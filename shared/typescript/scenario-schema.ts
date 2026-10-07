// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The World & Mode Editor project document (docs/world-editor.md):
// a portable, versioned JSON file (`*.prevast.json`) with stable IDs. This module owns its
// shape, structural validation, migrations and diagnostics. It knows nothing about content
// tables: whether `ref` names a real object is a compatibility check against a catalog, done
// by the editor (and independently by the C++ scenario compiler).
//
// Units: map size in tiles; positions and distances in integer world units (a tile is
// TILE_SIZE units and grid pieces sit on tile centres); rotations in quarter turns; facing
// angles in the wire's 0..255 steps. Every number in a document is an integer, so the
// canonical form (scenario-canonical.ts) is identical in every language.
import { z } from 'zod';
import { EDITOR_LIMITS, HALF_TILE, TILE_SIZE } from './editor-limits';

export const SCENARIO_FORMAT = 'prevast-scenario';
/** Projects saved before the project was renamed; read as SCENARIO_FORMAT. */
export const LEGACY_SCENARIO_FORMAT = 'devast-scenario';
export const SCENARIO_SCHEMA_VERSION = EDITOR_LIMITS.project.schemaVersion;
export const SCENARIO_FILE_EXTENSION = '.prevast.json';

const L = EDITOR_LIMITS.project;
const W = EDITOR_LIMITS.world;

// --- Types ----------------------------------------------------------------------------------

