// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERVAL_SECONDS, MISSED_BEATS_BEFORE_DROP, Registry } from './registry';

const TOKEN = 'x'.repeat(40);

function make(startAt = 1_000_000) {
  let now = startAt;
  const lines: string[] = [];
  const registry = new Registry(
    (t) => t === TOKEN,
    () => now,
    (line) => lines.push(line),
  );
  return { registry, lines, advance: (ms: number) => (now += ms) };
}

const beat = (extra: Record<string, unknown> = {}) => ({
  token: TOKEN,
  id: 'srv-1',
  host: '127.0.0.1',
  port: 7172,
  statusPort: 7171,
  visible: 1,
  name: 'Local',
  type: 'survival',
  location: 'EU',
  players: 3,
  max: 40,
  mapX: 100,
  mapY: 80,
  state: 'open',
  ...extra,
});

describe('Registry.heartbeat', () => {
  it('accepts a valid beat and lists it', () => {
    const { registry } = make();
    expect(registry.heartbeat(beat())).toEqual({ status: 200, body: { ok: true } });
    expect(registry.listed()).toEqual([
      {
        id: 'srv-1',
        name: 'Local',
        type: 'survival',
        location: 'EU',
        host: '127.0.0.1',
        port: 7172,
        tls: false,
        statusPort: 7171,
        players: 3,
        max: 40,
        mapX: 100,
        mapY: 80,
        state: 'open',
      },
    ]);
  });

  it('rejects non-objects, bad tokens, missing id, missing host/port', () => {
    const { registry } = make();
    expect(registry.heartbeat('nope').status).toBe(400);
    expect(registry.heartbeat(beat({ token: 'bad' })).status).toBe(403);
    expect(registry.heartbeat(beat({ id: '' })).status).toBe(400);
    expect(registry.heartbeat(beat({ host: '' })).status).toBe(400);
    expect(registry.heartbeat(beat({ port: 0 })).status).toBe(400);
    expect(registry.heartbeat(beat({ port: 70000 })).status).toBe(400);
    expect(registry.heartbeat(beat({ host: 'not a host!' })).status).toBe(400);
    expect(registry.listed()).toEqual([]);
  });

  it('normalises: strips control chars, clamps lengths, defaults unknown type/state, brackets IPv6', () => {
    const { registry } = make();
    registry.heartbeat(
      beat({
        name: 'A\x00B'.padEnd(40, 'z'),
        type: 'weird',
        state: 'odd',
        host: '::1',
        tls: 1,
        statusPort: 0,
      }),
    );
    const [entry] = registry.listed();
    expect(entry.name).toHaveLength(24);
    expect(entry.name.startsWith('AB')).toBe(true);
    expect(entry.type).toBe('survival');
    expect(entry.state).toBe('open');
    expect(entry.host).toBe('[::1]');
    expect(entry.tls).toBe(true);
    expect(entry.statusPort).toBeNull();
  });

  it('hides invisible servers from listed() but not from all()', () => {
    const { registry } = make();
    registry.heartbeat(beat({ visible: 0 }));
    expect(registry.listed()).toEqual([]);
    expect(registry.all()).toHaveLength(1);
  });

  it('drops a server after MISSED_BEATS_BEFORE_DROP intervals and on offline', () => {
    const { registry, advance, lines } = make();
    registry.heartbeat(beat());
    advance(DEFAULT_INTERVAL_SECONDS * 1000 * MISSED_BEATS_BEFORE_DROP + 1);
    expect(registry.listed()).toEqual([]);
    expect(lines.some((l) => l.includes('timed out'))).toBe(true);

    registry.heartbeat(beat());
    registry.heartbeat({ token: TOKEN, id: 'srv-1', offline: 1 });
    expect(registry.listed()).toEqual([]);
  });

  it('sorts by type, location, name, id', () => {
    const { registry } = make();
    registry.heartbeat(beat({ id: 'b', type: 'ghoul', name: 'B' }));
    registry.heartbeat(beat({ id: 'a', type: 'survival', location: 'US', name: 'A' }));
    registry.heartbeat(beat({ id: 'c', type: 'survival', location: 'EU', name: 'C' }));
    expect(registry.listed().map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('knows the address of each live server', () => {
    let t = 0;
    const registry = new Registry(
      (token) => token === 'ok',
      () => t,
      () => {},
    );
    expect(registry.address('a')).toBeNull();
    registry.heartbeat({ token: 'ok', id: 'a', host: '127.0.0.1', port: 7172, interval: 1 });
    expect(registry.address('a')).toBe('127.0.0.1:7172');
    registry.heartbeat({ token: 'ok', id: 'v6', host: '::1', port: 7173, interval: 1 });
    expect(registry.address('v6')).toBe('[::1]:7173');
    t += 10_000;
    expect(registry.address('a')).toBeNull();
  });
});

describe('Registry subscriptions and snapshots', () => {
  afterEach(() => vi.useRealTimers());

  it('notifies for accepted beats, including unchanged freshness, and offline removal', () => {
    const { registry, advance } = make();
    const snapshots: unknown[] = [];
    const unsubscribe = registry.subscribe(() => snapshots.push(registry.snapshot()));
    expect(snapshots).toEqual([]);
    registry.heartbeat(beat());
    advance(1000);
    registry.heartbeat(beat());
    registry.heartbeat(beat({ token: 'bad' }));
    registry.heartbeat({ token: TOKEN, id: 'srv-1', offline: 1 });
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toEqual([]);
    unsubscribe();
  });

  it('expires entries without requests, refreshes their deadline, and stops its timer on unsubscribe', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const registry = new Registry(
      (token) => token === TOKEN,
      Date.now,
      () => {},
    );
    const listener = vi.fn(() => registry.listed());
    const unsubscribe = registry.subscribe(listener);
    registry.heartbeat(beat());
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    registry.heartbeat(beat());
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.results.at(-1)?.value).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    registry.heartbeat(beat());
    expect(vi.getTimerCount()).toBe(1);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one earliest-expiry timer for multiple subscribers and server intervals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const registry = new Registry(
      (token) => token === TOKEN,
      Date.now,
      () => {},
    );
    const changes: string[][] = [];
    const stopOne = registry.subscribe(() =>
      changes.push(registry.listed().map((entry) => entry.id)),
    );
    const stopTwo = registry.subscribe(() => registry.all());
    registry.heartbeat(beat({ id: 'short', interval: 1 }));
    registry.heartbeat(beat({ id: 'long', interval: 2 }));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3001);
    expect(changes.at(-1)).toEqual(['long']);
    expect(vi.getTimerCount()).toBe(1);
    stopOne();
    expect(vi.getTimerCount()).toBe(1);
    stopTwo();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves original freshness, interval and hidden entries across restore', () => {
    const source = make();
    source.registry.heartbeat(beat({ visible: false, interval: 2 }));
    const saved = source.registry.snapshot();
    const restored = make(1_005_000);
    expect(restored.registry.restore(saved)).toBe(true);
    expect(restored.registry.listed()).toEqual([]);
    expect(restored.registry.address('srv-1')).toBe('127.0.0.1:7172');
    expect(restored.registry.snapshot()[0]).toMatchObject({ lastSeen: 1_000_000, interval: 2 });
    restored.advance(1001);
    expect(restored.registry.snapshot()).toEqual([]);
    expect(restored.registry.address('srv-1')).toBeNull();
    expect(make(1_006_001).registry.restore(saved)).toBe(true);
    const expired = make(1_006_001).registry;
    expired.restore(saved);
    expect(expired.listed()).toEqual([]);
  });

  it('rejects malformed, duplicate and future entries without changing live state', () => {
    const { registry } = make();
    registry.heartbeat(beat());
    const original = registry.snapshot();
    for (const malformed of [
      null,
      {},
      [{ ...original[0], host: 'https://invalid/path' }],
      [{ ...original[0], port: '7172' }],
      [{ ...original[0], interval: 0 }],
      [{ ...original[0], lastSeen: 1_000_001 }],
      [{ ...original[0], visible: 'false' }],
      [original[0], original[0]],
    ]) {
      expect(registry.restore(malformed)).toBe(false);
      expect(registry.snapshot()).toEqual(original);
    }
  });
});
