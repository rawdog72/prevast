// Copyright (c) 2026 Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { ContentStore } from '../content/store';
import {
  blastFootprint,
  CookTimer,
  fuseColor,
  throwProfileFor,
  throwTargetFor,
  type ThrowProfile,
} from './throw-aim';

function table(name: string, entries: Record<string, unknown>) {
  return { name, version: 1, hash: 'h', attributes: {}, entries } as never;
}

function item(id: number, key: string, name: string) {
  return {
    key,
    id,
    clientItemId: id,
    name,
    properties: { stack: 1 },
    equipable: { key },
    client: { icon: `inv-${key}`, description: `${name}.` },
  };
}

// Shaped like the export of data/XML: the grenade, and a spear (a throwable that is not cooked).
function grenadeContent(): ContentStore {
  const store = new ContentStore();
  store.load(
    table('items', {
      granade: item(113, 'granade', 'Grenade'),
      wood_spear: item(6, 'wood_spear', 'Spear'),
      sniper: item(11, 'sniper', 'Sniper'),
    }),
  );
  store.load(
    table('equipables', {
      granade: {
        key: 'granade',
        id: 38,
        idWeapon: 38,
        typeId: 3,
        fire: { mode: 'semi', projectileKey: 'granade', range: 380 },
        throw: { cookable: true, minRange: 100, pinMs: 250, releaseMs: 150 },
      },
      wood_spear: {
        key: 'wood_spear',
        id: 5,
        idWeapon: 5,
        typeId: 3,
        fire: { mode: 'semi', projectileKey: 'spear', range: 600 },
      },
      sniper: {
        key: 'sniper',
        id: 11,
        idWeapon: 11,
        typeId: 2,
        fire: { mode: 'semi', projectileKey: '762_round', range: 1400 },
      },
    }),
  );
  store.load(
    table('projectiles', {
      granade: {
        key: 'granade',
        id: 8,
        clientProjectileId: 8,
        lifetime: { durationMs: 3000 },
        onDestroy: { explosion: { area: 1, playerDamage: 200 } },
      },
      spear: { key: 'spear', id: 4, clientProjectileId: 4 },
      '762_round': { key: '762_round', id: 1, clientProjectileId: 1 },
    }),
  );
  return store;
}

const PROFILE: ThrowProfile = {
  minRange: 100,
  maxRange: 380,
  fuseMs: 3000,
  blastArea: 1,
  blastRadius: 0,
};

describe('throwProfileFor', () => {
  it('reads range, fuse and blast for a cookable grenade', () => {
    expect(throwProfileFor(grenadeContent(), 113)).toEqual(PROFILE);
  });

  it('is null for a throwable that is not cooked, a gun, and empty hands', () => {
    const content = grenadeContent();
    expect(throwProfileFor(content, 6)).toBeNull();
    expect(throwProfileFor(content, 11)).toBeNull();
    expect(throwProfileFor(content, 0)).toBeNull();
  });

  it('is null before the tables have arrived', () => {
    expect(throwProfileFor(new ContentStore(), 113)).toBeNull();
  });
});

describe('throwTargetFor', () => {
  it('lands on the cursor inside the range', () => {
    const t = throwTargetFor(1000, 1000, 1200, 1000, 0, PROFILE);
    expect(t).toEqual({ x: 1200, y: 1000, distance: 200, clamped: false });
  });

  it('holds the marker at the maximum range, along the cursor direction', () => {
    const t = throwTargetFor(1000, 1000, 1000, 2000, 0, PROFILE);
    expect(t.x).toBeCloseTo(1000);
    expect(t.y).toBeCloseTo(1380);
    expect(t.distance).toBe(380);
    expect(t.clamped).toBe(true);
  });

  it('pushes a cursor at the feet out to the minimum range along the facing', () => {
    const t = throwTargetFor(1000, 1000, 1000, 1000, Math.PI, PROFILE);
    expect(t.x).toBeCloseTo(900);
    expect(t.y).toBeCloseTo(1000);
    expect(t.distance).toBe(100);
    expect(t.clamped).toBe(true);
  });
});

describe('blastFootprint', () => {
  it('is the server tile square: `area` tiles around the landing tile', () => {
    expect(blastFootprint(1250, 870, PROFILE)).toEqual({
      kind: 'square',
      x0: 1100,
      y0: 700,
      x1: 1400,
      y1: 1000,
    });
  });

  it('is a circle for a radius blast, and nothing without either', () => {
    expect(blastFootprint(10, 20, { ...PROFILE, blastArea: 0, blastRadius: 150 })).toEqual({
      kind: 'circle',
      x: 10,
      y: 20,
      r: 150,
    });
    expect(blastFootprint(10, 20, { ...PROFILE, blastArea: 0 })).toBeNull();
  });
});

describe('CookTimer', () => {
  it('counts the fuse down from COOK_STATE and stops at zero', () => {
    const timer = new CookTimer();
    expect(timer.active).toBe(false);
    timer.set(3000, 2500, 1000);
    expect(timer.active).toBe(true);
    expect(timer.remainingMs(2000)).toBe(1500);
    expect(timer.fraction(2000)).toBeCloseTo(0.5);
    expect(timer.remainingMs(9000)).toBe(0);
  });

  it('ends when the server says the grenade left the hand', () => {
    const timer = new CookTimer();
    timer.set(3000, 3000, 0);
    timer.set(0, 0, 100);
    expect(timer.active).toBe(false);
    expect(timer.fraction(100)).toBe(0);
  });

  it('turns warning colours over the last two seconds', () => {
    expect(fuseColor(2500)).toBe('#f4f1e6');
    expect(fuseColor(1500)).toBe('#ffb23d');
    expect(fuseColor(800)).toBe('#ff4a3d');
  });
});
