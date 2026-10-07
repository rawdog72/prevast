// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// One player's stay on one server: the join from the start screen, the game
// while connected, and what happens when the connection ends -- a dialog with
// the reason, or an automatic reconnect after a plain drop. Only one GameLoop
// exists at a time: the old one is stopped before a reconnect builds the next.
// See docs/design/join-and-disconnect-flow.md.
import {
  JoinSession,
  type JoinConnection,
  type JoinResult,
  type JoinStage,
  type JoinStageInfo,
} from '../net/join-session';
import { DisconnectReason } from '../net/opcodes';
import {
  describeDisconnect,
  describeJoinFailure,
  joinStageText,
  reconnectingView,
  rejoiningView,
  waitingForNetworkView,
  type DisconnectAction,
  type DisconnectCause,
  type DisconnectView,
  type FailureNotice,
  type JoinContext,
  type JoinFailure,
} from '../ui/home/join-messages';

export interface PlayGame {
  start(): void;
  stop(): void;
}

export interface PlayConnection extends JoinConnection {
  readonly game: PlayGame;
}

export interface PlayScreen {
  show(): void;
  hide(): void;
  setProgress(text: string): void;
  showFailure(notice: FailureNotice): void;
  endJoin(): void;
}

export interface PlayDialog {
  open(backdropUrl: string): void;
  render(view: DisconnectView, onAction: (action: DisconnectAction) => void): void;
  close(): void;
}

export interface PlaySessionOptions<C extends PlayConnection> {
  serverName: string;
  maxPlayers?: number;
  screen: PlayScreen;
  dialog: PlayDialog;
  /** A picture of the game canvas right now, as a data URL ('' if unavailable). */
  captureFrame: () => string;
  ensureContent: () => Promise<void>;
  fetchTicket?: () => Promise<string>;
  openConnection: (ticket: string) => C;
  /** After every successful join, including reconnects. */
  onJoined?: (connection: C) => void;
  isOnline?: () => boolean;
  waitForOnline?: () => Promise<void>;
  reload?: () => void;
  reconnectDelaysMs?: readonly number[];
  joinTimeoutMs?: number;
  /** Start-screen retries of STARTING_UP / MAINTENANCE (JoinSession's default when omitted). */
  joinRetryDelaysMs?: readonly number[];
}

export const RECONNECT_DELAYS_MS: readonly number[] = [0, 2_000, 5_000];

/** While reconnecting, a server that is restarting is just another failed attempt. */
const RETRY_ON_RECONNECT: ReadonlySet<number> = new Set([
  DisconnectReason.STARTING_UP,
  DisconnectReason.MAINTENANCE,
]);

