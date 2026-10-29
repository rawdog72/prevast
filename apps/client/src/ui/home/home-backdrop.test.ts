// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ContentTable } from '../../../../../shared/typescript/content-format';
import type { AssetLoader } from '../../assets/asset-loader';
import { ContentStore } from '../../content/store';
import type { CanvasManager } from '../../core/canvas';
import { EntityType } from '../../world/entity-types';
import {
  BACKDROP_TILES_X,
  BACKDROP_TILES_Y,
  CAMP,
  HomeBackdrop,
  backdropNight,
  backdropPlacements,
  backdropRecords,
  backdropSprites,
  driftAt,
  scatterForest,
  seededRandom,
} from './home-backdrop';

function content(): ContentStore {
  const store = new ContentStore();
  const dir = path.resolve(process.cwd(), 'tests/fixtures/content');
  for (const name of ['items', 'objects', 'furnitures', 'resources']) {
    store.load(JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as ContentTable);
  }
  return store;
}

describe('home backdrop scene', () => {
  it('scatters the same forest every time, inside the world', () => {
    expect(scatterForest()).toEqual(scatterForest());
    const forest = scatterForest();
    expect(forest.length).toBeGreaterThan(200);
    for (const p of forest) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(BACKDROP_TILES_X * 100);
      expect(p.y).toBeLessThan(BACKDROP_TILES_Y * 100);
    }
  });

  it('keeps the trees out of the camp', () => {
    for (const p of scatterForest()) {
      if (p.ref !== 'leaf_tree' && p.ref !== 'wood') continue;
      expect(Math.hypot(p.x - CAMP.x, p.y - CAMP.y)).toBeGreaterThan(250);
    }
  });

  it('seededRandom is deterministic and in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('encodes the camp like the server: a burning firepit, a workbench, trees', () => {
    const store = content();
    const placements = backdropPlacements();
    const records = backdropRecords(placements, store);
    expect(records.length).toBe(placements.length);
    const firepitItem = store.byKey('items', 'firepit')!.id;
    const workbenchItem = store.byKey('items', 'workbench')!.id;
    const fire = records.find(
      (r) => r.type === EntityType.BUILD_DOWN && ((r.extra >> 7) & 0x1ff) === firepitItem,
    );
    expect(fire).toBeDefined();
    expect(fire!.state & 32).toBe(32);
    expect(records.some((r) => ((r.extra >> 7) & 0x1ff) === workbenchItem)).toBe(true);
    expect(records.some((r) => r.type === EntityType.RES_STOP)).toBe(true); // leafy trees
    expect(records.some((r) => r.type === EntityType.RES_TOP)).toBe(true); // pines
  });

  it('lists the sprites it draws, fire light included, without blueprints', () => {
    const names = backdropSprites(backdropPlacements(), content());
    expect(names.has('day-campfire-bbq')).toBe(true);
    expect(names.has('day-workbench')).toBe(true);
    expect(names.has('day-campfire-light-down')).toBe(true);
    expect([...names].some((n) => n.includes('clear-blue') || n.includes('redprint'))).toBe(false);
  });

  it('is night from 19:00 to 07:00 unless the address says otherwise', () => {
    const at = (h: number) => new Date(2026, 9, 28, h, 0, 0);
    expect(backdropNight(at(12))).toBe(0);
    expect(backdropNight(at(23))).toBe(1);
    expect(backdropNight(at(3))).toBe(1);
    expect(backdropNight(at(3), '?home=day')).toBe(0);
    expect(backdropNight(at(12), '?home=night')).toBe(1);
  });

  it('frames the camp right of the start window on wide screens only', () => {
    expect(driftAt(0, 1800, 1920).x).toBeLessThan(CAMP.x - 300);
    expect(Math.abs(driftAt(0, 600, 390).x - CAMP.x)).toBeLessThan(160);
  });
});

