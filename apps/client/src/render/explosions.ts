// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/explosions.ts
// The old client's _Explosions: an EXPLOSION entity (type 12) is a transient
// visual the server broadcasts once and never retracts (definitions.h
// isTransientVisualType). The client plays day-explosion0..9 at 70 ms a frame
// -- shaking the screen and playing the blast on the first -- and then the
// entity is simply gone. Nothing else may keep it: a blast that stayed in the
// store drew its last frame forever.

import type { EntityStore } from '../world/entity-store';
import { EntityType, type WorldEntity } from '../world/entity-types';

export const EXPLOSION_FRAMES = 10;
export const EXPLOSION_FRAME_MS = 70;
const LIFE_MS = EXPLOSION_FRAMES * EXPLOSION_FRAME_MS;

export class ExplosionAnimator {
  private readonly ages = new WeakMap<WorldEntity, number>();

  /** Advances every blast; `onStart` fires the first time one is seen. */
  update(store: EntityStore, deltaMs: number, onStart?: (entity: WorldEntity) => void): void {
    const blasts = store.getByType(EntityType.EXPLOSION);
    for (const entity of blasts) {
      if (entity.removed) continue;
      let age = this.ages.get(entity);
      if (age === undefined) {
        age = 0;
        this.ages.set(entity, 0);
        onStart?.(entity);
        continue;
      }
      age += deltaMs;
      if (age >= LIFE_MS) {
        this.ages.delete(entity);
        store.remove(entity.pid, entity.id, entity.type);
      } else {
        this.ages.set(entity, age);
      }
    }
  }

  /** Sprite frame index for this blast, or null once it has played out. */
  frame(entity: WorldEntity): number | null {
    const age = this.ages.get(entity);
    if (age === undefined) return null;
    const frame = Math.floor(age / EXPLOSION_FRAME_MS);
    return frame < EXPLOSION_FRAMES ? frame : null;
  }
}
