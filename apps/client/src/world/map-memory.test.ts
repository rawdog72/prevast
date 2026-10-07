// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { EntityType } from './entity-types';
import { MapMemory, MemoryCell } from './map-memory';

const at = (m: MapMemory, tx: number, ty: number) => m.cells[ty * m.tilesX + tx];

describe('MapMemory', () => {
  it('marks what is in view as ground, with resources and structures on it', () => {
    const m = new MapMemory();
    m.resize(10, 10);
    const changed = m.observe(
      { x0: 0, y0: 0, x1: 399, y1: 299 },
      () => [
        { type: EntityType.RES_TOP, x: 150, y: 150 },
        { type: EntityType.BUILD_DOWN, x: 250, y: 50 },
        { type: EntityType.PLAYER, x: 50, y: 50 },
        { type: EntityType.RES_DOWN, x: 950, y: 950 }, // out of view
      ],
      0,
    );
    expect(changed).toBe(true);
    expect(at(m, 0, 0)).toBe(MemoryCell.GROUND);
    expect(at(m, 1, 1)).toBe(MemoryCell.RESOURCE);
    expect(at(m, 2, 0)).toBe(MemoryCell.STRUCTURE);
    expect(at(m, 4, 0)).toBe(MemoryCell.UNKNOWN);
    expect(at(m, 9, 9)).toBe(MemoryCell.UNKNOWN);
  });

  it('forgets a resource that is gone the next time its tile is in view', () => {
    const m = new MapMemory();
    m.resize(5, 5);
    const view = { x0: 0, y0: 0, x1: 499, y1: 499 };
    m.observe(view, () => [{ type: EntityType.RES_MID, x: 250, y: 250 }], 0);
    expect(at(m, 2, 2)).toBe(MemoryCell.RESOURCE);
    const version = m.version;
    expect(m.observe(view, () => [], 100)).toBe(false); // throttled
    m.observe(view, () => [], 300);
    expect(at(m, 2, 2)).toBe(MemoryCell.GROUND);
    expect(m.version).toBeGreaterThan(version);
  });

  it('starts over when the map is resized', () => {
    const m = new MapMemory();
    m.resize(4, 4);
    m.observe({ x0: 0, y0: 0, x1: 399, y1: 399 }, () => [], 0);
    m.resize(6, 6);
    expect(m.cells.every((c) => c === MemoryCell.UNKNOWN)).toBe(true);
    expect(m.cells.length).toBe(36);
  });
});
