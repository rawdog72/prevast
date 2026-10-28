// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// What a molotov's fire looks like (AREA_EFFECT kind FIRE, render/clouds.ts).
//
// The server decides where the fire is -- which tiles, grown in what order, for
// how long -- and what it does to whoever stands in it. Everything here is
// looks only, on the same clock: nothing it draws hides anything or changes
// what anyone can do.
//
// The look follows the game's own effect art (the explosion, the campfire and
// its light): flat, hard-edged shapes in a few muted colours, no gradients,
// no glow. Every flame is a teardrop; all live flames are filled as ONE shape
// per colour -- coral, then orange, then yellow, each smaller than the last --
// so they merge into a single cartoon blaze with a warm heart, the way the
// explosion's peach and white do. Smoke is the explosion's warm grey, puffs
// that swell and shrink away rather than fade; the light is the campfire's two
// flat discs; embers are its little yellow sparks.
//
//   ground  (under creatures, over floors)  scorch, the light on the ground,
//            the flames, the bottle's fireball
//   top     (over everything but names)     smoke, embers, broken glass, the
//            flash of the bottle breaking, and flames on anyone burning
//
// The scorch outlives the fire and the last of it smoulders a while, so a
// spot that burned stays readable for a few seconds after.
//
// Cost. Flames are the bill: each is a curve filled three times. So a fire
// keeps few of them -- ~50, big enough to overlap into one blaze -- and each
// colour is one path and one fill however many flames are in it. (Stamping
// pre-filled bitmaps instead was measured, in Chrome with and without a GPU,
// and was no faster: the curves are cheap, the count was not.) Particles live
// in fixed pools with the live ones packed at the front (a dead one swaps
// with the last), so updating and drawing touch only what is alive and make
// no garbage, and culling is four compares against the view's rectangle,
// worked out once a frame. With `reduced` (the particles switch) the
// decoration thins out while the flames -- which mark ground that hurts --
// stay.

import type { Camera } from '../core/camera';
import type { EffectClient } from '../../../../shared/typescript/content-schema';

const TILE = 100;
/** How long one tile takes to catch once the spread reaches it (matches the cloud's TILE_APPEAR_MS). */
const TILE_CATCH_MS = 400;

/** A fire as the cloud layer holds it. */
export interface FireSource {
  id: number;
  tileX: number;
  tileY: number;
  growMs: number;
  holdMs: number;
  fadeMs: number;
  ageMs: number;
  cells: ReadonlyArray<readonly [number, number]>;
  /** Its effect's look (effects.xml <client render="fire">); the molotov's without one. */
  look?: { readonly fire: FireLook };
}

/** Anything that can stand in the fire: a player or a ghoul, by identity. */
export interface FireActor {
  readonly x: number;
  readonly y: number;
}