describe('HomeBackdrop', () => {
  function fakeWindow() {
    let next = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const win = {
      document: { hidden: false },
      location: { search: '?home=day' },
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb: FrameRequestCallback) => (frames.set(next, cb), next++),
      cancelAnimationFrame: (id: number) => frames.delete(id),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: (cb: () => void) => (cb(), 0),
    };
    const step = (now: number) => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(now);
    };
    return { win: win as unknown as Window, frames, step };
  }

  function canvas() {
    const ctx = {
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      canvas: { width: 1280, height: 800 },
    } as unknown as CanvasRenderingContext2D;
    return {
      ctx,
      width: 1280,
      height: 800,
      pixelRatio: 1,
      resolutionDivisor: 1,
    } as unknown as CanvasManager;
  }

  const assets = {
    preloadCore: vi.fn(() => new Promise<void>(() => {})),
    resolveSpriteName: (n: string) => n,
  } as unknown as AssetLoader;

  it('waits for content, then stops drawing when stopped', () => {
    const { win, frames, step } = fakeWindow();
    const c = canvas();
    const backdrop = new HomeBackdrop({ canvas: c, content: content(), assets, win });
    backdrop.start();
    step(100);
    // No content yet: a plain dark frame, no sprite requests.
    expect(c.ctx.fillRect).toHaveBeenCalled();
    expect(assets.preloadCore).not.toHaveBeenCalled();
    backdrop.stop();
    expect(frames.size).toBe(0);
    expect(backdrop.isRunning).toBe(false);
    expect(win.removeEventListener).toHaveBeenCalledWith('pointermove', expect.any(Function));
  });

  it('asks for its sprites once the content is in', () => {
    const { win, step } = fakeWindow();
    const backdrop = new HomeBackdrop({ canvas: canvas(), content: content(), assets, win });
    backdrop.setContentReady();
    backdrop.start();
    try {
      step(100);
    } catch {
      // The stub context cannot really draw; only the sprite request matters here.
    }
    expect(assets.preloadCore).toHaveBeenCalledTimes(1);
    backdrop.stop();
  });

  it('puts a survivor by the fire, wearing the chosen skin and the typed name', () => {
    const { win, step } = fakeWindow();
    const backdrop = new HomeBackdrop({ canvas: canvas(), content: content(), assets, win });
    backdrop.setContentReady();
    backdrop.setSurvivorSkin(3);
    backdrop.start();
    try {
      step(100);
    } catch {
      // The stub context cannot really draw.
    }
    const world = (backdrop as unknown as { world: import('../../world/world-state').WorldState })
      .world;
    const survivor = world.entities.getByType(EntityType.PLAYER)[0]!;
    expect(Math.hypot(survivor.x - CAMP.x, survivor.y - CAMP.y)).toBeLessThan(200);
    // A skin chosen before the scene existed is worn once it does; a later change shows at once.
    expect(survivor.extra & 255).toBe(3);
    backdrop.setSurvivorSkin(5);
    expect(world.entities.getByType(EntityType.PLAYER)[0]!.extra & 255).toBe(5);
    expect(world.players.get(survivor.pid)?.nickname).toBe('');
    backdrop.setSurvivorName('Ada', true);
    expect(world.players.get(survivor.pid)).toMatchObject({ nickname: 'Ada', verified: true });
    backdrop.setSurvivorName('');
    expect(world.players.get(survivor.pid)).toMatchObject({ nickname: '', verified: false });
    backdrop.stop();
  });

  it('leave() resolves straight away when not drawing', async () => {
    const { win } = fakeWindow();
    const backdrop = new HomeBackdrop({ canvas: canvas(), content: content(), assets, win });
    await expect(backdrop.leave()).resolves.toBeUndefined();
  });

  it('draws nothing while the tab is hidden', () => {
    const { win, step } = fakeWindow();
    (win.document as { hidden: boolean }).hidden = true;
    const c = canvas();
    const backdrop = new HomeBackdrop({ canvas: c, content: content(), assets, win });
    backdrop.start();
    step(100);
    expect(c.ctx.fillRect).not.toHaveBeenCalled();
    backdrop.stop();
  });
});
