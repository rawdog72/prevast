// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/aim-view.ts
// What an aimed gun shows: its <view>, and the box the server sends while it
// is aimed. The box math is the server's (apps/server/src/gameplay/aim_view.cpp
// aimedView) and both run tests/fixtures/weapon-mods/view-cases.json. Display
// only: the server decides what is sent.
import type { ContentStore } from '../content/store';
import { modByIid, resolveWeapon, type AimStats, type FittedMod } from './weapon-mods';

export type WeakShape = 'stretch' | 'shift';

/** A weak <view> as content exports it: it widens the box the server sends. */
export interface WeakViewDef {
  shape: WeakShape;
  ahead: number;
  extend: number;
  zoom: number;
}

/** A strong cone <view>: the server sends only what is inside it and the rear circle. */
export interface ConeViewDef {
  shape: 'cone';
  reach: number;
  halfAngleDeg: number;
  zoom: number;
  rearRadius: number;
}

/** A strong rect <view>; `back` is 0 when left out. */
export interface RectViewDef {
  shape: 'rect';
  length: number;
  width: number;
  back?: number;
  zoom: number;
  rearRadius: number;
}

export type StrongViewDef = ConeViewDef | RectViewDef;
export type ViewDef = WeakViewDef | StrongViewDef;

export function isStrong(view: ViewDef | null | undefined): view is StrongViewDef {
  return view?.shape === 'cone' || view?.shape === 'rect';
}

/** A world offset from the player. */
export interface Offset {
  x: number;
  y: number;
}

/** Offsets from the player: what the server sends lies within them. */
export interface ViewBox {
  minDX: number;
  maxDX: number;
  minDY: number;
  maxDY: number;
}

export interface PlayerView {
  box: ViewBox;
  offX: number;
  offY: number;
  stretch: boolean;
}

// Toward zero like the server's int cast; `|| 0` because -0 is not 0 to a fixture comparison.
const trunc = (v: number): number => Math.trunc(v) || 0;

export function normalView(viewX: number, viewY: number): PlayerView {
  return {
    box: { minDX: -viewX, maxDX: viewX, minDY: -viewY, maxDY: viewY },
    offX: 0,
    offY: 0,
    stretch: false,
  };
}

/** The box while aiming `view` toward `angle` (radians, y down, as the facing is computed). */
export function aimedView(
  view: ViewDef | null,
  viewX: number,
  viewY: number,
  angle: number,
): PlayerView {
  const v = normalView(viewX, viewY);
  // A strong view's box is only where the server's scenery comes from; the client draws the shape.
  if (!view || isStrong(view)) return v;
  const ex = trunc(view.extend * Math.cos(angle));
  const ey = trunc(view.extend * Math.sin(angle));
  const b = v.box;
  if (view.shape === 'shift') {
    b.minDX += ex;
    b.maxDX += ex;
    b.minDY += ey;
    b.maxDY += ey;
  } else {
    if (ex > 0) b.maxDX += ex;
    else b.minDX += ex;
    if (ey > 0) b.maxDY += ey;
    else b.minDY += ey;
  }
  return { box: b, offX: ex, offY: ey, stretch: view.shape === 'stretch' };
}

/** The cone's arc is drawn in steps of at most this many degrees. */
const ARC_STEP_DEG = 2;

/**
 * A strong view's inner shape toward `angle` (radians, y down), as a polygon
 * of offsets from the player. This is the shape the server sends a new entity
 * from (aim_view::strongContains). The rear circle (`rearRadius`) is not part
 * of the polygon.
 */
export function scopeOutline(view: StrongViewDef, angle: number): Offset[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Along the aim and across it, to a world offset.
  const at = (along: number, across: number): Offset => ({
    x: along * c - across * s,
    y: along * s + across * c,
  });
  if (view.shape === 'rect') {
    const back = view.back ?? 0;
    const half = view.width / 2;
    return [at(-back, -half), at(view.length, -half), at(view.length, half), at(-back, half)];
  }
  const half = (view.halfAngleDeg * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil((2 * view.halfAngleDeg) / ARC_STEP_DEG));
  const out: Offset[] = [{ x: 0, y: 0 }];
  for (let i = 0; i <= steps; i++) {
    const a = -half + (2 * half * i) / steps;
    out.push(at(view.reach * Math.cos(a), view.reach * Math.sin(a)));
  }
  return out;
}

/**
 * The player's zoom as an aimed view changes it, `blend` (0..1) of the way
 * in. A weak view multiplies the player's zoom and never goes past `zoomMin`.
 * A strong one replaces it with its own zoom, below `zoomMin` if it says so:
 * the shape is fixed in world units and has to fit on screen.
 */
export function aimedZoom(zoomShown: number, view: ViewDef | null, blend: number, zoomMin: number): number {
  const own = Math.max(zoomMin, zoomShown);
  if (!view || blend <= 0) return own;
  if (isStrong(view)) return own + (view.zoom - own) * blend;
  return Math.max(zoomMin, zoomShown * (1 + (view.zoom - 1) * blend));
}

/** The Mods window's line on what aiming with this view does. */
export function describeView(view: ViewDef | null): string {
  if (!view) return 'Standard aimed view.';
  switch (view.shape) {
    case 'stretch':
      return `View extends forward; rear coverage is preserved. Look ahead ${view.ahead} · camera ×${view.zoom.toFixed(2)}.`;
    case 'shift':
      return `View shifts forward; rear coverage is reduced. Look ahead ${view.ahead} · camera ×${view.zoom.toFixed(2)}.`;
    case 'cone':
      return `Scope view: a ${view.halfAngleDeg * 2}° cone reaching ${view.reach}. Only that and ${view.rearRadius} around you are shown. Camera fixed at ×${view.zoom.toFixed(2)}.`;
    case 'rect':
      return `Scope view: ${view.length} ahead, ${view.width} wide. Only that and ${view.rearRadius} around you are shown. Camera fixed at ×${view.zoom.toFixed(2)}.`;
  }
}

/** What a gun shows aimed with these mods: the fitted optic's <view>, else its own (weapon_mods::effectiveView). */
export function effectiveView(
  content: ContentStore,
  iid: number,
  fitted: readonly FittedMod[],
): ViewDef | null {
  for (const f of fitted) {
    const mod = modByIid(content, f.iid);
    if (mod?.slot === 'optic' && mod.view) return mod.view;
  }
  if (!content.has('items') || !content.has('equipables')) return null;
  const key = content.byId('items', iid)?.equipable?.key;
  const own = key ? content.byKey('equipables', key)?.view : undefined;
  return own ? (own as ViewDef) : null;
}

/** The gun's resolved aim stats, or null when it cannot aim. */
export function aimOf(
  content: ContentStore,
  iid: number,
  fitted: readonly FittedMod[],
): AimStats | null {
  return resolveWeapon(content, iid, fitted)?.aim ?? null;
}
