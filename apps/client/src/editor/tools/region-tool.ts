// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Draws regions: drag a circle from its centre or a rectangle corner to corner; a polygon is
// clicked point by point and closed with Enter or a double click. Effects and permissions are
// added in the inspector afterwards.
import type { RegionShape } from '../../../../../shared/typescript/scenario-schema';
import { polygonSelfIntersects } from '../../../../../shared/typescript/scenario-schema';
import type { EditorContext } from '../editor-context';
import { drawRegionShape } from '../scene/overlays';
import type { PointerInfo, Tool } from './tool';

export class RegionTool implements Tool {
  readonly id = 'region';
  readonly label = 'Region';
  readonly shortcut = 'k';
  readonly hint = 'Drag a circle or rectangle; for a polygon click points and press Enter.';
  private drag: { x: number; y: number; ex: number; ey: number } | null = null;
  private points: [number, number][] = [];
  private hover: PointerInfo | null = null;
  private lastClick = 0;

  cursor(): string {
    return 'crosshair';
  }

  down(ctx: EditorContext, p: PointerInfo): void {
    if (p.button !== 0) return;
    if (ctx.lockedLayers.has('regions') || ctx.hiddenLayers.has('regions')) {
      ctx.status('The regions layer is hidden or locked.', 'warn');
      return;
    }
    const x = Math.round(p.wx);
    const y = Math.round(p.wy);
    if (ctx.regionShape === 'polygon') {
      const now = performance.now();
      if (now - this.lastClick < 300 && this.points.length >= 3) {
        this.finishPolygon(ctx);
        return;
      }
      this.lastClick = now;
      this.points.push([x, y]);
      return;
    }
    this.drag = { x, y, ex: x, ey: y };
  }

  move(_ctx: EditorContext, p: PointerInfo): void {
    this.hover = p;
    if (this.drag) {
      this.drag.ex = Math.round(p.wx);
      this.drag.ey = Math.round(p.wy);
    }
  }

  up(ctx: EditorContext): void {
    const shape = this.dragShape(ctx);
    this.drag = null;
    if (shape) this.create(ctx, shape);
  }

  key(ctx: EditorContext, ev: KeyboardEvent): boolean {
    if (ev.key === 'Enter' && this.points.length >= 3) {
      this.finishPolygon(ctx);
      return true;
    }
    if (ev.key === 'Backspace' && this.points.length) {
      this.points.pop();
      return true;
    }
    return false;
  }

  cancel(): void {
    this.drag = null;
    this.points = [];
  }

  drawOverlay(ctx: EditorContext, g: CanvasRenderingContext2D): void {
    const shape = this.dragShape(ctx);
    if (shape) drawRegionShape(g, shape, 'rgba(110, 200, 255, 0.9)', 'rgba(110, 200, 255, 0.15)', ctx.camera.zoom);
    if (this.points.length) {
      const pts = [...this.points];
      if (this.hover) pts.push([Math.round(this.hover.wx), Math.round(this.hover.wy)]);
      g.save();
      g.strokeStyle = 'rgba(110, 200, 255, 0.9)';
      g.lineWidth = 2 / ctx.camera.zoom;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      for (const [x, y] of this.points) g.fillRect(x - 6 / ctx.camera.zoom, y - 6 / ctx.camera.zoom, 12 / ctx.camera.zoom, 12 / ctx.camera.zoom);
      g.restore();
    }
  }

  private dragShape(ctx: EditorContext): RegionShape | null {
    const d = this.drag;
    if (!d) return null;
    if (ctx.regionShape === 'circle') {
      const r = Math.round(Math.hypot(d.ex - d.x, d.ey - d.y));
      return r >= 10 ? { type: 'circle', x: d.x, y: d.y, r } : null;
    }
    const w = Math.abs(d.ex - d.x);
    const h = Math.abs(d.ey - d.y);
    return w >= 10 && h >= 10 ? { type: 'rect', x: Math.min(d.x, d.ex), y: Math.min(d.y, d.ey), w, h } : null;
  }

  private finishPolygon(ctx: EditorContext): void {
    const points = this.points;
    this.points = [];
    if (polygonSelfIntersects(points)) {
      ctx.status('A region polygon may not cross itself.', 'error');
      return;
    }
    this.create(ctx, { type: 'polygon', points });
  }

  private create(ctx: EditorContext, shape: RegionShape): void {
    const id = ctx.store.transact('Add region', () => {
      const regionId = ctx.store.allocId('r');
      ctx.store.put('region', {
        id: regionId,
        name: `Region ${ctx.store.regions.size + 1}`,
        shape,
        priority: 0,
      });
      return regionId;
    });
    ctx.selection.set([id]);
    ctx.status('Region added. Give it effects or permissions in the inspector.', 'ok');
  }
}
