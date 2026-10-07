// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { EntityType } from '../world/entity-types';
import { WorldState } from '../world/world-state';
import { EXPLOSION_FRAME_MS, EXPLOSION_FRAMES, ExplosionAnimator } from './explosions';

function blast(id: number, x = 500, y = 500) {
  return {
    pid: 0,
    id,
    type: EntityType.EXPLOSION,
    rotation: 0,
    state: 1,
    startX: x,
    startY: y,
    endX: x,
    endY: y,
    extra: 0,
  };
}

describe('ExplosionAnimator (old client _Explosions)', () => {
  it('fires onStart once per blast, steps a frame every 70 ms, and drops the entity after ten', () => {
    const world = new WorldState();
    world.entities.processUnits([blast(7)]);
    const entity = world.entities.get(0, 7)!;
    const onStart = vi.fn();
    const anim = new ExplosionAnimator();

    anim.update(world.entities, 16, onStart);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(entity);
    expect(anim.frame(entity)).toBe(0);

    anim.update(world.entities, EXPLOSION_FRAME_MS * 3, onStart);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(anim.frame(entity)).toBe(3);

    anim.update(world.entities, EXPLOSION_FRAME_MS * EXPLOSION_FRAMES, onStart);
    expect(anim.frame(entity)).toBeNull();
    // The server never retracts a transient visual: the animator drops it itself.
    expect(world.entities.get(0, 7)).toBeUndefined();
    expect(world.entities.getByType(EntityType.EXPLOSION)).toHaveLength(0);
  });

  it('a second blast reusing the same id (rotated slot) plays from frame 0 again', () => {
    const world = new WorldState();
    world.entities.processUnits([blast(7)]);
    const anim = new ExplosionAnimator();
    const onStart = vi.fn();
    anim.update(world.entities, 16, onStart);
    anim.update(world.entities, 800, onStart);
    expect(world.entities.get(0, 7)).toBeUndefined();

    world.entities.processUnits([blast(7, 900, 900)]);
    anim.update(world.entities, 16, onStart);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(anim.frame(world.entities.get(0, 7)!)).toBe(0);
  });
});
