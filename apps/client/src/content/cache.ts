// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Cache failures only cost a refetch. Data is validated by the sync boundary.
import type { ContentTable, ContentValue } from '../../../../shared/typescript/content-format';
type Table = ContentTable<ContentValue>;
export interface ContentCache {
  get(name: string, hash: string): Promise<Table | undefined>;
  put(table: Table): Promise<void>;
  clear(): Promise<void>;
}
export class MemoryCache implements ContentCache {
  private readonly tables = new Map<string, Table>();
  private key(name: string, hash: string): string {
    return `${name}\u0000${hash}`;
  }
  async get(name: string, hash: string): Promise<Table | undefined> {
    const table = this.tables.get(this.key(name, hash));
    return table ? structuredClone(table) : undefined;
  }
  async put(table: Table): Promise<void> {
    this.tables.set(this.key(table.name, table.hash), structuredClone(table));
  }
  async clear(): Promise<void> {
    this.tables.clear();
  }
}
const STORE = 'tables';
type CachedTable = Table & { cacheKey: string };

export class IndexedDbCache implements ContentCache {
  private db: Promise<IDBDatabase> | null = null;
  constructor(
    private readonly dbName = 'prevast-content',
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = this.factory.open(this.dbName, 1);
      let blocked = false;
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE, { keyPath: 'cacheKey' });
      };
      req.onsuccess = () => {
        if (blocked) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => {
          req.result.close();
          this.db = null;
        };
        resolve(req.result);
      };
      req.onblocked = () => {
        blocked = true;
        reject(new Error('IndexedDB open blocked'));
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    }).catch((error: unknown) => {
      this.db = null;
      throw error;
    });
    return this.db;
  }
  private async transact(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      const req = operation(tx.objectStore(STORE));
      req.onsuccess = () => {
        result = req.result as unknown;
      };
    });
  }
  async get(name: string, hash: string): Promise<Table | undefined> {
    try {
      const table = (await this.transact('readonly', (store) =>
        store.get(`${name}\u0000${hash}`),
      )) as CachedTable | undefined;
      if (!table || table.name !== name || table.hash !== hash) return undefined;
      const { cacheKey: _cacheKey, ...content } = table;
      return content;
    } catch {
      return undefined;
    }
  }
  async put(table: Table): Promise<void> {
    try {
      const value: CachedTable = { ...table, cacheKey: `${table.name}\u0000${table.hash}` };
      await this.transact('readwrite', (store) => store.put(value));
    } catch {
      /* Refetch next time. */
    }
  }
  async clear(): Promise<void> {
    try {
      await this.transact('readwrite', (store) => store.clear());
    } catch {
      /* Nothing to clear. */
    }
  }
}
