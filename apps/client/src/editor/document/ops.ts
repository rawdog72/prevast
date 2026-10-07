// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Document operations with the plan's all-or-nothing rules: a move, rotation or paste
// either lands every member legally or changes nothing and names the offenders. Every
// operation runs inside the caller's transaction (or opens its own), so it undoes as one.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import {
  GRID_KINDS,
  type GroupKind,
  type RegionShape,
  type ScenarioEntity,
  type ScenarioGroup,
  type ScenarioRegion,
  type ScenarioTemplate,
} from '../../../../../shared/typescript/scenario-schema';
import type { EditorCatalog } from '../catalog/catalog';
import { cellKey, footprint, slotOf, type SpatialIndex } from './spatial';
import type { DocumentStore } from './store';

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  dx: number;
  dy: number;
  /** Clockwise quarter turns about `pivot`, applied before the offset. */
  turns: number;
  pivot: Point;
}

export interface OpResult {
  ok: boolean;
  /** IDs that would become invalid; nothing changed when this is non-empty. */
  offenders: string[];
  reason?: string;
}

const OK: OpResult = { ok: true, offenders: [] };

function fail(offenders: string[], reason: string): OpResult {
  return { ok: false, offenders, reason };
}

// --- geometry ---------------------------------------------------------------------------------

/** Clockwise (screen, y down) quarter turns of a vector. */
export function turnVector(x: number, y: number, turns: number): Point {
  let vx = x;
  let vy = y;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) [vx, vy] = [-vy, vx];
  return { x: vx, y: vy };
}

export function transformPoint(p: Point, t: Transform): Point {
  const v = turnVector(p.x - t.pivot.x, p.y - t.pivot.y, t.turns);
  return { x: t.pivot.x + v.x + t.dx, y: t.pivot.y + v.y + t.dy };
}

/** A shape in absolute coordinates, turned and moved; `relative` shapes only turn. */
export function transformShape(shape: RegionShape, t: Transform, relative: boolean): RegionShape {
  const tp = (x: number, y: number): Point =>
    relative ? turnVector(x, y, t.turns) : transformPoint({ x, y }, t);
  switch (shape.type) {
    case 'circle': {
      const c = tp(shape.x, shape.y);
      return { ...shape, x: c.x, y: c.y };
    }
    case 'rect': {
      const a = tp(shape.x, shape.y);
      const b = tp(shape.x + shape.w, shape.y + shape.h);
      return {
        type: 'rect',
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
      };
    }
    default:
      return { type: 'polygon', points: shape.points.map(([x, y]) => {
        const p = tp(x, y);
        return [p.x, p.y] as [number, number];
      }) };
  }
}

