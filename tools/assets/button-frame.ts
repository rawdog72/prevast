// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// tools/assets/button-frame.ts
// Takes the old client's button frame off a sprite. Every `inv-*-out.png` item
// icon and `*-button-out.png` tab glyph is the art drawn over a rounded
// square: a solid black border (~6 px, touching the edges) and a fill that is
// either translucent (a yellow or black tint) or opaque (the grey tab
// buttons). The HUD draws its own slots, so the frame doubles up; this returns
// the art alone on transparency, at the same size so icons keep their scale.
//
// - The border is every pixel within the measured border thickness (+1 for
//   its anti-aliased inner edge) of the transparent outside.
// - A translucent fill is removed exactly: the art was composited over it,
//   so each pixel is un-composited (Porter-Duff "over" solved for the art).
// - An opaque fill cannot be un-composited. Those are the tab buttons: a light
//   glyph on a darker fill (with a bevel, sometimes an inner panel), so the
//   glyph is keyed out by brightness above the fill's.
//
// Anything that does not look like a frame (a shape that does not reach all
// four edges, a border of odd thickness) returns null and is used as it is.

import type { RgbaImage } from './png';

const MIN_BORDER = 3;
const MAX_BORDER = 14;
/** Border pixels: opaque and dark. */
const BORDER_ALPHA = 200;
const BORDER_LUMA = 60;
/** A fill at or above this alpha is treated as opaque. */
const OPAQUE_FILL = 240;
/** Fill samples this close (premultiplied RGBA) count as the same colour. */
const FILL_TOLERANCE = 64;
/** Opaque fills: coverage ramps from this far above the fill's brightness up to GLYPH_LUMA. */
const FILL_LIFT = 45;
const GLYPH_LUMA = 235;

type Px = [number, number, number, number];

