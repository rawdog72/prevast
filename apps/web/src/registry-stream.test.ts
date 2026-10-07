// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { Registry } from './registry';
import {
  createRegistryStream,
  LIST_STREAM_BATCH_MS,
  LIST_STREAM_KEEPALIVE_MS,
} from './registry-stream';

const TOKEN = 'test-listing-token';
const beat = (extra: Record<string, unknown> = {}) => ({
  token: TOKEN,
  id: 'a',
  host: '127.0.0.1',
  port: 7172,
  visible: 1,
  name: 'Local',
  players: 0,
  ...extra,
});
const makeRegistry = () =>
  new Registry(
    (t) => t === TOKEN,
    Date.now,
    () => {},
  );

class StreamResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  write = vi.fn((_frame: string) => true);
  set = vi.fn(() => this);
  status = vi.fn(() => this);
  json = vi.fn(() => this);
  flushHeaders = vi.fn();
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
  snapshots(): unknown[] {
    return this.write.mock.calls
      .flatMap(([frame]) => frame.split('\n').filter((line) => line.startsWith('data: ')))
      .map((line) => JSON.parse(line.slice(6)));
  }
}

afterEach(() => vi.useRealTimers());

describe('registry stream', () => {
  const connect = (handler: ReturnType<typeof createRegistryStream>, ip = 'local') => {
    const res = new StreamResponse();
    handler({ ip } as Request, res as unknown as Response, () => {});
    return res;
  };

  it('sends an immediate snapshot on every connection, including empty and reconnects', () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const stream = createRegistryStream(registry);
    const empty = connect(stream);
    expect(empty.snapshots()).toEqual([[]]);
    expect(empty.write.mock.calls[0][0]).toContain('retry: 5000');
    empty.destroy();
    registry.heartbeat(beat());
    const reload = connect(stream);
    expect(reload.snapshots()).toEqual([registry.listed()]);
    reload.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pushes a server arriving after an empty snapshot, coalesces bursts and ignores unchanged beats', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const stream = createRegistryStream(registry);
    const first = connect(stream);
    const second = connect(stream);
    registry.heartbeat(beat({ players: 1 }));
    registry.heartbeat(beat({ players: 2 }));
    registry.heartbeat(beat({ players: 3 }));
    expect(first.snapshots()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    expect(first.snapshots()).toEqual([[], registry.listed()]);
    expect(second.snapshots()).toEqual(first.snapshots());
    registry.heartbeat(beat({ players: 3, uptime: 10 }));
    registry.heartbeat(beat({ id: 'hidden', visible: 0 }));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    expect(first.snapshots()).toHaveLength(2);
    first.destroy();
    second.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pushes removals for offline and expired servers without a browser poll', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    registry.heartbeat(beat({ interval: 1 }));
    const client = connect(createRegistryStream(registry));
    await vi.advanceTimersByTimeAsync(3_001 + LIST_STREAM_BATCH_MS);
    expect(client.snapshots()).toEqual([[expect.objectContaining({ id: 'a' })], []]);
    registry.heartbeat(beat());
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    registry.heartbeat({ token: TOKEN, id: 'a', offline: 1 });
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    expect(client.snapshots().at(-1)).toEqual([]);
    client.destroy();
  });

  it('uses small keepalives while idle and cleans up when the last viewer leaves', async () => {
    vi.useFakeTimers();
    const client = connect(createRegistryStream(makeRegistry()));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_KEEPALIVE_MS);
    expect(client.snapshots()).toEqual([[]]);
    expect(client.write).toHaveBeenLastCalledWith(': keepalive\n\n');
    client.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds connections and releases capacity on disconnect', () => {
    vi.useFakeTimers();
    const stream = createRegistryStream(makeRegistry(), {
      maxConnections: 2,
      maxConnectionsPerIp: 1,
    });
    const first = connect(stream, 'a');
    expect(connect(stream, 'a').status).toHaveBeenCalledWith(503);
    const second = connect(stream, 'b');
    expect(connect(stream, 'c').status).toHaveBeenCalledWith(503);
    first.destroy();
    const replacement = connect(stream, 'a');
    expect(replacement.snapshots()).toEqual([[]]);
    second.destroy();
    replacement.destroy();
  });

  it('disconnects a blocked reader instead of building an outgoing queue', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const client = connect(createRegistryStream(registry));
    client.write.mockReturnValue(false);
    registry.heartbeat(beat({ players: 1 }));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    registry.heartbeat(beat({ players: 2 }));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    expect(client.destroyed).toBe(true);
    expect(client.snapshots()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues after a temporary full write buffer drains', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const client = connect(createRegistryStream(registry));
    client.write.mockReturnValueOnce(false);
    registry.heartbeat(beat({ players: 1 }));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    client.emit('drain');
    registry.heartbeat(beat({ players: 2 }));
    await vi.advanceTimersByTimeAsync(LIST_STREAM_BATCH_MS);
    expect(client.destroyed).toBe(false);
    expect(client.snapshots().at(-1)).toEqual([expect.objectContaining({ players: 2 })]);
    client.destroy();
  });
});

it('streams a snapshot and a later heartbeat through the real HTTP/compression stack', async () => {
  const app = createApp({ root: process.cwd(), validToken: (t) => t === TOKEN });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const abort = new AbortController();
  try {
    const response = await fetch(`${base}/api/servers/events`, {
      signal: abort.signal,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (): Promise<unknown> => {
      while (true) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream ended before snapshot');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    };
    expect(await next()).toEqual([]);
    const posted = await fetch(`${base}/api/servers/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(beat()),
    });
    expect(posted.status).toBe(200);
    expect(await next()).toEqual([expect.objectContaining({ id: 'a', name: 'Local' })]);
  } finally {
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