/** A molotov still in the air. */
export interface FireProjectile {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface FireUpdateInput {
  fires: Iterable<FireSource>;
  /** Creatures that may be standing in a fire: they catch, and burn on a moment after leaving. */
  creatures?: Iterable<FireActor>;
  /** Live molotovs: they trail fire and smoke, and say exactly where the bottle broke. */
  projectiles?: Iterable<FireProjectile>;
}

// ---- tuning ---------------------------------------------------------------

/** Flames born per second on a fully burning tile. */
const FLAME_RATE = 4.5;
/** Smoke puffs per second per burning tile. */
const SMOKE_RATE = 1.1;
/** Embers per second per burning tile. */
const EMBER_RATE = 2.4;
/** How far from the tile's middle a flame may start: past the tile's half, so neighbours merge. */
const FLAME_SPREAD = 54;
/** A flame's radius at its biggest, before heat and edge scale it. */
const FLAME_MIN_R = 26;
const FLAME_MAX_R = 46;
/** Flames (and the inner colours of flames) smaller than this are not drawn. */
const MIN_DRAWN_R = 4;

/**
 * The flame layers, outermost first: each is filled as one merged shape at
 * `scale` of every flame's size, so the yellow heart sits inside the orange
 * inside the coral. Colours sit with the explosion's peach and the campfire
 * light's yellow rather than pure red and orange.
 */
const FLAME_LAYERS: ReadonlyArray<readonly [string, number]> = [
  ['#d9573b', 1],
  ['#ee8f45', 0.7],
  ['#f2cf68', 0.42],
];
/** The explosion's warm greys: smoke body and its lit top. */
const SMOKE_DARK = 'rgb(136,128,112)';
const SMOKE_LIGHT = 'rgb(168,160,136)';
const SMOKE_ALPHA = 0.78;
/** The campfire light's two discs, day and night. */
const LIGHT_DAY: readonly [string, string] = ['rgb(232,176,112)', 'rgb(240,208,104)'];
const LIGHT_NIGHT: readonly [string, string] = ['rgb(248,248,224)', 'rgb(248,248,216)'];
const EMBER_COLOUR = 'rgb(240,216,104)';
const SCORCH_COLOUR = 'rgb(46,40,32)';
const GLASS = ['#a9d3a4', '#5f8f4e', '#e2d4aa'] as const;

/**
 * The colours of one kind of fire, and whether it starts with a bottle
 * breaking. effects.xml <client render="fire" flameColors= smokeColor=
 * smokeLitColor= emberColor= shatter=>; anything left out is the molotov's.
 */
export interface FireLook {
  /** The three flame layers, outermost first. */
  flames: readonly [string, string, string];
  smokeDark: string;
  smokeLight: string;
  ember: string;
  /** A bottle breaking where it starts: glass and a fireball. */
  shatter: boolean;
}

export const MOLOTOV_FIRE: FireLook = {
  flames: [FLAME_LAYERS[0]![0], FLAME_LAYERS[1]![0], FLAME_LAYERS[2]![0]],
  smokeDark: SMOKE_DARK,
  smokeLight: SMOKE_LIGHT,
  ember: EMBER_COLOUR,
  shatter: true,
};

/** "r,g,b" or any CSS colour; "r,g,b" becomes rgb(r,g,b). */
function cssColour(text: string | undefined, fallback: string): string {
  const t = text?.trim();
  if (!t) return fallback;
  return /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(t) ? `rgb(${t})` : t;
}

/** A fire look from an effect's <client>, the molotov's for whatever it leaves out. */
export function fireLookFrom(client?: EffectClient): FireLook {
  if (!client) return MOLOTOV_FIRE;
  const layers = (client.flameColors ?? '')
    .split(/[;,](?![^(]*\))/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const flames: [string, string, string] =
    layers.length === 3 ? [layers[0]!, layers[1]!, layers[2]!] : [...MOLOTOV_FIRE.flames];
  return {
    flames,
    smokeDark: cssColour(client.smokeColor, MOLOTOV_FIRE.smokeDark),
    smokeLight: cssColour(client.smokeLitColor, MOLOTOV_FIRE.smokeLight),
    ember: cssColour(client.emberColor, MOLOTOV_FIRE.ember),
    shatter: client.shatter ?? true,
  };
}

/** How many fire looks can be on screen at once with their own colours; past it, the molotov's. */
const MAX_FIRE_LOOKS = 16;

/** Long-lived low flames per second per tile: the burning carpet the tongues rise from. */
const BASE_RATE = 1.2;

/** After stepping out of the fire (conditions.xml "burning" durationMs). */
export const AFTERBURN_MS = 3000;
/** The scorch stays this long after the fire has gone, the last part fading. */
const SCORCH_LINGER_MS = 16000;
const SCORCH_FADE_MS = 6000;
/** How many strengths the fading scorch is drawn in: one fill each. */
const SCORCH_LEVELS = 4;
/** The burned spot keeps smoking and glowing this long after the flames are out. */
const SMOULDER_MS = 5000;
/** A fire first seen younger than this has just broken: play the shatter. */
const SHATTER_FRESH_MS = 450;
/** How far from the fire's first tile a tracked bottle may be and still be the one that broke there. */
const IMPACT_MATCH_DIST = 220;
/** How long a tracked bottle's last position is worth remembering. */
const IMPACT_MEMORY_MS = 400;

const POOL_FLAMES = 700;
const POOL_SMOKE = 260;
const POOL_EMBERS = 320;
const POOL_SHARDS = 64;
const POOL_FLASHES = 8;

// ---- particles ------------------------------------------------------------

interface Flame {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius at its biggest. */
  r: number;
  age: number;
  life: number;
  seed: number;
  /** Drawn over creatures (a burning player) rather than on the ground. */
  over: boolean;
  /** Slows as it flies: a fireball's lick slows, a rising flame does not. */
  drag: number;
  /** Which fire look it is drawn in (FireEffects.looks). */
  look: number;
}

interface Smoke {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r0: number;
  r1: number;
  age: number;
  life: number;
  peak: number;
  look: number;
}

interface Ember {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  life: number;
  seed: number;
  look: number;
}

interface Shard {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  size: number;
  age: number;
  life: number;
  /** 0: clear glass, 1: dark bottle glass, 2: the label. */
  tone: number;
}

interface Flash {
  active: boolean;
  x: number;
  y: number;
  age: number;
  life: number;
}

/**
 * A tile that is burning, or burned: one entry however many fires cover it,
 * so two molotovs on one spot draw (and cost) one fire, not two stacked.
 */
interface FireTile {
  x: number;
  y: number;
  tx: number;
  ty: number;
  /** Placement of its scorch, fixed per tile. */
  seed: number;
  /** Clock time it first caught: the scorch spreads from here. */
  at: number;
  /** How hot this update: the hottest fire on it; 0 once nothing burns it. */
  heat: number;
  /** Clock time the last fire on it is over. */
  endsAt: number;
  /** Flames owed: the spawn accumulator, so rates hold at any frame rate. */
  owed: number;
  /** The look of the fire burning it (the last one to reach it). */
  look: number;
}

/** A burning tile this update: where, and how hot (0..1). */
interface HotTile {
  x: number;
  y: number;
  heat: number;
  /** 0.7 at a lone tile's edge .. 1 in the middle of the fire. */
  edge: number;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function pool<T>(n: number, make: () => T): T[] {
  return Array.from({ length: n }, make);
}

function tileKey(tx: number, ty: number): number {
  return (tx + 0x8000) * 0x10000 + (ty + 0x8000);
}

/** A stable 0..1 per integer, for per-tile variation that does not churn. */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How hot tile `i` of a fire is right now: caught (0..1) times the fire's fade. */
export function tileHeat(fire: FireSource, i: number): number {
  const n = fire.cells.length;
  if (i >= n) return 0;
  const covered =
    fire.growMs <= 0 || fire.ageMs >= fire.growMs
      ? n
      : Math.min(n, Math.max(1, Math.ceil((n * fire.ageMs) / fire.growMs)));
  if (i >= covered) return 0;
  const reachedAt = fire.growMs > 0 ? (fire.growMs * i) / n : 0;
  const caught = clamp01((fire.ageMs - reachedAt) / TILE_CATCH_MS);
  const fadeStart = fire.growMs + fire.holdMs;
  const fade =
    fire.ageMs < fadeStart
      ? 1
      : fire.fadeMs > 0
        ? clamp01(1 - (fire.ageMs - fadeStart) / fire.fadeMs)
        : 0;
  return caught * fade;
}

/**
 * A flame's size over its life, 0..1: a quick swell, a long burn near full
 * size, then a quick end. Dying flames are what reads as "lots of little
 * fires", so a flame spends as little of its life small as it can.
 */
export function flameScale(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < 0.14) {
    const t = u / 0.14;
    return 1 - (1 - t) * (1 - t);
  }
  if (u < 0.7) return 1 - (0.15 * (u - 0.14)) / 0.56;
  const t = (u - 0.7) / 0.3;
  return 0.85 * (1 - t * t);
}

// ---- shapes -------------------------------------------------------------

/**
 * Adds a teardrop flame to the current path: a round belly of radius r centred
 * on (x, y), its point 1.25 r above the belly's top, leaning by `lean` (-1..1).
 * Always wound the same way, so overlapping flames fill as one shape.
 */
function addFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  lean: number,
): void {
  const tipX = x + lean * r * 0.5;
  const tipY = y - r * 2.25;
  ctx.moveTo(tipX, tipY);
  ctx.bezierCurveTo(tipX + r * 0.25, y - r * 1.5, x + r, y - r * 0.85, x + r, y);
  ctx.arc(x, y, r, 0, Math.PI);
  ctx.bezierCurveTo(x - r, y - r * 0.85, tipX - r * 0.25, y - r * 1.5, tipX, tipY);
  ctx.closePath();
}

function addCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** The world rectangle the camera shows, so culling is four compares and no allocation. */
interface View {
  l: number;
  t: number;
  r: number;
  b: number;
}

function viewOf(camera: Camera): View {
  const hw = camera.viewportWidth / 2 / camera.zoom;
  const hh = camera.viewportHeight / 2 / camera.zoom;
  return {
    l: camera.centerX - hw,
    t: camera.centerY - hh,
    r: camera.centerX + hw,
    b: camera.centerY + hh,
  };
}

function inView(v: View, x: number, y: number, m: number): boolean {
  return x + m >= v.l && x - m <= v.r && y + m >= v.t && y - m <= v.b;
}

/**
 * One small flame, as on a molotov's rag: three tongues in the three flame
 * colours, dancing on their own clock. (x, y) is the base of the flame and it
 * points up the screen; `size` is its height in world units.
 */
export function drawRagFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  timeMs: number,
  seed = 0,
): void {
  const t = timeMs / 1000;
  for (const [colour, scale] of FLAME_LAYERS) {
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const phase = t * (8 + k * 2.3) + seed * 1.7 + k * 2.1;
      const r = size * 0.24 * scale * (0.82 + 0.18 * Math.sin(phase)) * (k === 1 ? 1 : 0.72);
      if (r <= 0.3) continue;
      const ox = (k - 1) * size * 0.2 * (0.6 + 0.4 * scale);
      const oy = -r + size * 0.06 * (1 - scale) + (k === 1 ? 0 : size * 0.04);
      addFlame(ctx, x + ox, y + oy, r, Math.sin(phase * 1.3) * 0.5 + (k - 1) * 0.4);
    }
    ctx.fillStyle = colour;
    ctx.fill();
  }
}