/** Axis-aligned bounds of a shape, in the same space as its coordinates. */
export function shapeBounds(shape: RegionShape): { x0: number; y0: number; x1: number; y1: number } {
  switch (shape.type) {
    case 'circle':
      return { x0: shape.x - shape.r, y0: shape.y - shape.r, x1: shape.x + shape.r, y1: shape.y + shape.r };
    case 'rect':
      return { x0: shape.x, y0: shape.y, x1: shape.x + shape.w, y1: shape.y + shape.h };
    default: {
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
  }
}

export function pointInShape(shape: RegionShape, x: number, y: number): boolean {
  switch (shape.type) {
    case 'circle':
      return (x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.r ** 2;
    case 'rect':
      return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
    default: {
      let inside = false;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

/** Where a region's shape actually is: attached shapes are offsets from their entity. */
export function regionWorldShape(store: DocumentStore, region: ScenarioRegion): RegionShape | undefined {
  if (!region.attach) return region.shape;
  const e = store.entities.get(region.attach);
  if (!e) return undefined;
  return transformShape(region.shape, { dx: e.x, dy: e.y, turns: 0, pivot: { x: 0, y: 0 } }, false);
}

/** Snap a pivot to the nearest tile corner or centre, so grid pieces stay on centres. */
export function snapPivot(p: Point, preferCentre: boolean): Point {
  if (preferCentre)
    return {
      x: Math.floor(p.x / TILE_SIZE) * TILE_SIZE + TILE_SIZE / 2,
      y: Math.floor(p.y / TILE_SIZE) * TILE_SIZE + TILE_SIZE / 2,
    };
  return { x: Math.round(p.x / TILE_SIZE) * TILE_SIZE, y: Math.round(p.y / TILE_SIZE) * TILE_SIZE };
}

export function turnAngle(angle: number | undefined, turns: number): number | undefined {
  if (angle === undefined && turns % 4 === 0) return angle;
  return (((angle ?? 0) + turns * 64) % 256 + 256) % 256;
}

// --- selection closure ------------------------------------------------------------------------

/**
 * Everything a transform of `ids` carries: selected groups bring all descendants; entities
 * bring the regions attached to them (those follow implicitly, being relative).
 */
export function expandSelection(store: DocumentStore, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    if (!store.kindOf(id)) continue;
    out.add(id);
    if (store.groups.has(id)) for (const d of store.descendants(id)) out.add(d);
  }
  return out;
}

// --- validation of placements -----------------------------------------------------------------

export interface PlacementCheck {
  outOfBounds: string[];
  /** entity id -> the id already occupying one of its cells (same slot). */
  conflicts: Map<string, string>;
}

/**
 * Checks proposed entity records against the map bounds and the grid occupancy of every
 * entity NOT in `moving`, and against each other.
 */
export function checkPlacements(
  store: DocumentStore,
  spatial: SpatialIndex,
  catalog: EditorCatalog,
  proposed: readonly ScenarioEntity[],
  moving: ReadonlySet<string>,
): PlacementCheck {
  const { tilesX, tilesY } = store.header.world;
  const widthUnits = tilesX * TILE_SIZE;
  const heightUnits = tilesY * TILE_SIZE;
  const outOfBounds: string[] = [];
  const conflicts = new Map<string, string>();
  const claimed = new Map<string, string>();
  for (const e of proposed) {
    if (e.x < 0 || e.y < 0 || e.x >= widthUnits || e.y >= heightUnits) {
      outOfBounds.push(e.id);
      continue;
    }
    if (!GRID_KINDS.has(e.kind)) continue;
    const entry = catalog.resolve(e.kind, e.ref, e.variant);
    const slot = slotOf(entry);
    for (const [tx, ty] of footprint(e, entry)) {
      if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) {
        outOfBounds.push(e.id);
        break;
      }
      const occupant = spatial.cell(tx, ty)?.[slot];
      if (occupant && occupant !== e.id && !moving.has(occupant)) conflicts.set(e.id, occupant);
      const key = `${slot}:${cellKey(tx, ty)}`;
      const other = claimed.get(key);
      if (other && other !== e.id) conflicts.set(e.id, other);
      claimed.set(key, e.id);
    }
  }
  return { outOfBounds, conflicts };
}

// --- operations -------------------------------------------------------------------------------

/**
 * Places new entities, replacing whatever occupies their grid slot (painting over).
 * Returns the ids actually placed; out-of-bounds drafts are skipped.
 */
export function placeEntities(
  store: DocumentStore,
  spatial: SpatialIndex,
  catalog: EditorCatalog,
  drafts: readonly Omit<ScenarioEntity, 'id'>[],
  options: { replace: boolean } = { replace: true },
): string[] {
  const placed: string[] = [];
  const { tilesX, tilesY } = store.header.world;
  for (const draft of drafts) {
    const entry = catalog.resolve(draft.kind, draft.ref, draft.variant);
    if (GRID_KINDS.has(draft.kind)) {
      const cells = footprint(draft, entry);
      if (cells.some(([tx, ty]) => tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY)) continue;
      const slot = slotOf(entry);
      const occupants = new Set<string>();
      for (const [tx, ty] of cells) {
        const occ = spatial.cell(tx, ty)?.[slot];
        if (occ) occupants.add(occ);
      }
      if (occupants.size) {
        if (!options.replace) continue;
        // Identical piece already there: nothing to do (keeps brush strokes idempotent).
        const [only] = occupants;
        const current = only ? store.entities.get(only) : undefined;
        if (
          occupants.size === 1 &&
          current &&
          current.ref === draft.ref &&
          current.variant === draft.variant &&
          (current.rotation ?? 0) === (draft.rotation ?? 0) &&
          current.x === draft.x &&
          current.y === draft.y
        )
          continue;
        for (const id of occupants) removeWithDependents(store, [id]);
      }
    } else if (draft.x < 0 || draft.y < 0 || draft.x >= tilesX * TILE_SIZE || draft.y >= tilesY * TILE_SIZE) {
      continue;
    }
    const id = store.allocId('e');
    store.put('entity', { ...draft, id } as ScenarioEntity);
    placed.push(id);
  }
  return placed;
}

/** Moves/rotates the closure of `ids` as one unit, or changes nothing. */
export function transformSelection(
  store: DocumentStore,
  spatial: SpatialIndex,
  catalog: EditorCatalog,
  ids: Iterable<string>,
  t: Transform,
): OpResult {
  const closure = expandSelection(store, ids);
  const entities: ScenarioEntity[] = [];
  const groups: ScenarioGroup[] = [];
  const regions: ScenarioRegion[] = [];
  const hasGrid = [...closure].some((id) => {
    const e = store.entities.get(id);
    return e !== undefined && GRID_KINDS.has(e.kind);
  });
  if (hasGrid && (t.dx % TILE_SIZE !== 0 || t.dy % TILE_SIZE !== 0))
    return fail([], 'Grid pieces move in whole tiles.');
  if (hasGrid && t.turns % 4 !== 0) {
    const cx = ((t.pivot.x % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    const cy = ((t.pivot.y % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    if (!((cx === 0 && cy === 0) || (cx === TILE_SIZE / 2 && cy === TILE_SIZE / 2)))
      return fail([], 'Rotate grid pieces about a tile centre or corner.');
  }
  for (const id of closure) {
    const e = store.entities.get(id);
    if (e) {
      const p = transformPoint(e, t);
      const entry = catalog.resolve(e.kind, e.ref, e.variant);
      const next: ScenarioEntity = { ...e, x: p.x, y: p.y };
      if (GRID_KINDS.has(e.kind) && e.kind === 'object') {
        if (entry?.rotatable) next.rotation = (((e.rotation ?? 0) + t.turns) % 4 + 4) % 4;
      } else {
        const angle = turnAngle(e.angle, t.turns);
        if (angle !== undefined) next.angle = angle;
      }
      entities.push(next);
      continue;
    }
    const g = store.groups.get(id);
    if (g) {
      groups.push({ ...g, pivot: transformPoint(g.pivot, t) });
      continue;
    }
    const r = store.regions.get(id);
    if (r) regions.push({ ...r, shape: transformShape(r.shape, t, r.attach !== undefined) });
  }
  // Regions attached to moving entities turn with them (their offsets are relative).
  const movedEntityIds = new Set(entities.map((e) => e.id));
  for (const r of store.regions.values())
    if (r.attach && movedEntityIds.has(r.attach) && !closure.has(r.id) && t.turns % 4 !== 0)
      regions.push({ ...r, shape: transformShape(r.shape, t, true) });

  const check = checkPlacements(store, spatial, catalog, entities, closure);
  const offenders = [...check.outOfBounds, ...check.conflicts.keys()];
  const world = { w: store.header.world.tilesX * TILE_SIZE, h: store.header.world.tilesY * TILE_SIZE };
  for (const g of groups)
    if (g.pivot.x < 0 || g.pivot.y < 0 || g.pivot.x > world.w || g.pivot.y > world.h) offenders.push(g.id);
  for (const r of regions) {
    if (r.attach) continue;
    const b = shapeBounds(r.shape);
    if (b.x0 < 0 || b.y0 < 0 || b.x1 > world.w || b.y1 > world.h) offenders.push(r.id);
  }
  if (offenders.length)
    return fail(
      offenders,
      check.conflicts.size ? 'Some pieces would overlap existing pieces.' : 'Some members would leave the map.',
    );

  const own = !store.inTransaction;
  if (own) store.begin(t.turns ? 'Rotate' : 'Move');
  for (const e of entities) store.put('entity', e);
  for (const g of groups) store.put('group', g);
  for (const r of regions) store.put('region', r);
  if (own) store.commit();
  return OK;
}

/**
 * Deletes records and what cannot exist without them: a group's descendants and an entity's
 * attached regions. Returns every removed id so callers can report it.
 */
export function removeWithDependents(store: DocumentStore, ids: Iterable<string>): string[] {
  const doomed = expandSelection(store, ids);
  for (const id of [...doomed]) {
    if (store.entities.has(id)) for (const r of store.attachedRegions(id)) doomed.add(r.id);
  }
  const own = !store.inTransaction;
  if (own) store.begin('Delete');
  for (const id of doomed) {
    const kind = store.kindOf(id);
    if (kind) store.remove(kind, id);
  }
  if (own) store.commit();
  return [...doomed];
}

/** What a delete would take with it, for the confirmation shown before deleting. */
export function deletionImpact(store: DocumentStore, ids: Iterable<string>): { total: number; extra: number } {
  const requested = new Set(ids);
  const doomed = expandSelection(store, requested);
  for (const id of [...doomed])
    if (store.entities.has(id)) for (const r of store.attachedRegions(id)) doomed.add(r.id);
  return { total: doomed.size, extra: doomed.size - [...requested].filter((id) => store.kindOf(id)).length };
}

/** The outermost selected records: selecting a group and its child acts on the group once. */
export function topLevel(store: DocumentStore, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const id of set) {
    let parent = parentOf(store, id);
    let covered = false;
    while (parent) {
      if (set.has(parent)) {
        covered = true;
        break;
      }
      parent = store.groups.get(parent)?.parent;
    }
    if (!covered) out.push(id);
  }
  return out;
}

export function parentOf(store: DocumentStore, id: string): string | undefined {
  return (store.entities.get(id) ?? store.groups.get(id) ?? store.regions.get(id))?.parent;
}

/** Bounding box (world units) of the closure of `ids`. */
export function selectionBounds(
  store: DocumentStore,
  ids: Iterable<string>,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (a: number, b: number, c: number, d: number) => {
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  };
  for (const id of expandSelection(store, ids)) {
    const e = store.entities.get(id);
    if (e) {
      const half = GRID_KINDS.has(e.kind) ? TILE_SIZE / 2 : 40;
      grow(e.x - half, e.y - half, e.x + half, e.y + half);
      continue;
    }
    const r = store.regions.get(id);
    const shape = r ? regionWorldShape(store, r) : undefined;
    if (shape) {
      const b = shapeBounds(shape);
      grow(b.x0, b.y0, b.x1, b.y1);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : undefined;
}

/** Creates a group over the top-level members of `ids`, keeping them where they are. */
export function groupSelection(
  store: DocumentStore,
  ids: Iterable<string>,
  kind: GroupKind,
  name: string,
): string | undefined {
  const members = topLevel(store, ids);
  if (!members.length) return undefined;
  const bounds = selectionBounds(store, members)!;
  // New group joins the members' common parent, so nesting is preserved.
  const parents = new Set(members.map((id) => parentOf(store, id)));
  const parent = parents.size === 1 ? [...parents][0] : undefined;
  const own = !store.inTransaction;
  if (own) store.begin('Group');
  const id = store.allocId('g');
  store.put('group', {
    id,
    name,
    kind,
    ...(parent ? { parent } : {}),
    pivot: snapPivot({ x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 }, false),
  });
  for (const m of members) reparent(store, m, id);
  if (own) store.commit();
  return id;
}

/** Dissolves a group: its direct children move to the group's parent. */
export function ungroup(store: DocumentStore, groupId: string): void {
  const g = store.groups.get(groupId);
  if (!g) return;
  const own = !store.inTransaction;
  if (own) store.begin('Ungroup');
  for (const child of [...store.childrenOf(groupId)]) reparent(store, child, g.parent);
  store.remove('group', groupId);
  if (own) store.commit();
}

/** Moves one record under a new parent group (or to the top level). Rejects cycles. */
export function reparent(store: DocumentStore, id: string, parent: string | undefined): boolean {
  if (parent) {
    let cursor: string | undefined = parent;
    while (cursor) {
      if (cursor === id) return false;
      cursor = store.groups.get(cursor)?.parent;
    }
  }
  const apply = <T extends { parent?: string }>(record: T): T => {
    const next = { ...record };
    if (parent) next.parent = parent;
    else delete next.parent;
    return next;
  };
  const e = store.entities.get(id);
  if (e) return store.put('entity', apply(e)), true;
  const g = store.groups.get(id);
  if (g) return store.put('group', apply(g)), true;
  const r = store.regions.get(id);
  if (r) return store.put('region', apply(r)), true;
  return false;
}

// --- copy, paste and templates ----------------------------------------------------------------

/** A self-contained, position-relative copy of records: the clipboard and template body. */
export interface Fragment {
  entities: ScenarioEntity[];
  groups: ScenarioGroup[];
  regions: ScenarioRegion[];
  /** Origin the coordinates are relative to (a tile corner). */
  size: { w: number; h: number };
}

/**
 * Copies the closure of `ids` into a fragment whose coordinates start at a tile corner.
 * References that leave the fragment are dropped: parents outside it become top level,
 * attachments to entities outside it are skipped.
 */
export function extractFragment(store: DocumentStore, ids: Iterable<string>): Fragment | undefined {
  const closure = expandSelection(store, ids);
  for (const id of [...closure])
    if (store.entities.has(id)) for (const r of store.attachedRegions(id)) closure.add(r.id);
  const bounds = selectionBounds(store, closure);
  if (!bounds) return undefined;
  const ox = Math.floor(bounds.x0 / TILE_SIZE) * TILE_SIZE;
  const oy = Math.floor(bounds.y0 / TILE_SIZE) * TILE_SIZE;
  const t: Transform = { dx: -ox, dy: -oy, turns: 0, pivot: { x: 0, y: 0 } };
  const keepParent = <T extends { parent?: string }>(r: T): T => {
    const next = { ...r };
    if (next.parent && !closure.has(next.parent)) delete next.parent;
    return next;
  };
  const fragment: Fragment = {
    entities: [],
    groups: [],
    regions: [],
    size: {
      w: Math.max(1, Math.ceil((bounds.x1 - ox) / TILE_SIZE)),
      h: Math.max(1, Math.ceil((bounds.y1 - oy) / TILE_SIZE)),
    },
  };
  for (const id of closure) {
    const e = store.entities.get(id);
    if (e) fragment.entities.push(keepParent({ ...e, x: e.x - ox, y: e.y - oy }));
    const g = store.groups.get(id);
    if (g) {
      const copy = keepParent({ ...g, pivot: { x: g.pivot.x - ox, y: g.pivot.y - oy } });
      fragment.groups.push(copy);
    }
    const r = store.regions.get(id);
    if (r) {
      if (r.attach && !closure.has(r.attach)) continue;
      fragment.regions.push(keepParent({ ...r, shape: r.attach ? r.shape : transformShape(r.shape, t, false) }));
    }
  }
  return structuredClone(fragment);
}

/**
 * Inserts a fragment at a tile-corner offset with fresh identities for every record; internal
 * parent/attach references are remapped. Returns the new top-level ids, or the offenders.
 */
export function insertFragment(
  store: DocumentStore,
  spatial: SpatialIndex,
  catalog: EditorCatalog,
  fragment: Fragment,
  at: Point,
  options: { turns?: number; parent?: string; template?: ScenarioGroup['template'] } = {},
): OpResult & { ids: string[] } {
  const turns = options.turns ?? 0;
  const t: Transform = { dx: at.x, dy: at.y, turns, pivot: { x: 0, y: 0 } };
  // Turning about the fragment origin: shift back so the footprint starts at `at` again.
  if (turns % 4) {
    const corner = turnVector(fragment.size.w * TILE_SIZE, fragment.size.h * TILE_SIZE, turns);
    t.dx += Math.max(0, -corner.x);
    t.dy += Math.max(0, -corner.y);
  }
  const remap = new Map<string, string>();
  const idFor = (old: string, prefix: 'e' | 'g' | 'r'): string => {
    let id = remap.get(old);
    if (!id) remap.set(old, (id = store.allocId(prefix)));
    return id;
  };
  for (const g of fragment.groups) idFor(g.id, 'g');
  for (const e of fragment.entities) idFor(e.id, 'e');
  for (const r of fragment.regions) idFor(r.id, 'r');
  const mapParent = (p: string | undefined) => (p ? remap.get(p) : options.parent);

  const entities: ScenarioEntity[] = fragment.entities.map((e) => {
    const p = transformPoint(e, t);
    const entry = catalog.resolve(e.kind, e.ref, e.variant);
    const next: ScenarioEntity = { ...e, id: remap.get(e.id)!, x: p.x, y: p.y };
    const parent = mapParent(e.parent);
    if (parent) next.parent = parent;
    else delete next.parent;
    if (e.kind === 'object') {
      if (entry?.rotatable) next.rotation = (((e.rotation ?? 0) + turns) % 4 + 4) % 4;
    } else {
      const angle = turnAngle(e.angle, turns);
      if (angle !== undefined) next.angle = angle;
    }
    return next;
  });
  const check = checkPlacements(store, spatial, catalog, entities, new Set());
  const offenders = [...check.outOfBounds, ...check.conflicts.keys()];
  if (offenders.length) {
    return {
      ...fail(offenders, check.conflicts.size ? 'The paste overlaps existing pieces.' : 'The paste does not fit on the map.'),
      ids: [],
    };
  }
  const own = !store.inTransaction;
  if (own) store.begin('Paste');
  for (const g of fragment.groups) {
    const next: ScenarioGroup = { ...g, id: remap.get(g.id)!, pivot: transformPoint(g.pivot, t) };
    const parent = mapParent(g.parent);
    if (parent) next.parent = parent;
    else delete next.parent;
    store.put('group', next);
  }
  for (const e of entities) store.put('entity', e);
  for (const r of fragment.regions) {
    const next: ScenarioRegion = {
      ...r,
      id: remap.get(r.id)!,
      shape: transformShape(r.shape, t, r.attach !== undefined),
    };
    if (r.attach) next.attach = remap.get(r.attach)!;
    const parent = mapParent(r.parent);
    if (parent) next.parent = parent;
    else delete next.parent;
    store.put('region', next);
  }
  if (own) store.commit();
  const top = [
    ...fragment.groups.filter((g) => !g.parent).map((g) => remap.get(g.id)!),
    ...fragment.entities.filter((e) => !e.parent).map((e) => remap.get(e.id)!),
    ...fragment.regions.filter((r) => !r.parent && !r.attach).map((r) => remap.get(r.id)!),
  ];
  return { ...OK, ids: top };
}

/** Saves the selection as a new embedded template (an independent, portable definition). */
export function createTemplate(store: DocumentStore, ids: Iterable<string>, name: string): string | undefined {
  const fragment = extractFragment(store, ids);
  if (!fragment) return undefined;
  const id = store.allocId('t');
  const template: ScenarioTemplate = {
    id,
    name,
    revision: 1,
    size: fragment.size,
    source: 'authored',
    entities: fragment.entities,
    groups: fragment.groups,
    regions: fragment.regions,
  };
  store.put('template', template);
  return id;
}

/** Places an independent copy of a template, wrapped in a group that remembers its source. */
export function instantiateTemplate(
  store: DocumentStore,
  spatial: SpatialIndex,
  catalog: EditorCatalog,
  templateId: string,
  at: Point,
  turns = 0,
): OpResult & { ids: string[] } {
  const template = store.templates.get(templateId);
  if (!template) return { ...fail([], 'Unknown template.'), ids: [] };
  const own = !store.inTransaction;
  if (own) store.begin(`Place ${template.name}`);
  const groupId = store.allocId('g');
  const size = turnVector(template.size.w * TILE_SIZE, template.size.h * TILE_SIZE, turns);
  store.put('group', {
    id: groupId,
    name: template.name,
    kind: 'house',
    pivot: snapPivot({ x: at.x + Math.abs(size.x) / 2, y: at.y + Math.abs(size.y) / 2 }, false),
    template: { id: template.id, revision: template.revision, linked: false },
  });
  const result = insertFragment(store, spatial, catalog, template, at, { turns, parent: groupId });
  if (!result.ok) {
    if (own) store.cancel();
    else store.remove('group', groupId);
    return result;
  }
  if (own) store.commit();
  return { ...OK, ids: [groupId] };
}
