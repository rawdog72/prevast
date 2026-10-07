// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TABLES, type ContentTable } from '../../../../shared/typescript/content-format';
import { ContentNotLoaded, ContentStore } from './store';

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}
function loaded(): ContentStore {
  const store = new ContentStore();
  for (const name of CONTENT_TABLES) store.load(fixture(name));
  return store;
}

describe('ContentStore', () => {
  it('loads and validates every fixture and answers byKey/byId/config', () => {
    const store = loaded();
    expect(store.has('items')).toBe(true);
    expect(store.version('items')).toBe(1);
    expect(store.byKey('items', 'hatchet')!.id).toBe(15);
    expect(store.byId('items', 15)!.key).toBe('hatchet');
    expect(store.byId('equipables', 3)!.key).toBe('hatchet');
    expect(store.byId('wearables', 1)!.key).toBe('headscarf');
    expect(store.byId('agents', 0)!.key).toBe('normal_ghoul');
    expect(store.byId('modes', 2)!.key).toBe('ghoul'); // clientModeId 0 is shared by survival and benchmark
    expect(store.config.maxClans).toBe(18);
    expect(Object.keys(store.manifest()).sort()).toEqual([...CONTENT_TABLES].sort());
    expect(() => store.assertWellKnown()).not.toThrow();
  });

  it('throws a readable error for a table that is not loaded', () => {
    const store = new ContentStore();
    expect(() => store.table('items')).toThrow(ContentNotLoaded);
    expect(() => store.assertWellKnown()).toThrow(/items/);
  });

  it('refuses invalid tables', () => {
    const store = new ContentStore();
    expect(() => store.load({ ...fixture('items'), entries: { x: { key: 'x' } } })).toThrow(
      /items/,
    );
  });

  it('builds derived indexes and invalidates them on change', () => {
    const store = loaded();
    const loot = store.lootById(18)!;
    expect(loot.itemKey).toBe('hatchet');
    expect(loot.sprite).toBe('day-ground-hachet');
    expect(store.objectForItem(27)!.key).toBe('wood_wall');
    expect(store.objectForItem(71, 0)!.subtype).toBe(0);
    expect(store.stationForArea(2)!.key).toBe('workbench');
    const before = store.table('items').hatchet!;
    const result = store.applyPatch({
      name: 'items',
      fromVersion: 1,
      toVersion: 2,
      hash: 'h2',
      patch: {
        hatchet: { client: { loot: [{ id: 18, sprite: 'x', scale: 1, angle: 0, amount: 1 }] } },
      },
    });
    expect(result).toBe('applied');
    expect(store.version('items')).toBe(2);
    expect(store.hash('items')).toBe('h2');
    expect(store.lootById(18)!.sprite).toBe('x');
    expect(before.client!.loot![0]!.sprite).toBe('day-ground-hachet'); // old snapshot untouched
  });

  it('rejects a stale patch and reports unknown tables', () => {
    const store = loaded();
    expect(
      store.applyPatch({ name: 'items', fromVersion: 7, toVersion: 8, hash: 'h', patch: {} }),
    ).toBe('stale');
    expect(
      store.applyPatch({ name: 'nope', fromVersion: 1, toVersion: 2, hash: 'h', patch: {} }),
    ).toBe('unknown-table');
    expect(store.version('items')).toBe(1);
  });

  it('a patch that breaks the schema is refused and leaves the table intact', () => {
    const store = loaded();
    expect(() =>
      store.applyPatch({
        name: 'items',
        fromVersion: 1,
        toVersion: 2,
        hash: 'h',
        patch: { hatchet: { id: 'no' } },
      }),
    ).toThrow(/items/);
    expect(store.version('items')).toBe(1);
    expect(store.byKey('items', 'hatchet')!.id).toBe(15);
  });

  it('emits change(table, keys) on load and on patch', () => {
    const store = new ContentStore();
    const seen: [string, string[]][] = [];
    const off = store.onChange((table, keys) => seen.push([table, keys]));
    store.load(fixture('modes'));
    expect(seen[0]![0]).toBe('modes');
    expect(seen[0]![1]).toContain('survival');
    store.applyPatch({
      name: 'modes',
      fromVersion: 1,
      toVersion: 2,
      hash: 'h',
      patch: { survival: { craftSpeed: 0.9 }, benchmark: null },
    });
    expect(seen[1]).toEqual(['modes', ['survival', 'benchmark']]);
    expect(store.byKey('modes', 'benchmark')).toBeUndefined();
    off();
    store.load(fixture('modes'));
    expect(seen).toHaveLength(2);
  });
});

describe('store atomicity and index integrity', () => {
  const items = (): ContentTable => ({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      first: { key: 'first', id: 1, clientItemId: 1, name: 'First' },
      second: { key: 'second', id: 2, clientItemId: 2, name: 'Second' },
    },
  });
  const objects = (): ContentTable => ({
    name: 'objects',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      bench: {
        key: 'bench',
        category: 'station',
        healthMax: 100,
        layer: 'mid',
        station: { key: 'bench', areaId: 3 },
      },
    },
  });
  it('invalidates removed keys and id indexes on replacement and patches', () => {
    const store = new ContentStore();
    store.load(items());
    expect(store.byId('items', 2)?.key).toBe('second');
    const seen: string[][] = [];
    store.onChange((_table, keys) => seen.push(keys));
    const next = items();
    delete next.entries.second;
    store.load(next);
    expect(seen[0]).toContain('second');
    expect(store.byId('items', 2)).toBeUndefined();
    store.applyPatch({
      name: 'items',
      fromVersion: 1,
      toVersion: 2,
      hash: 'h2',
      patch: { first: { id: 4, clientItemId: 4 } },
    });
    expect(store.byId('items', 1)).toBeUndefined();
    expect(store.byId('items', 4)?.key).toBe('first');
  });
  it('rejects a bad batch or patch without changing state or sending events', () => {
    const store = new ContentStore();
    store.load(items());
    const seen: string[] = [];
    store.onChange((name) => seen.push(name));
    expect(() =>
      store.loadAll([objects(), { ...items(), entries: { bad: { key: 'bad' } } }]),
    ).toThrow();
    expect(store.has('objects')).toBe(false);
    expect(() =>
      store.applyPatch({ name: 'items', fromVersion: 1, toVersion: 1, hash: 'h2', patch: {} }),
    ).toThrow();
    expect(() =>
      store.applyPatch({
        name: 'items',
        fromVersion: 1,
        toVersion: 2,
        hash: 'h2',
        patch: { first: { name: 9 } },
      }),
    ).toThrow();
    expect(store.byId('items', 1)?.name).toBe('First');
    expect(store.hash('items')).toBe('h');
    expect(seen).toEqual([]);
  });
  it('keeps references immutable and exposes isolated snapshots', () => {
    const store = new ContentStore();
    const source = items();
    source.entries.first!.future = { nested: 1 };
    store.load(source);
    expect(Object.isFrozen(source.entries.first!.future)).toBe(false);
    source.entries.first!.name = 'Changed';
    expect(() => {
      store.byKey('items', 'first')!.name = 'Changed';
    }).toThrow();
    const copy = store.snapshot('items')!;
    (copy.entries.first as { name: string }).name = 'Changed';
    expect(store.byId('items', 1)?.name).toBe('First');
    expect(store.byKey('items', 'toString')).toBeUndefined();
  });
  it('indexes stations without requiring items', () => {
    const store = new ContentStore();
    store.load(objects());
    expect(store.stationForArea(3)?.key).toBe('bench');
  });
});