// ---- the effects ----------------------------------------------------------

export class FireEffects {
  /** Thin the decoration out (the particles switch). Flames always stay. */
  reduced = false;

  private readonly flames = pool<Flame>(POOL_FLAMES, () => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 0,
    age: 0,
    life: 1,
    seed: 0,
    over: false,
    drag: 0,
    look: 0,
  }));
  private readonly smoke = pool<Smoke>(POOL_SMOKE, () => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r0: 0,
    r1: 0,
    age: 0,
    life: 1,
    peak: 0,
    look: 0,
  }));
  private readonly embers = pool<Ember>(POOL_EMBERS, () => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    size: 0,
    age: 0,
    life: 1,
    seed: 0,
    look: 0,
  }));
  private readonly shards = pool<Shard>(POOL_SHARDS, () => ({
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rot: 0,
    vrot: 0,
    size: 0,
    age: 0,
    life: 1,
    tone: 0,
  }));
  private readonly flashes = pool<Flash>(POOL_FLASHES, () => ({
    active: false,
    x: 0,
    y: 0,
    age: 0,
    life: 1,
  }));
  /** Live particles are the first n of each pool. */
  private nFlames = 0;
  private nSmoke = 0;
  private nEmbers = 0;
  private shardCursor = 0;

  /** Burning tiles this update, for the ground glow and the light. */
  private hot: HotTile[] = [];
  /** One light per fire this update: its middle, reach and mean heat. */
  private lights: Array<{ x: number; y: number; r: number; heat: number }> = [];
  /** Every tile on fire or still scorched, by tileKey. */
  private readonly tiles = new Map<number, FireTile>();
  /** Creatures on fire, and until when (clock). */
  private readonly burning = new Map<FireActor, number>();
  /** The look each burning creature caught. */
  private readonly burningLook = new Map<FireActor, number>();
  /** Fire looks in use, by index; 0 is the molotov's. */
  private readonly looks: FireLook[] = [MOLOTOV_FIRE];
  private readonly lookIndex = new Map<string, number>([[JSON.stringify(MOLOTOV_FIRE), 0]]);
  /** Where each live molotov was last seen, and when (clock). */
  private readonly bottles = new Map<number, { x: number; y: number; at: number }>();
  /** Fires already shattered, so a restatement does not break the bottle twice. */
  private readonly seen = new Set<number>();
  /** Spawn accumulators, so rates are smooth at any frame rate. */
  private readonly owed = new Map<number, number>();
  /** Our own clock: summed update deltas. */
  private clock = 0;
  /** Where the last bottle broke, for tests and debugging. */
  lastShatter: { x: number; y: number } | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** The index of `look` in this.looks, adding it the first time it is seen. */
  private lookOf(fire: FireSource): number {
    const look = fire.look?.fire;
    if (!look || look === MOLOTOV_FIRE) return 0;
    const key = JSON.stringify(look);
    let index = this.lookIndex.get(key);
    if (index === undefined) {
      if (this.looks.length >= MAX_FIRE_LOOKS) return 0;
      index = this.looks.length;
      this.looks.push(look);
      this.lookIndex.set(key, index);
    }
    return index;
  }

  /** Live flames, for tests and the profiler. */
  get flameCount(): number {
    return this.nFlames;
  }

  get shardCount(): number {
    let n = 0;
    for (const s of this.shards) if (s.active) n++;
    return n;
  }

  /** Whether anything at all is left to draw. */
  get idle(): boolean {
    return (
      this.hot.length === 0 &&
      this.tiles.size === 0 &&
      this.burning.size === 0 &&
      !this.anyParticle()
    );
  }

  private anyParticle(): boolean {
    if (this.nFlames > 0 || this.nSmoke > 0 || this.nEmbers > 0) return true;
    for (const p of this.shards) if (p.active) return true;
    for (const p of this.flashes) if (p.active) return true;
    return false;
  }

  clear(): void {
    for (const list of [this.flames, this.smoke, this.embers, this.shards, this.flashes] as Array<
      Array<{ active: boolean }>
    >) {
      for (const p of list) p.active = false;
    }
    this.nFlames = 0;
    this.nSmoke = 0;
    this.nEmbers = 0;
    this.hot = [];
    this.lights = [];
    this.tiles.clear();
    this.burning.clear();
    this.burningLook.clear();
    this.bottles.clear();
    this.seen.clear();
    this.owed.clear();
  }

  /**
   * A fire the cloud layer has just been told about. A young one is a bottle
   * that has just broken: glass, a splash of burning fuel and a fireball where
   * it hit -- the bottle's last seen position when we watched it fly, else the
   * middle of the tile the fire started on.
   */
  ignite(fire: FireSource): void {
    if (this.seen.has(fire.id)) return;
    this.seen.add(fire.id);
    if (fire.ageMs > SHATTER_FRESH_MS || fire.cells.length === 0) return;
    if (!(fire.look?.fire ?? MOLOTOV_FIRE).shatter) return;
    this.breakBottleOn(fire);
  }

  /**
   * A fire we already had was fed by another bottle (the server folds a
   * molotov landing on a burning spot into that fire and starts its clock
   * again): the new bottle still breaks, where it was seen to land.
   */
  rekindle(fire: FireSource): void {
    this.seen.add(fire.id);
    if (fire.cells.length > 0 && (fire.look?.fire ?? MOLOTOV_FIRE).shatter)
      this.breakBottleOn(fire);
  }

  /**
   * Shatters the bottle that made or fed `fire`: at the last place a molotov
   * was seen flying over or next to the fire's tiles, else in the middle of
   * the tile it started on.
   */
  private breakBottleOn(fire: FireSource): void {
    const [dx, dy] = fire.cells[0];
    let x = (fire.tileX + dx) * TILE + TILE / 2;
    let y = (fire.tileY + dy) * TILE + TILE / 2;
    let best = IMPACT_MATCH_DIST * IMPACT_MATCH_DIST;
    let bestId = -1;
    for (const [id, b] of this.bottles) {
      if (this.clock - b.at > IMPACT_MEMORY_MS) continue;
      for (const [cx, cy] of fire.cells) {
        const tx = (fire.tileX + cx) * TILE + TILE / 2;
        const ty = (fire.tileY + cy) * TILE + TILE / 2;
        const d = (b.x - tx) * (b.x - tx) + (b.y - ty) * (b.y - ty);
        if (d < best) {
          best = d;
          bestId = id;
        }
      }
    }
    if (bestId >= 0) {
      const b = this.bottles.get(bestId)!;
      x = b.x;
      y = b.y;
      this.bottles.delete(bestId);
    }
    this.shatter(x, y, this.lookOf(fire));
  }

  /** The bottle breaking at (x, y); its fireball in fire look `look`. */
  shatter(x: number, y: number, look = 0): void {
    const rnd = this.random;
    this.lastShatter = { x, y };
    const flash = this.flashes.find((f) => !f.active) ?? this.flashes[0];
    Object.assign(flash, { active: true, x, y, age: 0, life: 200 });

    // Glass: shards skittering out and settling.
    const shards = this.reduced ? 7 : 14;
    for (let i = 0; i < shards; i++) {
      const s = this.nextShard();
      const a = rnd() * Math.PI * 2;
      const speed = 140 + rnd() * 220;
      Object.assign(s, {
        active: true,
        x: x + Math.cos(a) * 6,
        y: y + Math.sin(a) * 6,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        rot: rnd() * Math.PI * 2,
        vrot: (rnd() - 0.5) * 22,
        size: 3 + rnd() * 4.5,
        age: 0,
        life: 900 + rnd() * 900,
        tone: rnd() < 0.15 ? 2 : rnd() < 0.55 ? 1 : 0,
      });
    }

    // The fireball: big flames bursting from the break, slowing as they go.
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2;
      const speed = 30 + rnd() * 140;
      this.spawnFlame(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed - 25,
        24 + rnd() * 18,
        480 + rnd() * 320,
        false,
        3,
        look,
      );
    }
    // The splash: burning fuel thrown further out in small licks.
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const speed = 160 + rnd() * 160;
      this.spawnFlame(
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        14 + rnd() * 8,
        380 + rnd() * 220,
        false,
        4,
        look,
      );
    }
    // A gout of black smoke and a shower of sparks.
    const puffs = this.reduced ? 3 : 7;
    for (let i = 0; i < puffs; i++) {
      const a = rnd() * Math.PI * 2;
      this.spawnSmoke(
        x + Math.cos(a) * 30,
        y + Math.sin(a) * 30 - 20,
        Math.cos(a) * 50,
        Math.sin(a) * 50 - 40,
        12,
        36,
        1,
        look,
      );
    }
    const sparks = this.reduced ? 8 : 22;
    for (let i = 0; i < sparks; i++) {
      const a = rnd() * Math.PI * 2;
      const speed = 120 + rnd() * 260;
      this.spawnEmber(x, y, Math.cos(a) * speed, Math.sin(a) * speed - 40, 500 + rnd() * 700, look);
    }
  }

  update(deltaMs: number, input: FireUpdateInput): void {
    if (deltaMs <= 0) return;
    // A long stall (a hidden tab) would spawn a second's worth at once: cap it.
    const dt = Math.min(deltaMs, 100);
    this.clock += dt;
    const sec = dt / 1000;
    const rnd = this.random;
    const decor = this.reduced ? 0.35 : 1;
    const wind = this.wind();

    // 1. Which tiles burn, and how hot. A tile under two fires is ONE tile at
    // the hotter of the two, so stacked molotovs never stack flames.
    for (const tile of this.tiles.values()) tile.heat = 0;
    const live = new Set<number>();
    for (const fire of input.fires) {
      live.add(fire.id);
      const look = this.lookOf(fire);
      const left = Math.max(0, fire.growMs + fire.holdMs + fire.fadeMs - fire.ageMs);
      for (let i = 0; i < fire.cells.length; i++) {
        const heat = tileHeat(fire, i);
        if (heat <= 0) continue;
        const tx = fire.tileX + fire.cells[i][0];
        const ty = fire.tileY + fire.cells[i][1];
        const key = tileKey(tx, ty);
        let tile = this.tiles.get(key);
        if (!tile) {
          tile = {
            x: tx * TILE + TILE / 2,
            y: ty * TILE + TILE / 2,
            tx,
            ty,
            seed: hash01(key),
            at: this.clock,
            heat: 0,
            endsAt: 0,
            owed: rnd(),
            look,
          };
          this.tiles.set(key, tile);
        }
        tile.look = look;
        tile.heat = Math.max(tile.heat, heat);
        tile.endsAt = Math.max(tile.endsAt, this.clock + left);
      }
    }
    for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);

    const hot: HotTile[] = [];
    const lights: Array<{ x: number; y: number; r: number; heat: number }> = [];
    const burningNow: FireTile[] = [];
    for (const tile of this.tiles.values()) if (tile.heat > 0) burningNow.push(tile);
    const isHot = (tx: number, ty: number) => (this.tiles.get(tileKey(tx, ty))?.heat ?? 0) > 0;

    // 2. Each patch of touching burning tiles is one fire: one light, one
    // plume of smoke, and its rim leaning in toward its own middle.
    const grouped = new Set<FireTile>();
    for (const start of burningNow) {
      if (grouped.has(start)) continue;
      const patch: FireTile[] = [start];
      grouped.add(start);
      for (let k = 0; k < patch.length; k++) {
        const t = patch[k];
        for (const [ox, oy] of NEIGHBOURS) {
          const next = this.tiles.get(tileKey(t.tx + ox, t.ty + oy));
          if (next && next.heat > 0 && !grouped.has(next)) {
            grouped.add(next);
            patch.push(next);
          }
        }
      }
      let midX = 0;
      let midY = 0;
      let heatSum = 0;
      let top = Infinity;
      let spanX = 0;
      for (const t of patch) {
        midX += t.x;
        midY += t.y;
        heatSum += t.heat;
      }
      midX /= patch.length;
      midY /= patch.length;
      for (const t of patch) {
        top = Math.min(top, t.y);
        spanX = Math.max(spanX, Math.abs(t.x - midX));
      }
      const patchHeat = heatSum / patch.length;
      lights.push({
        x: midX,
        y: midY,
        r: 70 + Math.sqrt(patch.length) * 42,
        heat: patchHeat,
      });
      if (rnd() < SMOKE_RATE * decor * (0.3 + 0.7 * patchHeat) * Math.sqrt(patch.length) * sec) {
        this.spawnSmoke(
          midX + (rnd() - 0.5) * 2 * (spanX + 30),
          top - 40 - rnd() * 20,
          wind.x + (rnd() - 0.5) * 12,
          wind.y + (rnd() - 0.5) * 10,
          10 + rnd() * 4,
          28 + rnd() * 14,
          0.7 + 0.3 * patchHeat,
          start.look,
        );
      }

      for (const tile of patch) {
        const { x, y, heat } = tile;
        let neighbours = 0;
        if (isHot(tile.tx + 1, tile.ty)) neighbours++;
        if (isHot(tile.tx - 1, tile.ty)) neighbours++;
        if (isHot(tile.tx, tile.ty + 1)) neighbours++;
        if (isHot(tile.tx, tile.ty - 1)) neighbours++;
        const edge = 0.7 + 0.075 * neighbours;
        hot.push({ x, y, heat, edge });
        // A tile on the rim leans its flames inward: a corner most of all.
        const pull = (4 - neighbours) * 0.1;
        const cx = x + (midX - x) * pull;
        const cy = y + (midY - y) * pull;

        tile.owed += FLAME_RATE * heat * sec;
        while (tile.owed >= 1) {
          tile.owed -= 1;
          const a = rnd() * Math.PI * 2;
          const d = Math.sqrt(rnd()) * FLAME_SPREAD * (0.7 + 0.3 * edge);
          const r =
            (FLAME_MIN_R + rnd() * (FLAME_MAX_R - FLAME_MIN_R)) * (0.55 + 0.45 * heat) * edge;
          this.spawnFlame(
            cx + Math.cos(a) * d,
            cy + Math.sin(a) * d * 0.9,
            wind.x * 0.25 + (rnd() - 0.5) * 14,
            -(24 + rnd() * 30),
            r,
            520 + rnd() * 360,
            false,
            0,
            tile.look,
          );
        }

        // The carpet: big, slow, long-lived flames low in the tile, so the
        // ground between the tongues reads as burning rather than bare.
        if (rnd() < BASE_RATE * heat * sec) {
          const a = rnd() * Math.PI * 2;
          const d = Math.sqrt(rnd()) * 36 * edge;
          this.spawnFlame(
            cx + Math.cos(a) * d,
            cy + Math.sin(a) * d + 8,
            (rnd() - 0.5) * 8,
            -(6 + rnd() * 10),
            (40 + rnd() * 15) * (0.5 + 0.5 * heat) * edge,
            900 + rnd() * 600,
            false,
            0,
            tile.look,
          );
        }

        if (rnd() < EMBER_RATE * decor * heat * sec) {
          this.spawnEmber(
            x + (rnd() - 0.5) * 80,
            y + (rnd() - 0.5) * 80,
            wind.x * 0.6 + (rnd() - 0.5) * 50,
            -(60 + rnd() * 100),
            700 + rnd() * 900,
            tile.look,
          );
        }
      }
    }
    this.hot = hot;
    this.lights = lights;

    // Tiles no longer burning: the scorch stays a while and smoulders first.
    for (const [key, tile] of this.tiles) {
      if (tile.heat > 0) continue;
      const since = Math.max(0, this.clock - tile.endsAt);
      if (since >= SCORCH_LINGER_MS) {
        this.tiles.delete(key);
        continue;
      }
      if (since < SMOULDER_MS) {
        const fading = 1 - since / SMOULDER_MS;
        if (rnd() < 0.35 * decor * fading * sec) {
          this.spawnSmoke(
            tile.x + (rnd() - 0.5) * 60,
            tile.y + (rnd() - 0.5) * 60,
            wind.x,
            wind.y * 0.7,
            6,
            22,
            0.5 + 0.5 * fading,
            tile.look,
          );
        }
        if (rnd() < 1.2 * decor * fading * sec) {
          this.spawnEmber(
            tile.x + (rnd() - 0.5) * 70,
            tile.y + (rnd() - 0.5) * 70,
            wind.x * 0.3,
            -(20 + rnd() * 40),
            500 + rnd() * 600,
            tile.look,
          );
        }
      }
    }

    // 3. Creatures in the fire catch; out of it, they burn on a moment.
    if (input.creatures) {
      const burningTiles = new Map<number, number>();
      for (const t of hot)
        if (t.heat > 0.25) {
          const key = tileKey(Math.floor(t.x / TILE), Math.floor(t.y / TILE));
          burningTiles.set(key, this.tiles.get(key)?.look ?? 0);
        }
      for (const c of input.creatures) {
        if (burningTiles.size === 0) break;
        const look = burningTiles.get(tileKey(Math.floor(c.x / TILE), Math.floor(c.y / TILE)));
        if (look !== undefined) {
          this.burning.set(c, this.clock + AFTERBURN_MS);
          this.burningLook.set(c, look);
        }
      }
    }
    for (const [c, until] of this.burning) {
      const left = until - this.clock;
      const look = this.burningLook.get(c) ?? 0;
      if (left <= 0) {
        this.burning.delete(c);
        this.burningLook.delete(c);
        this.owed.delete(-1 - this.burningIndex(c));
        continue;
      }
      const strength = Math.min(1, left / AFTERBURN_MS + 0.35);
      let owed = (this.owed.get(-1 - this.burningIndex(c)) ?? 0) + 8 * strength * sec;
      while (owed >= 1) {
        owed -= 1;
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * 30;
        this.spawnFlame(
          c.x + Math.cos(a) * d,
          c.y + Math.sin(a) * d,
          (rnd() - 0.5) * 16,
          -(40 + rnd() * 30),
          (13 + rnd() * 9) * strength,
          320 + rnd() * 200,
          true,
          0,
          look,
        );
      }
      this.owed.set(-1 - this.burningIndex(c), owed);
      if (rnd() < 2.5 * decor * strength * sec) {
        this.spawnSmoke(c.x, c.y - 30, wind.x, wind.y, 6, 18, strength, look);
      }
    }

    // 4. Bottles in flight: a trail of fire and smoke, and where each last was.
    if (input.projectiles) {
      for (const p of input.projectiles) {
        const last = this.bottles.get(p.id);
        this.bottles.set(p.id, { x: p.x, y: p.y, at: this.clock });
        const moved = last ? Math.hypot(p.x - last.x, p.y - last.y) : 0;
        if (moved <= 0.5) continue;
        // A short tail of small licks, one per ~20 units flown so it is even at any speed.
        const steps = Math.min(6, Math.ceil(moved / 20));
        for (let k = 0; k < steps; k++) {
          const t = (k + rnd()) / steps;
          const x = last!.x + (p.x - last!.x) * t;
          const y = last!.y + (p.y - last!.y) * t;
          this.spawnFlame(
            x,
            y,
            (rnd() - 0.5) * 16,
            -(20 + rnd() * 20),
            4 + rnd() * 4,
            130 + rnd() * 90,
            true,
            0,
          );
        }
        if (rnd() < 0.35 * decor)
          this.spawnEmber(p.x, p.y, (rnd() - 0.5) * 60, -(30 + rnd() * 50), 300 + rnd() * 400);
      }
    }
    for (const [id, b] of this.bottles)
      if (this.clock - b.at > IMPACT_MEMORY_MS) this.bottles.delete(id);

    // 5. Move everything.
    // Backwards, so a dead one can swap with the last live one, already moved.
    for (let i = this.nFlames - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.age += dt;
      if (f.age >= f.life) {
        f.active = false;
        this.flames[i] = this.flames[--this.nFlames];
        this.flames[this.nFlames] = f;
        continue;
      }
      if (f.drag > 0) {
        const keep = Math.exp(-f.drag * sec);
        f.vx *= keep;
        f.vy = f.vy * keep - 30 * sec;
      }
      f.x += f.vx * sec;
      f.y += f.vy * sec;
    }
    for (let i = this.nSmoke - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        this.smoke[i] = this.smoke[--this.nSmoke];
        this.smoke[this.nSmoke] = s;
        continue;
      }
      s.x += s.vx * sec;
      s.y += s.vy * sec;
    }
    const emberKeep = Math.exp(-1.6 * sec);
    for (let i = this.nEmbers - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.age += dt;
      if (e.age >= e.life) {
        e.active = false;
        this.embers[i] = this.embers[--this.nEmbers];
        this.embers[this.nEmbers] = e;
        continue;
      }
      const keep = emberKeep;
      e.vx = e.vx * keep + Math.sin(this.clock / 180 + e.seed * 40) * 60 * sec + wind.x * 0.8 * sec;
      e.vy = e.vy * keep - 18 * sec;
      e.x += e.vx * sec;
      e.y += e.vy * sec;
    }
    for (const s of this.shards) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        continue;
      }
      const keep = Math.exp(-7 * sec);
      s.vx *= keep;
      s.vy *= keep;
      s.vrot *= keep;
      s.x += s.vx * sec;
      s.y += s.vy * sec;
      s.rot += s.vrot * sec;
    }
    for (const f of this.flashes) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) f.active = false;
    }
  }

  /** A stable small number per burning creature, for its spawn accumulator. */
  private readonly burnIds = new WeakMap<FireActor, number>();
  private nextBurnId = 0;
  private burningIndex(c: FireActor): number {
    let id = this.burnIds.get(c);
    if (id === undefined) {
      id = this.nextBurnId++ % 100000;
      this.burnIds.set(c, id);
    }
    return id;
  }

  /** A slow, gusting breeze: where smoke and embers drift. */
  private wind(): { x: number; y: number } {
    const t = this.clock / 1000;
    return {
      x: 14 + 9 * Math.sin(t * 0.21) + 4 * Math.sin(t * 0.83),
      y: -24 - 4 * Math.sin(t * 0.37),
    };
  }

  private spawnFlame(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    life: number,
    over: boolean,
    drag: number,
    look = 0,
  ): void {
    if (this.nFlames >= this.flames.length) return;
    {
      const f = this.flames[this.nFlames++];
      f.active = true;
      f.x = x;
      f.y = y;
      f.vx = vx;
      f.vy = vy;
      f.r = r;
      f.age = 0;
      f.life = life;
      f.seed = this.random();
      f.over = over;
      f.drag = drag;
      f.look = look;
      return;
    }
  }

  private spawnSmoke(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r0: number,
    r1: number,
    /** Scales the whole puff: how big it gets. */
    peak: number,
    look = 0,
  ): void {
    if (this.nSmoke >= this.smoke.length) return;
    const s = this.smoke[this.nSmoke++];
    s.active = true;
    s.x = x;
    s.y = y;
    s.vx = vx;
    s.vy = vy;
    s.r0 = r0;
    s.r1 = r1;
    s.age = 0;
    s.life = 2000 + this.random() * 1400;
    s.peak = peak;
    s.look = look;
  }

  private spawnEmber(x: number, y: number, vx: number, vy: number, life: number, look = 0): void {
    if (this.nEmbers >= this.embers.length) return;
    const e = this.embers[this.nEmbers++];
    e.active = true;
    e.x = x;
    e.y = y;
    e.vx = vx;
    e.vy = vy;
    e.size = 1.6 + this.random() * 1.8;
    e.age = 0;
    e.life = life;
    e.seed = this.random();
    e.look = look;
  }

  private nextShard(): Shard {
    const s = this.shards[this.shardCursor];
    this.shardCursor = (this.shardCursor + 1) % this.shards.length;
    return s;
  }

  // ---- drawing ------------------------------------------------------------

  /**
   * On the ground, under creatures and walls: scorch, the fire's light, the
   * flames. Camera transform applied (world space).
   */
  renderGround(ctx: CanvasRenderingContext2D, camera: Camera, timeMs: number, night = 0): void {
    if (this.idle) return;
    const view = viewOf(camera);
    ctx.save();

    // Scorch: flat dark blots, fading long after the fire. Every tile at the
    // same strength is one fill (a few strengths at most), and a tile two
    // fires burned is still one tile.
    ctx.fillStyle = SCORCH_COLOUR;
    for (let level = SCORCH_LEVELS; level >= 1; level--) {
      ctx.beginPath();
      let any = false;
      for (const tile of this.tiles.values()) {
        if (!inView(view, tile.x, tile.y, 110)) continue;
        const since = tile.heat > 0 ? 0 : Math.max(0, this.clock - tile.endsAt);
        const linger =
          since <= SCORCH_LINGER_MS - SCORCH_FADE_MS
            ? 1
            : clamp01((SCORCH_LINGER_MS - since) / SCORCH_FADE_MS);
        const grown = clamp01((this.clock - tile.at) / 1200);
        if (Math.ceil(linger * SCORCH_LEVELS) !== level || grown <= 0) continue;
        any = true;
        // A few overlapping blots per tile, fixed per tile, so the edge is ragged.
        for (let k = 0; k < 4; k++) {
          const a = hash01(tile.seed * 1e6 + k) * Math.PI * 2;
          const d = 18 + hash01(tile.seed * 1e6 + k + 9) * 22;
          const r = (34 + hash01(tile.seed * 1e6 + k + 17) * 16) * (0.6 + 0.4 * grown);
          addCircle(ctx, tile.x + Math.cos(a) * d, tile.y + Math.sin(a) * d, r);
        }
      }
      if (!any) continue;
      ctx.globalAlpha = (0.18 * level) / SCORCH_LEVELS;
      ctx.fill();
    }

    // Light: the campfire's two flat discs, one pair per fire, breathing.
    if (this.lights.length > 0) {
      const [outer, inner] = clamp01(night) >= 0.5 ? LIGHT_NIGHT : LIGHT_DAY;
      const strength = clamp01(night) >= 0.5 ? 0.32 : 0.2;
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (const l of this.lights) {
          if (!inView(view, l.x, l.y, l.r)) continue;
          const breathe = 1 + 0.035 * Math.sin(timeMs / 170 + l.x * 0.01);
          addCircle(ctx, l.x, l.y, l.r * (pass === 0 ? 1 : 0.62) * (0.5 + 0.5 * l.heat) * breathe);
        }
        ctx.globalAlpha = strength;
        ctx.fillStyle = pass === 0 ? outer : inner;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    this.drawFlames(ctx, view, timeMs, false);
    ctx.restore();
  }

  /**
   * Over everything but names: smoke, embers, glass, the flash of the bottle
   * breaking, and the flames on burning creatures and flying bottles.
   */
  renderTop(ctx: CanvasRenderingContext2D, camera: Camera, timeMs: number): void {
    if (this.idle) return;
    const view = viewOf(camera);
    ctx.save();

    // The bottle breaking: a white burst like the explosion's, out and gone.
    ctx.fillStyle = 'rgb(248,248,248)';
    for (const f of this.flashes) {
      if (!f.active) continue;
      const u = f.age / f.life;
      const r = 46 * Math.sin(Math.PI * Math.min(1, u * 1.15));
      if (r <= 0.5) continue;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      addCircle(ctx, f.x, f.y, r);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Glass, skittering out and lying where it stopped.
    for (const tone of [0, 1, 2]) {
      ctx.beginPath();
      let any = false;
      for (const s of this.shards) {
        if (!s.active || s.tone !== tone || !inView(view, s.x, s.y, 10)) continue;
        // Shrinks away at the end rather than fading: everything here is flat.
        const z = s.size * clamp01((s.life - s.age) / 300);
        if (z <= 0.3) continue;
        any = true;
        const c = Math.cos(s.rot);
        const sn = Math.sin(s.rot);
        ctx.moveTo(s.x + c * z, s.y + sn * z);
        ctx.lineTo(s.x - c * z * 0.6 - sn * z * 0.5, s.y - sn * z * 0.6 + c * z * 0.5);
        ctx.lineTo(s.x - c * z * 0.3 + sn * z * 0.6, s.y - sn * z * 0.3 - c * z * 0.6);
        ctx.closePath();
      }
      if (!any) continue;
      ctx.fillStyle = GLASS[tone];
      ctx.fill();
    }

    // Flames on whoever is burning, and the bottle's trail.
    this.drawFlames(ctx, view, timeMs, true);

    // Smoke: grey puffs that swell as they drift off and shrink away. The
    // body and its lit top are each one flat shape per fire look.
    let smokeLooks = 0;
    for (let i = 0; i < this.nSmoke; i++) smokeLooks |= 1 << this.smoke[i].look;
    for (let look = 0; look < this.looks.length; look++) {
      if (!(smokeLooks & (1 << look))) continue;
      for (const lit of [false, true]) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < this.nSmoke; i++) {
          const s = this.smoke[i];
          if (s.look !== look) continue;
          const u = s.age / s.life;
          const r =
            (s.r0 + (s.r1 - s.r0) * Math.min(1, u * 2)) *
            (u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45) *
            s.peak;
          if (r <= 0.5 || !inView(view, s.x, s.y, r * 1.6)) continue;
          any = true;
          // A puff is three lobes, like the explosion's smoke, its lit top on the upper one.
          if (lit) addCircle(ctx, s.x - r * 0.3, s.y - r * 0.42, r * 0.5);
          else {
            addCircle(ctx, s.x, s.y, r);
            addCircle(ctx, s.x - r * 0.62, s.y + r * 0.18, r * 0.66);
            addCircle(ctx, s.x + r * 0.55, s.y + r * 0.28, r * 0.58);
          }
        }
        if (!any) continue;
        ctx.globalAlpha = SMOKE_ALPHA;
        ctx.fillStyle = lit ? this.looks[look]!.smokeLight : this.looks[look]!.smokeDark;
        ctx.fill();
      }
    }

    // Embers: the campfire's little yellow sparks, shrinking out.
    ctx.globalAlpha = 0.9;
    let emberLooks = 0;
    for (let i = 0; i < this.nEmbers; i++) emberLooks |= 1 << this.embers[i].look;
    for (let look = 0; look < this.looks.length; look++) {
      if (!(emberLooks & (1 << look))) continue;
      ctx.fillStyle = this.looks[look]!.ember;
      ctx.beginPath();
      let sparks = false;
      for (let i = 0; i < this.nEmbers; i++) {
        const e = this.embers[i];
        if (e.look !== look || !inView(view, e.x, e.y, 6)) continue;
        const z = e.size * (1 - e.age / e.life);
        if (z <= 0.3) continue;
        sparks = true;
        addCircle(ctx, e.x, e.y, z);
      }
      if (sparks) ctx.fill();
    }
    ctx.restore();
  }

  /** Every live flame of one layer, each colour filled as one shape. */
  private drawFlames(
    ctx: CanvasRenderingContext2D,
    view: View,
    timeMs: number,
    over: boolean,
  ): void {
    const t = timeMs / 1000;
    let used = 0;
    for (let i = 0; i < this.nFlames; i++)
      if (this.flames[i].over === over) used |= 1 << this.flames[i].look;
    for (let look = 0; look < this.looks.length; look++) {
      if (!(used & (1 << look))) continue;
      const colours = this.looks[look]!.flames;
      for (let layer = 0; layer < FLAME_LAYERS.length; layer++) {
        const scale = FLAME_LAYERS[layer]![1];
        const colour = colours[layer]!;
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < this.nFlames; i++) {
          const f = this.flames[i];
          if (f.over !== over || f.look !== look) continue;
          const r = f.r * flameScale(f.age / f.life) * scale;
          // A speck reads as a stray little fire, not as part of the blaze: skip it.
          if (r <= MIN_DRAWN_R || !inView(view, f.x, f.y, f.r * 3)) continue;
          any = true;
          // The inner colours sit a little lower, hugging the base, and every
          // flame's tip wags on its own beat.
          const lean = Math.sin(t * 6 + f.seed * 30) * 0.6;
          addFlame(ctx, f.x, f.y + f.r * (1 - scale) * 0.45, r, lean);
        }
        if (!any) continue;
        ctx.fillStyle = colour;
        ctx.fill();
      }
    }
  }
}
