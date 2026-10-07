// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { convertTable } from './xml-to-json';

const ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<items>
  <!-- a comment mentioning <item key="ghost"> must be ignored -->
  <item clientItemId="1" key="wood" name="Wood">
    <properties stack="255" lootId="2" score="10"/>
  </item>
  <item clientItemId="15" key="hatchet" name="Hatchet">
    <properties stack="1" lootId="18" score="0"/>
    <equipable key="hatchet" equipTimeMs="1000"/>
    <crafting>
      <recipe>
        <ingredient itemKey="wood" amount="10" />
      </recipe>
      <stations>
        <station key="player" timeMs="5000" />
        <station key="workbench" timeMs="10000" />
      </stations>
    </crafting>
    <client description="Chops." icon="inv-hachet">
      <loot id="18" sprite="day-ground-hachet" scale="0.9" angle="0.5" amount="1"/>
    </client>
  </item>
</items>`;

const OBJECTS = `<objects>
  <object key="base_furniture" itemKey="furniture" category="furniture" healthMax="450" layer="mid" abstract="true">
    <transform width="100" height="100" collision="true" blocksProjectiles="true"/>
    <onDestroy><drops><item key="shaped_metal" amount="2"/></drops></onDestroy>
  </object>
  <object key="sofa0" base="base_furniture" itemKey="furniture" subtype="0" healthMax="500">
    <onDestroy><drops><item key="wood" amount="10"/></drops></onDestroy>
  </object>
  <object key="lamp" category="logic" healthMax="100" layer="mid">
    <logic type="lamp" ratesMs="500,1000"/>
  </object>
</objects>`;

describe('convertTable', () => {
  it('rejects missing keys, ambiguous attributes and invalid wire IDs', () => {
    expect(() => convertTable('<objects><object/></objects>', 'objects')).toThrow(/missing key/);
    expect(() => convertTable('<items><item key="x" clientItemId="1.5"/></items>', 'items')).toThrow(/clientItemId/);
    expect(() => convertTable('<objects><object key="x" client="lost"><client/></object></objects>', 'objects')).toThrow(/collision/);
  });

  it('handles dictionary keys without inherited properties and resolves only earlier bases', () => {
    const table = convertTable('<objects><object key="constructor"/><object key="__proto__"/></objects>', 'objects');
    expect(Object.keys(table.entries)).toEqual(['constructor', '__proto__']);
    expect(() => convertTable('<objects><object key="child" base="later"/><object key="later"/></objects>', 'objects')).toThrow(/not declared above/);
  });

  it('replaces a child block wholesale and does not inherit itemKey', () => {
    const table = convertTable('<objects><object key="base" abstract="true" itemKey="wood"><client a="1" b="2"/></object><object key="child" base="base"><client a="3"/></object></objects>', 'objects');
    expect(table.entries.child.client).toEqual({ a: 3 });
    expect(table.entries.child.itemKey).toBeUndefined();
  });
  it('exports entries keyed by key with lifted ids, typed scalars and array pairs', () => {
    const table = convertTable(ITEMS, 'items');
    expect(table.name).toBe('items');
    expect(table.version).toBe(1);
    expect(table.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(table.attributes).toEqual({});
    expect(Object.keys(table.entries)).toEqual(['wood', 'hatchet']);
    const hatchet = table.entries.hatchet!;
    expect(hatchet.id).toBe(15);
    expect(hatchet.clientItemId).toBe(15);
    expect(hatchet.properties).toEqual({ stack: 1, lootId: 18, score: 0 });
    expect(hatchet.equipable).toEqual({ key: 'hatchet', equipTimeMs: 1000 });
    expect(hatchet.crafting).toEqual({
      recipe: { ingredient: [{ itemKey: 'wood', amount: 10 }] },
      stations: {
        station: [
          { key: 'player', timeMs: 5000 },
          { key: 'workbench', timeMs: 10000 },
        ],
      },
    });
    expect(hatchet.client).toEqual({
      description: 'Chops.',
      icon: 'inv-hachet',
      loot: [{ id: 18, sprite: 'day-ground-hachet', scale: 0.9, angle: 0.5, amount: 1 }],
    });
  });

  it('resolves base= inheritance, drops abstract entries and never inherits itemKey', () => {
    const table = convertTable(OBJECTS, 'furnitures');
    expect(Object.keys(table.entries)).toEqual(['sofa0', 'lamp']);
    const sofa = table.entries.sofa0!;
    expect(sofa.base).toBeUndefined();
    expect(sofa.abstract).toBeUndefined();
    expect(sofa.category).toBe('furniture');
    expect(sofa.healthMax).toBe(500);
    expect(sofa.itemKey).toBe('furniture');
    expect(sofa.transform).toEqual({ width: 100, height: 100, collision: true, blocksProjectiles: true });
    expect(sofa.onDestroy).toEqual({ drops: { item: [{ key: 'wood', amount: 10 }] } });
    expect(table.entries.lamp!.logic).toEqual({ type: 'lamp', ratesMs: '500,1000' });
  });

  it('fails on a repeated pair that is not declared', () => {
    const bad = `<objects><object key="x" category="c" healthMax="1" layer="mid"><logic type="a"/><logic type="b"/></object></objects>`;
    expect(() => convertTable(bad, 'objects')).toThrow(/object>logic/);
  });

  it('fails on a missing id attribute and on a duplicate key', () => {
    expect(() => convertTable(`<items><item key="x"/></items>`, 'items')).toThrow(/clientItemId/);
    expect(() =>
      convertTable(`<items><item clientItemId="1" key="x"/><item clientItemId="2" key="x"/></items>`, 'items'),
    ).toThrow(/duplicate key 'x'/);
  });

  it('exports the skill tabs in file order with their button sprite', () => {
    const SKILLS = `<skills>
  <skill key="skill" name="Skills" icon="skill-button"/>
  <skill key="drug" name="Medicine" icon="medecine-button"/>
</skills>`;
    const t = convertTable(SKILLS, 'skills');
    expect(Object.keys(t.entries)).toEqual(['skill', 'drug']);
    expect(t.entries.drug).toEqual({ key: 'drug', name: 'Medicine', icon: 'medecine-button' });
  });

  it('keys kits by position and keeps root attributes and text content', () => {
    const kits = convertTable(
      `<kits deathRewardExpiryMinutes="180"><kit level="0"><items><item key="wood" amount="1"/></items></kit><kit level="5"/></kits>`,
      'kits',
    );
    expect(kits.attributes).toEqual({ deathRewardExpiryMinutes: 180 });
    expect(Object.keys(kits.entries)).toEqual(['0', '1']);
    const structures = convertTable(
      `<structures><template key="house0" width="3"><code>\n  !b=27:0:0:0\n  !b=62:1:0:0\n</code></template></structures>`,
      'structures',
    );
    expect(structures.entries.house0!.code).toEqual({ text: '!b=27:0:0:0\n  !b=62:1:0:0' });
  });
});
