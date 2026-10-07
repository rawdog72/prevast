// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AIM_STAT_NAMES,
  STAT_NAMES,
  artLayout,
  defaultFitted,
  fittingMods,
  magazineCapacity,
  resolveStats,
  resolveWeapon,
  slotForMod,
  statRows,
  weaponSlots,
  withMod,
  type AimBase,
  type ModDef,
  type WeaponStats,
} from './weapon-mods';
import { MODS_IID, modsContent } from './weapon-mods.fixtures';

interface FixtureCase {
  name: string;
  base: WeaponStats;
  hasMagazineSlot: boolean;
  aim?: AimBase;
  mods: { slot: string; capacity?: number; stats: ModDef['stat'] }[];
  expect: WeaponStats & Partial<Record<(typeof AIM_STAT_NAMES)[number], number>>;
}
const fixture = JSON.parse(
  readFileSync('tests/fixtures/weapon-mods/resolve-cases.json', 'utf8'),
) as { cases: FixtureCase[] };

describe('resolveStats (tests/fixtures/weapon-mods/resolve-cases.json, shared with the C++ self-test)', () => {
  it.each(fixture.cases)('$name', (c) => {
    const mods: ModDef[] = c.mods.map((m, i) => ({
      key: `m${i}`,
      slot: m.slot,
      installMs: 1,
      capacity: m.capacity,
      stat: m.stats,
    }));
    const got = resolveStats(c.base, mods, c.hasMagazineSlot, c.aim);
    for (const name of STAT_NAMES) expect(got[name]).toBeCloseTo(c.expect[name], 6);
    expect(got.magazineSize).toBe(c.expect.magazineSize);
    if (c.aim) {
      for (const name of AIM_STAT_NAMES) expect(got.aim![name]).toBeCloseTo(c.expect[name]!, 6);
    } else {
      expect(got.aim).toBeUndefined();
    }
  });
});