export class PlaySession<C extends PlayConnection> {
  private active: C | null = null;
  private join: JoinSession<C> | null = null;
  private unbind: (() => void)[] = [];
  private died = false;
  private cause: DisconnectCause | null = null;
  /** Main menu was chosen: nothing of this session may show up any more. */
  private ended = false;
  /** Bumped by every reconnect run, Play again and Main menu; an older run that sees it change stops. */
  private generation = 0;
  private countdown: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: PlaySessionOptions<C>) {}

  private get context(): JoinContext {
    return { serverName: this.options.serverName, maxPlayers: this.options.maxPlayers };
  }

  /** "Play" on the start screen: the screen stays until HANDSHAKE. */
  async start(): Promise<void> {
    const result = await this.runJoin(true, this.options.joinRetryDelaysMs);
    this.stopCountdown();
    if (this.ended) return this.discard(result);
    const { screen } = this.options;
    if (result.connection) {
      screen.hide();
      this.enter(result.connection);
    } else if (result.outcome.kind === 'cancelled') {
      screen.endJoin();
    } else {
      screen.showFailure(describeJoinFailure(result.outcome as JoinFailure, this.context));
    }
  }

  /** Cancel on the start screen. */
  cancel(): void {
    this.join?.cancel();
  }

  /** "Play again" in the death window. A refusal lands on the start screen. */
  async playAgain(): Promise<void> {
    const generation = ++this.generation;
    this.openDialog();
    this.render(rejoiningView(this.options.serverName));
    const result = await this.runJoin(false, []);
    if (this.ended || generation !== this.generation) return this.discard(result);
    this.options.dialog.close();
    if (result.connection) {
      this.enter(result.connection);
      return;
    }
    if (result.outcome.kind === 'cancelled') return;
    this.options.screen.show();
    this.options.screen.showFailure(
      describeJoinFailure(result.outcome as JoinFailure, this.context),
    );
  }

  /** "Main menu" from the death window or the disconnect dialog. */
  mainMenu(): void {
    this.ended = true;
    this.generation++;
    this.join?.cancel();
    this.stopCountdown();
    this.leave();
    this.options.dialog.close();
    this.options.screen.show();
  }

  private runJoin(showStages: boolean, retryDelaysMs?: readonly number[]): Promise<JoinResult<C>> {
    const join = new JoinSession<C>({
      ensureContent: this.options.ensureContent,
      fetchTicket: this.options.fetchTicket,
      openConnection: this.options.openConnection,
      onStage: showStages ? (stage, info) => this.showStage(stage, info) : undefined,
      timeoutMs: this.options.joinTimeoutMs,
      retryDelaysMs,
    });
    this.join = join;
    return join.run();
  }

  private discard(result: JoinResult<C>): void {
    result.connection?.close();
  }

  private showStage(stage: JoinStage, info: JoinStageInfo): void {
    this.stopCountdown();
    const { screen } = this.options;
    if (stage !== 'waiting') {
      screen.setProgress(joinStageText(stage, info, this.context));
      return;
    }
    const until = Date.now() + (info.retryInMs ?? 0);
    const tick = () =>
      screen.setProgress(
        joinStageText(stage, { ...info, retryInMs: until - Date.now() }, this.context),
      );
    tick();
    this.countdown = setInterval(tick, 1_000);
  }

  private stopCountdown(): void {
    if (this.countdown !== null) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
  }

  private enter(connection: C): void {
    this.active = connection;
    this.died = false;
    this.cause = null;
    const { bus } = connection;
    this.unbind = [
      bus.on('playerDie', () => {
        this.died = true;
      }),
      bus.on('disconnectReason', (ev) => {
        this.cause = { kind: 'reason', reason: ev.reason, detail: ev.detail };
      }),
      bus.on('stoleYourSession', () => {
        this.cause = { kind: 'stolen' };
      }),
      bus.on('connectionClosed', () => this.onClosed()),
    ];
    connection.game.start();
    this.options.onJoined?.(connection);
  }

  private leave(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
    this.active?.game.stop();
    this.active = null;
  }

  /** Picture first: stopping the game may resize the canvas, which clears it. */
  private openDialog(): void {
    const backdrop = this.options.captureFrame();
    this.leave();
    this.options.dialog.open(backdrop);
  }

  private render(view: DisconnectView): void {
    this.options.dialog.render(view, (action) => this.onDialogAction(action));
  }

  private onClosed(): void {
    // After YOU_DIED the server closes the socket on purpose; the death
    // window owns the session from there.
    if (this.died) return;
    const cause = this.cause;
    this.openDialog();
    if (cause) this.render(describeDisconnect(cause, this.context));
    else void this.reconnect();
  }

  private onDialogAction(action: DisconnectAction): void {
    if (action === 'main-menu') this.mainMenu();
    else if (action === 'refresh') (this.options.reload ?? (() => location.reload()))();
    else void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    this.join?.cancel();
    const generation = ++this.generation;
    const stale = () => this.ended || generation !== this.generation;
    const delays = this.options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    for (let i = 0; i < delays.length; i++) {
      const { isOnline, waitForOnline } = this.options;
      if (isOnline && waitForOnline && !isOnline()) {
        this.render(waitingForNetworkView());
        await waitForOnline();
        if (stale()) return;
      }
      this.render(reconnectingView(i + 1, delays.length));
      const delay = delays[i]!;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (stale()) return;
      }
      const result = await this.runJoin(false, []);
      if (stale()) return this.discard(result);
      if (result.connection) {
        this.options.dialog.close();
        this.enter(result.connection);
        return;
      }
      const { outcome } = result;
      if (outcome.kind === 'account-failed') {
        this.render({
          ...describeJoinFailure(outcome, this.context),
          busy: false,
          actions: ['main-menu'],
        });
        return;
      }
      if (outcome.kind === 'cancelled') return;
      if (outcome.kind === 'outdated') {
        this.render(describeDisconnect({ kind: 'outdated', text: outcome.text }, this.context));
        return;
      }
      if (outcome.kind === 'rejected' && !RETRY_ON_RECONNECT.has(outcome.reason)) {
        this.render(
          describeDisconnect(
            { kind: 'reason', reason: outcome.reason, detail: outcome.detail },
            this.context,
          ),
        );
        return;
      }
    }
    this.render(describeDisconnect({ kind: 'lost' }, this.context));
  }
}