/** What a placement is. `object` covers objects.xml and furnitures.xml (one key space). */
export const ENTITY_KINDS = ['object', 'resource', 'agent', 'npc', 'spawn'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** Kinds that sit on tile centres, one grid cell each (plus a second cell for two-tile pieces). */
export const GRID_KINDS: ReadonlySet<EntityKind> = new Set(['object', 'resource']);

export interface EntityOverrides {
  /** Maximum health for this instance only; absent = the definition's healthMax. */
  healthMax?: number;
  /** Health at start, at most the effective maximum; absent = full. */
  health?: number;
  /** false = cannot be damaged. Explicit rather than encoded as zero health. */
  destructible?: boolean;
  /** Doors only: authored open state. */
  doorOpen?: boolean;
}

/** An item by content key (items.xml) and a stack count. */
export interface ItemStack {
  item: string;
  count: number;
}

/** A container's authored contents; absent = the object type's default contents. */
export interface ContainerContents {
  /** Always placed first, in order. */
  fixed?: ItemStack[];
  /** Loot table rolled into the slots `fixed` leaves free. */
  loot?: string;
  /** Refill empty slots this often; player deposits are never replaced. Absent = never. */
  refillSeconds?: number;
}

export interface ScenarioEntity {
  id: string;
  kind: EntityKind;
  /** Content key: objects/furnitures key, resource key, agent key, npc key; `player` for spawns. */
  ref: string;
  /** Road texture / resource type id. */
  variant?: number;
  x: number;
  y: number;
  /** Quarter turns 0..3 (objects). */
  rotation?: number;
  /** Facing 0..255 (resources, agents, NPCs, spawns). */
  angle?: number;
  parent?: string;
  name?: string;
  tags?: string[];
  overrides?: EntityOverrides;
  /** Spawns: scenario team key (not a player clan). */
  team?: string;
  /** Spawns: relative selection weight. */
  weight?: number;
  /** NPCs: wander radius in tiles, overriding the definition's; 0 stays put. */
  wander?: number;
  /** Spawns: items granted instead of the starting kit. Absent = the usual kit. */
  loadout?: ItemStack[];
  /** Objects with storage: authored contents and refill. */
  container?: ContainerContents;
}

export const GROUP_KINDS = ['group', 'house', 'city'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export interface TemplateLink {
  id: string;
  revision: number;
  /** false = an independent copy that merely remembers where it came from. */
  linked: boolean;
}

export interface ScenarioGroup {
  id: string;
  name: string;
  kind: GroupKind;
  parent?: string;
  /** Rotation/placement pivot, on a tile centre or a tile corner (both axes alike). */
  pivot: { x: number; y: number };
  /** Opt in to a minimap/city marker. Labeling a group never adds gameplay on its own. */
  marker?: boolean;
  tags?: string[];
  template?: TemplateLink;
}

export type RegionShape =
  | { type: 'circle'; x: number; y: number; r: number }
  | { type: 'rect'; x: number; y: number; w: number; h: number }
  | { type: 'polygon'; points: [number, number][] };

export const EFFECT_STATS = ['health', 'warmth', 'stamina', 'radiation', 'food'] as const;
export type EffectStat = (typeof EFFECT_STATS)[number];

export interface RegionEffect {
  stat: EffectStat;
  /**
   * Signed gauge points per minute at full strength. Radiation: positive contaminates,
   * negative cleanses, whatever the HUD's inverted cleanliness bar shows.
   */
  perMinute: number;
  falloff: 'none' | 'linear';
  /** Stack channel; within one channel the strongest contribution per direction wins. */
  channel?: string;
  stacking?: 'strongest' | 'additive';
}

export const PERMISSIONS = ['allow', 'deny'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface RegionPermissions {
  build?: Permission;
  pvp?: Permission;
  spawn?: Permission;
}

/**
 * Keeps a creature population inside a region: every `everySeconds` up to `batch` spawn, while
 * fewer than `maxAlive` live, until `total` (if set) have spawned.
 */
export interface RegionSpawner {
  /** Creature key (agents.xml). */
  agent: string;
  maxAlive: number;
  batch: number;
  everySeconds: number;
  total?: number;
  /** Seconds after the world opens before the first spawn. */
  startDelay?: number;
}

export interface ScenarioRegion {
  id: string;
  name: string;
  shape: RegionShape;
  /** Group whose transforms carry this region. */
  parent?: string;
  /** Entity the shape is relative to: the shape's coordinates are offsets from it. */
  attach?: string;
  /** Higher wins for permissions; at equal priority denial wins. */
  priority: number;
  permissions?: RegionPermissions;
  effects?: RegionEffect[];
  spawner?: RegionSpawner;
}

export interface LootEntry {
  item: string;
  min: number;
  max: number;
  /** Weighted tables: relative weight. Independent tables: chance in basis points (of 10000). */
  weight: number;
}

/**
 * `weighted`: `rolls` picks, each one entry by weight or nothing with weight `empty`.
 * `independent`: every entry rolls once against its own chance.
 */
export type LootTable =
  | { id: string; name: string; mode: 'weighted'; rolls: number; empty: number; entries: LootEntry[] }
  | { id: string; name: string; mode: 'independent'; entries: LootEntry[] };

export interface ScenarioTemplate {
  id: string;
  name: string;
  revision: number;
  /** Footprint in tiles; the template's own coordinates start at (0, 0). */
  size: { w: number; h: number };
  source?: 'authored' | 'legacy-structure';
  entities: ScenarioEntity[];
  groups: ScenarioGroup[];
  regions: ScenarioRegion[];
}

export interface ScenarioWorld {
  tilesX: number;
  tilesY: number;
  /** Deterministic seed for every random stream (uint32). */
  seed: number;
  time: 'cycle' | 'day' | 'night';
  /** Procedural population is opt-in: an authored map holds only what was placed. */
  population: { resources: boolean; structures: boolean; agents: boolean };
}

export interface EditorLayerState {
  hidden?: boolean;
  locked?: boolean;
}

/** Non-gameplay authoring state. Never affects runtime behaviour or the gameplay hash. */
export interface ScenarioEditorMeta {
  layers?: Record<string, EditorLayerState>;
  camera?: { x: number; y: number; zoom: number };
  bookmarks?: { name: string; x: number; y: number }[];
  favorites?: string[];
}

export interface ScenarioProject {
  format: typeof SCENARIO_FORMAT;
  schemaVersion: number;
  id: string;
  title: string;
  /** Saved revision; 0 = never saved. */
  revision: number;
  /** Next free number for generated IDs (`e12`, `g3`, ...). */
  nextId: number;
  requiredFeatures: string[];
  /** Content table hashes at the last save: the compatibility manifest. */
  content?: Record<string, string>;
  world: ScenarioWorld;
  entities: ScenarioEntity[];
  groups: ScenarioGroup[];
  regions: ScenarioRegion[];
  templates: ScenarioTemplate[];
  lootTables: LootTable[];
  editor?: ScenarioEditorMeta;
}

// --- Diagnostics ----------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine code, e.g. `graph.cycle`. Shared with the C++ validator. */
  code: string;
  /** JSON path into the document, e.g. `entities[3].x`. */
  path: string;
  message: string;
  /** Selectable entity/group/region ID, when the problem belongs to one. */
  target?: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

// --- Zod shapes -----------------------------------------------------------------------------

const int = z.number().int();
const coord = int.min(0).max(W.positionMax);
const id = z
  .string()
  .min(1)
  .max(L.maxIdLength)
  .regex(/^[A-Za-z0-9_-]+$/, 'IDs use letters, digits, _ and - only');
const name = z.string().max(L.maxNameLength);
const tag = z.string().min(1).max(L.maxTagLength);
const tags = z.array(tag).max(L.maxTagsPerEntity);

const overrides = z.strictObject({
  healthMax: int.min(1).max(EDITOR_LIMITS.overrides.healthMax).optional(),
  health: int.min(1).max(EDITOR_LIMITS.overrides.healthMax).optional(),
  destructible: z.boolean().optional(),
  doorOpen: z.boolean().optional(),
});

const itemStack = z.strictObject({ item: z.string().min(1).max(L.maxIdLength), count: int.min(1).max(255) });

const containerSchema = z.strictObject({
  fixed: z.array(itemStack).max(L.maxLootEntries).optional(),
  loot: id.optional(),
  refillSeconds: int.min(10).max(86400).optional(),
});

const entitySchema = z.strictObject({
  id,
  kind: z.enum(ENTITY_KINDS),
  ref: z.string().min(1).max(L.maxIdLength),
  variant: int.min(0).max(63).optional(),
  x: coord,
  y: coord,
  rotation: int.min(0).max(3).optional(),
  angle: int.min(0).max(255).optional(),
  parent: id.optional(),
  name: name.optional(),
  tags: tags.optional(),
  overrides: overrides.optional(),
  team: tag.optional(),
  weight: int.min(1).max(1000).optional(),
  wander: int.min(0).max(20).optional(),
  loadout: z.array(itemStack).max(L.maxLoadoutItems).optional(),
  container: containerSchema.optional(),
});

const point = z.strictObject({ x: coord, y: coord });

const groupSchema = z.strictObject({
  id,
  name,
  kind: z.enum(GROUP_KINDS),
  parent: id.optional(),
  pivot: point,
  marker: z.boolean().optional(),
  tags: tags.optional(),
  template: z
    .strictObject({ id, revision: int.min(1), linked: z.boolean() })
    .optional(),
});

// Shapes are signed: an attached region's coordinates are offsets from its entity.
const offset = int.min(-W.positionMax).max(W.positionMax);
const shapeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('circle'), x: offset, y: offset, r: int.min(1).max(W.positionMax) }),
  z.strictObject({
    type: z.literal('rect'),
    x: offset,
    y: offset,
    w: int.min(1).max(W.positionMax),
    h: int.min(1).max(W.positionMax),
  }),
  z.strictObject({
    type: z.literal('polygon'),
    points: z.array(z.tuple([offset, offset])).min(3).max(64),
  }),
]);

