// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/map-memory.ts
// What this session has seen of the map, one cell per tile: the server sends
// no terrain, only the units around us, so the minimap and the big map (M)
// draw this instead of an empty grid. Whatever is on screen is re-read a few
// times a second -- the ground there is marked explored, then every resource
// and structure in view is painted on it -- so a felled tree or a razed wall
// disappears from the memory the next time it is in view. A map resize starts over.

import { EntityType } from './entity-types';

export const MemoryCell = {
  UNKNOWN: 0,
  GROUND: 1,
  RESOURCE: 2,
  STRUCTURE: 3,
} as const;

const OBSERVE_INTERVAL_MS = 250;
const TILE = 100;

const RESOURCE_TYPES: ReadonlySet<number> = new Set([
  EntityType.RES_TOP,
  EntityType.RES_DOWN,
  EntityType.RES_MID,
  EntityType.RES_STOP,
]);
const STRUCTURE_TYPES: ReadonlySet<number> = new Set([
  EntityType.BUILD_TOP,
  EntityType.BUILD_DOWN,
  EntityType.BUILD_GROUND,
  EntityType.BUILD_GROUND2,
]);

/** A world rectangle, in world units. */
export interface WorldRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class MapMemory {
  tilesX = 0;
  tilesY = 0;
  cells = new Uint8Array(0);
  /** Bumped on every change, so a drawer can cache its image. */
  version = 0;
  private lastObserve = -Infinity;

  /** Starts over on a map of this size (keeps what it has if the size is unchanged). */
  resize(tilesX: number, tilesY: number): void {
    if (tilesX === this.tilesX && tilesY === this.tilesY) return;
    this.tilesX = Math.max(0, Math.floor(tilesX));
    this.tilesY = Math.max(0, Math.floor(tilesY));
    this.cells = new Uint8Array(this.tilesX * this.tilesY);
    this.version++;
  }

  reset(): void {
    this.cells.fill(0);
    this.version++;
  }

  /**
   * Records `view` (what is on screen) at most every OBSERVE_INTERVAL_MS:
   * explored ground, then the resources and structures standing in it.
   */
  observe(
    view: WorldRect,
    /** Read only when this call records (the store copies its list). */
    entities: () => Iterable<{ type: number; x: number; y: number; removed?: boolean }>,
    now: number,
  ): boolean {
    if (now - this.lastObserve < OBSERVE_INTERVAL_MS || !this.cells.length) return false;
    this.lastObserve = now;
    const cx0 = Math.max(0, Math.floor(view.x0 / TILE));
    const cy0 = Math.max(0, Math.floor(view.y0 / TILE));
    const cx1 = Math.min(this.tilesX - 1, Math.floor(view.x1 / TILE));
    const cy1 = Math.min(this.tilesY - 1, Math.floor(view.y1 / TILE));
    if (cx0 > cx1 || cy0 > cy1) return false;

    const next = this.cells.slice();
    for (let y = cy0; y <= cy1; y++)
      next.fill(MemoryCell.GROUND, y * this.tilesX + cx0, y * this.tilesX + cx1 + 1);
    for (const e of entities()) {
      if (e.removed) continue;
      const kind = STRUCTURE_TYPES.has(e.type)
        ? MemoryCell.STRUCTURE
        : RESOURCE_TYPES.has(e.type)
          ? MemoryCell.RESOURCE
          : 0;
      if (!kind) continue;
      const tx = Math.floor(e.x / TILE);
      const ty = Math.floor(e.y / TILE);
      if (tx < cx0 || tx > cx1 || ty < cy0 || ty > cy1) continue;
      const i = ty * this.tilesX + tx;
      // A structure wins over a resource sharing its tile.
      if (kind > next[i]) next[i] = kind;
    }
    let changed = false;
    for (let i = 0; i < next.length; i++)
      if (next[i] !== this.cells[i]) {
        changed = true;
        break;
      }
    if (!changed) return false;
    this.cells = next;
    this.version++;
    return true;
  }
}