describe('weapon mod content helpers', () => {
  const content = modsContent();
  const inventory = [
    { uid: 1, iid: MODS_IID.gun, count: 1, ammo: 12 },
    { uid: 2, iid: MODS_IID.mag40, count: 1, ammo: 0 },
    { uid: 3, iid: MODS_IID.scope, count: 1, ammo: 0 },
    { uid: 4, iid: MODS_IID.bandage, count: 3, ammo: 0 },
  ];

  it('reads a weapon slot list with trimmed keys', () => {
    const slots = weaponSlots(content, MODS_IID.gun);
    expect(slots.map((s) => s.type)).toEqual(['magazine', 'optic', 'underbarrel', 'handguard']);
    expect(slots[0]!.accepts).toEqual(['mp5_mag_15', 'mp5_mag_30', 'mp5_mag_40']);
    expect(weaponSlots(content, MODS_IID.bandage)).toEqual([]);
  });

  it('lists the defaults a created gun has', () => {
    expect(defaultFitted(content, MODS_IID.gun)).toEqual([
      { slot: 0, iid: MODS_IID.mag30 },
      { slot: 6, iid: MODS_IID.handguard },
    ]);
  });

  it('resolves a gun with its fitted mods', () => {
    const drum = resolveWeapon(content, MODS_IID.gun, [{ slot: 0, iid: MODS_IID.mag40 }])!;
    expect(drum.magazineSize).toBe(40);
    expect(drum.reloadMs).toBe(3000);
    expect(drum.drawMs).toBe(1150);
    const bare = resolveWeapon(content, MODS_IID.gun, [])!;
    expect(bare.magazineSize).toBe(0);
    expect(bare.damage).toBe(18);
  });

  it('knows capacity, and that a bandage takes no ammo', () => {
    expect(magazineCapacity(content, MODS_IID.gun, [])).toBe(0);
    expect(magazineCapacity(content, MODS_IID.gun, [{ slot: 0, iid: MODS_IID.mag30 }])).toBe(30);
    expect(magazineCapacity(content, MODS_IID.bandage, [])).toBeNull();
  });

  it('finds the carried mods that fit a slot, and the slot a mod goes in', () => {
    expect(fittingMods(content, MODS_IID.gun, 'magazine', inventory).map((i) => i.uid)).toEqual([
      2,
    ]);
    expect(fittingMods(content, MODS_IID.gun, 'optic', inventory).map((i) => i.uid)).toEqual([3]);
    expect(slotForMod(content, MODS_IID.gun, MODS_IID.scope)).toBe('optic');
    expect(slotForMod(content, MODS_IID.gun, MODS_IID.bandage)).toBeNull();
  });

  it('replaces or clears one slot of a fitted list', () => {
    const fitted = defaultFitted(content, MODS_IID.gun);
    expect(withMod(fitted, 0, MODS_IID.mag40)).toEqual([
      { slot: 0, iid: MODS_IID.mag40 },
      { slot: 6, iid: MODS_IID.handguard },
    ]);
    expect(withMod(fitted, 6, 0)).toEqual([{ slot: 0, iid: MODS_IID.mag30 }]);
  });

  it('shows stat rows with deltas and whether each change is better', () => {
    const now = resolveWeapon(content, MODS_IID.gun, [{ slot: 0, iid: MODS_IID.mag30 }])!;
    const next = resolveWeapon(content, MODS_IID.gun, [{ slot: 0, iid: MODS_IID.mag40 }])!;
    const rows = statRows(now, next, 12);
    const row = (key: string) => rows.find((r) => r.key === key)!;
    expect(row('magazineSize')).toMatchObject({ value: '12/30', delta: '+10', better: true });
    expect(row('reloadMs')).toMatchObject({ value: '2.6 s', delta: '+0.4 s', better: false });
    expect(row('fireDelayMs')).toMatchObject({ value: '600 rpm' });
    expect(row('fireDelayMs').delta).toBeUndefined();
    expect(row('spread').value).toBe('4.6°');
  });

  it('shows the aim rows of a gun that can aim, and a scope`s change to them', () => {
    const now = resolveWeapon(content, MODS_IID.gun, [])!;
    const next = resolveWeapon(content, MODS_IID.gun, [{ slot: 1, iid: MODS_IID.scope }])!;
    expect(now.aim!.aimSpread).toBeCloseTo(0.052, 6);
    expect(next.aim!.aimMs).toBe(350);
    const rows = statRows(now, next);
    const row = (key: string) => rows.find((r) => r.key === key)!;
    expect(row('aimSpread')).toMatchObject({ value: '3.0°', delta: '−0.9°', better: true });
    expect(row('aimMove')).toMatchObject({ value: '80%', delta: '−8%', better: false });
    expect(row('aimMs')).toMatchObject({ value: '0.25 s', delta: '+0.10 s', better: false });
    // A gun that cannot aim has no aim rows.
    expect(statRows({ ...now, aim: undefined }).some((r) => r.key === 'aimSpread')).toBe(false);
  });
});

describe('artLayout', () => {
  const content = modsContent();
  it('places the body and each fitted part in frame percentages, in draw order', () => {
    const layout = artLayout(content, MODS_IID.gun, [
      { slot: 1, iid: MODS_IID.scope },
      { slot: 0, iid: MODS_IID.mag30 },
    ])!;
    expect(layout.aspect).toBeCloseTo(596 / 232, 6);
    expect(layout.layers.map((l) => l.src)).toEqual([
      '/img/mods/mag-30.svg',
      '/img/mods/gun-body.svg',
      '/img/mods/sight-tube.svg',
    ]);
    const mag = layout.layers[0]!;
    expect(mag.left).toBeCloseTo(((318 - 4 - 24) / 596) * 100, 4);
    expect(mag.top).toBeCloseTo(((101 - 4 - 8) / 232) * 100, 4);
    expect(mag.height).toBeCloseTo(50, 4);
    const scope = layout.layers[2]!;
    expect(scope.left).toBeCloseTo(((289 - 31 - 4 - 24) / 596) * 100, 4);
    expect(layout.spots.map((s) => s.slot)).toEqual(['magazine', 'optic']);
  });
  it('is null for a weapon without art', () => {
    expect(artLayout(content, MODS_IID.bandage, [])).toBeNull();
  });
});
