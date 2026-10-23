// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Gas, smoke and fire lying on the ground (AREA_EFFECT, Game::spawnCloud).
// The server decides the shape -- which tiles, in what order -- and what it does
// to whoever stands in it; this only draws it on the same clock. A cloud grows
// over growMs by uncovering its tiles in the order given, holds, then thins out
// over fadeMs and is gone: there is no removal message. Smoke thins from the
// edge in, giving back its tiles in reverse order, so it shrinks to its middle
// rather than lifting everywhere at once (smokeHeld).
//
// Unlike particles this is not optional eye candy. Gas hurts, so it is drawn
// even with particles switched off.
//
// Smoke is the server's to enforce: it simply does not send what smoke hides
// (smoke_sight.h). What is drawn here only matches it -- thick from outside;
// thin from inside, so whoever is in there with you can be seen; and, while you
// stand in it, everything outside the smoke darkened, because the server has
// stopped telling you about it.
//
// Cost. A cloud is tens of overlapping puffs, and standing in one puts all of
// them on screen at once, so every per-puff cost here is paid ~40 times per
// cloud per frame. Hence: each puff is one drawImage of a bitmap made once per
// kind, not a gradient built and filled every frame; the smoke cover (which
// tiles hide, and the clear-air gaps between them) is worked out only when it
// changes; and the darkening is plain pixel-aligned rectangles, not one
// screen-sized even-odd path with a hole per tile, which the browser had to
// rasterise from scratch every frame.

import type { Camera } from '../core/camera';
import type { AreaEffectEvent } from '../net/events';
import { FireEffects, type FireActor, type FireProjectile } from './fire';

/** AREA_EFFECT `kind` (CloudKind in opcodes.h). */
export const CloudKind = { GAS: 1, SMOKE: 2, FIRE: 3 } as const;

const TILE = 100;
/** How long one tile takes to swell in once the growth reaches it. */
const TILE_APPEAR_MS = 400;
/** A restated age within this of ours is the same clock; leave it alone. */
const RESYNC_SLACK_MS = 250;
/** Side of a cached puff bitmap in its own pixels; it is drawn scaled to the puff. */
const SPRITE_SIZE = 128;

interface Cloud {
  id: number;
  kind: number;
  tileX: number;
  tileY: number;
  growMs: number;
  holdMs: number;
  fadeMs: number;
  ageMs: number;
  cells: Array<[number, number]>;
}

/** What one cloud looks like at its current age. */
export interface CloudFrame {
  /** How many of its tiles are out, in growth order. */
  covered: number;
  /** 0..1 over the whole cloud: 1 until it starts to fade. */
  opacity: number;
}

/** Half the fade, in whole ms as the server counts it (fadeMs / 2u). */
function halfFade(cloud: Pick<Cloud, 'fadeMs'>): number {
  return Math.floor(cloud.fadeMs / 2);
}

/** Smoke hides until it is half faded (ActiveCloud::hiding on the server). */
export function obscures(cloud: Pick<Cloud, 'kind' | 'growMs' | 'holdMs' | 'fadeMs' | 'ageMs'>): boolean {
  return cloud.kind === CloudKind.SMOKE && cloud.ageMs < cloud.growMs + cloud.holdMs + halfFade(cloud);
}

/**
 * How many of a smoke cloud's tiles hide right now, always the first ones in
 * growth order -- ActiveCloud::hiding, on the same clock. It grows with the
 * cloud and holds; then over the first half of the fade it gives tiles back
 * last-grown first, so the cloud shrinks to its middle rather than letting
 * everyone in it be seen at once. Nothing once half faded.
 */
export function smokeHeld(cloud: Pick<Cloud, 'kind' | 'growMs' | 'holdMs' | 'fadeMs' | 'ageMs' | 'cells'>): number {
  const n = cloud.cells.length;
  if (cloud.kind !== CloudKind.SMOKE || n === 0) return 0;
  const fadeStart = cloud.growMs + cloud.holdMs;
  const half = halfFade(cloud);
  if (cloud.ageMs < fadeStart) return cloudFrame(cloud).covered;
  if (cloud.ageMs >= fadeStart + half) return 0;
  return Math.min(n, Math.max(1, Math.ceil((n * (fadeStart + half - cloud.ageMs)) / half)));
}

