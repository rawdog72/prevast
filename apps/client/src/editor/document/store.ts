// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The open project, as indexed records plus an undo history of command deltas. A transaction
// records (before, after) per touched record, so a brush stroke of a thousand tiles is one
// undo step that stores only what changed -- never a copy of the world per mouse move.
// Records are frozen: an edit always replaces a record, so a delta can hold references.
import {
  SCENARIO_FORMAT,
  SCENARIO_SCHEMA_VERSION,
  requiredFeatures,
  type LootTable,
  type ScenarioEditorMeta,
  type ScenarioEntity,
  type ScenarioGroup,
  type ScenarioProject,
  type ScenarioRegion,
  type ScenarioTemplate,
  type ScenarioWorld,
} from '../../../../../shared/typescript/scenario-schema';

export type RecordKind = 'entity' | 'group' | 'region' | 'template' | 'loot';

export interface RecordTypes {
  entity: ScenarioEntity;
  group: ScenarioGroup;
  region: ScenarioRegion;
  template: ScenarioTemplate;
  loot: LootTable;
}

export type AnyRecord = RecordTypes[RecordKind];

/** Gameplay-relevant header fields that edits (and undo) can change. */
export interface DocumentHeader {
  title: string;
  world: ScenarioWorld;
}

export type Change =
  | { kind: RecordKind; id: string; before: AnyRecord | null; after: AnyRecord | null }
  | { kind: 'header'; id: ''; before: DocumentHeader; after: DocumentHeader };

export interface Transaction {
  label: string;
  changes: Change[];
}

export type ChangeSource = 'edit' | 'undo' | 'redo' | 'load' | 'preview';
export type ChangeListener = (changes: readonly Change[], source: ChangeSource) => void;

