// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import {
  SERVER_LIST_EVENTS_PATH,
  type ListedServer,
} from '../../../../../shared/typescript/server-list';
import { parseServerList } from './server-list';

export interface ListingEventStream {
  readonly readyState?: number;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export type ListingState = 'loading' | 'ready' | 'updating' | 'unavailable';

export interface ServerListFeedOptions {
  fetchList: (signal: AbortSignal) => Promise<ListedServer[]>;
  createEventSource?: ((url: string) => ListingEventStream) | null;
  onSnapshot: (servers: ListedServer[]) => void;
  onState: (state: ListingState) => void;
  fallbackIntervalMs?: number;
}

/** One visible home screen's snapshot and change subscription. The stream owns
 * live updates; HTTP is used on entry and as a slow fallback while disconnected. */
export class ServerListFeed {
  private active = false;
  private epoch = 0;
  private revision = 0;
  private receivedSnapshot = false;
  private healthy = false;
  private stream: ListingEventStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly options: ServerListFeedOptions) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    const epoch = ++this.epoch;
    this.options.onState(this.receivedSnapshot ? 'updating' : 'loading');
    this.connect(epoch);
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.healthy) {
        // A terminal HTTP error can leave native EventSource CLOSED; its
        // automatic reconnect only covers recoverable connection failures.
        if (!this.stream || this.stream.readyState === 2) this.connect(this.epoch);
        void this.refresh();
      }
    }, this.options.fallbackIntervalMs ?? 20_000);
  }

  private connect(epoch: number): void {
    if (this.options.createEventSource) {
      try {
        this.stream?.close();
        const stream = this.options.createEventSource(SERVER_LIST_EVENTS_PATH);
        this.stream = stream;
        stream.addEventListener('servers', (event) => {
          if (!this.active || epoch !== this.epoch || stream !== this.stream) return;
          try {
            const servers = parseServerList(JSON.parse((event as MessageEvent<string>).data));
            this.healthy = true;
            this.revision++;
            this.accept(servers);
          } catch {
            this.disconnected();
          }
        });
        stream.addEventListener('error', () => {
          if (this.active && epoch === this.epoch && stream === this.stream) this.disconnected();
        });
      } catch {
        // Unsupported or blocked SSE uses the same bounded HTTP fallback.
        this.stream = null;
      }
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch++;
    this.healthy = false;
    this.stream?.close();
    this.stream = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
  }

  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.options.onState(this.receivedSnapshot ? 'updating' : 'loading');
    const timeout = setTimeout(() => abort.abort(), 8_000);
    const request = Promise.resolve()
      .then(() => this.options.fetchList(abort.signal))
      .then(
        (servers) => {
          if (this.active && epoch === this.epoch && revision === this.revision)
            this.accept(servers);
        },
        () => {
          if (this.active && epoch === this.epoch && revision === this.revision)
            this.disconnected();
        },
      )
      .finally(() => {
        clearTimeout(timeout);
        if (this.pending === request) {
          this.pending = null;
          this.abort = null;
        }
      });
    this.pending = request;
    return request;
  }

  private accept(servers: ListedServer[]): void {
    this.receivedSnapshot = true;
    this.options.onSnapshot(servers);
    this.options.onState('ready');
  }

  private disconnected(): void {
    this.healthy = false;
    this.options.onState(this.receivedSnapshot ? 'updating' : 'unavailable');
  }
}
