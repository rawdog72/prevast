// Copyright (c) 2026 Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Aiming a cooked grenade (equipables.xml <throw cookable="true">).
//
// The server decides everything: when the pin is out, how much fuse is left
// (COOK_STATE), and where the grenade lands -- the THROW_TARGET marker the
// client reports, clamped to [minRange, <fire range>]. This module only shows
// the player those same rules ahead of time: the landing point, the blast it
// will make there, the line it will fly along, and the fuse running down.

import type { ContentStore } from '../content/store';
import type { Camera } from '../core/camera';

/** Everything the overlay needs about the throwable in hand. */
export interface ThrowProfile {
  minRange: number;
  maxRange: number;
  fuseMs: number;
  /** Blast footprint, as the server's executeExplosion measures it: `area` tiles around the tile, else `radius`. */
  blastArea: number;
  blastRadius: number;
}

const TILE = 100;
/** Server fallback when a weapon names no <fire range> (Player::releaseCook). */
const DEFAULT_RANGE = 800;

/** The cookable throwable item `iid` resolves to, or null for anything else in hand. */
export function throwProfileFor(content: ContentStore, iid: number): ThrowProfile | null {
  if (!iid || !content.has('items') || !content.has('equipables')) return null;
  const item = content.byId('items', iid);
  const key = item?.equipable?.key;
  const equipable = key ? content.byKey('equipables', key) : undefined;
  if (!equipable || equipable.typeId !== 3 || !equipable.throw?.cookable) return null;
  const projectileKey = equipable.fire?.projectileKey;
  const projectile =
    projectileKey && content.has('projectiles')
      ? content.byKey('projectiles', projectileKey)
      : undefined;
  const fuseMs = projectile?.lifetime?.durationMs ?? 0;
  if (fuseMs <= 0) return null; // the server throws it like a spear then
  const maxRange = equipable.fire?.range && equipable.fire.range > 0 ? equipable.fire.range : DEFAULT_RANGE;
  const blast = projectile?.onDestroy?.explosion;
  return {
    minRange: Math.min(equipable.throw.minRange ?? 0, maxRange),
    maxRange,
    fuseMs,
    blastArea: blast?.area ?? 0,
    blastRadius: blast?.radius ?? 0,
  };
}

export interface ThrowTarget {
  x: number;
  y: number;
  /** The clamped distance from the thrower (THROW_TARGET carries x, y less the thrower). */
  distance: number;
  /** The cursor is outside [minRange, maxRange] and the marker is held at the edge. */
  clamped: boolean;
}

/**
 * Where a throw from (px, py) toward the cursor lands. Mirrors the server: the
 * landing point is the clamped distance along the facing, from the thrower's
 * centre. `facing` is used when the cursor sits on the player.
 */
export function throwTargetFor(
  px: number,
  py: number,
  cursorX: number,
  cursorY: number,
  facing: number,
  profile: ThrowProfile,
): ThrowTarget {
  const dx = cursorX - px;
  const dy = cursorY - py;
  const raw = Math.hypot(dx, dy);
  const angle = raw >= 1 ? Math.atan2(dy, dx) : facing;
  const distance = Math.min(profile.maxRange, Math.max(profile.minRange, raw));
  return {
    x: px + Math.cos(angle) * distance,
    y: py + Math.sin(angle) * distance,
    distance: Math.round(distance),
    clamped: Math.abs(distance - raw) > 0.5,
  };
}

export type BlastFootprint =
  | { kind: 'square'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'circle'; x: number; y: number; r: number };

/** The ground a blast at (x, y) reaches: the server's isWithinTileArea square, or its radius circle. */
export function blastFootprint(x: number, y: number, profile: ThrowProfile): BlastFootprint | null {
  if (profile.blastArea > 0) {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const n = profile.blastArea;
    return {
      kind: 'square',
      x0: (tx - n) * TILE,
      y0: (ty - n) * TILE,
      x1: (tx + n + 1) * TILE,
      y1: (ty + n + 1) * TILE,
    };
  }
  if (profile.blastRadius > 0) return { kind: 'circle', x, y, r: profile.blastRadius };
  return null;
}

/** The fuse of the grenade in hand, as COOK_STATE last stated it. */
export class CookTimer {
  private fuseMs = 0;
  private endsAt = 0;

  /** COOK_STATE: fuseMs 0 means the grenade has left the hand (or gone off in it). */
  set(fuseMs: number, remainingMs: number, now: number): void {
    this.fuseMs = fuseMs;
    this.endsAt = fuseMs > 0 ? now + remainingMs : 0;
  }

