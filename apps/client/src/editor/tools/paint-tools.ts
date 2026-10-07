// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Placement tools: brush, line, rectangle, flood fill, eraser and eyedropper. Each stroke is
// one transaction, so a whole drag undoes in one step.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import {
  GRID_KINDS,
  tileCentre,
  type ScenarioEntity,
} from '../../../../../shared/typescript/scenario-schema';
import type { CatalogEntry } from '../catalog/catalog';
import { instantiateTemplate, placeEntities, removeWithDependents, turnVector } from '../document/ops';
import { footprint, slotOf } from '../document/spatial';
import { isEditable, pickAt, type EditorContext } from '../editor-context';
import { BAD_COLOUR, drawGhost, drawTiles } from '../scene/ghost';
import { lineTiles, rectTiles, type PointerInfo, type Tool } from './tool';

/** Largest area a single fill may cover, so a misclick cannot flood the whole map. */
export const FILL_LIMIT = 40000;

export function draftFor(ctx: EditorContext, entry: CatalogEntry, x: number, y: number): Omit<ScenarioEntity, 'id'> {
  const draft: Omit<ScenarioEntity, 'id'> = { kind: entry.kind, ref: entry.ref, x, y };
  if (entry.variant !== undefined) draft.variant = entry.variant;
  if (entry.kind === 'object') draft.rotation = entry.rotatable ? ctx.placeRotation : 0;
  else if (ctx.placeRotation) draft.angle = (ctx.placeRotation * 64) % 256;
  return draft;
}

function tileDraft(ctx: EditorContext, entry: CatalogEntry, tx: number, ty: number) {
  return draftFor(ctx, entry, tileCentre(tx), tileCentre(ty));
}

function inMap(ctx: EditorContext, tx: number, ty: number): boolean {
  const { tilesX, tilesY } = ctx.store.header.world;
  return tx >= 0 && ty >= 0 && tx < tilesX && ty < tilesY;
}

function layerBlocked(ctx: EditorContext, entry: CatalogEntry): boolean {
  if (ctx.lockedLayers.has(entry.layer) || ctx.hiddenLayers.has(entry.layer)) {
    ctx.status(`The ${entry.layer} layer is ${ctx.lockedLayers.has(entry.layer) ? 'locked' : 'hidden'}.`, 'warn');
    return true;
  }
  return false;
}

/** Whether a draft could go down without replacing anything (for ghost colour only). */
function fits(ctx: EditorContext, entry: CatalogEntry, draft: Omit<ScenarioEntity, 'id'>): boolean {
  if (!GRID_KINDS.has(entry.kind)) {
    const { tilesX, tilesY } = ctx.store.header.world;
    return draft.x >= 0 && draft.y >= 0 && draft.x < tilesX * TILE_SIZE && draft.y < tilesY * TILE_SIZE;
  }
  return footprint(draft, entry).every(([tx, ty]) => inMap(ctx, tx, ty));
}

function freePosition(p: PointerInfo): { x: number; y: number } {
  return p.shift ? { x: tileCentre(p.tx), y: tileCentre(p.ty) } : { x: Math.round(p.wx), y: Math.round(p.wy) };
}

export class PlaceTool implements Tool {
  readonly id = 'place';
  readonly label = 'Paint';
  readonly shortcut = 'b';
  readonly hint = 'Click or drag to paint the selected piece. Right-drag erases. R rotates.';
  private stroke: { lastX: number; lastY: number; erase: boolean } | null = null;
  private hover: PointerInfo | null = null;

