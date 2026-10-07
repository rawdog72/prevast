// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/weapon-mods.ts
// Weapon mods on the client: which slots a weapon has, what fits them, and the
// numbers a gun has with its mods fitted. The formula is the server's
// (apps/server/src/gameplay/weapon_mods.cpp resolveStats) and both run
// tests/fixtures/weapon-mods/resolve-cases.json. Display only: the server
// decides what a gun actually does and what may be fitted.

import { MOD_SLOT_NAMES } from '../../../../shared/typescript/content-schema';
import type { ContentStore } from '../content/store';
import type { ViewDef } from './aim-view';
import type { InventoryItem } from './inventory-store';

export type ModSlotName = (typeof MOD_SLOT_NAMES)[number];

/** The slot's wire id: its index in MOD_SLOT_NAMES. */
export function slotIndex(name: ModSlotName): number {
  return MOD_SLOT_NAMES.indexOf(name);
}

export function slotName(index: number): ModSlotName | undefined {
  return MOD_SLOT_NAMES[index];
}

export const SLOT_LABELS: Record<ModSlotName, string> = {
  magazine: 'Magazine',
  optic: 'Optic',
  muzzle: 'Muzzle',
  underbarrel: 'Underbarrel',
  side: 'Side',
  stock: 'Stock',
  handguard: 'Handguard',
};

/** One fitted mod as ITEM_MODS, CONTAINER_CONTENTS and TRADE_STATE carry it. */
export interface FittedMod {
  slot: number;
  iid: number;
}

export const STAT_NAMES = [
  'damage',
  'fireDelayMs',
  'spread',
  'range',
  'bulletSpeed',
  'recoil',
  'knockback',
  'reloadMs',
  'drawMs',
] as const;
export type StatName = (typeof STAT_NAMES)[number];
/** The aim stats (aim-and-scopes spec), resolved after the others. */
export const AIM_STAT_NAMES = ['aimSpread', 'aimMove', 'aimMs'] as const;
export type AimStatName = (typeof AIM_STAT_NAMES)[number];
export type AimStats = Record<AimStatName, number>;
/** A weapon's <aim>: what its aim stats resolve from. */
export interface AimBase {
  spreadPercent: number;
  movePercent: number;
  timeMs: number;
}
/** `aim` only for a weapon that can aim. */
export type WeaponStats = Record<StatName, number> & { magazineSize: number; aim?: AimStats };

export interface ModDef {
  key: string;
  slot: string;
  installMs: number;
  capacity?: number;
  stat?: { name: string; add?: number; percent?: number }[];
  view?: ViewDef;
  client?: { art?: string; box?: string; anchorX?: number; anchorY?: number };
}

type AnyStat = StatName | AimStatName;

// Same numbers as weaponModLimits in weapon_mods.cpp.
const LIMITS: Record<AnyStat, { min: number; max: number; integer: boolean }> = {
  damage: { min: 1, max: 65535, integer: true },
  fireDelayMs: { min: 30, max: 600000, integer: true },
  spread: { min: 0, max: 10, integer: false },
  range: { min: 50, max: 65535, integer: true },
  bulletSpeed: { min: 0.1, max: 100, integer: false },
  recoil: { min: 0, max: 100, integer: false },
  knockback: { min: 0, max: 100, integer: false },
  reloadMs: { min: 100, max: 600000, integer: true },
  drawMs: { min: 100, max: 600000, integer: true },
  aimSpread: { min: 0, max: 10, integer: false },
  aimMove: { min: 0.1, max: 1, integer: false },
  aimMs: { min: 0, max: 600000, integer: true },
};

const ANY_STATS: readonly string[] = [...STAT_NAMES, ...AIM_STAT_NAMES];
const isStat = (name: string): name is AnyStat => ANY_STATS.includes(name);

function settle(name: AnyStat, from: number, add: number, percent: number): number {
  const limit = LIMITS[name];
  const v = Math.min(limit.max, Math.max(limit.min, (from + add) * (1 + Math.max(percent, -95) / 100)));
  return limit.integer ? Math.round(v) : v;
}

/**
 * final = clamp((base + Σadd) × (1 + max(Σpercent, −95) / 100)); a stat no mod
 * touches keeps its base value. A weapon with a magazine slot takes its
 * capacity from the fitted magazine (0 when none is). With `aim`, the aim stats
 * resolve last: the aimed spread starts as a share of the hip spread settled
 * here, as in weapon_mods.cpp.
 */
