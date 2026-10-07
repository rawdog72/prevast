// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// State shared by the editor's tools, panels and scene: one object, created per editor
// session and torn down with it.
import type { AssetLoader } from '../assets/asset-loader';
import type { ContentStore } from '../content/store';
import type { Camera } from '../core/camera';
import { GRID_KINDS } from '../../../../shared/typescript/scenario-schema';
import { TILE_SIZE } from '../../../../shared/typescript/editor-limits';
import type { CatalogEntry, EditorCatalog, EditorLayer } from './catalog/catalog';
import { pointInShape, regionWorldShape, shapeBounds } from './document/ops';
import type { SpatialIndex } from './document/spatial';
import type { DocumentStore } from './document/store';

export type StatusTone = 'info' | 'ok' | 'warn' | 'error';

export class Selection {
  private ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  values(): string[] {
    return [...this.ids];
  }

  set(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) return;
    this.ids = next;
    this.emit();
  }

  add(ids: Iterable<string>): void {
    this.set([...this.ids, ...ids]);
  }

  toggle(id: string): void {
    const next = new Set(this.ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.set(next);
  }

  clear(): void {
    this.set([]);
  }

  /** Drops ids that no longer exist in the document. */
  prune(exists: (id: string) => boolean): void {
    const kept = [...this.ids].filter(exists);
    if (kept.length !== this.ids.size) this.set(kept);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export interface EditorContext {
  store: DocumentStore;
  spatial: SpatialIndex;
  catalog: EditorCatalog;
  content: ContentStore;
  assets: AssetLoader;
  camera: Camera;
  selection: Selection;
  hiddenLayers: Set<EditorLayer>;
  lockedLayers: Set<EditorLayer>;
  /** The palette entry the placement tools paint with. */
  activeEntry: CatalogEntry | null;
  /** Template the place tool stamps instead of a single piece. */
  activeTemplate: string | null;
  /** Placement rotation in quarter turns (ignored by non-rotatable pieces). */
  placeRotation: number;
  showGrid: boolean;
  /** Rectangle tool: outline (walls) or filled (floors); Shift inverts while dragging. */
  rectFilled: boolean;
  /** Region tool shape. */
  regionShape: 'circle' | 'rect' | 'polygon';
  /** Members of the last rejected operation, highlighted until the next edit. */
  offenders: Set<string>;
  night: boolean;
  status(message: string, tone?: StatusTone): void;
  requestRender(): void;
  /** Tells panels that something besides the document or selection changed. */
  notify(): void;
}

/** Editor layer of a document record. */
export function layerOf(ctx: EditorContext, id: string): EditorLayer | undefined {
  const e = ctx.store.entities.get(id);
  if (e) return ctx.catalog.resolve(e.kind, e.ref, e.variant)?.layer ?? 'mid';
  if (ctx.store.regions.has(id)) return 'regions';
  return undefined;
}

/** Hidden or locked records cannot be picked or edited on the canvas. */
export function isEditable(ctx: EditorContext, id: string): boolean {
  const layer = layerOf(ctx, id);
  return !layer || (!ctx.hiddenLayers.has(layer) && !ctx.lockedLayers.has(layer));
}

const FREE_PICK_RADIUS = 45;

/**
 * Everything under a world point, top-most first: free placements (spawns, NPCs, creatures),
 * then the tile's solid and floor pieces, then regions (last: they are large).
 */
export function pickAt(ctx: EditorContext, x: number, y: number): string[] {
  const out: string[] = [];
  const free: { id: string; d: number }[] = [];
  for (const id of ctx.spatial.query(x - 100, y - 100, x + 100, y + 100, 0)) {
    const e = ctx.store.entities.get(id);
    if (!e || GRID_KINDS.has(e.kind)) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d <= FREE_PICK_RADIUS) free.push({ id, d });
  }
  free.sort((a, b) => a.d - b.d);
  out.push(...free.map((f) => f.id));
  const cell = ctx.spatial.cell(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
  if (cell?.solid) out.push(cell.solid);
  if (cell?.floor) out.push(cell.floor);
  const regions = [...ctx.store.regions.values()]
    .filter((r) => {
      const shape = regionWorldShape(ctx.store, r);
      return shape && pointInShape(shape, x, y);
    })
    .sort((a, b) => b.priority - a.priority);
  out.push(...regions.map((r) => r.id));
  return out.filter((id) => isEditable(ctx, id));
}

/** Records fully inside a world rectangle. */
export function pickRect(ctx: EditorContext, x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  for (const id of ctx.spatial.query(x0, y0, x1, y1, 0)) {
    const e = ctx.store.entities.get(id);
    if (e && e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1 && isEditable(ctx, id)) out.push(id);
  }
  for (const r of ctx.store.regions.values()) {
    const shape = regionWorldShape(ctx.store, r);
    if (!shape || !isEditable(ctx, r.id)) continue;
    const b = shapeBounds(shape);
    if (b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1) out.push(r.id);
  }
  return out;
}
