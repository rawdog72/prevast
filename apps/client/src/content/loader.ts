// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Connect-time content sync; no state becomes visible until every required table validates.
import {
  CONTENT_PROTOCOL,
  CONTENT_TABLES,
  type ContentTable,
  type ContentValue,
} from '../../../../shared/typescript/content-format';
import {
  contentManifestSchema,
  isContentTableName,
  validateTable,
} from '../../../../shared/typescript/content-schema';
import type { ContentCache } from './cache';
import { ContentStore } from './store';

export class ContentProtocolMismatch extends Error {
  constructor(
    readonly server: number,
    readonly client: number,
  ) {
    super(`server content protocol ${server}, client ${client}: incompatible content protocol`);
    this.name = 'ContentProtocolMismatch';
  }
}

export interface SyncResult {
  fromCache: string[];
  fetched: string[];
  unchanged: string[];
}
type Table = ContentTable<ContentValue>;

export async function syncContent(options: {
  store: ContentStore;
  cache: ContentCache;
  manifest: unknown;
  request: (names: string[]) => Promise<unknown[]>;
}): Promise<SyncResult> {
  const parsed = contentManifestSchema.safeParse(options.manifest);
  if (!parsed.success)
    throw new Error(`malformed content manifest: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  const manifest = parsed.data;
  if (manifest.protocol !== CONTENT_PROTOCOL)
    throw new ContentProtocolMismatch(manifest.protocol, CONTENT_PROTOCOL);
  const omitted = CONTENT_TABLES.filter((name) => !Object.hasOwn(manifest.tables, name));
  if (omitted.length) throw new Error(`manifest is missing required tables: ${omitted.join(', ')}`);

  const result: SyncResult = { fromCache: [], fetched: [], unchanged: [] };
  const missing: string[] = [];
  const pending: Table[] = [];
  for (const name of CONTENT_TABLES) {
    const expected = manifest.tables[name]!;
    const current = options.store.snapshot(name);
    if (current?.hash === expected.hash) {
      // Versions are local to a server run; identical bytes can have a new version.
      pending.push({ ...current, version: expected.version });
      result.unchanged.push(name);
      continue;
    }
    try {
      const cached = await options.cache.get(name, expected.hash);
      if (cached) {
        const valid = validateTable(name, cached);
        if (valid.hash !== expected.hash) throw new Error('cache hash mismatch');
        pending.push({ ...valid, version: expected.version });
        result.fromCache.push(name);
        continue;
      }
    } catch {
      /* Unavailable or corrupt caches are refetched. */
    }
    missing.push(name);
  }

  const received = missing.length ? await options.request(missing) : [];
  if (!Array.isArray(received)) throw new Error('server content response must be an array');
  const awaiting = new Set(missing);
  for (const data of received) {
    if (
      data === null ||
      typeof data !== 'object' ||
      !('name' in data) ||
      typeof data.name !== 'string'
    )
      throw new Error('received malformed content table');
    const name = data.name;
    if (!isContentTableName(name)) throw new Error(`received unknown table '${name}'`);
    if (!awaiting.delete(name))
      throw new Error(`received duplicate or unrequested table '${name}'`);
    const table = validateTable(name, data);
    const expected = manifest.tables[name]!;
    if (table.hash !== expected.hash)
      throw new Error(`table '${name}' hash does not match the manifest hash`);
    if (table.version !== expected.version)
      throw new Error(`table '${name}' version does not match the manifest version`);
    pending.push(table);
    result.fetched.push(name);
  }
  if (awaiting.size)
    throw new Error(`server did not send requested tables: ${[...awaiting].join(', ')}`);
  const candidate = new ContentStore();
  candidate.loadAll(pending);
  candidate.assertReady();
  options.store.loadAll(pending);
  for (const table of pending) {
    try {
      await options.cache.put(table);
    } catch {
      /* Caching is optional. */
    }
  }
  return result;
}
