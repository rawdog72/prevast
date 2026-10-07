// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import type { UnitRecord } from '../net/events';
import { EntityStore, isLootFlying } from './entity-store';
import { EntityType } from './entity-types';

describe('EntityStore', () => {
  it('indexes world entities (pid=0) and player entities (pid>0) correctly', () => {
    const store = new EntityStore(100);

    const recordWorld: UnitRecord = {
      pid: 0,
      id: 42,
      type: EntityType.RES_TOP,
      rotation: 0,
      state: 1,
      startX: 500,
      startY: 500,
      endX: 500,
      endY: 500,
      extra: 0,
    };

    const recordPlayer: UnitRecord = {
      pid: 2,
      id: 5,
      type: EntityType.PLAYER,
      rotation: 128,
      state: 1,
      startX: 100,
      startY: 200,
      endX: 150,
      endY: 200,
      extra: 0,
    };

    store.processUnits([recordWorld, recordPlayer]);

    expect(store.count).toBe(2);
    expect(store.get(0, 42)?.type).toBe(EntityType.RES_TOP);
    expect(store.get(2, 5)?.type).toBe(EntityType.PLAYER);
    expect(store.getByType(EntityType.RES_TOP)).toHaveLength(1);
    expect(store.getByType(EntityType.PLAYER)).toHaveLength(1);
  });

  it('re-indexes playerCache when unitsPerPlayer changes', () => {
    const store = new EntityStore(50);
    store.processUnits([
      {
        pid: 3,
        id: 10,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
        extra: 0,
      },
    ]);

    expect(store.get(3, 10)).toBeDefined();
    store.setUnitsPerPlayer(150);
    expect(store.get(3, 10)).toBeDefined();
  });

  it('removes entities when state is 0', () => {
    const store = new EntityStore();
    store.processUnits([
      {
        pid: 1,
        id: 1,
        type: EntityType.LOOT,
        rotation: 0,
        state: 1,
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
        extra: 0,
      },
    ]);
    expect(store.count).toBe(1);

    // State 0 = remove
    store.processUnits([
      {
        pid: 1,
        id: 1,
        type: EntityType.LOOT,
        rotation: 0,
        state: 0,
        startX: 0,
        startY: 0,
        endX: 0,
        endY: 0,
        extra: 0,
      },
    ]);
    expect(store.count).toBe(0);
    expect(store.get(1, 1)).toBeUndefined();
  });

  it('interpolates positions during update ticks', () => {
    const store = new EntityStore();
    store.processUnits([
      {
        pid: 1,
        id: 1,
        type: EntityType.PLAYER,
        rotation: 0,
        state: 1,
        startX: 100,
        startY: 100,
        endX: 200,
        endY: 100,
        extra: 0,
      },
    ]);

    const entity = store.get(1, 1)!;
    expect(entity.x).toBe(100);
    expect(entity.rx).toBe(100);

    // Advance 500ms
    store.update(500);

    expect(entity.rx).toBeGreaterThan(100);
    expect(entity.x).toBeGreaterThan(100);
  });

  describe('dead reckoning', () => {
    const FRAME = 1000 / 60;
    const TICK = 50; // server movement tick (MOVEMENT_TICK_MS)

    const creature = (
      type: number,
      wireSpeed: number,
      startX: number,
      endX: number,
      y = 1000,
    ): UnitRecord => ({
      pid: 1,
      id: 0,
      type,
      rotation: 0,
      state: (wireSpeed << 8) | 1,
      startX,
      startY: y,
      endX,
      endY: y,
      extra: 0,
    });

    /** Walks a player right for `ticks` server ticks of `step` units, rendering at 60 fps. */
    const walk = (store: EntityStore, wireSpeed: number, step: number, ticks: number) => {
      let x = 1000;
      store.processUnits([creature(EntityType.PLAYER, wireSpeed, x, x + step)]);
      x += step;
      for (let t = 0; t < ticks; t++) {
        for (let f = 0; f < TICK / FRAME; f++) store.update(FRAME);
        store.processUnits([creature(EntityType.PLAYER, wireSpeed, x, x + step)]);
        x += step;
      }
      return x;
    };

    it('reads a creature speed off the wire: state >> 8 is units per ms x 100', () => {
      const store = new EntityStore();
      store.processUnits([creature(EntityType.PLAYER, 23, 1000, 1011)]);
      expect(store.get(1, 0)!.speed).toBeCloseTo(0.23);

      store.processUnits([creature(EntityType.AI, 32, 1000, 1016)]);
      expect(store.get(1, 0)!.speed).toBeCloseTo(0.32);
    });

    it('keeps pace with a walking player instead of falling further behind every tick', () => {
      const store = new EntityStore();
      // 0.20 u/ms => 10 units per 50ms tick, for 2 seconds.
      const finalX = walk(store, 20, 10, 40);
      const e = store.get(1, 0)!;
      expect(e.nx).toBe(finalX);
      // Logical position is never more than one tick of travel behind the server.
      expect(e.nx - e.rx).toBeLessThanOrEqual(10.01);
      // Visual smoothing adds a small, bounded lag -- not a growing one.
      expect(e.nx - e.x).toBeLessThan(40);
    });

    it('settles on the server position shortly after the player stops', () => {
      const store = new EntityStore();
      const finalX = walk(store, 20, 10, 40);
      // Server reports the player standing still.
      store.processUnits([creature(EntityType.PLAYER, 20, finalX, finalX)]);
      for (let f = 0; f < 400 / FRAME; f++) store.update(FRAME);
      const e = store.get(1, 0)!;
      expect(Math.abs(e.x - finalX)).toBeLessThan(1);
    });

    it('renders the same motion at 60 and 120 fps (frame-rate independent smoothing)', () => {
      const at = (frameMs: number) => {
        const store = new EntityStore();
        store.processUnits([creature(EntityType.PLAYER, 20, 1000, 1100)]);
        for (let t = 0; t < 300 / frameMs; t++) store.update(frameMs);
        return store.get(1, 0)!.x;
      };
      expect(Math.abs(at(1000 / 60) - at(1000 / 120))).toBeLessThan(1);
    });

    it('resnaps a creature whose visual position drifted over 66 units from the server start', () => {
      const store = new EntityStore();
      store.processUnits([creature(EntityType.PLAYER, 20, 1000, 1000)]);
      const e = store.get(1, 0)!;
      // Server says the player was at 1200 last tick and is now at 1210:
      // we are 200 units off, so re-anchor the logical position there.
      store.processUnits([creature(EntityType.PLAYER, 20, 1200, 1210)]);
      expect(e.rx).toBe(1200);
      expect(e.ry).toBe(1000);
    });

    it('keeps the logical position when the drift is within tolerance', () => {
      const store = new EntityStore();
      store.processUnits([creature(EntityType.PLAYER, 20, 1000, 1010)]);
      const e = store.get(1, 0)!;
      store.update(FRAME);
      const rxBefore = e.rx;
      store.processUnits([creature(EntityType.PLAYER, 20, 1010, 1020)]);
      expect(e.rx).toBe(rxBefore);
    });

    it('uses the old client fixed speeds for loot and particles, and wire speed for bullets', () => {
      const store = new EntityStore();
      const rec = (type: number, state: number): UnitRecord => ({
        pid: 0,
        id: 7,
        type,
        rotation: 0,
        state,
        startX: 0,
        startY: 0,
        endX: 100,
        endY: 0,
        extra: 0,
      });
      store.processUnits([rec(EntityType.LOOT, (5 << 8) | 1)]); // high byte = attacker pid, not speed
      expect(store.get(0, 7)!.speed).toBeCloseTo(0.2);
      store.processUnits([rec(EntityType.PARTICLES, 1)]);
      expect(store.get(0, 7)!.speed).toBeCloseTo(0.7);
      store.processUnits([rec(EntityType.BULLET, (150 << 8) | 1)]);
      expect(store.get(0, 7)!.speed).toBeCloseTo(1.5);
    });

    it('does not rush a bullet to its landing point: projectiles travel at wire speed only', () => {
      const store = new EntityStore();
      store.processUnits([
        {
          pid: 0,
          id: 9,
          type: EntityType.BULLET,
          rotation: 0,
          state: (100 << 8) | 1, // 1 u/ms
          startX: 0,
          startY: 0,
          endX: 1000,
          endY: 0,
          extra: 0,
        },
      ]);
      store.update(100);
      expect(store.get(0, 9)!.rx).toBeCloseTo(100);
    });
  });

  it('latches a one-tick hurt pulse (state bit 1) on buildings and resources with the impact direction', () => {
    const store = new EntityStore();
    const rec = (type: number, state: number, extra: number): UnitRecord => ({
      pid: 0,
      id: 5,
      type,
      rotation: 0,
      state,
      startX: 250,
      startY: 250,
      endX: 250,
      endY: 250,
      extra,
    });
    store.processUnits([rec(EntityType.BUILD_TOP, 1, 27 << 7)]);
    const wall = store.get(0, 5)!;
    expect(wall.hurtPulse).toBe(false);
    store.processUnits([rec(EntityType.BUILD_TOP, 3, (27 << 7) | 12)]);
    store.processUnits([rec(EntityType.BUILD_TOP, 1, 27 << 7)]);
    expect(wall.hurtPulse).toBe(true);
    expect(wall.hurtPulseDir).toBe(12);

    store.processUnits([rec(EntityType.RES_TOP, 3, 7)]);
    expect(store.get(0, 5)!.hurtPulse).toBe(true);
    expect(store.get(0, 5)!.hurtPulseDir).toBe(7);
  });

  it('latches the one-tick bit 5 pulse on buildings (a door that could not open) even when the state is unchanged after', () => {
    const store = new EntityStore();
    const rec = (state: number): UnitRecord => ({
      pid: 0,
      id: 5,
      type: EntityType.BUILD_TOP,
      rotation: 0,
      state,
      startX: 250,
      startY: 250,
      endX: 250,
      endY: 250,
      extra: 50 << 7,
    });
    store.processUnits([rec(1)]);
    const door = store.get(0, 5)!;
    expect(door.failPulse).toBe(false);
    // The server sets bit 5 for exactly one update and sends nothing after it.
    store.processUnits([rec(1 | 32)]);
    expect(door.failPulse).toBe(true);
    door.failPulse = false;
    // A second refused attempt is a new packet with the same state: a new pulse.
    store.processUnits([rec(1 | 32)]);
    expect(door.failPulse).toBe(true);
  });

  it('keeps a removed creature listed (flagged removed) for 900ms so its death animation can play', () => {
    const store = new EntityStore();
    const rec = (state: number, extra = 0): UnitRecord => ({
      pid: 4,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0,
      state,
      startX: 100,
      startY: 100,
      endX: 100,
      endY: 100,
      extra,
    });
    store.processUnits([rec(1)]);
    const entity = store.get(4, 0)!;
    store.processUnits([rec(0, 1)]); // extra 1 = destruction / death

    expect(entity.removed).toBe(true);
    expect(store.get(4, 0)).toBeUndefined();
    expect(store.getByType(EntityType.PLAYER)).toContain(entity);

    store.update(500);
    expect(store.getByType(EntityType.PLAYER)).toContain(entity);
    store.update(500);
    expect(store.getByType(EntityType.PLAYER)).not.toContain(entity);
  });

  it('removes a creature immediately without death animation when extra is 0 (viewport exit)', () => {
    const store = new EntityStore();
    const rec = (state: number, extra = 0): UnitRecord => ({
      pid: 4,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0,
      state,
      startX: 100,
      startY: 100,
      endX: 100,
      endY: 100,
      extra,
    });
    store.processUnits([rec(1)]);
    const entity = store.get(4, 0)!;
    store.processUnits([rec(0, 0)]); // extra 0 = retraction / concealment / viewport exit

    expect(entity.removed).toBe(false);
    expect(store.get(4, 0)).toBeUndefined();
    expect(store.getByType(EntityType.PLAYER)).not.toContain(entity);
    expect(store.fadeLeft(entity)).toBeUndefined();
  });

  it('fades out a retracted structure smoothly over 300ms without death animation, and resumes if re-encountered', () => {
    const store = new EntityStore();
    const bRec = (state: number, extra = 0): UnitRecord => ({
      pid: 0,
      id: 5,
      type: EntityType.BUILD_TOP,
      rotation: 0,
      state,
      startX: 200,
      startY: 200,
      endX: 200,
      endY: 200,
      extra,
    });
    store.processUnits([bRec(1)]);
    const b = store.get(0, 5)!;
    store.processUnits([bRec(0, 0)]); // retraction

    expect(b.removed).toBe(false);
    expect(b.retracted).toBe(true);
    expect(store.fadeLeft(b)).toBe(300);
    expect(store.getByType(EntityType.BUILD_TOP)).toContain(b);

    // If player steps back into range during fade, it resumes
    store.processUnits([bRec(1)]);
    expect(b.retracted).toBe(false);
    expect(store.fadeLeft(b)).toBeUndefined();
    expect(store.get(0, 5)).toBe(b);

    // Retract again and let it expire
    store.processUnits([bRec(0, 0)]);
    store.update(150);
    expect(store.getByType(EntityType.BUILD_TOP)).toContain(b);
    store.update(150);
    expect(store.getByType(EntityType.BUILD_TOP)).not.toContain(b);
  });

  it('a creature that respawns while its corpse is fading gets a fresh entity', () => {
    const store = new EntityStore();
    const rec = (state: number, extra = 0): UnitRecord => ({
      pid: 4,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0,
      state,
      startX: 100,
      startY: 100,
      endX: 100,
      endY: 100,
      extra,
    });
    store.processUnits([rec(1)]);
    const corpse = store.get(4, 0)!;
    store.processUnits([rec(0, 1)]);
    store.processUnits([rec(1)]);
    const respawned = store.get(4, 0)!;
    expect(respawned).not.toBe(corpse);
    expect(respawned.removed).toBe(false);
    expect(store.getByType(EntityType.PLAYER)).toHaveLength(2);
  });

  it('drops stale bullets sitting at their endpoint for over 5000ms', () => {
    const store = new EntityStore();
    store.processUnits([
      {
        pid: 1,
        id: 99,
        type: EntityType.BULLET,
        rotation: 0,
        state: 1,
        startX: 300,
        startY: 300,
        endX: 300,
        endY: 300,
        extra: 0,
      },
    ]);

    expect(store.get(1, 99)).toBeDefined();

    // 4 seconds elapsed: still kept
    store.update(4000);
    expect(store.get(1, 99)).toBeDefined();

    // Another 1.5 seconds (5500ms total): evicted by stale backstop
    store.update(1500);
    expect(store.get(1, 99)).toBeUndefined();
  });

  describe('loot pickup flight', () => {
    const FRAME = 1000 / 60;
    const player = (x: number, y = 1000): UnitRecord => ({
      pid: 2,
      id: 0,
      type: EntityType.PLAYER,
      rotation: 0,
      state: 1,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      extra: 0,
    });
    /** A pickup lying at (x, y); `taker` is the server's attackerPid in the high byte of state. */
    const loot = (x: number, taker: number, state = 1): UnitRecord => ({
      pid: 0,
      id: 9,
      type: EntityType.LOOT,
      rotation: 0,
      state: state === 0 ? 0 : (taker << 8) | 1,
      startX: x,
      startY: 1000,
      endX: x,
      endY: 1000,
      extra: state === 0 ? 1 : 3,
    });

    it('flies to the player named in its state high byte instead of sitting where it dropped', () => {
      const store = new EntityStore();
      store.processUnits([player(1000), loot(800, 2)]);
      const pickup = store.get(0, 9)!;
      expect(isLootFlying(pickup)).toBe(true);
      for (let i = 0; i < 15; i++) store.update(FRAME); // 250 ms: the server's removal delay
      expect(pickup.nx).toBe(1000);
      expect(pickup.x).toBeGreaterThan(850);
      expect(pickup.x).toBeLessThanOrEqual(1000);
    });

    it('keeps homing on the player as they move, and keeps flying while it fades out', () => {
      const store = new EntityStore();
      store.processUnits([player(1000), loot(800, 2)]);
      const pickup = store.get(0, 9)!;
      store.processUnits([player(1100)]);
      for (let i = 0; i < 60; i++) store.update(FRAME);
      expect(pickup.nx).toBeCloseTo(store.get(2, 0)!.x, 1);
      expect(pickup.nx).toBeGreaterThan(1090);

      store.processUnits([loot(800, 2, 0)]); // removed: 800 ms fade
      const before = pickup.x;
      for (let i = 0; i < 30; i++) store.update(FRAME);
      expect(pickup.removed).toBe(true);
      expect(pickup.x).toBeGreaterThan(before);
      // Fast enough to reach a player standing 300 units away well inside the fade.
      expect(pickup.x).toBeGreaterThan(1050);
    });

    it('a pickup nobody has taken glides to its landing spot at the old fixed speed', () => {
      const store = new EntityStore();
      store.processUnits([player(1000), { ...loot(800, 0), endX: 850 }]);
      const pickup = store.get(0, 9)!;
      expect(isLootFlying(pickup)).toBe(false);
      for (let i = 0; i < 6; i++) store.update(FRAME); // 100 ms at 0.2 units/ms = 20 units
      expect(pickup.rx).toBeCloseTo(820, 0);
      expect(pickup.nx).toBe(850);
    });
  });
});
