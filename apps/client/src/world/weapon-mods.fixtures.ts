// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Test content only: SMG Tactical and some of its mods, and the sniper's built-in scope, shaped like the export.
import { ContentStore } from '../content/store';

export const MODS_IID = {
  gun: 172,
  mag15: 173,
  mag30: 174,
  mag40: 175,
  reflex: 176,
  scope: 177,
  grip: 179,
  handguard: 183,
  sniper: 11,
  bandage: 38,
} as const;

function table(name: string, entries: Record<string, unknown>) {
  return { name, version: 1, hash: 'h', attributes: {}, entries } as never;
}

function item(id: number, key: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    id,
    clientItemId: id,
    name,
    properties: { stack: 1 },
    client: { icon: `inv-${key}`, description: `${name}.` },
    ...extra,
  };
}

export function modsContent(): ContentStore {
  const store = new ContentStore();
  const mod = (id: number, key: string, name: string) =>
    item(id, key, name, { weaponMod: { key } });
  store.load(
    table('items', {
      mp5_tactical: item(172, 'mp5_tactical', 'SMG Tactical', {
        equipable: { key: 'mp5_tactical', equipTimeMs: 1000 },
      }),
      mp5_mag_15: mod(173, 'mp5_mag_15', 'SMG 15-round magazine'),
      mp5_mag_30: mod(174, 'mp5_mag_30', 'SMG 30-round magazine'),
      mp5_mag_40: mod(175, 'mp5_mag_40', 'SMG 40-round magazine'),
      reflex_sight: mod(176, 'reflex_sight', 'Reflex sight'),
      tube_scope: mod(177, 'tube_scope', 'Tube scope'),
      grip_vertical: mod(179, 'grip_vertical', 'Vertical grip'),
      handguard_standard: mod(183, 'handguard_standard', 'Standard handguard'),
      bandage: item(38, 'bandage', 'Bandage'),
      sniper: item(11, 'sniper', 'Sniper', { equipable: { key: 'sniper', equipTimeMs: 1000 } }),
    }),
  );
  store.load(
    table('equipables', {
      mp5_tactical: {
        key: 'mp5_tactical',
        id: 54,
        idWeapon: 54,
        typeId: 2,
        timing: { shotDelayMs: 100 },
        damage: { amount: 18, type: 'piercing', knockback: 1.2 },
        fire: {
          mode: 'auto',
          projectileKey: '9mm_bullet',
          speedMultiplier: 1.7,
          spreadRadians: 0.08,
          range: 900,
          recoilKickback: 0.7,
        },
        ammo: { key: '9mm_bullet', reloadMs: 2600 },
        aim: { spreadPercent: -35, movePercent: -20, timeMs: 250 },
        client: {
          render: 'gun',
          breath: 1,
          move: 2,
          modArt: {
            frame: '24 8 596 232',
            body: 'mods/gun-body.svg',
            bodyBox: '176 34 322 180',
            anchor: [
              { slot: 'magazine', x: 318, y: 101 },
              { slot: 'optic', x: 289, y: 55 },
            ],
          },
        },
        mods: {
          slot: [
            {
              type: 'magazine',
              accepts: 'mp5_mag_15, mp5_mag_30,mp5_mag_40',
              default: 'mp5_mag_30',
            },
            { type: 'optic', accepts: 'reflex_sight,tube_scope' },
            { type: 'underbarrel', accepts: 'grip_vertical' },
            { type: 'handguard', accepts: 'handguard_standard', default: 'handguard_standard' },
          ],
        },
      },
      sniper: {
        key: 'sniper',
        id: 2,
        idWeapon: 11,
        typeId: 2,
        timing: { shotDelayMs: 1200 },
        damage: { amount: 90, type: 'piercing', knockback: 5 },
        fire: {
          mode: 'semi',
          projectileKey: '762_round',
          speedMultiplier: 3,
          spreadRadians: 0.005,
          range: 1200,
          recoilKickback: 2,
        },
        ammo: { key: '762_round', magazineSize: 10, reloadMs: 3000 },
        aim: { spreadPercent: -60, movePercent: -40, timeMs: 450 },
        view: { shape: 'rect', length: 1900, width: 500, back: 100, zoom: 0.55, rearRadius: 250 },
      },
    }),
  );
  store.load(
    table('mods', {
      mp5_mag_15: {
        key: 'mp5_mag_15',
        slot: 'magazine',
        installMs: 1500,
        capacity: 15,
        stat: [
          { name: 'reloadMs', add: -300 },
          { name: 'drawMs', add: -100 },
        ],
      },
      mp5_mag_30: {
        key: 'mp5_mag_30',
        slot: 'magazine',
        installMs: 1800,
        capacity: 30,
        client: { art: 'mods/mag-30.svg', box: '-4 -4 66 116', anchorX: 0, anchorY: 0 },
      },
      mp5_mag_40: {
        key: 'mp5_mag_40',
        slot: 'magazine',
        installMs: 2200,
        capacity: 40,
        stat: [
          { name: 'reloadMs', add: 400 },
          { name: 'drawMs', add: 150 },
        ],
      },
      reflex_sight: {
        key: 'reflex_sight',
        slot: 'optic',
        installMs: 1500,
        view: { shape: 'stretch', ahead: 250, zoom: 0.95, extend: 250 },
      },
      tube_scope: {
        key: 'tube_scope',
        slot: 'optic',
        installMs: 2500,
        view: { shape: 'shift', ahead: 450, zoom: 0.85, extend: 500 },
        stat: [
          { name: 'aimSpread', percent: -30 },
          { name: 'aimMove', percent: -10 },
          { name: 'aimMs', add: 100 },
        ],
        client: { art: 'mods/sight-tube.svg', box: '-4 -4 71 43', anchorX: 31, anchorY: 35 },
      },
      grip_vertical: {
        key: 'grip_vertical',
        slot: 'underbarrel',
        installMs: 2000,
        stat: [{ name: 'recoil', percent: -30 }],
      },
      handguard_standard: { key: 'handguard_standard', slot: 'handguard', installMs: 2500 },
    }),
  );
  return store;
}
