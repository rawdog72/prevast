// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The client's view of every content table. Tables arrive validated (load), are
// updated by merge patches (applyPatch), and announce what changed so derived indexes and
// cached renders can drop. Nothing here knows about sockets or IndexedDB.
import {
  CONTENT_TABLES,
  ID_ATTRIBUTE,
  type ContentEntry,
  type ContentPatch,
  type ContentTable,
  type ContentTableName,
  type ContentValue,
} from '../../../../shared/typescript/content-format';
import {
  contentPatchSchema,
  validateTable,
  type ConfigTable,
  type EntryTypes,
  type ItemEntry,
  type ObjectEntry,
} from '../../../../shared/typescript/content-schema';
import { applyMergePatch, type JsonValue } from './merge-patch';
import { WELL_KNOWN_KEYS } from './well-known';

export type ChangeListener = (table: ContentTableName, keys: string[]) => void;

export interface LootIndexEntry {
  itemKey: string;
  item: ItemEntry;
  sprite: string;
  scale: number;
  angle: number;
  amount: number;
}

export class ContentNotLoaded extends Error {
  constructor(table: string) {
    super(`content table '${table}' is not loaded`);
    this.name = 'ContentNotLoaded';
  }
}

interface Indexes {
  byId: Map<ContentTableName, Map<number, ContentEntry>>;
  loot: Map<number, LootIndexEntry>;
  objectByItem: Map<string, ObjectEntry>; // `${itemId}:${subtype}`
  stationByArea: Map<number, ObjectEntry>;
}

export class ContentStore {
  private readonly tables = new Map<ContentTableName, ContentTable<ContentValue>>();
  private readonly listeners = new Set<ChangeListener>();
  private indexes: Indexes | null = null;

  load(table: ContentTable<ContentValue>): void {
    this.loadAll([table]);
  }

  // Validation completes for the whole batch before any observer sees new state.
  loadAll(tables: readonly ContentTable<ContentValue>[]): void {
    const names = tables.map((table) => table.name);
    if (new Set(names).size !== names.length)
      throw new Error(`content batch contains duplicate tables: ${names.join(', ')}`);
    const valid = tables.map((table) => freeze(structuredClone(validateTable(table.name, table))));
    const changes = valid.map((table) => ({
      table,
      keys: [
        ...new Set([
          ...Object.keys(this.tables.get(table.name as ContentTableName)?.entries ?? {}),
          ...Object.keys(table.entries),
        ]),
      ],
    }));
    for (const table of valid) this.tables.set(table.name as ContentTableName, table);
    this.indexes = null;
    for (const { table, keys } of changes) this.emit(table.name as ContentTableName, keys);
  }

  snapshot(name: ContentTableName): ContentTable<ContentValue> | undefined {
    const table = this.tables.get(name);
    return table ? structuredClone(table) : undefined;
  }

  assertReady(): void {
    const missing = CONTENT_TABLES.filter((name) => !this.has(name));
    if (missing.length) throw new Error(`content tables not loaded: ${missing.join(', ')}`);
    this.assertWellKnown();
  }

  applyPatch(patch: ContentPatch): 'applied' | 'stale' | 'unknown-table' {
    const parsed = contentPatchSchema.parse(patch);
    const current = this.tables.get(patch.name as ContentTableName);
    if (!current) return 'unknown-table';
    if (current.version !== patch.fromVersion) return 'stale';
    const entries = applyMergePatch(current.entries as unknown as JsonValue, parsed.patch);
    const next = freeze(
      structuredClone(
        validateTable(patch.name, {
          ...current,
          version: patch.toVersion,
          hash: patch.hash,
          entries,
        }),
      ),
    );
    this.tables.set(next.name as ContentTableName, next);
    this.indexes = null;
    const keys =
      patch.patch && typeof patch.patch === 'object' ? Object.keys(patch.patch as object) : [];
    this.emit(next.name as ContentTableName, keys);
    return 'applied';
  }

