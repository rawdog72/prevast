// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ContentStore } from '../../content/store';
import { ClanStore } from '../../world/clan-store';
import { EntityType } from '../../world/entity-types';
import { WorldState } from '../../world/world-state';
import { columnLabel, sectorGrid } from './map-grid';
import { HudMinimap, minimapView, sectorLabel, WORLD_PER_VIEW_PX } from './hud-minimap';

describe('sectorGrid (cells of about 20 tiles, 4..16 per axis, so the grid follows the map size)', () => {
  it('gives the default 150-tile map the old 8 x 8', () => {
    expect(sectorGrid(15000, 15000)).toEqual({ cols: 8, rows: 8 });
  });
  it('grows with a big map and shrinks with a small one, within bounds', () => {
    expect(sectorGrid(30000, 30000)).toEqual({ cols: 15, rows: 15 });
    expect(sectorGrid(65500, 65500)).toEqual({ cols: 16, rows: 16 });
    expect(sectorGrid(5000, 5000)).toEqual({ cols: 4, rows: 4 });
    expect(sectorGrid(3000, 3000)).toEqual({ cols: 4, rows: 4 });
  });
  it('keeps cells square in world units on a non-square map', () => {
    expect(sectorGrid(30000, 10000)).toEqual({ cols: 15, rows: 5 });
  });
});

describe('columnLabel', () => {
  it('runs A..Z then AA.. so any column count has a name', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(7)).toBe('H');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(27)).toBe('AB');
  });
});

describe('sectorLabel (GameUI mapGrid letters x numbers)', () => {
  it('labels the cell the player stands in, columns A.. and rows 1.., clamped to the grid', () => {
    expect(sectorLabel(0, 0, 15000, 15000)).toBe('A1');
    expect(sectorLabel(14999, 14999, 15000, 15000)).toBe('H8');
    expect(sectorLabel(3950, 3950, 15000, 15000)).toBe('C3');
    expect(sectorLabel(-50, 20000, 15000, 15000)).toBe('A8');
  });
  it('follows the map size: the same spot is a different cell on a bigger map', () => {
    expect(sectorLabel(3950, 3950, 30000, 30000)).toBe('B2');
    expect(sectorLabel(29000, 9000, 30000, 10000)).toBe('O5');
  });
});

describe('minimapView (old _Minimap: a fixed-span window on the world around the player)', () => {
  // The old client showed 256 of the 824 px map texture at half size on the
  // 150-tile map: 36.4 world units per view px. Keeping that world span fixed
  // means the small map is equally useful on a 50- or 655-tile map.
  const W = 15000;
  const view = { w: 134, h: 128 };

  it('centres on the player mid-map and puts the marker mid-view', () => {
    expect(WORLD_PER_VIEW_PX).toBeCloseTo(15000 / 412, 6);
    const v = minimapView(7500, 7500, W, W, view.w, view.h);
    expect(v.scale).toBeCloseTo(412 / 15000, 9);
    const me = v.toView(7500, 7500);
    expect(me.x).toBeCloseTo(67, 6);
    expect(me.y).toBeCloseTo(64, 6);
    expect(v.marker.x).toBeCloseTo(67, 6);
    expect(v.marker.y).toBeCloseTo(64, 6);
  });

  it('pins the window to the map edge in a corner so the marker moves off centre instead', () => {
    const v = minimapView(300, 300, W, W, view.w, view.h);
    expect(v.originX).toBe(0);
    expect(v.originY).toBe(0);
    const me = v.toView(300, 300);
    // 300 world = 8.24 view px; the old client kept the arrow at least 15 px in.
    expect(me.x).toBeCloseTo(8.24, 2);
    expect(v.marker).toEqual({ x: 15, y: 15 });

    const far = minimapView(W - 100, W - 100, W, W, view.w, view.h);
    expect(far.originX).toBeCloseTo(W - 134 * WORLD_PER_VIEW_PX, 6);
    expect(far.marker.x).toBeLessThanOrEqual(134 - 8);
    expect(far.marker.y).toBeLessThanOrEqual(128 - 8);
  });

  it('shows the same world distance per pixel whatever the map size (hot resizes included)', () => {
    for (const size of [5000, 15000, 30000, 65500]) {
      const v = minimapView(size / 2, size / 2, size, size, view.w, view.h);
      const a = v.toView(size / 2, size / 2);
      const b = v.toView(size / 2 + 1000, size / 2 - 500);
      expect(b.x - a.x).toBeCloseTo(1000 / WORLD_PER_VIEW_PX, 6);
      expect(a.y - b.y).toBeCloseTo(500 / WORLD_PER_VIEW_PX, 6);
    }
  });

  it('centres a map smaller than the window instead of pinning', () => {
    const v = minimapView(1000, 1000, 3000, 3000, view.w, view.h);
    const tl = v.toView(0, 0);
    const br = v.toView(3000, 3000);
    expect(tl.x).toBeCloseTo(134 - br.x, 6);
    expect(tl.y).toBeCloseTo(128 - br.y, 6);
    expect(v.marker.x).toBeCloseTo(v.toView(1000, 1000).x, 6);
  });
});

