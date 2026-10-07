// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { queryServerStatus, statusUrl } from './status-query';

let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  port = (wss.address() as { port: number }).port;
  // Mirrors protocolstatus.cpp: a text frame "[255]" gets one JSON reply, then close.
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.toString() !== '[255]') {
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ uptime: 5, players: 2, playersMax: 40, mapName: 'test' }));
      socket.close();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => wss.close(() => resolve())));

describe('queryServerStatus', () => {
  it('builds ws/wss URLs', () => {
    expect(statusUrl({ host: 'h', port: 7171, tls: false })).toBe('ws://h:7171');
    expect(statusUrl({ host: 'h', port: 7171, tls: true })).toBe('wss://h:7171');
  });

  it('sends [255] as text and resolves with the JSON and a round-trip time', async () => {
    const probe = await queryServerStatus({ host: '127.0.0.1', port, tls: false });
    expect(probe.status).toEqual({ uptime: 5, players: 2, playersMax: 40, mapName: 'test' });
    expect(probe.rttMs).toBeGreaterThanOrEqual(0);
    expect(probe.rttMs).toBeLessThan(1000);
  });

  it('rejects when nothing answers', async () => {
    await expect(
      queryServerStatus({ host: '127.0.0.1', port: 1, tls: false, timeoutMs: 500 }),
    ).rejects.toThrow();
  });

  it('closes an outstanding socket when its probe is cancelled', async () => {
    const close = vi.fn();
    const Socket = vi.fn(function () {
      return { close };
    });
    const abort = new AbortController();
    const result = queryServerStatus({
      host: 'localhost',
      port: 8171,
      tls: false,
      signal: abort.signal,
      WebSocketImpl: Socket as unknown as typeof WebSocket,
    });
    abort.abort();
    await expect(result).rejects.toThrow(/cancelled/);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      queryServerStatus({
        host: 'localhost',
        port: 8171,
        tls: false,
        signal: abort.signal,
        WebSocketImpl: Socket as unknown as typeof WebSocket,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(Socket).toHaveBeenCalledTimes(1);
  });
});
