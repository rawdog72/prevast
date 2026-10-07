// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_PROTOCOL,
  CONTENT_TABLES,
  type ContentTable,
  type ContentValue,
} from '../../../../shared/typescript/content-format';
import { MemoryCache, type ContentCache } from './cache';
import { ContentProtocolMismatch, syncContent } from './loader';
import { ContentStore } from './store';

type Table = ContentTable<ContentValue>;
const fixtures = (): Table[] =>
  CONTENT_TABLES.map(
    (name) => JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as Table,
  );
const manifestOf = (tables: Table[]) => ({
  protocol: CONTENT_PROTOCOL,
  tables: Object.fromEntries(tables.map((t) => [t.name, { version: t.version, hash: t.hash }])),
});
const setup = () => {
  const tables = fixtures();
  const request = vi.fn(async (names: string[]) =>
    tables.filter((table) => names.includes(table.name)),
  );
  return {
    tables,
    store: new ContentStore(),
    cache: new MemoryCache(),
    manifest: manifestOf(tables),
    request,
  };
};

describe('syncContent', () => {
  it('requests only missing tables and commits the complete validated set', async () => {
    const options = setup();
    await options.cache.put(options.tables.find((t) => t.name === 'modes')!);
    options.store.load(options.tables.find((t) => t.name === 'config')!);
    const result = await syncContent(options);
    expect(options.request).toHaveBeenCalledWith(
      CONTENT_TABLES.filter((n) => n !== 'modes' && n !== 'config'),
    );
    expect(result.fromCache).toEqual(['modes']);
    expect(result.unchanged).toEqual(['config']);
    expect(() => options.store.assertReady()).not.toThrow();
    expect((await options.cache.get('items', options.manifest.tables.items!.hash))?.name).toBe(
      'items',
    );
  });
  it('refuses a protocol mismatch before requesting anything', async () => {
    const options = setup();
    await expect(
      syncContent({ ...options, manifest: { protocol: 99, tables: {} } }),
    ).rejects.toThrow(ContentProtocolMismatch);
    expect(options.request).not.toHaveBeenCalled();
  });
  it('requires all known tables and rejects unknown names and malformed manifests', async () => {
    const options = setup();
    for (const manifest of [
      { protocol: 1, tables: {} },
      {
        ...options.manifest,
        tables: { ...options.manifest.tables, surprise: { version: 1, hash: 'h' } },
      },
      { nope: 1 },
    ]) {
      await expect(syncContent({ ...options, manifest })).rejects.toThrow(/manifest/);
    }
    expect(options.request).not.toHaveBeenCalled();
  });
  it.each(['hash', 'version', 'missing', 'duplicate', 'schema', 'well-known'])(
    'refuses %s corruption without partial store/cache updates',
    async (kind) => {
      const options = setup();
      const data = structuredClone(options.tables);
      const items = data.find((t) => t.name === 'items')!;
      if (kind === 'hash') items.hash = 'other';
      if (kind === 'version') items.version++;
      if (kind === 'missing') data.pop();
      if (kind === 'duplicate') data.push(items);
      if (kind === 'schema') items.entries.hatchet = { key: 'hatchet' };
      if (kind === 'well-known') delete items.entries.hatchet;
      await expect(syncContent({ ...options, request: async () => data })).rejects.toThrow();
      expect(options.store.manifest()).toEqual({});
      expect(await options.cache.get('items', items.hash)).toBeUndefined();
    },
  );
  it('recovers from corrupted cache entries and throwing caches', async () => {
    const options = setup();
    const items = options.tables.find((t) => t.name === 'items')!;
    const cache: ContentCache = {
      get: async (name) => {
        if (name === 'items') return { ...items, entries: { x: { key: 'x' } } };
        throw new Error('unavailable');
      },
      put: async () => {
        throw new Error('quota');
      },
      clear: async () => {},
    };
    await syncContent({ ...options, cache });
    expect(options.request).toHaveBeenCalledWith(CONTENT_TABLES);
    expect(() => options.store.assertReady()).not.toThrow();
  });
  it('rebases cached and in-memory versions after a server restart so the next patch applies', async () => {
    const options = setup();
    for (const table of options.tables) await options.cache.put({ ...table, version: 9 });
    options.store.load({ ...options.tables.find((t) => t.name === 'items')!, version: 7 });
    await syncContent(options);
    expect(options.request).not.toHaveBeenCalled();
    expect(options.store.version('items')).toBe(1);
    expect(options.store.version('modes')).toBe(1);
    expect(
      options.store.applyPatch({
        name: 'items',
        fromVersion: 1,
        toVersion: 2,
        hash: 'next',
        patch: { hatchet: { name: 'Renamed' } },
      }),
    ).toBe('applied');
  });
  it('observers see all tables at once', async () => {
    const options = setup();
    options.store.onChange(() => options.store.assertReady());
    await syncContent(options);
  });
});
