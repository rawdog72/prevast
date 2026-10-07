// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { BuildingAnimator, hurtKnock } from './building-animator';

const WALL = 27 << 7;

function building(state: number, extra = WALL, type: number = EntityType.BUILD_TOP) {
  return {
    pid: 0,
    id: 3,
    type,
    rotation: 0,
    state,
    startX: 250,
    startY: 250,
    endX: 250,
    endY: 250,
    extra,
  };
}

describe('hurtKnock', () => {
  it('jolts 20 units out along the hit direction then settles back over 250ms', () => {
    expect(hurtKnock(250)).toBe(0);
    expect(hurtKnock(200)).toBeCloseTo(20);
    expect(hurtKnock(100)).toBeCloseTo(10);
    expect(hurtKnock(0)).toBe(0);
  });
});

describe('BuildingAnimator', () => {
  function setup(state = 1, extra = WALL, type: number = EntityType.BUILD_TOP) {
    const world = new WorldState();
    world.entities.processUnits([building(state, extra, type)]);
    const animator = new BuildingAnimator();
    return { world, animator, entity: world.entities.get(0, 3)! };
  }

  it('turns a lamp off by its power bit alone, whatever colour it shows', () => {
    // Colour 2 sets bit 5 (the "working" bit other buildings use); power is bit 7.
    const colour = 2 << 4;
    const { world, animator, entity } = setup(1 | colour | 128);
    animator.update(world, 600);
    expect(animator.get(entity)!.power).toBe(500);
    world.entities.processUnits([building(1 | colour)]);
    animator.update(world, 600);
    expect(animator.get(entity)!.power).toBe(0);
  });

  it('starts a 250ms hurt knock from the latched pulse, toward the impact direction', () => {
    const { world, animator, entity } = setup();
    animator.update(world, 16);
    world.entities.processUnits([building(3, WALL | 8)]);
    animator.update(world, 16);
    const s = animator.get(entity)!;
    expect(s.hurt).toBe(250 - 16);
    expect(s.hurtAngle).toBeCloseTo((Math.PI * 2 * 8) / 31);
    expect(entity.hurtPulse).toBe(false);
  });

  it('swings a door open over 500ms when bit 4 rises and closed again when it drops', () => {
    const { world, animator, entity } = setup(1, 50 << 7);
    animator.update(world, 16);
    world.entities.processUnits([building(1 | 16, 50 << 7)]);
    animator.update(world, 250);
    const s = animator.get(entity)!;
    expect(s.open).toBe(250);
    animator.update(world, 1000);
    expect(s.open).toBe(500);
    world.entities.processUnits([building(1, 50 << 7)]);
    animator.update(world, 100);
    expect(s.open).toBe(400);
  });

  it('starts the 600ms "cannot open" flash from the latched bit 5 pulse, as the old _Door did', () => {
    const { world, animator, entity } = setup(1, 50 << 7);
    animator.update(world, 16);
    expect(animator.get(entity)!.fail).toBe(0);
    world.entities.processUnits([building(1 | 32, 50 << 7)]);
    animator.update(world, 16);
    const s = animator.get(entity)!;
    expect(s.fail).toBe(600 - 16);
    expect(entity.failPulse).toBe(false);
    // Bit 5 stays set on the entity (no further update): the flash still ends.
    animator.update(world, 1000);
    expect(s.fail).toBe(0);
  });

  it('ramps the lit clock (bit 5) to 500 and the working clock to 10000, spinning while working', () => {
    const { world, animator, entity } = setup(1 | 32);
    animator.update(world, 100);
    const s = animator.get(entity)!;
    expect(s.lit).toBe(100);
    expect(s.work).toBe(100);
    expect(s.spin).toBeGreaterThan(0);
    animator.update(world, 20000);
    expect(s.lit).toBe(500);
    expect(s.work).toBe(10000);
    world.entities.processUnits([building(1)]);
    animator.update(world, 100);
    expect(s.lit).toBe(400);
    expect(s.work).toBe(9900);
  });

  it('tracks the in-use clock (bit 4) for containers and stations', () => {
    const { world, animator, entity } = setup(1 | 16, 19 << 7);
    animator.update(world, 200);
    expect(animator.get(entity)!.use).toBe(200);
    world.entities.processUnits([building(1, 19 << 7)]);
    animator.update(world, 50);
    expect(animator.get(entity)!.use).toBe(150);
  });

  it('notices a growth stage change and times the cross-fade from it', () => {
    const { world, animator, entity } = setup(1 | (1 << 4), 40 << 7, EntityType.BUILD_DOWN);
    animator.update(world, 100);
    const s = animator.get(entity)!;
    expect(s.stage).toBe(1);
    expect(s.stageT).toBe(100);
    world.entities.processUnits([building(1 | (2 << 4), 40 << 7, EntityType.BUILD_DOWN)]);
    animator.update(world, 30);
    expect(s.stage).toBe(2);
    expect(s.stageT).toBe(30);
  });

  it('runs the death clock once the building is removed', () => {
    const { world, animator, entity } = setup();
    animator.update(world, 16);
    world.entities.processUnits([building(0, 1)]);
    animator.update(world, 120);
    expect(entity.removed).toBe(true);
    expect(animator.get(entity)!.death).toBe(120);
  });

  it('ramps down reveal when a building is retracted without running the death clock', () => {
    const { world, animator, entity } = setup();
    animator.update(world, 300);
    expect(animator.get(entity)!.reveal).toBe(300);

    world.entities.processUnits([building(0, 0)]); // retraction (extra 0)
    expect(entity.retracted).toBe(true);

    animator.update(world, 100);
    expect(animator.get(entity)!.reveal).toBe(200);
    expect(animator.get(entity)!.death).toBe(0);

    animator.update(world, 200);
    expect(animator.get(entity)!.reveal).toBe(0);
  });

  it('keeps the hurt clock ticking on resources too', () => {
    const { world, animator, entity } = setup(3, 5, EntityType.RES_TOP);
    animator.update(world, 50);
    expect(animator.get(entity)!.hurt).toBe(200);
  });
});
