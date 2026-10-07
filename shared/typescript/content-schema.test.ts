// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  ContentSchemaError,
  contentManifestSchema,
  contentPatchSchema,
  validateTable,
} from './content-schema';

const envelope = (name: string, entries: Record<string, unknown>) => ({
  name,
  version: 1,
  hash: '0'.repeat(16),
  attributes: {},
  entries,
});

describe('validateTable', () => {
  it('accepts a minimal item and passes unknown fields through', () => {
    const t = validateTable(
      'items',
      envelope('items', {
        wood: {
          id: 1,
          clientItemId: 1,
          key: 'wood',
          name: 'Wood',
          properties: { stack: 255, lootId: 2, score: 10 },
          future: 'x',
        },
      }),
    );
    expect((t.entries.wood as { future?: string }).future).toBe('x');
  });
  it('rejects an item without an id or with a numeric description', () => {
    expect(() =>
      validateTable('items', envelope('items', { wood: { key: 'wood', name: 'Wood' } })),
    ).toThrow(ContentSchemaError);
    try {
      validateTable(
        'items',
        envelope('items', {
          wood: { id: 1, clientItemId: 1, key: 'wood', name: 'Wood', client: { description: 42 } },
        }),
      );
    } catch (e) {
      expect((e as ContentSchemaError).issues.join('\n')).toMatch(/wood.*client.*description/);
    }
  });
  it('rejects a table whose name does not match', () => {
    expect(() => validateTable('items', envelope('objects', {}))).toThrow(/name/);
  });
  it('validates config strictly', () => {
    const good = {
      mode: 'survival',
      maxPlayers: 255,
      maxClans: 18,
      clanSize: 9,
      clanNameMaxLength: 5,
      clanActionDelayMs: 500,
      mapWidth: 150,
      mapHeight: 150,
      tileSize: 100,
      dayCycleMs: 960000,
      craftSpeed: 1,
      inventorySlots: 8,
      chatMaxLength: 200,
      nicknameMaxLength: 16,
      passwordMaxLength: 16,
      xpStart: 900,
      xpGrowth: 1.105,
      maxLevel: 200,
      craftQueueSize: 4,
      chestMaxSlots: 64,
      interactionRange: 150,
      lootPickupRange: 200,
    };
    expect(validateTable('config', envelope('config', good)).entries.maxClans).toBe(18);
    expect(() => validateTable('config', envelope('config', { ...good, maxClanz: 1 }))).toThrow(
      ContentSchemaError,
    );
    const { maxClans: _dropped, ...missing } = good;
    expect(() => validateTable('config', envelope('config', missing))).toThrow(/maxClans/);
  });
  it('has manifest and patch schemas', () => {
    expect(
      contentManifestSchema.parse({ protocol: 1, tables: { items: { version: 3, hash: 'ab' } } })
        .tables.items!.version,
    ).toBe(3);
    expect(
      contentPatchSchema.parse({
        name: 'items',
        fromVersion: 1,
        toVersion: 2,
        hash: 'x',
        patch: { hatchet: null },
      }).patch,
    ).toEqual({ hatchet: null });
  });
});

it('validates unknown-field JSON and patch shapes and versions', () => {
  const item = { id: 1, clientItemId: 1, key: 'wood', name: 'Wood' };
  for (const future of [undefined, NaN, Infinity, () => 1, BigInt(1)]) {
    expect(() => validateTable('items', envelope('items', { wood: { ...item, future } }))).toThrow(
      ContentSchemaError,
    );
  }
  for (const patch of [undefined, null, [], 'x', { wood: { future: undefined } }]) {
    expect(
      contentPatchSchema.safeParse({
        name: 'items',
        fromVersion: 1,
        toVersion: 2,
        hash: 'h',
        patch,
      }).success,
    ).toBe(false);
  }
  expect(
    contentPatchSchema.safeParse({
      name: 'items',
      fromVersion: 2,
      toVersion: 1,
      hash: 'h',
      patch: {},
    }).success,
  ).toBe(false);
  expect(
    contentManifestSchema.safeParse({ protocol: 1, tables: { items: { version: 0, hash: '' } } })
      .success,
  ).toBe(false);
});