describe('HudMinimap render', () => {
  it('draws the bad-karma badge inside the frame (BAD_KARMA marker)', () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          const fmt = (a: unknown) =>
            typeof a === 'string' ? a : typeof a === 'number' ? String(Math.round(a)) : '_';
          calls.push(`${prop}(${args.map(fmt).join(',')})`);
        };
      },
      set: (target, prop: string, value) => {
        target[prop] = value;
        return true;
      },
    });
    const canvas = {
      getBoundingClientRect: () => ({ width: 134, height: 128 }),
      getContext: () => ctx,
      width: 134,
      height: 128,
    } as unknown as HTMLCanvasElement;
    const world = new WorldState();
    world.ownGuid = 1;
    world.entities.processUnits([
      {
        pid: 1,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 7500,
        startY: 7500,
        endX: 7500,
        endY: 7500,
        extra: 0,
      },
    ]);
    // Far away on the map: the badge is pinned to the frame's inset, not lost off-canvas.
    world.badKarma = { guid: 9, x: 200, y: 200, karma: 4, remainingMs: 9000 };
    const assets = {
      get: (name: string) =>
        name.startsWith('karma')
          ? { naturalWidth: 30, naturalHeight: 30, image: { name } }
          : undefined,
    } as never;

    const minimap = new HudMinimap();
    minimap.mount(canvas);
    minimap.render(world, new ClanStore(world), undefined, assets);
    const drawn = calls.filter((c) => c.startsWith('drawImage('));
    expect(drawn).toEqual(['drawImage(_,10,10,10,10)']);
  });

  it('marks us with our own head sprite turned to our aim (not an arrow) once it is decoded', () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          const fmt = (a: unknown) =>
            typeof a === 'string'
              ? a
              : typeof a === 'number'
                ? String(Math.round(a * 100) / 100)
                : ((a as { name?: string })?.name ?? '_');
          calls.push(`${prop}(${args.map(fmt).join(',')})`);
        };
      },
      set: (target, prop: string, value) => {
        target[prop] = value;
        return true;
      },
    });
    const canvas = {
      getBoundingClientRect: () => ({ width: 134, height: 128 }),
      getContext: () => ctx,
      width: 134,
      height: 128,
    } as unknown as HTMLCanvasElement;
    const world = new WorldState();
    world.ownGuid = 1;
    world.players.set(1, { guid: 1, nickname: 'Me', repellentMs: 0, withdrawalMs: 0 } as never);
    world.localPlayerAngle = Math.PI / 2;
    world.entities.processUnits([
      {
        pid: 1,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 7500,
        startY: 7500,
        endX: 7500,
        endY: 7500,
        extra: 0,
      },
    ]);
    const content = new ContentStore();
    const assets = {
      get: (name: string) =>
        name === 'day-skin0'
          ? { naturalWidth: 178, naturalHeight: 178, image: { name } }
          : undefined,
    } as never;

    const minimap = new HudMinimap();
    minimap.mount(canvas);
    minimap.render(world, new ClanStore(world), undefined, assets, content);
    const i = calls.indexOf('drawImage(day-skin0,-8,-8,16,16)');
    expect(i).toBeGreaterThan(0);
    // Mid-map: the marker is mid-view (67, 64), turned by our aim.
    expect(calls.slice(i - 3, i)).toEqual(['save()', 'translate(67,64)', 'rotate(1.57)']);
    expect(calls).not.toContain('lineTo(-4,4)'); // the arrow it replaced
  });

  it('setScale re-sizes the backing store to the region zoom so a bigger panel stays sharp, keeping the 134x128 drawing space', () => {
    const transforms: number[][] = [];
    const ctx = {
      setTransform: (...args: number[]) => transforms.push(args),
      clearRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      getContext: () => ctx,
      width: 134,
      height: 128,
    } as unknown as HTMLCanvasElement;
    const minimap = new HudMinimap();
    minimap.mount(canvas);
    expect([canvas.width, canvas.height]).toEqual([134, 128]);
    minimap.setScale(1.5);
    expect([canvas.width, canvas.height]).toEqual([201, 192]);
    expect(transforms.at(-1)).toEqual([1.5, 0, 0, 1.5, 0, 0]);
    // Same scale again: nothing to redo (re-sizing a canvas clears it).
    const n = transforms.length;
    minimap.setScale(1.5);
    expect(transforms.length).toBe(n);
    minimap.setScale(0.7);
    expect([canvas.width, canvas.height]).toEqual([94, 90]);
  });
});