/** When smoke tile `i` of `n` stops hiding: the inverse of smokeHeld. */
function releasedAt(cloud: Pick<Cloud, 'growMs' | 'holdMs' | 'fadeMs'>, i: number, n: number): number {
  const half = halfFade(cloud);
  return cloud.growMs + cloud.holdMs + half - (half * i) / n;
}

/** How long a smoke tile takes to thin away once it has stopped hiding. */
const TILE_RELEASE_MS = 500;

/**
 * A fading smoke tile's opacity, 0..1 of its peak: whole until the fade
 * starts, down to half by the moment it stops hiding -- the same "too thin to
 * hide" line the old whole-cloud fade drew -- then to nothing soon after.
 */
function smokeTileFade(cloud: Pick<Cloud, 'growMs' | 'holdMs' | 'fadeMs' | 'ageMs'>, i: number, n: number): number {
  const fadeStart = cloud.growMs + cloud.holdMs;
  if (cloud.ageMs < fadeStart) return 1;
  const release = releasedAt(cloud, i, n);
  if (cloud.ageMs < release) {
    // Thinning toward the release, over at most TILE_RELEASE_MS before it.
    const from = Math.max(fadeStart, release - TILE_RELEASE_MS);
    return release > from ? 1 - (0.5 * (cloud.ageMs - from)) / (release - from) : 1;
  }
  const out = Math.min(TILE_RELEASE_MS, halfFade(cloud));
  return out > 0 ? Math.max(0, 0.5 * (1 - (cloud.ageMs - release) / out)) : 0;
}

/** Smoke seen from inside it: thin enough to see who is in there with you. */
const SMOKE_INSIDE_ALPHA = 0.3;
/** Everything outside the smoke while you stand in it: this colour, this opaque. */
const MASK_RGB = [48, 48, 48] as const;
const MASK_ALPHA = 0.94;
const SMOKE_MASK = `rgba(${MASK_RGB.join(',')},${MASK_ALPHA})`;
/** Half-size of the mask rectangle around the player, past any screen. */
const MASK_REACH = 8000;
/** How long the mask takes to come down as you step in, or lift as you step out. */
const MASK_FADE_MS = 180;

// The soft edge. The server hides by whole tiles, so the darkness must be
// complete by the edge of the smoke -- a lit band outside it would show open
// ground that may well hold a player you are not being sent. The softening
// therefore lies wholly inside. The smoke is shrunk by MASK_INSET (plus a
// little wobble, so the line wavers like the edge of a cloud rather than of a
// grid) and that core is blurred by no more than the inset: every corner
// comes out round, and no light gets past the edge.

/** How far in from the edge of the smoke the lit core starts, in tiles. */
const MASK_INSET = 0.4;
/** How much further in, at most, the core's edge wanders, in tiles. */
const MASK_WOBBLE = 0.25;
/** Box blur passes per axis; two make a soft, tent-shaped ramp. */
const MASK_BLUR_PASSES = 2;
/** Samples per tile in the mask bitmap; it is drawn smoothed, so few are needed. */
const MASK_PX_PER_TILE = 10;
/** Fully dark tiles round the smoke's box in the bitmap, so its border is uniform. */
const MASK_PAD = 1;
/** Upper bound on the bitmap, in pixels; past it, fewer samples per tile. */
const MASK_MAX_PIXELS = 1 << 19;

/** The soft mask over the smoke's box, as RGBA pixels. Origin and size in tiles. */
export interface MaskImage {
  tileX: number;
  tileY: number;
  tilesW: number;
  tilesH: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** How much further in the edge starts here: 0..MASK_WOBBLE, smooth, fixed in the world. */
function wobble(x: number, y: number): number {
  return MASK_WOBBLE * (0.5 + 0.25 * Math.sin(2.1 * x + 1.3 * y) + 0.25 * Math.sin(-1.7 * x + 2.9 * y + 1.1));
}

/** One axis of a box blur of radius r over a w x h grid, in place (via `tmp`). */
function boxBlur(src: Float32Array, tmp: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const stride = horizontal ? 1 : w;
  const scale = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w : line;
    // Running sum over [i - r, i + r]; beyond the grid counts as dark (0).
    let sum = 0;
    for (let i = 0; i < r && i < len; i++) sum += src[base + i * stride];
    for (let i = 0; i < len; i++) {
      if (i + r < len) sum += src[base + (i + r) * stride];
      if (i - r - 1 >= 0) sum -= src[base + (i - r - 1) * stride];
      tmp[base + i * stride] = sum * scale;
    }
  }
  src.set(tmp);
}

