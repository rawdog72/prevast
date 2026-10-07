// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { ContentStore } from '../content/store';
import type { ContentTable } from '../../../../shared/typescript/content-format';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { CharacterAnimator, hitPulse, swingDurationMs, triangleWave } from './character-animator';

function makeCreature(
  pid: number,
  state: number,
  opts: { type?: number; id?: number; x?: number; nx?: number; extra?: number } = {},
) {
  const x = opts.x ?? 0;
  return {
    pid,
    id: opts.id ?? 0,
    type: opts.type ?? EntityType.PLAYER,
    rotation: 0,
    state,
    startX: x,
    startY: 0,
    endX: opts.nx ?? x,
    endY: 0,
    extra: opts.extra ?? 0,
  };
}

const WALK = 23 << 8; // wire speed 0.23 u/ms
const SPRINT = 32 << 8;

function equipables(): ContentTable {
  return {
    name: 'equipables',
    version: 1,
    hash: 'x',
    attributes: {},
    entries: {
      hand: {
        key: 'hand',
        id: 0,
        idWeapon: 0,
        typeId: 0,
        timing: { attackDelayMs: 300 },
        client: { render: 'hand', breath: 0.05, move: 3, hitAnimMs: 150 },
      },
      hatchet: {
        key: 'hatchet',
        id: 3,
        idWeapon: 3,
        typeId: 1,
        timing: { attackDelayMs: 600 },
        client: { render: 'melee', breath: 0.02, move: 2, hitAnimMs: 350, swingAnimMs: 500 },
      },
      bow: {
        key: 'wood_bow',
        id: 6,
        idWeapon: 6,
        typeId: 4,
        timing: { shotDelayMs: 1200, impactMs: 1080 },
        client: { render: 'bow', breath: 0.5, move: 1, hitAnimMs: 100 },
      },
    },
  } as unknown as ContentTable;
}

describe('swingDurationMs', () => {
  it('prefers the client swing length, then the server attack/shot/impact delay (old client `delay`)', () => {
    expect(swingDurationMs({ swingAnimMs: 500 }, { attackDelayMs: 600 })).toBe(500);
    expect(swingDurationMs({}, { attackDelayMs: 300 })).toBe(300);
    expect(swingDurationMs({}, { shotDelayMs: 1200, impactMs: 1080 })).toBe(1200);
    expect(swingDurationMs({}, { impactMs: 850 })).toBe(850);
    expect(swingDurationMs({}, {})).toBe(300);
  });
});

describe('triangleWave', () => {
  it('rises over the first half of the period and falls over the second', () => {
    expect(triangleWave(0, 800)).toBe(0);
    expect(triangleWave(200, 800)).toBeCloseTo(0.5);
    expect(triangleWave(400, 800)).toBeCloseTo(1);
    expect(triangleWave(600, 800)).toBeCloseTo(0.5);
  });
});

describe('hitPulse', () => {
  it('fades in faintly over the first half, then pops to full and fades out while swelling 20%', () => {
    // Old client: value = t > 150 ? inQuad((300 - t) / 300) : outQuad(t / 150); scale grows as it fades.
    expect(hitPulse(300, 300)).toEqual({ alpha: 0, scale: 1 });
    expect(hitPulse(225, 300).alpha).toBeCloseTo(0.0625);
    expect(hitPulse(150, 300)).toEqual({ alpha: 1, scale: 1 });
    const late = hitPulse(75, 300);
    expect(late.alpha).toBeCloseTo(0.75);
    expect(late.scale).toBeCloseTo(1.05);
    expect(hitPulse(0, 300)).toEqual({ alpha: 0, scale: 1.2 });
  });
});