const effectSchema = z.strictObject({
  stat: z.enum(EFFECT_STATS),
  perMinute: int.min(-6000).max(6000),
  falloff: z.enum(['none', 'linear']),
  channel: tag.optional(),
  stacking: z.enum(['strongest', 'additive']).optional(),
});

const regionSchema = z.strictObject({
  id,
  name,
  shape: shapeSchema,
  parent: id.optional(),
  attach: id.optional(),
  priority: int.min(-1000).max(1000),
  permissions: z
    .strictObject({
      build: z.enum(PERMISSIONS).optional(),
      pvp: z.enum(PERMISSIONS).optional(),
      spawn: z.enum(PERMISSIONS).optional(),
    })
    .optional(),
  effects: z.array(effectSchema).max(16).optional(),
  spawner: z
    .strictObject({
      agent: z.string().min(1).max(L.maxIdLength),
      maxAlive: int.min(1).max(L.maxSpawnerAlive),
      batch: int.min(1).max(16),
      everySeconds: int.min(1).max(3600),
      total: int.min(1).max(100000).optional(),
      startDelay: int.min(0).max(3600).optional(),
    })
    .optional(),
});

const lootEntry = z.strictObject({
  item: z.string().min(1).max(L.maxIdLength),
  min: int.min(1).max(255),
  max: int.min(1).max(255),
  weight: int.min(1).max(10000),
});

const lootTableSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    id,
    name,
    mode: z.literal('weighted'),
    rolls: int.min(1).max(16),
    empty: int.min(0).max(10000),
    entries: z.array(lootEntry).min(1).max(L.maxLootEntries),
  }),
  z.strictObject({
    id,
    name,
    mode: z.literal('independent'),
    entries: z.array(lootEntry).min(1).max(L.maxLootEntries),
  }),
]);

const templateSchema = z.strictObject({
  id,
  name,
  revision: int.min(1),
  size: z.strictObject({ w: int.min(1).max(W.maxTiles), h: int.min(1).max(W.maxTiles) }),
  source: z.enum(['authored', 'legacy-structure']).optional(),
  entities: z.array(entitySchema).max(L.maxTemplateEntities),
  groups: z.array(groupSchema).max(L.maxGroups),
  regions: z.array(regionSchema).max(L.maxRegions),
});

const worldSchema = z.strictObject({
  tilesX: int,
  tilesY: int,
  seed: int.min(0).max(0xffffffff),
  time: z.enum(['cycle', 'day', 'night']),
  population: z.strictObject({
    resources: z.boolean(),
    structures: z.boolean(),
    agents: z.boolean(),
  }),
});

const editorSchema = z.strictObject({
  layers: z
    .record(
      z.string().max(L.maxIdLength),
      z.strictObject({ hidden: z.boolean().optional(), locked: z.boolean().optional() }),
    )
    .optional(),
  camera: z.strictObject({ x: int, y: int, zoom: z.number().positive().max(16) }).optional(),
  bookmarks: z.array(z.strictObject({ name, x: coord, y: coord })).max(64).optional(),
  favorites: z.array(z.string().max(160)).max(256).optional(),
});

const projectSchema = z.strictObject({
  format: z.literal(SCENARIO_FORMAT),
  schemaVersion: z.literal(SCENARIO_SCHEMA_VERSION),
  id,
  title: name,
  revision: int.min(0),
  nextId: int.min(1),
  requiredFeatures: z.array(z.string().max(64)).max(64),
  content: z.record(z.string().max(64), z.string().max(128)).optional(),
  world: worldSchema,
  entities: z.array(entitySchema),
  groups: z.array(groupSchema),
  regions: z.array(regionSchema),
  templates: z.array(templateSchema).max(L.maxTemplates),
  lootTables: z.array(lootTableSchema),
  editor: editorSchema.optional(),
});

// --- Migrations -----------------------------------------------------------------------------