const HISTORY_LIMIT = 200;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class DocumentStore {
  /** Identity; changes only through Save a Copy (a new document). */
  readonly projectId: string;
  header: DocumentHeader;
  /** Saved revision this document descends from (0 = never saved). */
  revision: number;
  /** Next number for generated IDs. Monotonic and outside history: undo never reuses an ID. */
  nextId: number;
  content?: Record<string, string>;
  editor: ScenarioEditorMeta;

  readonly entities = new Map<string, ScenarioEntity>();
  readonly groups = new Map<string, ScenarioGroup>();
  readonly regions = new Map<string, ScenarioRegion>();
  readonly templates = new Map<string, ScenarioTemplate>();
  readonly lootTables = new Map<string, LootTable>();
  /** parent group id -> child entity/group/region ids. */
  private readonly children = new Map<string, Set<string>>();

  /** Bumped on every applied change; `savedVersion` is the version at the last save. */
  version = 0;
  savedVersion = 0;

  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  private open: { label: string; changes: Map<string, Change> } | null = null;
  private readonly listeners = new Set<ChangeListener>();

  constructor(project: ScenarioProject) {
    this.projectId = project.id;
    this.revision = project.revision;
    this.nextId = project.nextId;
    this.content = project.content;
    this.editor = structuredClone(project.editor ?? {});
    this.header = deepFreeze({ title: project.title, world: structuredClone(project.world) });
    for (const e of project.entities) this.index('entity', null, deepFreeze(structuredClone(e)));
    for (const g of project.groups) this.index('group', null, deepFreeze(structuredClone(g)));
    for (const r of project.regions) this.index('region', null, deepFreeze(structuredClone(r)));
    for (const t of project.templates) this.index('template', null, deepFreeze(structuredClone(t)));
    for (const t of project.lootTables) this.index('loot', null, deepFreeze(structuredClone(t)));
    this.savedVersion = this.version;
  }

  // --- reading --------------------------------------------------------------------------------

  map<K extends RecordKind>(kind: K): Map<string, RecordTypes[K]> {
    switch (kind) {
      case 'entity':
        return this.entities as Map<string, RecordTypes[K]>;
      case 'group':
        return this.groups as Map<string, RecordTypes[K]>;
      case 'region':
        return this.regions as Map<string, RecordTypes[K]>;
      case 'loot':
        return this.lootTables as Map<string, RecordTypes[K]>;
      default:
        return this.templates as Map<string, RecordTypes[K]>;
    }
  }

  /** Which kind an ID in the shared entity/group/region namespace belongs to. */
  kindOf(id: string): 'entity' | 'group' | 'region' | undefined {
    if (this.entities.has(id)) return 'entity';
    if (this.groups.has(id)) return 'group';
    if (this.regions.has(id)) return 'region';
    return undefined;
  }

  childrenOf(groupId: string): ReadonlySet<string> {
    return this.children.get(groupId) ?? new Set();
  }

  /** Every entity/group/region under a group, depth-first, excluding the group itself. */
  descendants(groupId: string): string[] {
    const out: string[] = [];
    const walk = (id: string) => {
      for (const child of this.childrenOf(id)) {
        out.push(child);
        if (this.groups.has(child)) walk(child);
      }
    };
    walk(groupId);
    return out;
  }

  /** Regions attached to an entity (their shape follows it). */
  attachedRegions(entityId: string): ScenarioRegion[] {
    const out: ScenarioRegion[] = [];
    for (const r of this.regions.values()) if (r.attach === entityId) out.push(r);
    return out;
  }

  get dirty(): boolean {
    return this.version !== this.savedVersion;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 && !this.open;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0 && !this.open;
  }

  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  get inTransaction(): boolean {
    return this.open !== null;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- IDs ------------------------------------------------------------------------------------

  /** A fresh ID in the shared namespace: `e12`, `g3`, `r7`, `t2`, `l4`. */
  allocId(prefix: 'e' | 'g' | 'r' | 't' | 'l'): string {
    for (;;) {
      const id = `${prefix}${this.nextId++}`;
      if (!this.kindOf(id) && !this.templates.has(id) && !this.lootTables.has(id)) return id;
    }
  }

  // --- editing --------------------------------------------------------------------------------

  begin(label: string): void {
    if (this.open) throw new Error(`transaction "${this.open.label}" is still open`);
    this.open = { label, changes: new Map() };
  }

  /** Ends the open transaction; returns false (and records nothing) when nothing changed. */
  commit(): boolean {
    const open = this.open;
    if (!open) throw new Error('no open transaction');
    this.open = null;
    const changes = [...open.changes.values()].filter((c) => c.before !== c.after);
    if (!changes.length) return false;
    this.undoStack.push({ label: open.label, changes });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  /** Reverts everything the open transaction changed. */
  cancel(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    const reverted = [...open.changes.values()].reverse().map((c) => this.invert(c));
    this.applyAll(reverted, 'undo');
  }

  /** Runs `fn` as one undoable step; cancels on throw. */
  transact<T>(label: string, fn: () => T): T {
    this.begin(label);
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (e) {
      this.cancel();
      throw e;
    }
  }

  put<K extends RecordKind>(kind: K, record: RecordTypes[K]): void {
    const frozen = deepFreeze(record);
    const before = this.map(kind).get(frozen.id) ?? null;
    this.record({ kind, id: frozen.id, before, after: frozen } as Change);
  }

  remove(kind: RecordKind, id: string): void {
    const before = this.map(kind).get(id);
    if (!before) return;
    this.record({ kind, id, before, after: null } as Change);
  }

  setHeader(patch: Partial<DocumentHeader>): void {
    const after = deepFreeze({ ...this.header, ...patch });
    this.record({ kind: 'header', id: '', before: this.header, after });
  }

  /** Editor-only state (camera, layers, favorites): outside history, saved with the next save. */
  setEditorMeta(patch: Partial<ScenarioEditorMeta>): void {
    this.editor = { ...this.editor, ...patch };
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    const tx = this.undoStack.pop()!;
    this.applyAll([...tx.changes].reverse().map((c) => this.invert(c)), 'undo');
    this.redoStack.push(tx);
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    const tx = this.redoStack.pop()!;
    this.applyAll(tx.changes, 'redo');
    this.undoStack.push(tx);
    return true;
  }

  // --- serialization --------------------------------------------------------------------------

  toProject(): ScenarioProject {
    const entities = [...this.entities.values()];
    const regions = [...this.regions.values()];
    const lootTables = [...this.lootTables.values()];
    return structuredClone({
      format: SCENARIO_FORMAT,
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      id: this.projectId,
      title: this.header.title,
      revision: this.revision,
      nextId: this.nextId,
      requiredFeatures: requiredFeatures({ entities, regions, lootTables }),
      ...(this.content ? { content: this.content } : {}),
      world: this.header.world,
      entities,
      groups: [...this.groups.values()],
      regions,
      templates: [...this.templates.values()],
      lootTables,
      ...(Object.keys(this.editor).length ? { editor: this.editor } : {}),
    });
  }

  markSaved(revision: number, content?: Record<string, string>): void {
    this.revision = revision;
    if (content) this.content = content;
    this.savedVersion = this.version;
  }

  // --- internals ------------------------------------------------------------------------------

  private record(change: Change): void {
    if (!this.open) {
      // A lone edit is its own transaction.
      this.begin('Edit');
      this.record(change);
      this.commit();
      return;
    }
    const key = `${change.kind}:${change.id}`;
    const prior = this.open.changes.get(key);
    // Keep the first `before` and the latest `after` per record.
    this.open.changes.set(key, prior ? ({ ...change, before: prior.before } as Change) : change);
    this.applyAll([change], 'edit');
  }

  private invert(change: Change): Change {
    return { ...change, before: change.after, after: change.before } as Change;
  }

  private applyAll(changes: readonly Change[], source: ChangeSource): void {
    for (const change of changes) {
      if (change.kind === 'header') this.header = change.after;
      else this.index(change.kind, change.before, change.after);
    }
    this.version++;
    for (const listener of this.listeners) listener(changes, source);
  }

  private index(kind: RecordKind, before: AnyRecord | null, after: AnyRecord | null): void {
    const map = this.map(kind) as Map<string, AnyRecord>;
    const id = (after ?? before)!.id;
    const current = map.get(id);
    const oldParent = current && 'parent' in current ? current.parent : undefined;
    if (after) map.set(id, after);
    else map.delete(id);
    if (kind === 'template' || kind === 'loot') return;
    const newParent = after && 'parent' in after ? after.parent : undefined;
    if (oldParent !== newParent) {
      if (oldParent) this.children.get(oldParent)?.delete(id);
      if (newParent) {
        let set = this.children.get(newParent);
        if (!set) this.children.set(newParent, (set = new Set()));
        set.add(id);
      }
    }
    this.version++;
  }
}
