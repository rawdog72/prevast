// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import type { AssetLoader } from '../assets/asset-loader';
import { ContentStore } from '../content/store';
import { EntityType } from '../world/entity-types';
import { newPlayerInfo, WorldState } from '../world/world-state';
import { CharacterAnimator } from './character-animator';
import { CharacterRenderer } from './character-renderer';

function fixture(name: string): ContentTable {
  return JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')) as ContentTable;
}

interface Drawn {
  sprite: string;
  rotation: number;
  alpha: number;
}

/** Records every drawImage with the rotation accumulated since the last save(). */
function recordingContext() {
  const drawn: Drawn[] = [];
  const stack: number[] = [];
  let rotation = 0;
  let alpha = 1;
  const ctx = {
    save: () => stack.push(rotation),
    restore: () => {
      rotation = stack.pop() ?? 0;
    },
    translate: () => {},
    scale: () => {},
    rotate: (a: number) => {
      rotation += a;
    },
    drawImage: (img: { name: string }) => drawn.push({ sprite: img.name, rotation, alpha }),
    fillText: () => {},
    strokeText: () => {},
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
  get: (name: string) => ({ name, naturalWidth: 100, naturalHeight: 100, image: { name } }),
  warm: () => {},
} as unknown as AssetLoader;

function setup() {
  const content = new ContentStore();
  content.load(fixture('equipables'));
  content.load(fixture('agents'));
  content.load(fixture('wearables'));
  const world = new WorldState();
  world.ownGuid = 1;
  world.players.set(1, newPlayerInfo(1, 'Me'));
  const animator = new CharacterAnimator();
  const renderer = new CharacterRenderer();
  return { content, world, animator, renderer };
}

function idOf(content: ContentStore, key: string): number {
  return (content.byKey('equipables', key) as { id: number }).id;
}

function player(state: number, weapon: number, skin = 0) {
  return {
    pid: 1,
    id: 0,
    type: EntityType.PLAYER,
    rotation: 0,
    state,
    startX: 500,
    startY: 500,
    endX: 500,
    endY: 500,
    extra: state === 0 ? 1 : (weapon << 8) | skin,
  };
}

describe('CharacterRenderer', () => {
  it('draws a melee player as weapon, right arm, left arm, head (old client order)', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, idOf(content, 'hatchet'))]);
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    expect(drawn.map((d) => d.sprite)).toEqual([
      'day-hachet',
      'day-right-arm0',
      'day-left-arm0',
      'day-skin0',
    ]);
  });

  it('rotates the tool and arms through the swing and counter-turns the head', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(3, idOf(content, 'hatchet'))]);
    animator.update(world, content, 16);
    // Advance to the impact point of the hatchet swing (hitAnimMs 350 of 500).
    animator.update(world, content, 134);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    const [tool, rightArm, leftArm, head] = drawn;
    // animRotation = -inOutQuad(1) * 0.4 = -0.4; held.rotation 4, arm rotations 1.8 / 1
    // (plus a few thousandths of idle breath on the tool and arms).
    expect(tool!.rotation).toBeCloseTo(-1.6, 2);
    expect(rightArm!.rotation).toBeCloseTo(-0.72, 2);
    expect(leftArm!.rotation).toBeCloseTo(-0.4, 2);
    expect(head!.rotation).toBeCloseTo(-0.4 / 1.5, 5);
  });

  it('holds a consumable at the player angle, ignoring its own angle (old client)', () => {
    const { content, world, animator, renderer } = setup();
    // raw_steak declares held angle 1; the old consumable draw used player.angle only.
    world.entities.processUnits([player(1, idOf(content, 'raw_steak'))]);
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    const steak = drawn.find((d) => d.sprite === 'day-hand-raw-steak');
    expect(steak).toBeDefined();
    expect(steak!.rotation).toBeCloseTo(0, 5);
  });

  it('draws the hurt overlay under the head, fading per the pulse', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, 0)]);
    animator.update(world, content, 16);
    const e = world.entities.get(1, 0)!;
    animator.hurt(e, 0);
    animator.update(world, content, 150); // top of the pulse
    const { ctx, drawn } = recordingContext();

    renderer.draw({ ctx, assets, content, world, animator, isNight: false, timeMs: 0 }, e);

    const hurt = drawn.find((d) => d.sprite === 'hurt-player')!;
    expect(hurt).toBeDefined();
    expect(hurt.alpha).toBeCloseTo(1);
    expect(drawn.indexOf(hurt)).toBeLessThan(drawn.findIndex((d) => d.sprite === 'day-skin0'));
  });

  it('draws the heal and eat overlays', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, 0)]);
    animator.update(world, content, 16);
    const e = world.entities.get(1, 0)!;
    animator.heal(e);
    animator.eat(e);
    const { ctx, drawn } = recordingContext();

    renderer.draw({ ctx, assets, content, world, animator, isNight: false, timeMs: 0 }, e);

    expect(drawn.map((d) => d.sprite)).toContain('heal-player');
    expect(drawn.map((d) => d.sprite)).toContain('food-player');
  });

  it('draws the muzzle flash for the first 30ms of a gun shot', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(3, idOf(content, 'shotgun'))]);
    animator.update(world, content, 10);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    expect(drawn.map((d) => d.sprite)).toContain('day-gun-effect0');
  });

  it('layers the wearable head over the skin and swaps the arms for the wearable arms', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, 0, 3)]); // winter coat
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    const names = drawn.map((d) => d.sprite);
    expect(names).toEqual(['day-right-arm-coat', 'day-left-arm-coat', 'day-skin0', 'day-coat']);
  });

  it('keeps the clean base skin under a wearable whatever PLAYER_INFO.skin says', () => {
    // PLAYER_INFO's skin byte is the wearable skinId (3 = winter coat); the old
    // client never drew from it -- the base skin is the drug state only.
    const { content, world, animator, renderer } = setup();
    world.players.get(1)!.skin = 3;
    world.entities.processUnits([player(1, 0, 3)]);
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    expect(drawn.map((d) => d.sprite)).toEqual([
      'day-right-arm-coat',
      'day-left-arm-coat',
      'day-skin0',
      'day-coat',
    ]);
  });

  it('draws the drug skins: repellent, withdrawal, both, withdrawn (old skinType table)', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, 0)]);
    animator.update(world, content, 16);
    const info = world.players.get(1)!;
    const headAndArms = () => {
      const { ctx, drawn } = recordingContext();
      renderer.draw(
        { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
        world.entities.get(1, 0)!,
      );
      return drawn.map((d) => d.sprite);
    };

    info.repellentMs = 500;
    expect(headAndArms()).toEqual(['day-right-arm0', 'day-left-arm0', 'day-skin1']);
    info.withdrawalMs = 500;
    expect(headAndArms()).toEqual(['day-right-arm2', 'day-left-arm2', 'day-skin3']);
    info.repellentMs = 0;
    expect(headAndArms()).toEqual(['day-right-arm2', 'day-left-arm2', 'day-skin2']);
    info.withdrawalMs = 0;
    info.withdrawn = true;
    expect(headAndArms()).toEqual(['day-right-arm4', 'day-left-arm4', 'day-skin4']);
    info.repellentMs = 500;
    expect(headAndArms()).toEqual(['day-right-arm4', 'day-left-arm4', 'day-skin5']);
  });

  it('draws a dead player as a fading corpse over the death splat', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([player(1, 0)]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    world.entities.processUnits([player(0, 0)]);
    world.entities.update(500);
    animator.update(world, content, 500);
    const { ctx, drawn } = recordingContext();

    renderer.draw({ ctx, assets, content, world, animator, isNight: false, timeMs: 0 }, e);

    expect(drawn[0]!.sprite).toBe('day-dead-player');
    expect(drawn[0]!.alpha).toBeCloseTo(1);
    const head = drawn.find((d) => d.sprite === 'day-skin0')!;
    expect(head.alpha).toBe(0); // body fully faded after 400ms
  });

  it('draws an agent with its own sprites and hurt overlay', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([
      {
        pid: 0,
        id: 7,
        type: EntityType.AI,
        rotation: 0,
        state: 1,
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
        extra: 0 | 16,
      },
    ]);
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.draw(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(0, 7)!,
    );

    expect(drawn.map((d) => d.sprite)).toEqual([
      'day-ghoul-right-arm',
      'day-ghoul-left-arm',
      'ghoul-hurt',
      'day-ghoul',
    ]);
  });

  it('draws sprint dust and spent cartridges in world space', () => {
    const { content, world, animator, renderer } = setup();
    world.entities.processUnits([
      { ...player(3, idOf(content, 'shotgun')), state: 3 | (32 << 8), startX: 0, endX: 400 },
    ]);
    animator.update(world, content, 16);
    const { ctx, drawn } = recordingContext();

    renderer.drawDebris(
      { ctx, assets, content, world, animator, isNight: false, timeMs: 0 },
      world.entities.get(1, 0)!,
    );

    expect(drawn.map((d) => d.sprite)).toEqual(['day-run-effect', 'day-shotgun-cartridge']);
  });
});
