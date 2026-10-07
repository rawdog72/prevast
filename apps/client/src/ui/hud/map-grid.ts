// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/map-grid.ts
// GameUI.mapGrid, made to follow the map: the sector grid every map view
// draws -- inset fill, the player's cell lit, cells named column letter x row
// number. The old client fixed 8 x 8 whatever the map; here a cell is about 20
// tiles so "C3" is the same size of ground on every server, with the count
// clamped so labels stay readable on the 410 px big map. Admins resize maps
// live, so nothing is cached: callers pass the current world size each draw.
// Under the grid goes what the session has seen of the map (MapMemoryImage).

import { MemoryCell, type MapMemory } from '../../world/map-memory';

/** Target sector size in world units (20 tiles), and the per-axis cell count bounds. */
export const SECTOR_WORLD_UNITS = 2000;
export const MIN_SECTORS = 4;
export const MAX_SECTORS = 16;

/** GameUI theme values the canvas cannot read from CSS variables at draw time. */
export const MAP_INSET = 'rgba(5,9,13,.30)';
const CELL_ACTIVE = 'rgba(222,233,244,.12)';
const GRID_LINE = 'rgba(222,232,245,.16)';
const LABEL = '#f2f4f6';
const LABEL_FAINT = 'rgba(230,236,245,.45)';
export const MAP_FONT = 'Viga, sans-serif';

export interface SectorGrid {
  cols: number;
  rows: number;
}

/** How many sector columns / rows a map of this size gets (square cells in world units). */
export function sectorGrid(worldW: number, worldH: number): SectorGrid {
  const clamp = (n: number) => Math.min(MAX_SECTORS, Math.max(MIN_SECTORS, Math.round(n)));
  return {
    cols: clamp(worldW / SECTOR_WORLD_UNITS),
    rows: clamp(worldH / SECTOR_WORLD_UNITS),
  };
}

/** Spreadsheet-style column names: A..Z, AA, AB, ... */
export function columnLabel(col: number): string {
  let n = col;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The (col, row) cell containing a world point, clamped onto the grid. */
export function sectorCell(
  x: number,
  y: number,
  worldW: number,
  worldH: number,
  grid: SectorGrid = sectorGrid(worldW, worldH),
): { col: number; row: number } {
  return {
    col: Math.min(grid.cols - 1, Math.max(0, Math.floor((x / worldW) * grid.cols))),
    row: Math.min(grid.rows - 1, Math.max(0, Math.floor((y / worldH) * grid.rows))),
  };
}

/** Map memory colours (RGBA): explored ground after the world's day ground, darker resources, pale structures. */
const MEMORY_RGBA: Record<number, [number, number, number, number]> = {
  [MemoryCell.GROUND]: [61, 89, 66, 150],
  [MemoryCell.RESOURCE]: [30, 46, 34, 235],
  [MemoryCell.STRUCTURE]: [222, 212, 180, 235],
};

/**
 * The map memory as an image, one pixel per tile, rebuilt only when the
 * memory changes. Both map views draw it scaled over the whole world.
 */
export class MapMemoryImage {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private version = -1;

  /** Draws `memory` over `width x height` (the whole world) at the current origin. */
  draw(c: CanvasRenderingContext2D, memory: MapMemory, width: number, height: number): void {
    if (!memory.tilesX || !memory.tilesY) return;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
    }
    if (!this.ctx) return;
    if (this.version !== memory.version) {
      this.version = memory.version;
      if (this.canvas.width !== memory.tilesX || this.canvas.height !== memory.tilesY) {
        this.canvas.width = memory.tilesX;
        this.canvas.height = memory.tilesY;
      }
      const image = this.ctx.createImageData(memory.tilesX, memory.tilesY);
      for (let i = 0; i < memory.cells.length; i++) {
        const rgba = MEMORY_RGBA[memory.cells[i]];
        if (rgba) image.data.set(rgba, i * 4);
      }
      this.ctx.putImageData(image, 0, 0);
    }
    c.save();
    c.imageSmoothingEnabled = true;
    c.drawImage(this.canvas, 0, 0, width, height);
    c.restore();
  }
}

export interface MapGridOptions {
  grid: SectorGrid;
  /** Drawn over the inset fill and under the grid lines (the map memory). */
  underlay?: (c: CanvasRenderingContext2D) => void;
  /** The cell to light (the player's). */
  active?: { col: number; row: number };
  /** Draw column letters above and row numbers left of the grid (needs margin room). */
  margins?: boolean;
  /** Faint cell names inside every cell (the minimap texture look). */
  cellLabels?: boolean;
}

/**
 * The grid over a `width x height` rectangle at the current origin. Only the
 * cells intersecting `clip` (in the same coordinates) are stroked and
 * labelled, so a scrolled minimap pays for the handful it shows.
 */
export function drawMapGrid(
  c: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: MapGridOptions,
  clip?: { x: number; y: number; w: number; h: number },
): void {
  const { cols, rows } = options.grid;
  const cellW = width / cols;
  const cellH = height / rows;
  const region = clip ?? { x: 0, y: 0, w: width, h: height };
  const col0 = Math.max(0, Math.floor(region.x / cellW));
  const col1 = Math.min(cols, Math.ceil((region.x + region.w) / cellW));
  const row0 = Math.max(0, Math.floor(region.y / cellH));
  const row1 = Math.min(rows, Math.ceil((region.y + region.h) / cellH));

  c.save();
  c.fillStyle = MAP_INSET;
  c.fillRect(0, 0, width, height);
  options.underlay?.(c);
  if (options.active) {
    c.fillStyle = CELL_ACTIVE;
    c.fillRect(options.active.col * cellW, options.active.row * cellH, cellW, cellH);
  }
  c.strokeStyle = GRID_LINE;
  c.lineWidth = 1;
  c.beginPath();
  for (let col = col0; col <= col1; col++) {
    c.moveTo(col * cellW, 0);
    c.lineTo(col * cellW, height);
  }
  for (let row = row0; row <= row1; row++) {
    c.moveTo(0, row * cellH);
    c.lineTo(width, row * cellH);
  }
  c.stroke();
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (options.cellLabels) {
    // Sized to the cell so a dense grid stays legible rather than overlapping.
    const size = Math.max(9, Math.min(30, Math.floor(Math.min(cellW, cellH) * 0.3)));
    c.fillStyle = LABEL_FAINT;
    c.font = `${size}px ${MAP_FONT}`;
    for (let col = col0; col < col1; col++) {
      for (let row = row0; row < row1; row++) {
        c.fillText(columnLabel(col) + (row + 1), (col + 0.5) * cellW, (row + 0.5) * cellH);
      }
    }
  }
  if (options.margins) {
    const size = Math.max(9, Math.min(12, Math.floor(Math.min(cellW, cellH) * 0.5)));
    c.fillStyle = LABEL;
    c.font = `${size}px ${MAP_FONT}`;
    for (let col = 0; col < cols; col++) c.fillText(columnLabel(col), (col + 0.5) * cellW, -12);
    for (let row = 0; row < rows; row++) c.fillText(String(row + 1), -13, (row + 0.5) * cellH);
  }
  c.restore();
}