export function resolveStats(
  base: WeaponStats,
  mods: readonly ModDef[],
  hasMagazineSlot: boolean,
  aim?: AimBase | null,
): WeaponStats {
  const out: WeaponStats = { ...base };
  delete out.aim;
  const add: Partial<Record<AnyStat, number>> = {};
  const percent: Partial<Record<AnyStat, number>> = {};
  let capacity = 0;
  for (const mod of mods) {
    if (mod.slot === 'magazine') capacity = mod.capacity ?? 0;
    for (const s of mod.stat ?? []) {
      if (!isStat(s.name)) continue;
      add[s.name] = (add[s.name] ?? 0) + (s.add ?? 0);
      percent[s.name] = (percent[s.name] ?? 0) + (s.percent ?? 0);
    }
  }
  for (const name of STAT_NAMES) {
    if (add[name] === undefined) continue;
    out[name] = settle(name, base[name], add[name]!, percent[name]!);
  }
  if (hasMagazineSlot) out.magazineSize = capacity;
  if (aim) {
    const from: AimStats = {
      aimSpread: out.spread * (1 + aim.spreadPercent / 100),
      aimMove: 1 + aim.movePercent / 100,
      aimMs: aim.timeMs,
    };
    out.aim = { ...from };
    for (const name of AIM_STAT_NAMES) {
      if (add[name] !== undefined) out.aim[name] = settle(name, from[name], add[name]!, percent[name]!);
    }
  }
  return out;
}

export interface SlotDef {
  type: ModSlotName;
  accepts: string[];
  default?: string;
}

function equipableOf(content: ContentStore, iid: number) {
  if (!content.has('items') || !content.has('equipables')) return undefined;
  const key = content.byId('items', iid)?.equipable?.key;
  return key ? content.byKey('equipables', key) : undefined;
}

/** The weapon's slots in declaration order; [] for anything that takes no mods. */
export function weaponSlots(content: ContentStore, iid: number): SlotDef[] {
  const slots = equipableOf(content, iid)?.mods?.slot ?? [];
  return slots.map((s) => ({
    type: s.type,
    accepts: String(s.accepts)
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    default: s.default,
  }));
}

export function takesMods(content: ContentStore, iid: number): boolean {
  return weaponSlots(content, iid).length > 0;
}

export function modByIid(content: ContentStore, iid: number): ModDef | undefined {
  if (!content.has('items') || !content.has('mods')) return undefined;
  const key = content.byId('items', iid)?.weaponMod?.key;
  return key ? (content.byKey('mods', key) as ModDef | undefined) : undefined;
}

function modIidByKey(content: ContentStore, key: string): number {
  return content.has('items') ? (content.byKey('items', key)?.id ?? 0) : 0;
}

/** A firing weapon's unmodded numbers, or null for anything that does not fire. */
export function baseStats(content: ContentStore, iid: number): WeaponStats | null {
  const eq = equipableOf(content, iid);
  if (!eq?.fire) return null;
  return {
    damage: eq.damage?.amount ?? 0,
    fireDelayMs: eq.timing?.shotDelayMs ?? 0,
    spread: eq.fire.spreadRadians ?? 0,
    range: eq.fire.range ?? 0,
    bulletSpeed: eq.fire.speedMultiplier ?? 1,
    recoil: eq.fire.recoilKickback ?? 0,
    knockback: eq.damage?.knockback ?? 0,
    reloadMs: eq.ammo?.reloadMs ?? 0,
    drawMs: content.byId('items', iid)?.equipable?.equipTimeMs ?? 0,
    magazineSize: eq.ammo?.magazineSize ?? 0,
  };
}

/** The weapon's <aim>, or null when it cannot aim. */
export function aimBase(content: ContentStore, iid: number): AimBase | null {
  const aim = equipableOf(content, iid)?.aim;
  return aim
    ? { spreadPercent: aim.spreadPercent, movePercent: aim.movePercent, timeMs: aim.timeMs }
    : null;
}

export function resolveWeapon(
  content: ContentStore,
  iid: number,
  fitted: readonly FittedMod[],
): WeaponStats | null {
  const base = baseStats(content, iid);
  if (!base) return null;
  const mods = fitted.map((f) => modByIid(content, f.iid)).filter((m): m is ModDef => !!m);
  return resolveStats(
    base,
    mods,
    weaponSlots(content, iid).some((s) => s.type === 'magazine'),
    aimBase(content, iid),
  );
}