  cursor(): string {
    return 'crosshair';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    if (p.button === 2) {
      ctx.store.begin('Erase');
      this.stroke = { lastX: p.tx, lastY: p.ty, erase: true };
      eraseAt(ctx, p.wx, p.wy);
      return;
    }
    if (ctx.activeTemplate) {
      this.stampTemplate(ctx, p);
      return;
    }
    const entry = ctx.activeEntry;
    if (!entry) {
      ctx.status('Pick a piece from the library first.', 'warn');
      return;
    }
    if (layerBlocked(ctx, entry)) return;
    if (!GRID_KINDS.has(entry.kind)) {
      const pos = freePosition(p);
      const placed = ctx.store.transact(`Place ${entry.name}`, () =>
        placeEntities(ctx.store, ctx.spatial, ctx.catalog, [draftFor(ctx, entry, pos.x, pos.y)]),
      );
      if (placed.length) ctx.selection.set(placed);
      return;
    }
    ctx.store.begin(`Paint ${entry.name}`);
    this.stroke = { lastX: p.tx, lastY: p.ty, erase: false };
    placeEntities(ctx.store, ctx.spatial, ctx.catalog, [tileDraft(ctx, entry, p.tx, p.ty)]);
  }

  move(ctx: EditorContext, p: PointerInfo): void {
    this.hover = p;
    const s = this.stroke;
    if (!s || (s.lastX === p.tx && s.lastY === p.ty)) return;
    const tiles = lineTiles(s.lastX, s.lastY, p.tx, p.ty).slice(1);
    s.lastX = p.tx;
    s.lastY = p.ty;
    if (s.erase) {
      for (const [tx, ty] of tiles) eraseAt(ctx, tileCentre(tx), tileCentre(ty));
      return;
    }
    const entry = ctx.activeEntry;
    if (entry)
      placeEntities(ctx.store, ctx.spatial, ctx.catalog, tiles.map(([tx, ty]) => tileDraft(ctx, entry, tx, ty)));
  }

  up(ctx: EditorContext): void {
    if (!this.stroke) return;
    this.stroke = null;
    ctx.store.commit();
  }

  cancel(ctx: EditorContext): void {
    if (this.stroke) ctx.store.cancel();
    this.stroke = null;
  }

  drawOverlay(ctx: EditorContext, g: CanvasRenderingContext2D): void {
    const p = this.hover;
    if (!p || this.stroke?.erase) return;
    if (ctx.activeTemplate) {
      const t = ctx.store.templates.get(ctx.activeTemplate);
      if (!t) return;
      const size = turnVector(t.size.w * TILE_SIZE, t.size.h * TILE_SIZE, ctx.placeRotation);
      g.save();
      g.strokeStyle = 'rgba(110, 200, 255, 0.95)';
      g.fillStyle = 'rgba(110, 200, 255, 0.12)';
      g.lineWidth = 4;
      g.setLineDash([16, 10]);
      const w = Math.abs(size.x);
      const h = Math.abs(size.y);
      g.fillRect(p.tx * TILE_SIZE, p.ty * TILE_SIZE, w, h);
      g.strokeRect(p.tx * TILE_SIZE, p.ty * TILE_SIZE, w, h);
      g.restore();
      return;
    }
    const entry = ctx.activeEntry;
    if (!entry) return;
    const draft = GRID_KINDS.has(entry.kind)
      ? tileDraft(ctx, entry, p.tx, p.ty)
      : draftFor(ctx, entry, freePosition(p).x, freePosition(p).y);
    drawGhost(g, ctx.assets, entry, entry.kind, draft.x, draft.y, draft.rotation ?? 0, fits(ctx, entry, draft), ctx.night);
  }

  private stampTemplate(ctx: EditorContext, p: PointerInfo): void {
    const result = instantiateTemplate(ctx.store, ctx.spatial, ctx.catalog, ctx.activeTemplate!, {
      x: p.tx * TILE_SIZE,
      y: p.ty * TILE_SIZE,
    }, ctx.placeRotation);
    if (result.ok) {
      ctx.selection.set(result.ids);
      ctx.status('Template placed as an independent copy.', 'ok');
    } else {
      ctx.offenders = new Set(result.offenders);
      ctx.status(result.reason ?? 'The template does not fit here.', 'error');
    }
  }
}

/** Removes the top-most editable piece at a point; free placements win over tiles. */
export function eraseAt(ctx: EditorContext, x: number, y: number): boolean {
  const target = pickAt(ctx, x, y).find((id) => ctx.store.entities.has(id));
  if (!target) return false;
  removeWithDependents(ctx.store, [target]);
  return true;
}

