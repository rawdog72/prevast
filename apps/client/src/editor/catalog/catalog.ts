// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The editor's placeable catalog, derived from the same content tables the game renders from.
// Every entry says how to draw a placement (protocol layer and wire bits for the game
// renderer), where it sits (grid slot, footprint), what collides, and which per-instance
// properties may be overridden. Nothing here is typed by hand per object: a new object in
// data/XML shows up in the palette with the right behaviour or not at all.
import type { ContentStore } from '../../content/store';
import type { ObjectEntry, ResourceEntry } from '../../../../../shared/typescript/content-schema';
import type { EntityKind, EntityOverrides } from '../../../../../shared/typescript/scenario-schema';
import { EntityType } from '../../world/entity-types';

/** Editor layers: visibility/locking and hit-test order (later = on top). */
export const EDITOR_LAYERS = [
  'floors',
  'low',
  'mid',
  'top',
  'resources',
  'creatures',
  'npcs',
  'spawns',
  'regions',
] as const;
export type EditorLayer = (typeof EDITOR_LAYERS)[number];

export const LAYER_LABELS: Record<EditorLayer, string> = {
  floors: 'Floors & roads',
  low: 'Low pieces',
  mid: 'Furniture & stations',
  top: 'Walls & doors',
  resources: 'Resources',
  creatures: 'Creatures',
  npcs: 'NPCs',
  spawns: 'Player spawns',
  regions: 'Regions & effects',
};

/** One grid cell holds at most one floor-slot and one solid-slot piece. */
export type GridSlot = 'floor' | 'solid';

export type Collision =
  | { shape: 'box'; w: number; h: number }
  | { shape: 'circle'; r: number };

export type OverrideField = keyof EntityOverrides;

export interface CatalogEntry {
  /** `${kind}:${ref}` plus `:${variant}` for variant carriers. */
  key: string;
  kind: EntityKind;
  ref: string;
  variant?: number;
  name: string;
  category: string;
  layer: EditorLayer;
  /** Render protocol type (EntityType) for the game renderer; -1 = editor-drawn marker. */
  protocolType: number;
  /** Objects: the item id and variant subtype the server puts on the wire. */
  itemId?: number;
  subtype?: number;
  slot?: GridSlot;
  rotatable: boolean;
  /** Second tile of two-tile pieces, per rotation (old iTile/jTile). */
  secondTile?: Partial<Record<number, { di: number; dj: number }>>;
  collision?: Collision;
  healthMax?: number;
  overridable: OverrideField[];
  /** Sprite used for palette thumbnails. */
  icon?: string;
  isDoor?: boolean;
  /** Objects that hold items: their slot count (the container editor's bound). */
  containerSlots?: number;
  searchText: string;
}

/** An inventory item, for loadouts, container contents and loot tables. */
export interface CatalogItem {
  key: string;
  id: number;
  name: string;
  /** Most that fit one inventory slot. */
  stack: number;
}

interface ObjectClientBits {
  render?: string;
  frame?: { index: number; sprite: string; state?: number }[];
  on?: { index: number; sprite: string }[];
  hidden?: { index: number; sprite: string }[];
  variant?: { id: number; sprite: string }[];
  offset?: { rotation: number; tileI?: number; tileJ?: number }[];
  blueprint?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  wall: 'Walls & doors',
  floor: 'Floors',
  road: 'Roads',
  furniture: 'Furniture',
  station: 'Stations',
  container: 'Containers',
  logic: 'Logic',
  trap: 'Traps',
  explosives: 'Explosives',
  plant: 'Plants',
  spawner: 'Spawners',
  resurection: 'Resurrection',
  resource: 'Resources',
  creature: 'Creatures',
  npc: 'NPCs',
  spawn: 'Spawns',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category[0]!.toUpperCase() + category.slice(1);
}

const PROTOCOL_LAYER: Record<number, EditorLayer> = {
  [EntityType.BUILD_GROUND2]: 'floors',
  [EntityType.BUILD_GROUND]: 'floors',
  [EntityType.BUILD_TOP]: 'top',
};

// Mirrors ObjectManager's layerMap (object.cpp): the plane the server draws a piece on.
const OBJECT_PROTOCOL: Record<string, number> = {
  top: EntityType.BUILD_TOP,
  mid: EntityType.BUILD_DOWN,
  low: EntityType.BUILD_DOWN,
  bottom: EntityType.BUILD_GROUND2,
  bottom2: EntityType.BUILD_GROUND2,
};