  clear(): void {
    this.fuseMs = 0;
    this.endsAt = 0;
  }

  get active(): boolean {
    return this.fuseMs > 0;
  }

  remainingMs(now: number): number {
    return this.active ? Math.max(0, this.endsAt - now) : 0;
  }

  /** 1 at the pin pull, 0 when it goes off. */
  fraction(now: number): number {
    return this.active ? this.remainingMs(now) / this.fuseMs : 0;
  }
}

/** Fuse colour: calm, then warning, then the last second. */
export function fuseColor(remainingMs: number): string {
  if (remainingMs <= 1000) return '#ff4a3d';
  if (remainingMs <= 2000) return '#ffb23d';
  return '#f4f1e6';
}

export interface ThrowAimDraw {
  /** The thrower, where the client draws them. */
  originX: number;
  originY: number;
  target: ThrowTarget;
  profile: ThrowProfile;
  /** Null while just holding the grenade: the plan is shown, faintly. */
  cook: { remainingMs: number; fraction: number } | null;
  /** performance.now(), for the last-second pulse. */
  timeMs: number;
}

/** Draws the aim of the grenade in hand. World space; line widths are kept constant on screen. */
export function drawThrowAim(ctx: CanvasRenderingContext2D, camera: Camera, d: ThrowAimDraw): void {
  const px = 1 / camera.zoom;
  const { target, profile } = d;
  const cooking = d.cook !== null;
  const alpha = cooking ? 1 : 0.55;

  ctx.save();
  camera.applyTransform(ctx);
  ctx.globalAlpha = alpha;

  // The blast it will make there.
  const blast = blastFootprint(target.x, target.y, profile);
  if (blast) {
    ctx.fillStyle = 'rgba(255, 86, 60, 0.12)';
    ctx.strokeStyle = 'rgba(255, 96, 70, 0.7)';
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([8 * px, 6 * px]);
    ctx.beginPath();
    if (blast.kind === 'square') ctx.rect(blast.x0, blast.y0, blast.x1 - blast.x0, blast.y1 - blast.y0);
    else ctx.arc(blast.x, blast.y, blast.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // The path: a straight line over the ground, which is how it flies. Anything
  // standing on it -- a wall, a player, a ghoul -- stops it there.
  const lineColor = target.clamped ? 'rgba(255, 178, 61, 0.9)' : 'rgba(255, 255, 255, 0.8)';
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2 * px;
  ctx.setLineDash([6 * px, 7 * px]);
  ctx.beginPath();
  ctx.moveTo(d.originX, d.originY);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // The landing point.
  const markerR = 9 * px;
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = lineColor;
  ctx.beginPath();
  ctx.arc(target.x, target.y, markerR, 0, Math.PI * 2);
  ctx.moveTo(target.x - markerR * 1.8, target.y);
  ctx.lineTo(target.x - markerR * 0.5, target.y);
  ctx.moveTo(target.x + markerR * 0.5, target.y);
  ctx.lineTo(target.x + markerR * 1.8, target.y);
  ctx.moveTo(target.x, target.y - markerR * 1.8);
  ctx.lineTo(target.x, target.y - markerR * 0.5);
  ctx.moveTo(target.x, target.y + markerR * 0.5);
  ctx.lineTo(target.x, target.y + markerR * 1.8);
  ctx.stroke();

  // The fuse, running down around the marker.
  if (d.cook) {
    const color = fuseColor(d.cook.remainingMs);
    const lastSecond = d.cook.remainingMs <= 1000;
    const pulse = lastSecond ? 0.6 + 0.4 * Math.abs(Math.sin(d.timeMs / 70)) : 1;
    const ringR = 22 * px;
    ctx.lineWidth = 5 * px;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.arc(target.x, target.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = alpha * pulse;
    ctx.strokeStyle = color;
    ctx.beginPath();
    const start = -Math.PI / 2;
    ctx.arc(target.x, target.y, ringR, start, start + Math.PI * 2 * d.cook.fraction);
    ctx.stroke();

    ctx.font = `bold ${Math.round(13 * px * 10) / 10}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * px;
    ctx.lineJoin = 'round'; // a mitred outline spikes off the corners of the digits
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    const label = (d.cook.remainingMs / 1000).toFixed(1);
    ctx.strokeText(label, target.x, target.y - ringR - 4 * px);
    ctx.fillStyle = color;
    ctx.fillText(label, target.x, target.y - ringR - 4 * px);
  }

  ctx.restore();
}