abstract class ShapeTool implements Tool {
  abstract readonly id: 'line' | 'rect';
  abstract readonly label: string;
  abstract readonly shortcut: string;
  abstract readonly hint: string;
  protected start: { tx: number; ty: number } | null = null;
  protected end: { tx: number; ty: number; shift: boolean } | null = null;

  cursor(): string {
    return 'crosshair';
  }

  protected abstract tiles(ctx: EditorContext): [number, number][];

  down(ctx: EditorContext, p: PointerInfo): void {
    if (p.button !== 0) return;
    const entry = ctx.activeEntry;
    if (!entry || !GRID_KINDS.has(entry.kind)) {
      ctx.status('Line and rectangle paint grid pieces: pick a wall, floor or other piece.', 'warn');
      return;
    }
    if (layerBlocked(ctx, entry)) return;
    this.start = { tx: p.tx, ty: p.ty };
    this.end = { tx: p.tx, ty: p.ty, shift: p.shift };
  }

  move(_ctx: EditorContext, p: PointerInfo): void {
    if (this.start) this.end = { tx: p.tx, ty: p.ty, shift: p.shift };
  }

  up(ctx: EditorContext): void {
    const entry = ctx.activeEntry;
    if (!this.start || !entry) return;
    const tiles = this.tiles(ctx).filter(([tx, ty]) => inMap(ctx, tx, ty));
    this.start = this.end = null;
    ctx.store.transact(`${this.label} ${entry.name}`, () =>
      placeEntities(ctx.store, ctx.spatial, ctx.catalog, tiles.map(([tx, ty]) => tileDraft(ctx, entry, tx, ty))),
    );
  }

  cancel(): void {
    this.start = this.end = null;
  }

  drawOverlay(ctx: EditorContext, g: CanvasRenderingContext2D): void {
    if (!this.start) return;
    const tiles = this.tiles(ctx);
    const entry = ctx.activeEntry;
    if (entry && tiles.length <= 400)
      for (const [tx, ty] of tiles)
        drawGhost(g, ctx.assets, entry, entry.kind, tileCentre(tx), tileCentre(ty), ctx.placeRotation, inMap(ctx, tx, ty), ctx.night);
    else drawTiles(g, tiles, 'rgba(110, 200, 255, 0.35)');
  }
}

export class LineTool extends ShapeTool {
  readonly id = 'line';
  readonly label = 'Line';
  readonly shortcut = 'l';
  readonly hint = 'Drag to paint a straight line of the selected piece.';

  protected tiles(): [number, number][] {
    return this.start && this.end ? lineTiles(this.start.tx, this.start.ty, this.end.tx, this.end.ty) : [];
  }
}

export class RectTool extends ShapeTool {
  readonly id = 'rect';
  readonly label = 'Rectangle';
  readonly shortcut = 'u';
  readonly hint = 'Drag a rectangle; outline or filled per the toolbar. Shift inverts.';

  protected tiles(ctx: EditorContext): [number, number][] {
    if (!this.start || !this.end) return [];
    const filled = ctx.rectFilled !== this.end.shift;
    return rectTiles(this.start.tx, this.start.ty, this.end.tx, this.end.ty, filled);
  }
}

/**
 * Tiles connected (4-neighbour) to the start whose slot holds the same thing as the start
 * tile: the same piece, or nothing. Null when the area exceeds FILL_LIMIT.
 */
export function floodTiles(ctx: EditorContext, entry: CatalogEntry, sx: number, sy: number): [number, number][] | null {
  if (!inMap(ctx, sx, sy)) return [];
  const slot = slotOf(entry);
  const signature = (tx: number, ty: number): string => {
    const id = ctx.spatial.cell(tx, ty)?.[slot];
    const e = id ? ctx.store.entities.get(id) : undefined;
    return e ? `${e.ref}:${e.variant ?? ''}` : '';
  };
  const target = signature(sx, sy);
  const { tilesX } = ctx.store.header.world;
  const seen = new Set<number>([sy * tilesX + sx]);
  const out: [number, number][] = [];
  const queue: [number, number][] = [[sx, sy]];
  while (queue.length) {
    const [tx, ty] = queue.pop()!;
    out.push([tx, ty]);
    if (out.length > FILL_LIMIT) return null;
    for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]] as const) {
      const key = ny * tilesX + nx;
      if (seen.has(key) || !inMap(ctx, nx, ny)) continue;
      seen.add(key);
      if (signature(nx, ny) === target) queue.push([nx, ny]);
    }
  }
  return out;
}

