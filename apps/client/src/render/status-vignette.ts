// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/status-vignette.ts
// Screen-edge glow for the local player's condition, in place of the old
// top-centre hazard banners: red closing in as life drains (with a quickening
// double-thump heartbeat once critical), a red flash on every hit, green glow
// plus flickering Geiger grain once radiation passes 30 %, and blue-white frost
// creeping from the corners as warmth runs out. Each glow is an ellipse fitted
// to the viewport, so all four sides tint evenly and the centre stays clear.
// The bubbles over players' heads (player-alerts.ts) are separate and stay.

/** The local player's gauges as fractions, 0..1. */
export interface Vitals {
  life: number;
  warmth: number;
  /** How irradiated, 0 = clean (the wire gauge is cleanliness, so 1 - its fraction). */
  irradiation: number;
}

/** Red starts creeping in below this much life and is at full strength at LIFE_FULL. */
const LIFE_START = 0.5;
const LIFE_FULL = 0.1;
/** Below this much life the heartbeat starts, 70 bpm there up to 140 at death. */
const HEARTBEAT_BELOW = 0.3;
const HEARTBEAT_BPM_MIN = 70;
const HEARTBEAT_BPM_MAX = 140;
/** Radiation shows from RAD_START irradiation at RAD_FLOOR strength; full at RAD_FULL. */
const RAD_START = 0.3;
const RAD_FULL = 0.8;
const RAD_FLOOR = 0.2;
const COLD_START = 0.35;

/** Levels ease toward the gauges with this time constant, so nothing pops in. */
const EASE_MS = 300;
const FLASH_MS = 400;
const GRAIN_REFRESH_MS = 70;
const GRAIN_MAX = 160;
const VISIBLE_EPSILON = 0.004;

const HEALTH_RGB = '150,10,10';
const FLASH_RGB = '210,30,30';
const RAD_RGB = '60,190,40';
const GRAIN_RGB = '170,255,120';
const COLD_RGB = '160,200,235';
const FROST_RGB = '220,238,255';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export function healthLevel(life: number): number {
  return smoothstep((LIFE_START - life) / (LIFE_START - LIFE_FULL));
}

export function radiationLevel(irradiation: number): number {
  if (irradiation <= RAD_START) return 0;
  return RAD_FLOOR + (1 - RAD_FLOOR) * clamp01((irradiation - RAD_START) / (RAD_FULL - RAD_START));
}

export function coldLevel(warmth: number): number {
  return smoothstep((COLD_START - warmth) / COLD_START);
}

/** 0 while life is not critical. */
export function heartbeatBpm(life: number): number {
  if (life >= HEARTBEAT_BELOW) return 0;
  const t = clamp01((HEARTBEAT_BELOW - life) / HEARTBEAT_BELOW);
  return HEARTBEAT_BPM_MIN + (HEARTBEAT_BPM_MAX - HEARTBEAT_BPM_MIN) * t;
}

/** One beat over phase 0..1: a sharp lub, a weaker dub just after, then rest. */
export function heartbeatShape(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < 0.14) return 1 - p / 0.14;
  if (p < 0.2) return 0;
  if (p < 0.22) return (0.6 * (p - 0.2)) / 0.02;
  if (p < 0.36) return 0.6 * (1 - (p - 0.22) / 0.14);
  return 0;
}

interface Speck {
  x: number;
  y: number;
  size: number;
  alpha: number;
}

export class StatusVignette {
  health = 0;
  radiation = 0;
  cold = 0;
  flash = 0;
  /** This frame's heartbeat pulse, 0..1. */
  beat = 0;

  private beatPhase = 0;
  private grainClockMs = 0;
  private grainDirty = true;
  private specks: Speck[] = [];
  private grainW = 0;
  private grainH = 0;

  get isVisible(): boolean {
    return (
      this.health > VISIBLE_EPSILON ||
      this.radiation > VISIBLE_EPSILON ||
      this.cold > VISIBLE_EPSILON ||
      this.flash > 0
    );
  }

  /** The local player took a hit. */
  hit(): void {
    this.flash = 1;
  }

  /** `vitals` null = no local player (dead, menu): everything fades out. */
  update(deltaMs: number, vitals: Vitals | null): void {
    const k = 1 - Math.exp(-deltaMs / EASE_MS);
    this.health += ((vitals ? healthLevel(vitals.life) : 0) - this.health) * k;
    this.radiation += ((vitals ? radiationLevel(vitals.irradiation) : 0) - this.radiation) * k;
    this.cold += ((vitals ? coldLevel(vitals.warmth) : 0) - this.cold) * k;
    this.flash = Math.max(0, this.flash - deltaMs / FLASH_MS);

    const bpm = vitals ? heartbeatBpm(vitals.life) : 0;
    if (bpm > 0 && vitals) {
      this.beatPhase = (this.beatPhase + (deltaMs * bpm) / 60000) % 1;
      const strength = clamp01((HEARTBEAT_BELOW - vitals.life) / (HEARTBEAT_BELOW / 2));
      this.beat = heartbeatShape(this.beatPhase) * strength;
    } else {
      this.beatPhase = 0;
      this.beat = 0;
    }

    this.grainClockMs += deltaMs;
    if (this.grainClockMs >= GRAIN_REFRESH_MS) {
      this.grainClockMs %= GRAIN_REFRESH_MS;
      this.grainDirty = true;
    }
  }