/** Rounds the item holds when full; null when it takes no ammo at all. */
export function magazineCapacity(
  content: ContentStore,
  iid: number,
  fitted: readonly FittedMod[],
): number | null {
  const eq = equipableOf(content, iid);
  if (!eq?.ammo) return null;
  if (!takesMods(content, iid)) return eq.ammo.magazineSize ?? 0;
  return resolveWeapon(content, iid, fitted)?.magazineSize ?? 0;
}

/** What a newly created weapon has fitted (the slots' default= mods). */
export function defaultFitted(content: ContentStore, iid: number): FittedMod[] {
  const out: FittedMod[] = [];
  for (const slot of weaponSlots(content, iid)) {
    const modIid = slot.default ? modIidByKey(content, slot.default) : 0;
    if (modIid) out.push({ slot: slotIndex(slot.type), iid: modIid });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** `fitted` with `slot` holding `iid` (0 empties it), in slot order. */
export function withMod(fitted: readonly FittedMod[], slot: number, iid: number): FittedMod[] {
  const out = fitted.filter((f) => f.slot !== slot);
  if (iid) out.push({ slot, iid });
  return out.sort((a, b) => a.slot - b.slot);
}

/** The carried items that are mods this weapon accepts in `slot`. */
export function fittingMods(
  content: ContentStore,
  weaponIid: number,
  slot: ModSlotName,
  items: readonly InventoryItem[],
): InventoryItem[] {
  const def = weaponSlots(content, weaponIid).find((s) => s.type === slot);
  if (!def || !content.has('items')) return [];
  const keys = new Set(def.accepts);
  return items.filter(
    (it) => it.iid > 0 && keys.has(content.byId('items', it.iid)?.weaponMod?.key ?? ''),
  );
}

/** The slot `modIid` would go in on this weapon, or null when it does not fit. */
export function slotForMod(
  content: ContentStore,
  weaponIid: number,
  modIid: number,
): ModSlotName | null {
  const key = content.has('items') ? content.byId('items', modIid)?.weaponMod?.key : undefined;
  if (!key) return null;
  return weaponSlots(content, weaponIid).find((s) => s.accepts.includes(key))?.type ?? null;
}

export interface StatRow {
  key: StatName | AimStatName | 'magazineSize';
  label: string;
  value: string;
  /** The preview's change, in the row's own units ("+0.4 s"), when there is one. */
  delta?: string;
  better?: boolean;
}

interface RowSpec {
  key: StatName | AimStatName | 'magazineSize';
  label: string;
  /** NaN hides the row: the aim rows of a weapon that cannot aim. */
  show: (s: WeaponStats) => number;
  fmt: (n: number) => string;
  higherIsBetter: boolean;
}

const ROWS: readonly RowSpec[] = [
  {
    key: 'damage',
    label: 'Damage',
    show: (s) => s.damage,
    fmt: (n) => String(Math.round(n)),
    higherIsBetter: true,
  },
  {
    key: 'fireDelayMs',
    label: 'Fire rate',
    show: (s) => 60000 / s.fireDelayMs,
    fmt: (n) => `${Math.round(n)} rpm`,
    higherIsBetter: true,
  },
  {
    key: 'magazineSize',
    label: 'Magazine',
    show: (s) => s.magazineSize,
    fmt: (n) => String(Math.round(n)),
    higherIsBetter: true,
  },
  {
    key: 'reloadMs',
    label: 'Reload',
    show: (s) => s.reloadMs / 1000,
    fmt: (n) => `${n.toFixed(1)} s`,
    higherIsBetter: false,
  },
  {
    key: 'spread',
    label: 'Spread',
    show: (s) => (s.spread * 180) / Math.PI,
    fmt: (n) => `${n.toFixed(1)}°`,
    higherIsBetter: false,
  },
  {
    key: 'range',
    label: 'Range',
    show: (s) => s.range,
    fmt: (n) => String(Math.round(n)),
    higherIsBetter: true,
  },
  {
    key: 'bulletSpeed',
    label: 'Bullet speed',
    show: (s) => s.bulletSpeed,
    fmt: (n) => `×${n.toFixed(2)}`,
    higherIsBetter: true,
  },
  {
    key: 'recoil',
    label: 'Recoil',
    show: (s) => s.recoil,
    fmt: (n) => n.toFixed(2),
    higherIsBetter: false,
  },
  {
    key: 'knockback',
    label: 'Knockback',
    show: (s) => s.knockback,
    fmt: (n) => n.toFixed(2),
    higherIsBetter: true,
  },
  {
    key: 'drawMs',
    label: 'Draw',
    show: (s) => s.drawMs / 1000,
    fmt: (n) => `${n.toFixed(2)} s`,
    higherIsBetter: false,
  },
  {
    key: 'aimSpread',
    label: 'Aimed spread',
    show: (s) => (s.aim ? (s.aim.aimSpread * 180) / Math.PI : NaN),
    fmt: (n) => `${n.toFixed(1)}°`,
    higherIsBetter: false,
  },
  {
    key: 'aimMove',
    label: 'Aimed walk',
    show: (s) => (s.aim ? s.aim.aimMove * 100 : NaN),
    fmt: (n) => `${Math.round(n)}%`,
    higherIsBetter: true,
  },
  {
    key: 'aimMs',
    label: 'Aim time',
    show: (s) => (s.aim ? s.aim.aimMs / 1000 : NaN),
    fmt: (n) => `${n.toFixed(2)} s`,
    higherIsBetter: false,
  },
];

/** The rows the Mods window and the weapon tooltip show. `ammo` turns Magazine into "12/30". */
export function statRows(current: WeaponStats, preview?: WeaponStats, ammo?: number): StatRow[] {
  return ROWS.filter((r) => !Number.isNaN(r.show(current))).map((r) => {
    const now = r.show(current);
    const shown = r.fmt(now);
    const row: StatRow = {
      key: r.key,
      label: r.label,
      value: r.key === 'magazineSize' && ammo !== undefined ? `${ammo}/${shown}` : shown,
    };
    if (preview) {
      const next = r.show(preview);
      if (r.fmt(next) !== shown) {
        const diff = next - now;
        row.delta = `${diff > 0 ? '+' : '−'}${r.fmt(Math.abs(diff))}`;
        row.better = r.higherIsBetter ? diff > 0 : diff < 0;
      }
    }
    return row;
  });
}

export interface ArtLayer {
  src: string;
  left: number;
  top: number;
  width: number;
  height: number;
  z: number;
}
export interface ArtSpot {
  slot: ModSlotName;
  left: number;
  top: number;
}
/** Percent positions inside a box of the given aspect ratio (width / height). */
export interface ArtLayout {
  aspect: number;
  layers: ArtLayer[];
  spots: ArtSpot[];
}

const DRAW_ORDER: readonly string[] = [
  'stock',
  'magazine',
  'body',
  'handguard',
  'optic',
  'muzzle',
  'underbarrel',
  'side',
];

function box(text: unknown): [number, number, number, number] | null {
  const n = String(text ?? '')
    .trim()
    .split(/\s+/)
    .map(Number);
  return n.length === 4 && n.every(Number.isFinite) ? [n[0]!, n[1]!, n[2]!, n[3]!] : null;
}

/** The weapon's side view with the fitted parts on it, or null when it has no art. */
export function artLayout(
  content: ContentStore,
  weaponIid: number,
  fitted: readonly FittedMod[],
): ArtLayout | null {
  const art = equipableOf(content, weaponIid)?.client?.modArt;
  const frame = box(art?.frame);
  const body = box(art?.bodyBox);
  if (!art || !frame || !body) return null;
  const [fx, fy, fw, fh] = frame;
  const place = (x: number, y: number, w: number, h: number) => ({
    left: ((x - fx) / fw) * 100,
    top: ((y - fy) / fh) * 100,
    width: (w / fw) * 100,
    height: (h / fh) * 100,
  });
  const anchors = new Map((art.anchor ?? []).map((a) => [a.slot, a]));
  const layers: ArtLayer[] = [
    { src: `/img/${art.body}`, ...place(...body), z: DRAW_ORDER.indexOf('body') },
  ];
  for (const f of fitted) {
    const slot = slotName(f.slot);
    const anchor = slot ? anchors.get(slot) : undefined;
    const part = modByIid(content, f.iid)?.client;
    const partBox = box(part?.box);
    if (!slot || !anchor || !part?.art || !partBox) continue;
    const [minX, minY, w, h] = partBox;
    layers.push({
      src: `/img/${part.art}`,
      ...place(anchor.x - (part.anchorX ?? 0) + minX, anchor.y - (part.anchorY ?? 0) + minY, w, h),
      z: DRAW_ORDER.indexOf(slot),
    });
  }
  layers.sort((a, b) => a.z - b.z);
  const spots = weaponSlots(content, weaponIid).flatMap((s) => {
    const a = anchors.get(s.type);
    return a ? [{ slot: s.type, left: ((a.x - fx) / fw) * 100, top: ((a.y - fy) / fh) * 100 }] : [];
  });
  return { aspect: fw / fh, layers, spots };
}