/**
 * One step per version: MIGRATIONS[n] turns a version-n document into version n+1. Each is a
 * pure function over a copy, so a failed migration leaves the caller's original untouched.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // v2: loot tables, container contents, loadouts, NPC wander and region spawners. All new
  // entity/region fields are optional; the project gains an empty loot table list.
  1: (doc) => ({ ...doc, lootTables: [] }),
};

export interface MigrationResult {
  document?: Record<string, unknown>;
  diagnostics: Diagnostic[];
  migratedFrom?: number;
}

export function migrateProject(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { diagnostics: [error('schema.not-object', '', 'A project must be a JSON object.')] };
  const doc = raw as Record<string, unknown>;
  if (doc.format !== SCENARIO_FORMAT && doc.format !== LEGACY_SCENARIO_FORMAT)
    return {
      diagnostics: [
        error('schema.format', 'format', `Not a Prevast scenario project (format must be "${SCENARIO_FORMAT}").`),
      ],
    };
  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return { diagnostics: [error('schema.version', 'schemaVersion', 'schemaVersion must be a positive integer.')] };
  if (version > SCENARIO_SCHEMA_VERSION)
    return {
      diagnostics: [
        error(
          'schema.version-newer',
          'schemaVersion',
          `This project uses schema ${version}; this editor supports up to ${SCENARIO_SCHEMA_VERSION}. Update the game before opening it.`,
        ),
      ],
    };
  let current: Record<string, unknown> = { ...structuredClone(doc), format: SCENARIO_FORMAT };
  for (let v = version; v < SCENARIO_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step)
      return { diagnostics: [error('schema.migration-missing', 'schemaVersion', `No migration from schema ${v}.`)] };
    current = { ...step(current), schemaVersion: v + 1 };
  }
  return { document: current, diagnostics: [], migratedFrom: version === SCENARIO_SCHEMA_VERSION ? undefined : version };
}

// --- Structural validation ------------------------------------------------------------------

export interface ValidationResult {
  project?: ScenarioProject;
  diagnostics: Diagnostic[];
}

function error(code: string, path: string, message: string, target?: string): Diagnostic {
  return { severity: 'error', code, path, message, ...(target ? { target } : {}) };
}

function warning(code: string, path: string, message: string, target?: string): Diagnostic {
  return { severity: 'warning', code, path, message, ...(target ? { target } : {}) };
}

function zodPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** Validates a JSON text: the byte budget is checked before anything is parsed. */
export function parseProjectText(text: string): ValidationResult {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > L.maxBytes)
    return {
      diagnostics: [
        error('budget.bytes', '', `Project is ${bytes} bytes; the limit is ${L.maxBytes}.`),
      ],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { diagnostics: [error('json.syntax', '', `Not valid JSON: ${(e as Error).message}`)] };
  }
  return validateProject(raw);
}

/**
 * Structural validation: shape, budgets, identities, graph and geometry. Dimensions and
 * counts are checked before the (allocation-heavy) full parse. Returns the typed project
 * only when there are no errors.
 */
export function validateProject(raw: unknown): ValidationResult {
  const migrated = migrateProject(raw);
  if (!migrated.document) return { diagnostics: migrated.diagnostics };
  const doc = migrated.document;
  const diagnostics: Diagnostic[] = [];
  if (migrated.migratedFrom !== undefined)
    diagnostics.push({
      severity: 'info',
      code: 'schema.migrated',
      path: 'schemaVersion',
      message: `Migrated from schema ${migrated.migratedFrom}.`,
    });

  // Cheap preflight: dimensions and array budgets before the full parse.
  const world = doc.world as Record<string, unknown> | undefined;
  if (world && typeof world === 'object') {
    for (const axis of ['tilesX', 'tilesY'] as const) {
      const v = world[axis];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < W.minTiles || v > W.maxTiles)
        diagnostics.push(
          error('world.size', `world.${axis}`, `${axis} must be ${W.minTiles}..${W.maxTiles} tiles, got ${JSON.stringify(v)}.`),
        );
    }
  }
  const budgets: [string, number, string][] = [
    ['entities', L.maxEntities, 'budget.entities'],
    ['groups', L.maxGroups, 'budget.groups'],
    ['regions', L.maxRegions, 'budget.regions'],
    ['templates', L.maxTemplates, 'budget.templates'],
    ['lootTables', L.maxLootTables, 'budget.loot-tables'],
  ];
  for (const [key, max, code] of budgets) {
    const list = doc[key];
    if (Array.isArray(list) && list.length > max)
      diagnostics.push(error(code, key, `${list.length} ${key}; the limit is ${max}.`));
  }
  if (hasErrors(diagnostics)) return { diagnostics };

  const parsed = projectSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 200))
      diagnostics.push(error('schema.invalid', zodPath(issue.path), issue.message));
    return { diagnostics };
  }
  const project = parsed.data as ScenarioProject;
  diagnostics.push(...checkGraph(project));
  return hasErrors(diagnostics) ? { diagnostics } : { project, diagnostics };
}