/**
 * The darkness over and around the smoke tiles: full on every tile that is
 * not smoke; inside, clear on a core inset from the edge, blurred into a
 * ramp that is spent by the time it reaches the edge.
 */
export function softMask(cover: { tiles: ReadonlySet<number>; minX: number; minY: number; maxX: number; maxY: number }): MaskImage {
  const tileX = cover.minX - MASK_PAD;
  const tileY = cover.minY - MASK_PAD;
  const tilesW = cover.maxX - cover.minX + 1 + 2 * MASK_PAD;
  const tilesH = cover.maxY - cover.minY + 1 + 2 * MASK_PAD;
  let ppt = MASK_PX_PER_TILE;
  while (ppt > 2 && tilesW * tilesH * ppt * ppt > MASK_MAX_PIXELS) ppt--;
  const width = tilesW * ppt;
  const height = tilesH * ppt;

  // Smoke as a flat grid over the box plus a ring, so a neighbour is an index.
  const gw = tilesW + 2;
  const smoke = new Uint8Array(gw * (tilesH + 2));
  for (let ty = 0; ty < tilesH; ty++) {
    for (let tx = 0; tx < tilesW; tx++) {
      if (cover.tiles.has(tileKey(tileX + tx, tileY + ty))) smoke[(ty + 1) * gw + tx + 1] = 1;
    }
  }
  const isSmoke = (px: number, py: number) =>
    smoke[(Math.floor(py / ppt) + 1) * gw + Math.floor(px / ppt) + 1] === 1;

  // The core: smoke pixels at least the inset (and their wobble) from clear air.
  // Further than one tile in is past any inset, so the eight around are enough.
  const core = new Float32Array(width * height);
  for (let py = 0; py < height; py++) {
    const ly = (py + 0.5) / ppt; // tiles from the box's top
    const ty = Math.floor(ly);
    for (let px = 0; px < width; px++) {
      const lx = (px + 0.5) / ppt;
      const tx = Math.floor(lx);
      if (!smoke[(ty + 1) * gw + tx + 1]) continue;
      let d2 = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (smoke[(ty + oy + 1) * gw + tx + ox + 1]) continue;
          const ex = Math.max(tx + ox - lx, 0, lx - (tx + ox + 1));
          const ey = Math.max(ty + oy - ly, 0, ly - (ty + oy + 1));
          d2 = Math.min(d2, ex * ex + ey * ey);
        }
      }
      const inset = MASK_INSET + wobble(tileX + lx, tileY + ly);
      if (d2 >= inset * inset) core[py * width + px] = 1;
    }
  }

  // Blur the core. Each pass reaches r pixels, so all of them together reach
  // no further than the inset: the light stays inside the smoke.
  const r = Math.max(1, Math.floor((MASK_INSET * ppt) / MASK_BLUR_PASSES));
  const tmp = new Float32Array(width * height);
  for (let pass = 0; pass < MASK_BLUR_PASSES; pass++) {
    boxBlur(core, tmp, width, height, r, true);
    boxBlur(core, tmp, width, height, r, false);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const fullDark = Math.round(255 * MASK_ALPHA);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px;
      // Not smoke is dark, whatever the blur says: belt and braces for the rule above.
      const clear = isSmoke(px, py) ? Math.min(1, Math.max(0, core[i])) : 0;
      data[i * 4] = MASK_RGB[0];
      data[i * 4 + 1] = MASK_RGB[1];
      data[i * 4 + 2] = MASK_RGB[2];
      data[i * 4 + 3] = Math.round(fullDark * (1 - clear));
    }
  }
  return { tileX, tileY, tilesW, tilesH, width, height, data };
}

