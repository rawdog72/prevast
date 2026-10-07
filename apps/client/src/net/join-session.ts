// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// One attempt to join a game server, from "Play" to HANDSHAKE (or the reason
// it did not happen). See docs/design/join-and-disconnect-flow.md.
import type { NetEventBus } from './events';
import { DisconnectReason } from './opcodes';

export type JoinStage = 'content' | 'ticket' | 'connecting' | 'syncing' | 'logging-in' | 'waiting';

export interface JoinStageInfo {
  /** 1-based attempt number. */
  attempt: number;
  /** Attempts allowed in total: 1 + automatic retries. */
  attempts: number;
  /** 'waiting' only: time left until the next attempt. */
  retryInMs?: number;
  /** 'waiting' only: why the server asked us to wait. */
  reason?: DisconnectReason;
}

export type JoinOutcome =
  | { kind: 'joined' }
  | { kind: 'cancelled' }
  | { kind: 'content-failed' }
  | { kind: 'account-failed'; detail: string }
  | { kind: 'rejected'; reason: DisconnectReason; detail: string }
  | { kind: 'outdated'; text: string }
  | { kind: 'unreachable' }
  | { kind: 'timed-out' }
  | { kind: 'dropped' };

export interface JoinConnection {
  readonly bus: NetEventBus;
  connect(): void;
  /** Tears the connection down; no connectionClosed follows. */
  close(): void;
}

export interface JoinResult<C extends JoinConnection> {
  outcome: JoinOutcome;
  /** The live connection, only when the outcome is 'joined'. */
  connection: C | null;
}

export interface JoinSessionOptions<C extends JoinConnection> {
  ensureContent: () => Promise<void>;
  /** An account ticket for one attempt. A refusal stops the join. Omit for guests. */
  fetchTicket?: () => Promise<string>;
  /** A connection to the server, not yet connected. */
  openConnection: (ticket: string) => C;
  onStage?: (stage: JoinStage, info: JoinStageInfo) => void;
  timeoutMs?: number;
  /** Waits before each automatic retry of STARTING_UP / MAINTENANCE. */
  retryDelaysMs?: readonly number[];
}

export const JOIN_TIMEOUT_MS = 15_000;
export const JOIN_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000];

const RETRYABLE: ReadonlySet<number> = new Set([
  DisconnectReason.STARTING_UP,
  DisconnectReason.MAINTENANCE,
]);

/**
 * One join, from game data to HANDSHAKE. Every run ends in exactly one
 * outcome; whatever the socket does after that is ignored. Only HANDSHAKE
 * counts as being in -- the caller shows the game then, never earlier.
 */
export class JoinSession<C extends JoinConnection> {
  private cancelled = false;
  /** Ends whatever run() is currently waiting on, as 'cancelled'. */
  private abort: (() => void) | null = null;

  constructor(private readonly options: JoinSessionOptions<C>) {}

  cancel(): void {
    this.cancelled = true;
    this.abort?.();
  }

  async run(): Promise<JoinResult<C>> {
    const cancelled: JoinResult<C> = { outcome: { kind: 'cancelled' }, connection: null };
    const delays = this.options.retryDelaysMs ?? JOIN_RETRY_DELAYS_MS;
    const attempts = delays.length + 1;
    const stage = (name: JoinStage, attempt: number, extra: Partial<JoinStageInfo> = {}) => {
      if (!this.cancelled) this.options.onStage?.(name, { attempt, attempts, ...extra });
    };

    stage('content', 1);
    try {
      if (!(await this.unlessCancelled(this.options.ensureContent()))) return cancelled;
    } catch (error) {
      console.error('[join] game data failed to load:', error);
      return { outcome: { kind: 'content-failed' }, connection: null };
    }

    for (let attempt = 1; ; attempt++) {
      let ticket = '';
      if (this.options.fetchTicket) {
        stage('ticket', attempt);
        try {
          const fetched = await this.unlessCancelled(this.options.fetchTicket());
          if (fetched === null) return cancelled;
          if (!fetched.value) throw new Error('Sign in again or choose to play as a guest.');
          ticket = fetched.value;
        } catch (error) {
          return {
            outcome: {
              kind: 'account-failed',
              detail: error instanceof Error ? error.message : 'Account sign-in failed.',
            },
            connection: null,
          };
        }
      }
      if (this.cancelled) return cancelled;

      stage('connecting', attempt);
      const result = await this.attempt(ticket, attempt, stage);
      const { outcome } = result;
      if (
        outcome.kind === 'rejected' &&
        RETRYABLE.has(outcome.reason) &&
        attempt <= delays.length
      ) {
        const wait = delays[attempt - 1]!;
        stage('waiting', attempt, { retryInMs: wait, reason: outcome.reason });
        if (!(await this.sleep(wait))) return cancelled;
        continue;
      }
      return result;
    }
  }

  /** The promise's value, or null if cancel() came first. */
  private unlessCancelled<T>(promise: Promise<T>): Promise<{ value: T } | null> {
    if (this.cancelled) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.abort = () => resolve(null);
      promise.then(
        (value) => {
          this.abort = null;
          resolve(this.cancelled ? null : { value });
        },
        (error: unknown) => {
          this.abort = null;
          if (this.cancelled) resolve(null);
          else reject(error);
        },
      );
    });
  }

  /** True after `ms`; false if cancelled first. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.abort = null;
        resolve(true);
      }, ms);
      this.abort = () => {
        clearTimeout(timer);
        this.abort = null;
        resolve(false);
      };
    });
  }

  private attempt(
    ticket: string,
    attempt: number,
    stage: (name: JoinStage, attempt: number) => void,
  ): Promise<JoinResult<C>> {
    return new Promise((resolve) => {
      const connection = this.options.openConnection(ticket);
      const { bus } = connection;
      const timeoutMs = this.options.timeoutMs ?? JOIN_TIMEOUT_MS;
      let opened = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unbind: (() => void)[] = [];

      const finish = (outcome: JoinOutcome) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        for (const off of unbind) off();
        this.abort = null;
        const joined = outcome.kind === 'joined';
        if (!joined) connection.close();
        resolve({ outcome, connection: joined ? connection : null });
      };
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish({ kind: opened ? 'timed-out' : 'unreachable' }), timeoutMs);
      };

      unbind.push(
        bus.on('connectionOpened', () => {
          opened = true;
          stage('syncing', attempt);
          arm();
        }),
        bus.on('connectionActivity', arm),
        bus.on('loginSent', () => stage('logging-in', attempt)),
        bus.on('handshake', () => finish({ kind: 'joined' })),
        bus.on('disconnectReason', (ev) =>
          finish({ kind: 'rejected', reason: ev.reason, detail: ev.detail }),
        ),
        // Before HANDSHAKE the only ALERT is the protocol-version refusal.
        bus.on('alert', (ev) => finish({ kind: 'outdated', text: ev.text })),
        bus.on('connectionClosed', (ev) => finish({ kind: ev.opened ? 'dropped' : 'unreachable' })),
      );
      this.abort = () => finish({ kind: 'cancelled' });
      arm();
      connection.connect();
    });
  }
}
