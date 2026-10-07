// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Spatial indexes over the open document, kept current from store change deltas:
//   * grid cells: which floor-slot and solid-slot piece occupies each tile (placement rules,
//     eyedropper, autotile neighbours);
//   * chunks: every entity bucketed by CHUNK_TILES square, so hit tests, culling and box
//     selection touch only nearby entities, never the whole world.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import {
  GRID_KINDS,
  tileOf,
  type ScenarioEntity,
} from '../../../../../shared/typescript/scenario-schema';
import type { CatalogEntry, EditorCatalog, GridSlot } from '../catalog/catalog';
import type { Change, DocumentStore } from './store';

export const CHUNK_TILES = 16;
const CHUNK_UNITS = CHUNK_TILES * TILE_SIZE;

export function cellKey(tx: number, ty: number): number {
  return ty * 1024 + tx;
}

export function chunkKey(cx: number, cy: number): number {
  return cy * 1024 + cx;
}

export interface Cell {
  floor?: string;
  solid?: string;
}

/** Tiles a grid piece covers: its own tile plus the rotation's second tile, if any. */
export function footprint(
  entity: Pick<ScenarioEntity, 'kind' | 'x' | 'y' | 'rotation'>,
  entry: CatalogEntry | undefined,
): [number, number][] {
  const tx = tileOf(entity.x);
  const ty = tileOf(entity.y);
  const tiles: [number, number][] = [[tx, ty]];
  const second = entry?.secondTile?.[entity.rotation ?? 0];
  if (second) tiles.push([tx + second.dj, ty + second.di]);
  return tiles;
}

export function slotOf(entry: CatalogEntry | undefined): GridSlot {
  return entry?.slot ?? 'solid';
}

export class SpatialIndex {
  private readonly cells = new Map<number, Cell>();
  private readonly chunks = new Map<number, Set<string>>();
  /** entity id -> cell keys it occupies (grid kinds) and its chunk key. */
  private readonly placedCells = new Map<string, number[]>();
  private readonly placedChunk = new Map<string, number>();
  private readonly unsubscribe: () => void;

  constructor(
    store: DocumentStore,
    private readonly catalog: EditorCatalog,
  ) {
    for (const e of store.entities.values()) this.add(e);
    this.unsubscribe = store.onChange((changes) => this.apply(changes));
  }

  dispose(): void {
    this.unsubscribe();
  }

  cell(tx: number, ty: number): Cell | undefined {
    return this.cells.get(cellKey(tx, ty));
  }

  /** Entity ids whose chunk overlaps the world-unit rectangle (a superset; callers refine). */
  query(x0: number, y0: number, x1: number, y1: number, margin = 1): string[] {
    const out: string[] = [];
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK_UNITS) - margin);
    const cy0 = Math.max(0, Math.floor(y0 / CHUNK_UNITS) - margin);
    const cx1 = Math.floor(x1 / CHUNK_UNITS) + margin;
    const cy1 = Math.floor(y1 / CHUNK_UNITS) + margin;
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const set = this.chunks.get(chunkKey(cx, cy));
        if (set) for (const id of set) out.push(id);
      }
    return out;
  }

  /** The chunk rectangle a world-unit rectangle spans; used as a cheap cache key. */
  static chunkSpan(x0: number, y0: number, x1: number, y1: number): string {
    return `${Math.floor(x0 / CHUNK_UNITS)},${Math.floor(y0 / CHUNK_UNITS)},${Math.floor(x1 / CHUNK_UNITS)},${Math.floor(y1 / CHUNK_UNITS)}`;
  }

  entryFor(e: ScenarioEntity): CatalogEntry | undefined {
    return this.catalog.resolve(e.kind, e.ref, e.variant);
  }

  private apply(changes: readonly Change[]): void {
    for (const change of changes) {
      if (change.kind !== 'entity') continue;
      if (change.before) this.delete(change.before as ScenarioEntity);
      if (change.after) this.add(change.after as ScenarioEntity);
    }
  }

  private add(e: ScenarioEntity): void {
    const chunk = chunkKey(Math.floor(e.x / CHUNK_UNITS), Math.floor(e.y / CHUNK_UNITS));
    let set = this.chunks.get(chunk);
    if (!set) this.chunks.set(chunk, (set = new Set()));
    set.add(e.id);
    this.placedChunk.set(e.id, chunk);
    if (!GRID_KINDS.has(e.kind)) return;
    const entry = this.entryFor(e);
    const slot = slotOf(entry);
    const keys: number[] = [];
    for (const [tx, ty] of footprint(e, entry)) {
      const key = cellKey(tx, ty);
      let cell = this.cells.get(key);
      if (!cell) this.cells.set(key, (cell = {}));
      cell[slot] = e.id;
      keys.push(key);
    }
    this.placedCells.set(e.id, keys);
  }

  private delete(e: ScenarioEntity): void {
    const chunk = this.placedChunk.get(e.id);
    if (chunk !== undefined) {
      this.chunks.get(chunk)?.delete(e.id);
      this.placedChunk.delete(e.id);
    }
    const keys = this.placedCells.get(e.id);
    if (!keys) return;
    for (const key of keys) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      if (cell.floor === e.id) delete cell.floor;
      if (cell.solid === e.id) delete cell.solid;
      if (!cell.floor && !cell.solid) this.cells.delete(key);
    }
    this.placedCells.delete(e.id);
  }
}
