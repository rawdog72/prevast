// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { ContentStore } from '../content/store';
import {
  craftAreas,
  craftRecipes,
  recipesForArea,
  skillState,
  skillTabs,
  tabHasAffordable,
  skillCostOf,
  canCraft,
  craftDurationMs,
  fuelEstimateMs,
  stationFuel,
} from './craft-model';
import { InventoryStore } from './inventory-store';

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      wood: { key: 'wood', id: 1, clientItemId: 1, name: 'Wood', properties: { stack: 255 } },
      stone: { key: 'stone', id: 2, clientItemId: 2, name: 'Stone', properties: { stack: 255 } },
      shaped_metal: {
        key: 'shaped_metal',
        id: 8,
        clientItemId: 8,
        name: 'Shaped Metal',
        properties: { stack: 255 },
      },
      hatchet: {
        key: 'hatchet',
        id: 15,
        clientItemId: 15,
        name: 'Hatchet',
        properties: { stack: 1 },
        skill: { type: 'tool' },
        crafting: {
          recipe: {
            ingredient: [
              { itemKey: 'wood', amount: 10 },
              { itemKey: 'stone', amount: 2 },
            ],
          },
          stations: { station: [{ key: 'player', timeMs: 4000 }] },
        },
        client: { icon: 'inv-hachet' },
      },
      metal_pickaxe: {
        key: 'metal_pickaxe',
        id: 17,
        clientItemId: 17,
        name: 'Metal Pickaxe',
        properties: { stack: 1 },
        skill: { type: 'tool', requiredLevel: 6, skillCost: 1 },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'shaped_metal', amount: 6 }] },
          stations: { station: [{ key: 'workbench', timeMs: 15000 }] },
        },
        client: { icon: 'inv-steel-pickaxe' },
      },
      metal_axe: {
        key: 'metal_axe',
        id: 18,
        clientItemId: 18,
        name: 'Metal Axe',
        properties: { stack: 1 },
        skill: { type: 'tool', requiredLevel: 8, skillCost: 1, prerequisite: 'metal_pickaxe' },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'shaped_metal', amount: 8 }] },
          stations: { station: [{ key: 'workbench', timeMs: 15000 }] },
        },
        client: { icon: 'inv-stone-axe' },
      },
      iron: {
        key: 'iron',
        id: 3,
        clientItemId: 3,
        name: 'Iron',
        properties: { stack: 255 },
        skill: { type: 'mineral' },
        crafting: { extractor: { timeMs: 120000, outputMin: 4, outputMax: 12 } },
        client: { icon: 'inv-steel' },
      },
      inv4: {
        key: 'inv4',
        id: 165,
        clientItemId: 165,
        name: 'Inventory 4',
        properties: {},
        skill: { type: 'skill', requiredLevel: 10, skillCost: 2 },
        bag: { addSlots: 2 },
        client: { icon: 'skill-inv4' },
      },
      odd_thing: {
        key: 'odd_thing',
        id: 199,
        clientItemId: 199,
        name: 'Odd Thing',
        properties: {},
        skill: { type: 'mystery', requiredLevel: 1, skillCost: 1 },
        crafting: { recipe: { ingredient: [{ itemKey: 'wood', amount: 1 }] } },
      },
      stone_wall: {
        key: 'stone_wall',
        id: 28,
        clientItemId: 28,
        name: 'Stone Wall',
        properties: { stack: 255 },
        skill: { type: 'building', requiredLevel: 3, skillCost: 1 },
        crafting: {
          yield: 2,
          recipe: { ingredient: [{ itemKey: 'stone', amount: 20 }] },
          stations: {
            station: [
              { key: 'workbench', timeMs: 8000 },
              { key: 'player', timeMs: 12000 },
            ],
          },
        },
        client: { icon: 'inv-stone-wall' },
      },
      shaped_uranium: {
        key: 'shaped_uranium',
        id: 190,
        clientItemId: 190,
        name: 'Shaped Uranium',
        properties: { stack: 255 },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'stone', amount: 1 }] },
          stations: { station: [{ key: 'smelter', timeMs: 10000 }] },
        },
      },
    },
  });
  store.load({
    name: 'objects',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      workbench: {
        key: 'workbench',
        itemKey: 'workbench',
        category: 'station',
        healthMax: 500,
        layer: 'top',
        station: { key: 'workbench', areaId: 2 },
      },
      smelter: {
        key: 'smelter',
        category: 'station',
        healthMax: 500,
        layer: 'top',
        station: { key: 'smelter', areaId: 6 },
        fuel: { itemKey: 'wood', burnDurationPerUnitMs: 15000, addAmount: 15 },
      },
      extractor: {
        key: 'extractor',
        category: 'station',
        healthMax: 500,
        layer: 'top',
        station: { key: 'extractor', areaId: 10 },
      },
    },
  });
  store.load({
    name: 'skills',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      skill: { key: 'skill', name: 'Skills', icon: 'skill-button' },
      building: { key: 'building', name: 'Building', icon: 'building-button' },
      tool: { key: 'tool', name: 'Tools', icon: 'tool-button' },
      mineral: { key: 'mineral', name: 'Resources', icon: 'resources-button' },
    },
  });
  store.load({
    name: 'config',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      mode: 'survival',
      maxPlayers: 255,
      maxClans: 18,
      clanSize: 9,
      clanNameMaxLength: 5,
      clanActionDelayMs: 2000,
      mapWidth: 150,
      mapHeight: 150,
      tileSize: 100,
      dayCycleMs: 960000,
      craftSpeed: 0.5,
      inventorySlots: 8,
      chatMaxLength: 100,
      nicknameMaxLength: 16,
      passwordMaxLength: 16,
      xpStart: 900,
      xpGrowth: 1.105,
      maxLevel: 200,
      craftQueueSize: 4,
      chestMaxSlots: 4,
      interactionRange: 100,
      lootPickupRange: 60,
      fuelMaxUnits: 254,
    },
  });
  return store;
}