function px(img: RgbaImage, x: number, y: number): Px {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function luma([r, g, b]: Px): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Distance between two pixels in premultiplied RGBA, 0..~510. */
function dist(a: Px, b: Px): number {
  const pa = a[3] / 255;
  const pb = b[3] / 255;
  const dr = a[0] * pa - b[0] * pb;
  const dg = a[1] * pa - b[1] * pb;
  const db = a[2] * pa - b[2] * pb;
  const da = a[3] - b[3];
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

const isBorder = (p: Px) => p[3] >= BORDER_ALPHA && luma(p) < BORDER_LUMA;

/** Border thickness along one scan from the edge inwards, or -1 when it is not a frame edge. */
function borderRun(img: RgbaImage, points: [number, number][]): number {
  // A frame touches the edge: at most two faint (anti-aliased) pixels before the border.
  let i = 0;
  while (i < points.length && px(img, ...points[i])[3] < BORDER_ALPHA) i++;
  if (i > 2) return -1;
  const start = i;
  while (i < points.length && isBorder(px(img, ...points[i]))) i++;
  return i - start;
}

export function stripButtonFrame(img: RgbaImage): RgbaImage | null {
  const { width: w, height: h } = img;
  if (w < 24 || h < 24) return null;
  const midX = Math.floor(w / 2);
  const midY = Math.floor(h / 2);
  const reach = MAX_BORDER + 4;
  const scans: [number, number][][] = [
    Array.from({ length: reach }, (_, k) => [k, midY]),
    Array.from({ length: reach }, (_, k) => [w - 1 - k, midY]),
    Array.from({ length: reach }, (_, k) => [midX, k]),
    Array.from({ length: reach }, (_, k) => [midX, h - 1 - k]),
  ];
  const runs = scans.map((scan) => borderRun(img, scan));
  if (runs.some((r) => r < MIN_BORDER || r > MAX_BORDER)) return null;
  if (Math.max(...runs) - Math.min(...runs) > 2) return null;
  const t = Math.max(...runs);

  // Depth from the outside: 0 on the transparent surround (and the image edge),
  // growing inwards one ring per step (8-connected, i.e. Chebyshev distance).
  const depth = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const seed = (x: number, y: number) => {
    const i = y * w + x;
    if (depth[i] !== -1) return;
    depth[i] = 0;
    queue[tail++] = i;
  };
  for (let x = 0; x < w; x++) {
    if (px(img, x, 0)[3] < 10) seed(x, 0);
    if (px(img, x, h - 1)[3] < 10) seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    if (px(img, 0, y)[3] < 10) seed(0, y);
    if (px(img, w - 1, y)[3] < 10) seed(w - 1, y);
  }
  // Transparent pixels connected to the edge are outside too.
  for (let q = 0; q < tail; q++) {
    const i = queue[q];
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (depth[ny * w + nx] === -1 && px(img, nx, ny)[3] < 10) seed(nx, ny);
      }
  }
  // Edge pixels that are border (the frame's straight runs touch the edge) start
  // at depth 1; then one breadth-first pass from depth 0 and 1 outwards.
  const bfs: number[] = Array.from(queue.subarray(0, tail));
  for (let x = 0; x < w; x++)
    for (const i of [x, x + (h - 1) * w])
      if (depth[i] === -1) {
        depth[i] = 1;
        bfs.push(i);
      }
  for (let y = 0; y < h; y++)
    for (const i of [y * w, y * w + w - 1])
      if (depth[i] === -1) {
        depth[i] = 1;
        bfs.push(i);
      }
  for (let head = 0; head < bfs.length; head++) {
    const i = bfs[head];
    const d = depth[i];
    if (d > t + 8) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (depth[n] !== -1) continue;
        depth[n] = d + 1;
        bfs.push(n);
      }
  }

  // The fill: sampled just inside the border along the four scans.
  const samples: Px[] = [];
  for (const scan of scans)
    for (let k = t + 2; k < Math.min(scan.length, t + 5); k++) samples.push(px(img, ...scan[k]));
  // Art may come close to the frame on a side or two: the fill is the sample
  // most others agree with, and at least half of them must.
  let fill = samples[0];
  let near = 0;
  for (const s of samples) {
    const agree = samples.filter((o) => dist(o, s) <= FILL_TOLERANCE / 2).length;
    if (agree > near) {
      near = agree;
      fill = s;
    }
  }
  if (near * 2 < samples.length) return null;

  const out = new Uint8Array(img.data);
  const clear = (i: number) => out.fill(0, i * 4, i * 4 + 4);
  for (let i = 0; i < w * h; i++) if (depth[i] !== -1 && depth[i] <= t + 1) clear(i);

  if (fill[3] < OPAQUE_FILL) {
    // Translucent fill: art over fill, solved for the art.
    const fa = fill[3] / 255;
    for (let i = 0; i < w * h; i++) {
      if (depth[i] !== -1 && depth[i] <= t + 1) continue;
      const o = i * 4;
      const oa = out[o + 3] / 255;
      const a = oa <= fa ? 0 : (oa - fa) / (1 - fa);
      if (a < 0.03) {
        clear(i);
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const premult = (out[o + c] * oa - fill[c] * fa * (1 - a)) / a;
        out[o + c] = Math.max(0, Math.min(255, Math.round(premult)));
      }
      out[o + 3] = Math.round(a * 255);
    }
    return { width: w, height: h, data: out };
  }

  // Opaque fill (the tab buttons): a light glyph on a darker fill, often with a
  // bevel or an inner panel. Brightness above the fill's is the glyph's coverage.
  const floor = Math.min(200, luma(fill) + FILL_LIFT);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (out[o + 3] === 0) continue;
    const l = luma([out[o], out[o + 1], out[o + 2], 255]);
    const a = Math.max(0, Math.min(1, (l - floor) / (GLYPH_LUMA - floor)));
    if (a < 0.03) {
      clear(i);
      continue;
    }
    out[o + 3] = Math.round(out[o + 3] * a);
  }
  return { width: w, height: h, data: out };
}
