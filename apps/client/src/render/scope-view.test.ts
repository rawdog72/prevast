// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import { drawScopeMask, ShapeMask } from './scope-view';

function recorder() {
  const rects: number[][] = [];
  const ctx = {
    save() {},
    restore() {},
    fillStyle: '' as unknown,
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push([x, y, w, h]);
    },
    createLinearGradient: () => ({ addColorStop() {} }),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

// Camera on (0, 0), zoom 1: world (x, y) is screen (500 + x, 400 + y).
const camera = new Camera({ viewportWidth: 1000, viewportHeight: 800 });

describe('drawScopeMask', () => {
  it('draws nothing when the sent box covers the screen', () => {
    const { ctx, rects } = recorder();
    drawScopeMask(ctx, camera, 0, 0, { minDX: -1400, maxDX: 1400, minDY: -900, maxDY: 900 }, 1);
    expect(rects).toEqual([]);
  });

  it('darkens the strip behind a box shifted north, past a feathered edge', () => {
    const { ctx, rects } = recorder();
    drawScopeMask(ctx, camera, 0, 0, { minDX: -1400, maxDX: 1400, minDY: -1400, maxDY: 200 }, 1);
    // The box ends at screen y 600; the feather runs to 680; dark below that.
    expect(rects).toContainEqual([0, 600, 1000, 80]);
    expect(rects).toContainEqual([0, 680, 1000, 120]);
  });

  it('draws nothing while the blend is 0', () => {
    const { ctx, rects } = recorder();
    drawScopeMask(ctx, camera, 0, 0, { minDX: -1400, maxDX: 1400, minDY: -1400, maxDY: 200 }, 0);
    expect(rects).toEqual([]);
  });
});

describe('ShapeMask', () => {
  function layer() {
    const calls: string[] = [];
    const m = {
      globalCompositeOperation: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: '',
      fillStyle: '' as unknown,
      strokeStyle: '' as unknown,
      setTransform: () => calls.push('setTransform'),
      fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fillRect ${x} ${y} ${w} ${h}`),
      beginPath: () => calls.push('beginPath'),
      moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
      closePath: () => calls.push('closePath'),
      arc: (x: number, y: number, r: number) => calls.push(`arc ${x} ${y} ${r}`),
      fill: () => calls.push('fill'),
      stroke: () => calls.push(`stroke ${m.lineWidth.toFixed(1)} ${m.globalAlpha.toFixed(3)}`),
    };
    const canvas = { width: 0, height: 0, getContext: () => m } as unknown as HTMLCanvasElement;
    return { canvas, calls };
  }
  function game() {
    const drawn: number[] = [];
    const ctx = {
      canvas: { width: 1000, height: 800 },
      globalAlpha: 1,
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      save() {},
      restore() {},
      setTransform() {},
      drawImage() {
        drawn.push(ctx.globalAlpha);
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
  }
  // The sniper's rect aiming east, as scopeOutline gives it.
  const rect = [
    { x: -100, y: -250 },
    { x: 1900, y: -250 },
    { x: 1900, y: 250 },
    { x: -100, y: 250 },
  ];
  // Six strokes, widest first: a feather (80 world units) either side of the
  // edge, down to a sixth of it, each clearing 1/7 .. 1/2 of what is left.
  const feather = [
    'stroke 160.0 0.143',
    'stroke 133.3 0.167',
    'stroke 106.7 0.200',
    'stroke 80.0 0.250',
    'stroke 53.3 0.333',
    'stroke 26.7 0.500',
  ];

  it('cuts the shape and the rear circle out of a dark layer, and lays it over the world once', () => {
    const l = layer();
    const g = game();
    new ShapeMask(() => l.canvas).draw(g.ctx, camera, 0, 0, rect, 250, 1);
    expect(l.calls).toEqual([
      'setTransform',
      'fillRect 0 0 1000 800',
      'setTransform',
      'beginPath',
      'moveTo 400 150',
      'lineTo 2400 150',
      'lineTo 2400 650',
      'lineTo 400 650',
      'closePath',
      'fill',
      ...feather,
      'beginPath',
      'arc 500 400 250',
      'fill',
      ...feather,
    ]);
    expect(g.drawn).toEqual([0.72]);
  });

  it('draws nothing while the blend is 0', () => {
    const l = layer();
    const g = game();
    new ShapeMask(() => l.canvas).draw(g.ctx, camera, 0, 0, rect, 250, 0);
    expect(l.calls).toEqual([]);
    expect(g.drawn).toEqual([]);
  });
});
