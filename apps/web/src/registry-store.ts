// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Registry, type RegistryEntry } from './registry';

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 2_000_000;
const WRITE_INTERVAL_MS = 1000;

/** A restart cache, authenticated with the listing secret but never storing that secret. */
export class RegistrySnapshotStore {
  private unsubscribe: (() => void) | undefined;
  private pending: RegistryEntry[] | undefined;
  private writing: Promise<void> | undefined;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private nextWriteAt = 0;

  constructor(
    private readonly registry: Registry,
    private readonly file: string,
    private readonly token: string,
    private readonly context: string,
    private readonly log: (line: string) => void = console.error,
  ) {}

  /** Call before listening. Missing, outdated, or invalid caches never prevent startup. */
  async load(): Promise<void> {
    try {
      const handle = await fs.open(this.file, 'r');
      let contents: string;
      try {
        const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_SNAPSHOT_BYTES) throw new Error('snapshot is too large');
        contents = buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
      const saved: unknown = JSON.parse(contents);
      if (!saved || typeof saved !== 'object') throw new Error('invalid snapshot');
      const { version, entries, signature } = saved as Record<string, unknown>;
      if (
        version !== SNAPSHOT_VERSION ||
        typeof signature !== 'string' ||
        !/^[a-f0-9]{64}$/.test(signature)
      ) {
        throw new Error('invalid snapshot format');
      }
      const expected = Buffer.from(this.signature(entries), 'hex');
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
        throw new Error('snapshot authentication failed');
      }
      if (!this.registry.restore(entries)) throw new Error('invalid snapshot entries');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[registry] Ignoring saved snapshot: ${String(error)}`);
      }
    }
  }

  /** Start after load; an absent cache is not created until a registry change occurs. */
  start(): void {
    this.unsubscribe ??= this.registry.subscribe(() => {
      this.pending = this.registry.snapshot();
      this.scheduleWrite();
    });
  }

  /** Complete queued changes, useful on clean shutdown and in integration tests. */
  async flush(): Promise<void> {
    while (this.writing || this.pending) {
      this.beginWrite();
      await this.writing;
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.flush();
  }

  private signature(entries: unknown): string {
    return createHmac('sha256', this.token)
      .update(JSON.stringify({ version: SNAPSHOT_VERSION, context: this.context, entries }))
      .digest('hex');
  }

  private beginWrite(): void {
    if (this.writing || !this.pending) return;
    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    this.nextWriteAt = Date.now() + WRITE_INTERVAL_MS;
    const entries = this.pending;
    this.pending = undefined;
    this.writing = this.writeSnapshot(entries).finally(() => {
      this.writing = undefined;
      this.scheduleWrite();
    });
  }

  private scheduleWrite(): void {
    if (this.writing || this.writeTimer || !this.pending) return;
    const delay = this.nextWriteAt - Date.now();
    if (delay <= 0) {
      this.beginWrite();
      return;
    }
    // One non-reset timer keeps even staggered heartbeats to at most one disk write/second.
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.beginWrite();
    }, delay);
    this.writeTimer.unref();
  }

  private async writeSnapshot(entries: RegistryEntry[]): Promise<void> {
    // At most one write runs; new heartbeats replace a single pending snapshot.
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const contents = JSON.stringify({
        version: SNAPSHOT_VERSION,
        entries,
        signature: this.signature(entries),
      });
      if (Buffer.byteLength(contents) > MAX_SNAPSHOT_BYTES)
        throw new Error('snapshot is too large');
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch (error) {
      this.log(`[registry] Could not save snapshot: ${String(error)}`);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
