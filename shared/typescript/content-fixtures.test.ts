// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_TABLES } from './content-format';
import { validateTable } from './content-schema';

describe('tests/fixtures/content', () => {
  const files = readdirSync('tests/fixtures/content')
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
  it('has one file per table', () => {
    expect(files).toEqual([...CONTENT_TABLES].sort());
  });
  it.each(files)('%s validates and has the expected entry count', (name) => {
    const table = validateTable(
      name,
      JSON.parse(readFileSync(`tests/fixtures/content/${name}.json`, 'utf8')),
    );
    const expected: Record<string, number> = {
      skills: 10,
      npcs: 4,
      items: 171,
      resources: 14,
      equipables: 54,
      mods: 12,
      wearables: 16,
      kits: 32,
      objects: 62,
      furnitures: 59,
      projectiles: 9,
      agents: 9,
      structures: 12,
      conditions: 13,
      modes: 3,
      stats: 11,
      achievements: 12,
      config: 24,
    };
    expect(Object.keys(table.entries)).toHaveLength(expected[name]!);
  });
  it('carries the migrated presentation data', () => {
    const items = validateTable(
      'items',
      JSON.parse(readFileSync('tests/fixtures/content/items.json', 'utf8')),
    );
    expect((items.entries.hatchet as { client: { icon: string } }).client.icon).toBe('inv-hachet');
    expect(items.entries.granade!.name).toBe('Grenade');
    const objects = validateTable(
      'objects',
      JSON.parse(readFileSync('tests/fixtures/content/objects.json', 'utf8')),
    );
    expect((objects.entries.wood_wall as { client: { render: string } }).client.render).toBe(
      'wall',
    );
  });

  it('declares the reveal range of the objects the server hides from strangers', () => {
    const objects = validateTable(
      'objects',
      JSON.parse(readFileSync('tests/fixtures/content/objects.json', 'utf8')),
    );
    const conceal = (key: string) =>
      (objects.entries[key] as { conceal?: { tiles: number } }).conceal;
    for (const key of ['landmine', 'cable0', 'cable4', 'gate_or', 'gate_timer', 'gate_xor']) {
      expect(conceal(key), key).toEqual({ tiles: 3 });
    }
    for (const key of ['switch', 'platform', 'lamp', 'wood_wall']) {
      expect(conceal(key), key).toBeUndefined();
    }
  });
});