  /** Screen space, viewport units; drawn over the world, under the DOM HUD. */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    random: () => number = Math.random,
  ): void {
    if (!this.isVisible || width <= 0 || height <= 0) return;

    // Least urgent underneath: cold, radiation, health, then the hit flash.
    if (this.cold > VISIBLE_EPSILON) {
      edgeGlow(ctx, width, height, 1 - 0.35 * this.cold, COLD_RGB, 0.28 * this.cold);
      this.renderFrost(ctx, width, height);
    }
    if (this.radiation > VISIBLE_EPSILON) {
      edgeGlow(ctx, width, height, 1 - 0.4 * this.radiation, RAD_RGB, 0.42 * this.radiation);
      this.renderGrain(ctx, width, height, random);
    }
    if (this.health > VISIBLE_EPSILON) {
      const inner = 1 - 0.45 * this.health - 0.08 * this.beat;
      edgeGlow(ctx, width, height, inner, HEALTH_RGB, 0.55 * this.health + 0.2 * this.beat);
    }
    if (this.flash > 0) {
      edgeGlow(ctx, width, height, 0.55, FLASH_RGB, 0.4 * this.flash);
    }
  }

  /** Frost grows in from each corner. */
  private renderFrost(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const radius = Math.min(width, height) * (0.25 + 0.35 * this.cold);
    const alpha = 0.5 * this.cold;
    ctx.save();
    for (const [x, y] of [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ] as const) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(${FROST_RGB},${alpha})`);
      g.addColorStop(0.45, `rgba(${FROST_RGB},${alpha * 0.4})`);
      g.addColorStop(1, `rgba(${FROST_RGB},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x === 0 ? 0 : x - radius, y === 0 ? 0 : y - radius, radius, radius);
    }
    ctx.restore();
  }

  /** Geiger static: specks near the edges, reshuffled every GRAIN_REFRESH_MS. */
  private renderGrain(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    random: () => number,
  ): void {
    if (this.grainDirty || width !== this.grainW || height !== this.grainH) {
      this.grainDirty = false;
      this.grainW = width;
      this.grainH = height;
      this.specks = scatterSpecks(width, height, Math.round(GRAIN_MAX * this.radiation), random);
    }
    if (this.specks.length === 0) return;
    ctx.save();
    for (const s of this.specks) {
      ctx.fillStyle = `rgba(${GRAIN_RGB},${s.alpha * this.radiation})`;
      ctx.fillRect(s.x, s.y, s.size, s.size);
    }
    ctx.restore();
  }
}

/** Specks weighted toward the edges; attempts are capped so a bad random source cannot spin. */
function scatterSpecks(width: number, height: number, count: number, random: () => number): Speck[] {
  const specks: Speck[] = [];
  const cx = width / 2;
  const cy = height / 2;
  const inner = 0.55;
  for (let tries = 0; specks.length < count && tries < count * 6; tries++) {
    const x = random() * width;
    const y = random() * height;
    const r = Math.hypot((x - cx) / cx, (y - cy) / cy);
    if (r <= inner || random() > (r - inner) / (Math.SQRT2 - inner)) continue;
    specks.push({ x, y, size: 1.5 + random() * 1.5, alpha: 0.2 + random() * 0.5 });
  }
  return specks;
}

/**
 * An elliptical glow fitted to the viewport: clear inside `inner` (in units of
 * the half-width / half-height, so 1 = the screen edge), `alpha` at the edges,
 * stronger in the corners.
 */
function edgeGlow(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  inner: number,
  rgb: string,
  alpha: number,
): void {
  if (alpha <= VISIBLE_EPSILON) return;
  const r0 = Math.max(0.3, Math.min(0.95, inner));
  const at = (r: number): number => (r - r0) / (Math.SQRT2 - r0);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(width / 2, height / 2);
  const g = ctx.createRadialGradient(0, 0, r0, 0, 0, Math.SQRT2);
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(at((r0 + 1) / 2), `rgba(${rgb},${alpha * 0.3})`);
  g.addColorStop(at(1), `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},${Math.min(1, alpha * 1.4)})`);
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}