export function cloudFrame(cloud: Pick<Cloud, 'growMs' | 'holdMs' | 'fadeMs' | 'ageMs' | 'cells'>): CloudFrame {
  const n = cloud.cells.length;
  const covered =
    cloud.growMs <= 0 || cloud.ageMs >= cloud.growMs
      ? n
      : Math.min(n, Math.max(1, Math.ceil((n * cloud.ageMs) / cloud.growMs)));
  const fadeStart = cloud.growMs + cloud.holdMs;
  const opacity =
    cloud.ageMs < fadeStart
      ? 1
      : cloud.fadeMs > 0
        ? Math.max(0, 1 - (cloud.ageMs - fadeStart) / cloud.fadeMs)
        : 0;
  return { covered, opacity };
}

const COLORS: Record<number, [number, number, number, number]> = {
  // r, g, b, peak alpha
  [CloudKind.GAS]: [150, 178, 52, 0.42],
  [CloudKind.SMOKE]: [170, 170, 170, 0.85],
};

/** One colour stop of a puff at full strength: offset, "r,g,b", alpha. */
type Stop = [number, string, number];

/**
 * A puff's gradient at strength 1. Drawn at strength `s`, each stop's alpha is
 * min(1, alpha * s). (Fire is not a puff: render/fire.ts.)
 */
function puffStops(kind: number): Stop[] {
  const [r, g, b] = COLORS[kind] ?? COLORS[CloudKind.GAS];
  const rgb = `${r},${g},${b}`;
  return [
    [0, rgb, 1],
    [0.6, rgb, 0.7],
    [1, rgb, 0],
  ];
}

/** Makes a canvas for the puff bitmaps; null where there is none (tests, workers). */
export type CloudCanvasFactory = () => HTMLCanvasElement | null;

const documentCanvas: CloudCanvasFactory = () =>
  typeof document !== 'undefined' ? document.createElement('canvas') : null;

/** A tile as one number: cheaper to hash than an "x,y" string, and no garbage. */
function tileKey(tx: number, ty: number): number {
  return (tx + 0x8000) * 0x10000 + (ty + 0x8000);
}

/** Which tiles smoke hides right now, kept until that changes. */
interface SmokeCover {
  /** Which clouds, and how far grown: equal keys, equal cover. */
  key: string;
  tiles: Set<number>;
  /** Bounding box of `tiles`, inclusive; maxX < minX when there are none. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Clear air inside the box, row by row: [tileY, fromTileX, toTileX exclusive]. */
  gaps: Array<[number, number, number]>;
}

const NO_SMOKE: SmokeCover = { key: '', tiles: new Set(), minX: 0, minY: 0, maxX: -1, maxY: -1, gaps: [] };

export class CloudLayer {
  private readonly clouds = new Map<number, Cloud>();
  /** Per kind: the puff bitmap, or null when no canvas could be had. */
  private readonly sprites = new Map<number, HTMLCanvasElement | null>();
  private cover: SmokeCover = NO_SMOKE;
  /** The soft mask bitmap, for the cover named by maskKey; null without a canvas. */
  private maskCanvas: HTMLCanvasElement | null | undefined;
  private maskKey = '';
  private maskImage: MaskImage | null = null;
  /** 0..1: how far the mask is down (it eases in and out over MASK_FADE_MS). */
  private maskBlend = 0;
  private lastRenderMs: number | undefined;

  /** Everything fire looks like: flames, scorch, smoke, light (render/fire.ts). */
  readonly fire: FireEffects;

  constructor(private readonly createCanvas: CloudCanvasFactory = documentCanvas) {
    this.fire = new FireEffects();
  }

  get count(): number {
    return this.clouds.size;
  }

