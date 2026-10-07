// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { convertTable } from './xml-to-json';
import { buildConfigTable, parseConfigLua } from './config-table';

const LUA = `-- comment\nmapTilesX = 150\nmapTilesY = 120 -- trailing\ngameMode = "ghoul"\nmaxPlayers = 255\nclanActionDelay = 500\nallowClones = false\n`;
const MODES = `<modes><mode key="common" abstract="true"><clans enabled="true" maxMembers="9" maxClans="18"/></mode><mode key="ghoul" base="common" clientModeId="2" dayNightCycle="960000" craftSpeed="0.4"/></modes>`;

describe('config table', () => {
  it('parses top-level lua assignments', () => {
    expect(parseConfigLua(LUA)).toEqual({
      mapTilesX: 150,
      mapTilesY: 120,
      gameMode: 'ghoul',
      maxPlayers: 255,
      clanActionDelay: 500,
      allowClones: false,
    });
  });
  it('builds the config table from lua, the active mode and the constants', () => {
    const t = buildConfigTable({ configLua: LUA, modes: convertTable(MODES, 'modes') });
    expect(t.name).toBe('config');
    expect(t.entries).toMatchObject({
      mode: 'ghoul',
      mapWidth: 150,
      mapHeight: 120,
      maxPlayers: 255,
      maxClans: 18,
      clanSize: 9,
      dayCycleMs: 960000,
      craftSpeed: 0.4,
      clanActionDelayMs: 500,
      tileSize: 100,
      xpStart: 900,
      xpGrowth: 1.105,
      inventorySlots: 8,
      fuelMaxUnits: 254,
    });
    expect(t.hash).toMatch(/^[0-9a-f]{16}$/);
  });
  it('fails when the active mode is missing', () => {
    expect(() =>
      buildConfigTable({ configLua: 'gameMode = "nope"', modes: convertTable(MODES, 'modes') }),
    ).toThrow(/nope/);
  });
});

it('parses comments only outside quoted literals and accepts Lua number literals', () => {
  expect(
    parseConfigLua(
      `gameMode = 'survival--test' -- comment\nmapTilesX = +1.5e2; -- 150\nlabel = "a\\\"b"\nignored = math.random()\n`,
    ),
  ).toEqual({ gameMode: 'survival--test', mapTilesX: 150, label: 'a"b' });
});
