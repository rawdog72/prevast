// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { ClanStore } from '../../world/clan-store';
import { EntityType } from '../../world/entity-types';
import { WorldState } from '../../world/world-state';
import { BIG_MAP_PX, bigMapLayout, bigMapPoint, MAP_MARGIN, MapWindow } from './map-window';

describe('bigMapLayout / bigMapPoint (old _BigMinimap: the world on a 410 px square, markers 10 px in)', () => {
  it('fills the square for a square map and keeps the aspect ratio otherwise', () => {
    expect(BIG_MAP_PX).toBe(410);
    expect(bigMapLayout(15000, 15000)).toEqual({ w: 410, h: 410 });
    expect(bigMapLayout(10000, 5000)).toEqual({ w: 410, h: 205 });
    expect(bigMapLayout(5000, 10000)).toEqual({ w: 205, h: 410 });
  });
  it('scales world points onto the box and clamps them to the inner band', () => {
    expect(bigMapPoint(7500, 7500, 15000, 15000)).toEqual({ x: 205, y: 205 });
    expect(bigMapPoint(0, 0, 15000, 15000)).toEqual({ x: 10, y: 10 });
    expect(bigMapPoint(15000, 15000, 15000, 15000)).toEqual({ x: 400, y: 400 });
    expect(bigMapPoint(5000, 2500, 10000, 5000)).toEqual({ x: 205, y: 102.5 });
    expect(bigMapPoint(10000, 5000, 10000, 5000)).toEqual({ x: 400, y: 195 });
  });
});

describe('MapWindow (M key: GameUI.mapGrid full map with markers)', () => {
  function setup(worldTiles = 150) {
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
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as RenderingContext,
    );
    const world = new WorldState();
    world.tilesX = worldTiles;
    world.tilesY = worldTiles;
    world.ownGuid = 1;
    world.players.set(1, { guid: 1, nickname: 'Me' } as never);
    world.players.set(2, { guid: 2, nickname: 'Mate' } as never);
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
    world.cities.push({ x: 20, y: 30 });
    world.houses.push({ x: 140, y: 10 });
    const clans = new ClanStore(world);
    clans.positions.set(2, { x: 51, y: 204 });
    const body = document.createElement('div');
    const win = new MapWindow();
    win.mount(body, { world, clans });
    return { body, win, world, clans, calls };
  }

  it('mounts one canvas sized to the map box plus the label margins', () => {
    const { body } = setup();
    const canvas = body.querySelector<HTMLCanvasElement>('canvas.dv-map-canvas')!;
    expect(canvas).not.toBeNull();
    expect(canvas.width).toBe(BIG_MAP_PX + MAP_MARGIN * 2);
    expect(canvas.height).toBe(BIG_MAP_PX + MAP_MARGIN * 2);
  });

  it('draws the grid with margins, structures at their tiles, mates with names, and us', () => {
    const { win, world, clans, calls } = setup();
    calls.length = 0;
    win.refresh({ world, clans }, true);
    const text = calls.join('\n');
    // Column letters and row numbers from mapGrid margins (8 x 8 on the default map).
    expect(text).toContain('fillText(A,');
    expect(text).toContain('fillText(H,');
    expect(text).not.toContain('fillText(I,');
    expect(text).toContain('fillText(8,');
    // City at tile (20,30) -> world (2000,3000) -> (55, 82) on the 410 box.
    // (No sprites loaded here, so it is the 6 px fallback square, drawn from its top-left.)
    const markers = calls
      .filter((c) => c.startsWith('fillRect(') && c.endsWith(',6,6)'))
      .map((c) => c.slice(9, -1).split(',').map(Number));
    expect(
      markers.some(([x, y]) => Math.abs(x + 3 - 54.7) < 1.5 && Math.abs(y + 3 - 82) < 1.5),
    ).toBe(true);
    // Clan mate at 51/255 -> 20 % -> 82 px, named.
    expect(text).toContain('fillText(Mate,');
    // Our own arrow is translated to the centre of the box.
    expect(text).toContain('translate(205,205)');
  });

  it('marks us with our own head sprite turned to our aim once it is decoded', () => {
    const { win, world, clans, calls } = setup();
    world.localPlayerAngle = Math.PI;
    const content = new ContentStore();
    const assets = {
      get: (name: string) =>
        name === 'day-skin0'
          ? { naturalWidth: 178, naturalHeight: 178, image: { name } }
          : undefined,
    } as never;
    calls.length = 0;
    win.refresh({ world, clans, assets, content }, true);
    const i = calls.findIndex((c) => c.startsWith('drawImage(_,-11,-11,22,22)'));
    expect(i).toBeGreaterThan(0);
    expect(calls.slice(i - 3, i)).toEqual(['save()', 'translate(205,205)', 'rotate(3)']);
  });

  it('marks the bad-karma player with their karma icon (WORST_KARMA_PLAYER, 14 s)', () => {
    const { win, world, clans, calls } = setup();
    world.badKarma = { guid: 9, x: 3000, y: 12000, karma: 4, remainingMs: 9000 };
    const assets = {
      get: (name: string) =>
        name.startsWith('karma')
          ? { naturalWidth: 40, naturalHeight: 40, image: { name } }
          : undefined,
    } as never;
    calls.length = 0;
    win.refresh({ world, clans, assets }, true);
    // karma index 4 -> 'karma0' (old KARMA table order), drawn 1.25x the
    // leaderboard badge (naturalWidth / 2) centred on (3000, 12000) -> (82, 328).
    const drawn = calls.filter((c) => c.startsWith('drawImage('));
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toBe('drawImage(_,70,316,25,25)');

    world.badKarma = null;
    calls.length = 0;
    win.refresh({ world, clans, assets }, true);
    expect(calls.filter((c) => c.startsWith('drawImage('))).toHaveLength(0);
  });

  it('follows a live map resize: more sectors and a re-fitted box', () => {
    const { win, world, clans, calls, body } = setup();
    world.tilesX = 300;
    world.tilesY = 100;
    calls.length = 0;
    win.refresh({ world, clans }, true);
    const text = calls.join('\n');
    expect(text).toContain('fillText(O,'); // 15 columns
    expect(text).toContain('fillText(5,'); // 5 rows
    expect(text).not.toContain('fillText(6,');
    const canvas = body.querySelector<HTMLCanvasElement>('canvas.dv-map-canvas')!;
    expect(canvas.height).toBe(Math.round(410 / 3) + MAP_MARGIN * 2);
  });
});