describe('craft model (old client buildCraftList / buildSkillList / _CheckSkillState)', () => {
  const store = content();

  it('lists areas from the objects table with "By hand" first, and recipes with their stations resolved to areas', () => {
    expect(craftAreas(store).map((a) => `${a.id}:${a.key}`)).toEqual([
      '0:player',
      '2:workbench',
      '6:smelter',
      '10:extractor',
    ]);
    const recipes = craftRecipes(store);
    const wall = recipes.find((r) => r.key === 'stone_wall')!;
    expect(wall.stations.map((s) => `${s.areaId}:${s.timeMs}`)).toEqual(['2:8000', '0:12000']);
    expect(wall.ingredients).toEqual([{ iid: 2, key: 'stone', name: 'Stone', amount: 20 }]);
    expect(wall.yield).toBe(2);
    expect(wall.category).toBe('building');
    expect(recipes.find((r) => r.key === 'metal_axe')!.prerequisite).toEqual({
      iid: 17,
      name: 'Metal Pickaxe',
    });
  });

  it('an area lists the recipes with a station there that are unlocked (no skill, or bought)', () => {
    const recipes = craftRecipes(store);
    expect(recipesForArea(recipes, 0, new Set()).map((r) => r.key)).toEqual(['hatchet']);
    expect(recipesForArea(recipes, 0, new Set([28])).map((r) => r.key)).toEqual([
      'hatchet',
      'stone_wall',
    ]);
    expect(recipesForArea(recipes, 2, new Set([17, 28])).map((r) => r.key)).toEqual([
      'metal_pickaxe',
      'stone_wall',
    ]);
  });

  it('canCraft needs every ingredient in the inventory', () => {
    const recipes = craftRecipes(store);
    const hatchet = recipes.find((r) => r.key === 'hatchet')!;
    const inventory = new InventoryStore();
    inventory.setAllSlots([
      { iid: 1, count: 10, uid: 1, ammo: 0 },
      { iid: 2, count: 1, uid: 2, ammo: 0 },
    ]);
    expect(canCraft(hatchet, inventory)).toBe(false);
    inventory.setAllSlots([
      { iid: 1, count: 10, uid: 1, ammo: 0 },
      { iid: 2, count: 2, uid: 2, ammo: 0 },
    ]);
    expect(canCraft(hatchet, inventory)).toBe(true);
  });

  it('perks with no recipe and extractor jobs with no ingredients are listed too', () => {
    const recipes = craftRecipes(store);
    const perk = recipes.find((r) => r.key === 'inv4')!;
    expect(perk.kind).toBe('perk');
    expect(perk.stations).toEqual([]);
    expect(perk.skillCost).toBe(2);
    const iron = recipes.find((r) => r.key === 'iron')!;
    expect(iron.kind).toBe('extractor');
    expect(iron.stations).toEqual([{ areaId: 10, key: 'extractor', timeMs: 120000 }]);
    expect(iron.ingredients).toEqual([]);
    expect(iron.yieldRange).toEqual([4, 12]);
    expect(recipesForArea(recipes, 10, new Set()).map((r) => r.key)).toEqual(['iron']);
    // A perk is never craftable anywhere.
    expect(recipesForArea(recipes, 0, new Set([165])).map((r) => r.key)).toEqual(['hatchet']);
    // Unlocked perks cost their real price.
    expect(skillCostOf(recipes)(165)).toBe(2);
    expect(skillCostOf(recipes)(17)).toBe(1);
  });

  it('skill tabs come from the skills table in its order; unknown types land under Other', () => {
    const recipes = craftRecipes(store);
    const tabs = skillTabs(store, recipes);
    expect(tabs.map((t) => `${t.key}:${t.name}:${t.icon}`)).toEqual([
      'skill:Skills:skill-button',
      'building:Building:building-button',
      'tool:Tools:tool-button',
      'mineral:Resources:resources-button',
      'other:Other:skill-button',
    ]);
    // Free recipes are listed beside the ones to unlock, so a tab shows all it can make.
    expect(tabs[2]!.recipes.map((r) => r.key)).toEqual(['hatchet', 'metal_pickaxe', 'metal_axe']);
    expect(tabs[3]!.recipes.map((r) => r.key)).toEqual(['iron']);
    expect(tabs[4]!.recipes.map((r) => r.key)).toEqual(['odd_thing']);
    // A free recipe with no skill type belongs to no tab (and is no reason for Other).
    expect(tabs.some((t) => t.recipes.some((r) => r.key === 'shaped_uranium'))).toBe(false);
    const tool = tabs[2]!;
    expect(tabHasAffordable(tool, { level: 6, points: 1, unlocked: new Set() })).toBe(true);
    expect(tabHasAffordable(tool, { level: 6, points: 0, unlocked: new Set() })).toBe(false);
    expect(tabHasAffordable(tool, { level: 5, points: 3, unlocked: new Set() })).toBe(false);
  });

  it('counts down a partially burned server snapshot through unit boundaries and clamps at zero', () => {
    expect(fuelEstimateMs(32000, 1000, 1000)).toBe(32000);
    expect(fuelEstimateMs(32000, 1000, 6000)).toBe(27000);
    expect(fuelEstimateMs(32000, 1000, 40000)).toBe(0);
    expect(fuelEstimateMs(32000, 1000, 0)).toBe(32000);
    expect(fuelEstimateMs(0, 1000, 1000)).toBe(0);
    expect(stationFuel(store, 6)).toEqual({
      itemIid: 1,
      itemName: 'Wood',
      addAmount: 15,
      burnMs: 15000,
      maxUnits: 254,
    });
    expect(stationFuel(store, 2)).toBeUndefined();
  });

  it('state and reasons follow the old client _CheckSkillState', () => {
    const recipes = craftRecipes(store);

    const pickaxe = recipes.find((r) => r.key === 'metal_pickaxe')!;
    const axe = recipes.find((r) => r.key === 'metal_axe')!;
    expect(skillState(pickaxe, { level: 5, points: 3, unlocked: new Set() })).toEqual({
      state: 'locked',
      reasons: ['Require level 6 or higher'],
    });
    expect(skillState(pickaxe, { level: 6, points: 0, unlocked: new Set() })).toEqual({
      state: 'locked',
      reasons: ['Cost 1 skill point'],
    });
    expect(skillState(pickaxe, { level: 6, points: 1, unlocked: new Set() })).toEqual({
      state: 'available',
      reasons: [],
    });
    expect(skillState(pickaxe, { level: 6, points: 1, unlocked: new Set([17]) })).toEqual({
      state: 'unlocked',
      reasons: [],
    });
    expect(skillState(axe, { level: 8, points: 1, unlocked: new Set() })).toEqual({
      state: 'locked',
      reasons: ['Unlock Metal Pickaxe before'],
    });
    expect(skillState(axe, { level: 2, points: 0, unlocked: new Set() })).toEqual({
      state: 'locked',
      reasons: ['Require level 8 or higher', 'Unlock Metal Pickaxe before', 'Cost 1 skill point'],
    });
    const hatchet = recipes.find((r) => r.key === 'hatchet')!;
    expect(skillState(hatchet, { level: 0, points: 0, unlocked: new Set() }).state).toBe(
      'unlocked',
    );
  });

  it('craft duration is the station time scaled by the mode craft speed', () => {
    const recipes = craftRecipes(store);
    const wall = recipes.find((r) => r.key === 'stone_wall')!;
    expect(craftDurationMs(store, wall, 0)).toBe(6000);
    expect(craftDurationMs(store, wall, 2)).toBe(4000);
    expect(craftDurationMs(store, wall, 6)).toBe(0);
  });
});
