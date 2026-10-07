// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TABLES, type ContentTable } from '../../../../shared/typescript/content-format';
import { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { EntityType } from '../world/entity-types';
import { newPlayerInfo, WorldState } from '../world/world-state';
import { BuildingAnimator } from './building-animator';
import { CharacterAnimator } from './character-animator';
import { EXPLOSION_FRAME_MS, ExplosionAnimator } from './explosions';
import { GameRenderer } from './renderer';

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}

function createMockContext(): {
  ctx: CanvasRenderingContext2D;
  calls: { saves: number; restores: number; images: number; rects: number };
} {
  const calls = { saves: 0, restores: 0, images: 0, rects: 0 };
  const ctx: Partial<CanvasRenderingContext2D> = {
    save: () => {
      calls.saves++;
    },
    restore: () => {
      calls.restores++;
    },
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillRect: () => {
      calls.rects++;
    },
    strokeRect: () => {
      calls.rects++;
    },
    fillText: () => {},
    strokeText: () => {},
    drawImage: () => {
      calls.images++;
    },
    createRadialGradient: () =>
      ({
        addColorStop: () => {},
      }) as unknown as CanvasGradient,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('GameRenderer', () => {
  it('renders world layers with balanced transforms and zero world mutation', () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));

    const world = new WorldState();
    world.ownGuid = 1;
    world.entities.processUnits([
      {
        pid: 1,
        id: 0,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 500,
        endX: 500,
        endY: 500,
        extra: 0,
      },
      {
        pid: 0,
        id: 2,
        type: EntityType.RES_TOP,
        rotation: 0,
        state: 1,
        startX: 550,
        startY: 550,
        endX: 550,
        endY: 550,
        extra: 0, // wood
      },
    ]);

    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);

    const assets = new AssetLoader();
    const renderer = new GameRenderer();
    const { ctx, calls } = createMockContext();

    const entityCountBefore = world.entities.count;
    const phaseBefore = world.clock.phaseMs;

    // Render frame
    renderer.render({ ctx, camera, world, content: store, assets });

    // Assert balanced save/restore
    expect(calls.saves).toBeGreaterThan(0);
    expect(calls.saves).toBe(calls.restores);

    // Assert drawn background
    expect(calls.rects).toBeGreaterThan(0);

    // Assert ZERO world mutation
    expect(world.entities.count).toBe(entityCountBefore);
    expect(world.clock.phaseMs).toBe(phaseBefore);
  });

  async function loadedAssets(names: string[]): Promise<AssetLoader> {
    const assets = new AssetLoader({
      decoder: {
        decode: async (url) => ({
          image: { url } as unknown as CanvasImageSource,
          width: 200,
          height: 200,
        }),
      },
    });
    await Promise.all(names.map((n) => assets.load(n)));
    return assets;
  }

  function drawnImages(ctx: Partial<CanvasRenderingContext2D>) {
    const draws: { url: string; w: number; h: number }[] = [];
    ctx.drawImage = ((img: { url: string }, _x: number, _y: number, w: number, h: number) => {
      draws.push({ url: img.url, w, h });
    }) as unknown as CanvasRenderingContext2D['drawImage'];
    return draws;
  }

  it('draws a tree top (client.type[].spriteTop) over the trunk, breathing on its own beat', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const leaftree = store.byKey('resources', 'leaf_tree')!;
    const world = new WorldState();
    world.entities.processUnits([
      {
        pid: 0,
        id: 2,
        type: EntityType.RES_STOP,
        rotation: 0,
        state: 1,
        startX: 550,
        startY: 550,
        endX: 550,
        endY: 550,
        extra: leaftree.id << 5, // type 0
      },
    ]);
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets(['day-tree0', 'day-treeleaf0']);
    const animator = new BuildingAnimator();
    animator.update(world, 16);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    new GameRenderer().render({
      ctx,
      camera,
      world,
      content: store,
      assets,
      buildingAnimator: animator,
    });

    const trunk = draws.findIndex((d) => d.url.includes('day-tree0'));
    const leaf = draws.findIndex((d) => d.url.includes('day-treeleaf0'));
    expect(trunk).toBeGreaterThanOrEqual(0);
    expect(leaf).toBeGreaterThan(trunk);
    // Natural 200 px sprite draws at 100 world units; the top is scaled by the breath (1.0..1.025).
    expect(draws[trunk].w).toBeCloseTo(100, 6);
    expect(draws[leaf].w).toBeGreaterThanOrEqual(100);
    expect(draws[leaf].w).toBeLessThanOrEqual(102.5);
  });

  it('pulses loot between 95 % and 105 % of its size over time', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const wood = store.byKey('items', 'wood')!;
    const world = new WorldState();
    world.entities.processUnits([
      {
        pid: 0,
        id: 5,
        type: EntityType.LOOT,
        rotation: 0,
        state: 1,
        startX: 520,
        startY: 520,
        endX: 520,
        endY: 520,
        extra: wood.id,
      },
    ]);
    const sprite = store.lootById(wood.id)!.sprite;
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets([sprite]);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    const renderer = new GameRenderer();
    const widths = new Set<number>();
    for (const timeMs of [0, 375, 750, 1125]) {
      draws.length = 0;
      renderer.render({ ctx, camera, world, content: store, assets, timeMs });
      const d = draws.find((x) => x.url.includes(sprite))!;
      expect(d.w).toBeGreaterThanOrEqual(95);
      expect(d.w).toBeLessThanOrEqual(105);
      widths.add(Math.round(d.w * 100));
    }
    expect(widths.size).toBeGreaterThan(1);
  });

  it('draws a blast as its current explosion frame and nothing once it has played out', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const world = new WorldState();
    world.entities.processUnits([
      {
        pid: 0,
        id: 9,
        type: EntityType.EXPLOSION,
        rotation: 0,
        state: 1,
        startX: 520,
        startY: 520,
        endX: 520,
        endY: 520,
        extra: 0,
      },
    ]);
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets(['day-explosion0', 'day-explosion3']);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    const renderer = new GameRenderer();
    const explosions = new ExplosionAnimator();

    // Not started: without the animator's frame there is nothing to draw.
    renderer.render({ ctx, camera, world, content: store, assets });
    expect(draws.some((d) => d.url.includes('explosion'))).toBe(false);

    explosions.update(world.entities, 16);
    renderer.render({ ctx, camera, world, content: store, assets, explosions });
    expect(draws.some((d) => d.url.includes('day-explosion0'))).toBe(true);

    explosions.update(world.entities, EXPLOSION_FRAME_MS * 3);
    draws.length = 0;
    renderer.render({ ctx, camera, world, content: store, assets, explosions });
    expect(draws.some((d) => d.url.includes('day-explosion3'))).toBe(true);

    explosions.update(world.entities, 1000);
    draws.length = 0;
    renderer.render({ ctx, camera, world, content: store, assets, explosions });
    expect(draws.some((d) => d.url.includes('explosion'))).toBe(false);
  });

  it('shrinks a pickup as it flies into its taker, and shrinks it further while it fades out', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const wood = store.byKey('items', 'wood')!;
    const world = new WorldState();
    world.ownGuid = 1;
    const player = {
      pid: 1,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0,
      state: 1,
      startX: 500,
      startY: 500,
      endX: 500,
      endY: 500,
      extra: 0,
    };
    const loot = (state: number) => ({
      pid: 0,
      id: 5,
      type: EntityType.LOOT,
      rotation: 0,
      state,
      startX: 700,
      startY: 500,
      endX: 700,
      endY: 500,
      extra: wood.id,
    });
    const sprite = store.lootById(wood.id)!.sprite;
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets([sprite]);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    const renderer = new GameRenderer();
    const width = () => {
      draws.length = 0;
      renderer.render({ ctx, camera, world, content: store, assets, timeMs: 0 });
      return draws.find((x) => x.url.includes(sprite))!.w;
    };

    // Lying 200 units from us, untaken: full size (give or take the pulse).
    world.entities.processUnits([player, loot(1)]);
    const resting = width();
    expect(resting).toBeGreaterThanOrEqual(95);

    // Taken by us (pid 1): flying, and smaller the closer it gets.
    world.entities.processUnits([loot((1 << 8) | 1)]);
    const far = width();
    for (let i = 0; i < 20; i++) world.update(16);
    const near = width();
    expect(far).toBeLessThanOrEqual(resting);
    expect(near).toBeLessThan(far);
    expect(near).toBeGreaterThan(40);

    // Removed: keeps shrinking through the fade (old _Loots: scale - death/2400).
    world.entities.processUnits([loot(0)]);
    world.update(400);
    const fading = width();
    expect(fading).toBeLessThan(near);
    expect(draws.find((x) => x.url.includes(sprite))).toBeDefined();
  });

  it('draws nameplates after tree tops and walls, as the old client did', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const leaftree = store.byKey('resources', 'leaf_tree')!;
    const wall = store.byKey('items', 'wood_wall')!;
    const world = new WorldState();
    world.ownGuid = 1;
    world.players.set(1, newPlayerInfo(1, 'Me'));
    const at = (x: number) => ({
      startX: x,
      startY: 500,
      endX: x,
      endY: 500,
      rotation: 0,
      state: 1,
    });
    world.entities.processUnits([
      { pid: 1, id: 0, type: EntityType.PLAYER, extra: 0, ...at(500) },
      { pid: 0, id: 2, type: EntityType.RES_STOP, extra: leaftree.id << 5, ...at(560) },
      { pid: 0, id: 3, type: EntityType.BUILD_TOP, extra: wall.id << 7, ...at(450) },
    ]);
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets([
      'day-tree0',
      'day-treeleaf0',
      'day-wood-wall0',
      'day-skin0',
    ]);
    const buildings = new BuildingAnimator();
    buildings.update(world, 16);
    const characters = new CharacterAnimator();
    characters.update(world, store, 16);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    // Labels are rasterised on canvases from this factory; tag them so the order is visible.
    const labelCanvas = () => {
      const canvas = { width: 0, height: 0, url: 'nameplate' } as unknown as HTMLCanvasElement;
      canvas.getContext = (() => ({
        measureText: (t: string) => ({ width: t.length * 20 }),
        strokeText: () => {},
        fillText: () => {},
      })) as unknown as HTMLCanvasElement['getContext'];
      return canvas;
    };
    new GameRenderer({ createCanvas: labelCanvas }).render({
      ctx,
      camera,
      world,
      content: store,
      assets,
      buildingAnimator: buildings,
      animator: characters,
    });

    const plate = draws.findIndex((d) => d.url === 'nameplate');
    const leaf = draws.findIndex((d) => d.url.includes('day-treeleaf0'));
    const wallDraw = draws.findIndex((d) => d.url.includes('day-wood-wall0'));
    const head = draws.findIndex((d) => d.url.includes('day-skin0'));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(plate).toBeGreaterThan(leaf);
    expect(plate).toBeGreaterThan(wallDraw);
    expect(plate).toBeGreaterThan(head);
  });

  it('draws the correct projectile sprite in flight and on landing', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const world = new WorldState();
    world.ownGuid = 1;

    // Spear projectile (extra = 4):
    // In flight: distance to (endX, endY) >= 20 (fastDist >= 400)
    world.entities.processUnits([
      {
        pid: 0,
        id: 10,
        type: EntityType.BULLET,
        rotation: 0,
        state: 1,
        startX: 500,
        startY: 500,
        endX: 700,
        endY: 500,
        extra: 4, // spear
      },
    ]);

    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
    camera.update(500, 500);
    const assets = await loadedAssets(['day-wood-spear0', 'day-wood-spear1', 'day-wood-spearl']);
    const { ctx } = createMockContext();
    const draws = drawnImages(ctx);
    const renderer = new GameRenderer();

    // 1. In flight: should draw frame 0 (day-wood-spear0)
    renderer.render({ ctx, camera, world, content: store, assets });
    expect(draws.some((d) => d.url.includes('day-wood-spear0'))).toBe(true);
    expect(draws.some((d) => d.url.includes('day-bullet1'))).toBe(false);

    // 2. Landed: move entity close to end position
    const spear = world.entities.get(0, 10)!;
    spear.x = 700;
    spear.y = 500;
    spear.rx = 700;
    spear.ry = 500;
    draws.length = 0;
    renderer.render({ ctx, camera, world, content: store, assets });
    expect(draws.some((d) => d.url.includes('day-wood-spear1'))).toBe(true);
    expect(draws.some((d) => d.url.includes('day-wood-spearl'))).toBe(true);
  });
});