  has(name: ContentTableName): boolean {
    return this.tables.has(name);
  }
  version(name: ContentTableName): number | undefined {
    return this.tables.get(name)?.version;
  }
  hash(name: ContentTableName): string | undefined {
    return this.tables.get(name)?.hash;
  }
  manifest(): Record<string, { version: number; hash: string }> {
    const out: Record<string, { version: number; hash: string }> = {};
    for (const [name, table] of this.tables)
      out[name] = { version: table.version, hash: table.hash };
    return out;
  }

  table<N extends ContentTableName>(name: N): Readonly<Record<string, EntryTypes[N]>> {
    const table = this.tables.get(name);
    if (!table) throw new ContentNotLoaded(name);
    return table.entries as unknown as Record<string, EntryTypes[N]>;
  }
  byKey<N extends ContentTableName>(name: N, key: string): EntryTypes[N] | undefined {
    const entries = this.table(name);
    return Object.hasOwn(entries, key) ? entries[key] : undefined;
  }
  byId<N extends ContentTableName>(name: N, id: number): EntryTypes[N] | undefined {
    return this.ensureIndexes().byId.get(name)?.get(id) as EntryTypes[N] | undefined;
  }
  get config(): ConfigTable {
    return this.table('config') as unknown as ConfigTable;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  assertWellKnown(): void {
    const missing: string[] = [];
    for (const [name, keys] of Object.entries(WELL_KNOWN_KEYS) as [
      ContentTableName,
      readonly string[],
    ][]) {
      const table = this.tables.get(name);
      if (!table) {
        missing.push(`${name}: table not loaded`);
        continue;
      }
      for (const key of keys)
        if (!Object.hasOwn(table.entries, key)) missing.push(`${name}/${key}`);
    }
    if (missing.length)
      throw new Error(`content is missing keys the client depends on:\n  ${missing.join('\n  ')}`);
  }

  lootById(id: number): LootIndexEntry | undefined {
    return this.ensureIndexes().loot.get(id);
  }
  objectForItem(itemId: number, subtype = 0): ObjectEntry | undefined {
    return this.ensureIndexes().objectByItem.get(`${itemId}:${subtype}`);
  }
  stationForArea(areaId: number): ObjectEntry | undefined {
    return this.ensureIndexes().stationByArea.get(areaId);
  }

  private emit(table: ContentTableName, keys: string[]): void {
    for (const listener of this.listeners) listener(table, keys);
  }

  private ensureIndexes(): Indexes {
    if (this.indexes) return this.indexes;
    const byId = new Map<ContentTableName, Map<number, ContentEntry>>();
    for (const [name, table] of this.tables) {
      if (!(name in ID_ATTRIBUTE)) continue;
      const index = new Map<number, ContentEntry>();
      for (const entry of Object.values(table.entries))
        if (typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'number')
          index.set(entry.id, entry);
      byId.set(name, index);
    }
    const loot = new Map<number, LootIndexEntry>();
    const items = this.tables.get('items')?.entries as Record<string, ItemEntry> | undefined;
    if (items)
      for (const [itemKey, item] of Object.entries(items))
        for (const row of item.client?.loot ?? [])
          loot.set(row.id, {
            itemKey,
            item,
            sprite: row.sprite,
            scale: row.scale,
            angle: row.angle,
            amount: row.amount,
          });
    const objectByItem = new Map<string, ObjectEntry>();
    const stationByArea = new Map<number, ObjectEntry>();
    for (const name of ['objects', 'furnitures'] as const) {
      const objects = this.tables.get(name)?.entries as Record<string, ObjectEntry> | undefined;
      if (!objects) continue;
      for (const object of Object.values(objects)) {
        const item = items?.[object.itemKey ?? object.key];
        if (item) objectByItem.set(`${item.id}:${object.subtype ?? 0}`, object);
        if (object.station) stationByArea.set(object.station.areaId, object);
      }
    }
    this.indexes = { byId, loot, objectByItem, stationByArea };
    return this.indexes;
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
