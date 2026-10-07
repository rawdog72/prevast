// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The `config` table, built here until the server exports it itself. Values come from
// config.lua, the active mode in modes.xml, and constants the server keeps in C++ (each
// cited so a server-side export can read the same place).
import { tableHash, type ContentTable, type Scalar } from '../../shared/typescript/content-format';
import { modeEntry, validateTable } from '../../shared/typescript/content-schema';

export const SERVER_CONSTANTS = {
  tileSize: 100, // definitions.h TILE_SIZE
  clanNameMaxLength: 5, // game_clans.cpp:51 name.length() > 5
  inventorySlots: 8, // inventory.cpp:30 slots.resize(8)
  chatMaxLength: 200, // definitions.h MAX_CHAT_LENGTH
  nicknameMaxLength: 16, // definitions.h MAX_NICKNAME_LENGTH comment: 16 characters
  passwordMaxLength: 16, // definitions.h MAX_LOGIN_PASSWORD_LENGTH comment: 16-char client cap
  xpStart: 900, // player.cpp Player::getRequiredXP
  xpGrowth: 1.105, // player.cpp Player::getRequiredXP
  maxLevel: 200, // player.h PLAYER_MAX_LEVEL
  craftQueueSize: 4, // definitions.h STATION_QUEUE_SIZE
  chestMaxSlots: 64, // definitions.h MAX_CHEST_SLOTS
  interactionRange: 150, // definitions.h INTERACTION_RANGE
  lootPickupRange: 200, // definitions.h LOOT_PICKUP_RANGE
  fuelMaxUnits: 254, // game.cpp playerAddFuel: currentFuelUnits >= 254 is full
  tradeRangeTiles: 2, // trade.h TRADE_RANGE_TILES; authoritative value also travels in TRADE_STATE
} as const;

export function parseConfigLua(text: string): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const line of text.split('\n')) {
    const m =
      /^\s*([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|true|false)\s*;?\s*(?:--.*)?$/.exec(
        line,
      );
    if (!m) continue;
    const raw = m[2]!;
    const str = /^["'](.*)["']$/.exec(raw);
    if (str)
      out[m[1]!] = str[1]!.replace(
        /\\([\\"'nrt])/g,
        (_, char: string) => ({ n: '\n', r: '\r', t: '\t' })[char] ?? char,
      );
    else if (raw === 'true' || raw === 'false') out[m[1]!] = raw === 'true';
    else if (Number.isFinite(Number(raw))) out[m[1]!] = Number(raw);
  }
  return out;
}

function need<T extends Scalar>(
  values: Record<string, Scalar>,
  key: string,
  type: 'string' | 'number',
): T {
  const v = values[key];
  if (typeof v !== type) throw new Error(`config.lua: '${key}' is missing or not a ${type}`);
  return v as T;
}

export function buildConfigTable(input: {
  configLua: string;
  modes: ContentTable;
}): ContentTable<Scalar> {
  const lua = parseConfigLua(input.configLua);
  const modeKey = need<string>(lua, 'gameMode', 'string');
  const rawMode = Object.hasOwn(input.modes.entries, modeKey)
    ? input.modes.entries[modeKey]
    : undefined;
  if (!rawMode) throw new Error(`modes.xml has no mode '${modeKey}' (config.lua gameMode)`);
  const mode = modeEntry.parse(rawMode);
  const clans = mode.clans;
  const entries: Record<string, Scalar> = {
    mode: modeKey,
    maxPlayers: need<number>(lua, 'maxPlayers', 'number'),
    maxClans: clans?.maxClans ?? 0,
    clanSize: clans?.maxMembers ?? 0,
    clanActionDelayMs: need<number>(lua, 'clanActionDelay', 'number'),
    mapWidth: need<number>(lua, 'mapTilesX', 'number'),
    mapHeight: need<number>(lua, 'mapTilesY', 'number'),
    dayCycleMs: mode.dayNightCycle,
    craftSpeed: mode.craftSpeed ?? 1,
    ...SERVER_CONSTANTS,
  };
  const table: ContentTable<Scalar> = {
    name: 'config',
    version: 1,
    hash: tableHash({}, entries),
    attributes: {},
    entries,
  };
  return validateTable('config', table);
}