/**
 * A context that keeps the state save/restore really scopes, and logs every
 * fill and image as `fill <op> <style>` / `image <alpha> <url>` in draw order.
 */
function recordingContext(log: string[], canvas?: { width: number; height: number }) {
  const state = { fillStyle: '' as unknown, globalCompositeOperation: 'source-over', globalAlpha: 1 };
  const stack: (typeof state)[] = [];
  const transforms: unknown[] = [];
  const ctx = {
    canvas,
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: unknown) {
      state.fillStyle = v;
    },
    get globalCompositeOperation() {
      return state.globalCompositeOperation;
    },
    set globalCompositeOperation(v: string) {
      state.globalCompositeOperation = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    strokeStyle: '',
    lineWidth: 1,
    save: () => void stack.push({ ...state }),
    restore: () => void Object.assign(state, stack.pop()),
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    fillRect: () => void log.push(`fill ${state.globalCompositeOperation} ${String(state.fillStyle)}`),
    strokeRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    drawImage: (img: { url?: string }) => void log.push(`image ${state.globalAlpha} ${img.url ?? ''}`),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    getTransform: () => 'main-matrix',
    setTransform: (...m: unknown[]) => void transforms.push(m.length === 1 ? m[0] : m.join(',')),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, transforms };
}

describe('GameRenderer day / night look', () => {
  const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
  camera.update(500, 500);
  const render = (renderer: GameRenderer, ctx: CanvasRenderingContext2D, night?: number, world = new WorldState()) =>
    renderer.render({ ctx, camera, world, content: new ContentStore(), assets: new AssetLoader(), night });

  /** A canvas factory whose canvases record into `log` and are tagged `night-layer`. */
  function layers(log: string[]) {
    const made: { canvas: HTMLCanvasElement & { url: string }; transforms: unknown[] }[] = [];
    const createCanvas = () => {
      const recorded = recordingContext(log);
      const canvas = { width: 0, height: 0, url: 'night-layer', getContext: () => recorded.ctx } as unknown as HTMLCanvasElement & {
        url: string;
      };
      made.push({ canvas, transforms: recorded.transforms });
      return canvas;
    };
    return { createCanvas, made };
  }

  it('cross-fades the night palette over the day palette at the night opacity, untinted', () => {
    const layerLog: string[] = [];
    const { createCanvas, made } = layers(layerLog);
    const log: string[] = [];
    const { ctx, transforms } = recordingContext(log, { width: 1600, height: 1200 });
    render(new GameRenderer({ createCanvas }), ctx, 0.25);

    // The day pass on the screen...
    expect(log[0]).toBe(`fill source-over ${GameRenderer.OUTSIDE_DAY_BG}`);
    expect(log).toContain(`fill source-over ${GameRenderer.DAY_BG}`);
    // ...the night pass on a screen-sized layer with the screen's transform...
    expect(made).toHaveLength(1);
    expect(made[0]!.canvas).toMatchObject({ width: 1600, height: 1200 });
    expect(made[0]!.transforms).toContain('main-matrix');
    expect(layerLog[0]).toBe(`fill source-over ${GameRenderer.OUTSIDE_NIGHT_BG}`);
    expect(layerLog).toContain(`fill source-over ${GameRenderer.NIGHT_BG}`);
    // ...laid over it, untransformed, at the night opacity. Nothing is tinted:
    // a tint would also change the lamp and fire glows, which are the same
    // art in both palettes.
    expect(log).toContain('image 0.25 night-layer');
    expect(transforms).toContain('1,0,0,1,0,0');
    expect([...log, ...layerLog].some((l) => l.startsWith('fill multiply'))).toBe(false);
  });

  it('draws nameplates over the night layer, once', async () => {
    const store = new ContentStore();
    for (const name of CONTENT_TABLES) store.load(fixture(name));
    const world = new WorldState();
    world.ownGuid = 1;
    world.players.set(1, newPlayerInfo(1, 'Me'));
    world.entities.processUnits([
      { pid: 1, id: 0, type: EntityType.PLAYER, extra: 0, startX: 500, startY: 500, endX: 500, endY: 500, rotation: 0, state: 1 },
    ]);
    const characters = new CharacterAnimator();
    characters.update(world, store, 16);
    // Labels and the night layer both come from the factory: label canvases
    // measure text, the layer is told apart by being drawn at the blend opacity.
    const createCanvas = () => {
      const recorded = recordingContext([]);
      const canvas = { width: 0, height: 0, url: 'canvas', getContext: () => ({
        ...recorded.ctx,
        measureText: (t: string) => ({ width: t.length * 20 }),
        strokeText: () => {},
        fillText: () => {},
        setTransform: () => {},
        fillRect: () => {},
      }) } as unknown as HTMLCanvasElement;
      return canvas;
    };
    const log: string[] = [];
    const { ctx } = recordingContext(log, { width: 800, height: 600 });
    new GameRenderer({ createCanvas }).render({
      ctx,
      camera,
      world,
      content: store,
      assets: new AssetLoader(),
      animator: characters,
      night: 0.5,
    });
    const layer = log.indexOf('image 0.5 canvas');
    const plates = log.filter((l) => l === 'image 1 canvas');
    expect(layer).toBeGreaterThanOrEqual(0);
    expect(plates).toHaveLength(1);
    expect(log.indexOf('image 1 canvas')).toBeGreaterThan(layer);
  });

  it('draws one palette straight to the screen outside the fade, and frees the layer', () => {
    const { createCanvas, made } = layers([]);
    const renderer = new GameRenderer({ createCanvas });
    const log: string[] = [];
    const { ctx } = recordingContext(log, { width: 1600, height: 1200 });

    render(renderer, ctx, 1);
    expect(log[0]).toBe(`fill source-over ${GameRenderer.OUTSIDE_NIGHT_BG}`);
    expect(made).toHaveLength(0);

    render(renderer, ctx, 0.5);
    expect(made[0]!.canvas.width).toBe(1600);
    log.length = 0;
    render(renderer, ctx, 0);
    expect(log[0]).toBe(`fill source-over ${GameRenderer.OUTSIDE_DAY_BG}`);
    expect(log.some((l) => l.endsWith('night-layer'))).toBe(false);
    expect(made[0]!.canvas.width).toBe(0);
  });

  it("without a night value, follows the clock's half -- the editor's fixed day / night", () => {
    const log: string[] = [];
    const { ctx } = recordingContext(log);
    const world = new WorldState();
    world.clock.isNight = true;
    render(new GameRenderer(), ctx, undefined, world);
    expect(log).toContain(`fill source-over ${GameRenderer.NIGHT_BG}`);
  });
});
