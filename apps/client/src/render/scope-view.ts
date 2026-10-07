// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/scope-view.ts
// While aiming with a scope view, everything the server does not send is
// darkened: outside a weak view's box, or outside a strong view's shape and
// rear circle. So what a shift view gives up behind shows as given up rather
// than as entities silently missing. Screen space: drawn after the world and
// before the overlays and the HUD.
import type { Camera } from '../core/camera';
import type { Offset, ViewBox } from '../world/aim-view';

export const SCOPE_MASK_ALPHA = 0.72;
/** World units over which the darkness fades in outside the box edge. */
export const SCOPE_MASK_FEATHER = 80;

/** Darkens outside the box around (x, y), by `blend` (0..1) of the full mask. */
export function drawScopeMask(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  x: number,
  y: number,
  box: ViewBox,
  blend: number,
): void {
  const alpha = SCOPE_MASK_ALPHA * Math.min(1, Math.max(0, blend));
  if (alpha <= 0) return;
  const w = camera.viewportWidth;
  const h = camera.viewportHeight;
  const tl = camera.worldToScreen(x + box.minDX, y + box.minDY);
  const br = camera.worldToScreen(x + box.maxDX, y + box.maxDY);
  if (tl.x <= 0 && tl.y <= 0 && br.x >= w && br.y >= h) return;

  const f = SCOPE_MASK_FEATHER * camera.zoom;
  // Fully dark from a feather's width outside the box.
  const x0 = tl.x - f;
  const y0 = tl.y - f;
  const x1 = br.x + f;
  const y1 = br.y + f;
  const fill = (rx: number, ry: number, rw: number, rh: number) => {
    const left = Math.max(0, rx);
    const top = Math.max(0, ry);
    const right = Math.min(w, rx + rw);
    const bottom = Math.min(h, ry + rh);
    if (right > left && bottom > top) ctx.fillRect(left, top, right - left, bottom - top);
  };
  const dark = `rgba(0, 0, 0, ${alpha})`;
  const strip = (gx0: number, gy0: number, gx1: number, gy1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    fill(rx, ry, rw, rh);
  };

  ctx.save();
  // The feather: clear at the box edge, dark a feather out.
  strip(0, tl.y, 0, y0, x0, y0, x1 - x0, f); // above
  strip(0, br.y, 0, y1, x0, br.y, x1 - x0, f); // below
  strip(tl.x, 0, x0, 0, x0, tl.y, f, br.y - tl.y); // left
  strip(br.x, 0, x1, 0, br.x, tl.y, f, br.y - tl.y); // right
  ctx.fillStyle = dark;
  fill(0, 0, w, y0); // above
  fill(0, y1, w, h - y1); // below
  fill(0, y0, x0, y1 - y0); // left
  fill(x1, y0, w - x1, y1 - y0); // right
  ctx.restore();
}

/** Bands in the strong mask's soft edge: more is smoother, at one stroke each. */
export const SCOPE_FEATHER_STEPS = 6;

/**
 * The strong scope mask: everything outside the shape and the rear circle
 * darkened, with a soft edge. It is drawn on a canvas of its own, the size of
 * the game canvas, so the lit area can be cut out of the darkness whatever
 * its shape, then laid over the world in one draw.
 */
export class ShapeMask {
  private layer: HTMLCanvasElement | null = null;

  constructor(
    private readonly createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  ) {}

  /** Darkens outside `outline` (offsets from (x, y)) and the rear circle, by `blend` (0..1) of the full mask. */
  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    x: number,
    y: number,
    outline: readonly Offset[],
    rearRadius: number,
    blend: number,
  ): void {
    const alpha = SCOPE_MASK_ALPHA * Math.min(1, Math.max(0, blend));
    if (alpha <= 0) return;
    this.layer ??= this.createCanvas();
    const layer = this.layer;
    if (layer.width !== ctx.canvas.width) layer.width = ctx.canvas.width;
    if (layer.height !== ctx.canvas.height) layer.height = ctx.canvas.height;
    const m = layer.getContext('2d');
    if (!m) return;
    // Dark everywhere, in the layer's own pixels.
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.globalAlpha = 1;
    m.fillStyle = '#000';
    m.fillRect(0, 0, layer.width, layer.height);
    // Then the game canvas's own transform (its devicePixelRatio scale), so
    // the camera's screen points land where they do on the game canvas.
    m.setTransform(ctx.getTransform());
    m.globalCompositeOperation = 'destination-out';
    m.strokeStyle = '#000';
    m.lineJoin = 'round';
    const feather = SCOPE_MASK_FEATHER * camera.zoom;
    const centre = camera.worldToScreen(x, y);
    const traces = [
      () => {
        outline.forEach((p, i) => {
          const s = camera.worldToScreen(x + p.x, y + p.y);
          if (i === 0) m.moveTo(s.x, s.y);
          else m.lineTo(s.x, s.y);
        });
        m.closePath();
      },
      () => m.arc(centre.x, centre.y, rearRadius * camera.zoom, 0, Math.PI * 2),
    ];
    for (const trace of traces) {
      m.beginPath();
      trace();
      m.globalAlpha = 1;
      m.fill();
      // The soft edge: strokes centred on the edge, widest first, each
      // clearing 1/(n+1) .. 1/2 of what is left, so the darkness ramps up in
      // even steps over a feather's width outside the edge.
      for (let i = 0; i < SCOPE_FEATHER_STEPS; i++) {
        m.globalAlpha = 1 / (SCOPE_FEATHER_STEPS + 1 - i);
        m.lineWidth = (2 * feather * (SCOPE_FEATHER_STEPS - i)) / SCOPE_FEATHER_STEPS;
        m.stroke();
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }
}