  /** A cloud appeared, or the server restated one we may already have. */
  apply(ev: AreaEffectEvent): void {
    const known = this.clouds.get(ev.id);
    // The server folds a molotov landing on a fire into that fire (Game::
    // mergeCloud): same id, its clock wound back, maybe more tiles. That is a
    // bottle breaking here, not the clock drifting.
    const fed =
      known !== undefined &&
      known.kind === CloudKind.FIRE &&
      ev.kind === CloudKind.FIRE &&
      ev.ageMs + RESYNC_SLACK_MS < known.ageMs;
    if (known && known.tileX === ev.tileX && known.tileY === ev.tileY && known.cells.length === ev.cells.length) {
      if (Math.abs(known.ageMs - ev.ageMs) > RESYNC_SLACK_MS) known.ageMs = ev.ageMs;
      if (fed) this.fire.rekindle(known);
      return;
    }
    // New, or an id the server has reused for a different cloud.
    const cloud: Cloud = {
      id: ev.id,
      kind: ev.kind,
      tileX: ev.tileX,
      tileY: ev.tileY,
      growMs: ev.growMs,
      holdMs: ev.holdMs,
      fadeMs: ev.fadeMs,
      ageMs: ev.ageMs,
      cells: ev.cells,
    };
    this.clouds.set(ev.id, cloud);
    // A fresh fire is a bottle that has just broken there.
    if (fed) this.fire.rekindle(cloud);
    else if (cloud.kind === CloudKind.FIRE) this.fire.ignite(cloud);
  }

  /**
   * Ages every cloud. `creatures` (players and ghouls) may catch fire;
   * `molotovs` are bottles still flying, which trail flame.
   */
  update(deltaMs: number, around: { creatures?: Iterable<FireActor>; molotovs?: Iterable<FireProjectile> } = {}): void {
    for (const [id, cloud] of this.clouds) {
      cloud.ageMs += deltaMs;
      if (cloud.ageMs >= cloud.growMs + cloud.holdMs + cloud.fadeMs) this.clouds.delete(id);
    }
    this.fire.update(deltaMs, {
      fires: this.fires(),
      creatures: around.creatures,
      projectiles: around.molotovs,
    });
  }

  private *fires(): Iterable<Cloud> {
    for (const cloud of this.clouds.values()) if (cloud.kind === CloudKind.FIRE) yield cloud;
  }

  /** What lies on the ground under creatures: a fire's scorch, fuel and flames. */
  renderGround(ctx: CanvasRenderingContext2D, camera: Camera, timeMs: number, night = 0): void {
    this.fire.renderGround(ctx, camera, timeMs, night);
  }

  clear(): void {
    this.fire.clear();
    this.clouds.clear();
    this.cover = NO_SMOKE;
    this.maskBlend = 0;
  }

