// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/damage-numbers.ts
// DAMAGE_INDICATOR: the server states every hit, heal and ambient loss as
// `[x][y][amount i16][pct]` for whoever can see it -- players and agents alike
// (Game::broadcastDamageIndicator). The old client predates the message, so
// this is drawn in the GameUI voice rather than copied: Viga, the danger red /
// life green of the HUD, a dark outline for legibility over the world, sized
// by how much of the target's full health the blow took. Numbers rise ~60
// world units with an ease-out and fade over their last 300 ms. Screen space,
// after the world, like the alert bubbles.

import type { Camera } from '../core/camera';

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export const DAMAGE_NUMBER_LIFE_MS = 1000;
const FADE_MS = 300;
/** World units above the reported position where the number starts. */
export const DAMAGE_NUMBER_OFFSET_Y = 70;
const RISE_UNITS = 60;
/** Sideways stagger alternated per spawn, in CSS px, so a burst does not overprint. */
const STAGGER_PX = 14;
export const MAX_DAMAGE_NUMBERS = 48;

const FONT_MIN_PX = 14;
const FONT_MAX_PX = 32;
const FONT_FAMILY = "'Viga', sans-serif";
const DAMAGE_FILL = '#f0a6a6';
const HEAL_FILL = '#70bd56';
const OUTLINE = 'rgba(5, 9, 13, 0.85)';

/** Font size from the hit's share of full health (0..100): 14 px for a scratch, 32 px for a kill. */
export function damageNumberFontPx(pct: number): number {
  const share = Math.min(100, Math.max(0, pct)) / 100;
  return Math.round(FONT_MIN_PX + (FONT_MAX_PX - FONT_MIN_PX) * Math.sqrt(share));
}

interface Entry {
  x: number;
  y: number;
  amount: number;
  fontPx: number;
  dx: number;
  ageMs: number;
}

export interface DamageNumberFrame {
  x: number;
  y: number;
  text: string;
  fill: string;
  fontPx: number;
  /** Sideways stagger in CSS px. */
  dx: number;
  /** Rise so far in world units. */
  rise: number;
  alpha: number;
}

export class DamageNumbers {
  private entries: Entry[] = [];
  private stagger = 1;

  get count(): number {
    return this.entries.length;
  }

  push(x: number, y: number, amount: number, pct: number): void {
    if (amount === 0) return;
    this.stagger = -this.stagger;
    this.entries.push({
      x,
      y,
      amount,
      fontPx: damageNumberFontPx(pct),
      dx: this.stagger * STAGGER_PX,
      ageMs: 0,
    });
    if (this.entries.length > MAX_DAMAGE_NUMBERS) {
      this.entries.splice(0, this.entries.length - MAX_DAMAGE_NUMBERS);
    }
  }

  update(deltaMs: number): void {
    if (this.entries.length === 0) return;
    for (const e of this.entries) e.ageMs += deltaMs;
    this.entries = this.entries.filter((e) => e.ageMs < DAMAGE_NUMBER_LIFE_MS);
  }

  frame(index: number): DamageNumberFrame | null {
    const e = this.entries[index];
    if (!e) return null;
    const t = Math.min(1, e.ageMs / DAMAGE_NUMBER_LIFE_MS);
    const fadeStart = DAMAGE_NUMBER_LIFE_MS - FADE_MS;
    const alpha =
      e.ageMs <= fadeStart ? 1 : Math.max(0, (DAMAGE_NUMBER_LIFE_MS - e.ageMs) / FADE_MS);
    return {
      x: e.x,
      y: e.y,
      text: e.amount > 0 ? `+${e.amount}` : `${e.amount}`,
      fill: e.amount > 0 ? HEAL_FILL : DAMAGE_FILL,
      fontPx: e.fontPx,
      dx: e.dx,
      rise: RISE_UNITS * easeOutQuart(t),
      alpha,
    };
  }

  render(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (this.entries.length === 0) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = OUTLINE;
    const zoom = camera.zoom;
    for (let i = 0; i < this.entries.length; i++) {
      const f = this.frame(i)!;
      const p = camera.worldToScreen(f.x, f.y - DAMAGE_NUMBER_OFFSET_Y - f.rise);
      const px = Math.round(f.fontPx * Math.max(0.75, Math.min(1.5, zoom)));
      ctx.font = `${px}px ${FONT_FAMILY}`;
      ctx.lineWidth = Math.max(2, px / 6);
      ctx.globalAlpha = f.alpha;
      ctx.fillStyle = f.fill;
      ctx.strokeText(f.text, p.x + f.dx, p.y);
      ctx.fillText(f.text, p.x + f.dx, p.y);
    }
    ctx.restore();
  }
}