// Mirrors ResourceManager (resource.cpp): resource type layer -> protocol type.
const RESOURCE_PROTOCOL: Record<string, number> = {
  top: EntityType.RES_TOP,
  mid: EntityType.RES_DOWN,
  low: EntityType.RES_MID,
  above: EntityType.RES_STOP,
};

function humanize(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function objectEntries(
  content: ContentStore,
  table: 'objects' | 'furnitures',
): CatalogEntry[] {
  if (!content.has(table) || !content.has('items')) return [];
  const out: CatalogEntry[] = [];
  for (const object of Object.values(content.table(table)) as ObjectEntry[]) {
    if ((object as { abstract?: boolean }).abstract) continue;
    const item = content.byKey('items', object.itemKey ?? object.key);
    const client = object.client as ObjectClientBits | undefined;
    if (!item || !client?.render) continue;
    const protocolType = OBJECT_PROTOCOL[object.layer] ?? EntityType.BUILD_DOWN;
    const isFloor = object.category === 'floor' || object.category === 'road';
    const layer: EditorLayer =
      PROTOCOL_LAYER[protocolType] ?? (object.layer === 'low' ? 'low' : 'mid');
    const secondTile: CatalogEntry['secondTile'] = {};
    for (const o of client.offset ?? [])
      if (o.tileI || o.tileJ) secondTile[o.rotation] = { di: o.tileI ?? 0, dj: o.tileJ ?? 0 };
    const t = object.transform;
    const collision: Collision | undefined = !t?.collision
      ? undefined
      : t.radius
        ? { shape: 'circle', r: t.radius }
        : { shape: 'box', w: t.width ?? 100, h: t.height ?? 100 };
    const isDoor =
      (object.interaction as { type?: string } | undefined)?.type === 'door' ||
      client.render === 'door';
    const overridable: OverrideField[] = [];
    const containerSlots = (object as { storage?: { slots?: number } }).storage?.slots || undefined;
    if (object.healthMax > 0) overridable.push('healthMax', 'health', 'destructible');
    if (isDoor) overridable.push('doorOpen');
    const icon =
      client.frame?.find((f) => f.index === 0 && (f.state ?? 0) === 0)?.sprite ??
      client.hidden?.[0]?.sprite ??
      client.blueprint;
    const base = {
      kind: 'object' as const,
      ref: object.key,
      category: object.category,
      layer,
      protocolType,
      itemId: item.id,
      subtype: object.subtype ?? 0,
      slot: (isFloor ? 'floor' : 'solid') as GridSlot,
      // Old `wall: 1`: autotiled walls and floors always go down at rotation 0.
      rotatable: client.render !== 'wall' && client.render !== 'groundFloor' && !isFloor,
      secondTile: Object.keys(secondTile).length ? secondTile : undefined,
      collision,
      healthMax: object.healthMax,
      overridable,
      isDoor,
      containerSlots,
    };
    const name = (client as { name?: string }).name ?? humanize(object.key);
    if (client.render === 'road' && client.variant?.length) {
      for (const v of client.variant) {
        out.push({
          ...base,
          key: `object:${object.key}:${v.id}`,
          variant: v.id,
          name: `${name} ${v.id}`,
          icon: v.sprite,
          searchText: `${object.key} ${name} ${object.category} road`.toLowerCase(),
        });
      }
      continue;
    }
    out.push({
      ...base,
      key: `object:${object.key}`,
      name,
      icon,
      searchText: `${object.key} ${name} ${object.category} ${table}`.toLowerCase(),
    });
  }
  return out;
}

function resourceEntries(content: ContentStore): CatalogEntry[] {
  if (!content.has('resources')) return [];
  const out: CatalogEntry[] = [];
  for (const res of Object.values(content.table('resources')) as ResourceEntry[]) {
    const clientTypes = (res.client as { type?: { id: number; sprite?: string }[] } | undefined)
      ?.type;
    for (const type of res.types.type) {
      out.push({
        key: `resource:${res.key}:${type.id}`,
        kind: 'resource',
        ref: res.key,
        variant: type.id,
        name: `${humanize(res.key)} ${type.id}`,
        category: 'resource',
        layer: 'resources',
        protocolType: RESOURCE_PROTOCOL[type.layer] ?? EntityType.RES_TOP,
        slot: 'solid',
        rotatable: false,
        collision: type.collision ? { shape: 'circle', r: type.radius } : undefined,
        overridable: [],
        icon: clientTypes?.find((t) => t.id === type.id)?.sprite,
        searchText: `${res.key} resource ${type.layer}`.toLowerCase(),
      });
    }
  }
  return out;
}

function agentEntries(content: ContentStore): CatalogEntry[] {
  if (!content.has('agents')) return [];
  return Object.values(content.table('agents')).map((agent) => ({
    key: `agent:${agent.key}`,
    kind: 'agent' as const,
    ref: agent.key,
    name: humanize(agent.key),
    category: 'creature',
    layer: 'creatures' as const,
    protocolType: EntityType.AI,
    rotatable: false,
    collision: agent.body?.radius ? { shape: 'circle' as const, r: agent.body.radius } : undefined,
    overridable: [],
    icon: (agent.client as { head?: string } | undefined)?.head,
    searchText: `${agent.key} ${agent.family} creature agent`.toLowerCase(),
  }));
}

function npcEntries(content: ContentStore): CatalogEntry[] {
  if (!content.has('npcs')) return [];
  return Object.values(content.table('npcs')).map((npc) => ({
    key: `npc:${npc.key}`,
    kind: 'npc' as const,
    ref: npc.key,
    name: `${npc.name} (${humanize(npc.key)})`,
    category: 'npc',
    layer: 'npcs' as const,
    protocolType: EntityType.NPC,
    rotatable: false,
    collision: { shape: 'circle' as const, r: 38 },
    overridable: [],
    icon: npc.client.head,
    searchText: `${npc.key} ${npc.name} npc ${npc.client.shop ? 'shop merchant' : ''}`.toLowerCase(),
  }));
}

function itemList(content: ContentStore): CatalogItem[] {
  if (!content.has('items')) return [];
  return (Object.values(content.table('items')) as { key: string; id: number; name: string; properties?: { stack?: number } }[])
    .filter((i) => i.name)
    .map((i) => ({ key: i.key, id: i.id, name: i.name, stack: Math.max(1, i.properties?.stack ?? 255) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const SPAWN_ENTRY: CatalogEntry = {
  key: 'spawn:player',
  kind: 'spawn',
  ref: 'player',
  name: 'Player spawn',
  category: 'spawn',
  layer: 'spawns',
  protocolType: -1,
  rotatable: false,
  overridable: [],
  icon: 'day-skin0',
  searchText: 'player spawn start team',
};

export class EditorCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly items: readonly CatalogItem[];
  private readonly byKey = new Map<string, CatalogEntry>();
  private readonly byRef = new Map<string, CatalogEntry>();
  private readonly itemsByKey = new Map<string, CatalogItem>();

  constructor(entries: readonly CatalogEntry[], items: readonly CatalogItem[] = []) {
    this.entries = entries;
    this.items = items;
    for (const item of items) this.itemsByKey.set(item.key, item);
    for (const e of entries) {
      this.byKey.set(e.key, e);
      const refKey = `${e.kind}:${e.ref}`;
      if (!this.byRef.has(refKey)) this.byRef.set(refKey, e);
    }
  }

  static fromContent(content: ContentStore): EditorCatalog {
    return new EditorCatalog(
      [
        ...objectEntries(content, 'objects'),
        ...objectEntries(content, 'furnitures'),
        ...resourceEntries(content),
        ...agentEntries(content),
        ...npcEntries(content),
        SPAWN_ENTRY,
      ],
      itemList(content),
    );
  }

  item(key: string): CatalogItem | undefined {
    return this.itemsByKey.get(key);
  }

  get(key: string): CatalogEntry | undefined {
    return this.byKey.get(key);
  }

  /** The entry a placement resolves to; variant-specific entries win when they exist. */
  resolve(kind: EntityKind, ref: string, variant?: number): CatalogEntry | undefined {
    if (variant !== undefined) {
      const exact = this.byKey.get(`${kind}:${ref}:${variant}`);
      if (exact) return exact;
    }
    return this.byRef.get(`${kind}:${ref}`);
  }

  categories(): string[] {
    return [...new Set(this.entries.map((e) => e.category))];
  }

  search(query: string, category?: string): CatalogEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.entries.filter(
      (e) =>
        (!category || e.category === category) &&
        words.every((w) => e.searchText.includes(w) || e.name.toLowerCase().includes(w)),
    );
  }
}
