// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Registry } from './registry';
import { RegistrySnapshotStore } from './registry-store';

const TOKEN = 'listing-secret-'.repeat(4);
const CONTEXT = 'web-port:3100';
const beat = {
  token: TOKEN,
  id: 'local',
  host: '127.0.0.1',
  port: 8172,
  visible: true,
  interval: 10,
};

describe('RegistrySnapshotStore', () => {
  let directory: string;
  let file: string;
  let now: number;
  const stores: RegistrySnapshotStore[] = [];

  beforeEach(async () => {
    const runtime = path.join(process.cwd(), 'runtime');
    await fs.mkdir(runtime, { recursive: true });
    directory = await fs.mkdtemp(path.join(runtime, 'registry-tests-'));
    file = path.join(directory, 'snapshot.json');
    now = 1_000_000;
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function make(token = TOKEN, context = CONTEXT) {
    const lines: string[] = [];
    const registry = new Registry(
      (value) => value === token,
      () => now,
      () => {},
    );
    const store = new RegistrySnapshotStore(registry, file, token, context, (line) =>
      lines.push(line),
    );
    stores.push(store);
    return { registry, store, lines };
  }

  it('does not write an initially absent snapshot', async () => {
    const { registry, store, lines } = make();
    await store.load();
    store.start();
    await store.flush();
    expect(registry.listed()).toEqual([]);
    expect(lines).toEqual([]);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores live and hidden entries after restart without renewing their original TTL', async () => {
    const source = make();
    source.store.start();
    source.registry.heartbeat(beat);
    source.registry.heartbeat({ ...beat, id: 'hidden', visible: false, host: '::1', interval: 5 });
    await source.store.close();
    const contents = await fs.readFile(file, 'utf8');
    expect(contents).not.toContain(TOKEN);
    expect(contents).not.toContain('token');

    now += 10_000;
    const restored = make();
    await restored.store.load();
    expect(restored.registry.listed().map((entry) => entry.id)).toEqual(['local']);
    expect(restored.registry.address('hidden')).toBe('[::1]:8172');
    expect(restored.registry.snapshot().map((entry) => entry.lastSeen)).toEqual([
      1_000_000, 1_000_000,
    ]);
    now += 5001;
    expect(restored.registry.address('hidden')).toBeNull();

    now = 1_030_001;
    const expired = make();
    await expired.store.load();
    expect(expired.registry.snapshot()).toEqual([]);
    expect(expired.lines).toEqual([]);
  });

  it('serializes changes and saves latest freshness and explicit offline removal', async () => {
    const source = make();
    source.store.start();
    for (let players = 0; players < 20; players++) {
      now += 100;
      source.registry.heartbeat({ ...beat, players });
    }
    await source.store.flush();
    const latest = make();
    await latest.store.load();
    expect(latest.registry.snapshot()[0]).toMatchObject({ players: 19, lastSeen: now });
    source.registry.heartbeat({ token: TOKEN, id: 'local', offline: true });
    await source.store.flush();
    const offline = make();
    await offline.store.load();
    expect(offline.registry.snapshot()).toEqual([]);
    expect(await fs.readdir(directory)).toEqual(['snapshot.json']);
  });

  it('batches staggered heartbeats without resetting the one-second write deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const writes = vi.spyOn(fs, 'writeFile');
    const directories = vi.spyOn(fs, 'mkdir');
    const source = make();
    source.store.start();
    source.registry.heartbeat(beat);
    await source.store.flush();
    expect(writes).toHaveBeenCalledTimes(1);
    for (let players = 1; players < 10; players++) {
      now += 100;
      vi.advanceTimersByTime(100);
      source.registry.heartbeat({ ...beat, players });
    }
    expect(writes).toHaveBeenCalledTimes(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(directories).toHaveBeenCalledTimes(2);
    await source.store.flush();
    expect(writes).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.entries[0]).toMatchObject({ players: 9, lastSeen: now - 100 });
    // Unchanged visible data must still save its new heartbeat time.
    source.registry.heartbeat({ ...beat, players: 9 });
    await source.store.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).entries[0].lastSeen).toBe(now);
  });

  it('keeps only the latest mutation received while a write is in progress', async () => {
    const originalWrite = fs.writeFile.bind(fs);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstWrite = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writes = vi
      .spyOn(fs, 'writeFile')
      .mockImplementationOnce(async (target, contents, options) => {
        started();
        await gate;
        await originalWrite(target, contents, options);
      });
    const source = make();
    source.store.start();
    source.registry.heartbeat(beat);
    await firstWrite;
    for (let players = 1; players < 20; players++) source.registry.heartbeat({ ...beat, players });
    source.registry.heartbeat({ token: TOKEN, id: 'local', offline: true });
    release();
    await source.store.close();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).entries).toEqual([]);
  });

  it('logs a failed write without a retry loop, then saves a later heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const writes = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
    const source = make();
    source.store.start();
    source.registry.heartbeat(beat);
    await source.store.flush();
    expect(source.lines[0]).toContain('disk unavailable');
    expect(source.registry.listed()).toHaveLength(1);
    now += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toHaveBeenCalledTimes(1);
    source.registry.heartbeat(beat);
    await source.store.flush();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).entries[0].lastSeen).toBe(now);
  });

  it('does not trust restored addresses after token, context, or file changes', async () => {
    const source = make();
    source.store.start();
    source.registry.heartbeat(beat);
    await source.store.close();
    for (const changed of [make('changed-secret-'.repeat(4)), make(TOKEN, 'web-port:3200')]) {
      await changed.store.load();
      expect(changed.registry.address('local')).toBeNull();
      expect(changed.lines[0]).toContain('authentication failed');
    }
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.entries[0].host = 'attacker.example';
    await fs.writeFile(file, JSON.stringify(saved));
    const tampered = make();
    await tampered.store.load();
    expect(tampered.registry.address('local')).toBeNull();
    expect(tampered.lines[0]).toContain('authentication failed');
  });

  it('ignores corrupt, oversized, malformed, and future snapshots nonfatally', async () => {
    const source = make();
    source.registry.heartbeat(beat);
    const entry = source.registry.snapshot()[0];
    const signed = (entries: unknown) =>
      JSON.stringify({
        version: 1,
        entries,
        signature: createHmac('sha256', TOKEN)
          .update(JSON.stringify({ version: 1, context: CONTEXT, entries }))
          .digest('hex'),
      });
    for (const contents of [
      '{invalid',
      'x'.repeat(2_000_001),
      signed([{ ...entry, port: -1 }]),
      signed([{ ...entry, lastSeen: now + 1 }]),
    ]) {
      await fs.writeFile(file, contents);
      const restored = make();
      await restored.store.load();
      expect(restored.registry.snapshot()).toEqual([]);
      expect(restored.registry.address('local')).toBeNull();
      expect(restored.lines).toHaveLength(1);
    }
  });
});
