// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The start screen's backdrop: a survivor camp in a forest clearing -- a lit
// firepit, a workbench and a survivor warming up by the fire, trees all
// around -- drawn by the game's own renderer on the game canvas, behind the
// start window, while the camera drifts slowly over it. Pressing Play closes in
// on the fire; joining pushes in and fades to dark as the game takes over.
//
// Placements are encoded the way the server sends them (editor/scene/scene-world.ts)
// and loaded into a private WorldState, so sprites, layering, the fire's light
// and the day / night palettes are exactly the game's. Day or night follows the
// player's own clock; `?home=day` or `?home=night` picks one.
//
// The forest is scattered from a fixed seed, so every visit shows the same
// place. Cheap by design: about 30 frames a second, nothing while the tab is
// hidden or the start screen is down, and a still camera for players who ask
// for reduced motion.
import type { AssetLoader } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import { baseWorldScale, Camera } from '../../core/camera';
import type { CanvasManager } from '../../core/canvas';
import { EditorCatalog } from '../../editor/catalog/catalog';
import { unitRecordFor } from '../../editor/scene/scene-world';
import type { UnitRecord } from '../../net/events';
import { BuildingAnimator } from '../../render/building-animator';
import { CharacterAnimator } from '../../render/character-animator';
import { CAMPFIRE_LIGHT_SPRITES } from '../../render/building-renderer';
import { GameRenderer } from '../../render/renderer';
import { nightAt } from '../../render/sky';
import { EntityType } from '../../world/entity-types';
import { newPlayerInfo, WorldState } from '../../world/world-state';
import type { ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';

/** One thing in the scene: an objects/furnitures or resources key at a world position. */
export interface BackdropPlacement {
  kind: 'object' | 'resource';
  ref: string;
  /** Resource type id. */
  variant?: number;
  x: number;
  y: number;
  /** Objects: quarter turns 0..3. */
  rotation?: number;
  /** Resources: facing 0..255. */
  angle?: number;
  /** Campfires: burning. */
  lit?: boolean;
}

const TILE = 100;
/** The private world, in tiles: wide enough that no screen shape reaches its edge. */
export const BACKDROP_TILES_X = 40;
export const BACKDROP_TILES_Y = 30;
/** The firepit, the middle of the camp. */
export const CAMP = { x: 2050, y: 1550 } as const;

/** The camp, by hand, on tile centres: a burning firepit and a workbench beside it. */
const CAMP_PLACEMENTS: readonly BackdropPlacement[] = [
  { kind: 'object', ref: 'firepit', x: 2050, y: 1550, lit: true },
  { kind: 'object', ref: 'workbench', x: 2250, y: 1450 },
];

/** The clearing the forest keeps out of: an ellipse around the camp. */
const CLEARING = { x: 2100, y: 1520, rx: 380, ry: 300 } as const;

/** Small deterministic PRNG (mulberry32): the same forest on every load. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the clearing is, 0 at its middle, 1 on its rim. */
function clearingDistance(x: number, y: number): number {
  const dx = (x - CLEARING.x) / CLEARING.rx;
  const dy = (y - CLEARING.y) / CLEARING.ry;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The forest around the clearing: leafy trees and pines whose crowns overlap,
 * a ragged treeline at the clearing's edge, the odd boulder among the trunks
 * and a few mushrooms where the trees begin.
 */
export function scatterForest(seed = 0x9e3779b1): BackdropPlacement[] {
  const rand = seededRandom(seed);
  const out: BackdropPlacement[] = [];
  const trunks: { x: number; y: number; r: number }[] = [];
  const free = (x: number, y: number, r: number, spacing: number) =>
    trunks.every((t) => Math.hypot(t.x - x, t.y - y) > (t.r + r) * spacing);
  const width = BACKDROP_TILES_X * TILE;
  const height = BACKDROP_TILES_Y * TILE;
  const facing = () => Math.floor(rand() * 256);

  // Radius by resources.xml type id (leaf_tree 0..4, wood 0..4, stone 0..2).
  const LEAF = [70, 52, 42, 34, 54];
  const PINE = [80, 55, 48, 37, 30];
  const ROCK = [60, 58, 54];
  for (let i = 0; i < 8000 && trunks.length < 520; i++) {
    const x = 60 + rand() * (width - 120);
    const y = 60 + rand() * (height - 120);
    const d = clearingDistance(x, y);
    if (d < 1) continue;
    // Thin just outside the clearing so its edge reads as a ragged treeline.
    if (d < 1.35 && rand() > 0.25 + (d - 1) / 0.35) continue;
    if (d > 1.3 && rand() < 0.05) {
      const variant = Math.floor(rand() * 3);
      if (!free(x, y, ROCK[variant]!, 1.2)) continue;
      trunks.push({ x, y, r: ROCK[variant]! });
      out.push({
        kind: 'resource',
        ref: 'stone',
        variant,
        x: Math.round(x),
        y: Math.round(y),
        angle: facing(),
      });
      continue;
    }
    const leafy = rand() < 0.6;
    const variant = Math.floor(rand() * 5);
    const r = (leafy ? LEAF : PINE)[variant]!;
    if (!free(x, y, r, 1.05)) continue;
    trunks.push({ x, y, r });
    out.push({
      kind: 'resource',
      ref: leafy ? 'leaf_tree' : 'wood',
      variant,
      x: Math.round(x),
      y: Math.round(y),
      angle: facing(),
    });
  }

  // Mushrooms where the trees begin.
  const shrooms: [string, number][] = [
    ['mushroom1', 0],
    ['mushroom2', 1],
    ['mushroom1', 2],
    ['mushroom3', 3],
  ];
  for (const [ref, variant] of shrooms) {
    for (let tries = 0; tries < 60; tries++) {
      const a = rand() * Math.PI * 2;
      const k = 1 + rand() * 0.15;
      const x = CLEARING.x + Math.cos(a) * CLEARING.rx * k;
      const y = CLEARING.y + Math.sin(a) * CLEARING.ry * k;
      if (!free(x, y, 30, 1)) continue;
      trunks.push({ x, y, r: 30 });
      out.push({
        kind: 'resource',
        ref,
        variant,
        x: Math.round(x),
        y: Math.round(y),
        angle: facing(),
      });
      break;
    }
  }
  return out;
}

/** The whole scene: camp first, then the forest. */
export function backdropPlacements(): BackdropPlacement[] {
  return [...CAMP_PLACEMENTS, ...scatterForest()];
}

/** Wire records for the placements; anything the content does not know is skipped. */
export function backdropRecords(
  placements: readonly BackdropPlacement[],
  content: ContentStore,
  catalog = EditorCatalog.fromContent(content),
): UnitRecord[] {
  const records: UnitRecord[] = [];
  placements.forEach((p, i) => {
    const e: ScenarioEntity = {
      id: `home-${i}`,
      kind: p.kind,
      ref: p.ref,
      variant: p.variant,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      angle: p.angle,
    };
    const record = unitRecordFor(e, catalog.resolve(p.kind, p.ref, p.variant), content, i + 1);
    if (!record) return;
    // A burning campfire: state bit 5, the "working" bit the animator ramps `lit` from.
    if (p.lit) record.state |= 32;
    records.push(record);
  });
  return records;
}

/** Sprite names the scene draws, so they can be loaded (and pinned) before it fades in. */
export function backdropSprites(
  placements: readonly BackdropPlacement[],
  content: ContentStore,
): Set<string> {
  const names = new Set<string>(CAMPFIRE_LIGHT_SPRITES);
  const collect = (client: unknown) => {
    const walk = (v: unknown, key?: string): void => {
      if (typeof v === 'string') {
        if (key === 'sprite' || key === 'spriteTop' || key === 'spriteFull') names.add(v);
      } else if (Array.isArray(v)) {
        for (const item of v) walk(item);
      } else if (v && typeof v === 'object') {
        for (const [k, item] of Object.entries(v)) {
          // Construction stages and blueprints are never shown here.
          if (k === 'hidden' || k === 'blueprint' || k === 'redprint') continue;
          walk(item, k);
        }
      }
    };
    walk(client);
  };
  const seen = new Set<string>();
  for (const p of placements) {
    const key = `${p.kind}:${p.ref}:${p.kind === 'resource' ? (p.variant ?? 0) : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.kind === 'resource') {
      // Only the types placed: a resource's client lists every type's art.
      const client = content.has('resources')
        ? (content.byKey('resources', p.ref)?.client as { type?: { id: number }[] } | undefined)
        : undefined;
      collect(client?.type?.find((t) => t.id === (p.variant ?? 0)));
    } else {
      for (const table of ['objects', 'furnitures'] as const) {
        if (!content.has(table)) continue;
        const entry = content.byKey(table, p.ref) as { client?: unknown } | undefined;
        if (entry) collect(entry.client);
      }
    }
  }
  return names;
}

/** Day 07:00-19:00 on the player's clock; `?home=day|night` decides instead. */
export function backdropNight(now: Date, search = ''): number {
  const pick = new URLSearchParams(search).get('home');
  if (pick === 'day') return 0;
  if (pick === 'night') return 1;
  const DAY_MS = 24 * 3600_000;
  const msOfDay =
    ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 +
    now.getMilliseconds();
  return nightAt(msOfDay - 7 * 3600_000, DAY_MS);
}

/**
 * Where the camera looks, `t` ms into its slow loop, on a view `viewWidth`
 * world units wide. On a wide screen the camp sits right of the start window
 * (CAMP_ACROSS of the way across that space); on a narrow one the window covers
 * the middle anyway.
 * Two unrelated periods, so the loop never quite repeats.
 */
export function driftAt(
  t: number,
  viewWidth: number,
  screenWidth: number,
): { x: number; y: number } {
  // The firepit sits a little left of the middle of the space right of the start window.
  const windowRight = screenWidth / 2 + START_WINDOW_HALF;
  const fireX = windowRight + (screenWidth - windowRight) * CAMP_ACROSS;
  const offset = screenWidth >= WIDE_SCREEN ? (fireX / screenWidth - 0.5) * viewWidth : 0;
  return {
    x: CAMP.x - offset + 150 * Math.sin((t / 97_000) * Math.PI * 2),
    y: CAMP.y + 80 * Math.sin((t / 71_000) * Math.PI * 2 + 1),
  };
}

/** From this CSS width the camp is framed beside the start window. */
const WIDE_SCREEN = 1000;
/** Half the start window's width plus a margin for the fire's glow (CSS px). */
const START_WINDOW_HALF = 240;
/** How far across the space right of the start window the firepit sits (0..1). */
const CAMP_ACROSS = 0.42;

/** The survivor warming up by the fire: their player id in the private world, and where they stand. */
const SURVIVOR_PID = 1;
export const SURVIVOR = { x: 2170, y: 1595 } as const;
/** Facing the fire, glancing round now and then (radians, slow). */
function survivorAngle(t: number): number {
  const toFire = Math.atan2(CAMP.y - SURVIVOR.y, CAMP.x - SURVIVOR.x);
  // Mostly still, with an occasional look over the shoulder toward the trees.
  const glance = Math.max(0, Math.sin((t / 23_000) * Math.PI * 2)) ** 6;
  return toFire + 0.12 * Math.sin((t / 5_300) * Math.PI * 2) - 1.1 * glance;
}

const FRAME_MS = 1000 / 30;
const STILL_FRAME_MS = 250;
const FADE_MS = 1400;
/** Longest the fade-in waits for sprites before showing whatever has arrived. */
const SPRITE_WAIT_MS = 3000;
/** Wider than the game's view, so the camp and the forest round it fit beside the start window. */
const ZOOM = 0.72;
/** How far the view leans toward the pointer, in world units. */
const PARALLAX = 40;
const FADE_RGB = '5, 8, 12';
/** Play pressed: the view closes in on the fire, where it stands on screen, this much over APPROACH_MS. */
const APPROACH_ZOOM = 1.45;
const APPROACH_MS = 1800;
/** Joined: the last push in and the fade to dark before the game takes the canvas. */
export const LEAVE_MS = 450;
const LEAVE_ZOOM = 1.25;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export interface HomeBackdropOptions {
  canvas: CanvasManager;
  content: ContentStore;
  assets: AssetLoader;
  /** Injected for tests. */
  win?: Window;
}

export class HomeBackdrop {
  private readonly canvas: CanvasManager;
  private readonly content: ContentStore;
  private readonly assets: AssetLoader;
  private readonly win: Window;
  private readonly camera = new Camera();
  private readonly renderer = new GameRenderer();
  private readonly animator = new BuildingAnimator();
  private readonly characters = new CharacterAnimator();
  private world: WorldState | null = null;
  private contentReady = false;
  private running = false;
  private frame = 0;
  private lastFrame = 0;
  private lastDraw = 0;
  /** Drift clock: only runs while the backdrop is drawn. */
  private clock = 0;
  /** When the fade-in began; null until the sprites are in (or the wait ran out). */
  private fadeFrom: number | null = null;
  private spritesWanted = false;
  private pointer = { x: 0, y: 0 };
  private lean = { x: 0, y: 0 };
  /** The survivor's look: a wearable id (0 = none); skins will land here. */
  private survivorSkin = 0;
  /** The name over the survivor: whatever is in the start screen's name box. */
  private survivorName = '';
  private survivorVerified = false;
  /** 0..1 how far the view has closed in on the fire, and where it is heading. */
  private approach = 0;
  private approachTarget = 0;
  /** ms into leaving (fade to dark), or null. */
  private leaving: number | null = null;
  private readonly reducedMotion: MediaQueryList | null;
  private readonly onPointer = (ev: PointerEvent) => {
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    this.pointer = { x: (ev.clientX / w) * 2 - 1, y: (ev.clientY / h) * 2 - 1 };
  };

  constructor(options: HomeBackdropOptions) {
    this.canvas = options.canvas;
    this.content = options.content;
    this.assets = options.assets;
    this.win = options.win ?? window;
    this.reducedMotion = this.win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  }

  /** The content tables are in: the scene can be built. Safe to call again. */
  setContentReady(): void {
    this.contentReady = true;
  }

  /** What the survivor by the fire wears (a wearables.xml id; 0 = nothing). */
  setSurvivorSkin(wearableId: number): void {
    this.survivorSkin = wearableId & 255;
    if (this.world) this.placeSurvivor(this.world, survivorAngle(this.clock));
  }

  /**
   * The name over the survivor, as other players will see it (empty = none),
   * with the verified tick when it is a registered account's.
   */
  setSurvivorName(name: string, verified = false): void {
    this.survivorName = name;
    this.survivorVerified = verified;
    const info = this.world?.players.get(SURVIVOR_PID);
    if (info) {
      info.nickname = name;
      info.verified = verified && name !== '';
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = 0;
    this.approach = this.approachTarget = 0;
    this.leaving = null;
    this.win.addEventListener('pointermove', this.onPointer, { passive: true });
    this.frame = this.win.requestAnimationFrame(this.loop);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.win.cancelAnimationFrame(this.frame);
    this.win.removeEventListener('pointermove', this.onPointer);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Play pressed: close in on the fire while the join runs. */
  closeIn(): void {
    this.approachTarget = 1;
  }

  /** The join ended without a game (failed, cancelled): back to the slow drift. */
  pullBack(): void {
    this.approachTarget = 0;
    this.leaving = null;
  }

  /** Joined: push in and fade to dark; resolves when the canvas can go to the game. */
  leave(): Promise<void> {
    this.approachTarget = 1;
    this.leaving = 0;
    const ms = this.running ? LEAVE_MS : 0;
    return new Promise((resolve) => this.win.setTimeout(resolve, ms));
  }

  private readonly loop = (now: number): void => {
    if (!this.running) return;
    this.frame = this.win.requestAnimationFrame(this.loop);
    if (this.win.document.hidden) {
      this.lastFrame = now;
      return;
    }
    // A still scene only needs redrawing for late sprites and window resizes.
    const still =
      this.reducedMotion?.matches === true &&
      this.fadeFrom !== null &&
      now - this.fadeFrom > FADE_MS &&
      this.leaving === null;
    if (now - this.lastDraw < (still ? STILL_FRAME_MS : FRAME_MS) - 2) return;
    const delta = this.lastFrame ? Math.min(100, now - this.lastFrame) : FRAME_MS;
    this.lastFrame = now;
    this.lastDraw = now;
    this.draw(now, delta);
  };

  private ensureWorld(): WorldState | null {
    if (this.world) return this.world;
    if (!this.contentReady) return null;
    const world = new WorldState();
    world.tilesX = BACKDROP_TILES_X;
    world.tilesY = BACKDROP_TILES_Y;
    const placements = backdropPlacements();
    world.entities.processUnits(backdropRecords(placements, this.content), true);
    // An empty nickname draws no nameplate at all.
    const info = newPlayerInfo(SURVIVOR_PID, this.survivorName);
    info.verified = this.survivorVerified && this.survivorName !== '';
    world.players.set(SURVIVOR_PID, info);
    this.placeSurvivor(world, survivorAngle(0));
    // Already burning when the scene fades in, rather than lighting up.
    this.animator.update(world, 1000);
    this.world = world;
    this.requestSprites(placements);
    return world;
  }

  /** The survivor as the server would send a player: bare hands, `survivorSkin` worn. */
  private placeSurvivor(world: WorldState, angle: number): void {
    const turn = Math.PI * 2;
    const rotation = Math.round(((((angle % turn) + turn) % turn) / turn) * 255);
    const { x, y } = SURVIVOR;
    world.entities.processUnits([
      {
        pid: SURVIVOR_PID,
        id: 0,
        type: EntityType.PLAYER,
        rotation,
        state: 1,
        startX: x,
        startY: y,
        endX: x,
        endY: y,
        extra: this.survivorSkin,
      },
    ]);
    const survivor = world.entities.get(SURVIVOR_PID, 0);
    if (survivor) {
      survivor.x = survivor.rx = survivor.nx = x;
      survivor.y = survivor.ry = survivor.ny = y;
      survivor.angle = survivor.nangle = angle;
    }
  }

  /** Loads (and pins) the scene's sprites in the palette it will show, then lets it fade in. */
  private requestSprites(placements: readonly BackdropPlacement[]): void {
    if (this.spritesWanted) return;
    this.spritesWanted = true;
    const night = backdropNight(new Date(), this.win.location?.search ?? '') >= 0.5;
    const names = [...backdropSprites(placements, this.content), ...SURVIVOR_SPRITES].map((n) =>
      this.assets.resolveSpriteName(n, night),
    );
    const begin = () => {
      if (this.fadeFrom === null) this.fadeFrom = performance.now();
    };
    // Pinned like the core set, so leaving a game does not drop them.
    void this.assets.preloadCore(names).then(begin, begin);
    this.win.setTimeout(begin, SPRITE_WAIT_MS);
  }

  private draw(now: number, delta: number): void {
    const ctx = this.canvas.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ratio = this.canvas.pixelRatio / this.canvas.resolutionDivisor;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    const world = this.ensureWorld();
    if (!world || this.fadeFrom === null) {
      ctx.fillStyle = `rgb(${FADE_RGB})`;
      ctx.fillRect(0, 0, w, h);
      return;
    }

    const still = this.reducedMotion?.matches ?? false;
    if (!still) this.clock += delta;
    const baseZoom = baseWorldScale(w, h) * ZOOM;
    const drift = driftAt(still ? 0 : this.clock, w / baseZoom, w);
    if (!still) {
      // Ease toward the pointer: a slow lean, not a pan.
      const k = Math.min(1, delta / 900);
      this.lean.x += (this.pointer.x * PARALLAX - this.lean.x) * k;
      this.lean.y += (this.pointer.y * PARALLAX - this.lean.y) * k;
    }
    const cx = drift.x + this.lean.x;
    const cy = drift.y + this.lean.y;

    // Closing in: zoom about the fire's own place on screen, so it stays beside
    // the start window instead of sliding behind it. Reduced motion skips the zoom.
    const towards = still ? 0 : this.approachTarget;
    const rate = delta / APPROACH_MS;
    this.approach =
      towards > this.approach
        ? Math.min(towards, this.approach + rate)
        : Math.max(towards, this.approach - rate);
    if (this.leaving !== null) this.leaving += delta;
    const leave = this.leaving === null ? 0 : Math.min(1, this.leaving / LEAVE_MS);
    const push =
      (1 + (APPROACH_ZOOM - 1) * easeInOut(this.approach)) *
      (1 + (LEAVE_ZOOM - 1) * (still ? 0 : leave * leave));
    const zoom = baseZoom * push;
    this.camera.setViewport(w, h);
    this.camera.setZoom(zoom);
    this.camera.x = CAMP.x - ((CAMP.x - cx) * baseZoom) / zoom;
    this.camera.y = CAMP.y - ((CAMP.y - cy) * baseZoom) / zoom;

    // Reduced motion: no drift, no lean, and the fire, the leaves and the survivor hold still too.
    const step = still ? 0 : delta;
    this.placeSurvivor(world, survivorAngle(still ? 0 : this.clock));
    this.assets.tick(now);
    this.animator.update(world, step);
    this.characters.update(world, this.content, step);
    world.entities.update(step);
    this.renderer.render({
      ctx,
      camera: this.camera,
      world,
      content: this.content,
      assets: this.assets,
      buildingAnimator: this.animator,
      animator: this.characters,
      timeMs: still ? 0 : now,
      night: backdropNight(new Date(), this.win.location?.search ?? ''),
    });

    const fadeIn = 1 - Math.min(1, (performance.now() - this.fadeFrom) / FADE_MS);
    const dark = Math.max(fadeIn * fadeIn, leave);
    if (dark > 0) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(${FADE_RGB}, ${dark})`;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    }
  }
}

/** The bare survivor's body and arms (skin 0, the unarmed hands). */
const SURVIVOR_SPRITES = ['day-skin0', 'day-left-arm0', 'day-right-arm0'];
