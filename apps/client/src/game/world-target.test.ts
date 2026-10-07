// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import { EntityType } from '../world/entity-types';
import { WorldState, newPlayerInfo } from '../world/world-state';
import { worldTargetAt } from './world-target';

function setup() {
  const world = new WorldState();
  world.ownGuid = 1;
  world.players.set(1, newPlayerInfo(1, 'Me'));
  world.players.set(2, newPlayerInfo(2, 'Bob'));
  const unit = (pid: number, id: number, type: number, x: number, y: number) => ({
    pid,
    id,
    type,
    rotation: 0,
    state: 1,
    startX: x,
    startY: y,
    endX: x,
    endY: y,
    extra: 0,
  });
  world.entities.processUnits([
    unit(1, 0, EntityType.PLAYER, 500, 500),
    unit(2, 0, EntityType.PLAYER, 750, 500),
    unit(0, 10, EntityType.BUILD_GROUND, 750, 500), // floor under Bob
    unit(0, 11, EntityType.BUILD_GROUND, 950, 500), // floor under a chest
    unit(0, 12, EntityType.BUILD_DOWN, 950, 500), // the chest
    unit(0, 13, EntityType.BUILD_TOP, 950, 700), // a plain wall
    unit(0, 14, EntityType.RES_TOP, 500, 800), // a tree
  ]);
  const camera = new Camera({ viewportWidth: 1600, viewportHeight: 1200 });
  camera.x = 750;
  camera.y = 650;
  const at = (x: number, y: number, usable: (id: number) => boolean = (id) => id === 12) => {
    const s = camera.worldToScreen(x, y);
    return worldTargetAt(world, camera, s.x, s.y, {
      isUsable: (e) => usable(e.id),
      // The chest (id 12) is a long station: 100 wide, 260 tall.
      halfSize: (e) => (e.id === 12 ? { x: 50, y: 130 } : { x: 50, y: 50 }),
    });
  };
  return { at };
}

describe('worldTargetAt', () => {
  it('puts creatures over buildings, usable pieces over floors, and finds resources last', () => {
    const { at } = setup();
    expect(at(760, 510)).toMatchObject({ kind: 'player', entity: { pid: 2 } });
    expect(at(930, 520)).toMatchObject({ kind: 'object', entity: { id: 12 } });
    // Without the chest being usable, its layer still beats the floor.
    expect(at(930, 520, () => false)).toMatchObject({ kind: 'object', entity: { id: 12 } });
    // Its far end, well off its centre tile, still picks it.
    expect(at(950, 620)).toMatchObject({ kind: 'object', entity: { id: 12 } });
    expect(at(960, 690)).toMatchObject({ kind: 'object', entity: { id: 13 } });
    expect(at(520, 790)).toMatchObject({ kind: 'resource', entity: { id: 14 } });
    // Our own body, when nobody else is there; open ground is nothing.
    expect(at(500, 500)).toMatchObject({ kind: 'player', entity: { pid: 1 } });
    expect(at(300, 300)).toBeNull();
  });
});
