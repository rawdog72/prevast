// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/craft-model.ts
// The crafting rules the old client kept in buildCraftList / buildSkillList /
// _CheckSkillState / updateRecipeAvailability, read from the content tables
// instead of a hardcoded INVENTORY: which recipes a station area offers, what
// they need, and what it takes to unlock the ones that are skills. Pure
// functions over ContentStore + InventoryStore; the server still decides.

import type { ContentStore } from '../content/store';
import type { InventoryStore } from './inventory-store';

/** Area 0 is "by hand"; every other area is a station object's areaId. */
export const HAND_AREA = 0;
const HAND_STATION_KEY = 'player';
/** The extractor job (`<crafting><extractor/>`) is a station with this key on the server (item.cpp). */
const EXTRACTOR_STATION_KEY = 'extractor';

export interface CraftArea {
  id: number;
  key: string;
  name: string;
}

export interface CraftIngredient {
  iid: number;
  key: string;
  name: string;
  amount: number;
}

export interface CraftStation {
  areaId: number;
  key: string;
  timeMs: number;
}

/**
 * recipe: made from ingredients (by hand or at a station); extractor: a
 * station job with no recipe that rolls its output (stone, iron at the
 * Extractor); perk: a skill with nothing to craft (the bag and builder
 * skills), only ever seen in the skill tabs.
 */
export type CraftKind = 'recipe' | 'extractor' | 'perk';

export interface CraftRecipe {
  iid: number;
  key: string;
  name: string;
  icon?: string;
  kind: CraftKind;
  /** items[].skill.type -- the skill tab it lives under; none without a <skill>. */
  category?: string;
  stations: CraftStation[];
  ingredients: CraftIngredient[];
  yield: number;
  /** An extractor's roll, outputMin..outputMax. */
  yieldRange?: [number, number];
  /** Present when the recipe must be unlocked as a skill. */
  requiredLevel?: number;
  skillCost: number;
  prerequisite?: { iid: number; name: string };
}

export type SkillStateName = 'unlocked' | 'available' | 'locked';

export interface SkillState {
  state: SkillStateName;
  /** Old client info panel lines, in its order. */
  reasons: string[];
}

export interface SkillContext {
  level: number;
  points: number;
  unlocked: ReadonlySet<number>;
}

/** A skill tab (skills table row) with what it has to unlock, in items-table order. */
export interface SkillTab {
  key: string;
  name: string;
  /** Old `img/<icon>-out.png` button sprite. */
  icon: string;
  recipes: CraftRecipe[];
}

/** Where an item with a skill type the skills table does not declare lands (never by design). */
const FALLBACK_TAB = { key: 'other', name: 'Other', icon: 'skill-button' } as const;