export class FillTool implements Tool {
  readonly id = 'fill';
  readonly label = 'Fill';
  readonly shortcut = 'g';
  readonly hint = `Click to flood-fill the connected area that matches the clicked tile (up to ${FILL_LIMIT} tiles).`;

  cursor(): string {
    return 'crosshair';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    const entry = ctx.activeEntry;
    if (!entry || !GRID_KINDS.has(entry.kind)) {
      ctx.status('Fill paints grid pieces: pick a floor, road or other piece.', 'warn');
      return;
    }
    if (layerBlocked(ctx, entry)) return;
    const tiles = floodTiles(ctx, entry, p.tx, p.ty);
    if (!tiles) {
      ctx.status(`That area is larger than ${FILL_LIMIT} tiles; use the rectangle tool.`, 'error');
      return;
    }
    ctx.store.transact(`Fill ${entry.name}`, () =>
      placeEntities(ctx.store, ctx.spatial, ctx.catalog, tiles.map(([tx, ty]) => tileDraft(ctx, entry, tx, ty))),
    );
    ctx.status(`Filled ${tiles.length} tiles.`, 'ok');
  }
}

export class EraseTool implements Tool {
  readonly id = 'erase';
  readonly label = 'Erase';
  readonly shortcut = 'e';
  readonly hint = 'Click or drag to remove the top-most piece under the cursor.';
  private last: { tx: number; ty: number } | null = null;
  private hover: PointerInfo | null = null;

  cursor(): string {
    return 'cell';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    ctx.store.begin('Erase');
    this.last = { tx: p.tx, ty: p.ty };
    eraseAt(ctx, p.wx, p.wy);
  }

  move(ctx: EditorContext, p: PointerInfo): void {
    this.hover = p;
    if (!this.last || (this.last.tx === p.tx && this.last.ty === p.ty)) return;
    for (const [tx, ty] of lineTiles(this.last.tx, this.last.ty, p.tx, p.ty).slice(1))
      eraseAt(ctx, tileCentre(tx), tileCentre(ty));
    this.last = { tx: p.tx, ty: p.ty };
  }

  up(ctx: EditorContext): void {
    if (!this.last) return;
    this.last = null;
    ctx.store.commit();
  }

  cancel(ctx: EditorContext): void {
    if (this.last) ctx.store.cancel();
    this.last = null;
  }

  drawOverlay(_ctx: EditorContext, g: CanvasRenderingContext2D): void {
    if (this.hover) drawTiles(g, [[this.hover.tx, this.hover.ty]], BAD_COLOUR.replace('0.95', '0.25'));
  }
}

export class PickTool implements Tool {
  readonly id = 'pick';
  readonly label = 'Eyedropper';
  readonly shortcut = 'i';
  readonly hint = 'Click a piece to paint with it (keeps its rotation).';

  constructor(private readonly onPicked: (ctx: EditorContext) => void) {}

  cursor(): string {
    return 'copy';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    const id = pickAt(ctx, p.wx, p.wy).find((x) => ctx.store.entities.has(x));
    const e = id ? ctx.store.entities.get(id) : undefined;
    const entry = e ? ctx.catalog.resolve(e.kind, e.ref, e.variant) : undefined;
    if (!e || !entry || !isEditable(ctx, e.id)) {
      ctx.status('Nothing to pick here.', 'warn');
      return;
    }
    ctx.activeEntry = entry;
    ctx.activeTemplate = null;
    ctx.placeRotation = e.rotation ?? Math.round((e.angle ?? 0) / 64) % 4;
    ctx.status(`Painting with ${entry.name}.`, 'ok');
    this.onPicked(ctx);
  }
}