describe('mods table', () => {
  it('accepts a magazine with stats and keeps the stat list an array', () => {
    const t = validateTable(
      'mods',
      envelope('mods', {
        mp5_mag_40: {
          key: 'mp5_mag_40',
          slot: 'magazine',
          installMs: 2200,
          capacity: 40,
          stat: [{ name: 'reloadMs', add: 400 }],
        },
      }),
    );
    expect((t.entries.mp5_mag_40 as { capacity: number }).capacity).toBe(40);
  });
  it('rejects an unknown slot and a zero install time', () => {
    expect(() =>
      validateTable('mods', envelope('mods', { x: { key: 'x', slot: 'barrel', installMs: 1 } })),
    ).toThrow(ContentSchemaError);
    expect(() =>
      validateTable('mods', envelope('mods', { x: { key: 'x', slot: 'optic', installMs: 0 } })),
    ).toThrow(ContentSchemaError);
  });
  it('types a weapon slot list', () => {
    const eq = validateTable(
      'equipables',
      envelope('equipables', {
        gun: {
          key: 'gun',
          id: 54,
          idWeapon: 54,
          typeId: 2,
          ammo: { key: '9mm_bullet', reloadMs: 2600 },
          mods: { slot: [{ type: 'magazine', accepts: 'a,b', default: 'a' }] },
        },
      }),
    );
    expect((eq.entries.gun as { mods: { slot: unknown[] } }).mods.slot).toHaveLength(1);
  });
  // equipableEntry and itemEntry are loose objects, so these only fail when the typed shape
  // (equipableEntry.mods, equipableEntry.fire, itemEntry.weaponMod) is really declared.
  const gun = (extra: Record<string, unknown>) =>
    envelope('equipables', { gun: { key: 'gun', id: 54, idWeapon: 54, typeId: 2, ...extra } });
  it('rejects a weapon slot with an unknown type or empty accepts list', () => {
    expect(() =>
      validateTable('equipables', gun({ mods: { slot: [{ type: 'barrel', accepts: 'a' }] } })),
    ).toThrow(/gun\.mods\.slot\.0\.type/);
    expect(() =>
      validateTable('equipables', gun({ mods: { slot: [{ type: 'optic', accepts: '' }] } })),
    ).toThrow(/gun\.mods\.slot\.0\.accepts/);
  });
  it('types the fire tuning fields as numbers', () => {
    const fire = { mode: 'auto', projectileKey: '9mm_bullet' };
    const ok = validateTable(
      'equipables',
      gun({ fire: { ...fire, spreadRadians: 0.05, speedMultiplier: 1.2, recoilKickback: 3 } }),
    );
    expect((ok.entries.gun as { fire: { spreadRadians: number } }).fire.spreadRadians).toBe(0.05);
    for (const field of ['spreadRadians', 'speedMultiplier', 'recoilKickback']) {
      expect(() => validateTable('equipables', gun({ fire: { ...fire, [field]: 'x' } }))).toThrow(
        new RegExp(`gun\\.fire\\.${field}`),
      );
    }
  });
  it('types a weapon <aim> and rejects one out of range', () => {
    const ok = validateTable(
      'equipables',
      gun({ aim: { spreadPercent: -35, movePercent: -20, timeMs: 250 } }),
    );
    expect((ok.entries.gun as { aim: { timeMs: number } }).aim.timeMs).toBe(250);
    expect(() =>
      validateTable('equipables', gun({ aim: { spreadPercent: 5, movePercent: -20, timeMs: 250 } })),
    ).toThrow(/gun\.aim\.spreadPercent/);
    expect(() =>
      validateTable('equipables', gun({ aim: { spreadPercent: -35, movePercent: -20 } })),
    ).toThrow(/gun\.aim\.timeMs/);
  });
  it('types a weak <view> on an optic and on a weapon', () => {
    const view = { shape: 'shift', ahead: 450, zoom: 0.85, extend: 500 };
    const t = validateTable(
      'mods',
      envelope('mods', { s: { key: 's', slot: 'optic', installMs: 1, view } }),
    );
    expect((t.entries.s as { view: { extend: number } }).view.extend).toBe(500);
    expect(() =>
      validateTable(
        'mods',
        envelope('mods', { s: { key: 's', slot: 'optic', installMs: 1, view: { ...view, shape: 'triangle' } } }),
      ),
    ).toThrow(/s\.view\.shape/);
    expect(() => validateTable('equipables', gun({ view: { ...view, zoom: 0.3 } }))).toThrow(
      /gun\.view\.zoom/,
    );
  });
  it('types a strong <view> and rejects another shape`s attributes', () => {
    const rect = { shape: 'rect', length: 1900, width: 500, back: 100, zoom: 0.55, rearRadius: 250 };
    const cone = { shape: 'cone', reach: 1500, halfAngleDeg: 20, zoom: 0.7, rearRadius: 250 };
    const ok = validateTable('equipables', gun({ view: rect }));
    expect((ok.entries.gun as { view: { length: number } }).view.length).toBe(1900);
    expect(() => validateTable('equipables', gun({ view: { shape: 'rect', length: 1900, width: 500, zoom: 0.55, rearRadius: 250 } }))).not.toThrow();
    expect(() => validateTable('equipables', gun({ view: cone }))).not.toThrow();
    expect(() => validateTable('equipables', gun({ view: { ...rect, zoom: 0.3 } }))).toThrow(
      /gun\.view\.zoom/,
    );
    expect(() => validateTable('equipables', gun({ view: { ...cone, halfAngleDeg: 61 } }))).toThrow(
      /gun\.view\.halfAngleDeg/,
    );
    expect(() => validateTable('equipables', gun({ view: { shape: 'cone', halfAngleDeg: 20, zoom: 0.7, rearRadius: 250 } }))).toThrow(
      /gun\.view\.reach/,
    );
    expect(() => validateTable('equipables', gun({ view: { ...rect, extend: 300 } }))).toThrow(
      /gun\.view/,
    );
  });
  it('types an item link to its weapon mod', () => {
    const item = (weaponMod: unknown) =>
      envelope('items', {
        mp5_mag_40: { key: 'mp5_mag_40', id: 200, clientItemId: 200, name: 'SMG magazine', weaponMod },
      });
    const t = validateTable('items', item({ key: 'mp5_mag_40' }));
    expect((t.entries.mp5_mag_40 as { weaponMod: { key: string } }).weaponMod.key).toBe('mp5_mag_40');
    expect(() => validateTable('items', item({ key: 5 }))).toThrow(
      /mp5_mag_40\.weaponMod\.key/,
    );
  });
});