function titleCase(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Station areas from the objects table (areaId order), "By hand" first. */
export function craftAreas(content: ContentStore): CraftArea[] {
  const areas: CraftArea[] = [{ id: HAND_AREA, key: HAND_STATION_KEY, name: 'By hand' }];
  if (content.has('objects')) {
    const seen = new Set<number>();
    for (const obj of Object.values(content.table('objects'))) {
      const station = obj.station;
      if (!station || seen.has(station.areaId)) continue;
      seen.add(station.areaId);
      const item =
        obj.itemKey && content.has('items') ? content.byKey('items', obj.itemKey) : undefined;
      areas.push({ id: station.areaId, key: station.key, name: item?.name ?? titleCase(obj.key) });
    }
    areas.sort((a, b) => a.id - b.id);
  }
  return areas;
}

function stationAreaIds(content: ContentStore): Map<string, number> {
  const map = new Map<string, number>([[HAND_STATION_KEY, HAND_AREA]]);
  if (content.has('objects')) {
    for (const obj of Object.values(content.table('objects'))) {
      if (obj.station) map.set(obj.station.key, obj.station.areaId);
    }
  }
  return map;
}

/**
 * Every craftable item and every skill, in items-table order: recipes and
 * extractor jobs (anything with <crafting>) plus the perks that are only a
 * <skill requiredLevel> with nothing to make.
 */
export function craftRecipes(content: ContentStore): CraftRecipe[] {
  if (!content.has('items')) return [];
  const areaByStation = stationAreaIds(content);
  const items = content.table('items');
  const recipes: CraftRecipe[] = [];
  for (const item of Object.values(items)) {
    const crafting = item.crafting;
    const isPerk = !crafting && item.skill?.requiredLevel !== undefined;
    if (!crafting && !isPerk) continue;
    const stations: CraftStation[] = [];
    for (const s of crafting?.stations?.station ?? []) {
      const areaId = areaByStation.get(s.key);
      if (areaId !== undefined) stations.push({ areaId, key: s.key, timeMs: s.timeMs ?? 0 });
    }
    const extractor = crafting?.extractor;
    if (extractor) {
      const areaId = areaByStation.get(EXTRACTOR_STATION_KEY);
      if (areaId !== undefined)
        stations.push({ areaId, key: EXTRACTOR_STATION_KEY, timeMs: extractor.timeMs });
    }
    const ingredients: CraftIngredient[] = (crafting?.recipe?.ingredient ?? []).map((ing) => {
      const ingItem = content.byKey('items', ing.itemKey);
      return {
        iid: ingItem?.id ?? 0,
        key: ing.itemKey,
        name: ingItem?.name ?? ing.itemKey,
        amount: ing.amount,
      };
    });
    const prereqItem = item.skill?.prerequisite
      ? content.byKey('items', item.skill.prerequisite)
      : undefined;
    recipes.push({
      iid: item.id,
      key: item.key,
      name: item.name || item.key,
      icon: item.client?.icon,
      kind: isPerk ? 'perk' : extractor && !crafting?.recipe ? 'extractor' : 'recipe',
      category: item.skill?.type,
      stations,
      ingredients,
      yield: crafting?.yield ?? 1,
      yieldRange: extractor ? [extractor.outputMin, extractor.outputMax] : undefined,
      requiredLevel: item.skill?.requiredLevel,
      skillCost: item.skill?.skillCost ?? 0,
      prerequisite: prereqItem
        ? { iid: prereqItem.id, name: prereqItem.name || prereqItem.key }
        : undefined,
    });
  }
  return recipes;
}

export function needsUnlock(recipe: CraftRecipe): boolean {
  return recipe.requiredLevel !== undefined;
}

/** buildCraftList: recipes with a station in this area that are unlocked (or need no unlock). */
export function recipesForArea(
  recipes: CraftRecipe[],
  areaId: number,
  unlocked: ReadonlySet<number>,
): CraftRecipe[] {
  return recipes.filter(
    (r) => r.stations.some((s) => s.areaId === areaId) && (!needsUnlock(r) || unlocked.has(r.iid)),
  );
}

/** updateRecipeAvailability: every ingredient present in the inventory. */
export function canCraft(recipe: CraftRecipe, inventory: InventoryStore): boolean {
  return recipe.ingredients.every((ing) => inventory.getItemCount(ing.iid) >= ing.amount);
}

const warnedTypes = new Set<string>();

/**
 * The skill tabs: the skills table in its order, each with every recipe of its
 * type -- the ones to unlock and the free ones (shown as unlocked), so a tab
 * says all that skill can make. Tabs with nothing are left out. A type
 * the table does not declare lands under a trailing "Other" tab (and warns
 * once) so unexpected content can never hide a skill.
 */
export function skillTabs(content: ContentStore, recipes: CraftRecipe[]): SkillTab[] {
  const rows = content.has('skills') ? Object.values(content.table('skills')) : [];
  const tabs: SkillTab[] = rows.map((s) => ({
    key: s.key,
    name: s.name,
    icon: s.icon,
    recipes: [],
  }));
  const known = new Set(tabs.map((t) => t.key));
  const other: SkillTab = { ...FALLBACK_TAB, recipes: [] };
  for (const r of recipes) {
    if (r.category === undefined) continue;
    if (known.has(r.category)) {
      tabs.find((t) => t.key === r.category)!.recipes.push(r);
    } else {
      if (!warnedTypes.has(r.category)) {
        warnedTypes.add(r.category);
        console.warn(`craft: skill type '${r.category}' (${r.key}) is not in the skills table`);
      }
      other.recipes.push(r);
    }
  }
  if (other.recipes.length > 0) tabs.push(other);
  return tabs.filter((t) => t.recipes.length > 0);
}

/** Old client: the bobbing icon on a tab -- here, a dot when something can be bought right now. */
export function tabHasAffordable(tab: SkillTab, ctx: SkillContext): boolean {
  return tab.recipes.some((r) => skillState(r, ctx).state === 'available');
}

/** What each unlocked iid cost, for InventoryStore.skillPointsLeft (perks included). */
export function skillCostOf(recipes: CraftRecipe[]): (iid: number) => number {
  const costs = new Map(recipes.map((r) => [r.iid, r.skillCost]));
  return (iid) => costs.get(iid) ?? 1;
}

/** _CheckSkillState plus the info-panel reasons the old client drew when locked. */
export function skillState(recipe: CraftRecipe, ctx: SkillContext): SkillState {
  if (!needsUnlock(recipe) || ctx.unlocked.has(recipe.iid))
    return { state: 'unlocked', reasons: [] };
  const reasons: string[] = [];
  if (recipe.requiredLevel! > ctx.level)
    reasons.push(`Require level ${recipe.requiredLevel} or higher`);
  if (recipe.prerequisite && !ctx.unlocked.has(recipe.prerequisite.iid))
    reasons.push(`Unlock ${recipe.prerequisite.name} before`);
  if (ctx.points < recipe.skillCost)
    reasons.push(`Cost ${recipe.skillCost} skill point${recipe.skillCost === 1 ? '' : 's'}`);
  return { state: reasons.length === 0 ? 'available' : 'locked', reasons };
}

/** Station time for this area scaled by the mode's craft speed (config.craftSpeed). */
export function craftDurationMs(
  content: ContentStore,
  recipe: CraftRecipe,
  areaId: number,
): number {
  const station = recipe.stations.find((s) => s.areaId === areaId);
  if (!station) return 0;
  const speed = content.has('config') ? content.config.craftSpeed : 1;
  return Math.round(station.timeMs * speed);
}

/**
 * Count down from the server's exact remaining time. Fuel stations burn
 * continuously, even with an empty queue. Every open/refill/unit update
 * supplies a fresh snapshot; the client only interpolates between them.
 */
export function fuelEstimateMs(remainingMs: number, statedAt: number, now: number): number {
  return Math.max(0, remainingMs - Math.max(0, now - statedAt));
}

export interface StationFuel {
  itemIid: number;
  itemName: string;
  addAmount: number;
  burnMs: number;
  maxUnits: number;
}

/** objects[].fuel for a station area, or undefined for a station that burns nothing. */
export function stationFuel(content: ContentStore, areaId: number): StationFuel | undefined {
  if (!content.has('objects')) return undefined;
  const fuel = content.stationForArea(areaId)?.fuel;
  if (!fuel) return undefined;
  const item = content.has('items') ? content.byKey('items', fuel.itemKey) : undefined;
  const maxUnits = content.has('config') ? (content.config.fuelMaxUnits ?? 254) : 254;
  return {
    itemIid: item?.id ?? 0,
    itemName: item?.name ?? titleCase(fuel.itemKey),
    addAmount: fuel.addAmount ?? 1,
    burnMs: fuel.burnDurationPerUnitMs,
    maxUnits,
  };
}
