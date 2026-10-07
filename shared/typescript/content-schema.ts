// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The JSON contract: what the client relies on from each table, as zod. Entry
// schemas are loose — the generic exporter passes every attribute through and a new one must
// never make a client refuse to join. Named fields are the ones client code reads.
import { z } from 'zod';
import {
  CONTENT_TABLES,
  type ContentTable,
  type ContentTableName,
  type ContentValue,
  type Scalar,
  type XmlTableName,
} from './content-format';

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const sprite = z.string().min(1);
const sound = z.string().min(1);
const int = z.number().int();

// Wire order: the index is the slot id ITEM_MODS / FULL_CHEST / TRADE_STATE carry.
export const MOD_SLOT_NAMES = [
  'magazine',
  'optic',
  'muzzle',
  'underbarrel',
  'side',
  'stock',
  'handguard',
] as const;
const modSlotName = z.enum(MOD_SLOT_NAMES);

// --- <client> shapes ---------------------------------------------------------------
const lootSprite = z.looseObject({
  id: int,
  sprite,
  scale: z.number(),
  angle: z.number(),
  amount: int,
});
const frame = z.looseObject({
  index: int.nonnegative(),
  state: int.nonnegative().optional(),
  sprite,
});
const offset = z.looseObject({
  rotation: int,
  cx: z.number().optional(),
  cy: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  tileI: z.number().optional(),
  tileJ: z.number().optional(),
  lightX: z.number().optional(),
  lightY: z.number().optional(),
  spineX: z.number().optional(),
  spineY: z.number().optional(),
});
const swing = z.looseObject({
  rotation: int,
  i: z.number(),
  j: z.number(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const wire = z.looseObject({
  rotation: int,
  a: z.number(),
  b: z.number(),
  c: z.number(),
  d: z.number(),
});
const armPose = z.looseObject({
  angle: z.number(),
  x: z.number(),
  y: z.number(),
  distance: z.number().optional(),
  rotation: z.number().optional(),
});
const agentArm = z.looseObject({ sprite, angle: z.number(), x: z.number(), y: z.number() });

const itemClient = z.looseObject({
  description: z.string().optional(),
  icon: sprite.optional(),
  iconOut: sprite.optional(),
  iconIn: sprite.optional(),
  iconClick: sprite.optional(),
  loot: z.array(lootSprite).optional(),
});
const objectClient = z.looseObject({
  render: z.string(),
  renderTop: z.string().optional(),
  blueprint: sprite.optional(),
  redprint: sprite.optional(),
  interact: sprite.optional(),
  interactClose: sprite.optional(),
  builder: sprite.optional(),
  particles: z.string().optional(),
  particlesDistance: z.number().optional(),
  impactSound: sound.optional(),
  destroySound: sound.optional(),
  angle: z.number().optional(),
  z: z.number().optional(),
  zGroup: z.number().optional(),
  autotile: z.boolean().optional(),
  autotileGroup: z.string().optional(),
  pivotX: z.number().optional(),
  pivotY: z.number().optional(),
  frame: z.array(frame).optional(),
  broken: z.array(frame).optional(),
  offset: z.array(offset).optional(),
  swing: z.array(swing).optional(),
  light: z.array(frame).optional(),
  on: z.array(frame).optional(),
  top: z.array(frame).optional(),
  hidden: z.array(frame).optional(),
  deployed: z.array(frame).optional(),
  wire: z.array(wire).optional(),
  variant: z
    .array(
      z.looseObject({
        id: int,
        sprite,
        angle: z.number().optional(),
        impactSound: sound.optional(),
        destroySound: sound.optional(),
      }),
    )
    .optional(),
});
const equipableClient = z.looseObject({
  render: z.enum(['hand', 'melee', 'gun', 'throwable', 'bow', 'consumable', 'place']),
  breath: z.number(),
  move: z.number(),
  breathWeapon: z.number().optional(),
  x: z.number().optional(),
  distance: z.number().optional(),
  radius: z.number().optional(),
  recoil: z.number().optional(),
  recoilHead: z.number().optional(),
  recoilGun: z.number().optional(),
  noEffect: z.number().optional(),
  gunEffect: z.enum(['gun', 'laser']).optional(),
  cartridge: sprite.optional(),
  cartridgeDelay: z.number().optional(),
  soundDelay: z.number().optional(),
  soundVolume: z.number().optional(),
  hitAnimMs: z.number().optional(),
  swingAnimMs: z.number().optional(),
  consumeAnimMs: z.number().optional(),
  blueprint: sprite.optional(),
  pencil: sprite.optional(),
  held: z
    .looseObject({
      sprite,
      angle: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
    })
    .optional(),
  projectileHeld: z.looseObject({ sprite, x: z.number(), y: z.number() }).optional(),
  rightArm: armPose.optional(),
  leftArm: armPose.optional(),
  sound: z.array(z.looseObject({ file: sound })).optional(),
  // The Mods window's side-view picture (Task 10 art): frame and body boxes are
  // "x y w h" in art units, anchors are where each slot's part attaches.
  modArt: z
    .looseObject({
      frame: z.string(),
      body: z.string(),
      bodyBox: z.string(),
      anchor: z.array(z.looseObject({ slot: modSlotName, x: z.number(), y: z.number() })),
    })
    .optional(),
});
const wearableClient = z.looseObject({
  head: sprite.optional(),
  leftArm: sprite.optional(),
  rightArm: sprite.optional(),
});
const projectileClient = z.looseObject({ frame: z.array(frame).length(3) });
const resourceClient = z.looseObject({
  render: z.string(),
  particles: z.string().optional(),
  impactSound: sound.optional(),
  destroySound: sound.optional(),
  type: z.array(
    z.looseObject({
      id: int,
      sprite,
      spriteTop: sprite.optional(),
      spriteFull: sprite.optional(),
      particleCount: int.optional(),
      particlesDistance: z.number().optional(),
    }),
  ),
});
const agentClient = z.looseObject({
  render: z.string(),
  breath: z.number(),
  armMove: z.number(),
  head: sprite,
  hurt: sprite,
  death: sprite,
  light: z.number(),
  hitAnimMs: z.number(),
  leftArm: agentArm,
  rightArm: agentArm,
});

// --- server shapes the client reads -----------------------------------------------------------
const keyed = { key: z.string().min(1) };
const ingredient = z.looseObject({ itemKey: z.string(), amount: int });
const station = z.looseObject({ key: z.string(), timeMs: int.optional() });
const drop = z.looseObject({
  key: z.string(),
  amount: int.optional(),
  amountMax: int.optional(),
  chance: z.number().optional(),
});
const drops = z.looseObject({ item: z.array(drop) });

// skills.xml: one row per craft-window skill tab, in tab order. `icon` names the old
// `img/<icon>-out.png` button sprite (in/click variants exist alongside).
export const skillEntry = z.looseObject({
  ...keyed,
  name: z.string().min(1),
  icon: sprite,
});
// <aim> on a weapon (aim-and-scopes spec): the base its aim stats resolve from.
const aimEntry = z.looseObject({
  spreadPercent: z.number().min(-95).max(0),
  movePercent: z.number().min(-90).max(0),
  timeMs: int.min(0),
});
// <view> on an optic mod or an aiming weapon. Weak shapes widen the box the
// server sends; strong ones send only the shape and a circle around the
// player. Strict: like the server, a shape refuses another shape's attributes.
const weakView = (shape: 'stretch' | 'shift') =>
  z.strictObject({
    shape: z.literal(shape),
    ahead: int.min(0).max(600),
    extend: int.min(0).max(1200),
    zoom: z.number().min(0.6).max(1),
  });
const viewEntry = z.discriminatedUnion('shape', [
  weakView('stretch'),
  weakView('shift'),
  z.strictObject({
    shape: z.literal('cone'),
    reach: int.min(200).max(4000),
    halfAngleDeg: z.number().min(1).max(60),
    zoom: z.number().min(0.4).max(1),
    rearRadius: int.min(150).max(600),
  }),
  z.strictObject({
    shape: z.literal('rect'),
    length: int.min(200).max(4000),
    width: int.min(100).max(2000),
    back: int.min(0).max(500).optional(),
    zoom: z.number().min(0.4).max(1),
    rearRadius: int.min(150).max(600),
  }),
]);
const modStat = z.looseObject({
  name: z.string().min(1),
  add: z.number().optional(),
  percent: z.number().optional(),
});
export const modEntry = z.looseObject({
  ...keyed,
  slot: modSlotName,
  installMs: int.positive(),
  capacity: int.min(1).max(255).optional(),
  stat: z.array(modStat).optional(),
  view: viewEntry.optional(),
  client: z
    .looseObject({
      art: z.string(),
      box: z.string(),
      anchorX: z.number().optional(),
      anchorY: z.number().optional(),
    })
    .optional(),
});
export const itemEntry = z.looseObject({
  ...keyed,
  id: int,
  clientItemId: int,
  currency: z.object({ value: int.positive().max(65025) }).optional(),
  name: z.string(),
  properties: z
    .looseObject({ stack: int.optional(), lootId: int.optional(), score: int.optional() })
    .optional(),
  skill: z
    .looseObject({
      type: z.string(),
      requiredLevel: int.optional(),
      skillCost: int.optional(),
      prerequisite: z.string().optional(),
    })
    .optional(),
  crafting: z
    .looseObject({
      yield: int.optional(),
      recipe: z.looseObject({ ingredient: z.array(ingredient) }).optional(),
      stations: z.looseObject({ station: z.array(station) }).optional(),
      extractor: z.looseObject({ timeMs: int, outputMin: int, outputMax: int }).optional(),
    })
    .optional(),
  equipable: z.looseObject({ key: z.string(), equipTimeMs: int.optional() }).optional(),
  wearable: z.looseObject({ key: z.string(), equipTimeMs: int.optional() }).optional(),
  weaponMod: z.looseObject({ key: z.string() }).optional(),
  decay: z.looseObject({ transformTo: z.string(), timeMs: int }).optional(),
  bag: z.looseObject({ addSlots: int }).optional(),
  client: itemClient.optional(),
});
export const resourceEntry = z.looseObject({
  ...keyed,
  id: int,
  experience: int.optional(),
  respawnDelayMs: int.optional(),
  types: z.looseObject({
    type: z.array(
      z.looseObject({
        id: int,
        life: int,
        radius: z.number(),
        layer: z.string(),
        collision: z.boolean(),
      }),
    ),
  }),
  client: resourceClient.optional(),
});
export const equipableEntry = z.looseObject({
  ...keyed,
  id: int,
  idWeapon: int,
  typeId: int,
  timing: z
    .looseObject({
      attackDelayMs: int.optional(),
      shotDelayMs: int.optional(),
      consumeDelayMs: int.optional(),
      impactMs: int.optional(),
    })
    .optional(),
  damage: z
    .looseObject({ amount: int, type: z.string().optional(), knockback: z.number().optional() })
    .optional(),
  usage: z.looseObject({ stamina: int }).optional(),
  combat: z.looseObject({ range: z.number(), radius: z.number() }).optional(),
  fire: z
    .looseObject({
      mode: z.string(),
      projectileKey: z.string(),
      range: z.number().optional(),
      pellets: int.optional(),
      speedMultiplier: z.number().optional(),
      spreadRadians: z.number().optional(),
      recoilKickback: z.number().optional(),
    })
    .optional(),
  ammo: z
    .looseObject({
      key: z.string(),
      magazineSize: int.optional(),
      reloadMs: int,
      reloadPerShell: z.boolean().optional(),
    })
    .optional(),
  mods: z
    .looseObject({
      slot: z.array(
        z.looseObject({ type: modSlotName, accepts: z.string().min(1), default: z.string().optional() }),
      ),
    })
    .optional(),
  aim: aimEntry.optional(),
  view: viewEntry.optional(),
  consumable: z
    .looseObject({ effect: z.array(z.looseObject({ type: z.string(), amount: z.number() })) })
    .optional(),
  client: equipableClient.optional(),
});
export const wearableEntry = z.looseObject({
  ...keyed,
  id: int,
  skinId: int,
  modifiers: z
    .looseObject({ modifier: z.array(z.looseObject({ key: z.string(), multiplier: z.number() })) })
    .optional(),
  client: wearableClient.optional(),
});
export const kitEntry = z.looseObject({
  level: int.optional(),
  startLevel: int.optional(),
  firstSession: z.boolean().optional(),
  items: z
    .looseObject({
      item: z.array(
        z.looseObject({ key: z.string(), amount: int.optional(), ammo: int.optional() }),
      ),
    })
    .optional(),
});
export const objectEntry = z.looseObject({
  ...keyed,
  itemKey: z.string().optional(),
  subtype: int.optional(),
  category: z.string(),
  healthMax: int,
  layer: z.string(),
  transform: z
    .looseObject({
      width: z.number().optional(),
      height: z.number().optional(),
      collision: z.boolean(),
      blocksProjectiles: z.boolean().optional(),
      radius: z.number().optional(),
    })
    .refine(
      (shape) =>
        shape.radius !== undefined || (shape.width !== undefined && shape.height !== undefined),
      'transform requires radius or width and height',
    )
    .optional(),
  place: z.looseObject({ delayMs: int }).optional(),
  /** Hidden from players outside the owner's clan until they are within `tiles` of it (server-enforced). */
  conceal: z.looseObject({ tiles: int }).optional(),
  interaction: z.looseObject({ type: z.string(), interactionDelayMs: int.optional() }).optional(),
  station: z.looseObject({ key: z.string(), areaId: int }).optional(),
  fuel: z
    .looseObject({ itemKey: z.string(), burnDurationPerUnitMs: int, addAmount: int.optional() })
    .optional(),
  storage: z.looseObject({ slots: int, refrigeration: z.boolean().optional() }).optional(),
  stages: z.looseObject({ stage: z.array(z.looseObject({ id: int })) }).optional(),
  onDestroy: z.looseObject({ drops: drops.optional() }).optional(),
  client: objectClient.optional(),
});
export const projectileEntry = z.looseObject({
  ...keyed,
  id: int,
  clientProjectileId: int,
  physics: z.looseObject({ baseSpeed: z.number() }).optional(),
  damage: z.looseObject({ type: z.string() }).optional(),
  client: projectileClient.optional(),
});
export const agentEntry = z.looseObject({
  ...keyed,
  id: int,
  sprite: int,
  family: z.string(),
  body: z.looseObject({ radius: z.number() }).optional(),
  vitals: z.looseObject({ health: int, experience: int.optional() }).optional(),
  client: agentClient.optional(),
});
export const structureEntry = z.looseObject({
  ...keyed,
  width: int.optional(),
  height: int.optional(),
  code: z.looseObject({ text: z.string() }).optional(),
  file: z.string().optional(),
});
export const conditionEntry = z.looseObject({
  ...keyed,
  name: z.string().optional(),
  stage: z.array(z.looseObject({ key: z.string(), durationMs: int.optional() })),
});
export const modeEntry = z.looseObject({
  ...keyed,
  id: int,
  clientModeId: int,
  dayNightCycle: int,
  craftSpeed: z.number().optional(),
  clans: z
    .looseObject({
      enabled: z.boolean(),
      canCreate: z.boolean().optional(),
      maxMembers: int,
      maxClans: int,
    })
    .optional(),
  karma: z
    .looseObject({
      level: z.array(z.looseObject({ id: int, xpMultiplier: z.number(), maxKills: int })),
    })
    .optional(),
  gauges: z
    .looseObject({
      gauge: z.array(z.looseObject({ key: z.string(), max: int, speedInc: int, speedDec: int })),
    })
    .optional(),
});

// The config table: strict — a misspelled key here is a bug, not a new attribute.
export const configTable = z.strictObject({
  mode: z.string().min(1),
  maxPlayers: int.positive(),
  maxClans: int.nonnegative(),
  clanSize: int.nonnegative(),
  clanNameMaxLength: int.positive(),
  clanActionDelayMs: int.nonnegative(),
  mapWidth: int.positive(),
  mapHeight: int.positive(),
  tileSize: int.positive(),
  dayCycleMs: int.nonnegative(),
  craftSpeed: z.number().nonnegative(),
  inventorySlots: int.positive(),
  chatMaxLength: int.positive(),
  nicknameMaxLength: int.positive(),
  passwordMaxLength: int.positive(),
  xpStart: int.positive(),
  xpGrowth: z.number().positive(),
  maxLevel: int.positive(),
  craftQueueSize: int.positive(),
  chestMaxSlots: int.positive(),
  interactionRange: int.nonnegative(),
  lootPickupRange: int.nonnegative(),
  // game.cpp playerAddFuel: a station holds at most 254 fuel units. Optional so an older
  // server's config still validates; the client falls back to 254.
  fuelMaxUnits: int.positive().optional(),
  tradeRangeTiles: int.positive().optional(),
});

export type SkillEntry = z.infer<typeof skillEntry>;
export type ItemEntry = z.infer<typeof itemEntry>;
export type ResourceEntry = z.infer<typeof resourceEntry>;
export type EquipableEntry = z.infer<typeof equipableEntry>;
export type ModEntry = z.infer<typeof modEntry>;
export type WearableEntry = z.infer<typeof wearableEntry>;
export type KitEntry = z.infer<typeof kitEntry>;
export type ObjectEntry = z.infer<typeof objectEntry>;
export type ProjectileEntry = z.infer<typeof projectileEntry>;
export type AgentEntry = z.infer<typeof agentEntry>;
export type StructureEntry = z.infer<typeof structureEntry>;
export type ConditionEntry = z.infer<typeof conditionEntry>;
export type ModeEntry = z.infer<typeof modeEntry>;
export type ConfigTable = z.infer<typeof configTable>;

export const npcEntry = z.object({
  key: z.string(), id: int.positive(), name: z.string(), rangeTiles: int.positive().max(5).optional(),
  client: z.object({ head: z.string(), leftArm: z.string(), rightArm: z.string(), shop: z.boolean().optional(), tint: z.string().optional() }),
});
export type NpcEntry = z.infer<typeof npcEntry>;
export const statEntry = z.object({
  key: z.string(), id: int.positive().max(65535), name: z.string(),
  public: z.boolean().optional(), retired: z.boolean().optional(), aggregate: z.enum(['sum', 'max']).optional(),
});
export type StatEntry = z.infer<typeof statEntry>;
/** A secret achievement arrives without name, description, requirements or rewards. */
export const achievementEntry = z.object({
  key: z.string(), id: int.positive().max(65535), name: z.string().optional(), description: z.string().optional(),
  grade: int.min(1).max(3).optional(), points: int.min(0).max(100).optional(),
  secret: z.boolean().optional(), retired: z.boolean().optional(), announce: z.boolean().optional(),
  requires: z.array(z.object({ stat: z.string(), atLeast: int.positive() })).optional(),
  reward: z.array(z.object({ caps: int.positive().optional(), item: z.string().optional(), count: int.positive().optional() })).optional(),
});
export type AchievementEntry = z.infer<typeof achievementEntry>;
export interface EntryTypes {
  npcs: NpcEntry;
  skills: SkillEntry;
  items: ItemEntry;
  resources: ResourceEntry;
  equipables: EquipableEntry;
  mods: ModEntry;
  wearables: WearableEntry;
  kits: KitEntry;
  objects: ObjectEntry;
  furnitures: ObjectEntry;
  projectiles: ProjectileEntry;
  agents: AgentEntry;
  structures: StructureEntry;
  conditions: ConditionEntry;
  modes: ModeEntry;
  stats: StatEntry;
  achievements: AchievementEntry;
  config: Scalar;
}

export const ENTRY_SCHEMAS: Record<Exclude<ContentTableName, 'config'>, z.ZodType> = {
  npcs: npcEntry,
  skills: skillEntry,
  items: itemEntry,
  resources: resourceEntry,
  equipables: equipableEntry,
  mods: modEntry,
  wearables: wearableEntry,
  kits: kitEntry,
  objects: objectEntry,
  furnitures: objectEntry,
  projectiles: projectileEntry,
  agents: agentEntry,
  structures: structureEntry,
  conditions: conditionEntry,
  modes: modeEntry,
  stats: statEntry,
  achievements: achievementEntry,
};

const envelopeBase = {
  version: int.positive(),
  hash: z.string().min(1),
  attributes: z.record(z.string(), scalar),
};
function envelopeFor(name: ContentTableName): z.ZodType {
  const entries = name === 'config' ? configTable : z.record(z.string(), ENTRY_SCHEMAS[name]);
  return z.strictObject({ name: z.literal(name), ...envelopeBase, entries });
}
const ENVELOPES = Object.fromEntries(CONTENT_TABLES.map((n) => [n, envelopeFor(n)])) as Record<
  ContentTableName,
  z.ZodType
>;

export const contentManifestSchema = z.strictObject({
  protocol: int.positive(),
  tables: z.record(
    z.string().refine(isContentTableName, 'unknown table name'),
    z.strictObject({ version: int.positive(), hash: z.string().min(1) }),
  ),
});
export const contentPatchSchema = z
  .strictObject({
    name: z.string().min(1),
    fromVersion: int.positive(),
    toVersion: int.positive(),
    hash: z.string().min(1),
    patch: z.record(z.string(), z.json()),
  })
  .refine((p) => p.toVersion > p.fromVersion, {
    path: ['toVersion'],
    message: 'patch version must increase',
  });

export class ContentSchemaError extends Error {
  constructor(
    readonly table: string,
    readonly issues: string[],
  ) {
    super(`content table '${table}' failed validation:\n  ${issues.join('\n  ')}`);
    this.name = 'ContentSchemaError';
  }
}

export function isContentTableName(name: string): name is ContentTableName {
  return (CONTENT_TABLES as readonly string[]).includes(name);
}

export function validateTable(name: XmlTableName, data: unknown): ContentTable;
export function validateTable(name: 'config', data: unknown): ContentTable<Scalar>;
export function validateTable(name: string, data: unknown): ContentTable<ContentValue>;
export function validateTable(name: string, data: unknown): ContentTable<ContentValue> {
  if (!isContentTableName(name)) throw new ContentSchemaError(name, ['unknown table name']);
  // Loose entry schemas allow future fields, but those fields must still be JSON.
  const json = z.json().safeParse(data);
  if (!json.success)
    throw new ContentSchemaError(
      name,
      json.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  const result = ENVELOPES[name].safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 20)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    if (result.error.issues.length > 20) issues.push(`… ${result.error.issues.length - 20} more`);
    throw new ContentSchemaError(name, issues);
  }
  return result.data as ContentTable<ContentValue>;
}