  /**
   * Every tile currently hidden by smoke. Rebuilt only when a smoke cloud
   * grows, appears, gives a tile back or goes -- a few times a second while
   * one grows or thins, never while it holds.
   */
  private smokeCover(): SmokeCover {
    let key = '';
    for (const cloud of this.clouds.values()) {
      const held = smokeHeld(cloud);
      if (held > 0) key += `${cloud.id}@${cloud.tileX},${cloud.tileY}:${held};`;
    }
    if (key === this.cover.key) return this.cover;
    if (key === '') return (this.cover = NO_SMOKE);

    const tiles = new Set<number>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const cloud of this.clouds.values()) {
      const held = smokeHeld(cloud);
      for (let i = 0; i < held; i++) {
        const [dx, dy] = cloud.cells[i];
        const tx = cloud.tileX + dx;
        const ty = cloud.tileY + dy;
        tiles.add(tileKey(tx, ty));
        if (tx < minX) minX = tx;
        if (tx > maxX) maxX = tx;
        if (ty < minY) minY = ty;
        if (ty > maxY) maxY = ty;
      }
    }
    const gaps: Array<[number, number, number]> = [];
    for (let ty = minY; ty <= maxY; ty++) {
      let tx = minX;
      while (tx <= maxX) {
        if (tiles.has(tileKey(tx, ty))) {
          tx++;
          continue;
        }
        const from = tx;
        while (tx <= maxX && !tiles.has(tileKey(tx, ty))) tx++;
        gaps.push([ty, from, tx]);
      }
    }
    return (this.cover = { key, tiles, minX, minY, maxX, maxY, gaps });
  }

  /** Whether the world point (x, y) stands in smoke. */
  inSmoke(x: number, y: number): boolean {
    return this.smokeCover().tiles.has(tileKey(Math.floor(x / TILE), Math.floor(y / TILE)));
  }

  /** The puff bitmap for `kind`, made on first use; null without a canvas. */
  private sprite(kind: number): HTMLCanvasElement | null {
    const cached = this.sprites.get(kind);
    if (cached !== undefined) return cached;
    let made: HTMLCanvasElement | null = null;
    const canvas = this.createCanvas();
    if (canvas) {
      canvas.width = SPRITE_SIZE;
      canvas.height = SPRITE_SIZE;
      const g = canvas.getContext('2d');
      if (g) {
        const h = SPRITE_SIZE / 2;
        const gradient = g.createRadialGradient(h, h, 0, h, h, h);
        for (const [at, rgb, a] of puffStops(kind)) gradient.addColorStop(at, `rgba(${rgb},${a})`);
        g.fillStyle = gradient;
        g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
        made = canvas;
      }
    }
    this.sprites.set(kind, made);
    return made;
  }

  /** One puff of `kind`, radius `r`, at `strength` (see puffStops). */
  private drawPuff(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, r: number, strength: number): void {
    const sprite = this.sprite(kind);
    if (sprite) {
      ctx.globalAlpha = Math.min(1, strength);
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
      return;
    }
    // No canvas to cache a bitmap on: the same gradient, built in place.
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [at, rgb, a] of puffStops(kind)) gradient.addColorStop(at, `rgba(${rgb},${Math.min(1, a * strength)})`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Draws every cloud. The camera transform must already be applied (world
   * space). `viewer` is the local player: from inside smoke the smoke is drawn
   * thin and everything outside it is masked.
   */
  render(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    timeMs: number,
    viewer?: { x: number; y: number },
  ): void {
    // Fire's smoke, embers and glass, and whatever of it outlives the cloud.
    this.fire.renderTop(ctx, camera, timeMs);
    if (this.clouds.size === 0) return;
    const cover = this.smokeCover();
    const viewerInSmoke =
      viewer !== undefined && cover.tiles.has(tileKey(Math.floor(viewer.x / TILE), Math.floor(viewer.y / TILE)));

    // Ease the mask toward where the viewer is. A first frame, a stalled
    // clock or a long gap (a hidden tab) just takes the target.
    const target = viewerInSmoke ? 1 : 0;
    const dt = this.lastRenderMs === undefined ? 0 : timeMs - this.lastRenderMs;
    this.lastRenderMs = timeMs;
    if (dt <= 0 || dt > 1000) this.maskBlend = target;
    else {
      const step = dt / MASK_FADE_MS;
      this.maskBlend = target > this.maskBlend ? Math.min(target, this.maskBlend + step) : Math.max(target, this.maskBlend - step);
    }
    const blend = cover.tiles.size > 0 ? this.maskBlend : 0;

    ctx.save();
    for (const cloud of this.clouds.values()) {
      // Fire is drawn by this.fire, in its two layers.
      if (cloud.kind === CloudKind.FIRE) continue;
      const { covered, opacity } = cloudFrame(cloud);
      if (opacity <= 0) continue;
      const kind = COLORS[cloud.kind] ? cloud.kind : CloudKind.GAS;
      const fullPeak = COLORS[kind][3];
      const peak = kind === CloudKind.SMOKE ? fullPeak + (SMOKE_INSIDE_ALPHA - fullPeak) * blend : fullPeak;
      const n = cloud.cells.length;

      for (let i = 0; i < covered; i++) {
        const [dx, dy] = cloud.cells[i];
        // A slow drift per tile so the cloud churns rather than sitting still.
        const phase = timeMs / 1400 + i * 1.7;
        const x = (cloud.tileX + dx) * TILE + TILE / 2 + Math.sin(phase) * 12;
        const y = (cloud.tileY + dy) * TILE + TILE / 2 + Math.cos(phase * 0.8) * 12;
        const radius = TILE * 0.85;
        if (!camera.isVisible(x, y, radius)) continue;

        // Each tile swells in from the moment the growth reaches it.
        const reachedAt = cloud.growMs > 0 ? (cloud.growMs * i) / n : 0;
        const swell = Math.min(1, Math.max(0, (cloud.ageMs - reachedAt) / TILE_APPEAR_MS));
        // Smoke thins tile by tile from the edge in, as it stops hiding;
        // gas and fire fade as a whole.
        const fade = kind === CloudKind.SMOKE ? smokeTileFade(cloud, i, n) : opacity;
        const alpha = peak * fade * swell;
        if (alpha <= 0) continue;

        this.drawPuff(ctx, kind, x, y, radius * (0.6 + 0.4 * swell), alpha);
      }
    }
    ctx.globalAlpha = 1;

    if (blend > 0 && viewer) {
      ctx.globalAlpha = blend;
      this.drawMask(ctx, cover, viewer);
    }
    ctx.restore();
  }

  /** The mask bitmap for `cover`, redrawn only when the cover changes. */
  private maskFor(cover: SmokeCover): HTMLCanvasElement | null {
    if (this.maskCanvas === undefined) this.maskCanvas = this.createCanvas();
    const canvas = this.maskCanvas;
    if (!canvas) return null;
    if (this.maskKey !== cover.key) {
      const image = softMask(cover);
      canvas.width = image.width;
      canvas.height = image.height;
      const g = canvas.getContext('2d');
      if (!g) return (this.maskCanvas = null);
      const pixels = g.createImageData(image.width, image.height);
      pixels.data.set(image.data);
      g.putImageData(pixels, 0, 0);
      this.maskKey = cover.key;
      this.maskImage = image;
    }
    return canvas;
  }

  /**
   * Standing in smoke: everything but the smoke itself goes dark. Over the
   * smoke's box, the soft mask bitmap drawn smoothed; outside it, four plain
   * rectangles. Both are snapped to whole device pixels so they meet exactly
   * -- no seam, no overlap, and nothing the browser has to rasterise as a path.
   * Without a canvas for the bitmap the box is filled hard-edged instead.
   */
  private drawMask(ctx: CanvasRenderingContext2D, cover: SmokeCover, viewer: { x: number; y: number }): void {
    // World to device pixels. The camera only translates and scales; anything
    // else (or a context that cannot say) is drawn unsnapped in world space.
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const snap = m !== null && m.b === 0 && m.c === 0;
    const sx = snap ? (wx: number) => Math.round(m.a * wx + m.e) : (wx: number) => wx;
    const sy = snap ? (wy: number) => Math.round(m.d * wy + m.f) : (wy: number) => wy;
    if (snap) ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SMOKE_MASK;
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    };

    const left = sx(viewer.x - MASK_REACH);
    const right = sx(viewer.x + MASK_REACH);
    const top = sy(viewer.y - MASK_REACH);
    const bottom = sy(viewer.y + MASK_REACH);

    const mask = snap ? this.maskFor(cover) : null;
    const image = this.maskImage;
    if (mask && image) {
      const mx0 = sx(image.tileX * TILE);
      const my0 = sy(image.tileY * TILE);
      const mx1 = sx((image.tileX + image.tilesW) * TILE);
      const my1 = sy((image.tileY + image.tilesH) * TILE);
      fill(left, top, right, my0);
      fill(left, my1, right, bottom);
      fill(left, my0, mx0, my1);
      fill(mx1, my0, right, my1);
      if (mx1 > mx0 && my1 > my0) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(mask, mx0, my0, mx1 - mx0, my1 - my0);
      }
      return;
    }

    const bx0 = Math.max(left, sx(cover.minX * TILE));
    const bx1 = Math.min(right, sx((cover.maxX + 1) * TILE));
    const by0 = Math.max(top, sy(cover.minY * TILE));
    const by1 = Math.min(bottom, sy((cover.maxY + 1) * TILE));
    fill(left, top, right, by0);
    fill(left, by1, right, bottom);
    fill(left, by0, bx0, by1);
    fill(bx1, by0, right, by1);
    for (const [ty, from, to] of cover.gaps) {
      fill(sx(from * TILE), sy(ty * TILE), sx(to * TILE), sy((ty + 1) * TILE));
    }
  }
}