interface GraphScope {
  entities: readonly ScenarioEntity[];
  groups: readonly ScenarioGroup[];
  regions: readonly ScenarioRegion[];
  /** Bounds in world units, or null for template-local space (checked against its size). */
  widthUnits: number;
  heightUnits: number;
  prefix: string;
  lootIds: ReadonlySet<string>;
  /** Templates only warn: their loot references matter once placed. */
  inTemplate: boolean;
}

/** Identity, reference, hierarchy and geometry rules shared by the project and its templates. */
function checkScope(scope: GraphScope): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { prefix } = scope;
  const ids = new Map<string, string>();
  const claim = (value: string, path: string) => {
    const previous = ids.get(value);
    if (previous) out.push(error('id.duplicate', path, `ID "${value}" is also used at ${previous}.`, value));
    else ids.set(value, path);
  };
  scope.entities.forEach((e, i) => claim(e.id, `${prefix}entities[${i}].id`));
  scope.groups.forEach((g, i) => claim(g.id, `${prefix}groups[${i}].id`));
  scope.regions.forEach((r, i) => claim(r.id, `${prefix}regions[${i}].id`));

  const groups = new Map(scope.groups.map((g) => [g.id, g]));
  const entityIds = new Set(scope.entities.map((e) => e.id));
  const parentOk = (parent: string | undefined, path: string, owner: string) => {
    if (parent === undefined) return;
    if (!groups.has(parent))
      out.push(
        error(
          entityIds.has(parent) ? 'ref.parent-not-group' : 'ref.dangling-parent',
          path,
          `Parent "${parent}" is not a group in this project.`,
          owner,
        ),
      );
  };

  // Groups: parents exist, no cycles, bounded depth. Walk each chain once with memoised depth.
  const depth = new Map<string, number>();
  scope.groups.forEach((g, i) => {
    parentOk(g.parent, `${prefix}groups[${i}].parent`, g.id);
    const chain: string[] = [];
    let cursor: ScenarioGroup | undefined = g;
    const seen = new Set<string>();
    let base = 0;
    while (cursor) {
      if (depth.has(cursor.id)) {
        base = depth.get(cursor.id)!;
        break;
      }
      if (seen.has(cursor.id)) {
        out.push(error('graph.cycle', `${prefix}groups[${i}].parent`, `Group "${g.id}" is its own ancestor.`, g.id));
        base = Number.POSITIVE_INFINITY;
        break;
      }
      seen.add(cursor.id);
      chain.push(cursor.id);
      cursor = cursor.parent ? groups.get(cursor.parent) : undefined;
    }
    for (let k = chain.length - 1; k >= 0; k--) depth.set(chain[k]!, base + (chain.length - k));
    const d = depth.get(g.id)!;
    if (Number.isFinite(d) && d > EDITOR_LIMITS.project.maxGroupDepth)
      out.push(
        error('graph.too-deep', `${prefix}groups[${i}]`, `Group "${g.id}" is nested ${d} deep; the limit is ${EDITOR_LIMITS.project.maxGroupDepth}.`, g.id),
      );
    if (!pivotOk(g.pivot))
      out.push(
        error('group.pivot', `${prefix}groups[${i}].pivot`, 'A pivot must sit on tile centres or tile corners on both axes.', g.id),
      );
  });
  const cyclic = new Set(out.filter((d) => d.code === 'graph.cycle').map((d) => d.target));
  if (cyclic.size) return out;

  scope.entities.forEach((e, i) => {
    const path = `${prefix}entities[${i}]`;
    parentOk(e.parent, `${path}.parent`, e.id);
    if (e.x >= scope.widthUnits || e.y >= scope.heightUnits)
      out.push(error('entity.out-of-bounds', path, `"${e.id}" at (${e.x}, ${e.y}) is outside the map.`, e.id));
    if (GRID_KINDS.has(e.kind)) {
      if (e.x % TILE_SIZE !== HALF_TILE || e.y % TILE_SIZE !== HALF_TILE)
        out.push(error('entity.off-grid', path, `"${e.id}" must sit on a tile centre.`, e.id));
    } else if (e.rotation !== undefined) {
      out.push(error('entity.rotation', `${path}.rotation`, `Only grid pieces take quarter-turn rotation; use angle.`, e.id));
    }
    if (e.kind !== 'spawn' && (e.team !== undefined || e.weight !== undefined))
      out.push(error('entity.spawn-fields', path, 'team and weight belong to spawn points.', e.id));
    if (
      (e.wander !== undefined && e.kind !== 'npc') ||
      (e.loadout !== undefined && e.kind !== 'spawn') ||
      (e.container !== undefined && e.kind !== 'object')
    )
      out.push(error('entity.kind-fields', path, `"${e.id}": wander is for NPCs, loadout for spawns, container for objects.`, e.id));
    const loot = e.container?.loot;
    if (loot !== undefined && !scope.lootIds.has(loot))
      out.push(
        (scope.inTemplate ? warning : error)('ref.dangling-loot', `${path}.container.loot`, `"${e.id}" uses missing loot table "${loot}".`, e.id),
      );
    const o = e.overrides;
    if (o) {
      if (e.kind !== 'object')
        out.push(error('override.unsupported', `${path}.overrides`, `${e.kind} placements take no property overrides yet.`, e.id));
      if (o.health !== undefined && o.healthMax !== undefined && o.health > o.healthMax)
        out.push(error('override.range', `${path}.overrides.health`, 'Initial health exceeds the maximum.', e.id));
    }
  });

  scope.regions.forEach((r, i) => {
    const path = `${prefix}regions[${i}]`;
    parentOk(r.parent, `${path}.parent`, r.id);
    if (r.attach !== undefined && !entityIds.has(r.attach))
      out.push(error('ref.dangling-attach', `${path}.attach`, `Region "${r.id}" is attached to missing entity "${r.attach}".`, r.id));
    if (!r.effects?.length && !r.permissions && !r.spawner)
      out.push(warning('region.empty', path, `Region "${r.id}" has no effects or permissions.`, r.id));
    if (r.shape.type === 'polygon' && polygonSelfIntersects(r.shape.points))
      out.push(error('region.polygon', `${path}.shape`, `Region "${r.id}" polygon crosses itself.`, r.id));
    if (r.shape.type === 'polygon' && r.effects?.some((f) => f.falloff === 'linear'))
      out.push(error('effect.falloff-shape', `${path}.effects`, `Region "${r.id}": a fading effect needs a circle or rectangle.`, r.id));
  });
  return out;
}

