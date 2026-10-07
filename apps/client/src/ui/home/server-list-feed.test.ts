// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListedServer } from '../../../../../shared/typescript/server-list';
import { ServerListFeed, type ListingEventStream, type ListingState } from './server-list-feed';

const listed = (name = 'Local'): ListedServer => ({
  id: 'a',
  name,
  type: 'survival',
  location: '',
  host: 'localhost',
  port: 8172,
  tls: false,
  statusPort: 8171,
  players: 2,
  max: 40,
  mapX: 0,
  mapY: 0,
  state: 'open',
});

class Stream extends EventTarget implements ListingEventStream {
  readyState = 1;
  close = vi.fn(() => {
    this.readyState = 2;
  });
  snapshot(servers: ListedServer[]): void {
    this.dispatchEvent(new MessageEvent('servers', { data: JSON.stringify(servers) }));
  }
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const feeds: ServerListFeed[] = [];
function setup(fetchList = vi.fn(async (_signal: AbortSignal) => [listed()]), useStream = true) {
  const streams: Stream[] = [];
  const createEventSource = vi.fn(() => {
    const source = new Stream();
    streams.push(source);
    return source;
  });
  const onSnapshot = vi.fn();
  const onState = vi.fn<(state: ListingState) => void>();
  const feed = new ServerListFeed({
    fetchList,
    createEventSource: useStream ? createEventSource : null,
    onSnapshot,
    onState,
  });
  feeds.push(feed);
  return { feed, streams, createEventSource, fetchList, onSnapshot, onState };
}

describe('ServerListFeed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const feed of feeds.splice(0)) feed.stop();
    vi.useRealTimers();
  });

  it('fetches immediately, receives changes, and makes no periodic HTTP requests with a healthy stream', async () => {
    const t = setup();
    t.feed.start();
    expect(t.onState).toHaveBeenLastCalledWith('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchList).toHaveBeenCalledTimes(1);
    t.streams[0].snapshot([listed('Changed')]);
    expect(t.onSnapshot).toHaveBeenLastCalledWith([listed('Changed')]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.fetchList).toHaveBeenCalledTimes(1);
    expect(t.onState).toHaveBeenLastCalledWith('ready');
  });

  it('ignores an older HTTP response after the immediate stream snapshot', async () => {
    const pending = deferred<ListedServer[]>();
    const t = setup(vi.fn(() => pending.promise));
    t.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    t.streams[0].snapshot([listed()]);
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onSnapshot).toHaveBeenCalledTimes(1);
    expect(t.onSnapshot).toHaveBeenLastCalledWith([listed()]);
  });

  it('coalesces HTTP requests and rejects late responses/events after a stop and restart', async () => {
    const first = deferred<ListedServer[]>();
    const second = deferred<ListedServer[]>();
    const fetchList = vi
      .fn<(_signal: AbortSignal) => Promise<ListedServer[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const t = setup(fetchList);
    t.feed.start();
    void t.feed.refresh();
    void t.feed.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchList).toHaveBeenCalledTimes(1);
    t.feed.stop();
    expect(fetchList.mock.calls[0][0].aborted).toBe(true);
    expect(t.streams[0].close).toHaveBeenCalledTimes(1);
    t.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    second.resolve([listed('New')]);
    await vi.advanceTimersByTimeAsync(0);
    first.resolve([]);
    t.streams[0].snapshot([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onSnapshot).toHaveBeenCalledTimes(1);
    expect(t.onSnapshot).toHaveBeenLastCalledWith([listed('New')]);
  });

  it('uses bounded fallback for disconnects and stops fallback when streaming recovers', async () => {
    const t = setup();
    t.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    t.streams[0].snapshot([listed()]);
    for (let i = 0; i < 5; i++) t.streams[0].fail();
    expect(t.onState).toHaveBeenLastCalledWith('updating');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(t.fetchList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetchList).toHaveBeenCalledTimes(2);
    t.streams[0].snapshot([listed('Recovered')]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetchList).toHaveBeenCalledTimes(2);
  });

  it('recreates a terminally closed stream only on the fallback interval', async () => {
    const t = setup();
    t.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    t.streams[0].readyState = 2;
    t.streams[0].fail();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(t.createEventSource).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.createEventSource).toHaveBeenCalledTimes(2);
    t.streams[1].snapshot([listed('Reconnected')]);
    t.streams[0].snapshot([]);
    expect(t.onSnapshot).toHaveBeenLastCalledWith([listed('Reconnected')]);
  });

  it('falls back when SSE opens without delivering a snapshot, and rejects malformed events', async () => {
    const t = setup();
    t.feed.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.fetchList).toHaveBeenCalledTimes(3);
    t.streams[0].dispatchEvent(new MessageEvent('servers', { data: '[{}]' }));
    expect(t.onSnapshot).toHaveBeenLastCalledWith([listed()]);
    expect(t.onState).toHaveBeenLastCalledWith('updating');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.fetchList).toHaveBeenCalledTimes(4);
  });

  it('recovers from initial HTTP failure without SSE and reports empty as a successful snapshot', async () => {
    const fetchList = vi
      .fn<(_signal: AbortSignal) => Promise<ListedServer[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([]);
    const t = setup(fetchList, false);
    t.feed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.onState).toHaveBeenLastCalledWith('unavailable');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.onSnapshot).toHaveBeenLastCalledWith([]);
    expect(t.onState).toHaveBeenLastCalledWith('ready');
    t.feed.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
});
