// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import { IndexedDbCache, MemoryCache, type ContentCache } from './cache';

const table = (name: string, hash: string): ContentTable => ({
  name,
  version: 1,
  hash,
  attributes: {},
  entries: { a: { key: 'a' } },
});

describe.each<[string, () => ContentCache]>([
  ['MemoryCache', () => new MemoryCache()],
  ['IndexedDbCache', () => new IndexedDbCache('test-content', new IDBFactory())],
])('%s', (_name, make) => {
  it('returns a table only when the hash matches, and clears', async () => {
    const cache = make();
    expect(await cache.get('items', 'h1')).toBeUndefined();
    await cache.put(table('items', 'h1'));
    expect((await cache.get('items', 'h1'))?.hash).toBe('h1');
    expect(await cache.get('items', 'h1')).not.toHaveProperty('cacheKey');
    expect(await cache.get('items', 'h2')).toBeUndefined();
    await cache.put(table('items', 'h2'));
    expect((await cache.get('items', 'h2'))?.hash).toBe('h2');
    expect((await cache.get('items', 'h1'))?.hash).toBe('h1');
    await cache.clear();
    expect(await cache.get('items', 'h2')).toBeUndefined();
  });
});

describe('IndexedDbCache', () => {
  it('survives a new instance on the same factory (persistence)', async () => {
    const factory = new IDBFactory();
    await new IndexedDbCache('persist', factory).put(table('modes', 'h'));
    expect((await new IndexedDbCache('persist', factory).get('modes', 'h'))?.name).toBe('modes');
  });
});

it('isolates memory cache values from caller mutations', async () => {
  const cache = new MemoryCache();
  const original = table('items', 'h');
  await cache.put(original);
  original.hash = 'changed';
  const copy = (await cache.get('items', 'h'))!;
  (copy.entries.a as { key: string }).key = 'mutated';
  expect((await cache.get('items', 'h'))!.entries.a).toEqual({ key: 'a' });
});

it('treats missing IndexedDB as a cache miss', async () => {
  const cache = new IndexedDbCache('unavailable');
  await expect(cache.get('items', 'h')).resolves.toBeUndefined();
  await expect(cache.put(table('items', 'h'))).resolves.toBeUndefined();
  await expect(cache.clear()).resolves.toBeUndefined();
});