function checkGraph(project: ScenarioProject): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lootIds = new Set<string>();
  project.lootTables.forEach((t, i) => {
    if (lootIds.has(t.id)) out.push(error('id.duplicate', `lootTables[${i}].id`, `Loot table ID "${t.id}" is used twice.`));
    lootIds.add(t.id);
    t.entries.forEach((e, k) => {
      if (e.min > e.max)
        out.push(error('loot.range', `lootTables[${i}].entries[${k}]`, `"${e.item}": minimum ${e.min} exceeds maximum ${e.max}.`));
    });
  });
  out.push(
    ...checkScope({
      entities: project.entities,
      groups: project.groups,
      regions: project.regions,
      widthUnits: project.world.tilesX * TILE_SIZE,
      heightUnits: project.world.tilesY * TILE_SIZE,
      prefix: '',
      lootIds,
      inTemplate: false,
    }),
  );
  const templateIds = new Set<string>();
  project.templates.forEach((t, i) => {
    if (templateIds.has(t.id)) out.push(error('id.duplicate', `templates[${i}].id`, `Template ID "${t.id}" is used twice.`));
    templateIds.add(t.id);
    out.push(
      ...checkScope({
        entities: t.entities,
        groups: t.groups,
        regions: t.regions,
        widthUnits: t.size.w * TILE_SIZE,
        heightUnits: t.size.h * TILE_SIZE,
        prefix: `templates[${i}].`,
        lootIds,
        inTemplate: true,
      }),
    );
  });
  project.groups.forEach((g, i) => {
    if (g.template && !templateIds.has(g.template.id))
      out.push(
        (g.template.linked ? error : warning)(
          'ref.dangling-template',
          `groups[${i}].template`,
          `Group "${g.id}" refers to missing template "${g.template.id}".`,
          g.id,
        ),
      );
  });
  const npcCount = project.entities.filter((e) => e.kind === 'npc').length;
  if (npcCount > L.maxNpcs) out.push(error('budget.npcs', 'entities', `${npcCount} NPCs; the limit is ${L.maxNpcs}.`));
  const spawnCount = project.entities.filter((e) => e.kind === 'spawn').length;
  if (spawnCount > L.maxSpawns) out.push(error('budget.spawns', 'entities', `${spawnCount} spawns; the limit is ${L.maxSpawns}.`));
  const effectCount = project.regions.reduce((n, r) => n + (r.effects?.length ?? 0), 0);
  if (effectCount > L.maxEffects) out.push(error('budget.effects', 'regions', `${effectCount} effects; the limit is ${L.maxEffects}.`));
  const agentCount =
    project.entities.filter((e) => e.kind === 'agent').length +
    project.regions.reduce((n, r) => n + (r.spawner?.maxAlive ?? 0), 0);
  if (agentCount > L.maxScenarioAgents)
    out.push(
      error('budget.agents', 'entities', `Placed creatures plus spawner populations reach ${agentCount}; the limit is ${L.maxScenarioAgents}.`),
    );
  return out;
}

