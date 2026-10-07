// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Local project library and crash recovery in IndexedDB.
//
//   projects: the last saved revision of each project, plus the previous revision as a
//             known-good checkpoint. A save commits atomically and only over the revision it
//             was based on; anything else is a conflict (another tab saved first) and is
//             reported instead of overwritten.
//   drafts:   autosaved work since the last save, one per project. Kept until a save (or an
//             explicit discard) supersedes it, so a crash or closed tab loses at most one
//             autosave interval.
import type { ScenarioProject } from '../../../../../shared/typescript/scenario-schema';

const DB_VERSION = 1;
const PROJECTS = 'projects';
const DRAFTS = 'drafts';

export interface ProjectRecord {
  id: string;
  title: string;
  revision: number;
  savedAt: number;
  project: ScenarioProject;
  previous?: ScenarioProject;
}

export interface DraftRecord {
  id: string;
  title: string;
  /** Saved revision the draft continues from (0 = never saved). */
  baseRevision: number;
  updatedAt: number;
  project: ScenarioProject;
}

export interface ProjectSummary {
  id: string;
  title: string;
  revision: number;
  savedAt?: number;
  draftAt?: number;
  draftBase?: number;
}

export type SaveOutcome =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; storedRevision: number }
  | { ok: false; conflict: false; error: string };

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class ProjectDb {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = 'prevast-editor',
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
  ) {}

  close(): void {
    void this.db?.then((db) => db.close()).catch(() => {});
    this.db = null;
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!this.factory) {
        reject(new Error('Browser storage (IndexedDB) is unavailable.'));
        return;
      }
      const req = this.factory.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close();
          this.db = null;
        };
        resolve(req.result);
      };
      req.onblocked = () => reject(new Error('Browser storage is blocked by another tab.'));
      req.onerror = () => reject(req.error ?? new Error('Browser storage failed to open.'));
    }).catch((error: unknown) => {
      this.db = null;
      throw error;
    });
    return this.db;
  }

  async list(): Promise<ProjectSummary[]> {
    const db = await this.open();
    const tx = db.transaction([PROJECTS, DRAFTS], 'readonly');
    const [projects, drafts] = await Promise.all([
      promisify(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectRecord[]>),
      promisify(tx.objectStore(DRAFTS).getAll() as IDBRequest<DraftRecord[]>),
    ]);
    const out = new Map<string, ProjectSummary>();
    for (const p of projects) out.set(p.id, { id: p.id, title: p.title, revision: p.revision, savedAt: p.savedAt });
    for (const d of drafts) {
      const s = out.get(d.id) ?? { id: d.id, title: d.title, revision: 0 };
      out.set(d.id, { ...s, title: s.savedAt ? s.title : d.title, draftAt: d.updatedAt, draftBase: d.baseRevision });
    }
    return [...out.values()].sort(
      (a, b) => Math.max(b.savedAt ?? 0, b.draftAt ?? 0) - Math.max(a.savedAt ?? 0, a.draftAt ?? 0),
    );
  }

  async load(id: string): Promise<ProjectRecord | undefined> {
    const db = await this.open();
    return promisify(db.transaction(PROJECTS).objectStore(PROJECTS).get(id) as IDBRequest<ProjectRecord | undefined>);
  }

  async loadDraft(id: string): Promise<DraftRecord | undefined> {
    const db = await this.open();
    return promisify(db.transaction(DRAFTS).objectStore(DRAFTS).get(id) as IDBRequest<DraftRecord | undefined>);
  }

  /**
   * Saves `project` as revision baseRevision + 1, provided the stored revision is still
   * `baseRevision`. The draft is cleared in the same transaction.
   */
  async save(project: ScenarioProject, baseRevision: number): Promise<SaveOutcome> {
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (e) {
      return { ok: false, conflict: false, error: (e as Error).message };
    }
    const tx = db.transaction([PROJECTS, DRAFTS], 'readwrite');
    const finished = done(tx);
    const projects = tx.objectStore(PROJECTS);
    const current = await promisify(projects.get(project.id) as IDBRequest<ProjectRecord | undefined>);
    const storedRevision = current?.revision ?? 0;
    if (storedRevision !== baseRevision) {
      tx.abort();
      await finished.catch(() => {});
      return { ok: false, conflict: true, storedRevision };
    }
    const revision = baseRevision + 1;
    const saved: ScenarioProject = { ...project, revision };
    const record: ProjectRecord = {
      id: project.id,
      title: project.title,
      revision,
      savedAt: Date.now(),
      project: saved,
      ...(current ? { previous: current.project } : {}),
    };
    projects.put(record);
    tx.objectStore(DRAFTS).delete(project.id);
    try {
      await finished;
    } catch (e) {
      return { ok: false, conflict: false, error: (e as Error).message };
    }
    return { ok: true, revision };
  }

  async putDraft(project: ScenarioProject, baseRevision: number): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readwrite');
    const record: DraftRecord = { id: project.id, title: project.title, baseRevision, updatedAt: Date.now(), project };
    tx.objectStore(DRAFTS).put(record);
    await done(tx);
  }

  async discardDraft(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(DRAFTS, 'readwrite');
    tx.objectStore(DRAFTS).delete(id);
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([PROJECTS, DRAFTS], 'readwrite');
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(DRAFTS).delete(id);
    await done(tx);
  }
}

/** Announces saves to other tabs editing the same project. */
export class ProjectChannel {
  private readonly channel: BroadcastChannel | null;

  constructor(onSaved: (id: string, revision: number) => void, name = 'prevast-editor') {
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
    if (this.channel)
      this.channel.onmessage = (ev: MessageEvent<{ type: string; id: string; revision: number }>) => {
        if (ev.data?.type === 'saved') onSaved(ev.data.id, ev.data.revision);
      };
  }

  saved(id: string, revision: number): void {
    this.channel?.postMessage({ type: 'saved', id, revision });
  }

  close(): void {
    this.channel?.close();
  }
}
