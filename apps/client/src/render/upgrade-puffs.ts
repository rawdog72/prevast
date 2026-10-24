// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/upgrade-puffs.ts
// The puff of dust when a building finishes upgrading (UPGRADE_FINISHED). The
// building itself just changes sprite under it; this is what tells you it
// happened.
//
// It is the molotov fire's smoke puff (fire.ts) with a little changed: the
// same flat three-lobe shape that swells and shrinks away rather than fading,
// in pale dust instead of grey, thrown out from the building's edges and gone
// in under a second, with a few chips of rubble skittering off. Like the
// fire's particles they live in a fixed pool with the live ones packed at
// the front, so a wall of upgrades finishing at once makes no garbage.

import type { Camera } from '../core/camera';

const TILE = 100;
const POOL_PUFFS = 96;
const POOL_CHIPS = 64;

const DUST_DARK = 'rgb(206,196,174)';
const DUST_LIGHT = 'rgb(236,230,212)';
const DUST_ALPHA = 0.85;

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r0: number;
  r1: number;
  age: number;
  life: number;
}

interface Chip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  life: number;
}

function pool<T>(n: number, make: () => T): T[] {
  return Array.from({ length: n }, make);
}

function addCircle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

export class UpgradePuffs {
  /** Thin it out (the particles switch). */
  reduced = false;

  private readonly puffs = pool<Puff>(POOL_PUFFS, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r0: 0,
    r1: 0,
    age: 0,
    life: 1,
  }));
  private readonly chips = pool<Chip>(POOL_CHIPS, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    size: 0,
    age: 0,
    life: 1,
  }));
  /** Live particles are the first n of each pool. */
  private nPuffs = 0;
  private nChips = 0;

  constructor(private readonly random: () => number = Math.random) {}

  get idle(): boolean {
    return this.nPuffs === 0 && this.nChips === 0;
  }

  get puffCount(): number {
    return this.nPuffs;
  }

  /** A building at (x, y), its tile's middle, has just been upgraded. */
  burst(x: number, y: number): void {
    const rnd = this.random;
    // Round the edges of the tile, pushed outward: the dust of the old
    // facing coming off.
    const puffs = this.reduced ? 6 : 14;
    for (let i = 0; i < puffs; i++) {
      const a = (Math.PI * 2 * (i + rnd() * 0.6)) / puffs;
      const edge = TILE * (0.42 + rnd() * 0.12);
      const speed = 40 + rnd() * 50;
      this.spawnPuff(
        x + Math.cos(a) * edge,
        y + Math.sin(a) * edge,
        Math.cos(a) * speed,
        Math.sin(a) * speed - 18,
        8 + rnd() * 4,
        20 + rnd() * 10,
        620 + rnd() * 380,
      );
    }
    // A few in the middle, so it reads as one cloud over the whole piece.
    const middle = this.reduced ? 1 : 3;
    for (let i = 0; i < middle; i++) {
      this.spawnPuff(
        x + (rnd() - 0.5) * 30,
        y + (rnd() - 0.5) * 30,
        0,
        -22,
        12,
        30,
        700 + rnd() * 300,
      );
    }
    // Chips of the old material skittering off and settling.
    const chips = this.reduced ? 4 : 10;
    for (let i = 0; i < chips; i++) {
      const a = rnd() * Math.PI * 2;
      const speed = 120 + rnd() * 160;
      this.spawnChip(
        x + Math.cos(a) * 30,
        y + Math.sin(a) * 30,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        400 + rnd() * 400,
      );
    }
  }

  update(deltaMs: number): void {
    if (deltaMs <= 0 || this.idle) return;
    const dt = Math.min(deltaMs, 100);
    const sec = dt / 1000;
    const keep = Math.exp(-2.2 * sec);
    for (let i = this.nPuffs - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.puffs[i] = this.puffs[--this.nPuffs]!;
        this.puffs[this.nPuffs] = p;
        continue;
      }
      p.vx *= keep;
      p.vy *= keep;
      p.x += p.vx * sec;
      p.y += p.vy * sec;
    }
    const chipKeep = Math.exp(-7 * sec);
    for (let i = this.nChips - 1; i >= 0; i--) {
      const c = this.chips[i]!;
      c.age += dt;
      if (c.age >= c.life) {
        this.chips[i] = this.chips[--this.nChips]!;
        this.chips[this.nChips] = c;
        continue;
      }
      c.vx *= chipKeep;
      c.vy *= chipKeep;
      c.x += c.vx * sec;
      c.y += c.vy * sec;
    }
  }

  /** Over the scene, under names. Camera transform applied (world space). */
  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (this.idle) return;
    ctx.save();
    // Body, then its lit top: each one flat shape, as the fire's smoke is.
    for (const lit of [false, true]) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < this.nPuffs; i++) {
        const p = this.puffs[i]!;
        const u = p.age / p.life;
        // Swells fast, holds, then shrinks away -- never fades.
        const r =
          (p.r0 + (p.r1 - p.r0) * Math.min(1, u * 2.5)) * (u < 0.5 ? 1 : 1 - (u - 0.5) / 0.5);
        if (r <= 0.5 || !camera.isVisible(p.x, p.y, r * 1.6)) continue;
        any = true;
        if (lit) addCircle(ctx, p.x - r * 0.3, p.y - r * 0.42, r * 0.5);
        else {
          addCircle(ctx, p.x, p.y, r);
          addCircle(ctx, p.x - r * 0.62, p.y + r * 0.18, r * 0.66);
          addCircle(ctx, p.x + r * 0.55, p.y + r * 0.28, r * 0.58);
        }
      }
      if (!any) continue;
      ctx.globalAlpha = DUST_ALPHA;
      ctx.fillStyle = lit ? DUST_LIGHT : DUST_DARK;
      ctx.fill();
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = DUST_DARK;
    ctx.beginPath();
    let anyChip = false;
    for (let i = 0; i < this.nChips; i++) {
      const c = this.chips[i]!;
      const z = c.size * Math.min(1, (c.life - c.age) / 200);
      if (z <= 0.3 || !camera.isVisible(c.x, c.y, 6)) continue;
      anyChip = true;
      ctx.rect(c.x - z / 2, c.y - z / 2, z, z);
    }
    if (anyChip) ctx.fill();
    ctx.restore();
  }

  private spawnPuff(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r0: number,
    r1: number,
    life: number,
  ): void {
    if (this.nPuffs >= this.puffs.length) return;
    const p = this.puffs[this.nPuffs++]!;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.r0 = r0;
    p.r1 = r1;
    p.age = 0;
    p.life = life;
  }

  private spawnChip(x: number, y: number, vx: number, vy: number, life: number): void {
    if (this.nChips >= this.chips.length) return;
    const c = this.chips[this.nChips++]!;
    c.x = x;
    c.y = y;
    c.vx = vx;
    c.vy = vy;
    c.size = 2.5 + this.random() * 3;
    c.age = 0;
    c.life = life;
  }
}