function pivotOk(p: { x: number; y: number }): boolean {
  const cx = p.x % TILE_SIZE;
  const cy = p.y % TILE_SIZE;
  return (cx === 0 && cy === 0) || (cx === HALF_TILE && cy === HALF_TILE);
}

function segmentsCross(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): boolean {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** Simple polygons only: no two non-adjacent edges may cross. */
export function polygonSelfIntersects(points: readonly [number, number][]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(points[i]!, points[(i + 1) % n]!, points[j]!, points[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

// --- Construction helpers -------------------------------------------------------------------

/** Feature flags a project needs from a server; computed, never hand-edited. */
export function requiredFeatures(
  project: Pick<ScenarioProject, 'entities' | 'regions'> & { lootTables?: readonly LootTable[] },
): string[] {
  const features = new Set<string>(['world.v1']);
  for (const e of project.entities) {
    if (e.overrides?.healthMax !== undefined || e.overrides?.health !== undefined) features.add('overrides.health');
    if (e.overrides?.destructible !== undefined) features.add('overrides.destructible');
    if (e.overrides?.doorOpen !== undefined) features.add('overrides.door');
    if (e.kind === 'npc') features.add('population.npcs');
    if (e.kind === 'agent') features.add('population.agents');
    if (e.kind === 'spawn') features.add('population.spawns');
    if (e.container) features.add('population.loot');
  }
  if (project.lootTables?.length) features.add('population.loot');
  for (const r of project.regions) {
    if (r.effects?.length) features.add('regions.effects');
    if (r.permissions) features.add('regions.permissions');
    if (r.shape.type === 'polygon') features.add('regions.polygon');
    if (r.spawner) features.add('population.spawners');
  }
  return [...features].sort();
}

export function createProject(options: {
  id: string;
  title: string;
  tilesX: number;
  tilesY: number;
  seed?: number;
}): ScenarioProject {
  return {
    format: SCENARIO_FORMAT,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: options.id,
    title: options.title,
    revision: 0,
    nextId: 1,
    requiredFeatures: ['world.v1'],
    world: {
      tilesX: options.tilesX,
      tilesY: options.tilesY,
      seed: options.seed ?? 1,
      time: 'day',
      population: { resources: false, structures: false, agents: false },
    },
    entities: [],
    groups: [],
    regions: [],
    templates: [],
    lootTables: [],
  };
}

/** A random project identity, e.g. `prj-k3j9x0a2bq`. */
export function newProjectId(random: () => number = Math.random): string {
  let out = 'prj-';
  for (let i = 0; i < 10; i++) out += Math.floor(random() * 36).toString(36);
  return out;
}

/** Tile centre in world units for a tile index. */
export function tileCentre(tile: number): number {
  return tile * TILE_SIZE + HALF_TILE;
}

export function tileOf(units: number): number {
  return Math.floor(units / TILE_SIZE);
}
