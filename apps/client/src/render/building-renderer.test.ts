// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import type { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { Camera } from '../core/camera';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { BuildingAnimator } from './building-animator';
import { BuildingRenderer } from './building-renderer';

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}

interface Drawn {
  sprite: string;
  x: number;
  y: number;
  rotation: number;
  alpha: number;
  w: number;
}

/** Records drawImage calls with the translation/rotation accumulated since the last save(). */
function recordingContext() {
  const drawn: Drawn[] = [];
  const stack: { x: number; y: number; r: number }[] = [];
  let x = 0;
  let y = 0;
  let r = 0;
  let alpha = 1;
  const ctx = {
    save: () => stack.push({ x, y, r }),
    restore: () => {
      const s = stack.pop();
      if (s) ({ x, y, r } = s);
    },
    translate: (dx: number, dy: number) => {
      x += Math.cos(r) * dx - Math.sin(r) * dy;
      y += Math.sin(r) * dx + Math.cos(r) * dy;
    },
    rotate: (a: number) => {
      r += a;
    },
    scale: () => {},
    drawImage: (img: { name: string }, dx: number, dy: number, w: number, h: number) => {
      // Record the image centre in world space.
      const cx = dx + w / 2;
      const cy = dy + h / 2;
      drawn.push({
        sprite: img.name,
        x: x + Math.cos(r) * cx - Math.sin(r) * cy,
        y: y + Math.sin(r) * cx + Math.cos(r) * cy,
        rotation: r,
        alpha,
        w,
      });
    },
    set globalAlpha(v: number) {
      alpha = v;
    },
    get globalAlpha() {
      return alpha;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

const assets = {
  get: (name: string) => ({ name, naturalWidth: 200, naturalHeight: 200, image: { name } }),
  warm: () => {},
} as unknown as AssetLoader;

function setup() {
  const content = new ContentStore();
  content.load(fixture('items'));
  content.load(fixture('objects'));
  content.load(fixture('furnitures'));
  const world = new WorldState();
  const animator = new BuildingAnimator();
  const renderer = new BuildingRenderer();
  const camera = new Camera({ viewportWidth: 2000, viewportHeight: 2000 });
  camera.update(500, 500);
  return { content, world, animator, renderer, camera };
}

function itemId(content: ContentStore, key: string): number {
  return (content.byKey('items', key) as { id: number }).id;
}

let nextId = 1;
function structure(type: number, x: number, y: number, extra: number, state = 1) {
  return {
    pid: 0,
    id: nextId++,
    type,
    rotation: 0,
    state,
    startX: x,
    startY: y,
    endX: x,
    endY: y,
    extra,
  };
}

function draw(s: ReturnType<typeof setup>, layer: number) {
  const { ctx, drawn } = recordingContext();
  const rc = {
    ctx,
    assets,
    content: s.content,
    world: s.world,
    animator: s.animator,
    isNight: false,
  };
  s.renderer.beginFrame(rc, s.camera);
  s.renderer.drawLayer(rc, layer);
  return drawn;
}

describe('BuildingRenderer', () => {
  it('autotiles a row of three walls: left end, middle, right end frames', () => {
    const s = setup();
    const wall = itemId(s.content, 'wood_wall') << 7;
    s.world.entities.processUnits([
      structure(EntityType.BUILD_TOP, 150, 350, wall),
      structure(EntityType.BUILD_TOP, 250, 350, wall),
      structure(EntityType.BUILD_TOP, 350, 350, wall),
    ]);
    s.animator.update(s.world, 16);

    const names = draw(s, EntityType.BUILD_TOP).map((d) => d.sprite);
    // tileBitmaskMap: RIGHT only -> 4, LEFT|RIGHT -> 5, LEFT only -> 3
    expect(names).toEqual(['day-wood-wall4', 'day-wood-wall5', 'day-wood-wall3']);
  });

  it('does not connect walls of different materials', () => {
    const s = setup();
    s.world.entities.processUnits([
      structure(EntityType.BUILD_TOP, 150, 350, itemId(s.content, 'wood_wall') << 7),
      structure(EntityType.BUILD_TOP, 250, 350, itemId(s.content, 'stone_wall') << 7),
    ]);
    s.animator.update(s.world, 16);
    expect(draw(s, EntityType.BUILD_TOP).map((d) => d.sprite)).toEqual([
      'day-wood-wall0',
      'day-stone-wall0',
    ]);
  });

  it('draws a wall at its tile centre with its broken frame once damaged', () => {
    const s = setup();
    const wall = itemId(s.content, 'wood_wall') << 7;
    s.world.entities.processUnits([structure(EntityType.BUILD_TOP, 137, 362, wall, 1 | (2 << 14))]);
    s.animator.update(s.world, 16);
    const [d] = draw(s, EntityType.BUILD_TOP);
    expect(d!.sprite).toBe('day-wood-wall-broken1');
    expect(d!.x).toBeCloseTo(150);
    expect(d!.y).toBeCloseTo(350);
  });

  it('autotiles floors on the bottom layer', () => {
    const s = setup();
    const floor = itemId(s.content, 'wood_floor') << 7;
    s.world.entities.processUnits([
      structure(EntityType.BUILD_GROUND2, 150, 350, floor),
      structure(EntityType.BUILD_GROUND2, 150, 450, floor),
    ]);
    s.animator.update(s.world, 16);
    // DOWN only -> 1, TOP only -> 2
    expect(draw(s, EntityType.BUILD_GROUND2).map((d) => d.sprite)).toEqual([
      'day-wood-floor-1',
      'day-wood-floor-2',
    ]);
  });

  it('draws a chest rotated by its placement rotation, offset by the rotation centre', () => {
    const s = setup();
    const chest = (itemId(s.content, 'wood_chest') << 7) | (1 << 5);
    s.world.entities.processUnits([structure(EntityType.BUILD_DOWN, 250, 250, chest)]);
    s.animator.update(s.world, 16);
    const [d] = draw(s, EntityType.BUILD_DOWN);
    expect(d!.sprite).toBe('day-chest');
    expect(d!.rotation).toBeCloseTo(Math.PI / 2);
    expect(d!.x).toBeCloseTo(250);
    expect(d!.y).toBeCloseTo(250);
  });

  it('places a low wall against the edge its rotation names', () => {
    const s = setup();
    const lowWall = (itemId(s.content, 'wood_low_wall') << 7) | (1 << 5);
    s.world.entities.processUnits([structure(EntityType.BUILD_DOWN, 250, 250, lowWall)]);
    s.animator.update(s.world, 16);
    const [d] = draw(s, EntityType.BUILD_DOWN);
    // rotation 1: cx -30 -> the wall hugs the west edge of the tile
    expect(d!.sprite).toBe('day-wood-smallwalls-11');
    expect(d!.x).toBeLessThan(250);
  });

  it('swings an open door about its pivot by the content angle', () => {
    const s = setup();
    const door = itemId(s.content, 'wood_door') << 7;
    s.world.entities.processUnits([structure(EntityType.BUILD_TOP, 250, 250, door, 1 | 16)]);
    s.animator.update(s.world, 16);
    s.animator.update(s.world, 1000);
    const [d] = draw(s, EntityType.BUILD_TOP);
    expect(d!.sprite).toBe('day-wood-door1');
    expect(d!.rotation).toBeCloseTo(Math.PI);
  });

  it('draws a seed at its current growth stage', () => {
    const s = setup();
    const seed = itemId(s.content, 'orange_seed') << 7;
    s.world.entities.processUnits([structure(EntityType.BUILD_DOWN, 250, 250, seed, 1 | (3 << 4))]);
    s.animator.update(s.world, 16);
    expect(draw(s, EntityType.BUILD_DOWN)[0]!.sprite).toBe('day-plant3-orange');
  });

  it('draws the lit campfire flames on top only while it burns', () => {
    const s = setup();
    const campfire = itemId(s.content, 'campfire') << 7;
    s.world.entities.processUnits([structure(EntityType.BUILD_DOWN, 250, 250, campfire, 1 | 32)]);
    s.animator.update(s.world, 600);
    const { ctx, drawn } = recordingContext();
    const rc = {
      ctx,
      assets,
      content: s.content,
      world: s.world,
      animator: s.animator,
      isNight: false,
    };
    s.renderer.beginFrame(rc, s.camera);
    s.renderer.drawLayer(rc, EntityType.BUILD_DOWN);
    expect(drawn.map((d) => d.sprite)).toEqual(['day-campfire']);
    s.renderer.drawTops(rc);
    expect(drawn.map((d) => d.sprite)).toContain('day-campfire-light-1');
    expect(drawn.map((d) => d.sprite)).toContain('day-campfire-light-down');
  });

  it('knocks a hit building along the impact direction', () => {
    const s = setup();
    const wall = itemId(s.content, 'wood_wall') << 7;
    const rec = structure(EntityType.BUILD_TOP, 250, 250, wall);
    s.world.entities.processUnits([rec]);
    s.animator.update(s.world, 16);
    s.world.entities.processUnits([{ ...rec, state: 3 }]);
    s.animator.update(s.world, 50); // hurt = 200: peak knock of 20 along angle 0
    const [d] = draw(s, EntityType.BUILD_TOP);
    expect(d!.x).toBeCloseTo(270);
  });

  it('shrinks-and-fades a destroyed building over 300ms', () => {
    const s = setup();
    const wall = itemId(s.content, 'wood_wall') << 7;
    const rec = structure(EntityType.BUILD_TOP, 250, 250, wall);
    s.world.entities.processUnits([rec]);
    s.animator.update(s.world, 16);
    s.world.entities.processUnits([{ ...rec, state: 0, extra: 1 }]);
    s.world.entities.update(150);
    s.animator.update(s.world, 150);
    const [d] = draw(s, EntityType.BUILD_TOP);
    expect(d!.alpha).toBeLessThan(1);
    expect(d!.alpha).toBeGreaterThan(0);
    expect(d!.w).toBeGreaterThan(100);
  });

  it('fades out a retracted concealed building without popping scale', () => {
    const s = setup();
    const cable = itemId(s.content, 'cable0') << 7;
    const rec = structure(EntityType.BUILD_DOWN, 250, 250, cable);
    s.world.entities.processUnits([rec]);
    s.animator.update(s.world, 300); // fully revealed
    const [before] = draw(s, EntityType.BUILD_DOWN);
    expect(before!.alpha).toBeCloseTo(1);
    expect(before!.w).toBe(100);

    s.world.entities.processUnits([{ ...rec, state: 0, extra: 0 }]); // retraction
    s.world.entities.update(150);
    s.animator.update(s.world, 150);
    const [mid] = draw(s, EntityType.BUILD_DOWN);
    expect(mid!.alpha).toBeLessThan(1);
    expect(mid!.alpha).toBeGreaterThan(0);
    expect(mid!.w).toBe(100); // scale stays strictly 1.0 (no pop)
  });

  it('draws furniture variants by subtype', () => {
    const s = setup();
    const sofa = s.content.byKey('furnitures', 'sofa1') as { itemKey: string; subtype: number };
    const extra = itemId(s.content, sofa.itemKey) << 7;
    s.world.entities.processUnits([
      structure(EntityType.BUILD_DOWN, 250, 250, extra, 1 | (sofa.subtype << 5)),
    ]);
    s.animator.update(s.world, 16);
    expect(draw(s, EntityType.BUILD_DOWN)[0]!.sprite).toBe('day-sofa1');
  });

  describe('automatic door', () => {
    // Frames are keyed (state, index): state 0/1 = closed/open, index = break stage.
    function door(s: ReturnType<typeof setup>, state: number) {
      const extra = itemId(s.content, 'automatic_door') << 7;
      s.world.entities.processUnits([structure(EntityType.BUILD_DOWN, 250, 250, extra, state)]);
      s.animator.update(s.world, 16);
    }

    it('draws the closed frame while unpowered', () => {
      const s = setup();
      door(s, 1);
      expect(draw(s, EntityType.BUILD_DOWN).map((d) => d.sprite)).toEqual([
        'day-automatic-door-off',
      ]);
    });

    it('draws the open frame once powered, not the stage-1 broken closed one', () => {
      const s = setup();
      door(s, 1 | 128);
      s.animator.update(s.world, 600);
      expect(draw(s, EntityType.BUILD_DOWN).map((d) => d.sprite)).toEqual([
        'day-automatic-door-on',
      ]);
    });

    it('keeps the break stage on the open frame', () => {
      const s = setup();
      door(s, 1 | 128 | (2 << 14));
      s.animator.update(s.world, 600);
      expect(draw(s, EntityType.BUILD_DOWN).map((d) => d.sprite)).toEqual([
        'day-automatic-door2-on',
      ]);
    });
  });

  it('does not bounce roads when attacked', () => {
    const s = setup();
    const roadItem = itemId(s.content, 'road') << 7;
    s.world.entities.processUnits([
      structure(EntityType.BUILD_GROUND2, 150, 350, roadItem),
    ]);
    const entity = s.world.entities.getByType(EntityType.BUILD_GROUND2)[0]!;
    entity.hurtPulse = true;
    entity.hurtPulseDir = 0;
    s.animator.update(s.world, 50);

    const drawn = draw(s, EntityType.BUILD_GROUND2);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].x).toBe(150);
    expect(drawn[0].y).toBe(350);
  });
});