describe('CharacterAnimator', () => {
  function setup() {
    const world = new WorldState();
    const content = new ContentStore();
    content.load(equipables());
    const animator = new CharacterAnimator();
    return { world, content, animator };
  }

  it('starts a swing lasting the weapon swing duration when the attack bit rises', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK, { extra: 3 << 8 })]);
    animator.update(world, content, 16);
    const e = world.entities.get(1, 0)!;
    expect(animator.get(e)!.hit).toBe(0);

    world.entities.processUnits([makeCreature(1, 3 | WALK, { extra: 3 << 8 })]);
    animator.update(world, content, 16);
    const anim = animator.get(e)!;
    expect(anim.hitMax).toBe(500); // hatchet swingAnimMs
    expect(anim.hit).toBe(484);

    animator.update(world, content, 1000);
    expect(anim.hit).toBe(0);
  });

  it('does not miss a one-packet attack pulse that arrives and clears between two frames', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    animator.update(world, content, 16);
    // Pulse packet, then the next tick's packet without it, before any frame runs.
    world.entities.processUnits([makeCreature(1, 3 | WALK)]);
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    animator.update(world, content, 16);
    expect(animator.get(world.entities.get(1, 0)!)!.hitMax).toBe(300);
  });

  it('is edge-triggered: a held attack bit does not restart the swing', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 3 | WALK)]);
    animator.update(world, content, 16);
    world.entities.processUnits([makeCreature(1, 3 | WALK)]);
    animator.update(world, content, 16);
    expect(animator.get(world.entities.get(1, 0)!)!.hit).toBe(300 - 32);
  });

  it('alternates the punching hand between bare-hand swings', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 3 | WALK)]);
    animator.update(world, content, 16);
    const e = world.entities.get(1, 0)!;
    const first = animator.get(e)!.punch;
    animator.update(world, content, 1000); // swing over
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    animator.update(world, content, 16);
    world.entities.processUnits([makeCreature(1, 3 | WALK)]);
    animator.update(world, content, 16);
    expect(animator.get(e)!.punch).toBe(-first);
  });

  it('runs the walk cycle only while the entity is moving, flipping direction every 800ms', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK, { x: 0, nx: 400 })]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 100);
    const anim = animator.get(e)!;
    expect(anim.move).toBe(100);
    expect(anim.orientation).toBe(1);
    animator.update(world, content, 750);
    expect(anim.orientation).toBe(-1);
    expect(anim.move).toBeCloseTo(50);

    // Stops: the stride amplitude winds back to rest instead of freezing mid-stride.
    e.rx = e.x = e.nx;
    const before = triangleWave(anim.move, 800);
    animator.update(world, content, 20);
    expect(triangleWave(anim.move, 800)).toBeLessThan(before);
    animator.update(world, content, 2000);
    expect(anim.move).toBe(0);
  });

  it('runs the walk cycle 1.9x faster when sprinting (wire speed above walking pace)', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | SPRINT, { x: 0, nx: 400 })]);
    animator.update(world, content, 100);
    expect(animator.get(world.entities.get(1, 0)!)!.move).toBeCloseTo(190);
  });

  it('breathes only while idle', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 100);
    expect(animator.get(e)!.breath).toBe(100);
    world.entities.processUnits([makeCreature(1, 1 | WALK, { x: 0, nx: 400 })]);
    animator.update(world, content, 2000);
    expect(animator.get(e)!.breath).toBe(0);
  });

  it('hurt() starts a 300ms pulse toward the hit angle and heal()/eat() their own', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    animator.hurt(e, Math.PI / 2);
    animator.heal(e);
    animator.eat(e);
    const anim = animator.get(e)!;
    expect(anim.hurt).toBe(300);
    expect(anim.hurtAngle).toBe(Math.PI / 2);
    expect(anim.heal).toBe(300);
    expect(anim.food).toBe(300);
    animator.update(world, content, 100);
    expect(anim.hurt).toBe(200);
    expect(anim.heal).toBe(200);
    expect(anim.food).toBe(200);
  });

  it('starts a hurt pulse at most once a second: a spike ticking every 100 ms does not jitter the sprite', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    let pulses = 0;
    for (let t = 0; t < 2000; t += 100) {
      const before = animator.get(e)?.hurt ?? 0;
      animator.hurt(e, 0);
      if (animator.get(e)!.hurt > before) pulses++;
      animator.update(world, content, 100);
    }
    expect(pulses).toBe(2);
  });

  it('reads an agent hurt pulse off extra bit 4 with the direction in bits 5-9 (edge-triggered)', () => {
    const { world, content, animator } = setup();
    const agent = (extra: number) =>
      makeCreature(0, 1 | WALK, { type: EntityType.AI, id: 9, extra });
    world.entities.processUnits([agent(2)]);
    animator.update(world, content, 16);
    const e = world.entities.get(0, 9)!;
    expect(animator.get(e)!.hurt).toBe(0);
    world.entities.processUnits([agent(2 | 16 | (8 << 5))]);
    animator.update(world, content, 16);
    const anim = animator.get(e)!;
    expect(anim.hurt).toBe(250 - 16);
    expect(anim.hurtAngle).toBeCloseTo((Math.PI * 2 * 8) / 31);
    world.entities.processUnits([agent(2 | 16 | (8 << 5))]);
    animator.update(world, content, 16);
    expect(anim.hurt).toBe(250 - 32);
  });

  it('does not miss an agent hurt pulse that arrives and clears between two frames', () => {
    const { world, content, animator } = setup();
    const agent = (extra: number) =>
      makeCreature(0, 1 | WALK, { type: EntityType.AI, id: 9, extra });
    world.entities.processUnits([agent(2)]);
    animator.update(world, content, 16);
    world.entities.processUnits([agent(2 | 16 | (3 << 5))]);
    world.entities.processUnits([agent(2)]);
    animator.update(world, content, 16);
    const anim = animator.get(world.entities.get(0, 9)!)!;
    expect(anim.hurt).toBe(250 - 16);
    expect(anim.hurtAngle).toBeCloseTo((Math.PI * 2 * 3) / 31);
  });

  it('bobs the held consumable hand-to-mouth while the consuming bit (state & 4) is set', () => {
    const { world, content, animator } = setup();
    content.load({
      name: 'equipables',
      version: 2,
      hash: 'y',
      attributes: {},
      entries: {
        steak: {
          key: 'raw_steak',
          id: 20,
          idWeapon: 20,
          typeId: 5,
          timing: { consumeDelayMs: 1000 },
          client: { render: 'consumable', breath: 1, move: 2, consumeAnimMs: 200, recoil: 3 },
        },
      },
    } as unknown as ContentTable);
    world.entities.processUnits([makeCreature(1, 1 | 4 | WALK, { extra: 20 << 8 })]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 100);
    const anim = animator.get(e)!;
    expect(anim.consume).toBe(100);
    animator.update(world, content, 100);
    expect(anim.consume).toBe(200); // reached the mouth
    animator.update(world, content, 50);
    expect(anim.consume).toBe(150); // and back
    world.entities.processUnits([makeCreature(1, 1 | WALK, { extra: 20 << 8 })]);
    animator.update(world, content, 1000);
    expect(anim.consume).toBe(0);
  });

  it('kicks up dust puffs under a sprinting player, one every 250ms, each living 750ms', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | SPRINT, { x: 0, nx: 400 })]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    expect(animator.get(e)!.puffs).toHaveLength(1);
    animator.update(world, content, 200);
    expect(animator.get(e)!.puffs).toHaveLength(1);
    animator.update(world, content, 100);
    expect(animator.get(e)!.puffs).toHaveLength(2);
    animator.update(world, content, 2000);
    world.entities.processUnits([makeCreature(1, 1 | WALK, { x: 400, nx: 800 })]);
    animator.update(world, content, 800);
    expect(animator.get(e)!.puffs).toHaveLength(0);
  });

  it('ejects a cartridge when a gun with one fires', () => {
    const { world, content, animator } = setup();
    content.load({
      name: 'equipables',
      version: 3,
      hash: 'z',
      attributes: {},
      entries: {
        shotgun: {
          key: 'shotgun',
          id: 8,
          idWeapon: 8,
          typeId: 2,
          timing: { shotDelayMs: 900 },
          client: {
            render: 'gun',
            breath: 1,
            move: 2,
            cartridge: 'day-shotgun-cartridge',
            cartridgeDelay: 500,
          },
        },
      },
    } as unknown as ContentTable);
    world.entities.processUnits([makeCreature(1, 3 | WALK, { x: 100, extra: 8 << 8 })]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    const anim = animator.get(e)!;
    expect(anim.cartridges).toHaveLength(1);
    expect(anim.cartridges[0]!.sprite).toBe('day-shotgun-cartridge');
    // 44 units ahead along facing (angle 0), then tumbling off at up to 0.18 u/ms.
    expect(Math.abs(anim.cartridges[0]!.x - 144)).toBeLessThan(4);
    animator.update(world, content, 600);
    expect(anim.cartridges).toHaveLength(0);
  });

  it('keeps timing the death animation for a removed creature', () => {
    const { world, content, animator } = setup();
    world.entities.processUnits([makeCreature(1, 1 | WALK)]);
    const e = world.entities.get(1, 0)!;
    animator.update(world, content, 16);
    world.entities.processUnits([makeCreature(1, 0, { extra: 1 })]);
    animator.update(world, content, 100);
    expect(e.removed).toBe(true);
    expect(animator.get(e)!.death).toBe(100);
  });
});
