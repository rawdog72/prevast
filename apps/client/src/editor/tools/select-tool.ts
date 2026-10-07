// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Selection: click (Shift adds, Ctrl toggles, clicking the same spot again cycles through
// overlapping pieces), box select on empty ground, drag to move (whole tiles when grid
// pieces are involved), Alt-drag to duplicate. Moves are all-or-nothing.
import { TILE_SIZE } from '../../../../../shared/typescript/editor-limits';
import { GRID_KINDS } from '../../../../../shared/typescript/scenario-schema';
import {
  expandSelection,
  extractFragment,
  insertFragment,
  selectionBounds,
  transformSelection,
} from '../document/ops';
import { pickAt, pickRect, type EditorContext } from '../editor-context';
import { drawGhost } from '../scene/ghost';
import type { PointerInfo, Tool } from './tool';

const DRAG_THRESHOLD_PX = 4;
const MAX_MOVE_GHOSTS = 1500;

type Gesture =
  | { type: 'click'; start: PointerInfo; picks: string[] }
  | { type: 'move'; start: PointerInfo; dx: number; dy: number; duplicate: boolean; grid: boolean }
  | { type: 'box'; start: PointerInfo; end: PointerInfo };

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly label = 'Select';
  readonly shortcut = 'v';
  readonly hint = 'Click to select (Shift adds, Ctrl toggles, click again to cycle). Drag to move, Alt-drag to copy, drag empty ground to box-select.';
  private gesture: Gesture | null = null;
  private cycle: { x: number; y: number; index: number } | null = null;

  cursor(): string {
    return this.gesture?.type === 'move' ? 'grabbing' : 'default';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    if (p.button !== 0) return;
    const picks = pickAt(ctx, p.wx, p.wy);
    if (!picks.length) {
      this.gesture = { type: 'box', start: p, end: p };
      return;
    }
    const hitSelected = picks.find((id) => this.selectedOrAncestor(ctx, id));
    if (!hitSelected && !p.shift && !p.ctrl) ctx.selection.set([this.selectable(ctx, picks[0]!)]);
    else if (!hitSelected && p.shift) ctx.selection.add([this.selectable(ctx, picks[0]!)]);
    this.gesture = { type: 'click', start: p, picks };
  }

  move(ctx: EditorContext, p: PointerInfo): void {
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'box') {
      g.end = p;
      return;
    }
    if (g.type === 'click') {
      if (Math.hypot(p.sx - g.start.sx, p.sy - g.start.sy) < DRAG_THRESHOLD_PX || p.ctrl) return;
      if (!ctx.selection.size) return;
      const grid = [...expandSelection(ctx.store, ctx.selection.values())].some((id) => {
        const e = ctx.store.entities.get(id);
        return e !== undefined && GRID_KINDS.has(e.kind);
      });
      this.gesture = { type: 'move', start: g.start, dx: 0, dy: 0, duplicate: p.alt, grid };
      return;
    }
    const rawDx = p.wx - g.start.wx;
    const rawDy = p.wy - g.start.wy;
    g.dx = g.grid ? Math.round(rawDx / TILE_SIZE) * TILE_SIZE : Math.round(rawDx);
    g.dy = g.grid ? Math.round(rawDy / TILE_SIZE) * TILE_SIZE : Math.round(rawDy);
  }

  up(ctx: EditorContext, p: PointerInfo): void {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.type === 'box') {
      const x0 = Math.min(g.start.wx, p.wx);
      const x1 = Math.max(g.start.wx, p.wx);
      const y0 = Math.min(g.start.wy, p.wy);
      const y1 = Math.max(g.start.wy, p.wy);
      if (Math.abs(g.start.sx - p.sx) < DRAG_THRESHOLD_PX && Math.abs(g.start.sy - p.sy) < DRAG_THRESHOLD_PX) {
        if (!p.shift && !p.ctrl) ctx.selection.clear();
        return;
      }
      const hits = pickRect(ctx, x0, y0, x1, y1);
      if (p.shift || p.ctrl) ctx.selection.add(hits);
      else ctx.selection.set(hits);
      return;
    }
    if (g.type === 'click') {
      this.clickSelect(ctx, p, g.picks);
      return;
    }
    if (!g.dx && !g.dy) return;
    const ids = ctx.selection.values();
    if (g.duplicate) {
      const fragment = extractFragment(ctx.store, ids);
      const bounds = selectionBounds(ctx.store, ids);
      if (!fragment || !bounds) return;
      const origin = {
        x: Math.floor(bounds.x0 / TILE_SIZE) * TILE_SIZE + g.dx,
        y: Math.floor(bounds.y0 / TILE_SIZE) * TILE_SIZE + g.dy,
      };
      const result = insertFragment(ctx.store, ctx.spatial, ctx.catalog, fragment, origin);
      this.report(ctx, result.ok, result.offenders, result.reason);
      if (result.ok) ctx.selection.set(result.ids);
      return;
    }
    const result = transformSelection(ctx.store, ctx.spatial, ctx.catalog, ids, {
      dx: g.dx,
      dy: g.dy,
      turns: 0,
      pivot: { x: 0, y: 0 },
    });
    this.report(ctx, result.ok, result.offenders, result.reason);
  }

  cancel(): void {
    this.gesture = null;
  }

  drawOverlay(ctx: EditorContext, g: CanvasRenderingContext2D): void {
    const gesture = this.gesture;
    if (gesture?.type === 'box') {
      g.save();
      g.fillStyle = 'rgba(120, 190, 255, 0.12)';
      g.strokeStyle = 'rgba(160, 210, 255, 0.9)';
      g.lineWidth = 2 / ctx.camera.zoom;
      const x = Math.min(gesture.start.wx, gesture.end.wx);
      const y = Math.min(gesture.start.wy, gesture.end.wy);
      const w = Math.abs(gesture.end.wx - gesture.start.wx);
      const h = Math.abs(gesture.end.wy - gesture.start.wy);
      g.fillRect(x, y, w, h);
      g.strokeRect(x, y, w, h);
      g.restore();
    }
    if (gesture?.type === 'move' && (gesture.dx || gesture.dy)) {
      const closure = [...expandSelection(ctx.store, ctx.selection.values())];
      const entities = closure.map((id) => ctx.store.entities.get(id)).filter((e) => e !== undefined);
      if (entities.length > MAX_MOVE_GHOSTS) {
        const b = selectionBounds(ctx.store, closure);
        if (b) {
          g.save();
          g.strokeStyle = 'rgba(110, 200, 255, 0.95)';
          g.lineWidth = 4 / ctx.camera.zoom;
          g.strokeRect(b.x0 + gesture.dx, b.y0 + gesture.dy, b.x1 - b.x0, b.y1 - b.y0);
          g.restore();
        }
        return;
      }
      for (const e of entities) {
        const entry = ctx.catalog.resolve(e.kind, e.ref, e.variant);
        drawGhost(g, ctx.assets, entry, e.kind, e.x + gesture.dx, e.y + gesture.dy, e.rotation ?? 0, true, ctx.night);
      }
    }
  }

  /** Clicking a group member selects the outermost unselected group, like most editors. */
  private selectable(ctx: EditorContext, id: string): string {
    let top = id;
    let parent = (ctx.store.entities.get(id) ?? ctx.store.regions.get(id))?.parent;
    while (parent) {
      top = parent;
      parent = ctx.store.groups.get(parent)?.parent;
    }
    return top === id || ctx.selection.has(top) ? id : top;
  }

  private selectedOrAncestor(ctx: EditorContext, id: string): boolean {
    let cursor: string | undefined = id;
    while (cursor) {
      if (ctx.selection.has(cursor)) return true;
      cursor = (ctx.store.entities.get(cursor) ?? ctx.store.groups.get(cursor) ?? ctx.store.regions.get(cursor))?.parent;
    }
    return false;
  }

  private clickSelect(ctx: EditorContext, p: PointerInfo, picks: string[]): void {
    if (p.ctrl) {
      ctx.selection.toggle(picks[0]!);
      return;
    }
    if (p.shift) return; // already added on down
    // A second click on the same spot steps through what lies under it; a click that
    // started on a selected group member drills into the member itself.
    const same = this.cycle && Math.hypot(this.cycle.x - p.wx, this.cycle.y - p.wy) < 8;
    if (same) {
      this.cycle!.index = (this.cycle!.index + 1) % picks.length;
      ctx.selection.set([picks[this.cycle!.index]!]);
    } else {
      this.cycle = { x: p.wx, y: p.wy, index: 0 };
      const first = this.selectable(ctx, picks[0]!);
      if (!ctx.selection.has(first) || ctx.selection.size > 1) ctx.selection.set([first]);
    }
  }

  private report(ctx: EditorContext, ok: boolean, offenders: string[], reason?: string): void {
    ctx.offenders = new Set(offenders);
    if (!ok) ctx.status(`${reason ?? 'Not possible here.'} ${offenders.length ? `${offenders.length} member(s) highlighted.` : ''}`, 'error');
  }
}
