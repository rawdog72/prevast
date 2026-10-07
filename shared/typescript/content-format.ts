// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The export contract shared by the two XML->JSON exporters (tools/content/xml-to-json.ts
// and apps/server/src/content/contentexport.cpp), the zod schema and the client store.
// Spec §4.2 plus plan decision D1. Change a constant here and mirror it in the C++.

export const XML_TABLES = [
  'npcs',
  'skills',
  'items',
  'resources',
  'equipables',
  'mods',
  'wearables',
  'kits',
  'objects',
  'furnitures',
  'projectiles',
  'agents',
  'structures',
  'conditions',
  'modes',
  'stats',
  'achievements',
] as const;
export type XmlTableName = (typeof XML_TABLES)[number];
export type ContentTableName = XmlTableName | 'config';
export const CONTENT_TABLES: readonly ContentTableName[] = [...XML_TABLES, 'config'];

export const CONTENT_PROTOCOL = 1;

export const TABLE_FILES: Record<XmlTableName, { file: string; root: string; entry: string }> = {
  // The craft window's skill tabs, in tab order; items bind to one by <skill type=>.
  npcs: { file: 'npcs.xml', root: 'npcs', entry: 'npc' },
  skills: { file: 'skills.xml', root: 'skills', entry: 'skill' },
  items: { file: 'items.xml', root: 'items', entry: 'item' },
  resources: { file: 'resources.xml', root: 'resources', entry: 'resource' },
  equipables: { file: 'equipables.xml', root: 'equipables', entry: 'equipable' },
  // Weapon mods; each is also an item, and weapons name them in <mods><slot>.
  mods: { file: 'mods.xml', root: 'mods', entry: 'mod' },
  wearables: { file: 'wearables.xml', root: 'wearables', entry: 'wearable' },
  kits: { file: 'kits.xml', root: 'kits', entry: 'kit' },
  objects: { file: 'objects.xml', root: 'objects', entry: 'object' },
  furnitures: { file: 'furnitures.xml', root: 'objects', entry: 'object' },
  projectiles: { file: 'projectiles.xml', root: 'projectiles', entry: 'projectile' },
  agents: { file: 'agents.xml', root: 'agents', entry: 'agent' },
  structures: { file: 'structures.xml', root: 'structures', entry: 'template' },
  conditions: { file: 'conditions.xml', root: 'conditions', entry: 'condition' },
  modes: { file: 'modes.xml', root: 'modes', entry: 'mode' },
  // Account progress (ProgressSystem). The export keeps only what a player may
  // see: no <count> rules, and nothing of a secret achievement but its id.
  stats: { file: 'stats.xml', root: 'stats', entry: 'stat' },
  achievements: { file: 'achievements.xml', root: 'achievements', entry: 'achievement' },
};

// Copied to `entry.id`; the original attribute stays (D1.6).
export const ID_ATTRIBUTE: Partial<Record<XmlTableName, string>> = {
  npcs: 'id',
  items: 'clientItemId',
  resources: 'id',
  equipables: 'idWeapon',
  wearables: 'skinId',
  projectiles: 'clientProjectileId',
  agents: 'sprite',
  modes: 'clientModeId',
  stats: 'id',
  achievements: 'id',
};

// Never copied from a base= entry (D1.5).
export const NON_INHERITED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'key',
  'abstract',
  'base',
  'itemKey',
]);

// parent>child pairs that are always arrays. A repeated pair not listed here is an
// export error, so this list cannot drift silently (D1.4).
export const ARRAY_PAIRS: ReadonlySet<string> = new Set([
  // server tables
  'recipe>ingredient',
  'stations>station',
  'craftBonus>item',
  'drops>item',
  'items>item',
  'contents>item',
  'tools>tool',
  'types>type',
  'areaEffects>areaEffect',
  'consumable>effect',
  'modifiers>modifier',
  'damageModifiers>modifier',
  'mods>slot',
  'mod>stat',
  'modArt>anchor',
  'stages>stage',
  'condition>stage',
  'brain>target',
  'abilities>ability',
  'karma>level',
  'gauges>gauge',
  'spawns>spawn',
  'spawn>structure',
  'spawn>agent',
  'ghoulRules>ghoul',
  'achievement>requires',
  'achievement>reward',
  // <client> (D2)
  'client>loot',
  'client>sound',
  'client>frame',
  'client>broken',
  'client>offset',
  'client>swing',
  'client>light',
  'client>on',
  'client>top',
  'client>hidden',
  'client>deployed',
  'client>wire',
  'client>variant',
  'client>type',
]);

// Same acceptance as xml_utils::detail::isNumber in the server: optional sign, digits with
// an optional fraction (or a bare fraction), optional exponent, nothing else.
export const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

// Same list as xml_utils::detail::isNameAttribute.
const NAME_ATTRIBUTES: ReadonlySet<string> = new Set([
  'key',
  'name',
  'prerequisite',
  'base',
  'channel',
  'spawnCreature',
  'ratesMs',
]);
export function isNameAttribute(name: string): boolean {
  return (name.length > 3 && name.endsWith('Key')) || NAME_ATTRIBUTES.has(name);
}

export type Scalar = string | number | boolean;
export type ContentValue = Scalar | ContentObject | ContentObject[];
export interface ContentObject {
  [property: string]: ContentValue;
}
export type ContentEntry = ContentObject;

export interface ContentTable<Entry = ContentEntry> {
  name: string;
  version: number;
  hash: string;
  attributes: Record<string, Scalar>;
  entries: Record<string, Entry>;
}

export interface ContentManifest {
  protocol: number;
  tables: Record<string, { version: number; hash: string }>;
}

export interface ContentPatch {
  name: string;
  fromVersion: number;
  toVersion: number;
  hash: string;
  patch: unknown;
}

export function parseScalar(name: string, value: string): Scalar {
  if (isNameAttribute(name)) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (NUMBER_RE.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`non-finite number in ${name}: ${value}`);
    return number;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

// `entries` is Record<string, ContentEntry> for XML tables and the flat config object for
// `config` (D1.7), hence the wider value type.
export function tableHash(
  attributes: Record<string, Scalar>,
  entries: Record<string, ContentValue>,
): string {
  return fnv1a64(canonicalJson({ attributes, entries }));
}
