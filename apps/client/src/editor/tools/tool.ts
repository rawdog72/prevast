// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Canvas tools. A tool turns pointer input into document operations; it never touches the
// DOM and draws its own previews in world space during the overlay pass.
import type { EditorContext } from '../editor-context';

export interface PointerInfo {
  /** Screen position in CSS pixels, relative to the canvas. */
  sx: number;
  sy: number;
  /** World position in units. */
  wx: number;
  wy: number;
  /** Tile under the pointer. */
  tx: number;
  ty: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type ToolId = 'select' | 'place' | 'line' | 'rect' | 'fill' | 'erase' | 'pick' | 'region';

export interface Tool {
  readonly id: ToolId;
  readonly label: string;
  /** Keyboard shortcut (single key, no modifiers). */
  readonly shortcut: string;
  readonly hint: string;
  cursor(ctx: EditorContext): string;
  down?(ctx: EditorContext, p: PointerInfo): void;
  move?(ctx: EditorContext, p: PointerInfo, dragging: boolean): void;
  up?(ctx: EditorContext, p: PointerInfo): void;
  /** Abandon an in-progress gesture (Escape, tool switch, blur). */
  cancel?(ctx: EditorContext): void;
  /** Tool-specific keys; return true when handled. */
  key?(ctx: EditorContext, ev: KeyboardEvent): boolean;
  /** Preview drawing, world space (camera transform applied). */
  drawOverlay?(ctx: EditorContext, g: CanvasRenderingContext2D): void;
}

/** Tiles on the straight line between two tiles (Bresenham), both ends included. */
export function lineTiles(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Tiles of a rectangle between two corner tiles, outline or filled. */
export function rectTiles(x0: number, y0: number, x1: number, y1: number, filled: boolean): [number, number][] {
  const out: [number, number][] = [];
  const ax = Math.min(x0, x1);
  const bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1);
  const by = Math.max(y0, y1);
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++)
      if (filled || x === ax || x === bx || y === ay || y === by) out.push([x, y]);
  return out;
}
