// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The browser's copy of the server's region rules (apps/server/src/gameplay/scenarios/
// scenario_regions.cpp): containment, permission priority and effect stacking. The editor
// uses it for diagnostics and to show what a region does at a point; the numbers are held to
// the C++ self-test's by scenario-regions.test.ts.
//
//   * Permissions: the highest-priority region containing the point that sets it decides;
//     at equal priority deny wins; no region = inherit (undefined).
//   * Effects: per stat and stack channel (default: the stat's name) a "strongest" effect
//     keeps the largest positive and the most negative contribution, "additive" ones sum;
//     channels add. Linear falloff: 1 at the centre to 0 at the edge (circle by distance,
//     rectangle by the nearer edge). The total is rounded once to the gauge wire's step.
import type { EffectStat, RegionShape, ScenarioProject, ScenarioRegion } from './scenario-schema';
import { EFFECT_STATS } from './scenario-schema';

/** Gauge points per minute one wire rate unit stands for (rate/10000 per ms). */
export const POINTS_PER_MINUTE_PER_RATE = 6;

/** perMinute rounded to the rate a player actually gets (C++ std::lround). */
export function wireRate(pointsPerMinute: number): number {
  const q = pointsPerMinute / POINTS_PER_MINUTE_PER_RATE;
  return Math.sign(q) * Math.round(Math.abs(q));
}

/** The points per minute a player actually gets for an authored rate. */
export function effectiveRate(pointsPerMinute: number): number {
  return wireRate(pointsPerMinute) * POINTS_PER_MINUTE_PER_RATE;
}

export interface ResolvedRegion {
  region: ScenarioRegion;
  /** Absolute: circle centre, rect top-left, polygon points. */
  shape: RegionShape;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type PermissionKind = 'build' | 'pvp' | 'spawn';

/** Shapes in absolute world units (attached regions offset by their placement). */
export function resolveRegions(project: Pick<ScenarioProject, 'entities' | 'regions'>): ResolvedRegion[] {
  const anchors = new Map(project.entities.map((e) => [e.id, e] as const));
  const out: ResolvedRegion[] = [];
  for (const region of project.regions) {
    let ox = 0;
    let oy = 0;
    if (region.attach !== undefined) {
      const anchor = anchors.get(region.attach);
      if (!anchor) continue;
      ox = anchor.x;
      oy = anchor.y;
    }
    const s = region.shape;
    if (s.type === 'circle') {
      const x = s.x + ox;
      const y = s.y + oy;
      out.push({ region, shape: { ...s, x, y }, minX: x - s.r, minY: y - s.r, maxX: x + s.r, maxY: y + s.r });
    } else if (s.type === 'rect') {
      const x = s.x + ox;
      const y = s.y + oy;
      out.push({ region, shape: { ...s, x, y }, minX: x, minY: y, maxX: x + s.w - 1, maxY: y + s.h - 1 });
    } else {
      const points = s.points.map(([px, py]) => [px + ox, py + oy] as [number, number]);
      out.push({
        region,
        shape: { type: 'polygon', points },
        minX: Math.min(...points.map((p) => p[0])),
        minY: Math.min(...points.map((p) => p[1])),
        maxX: Math.max(...points.map((p) => p[0])),
        maxY: Math.max(...points.map((p) => p[1])),
      });
    }
  }
  return out;
}

export function regionContains(r: ResolvedRegion, x: number, y: number): boolean {
  if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) return false;
  const s = r.shape;
  if (s.type === 'circle') return (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r * s.r;
  if (s.type === 'rect') return true;
  let inside = false;
  const pts = s.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y) {
      const lhs = (x - xi) * (yj - yi);
      const rhs = (y - yi) * (xj - xi);
      if (yj > yi ? lhs < rhs : lhs > rhs) inside = !inside;
    }
  }
  return inside;
}

function strength(r: ResolvedRegion, x: number, y: number): number {
  const s = r.shape;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (s.type === 'circle') return clamp(1 - Math.hypot(x - s.x, y - s.y) / s.r);
  if (s.type === 'rect') {
    const hw = s.w / 2;
    const hh = s.h / 2;
    return clamp(1 - Math.max(Math.abs(x - (s.x + hw)) / hw, Math.abs(y - (s.y + hh)) / hh));
  }
  return 1;
}

export function permissionAt(regions: readonly ResolvedRegion[], kind: PermissionKind, x: number, y: number): boolean | undefined {
  let best: number | undefined;
  let allowed = true;
  for (const r of regions) {
    const p = r.region.permissions?.[kind];
    if (!p || !regionContains(r, x, y)) continue;
    const allow = p === 'allow';
    if (best === undefined || r.region.priority > best) {
      best = r.region.priority;
      allowed = allow;
    } else if (r.region.priority === best && !allow) allowed = false;
  }
  return best === undefined ? undefined : allowed;
}

/** Signed wire rates per stat at a point (see the header for the rules). */
export function ratesAt(regions: readonly ResolvedRegion[], x: number, y: number): Record<EffectStat, number> {
  const channels = new Map<string, { up: number; down: number; sum: number }>();
  for (const r of regions) {
    if (!r.region.effects?.length || !regionContains(r, x, y)) continue;
    for (const e of r.region.effects) {
      const value = e.perMinute * (e.falloff === 'linear' ? strength(r, x, y) : 1);
      const key = `${e.stat}\u0000${e.channel ?? e.stat}`;
      const c = channels.get(key) ?? { up: 0, down: 0, sum: 0 };
      if (e.stacking === 'additive') c.sum += value;
      else if (value > 0) c.up = Math.max(c.up, value);
      else c.down = Math.min(c.down, value);
      channels.set(key, c);
    }
  }
  const out = Object.fromEntries(EFFECT_STATS.map((s) => [s, 0])) as Record<EffectStat, number>;
  const totals = new Map<EffectStat, number>();
  // Channels sum in name order, as the server's ordered map does.
  for (const key of [...channels.keys()].sort()) {
    const stat = key.split('\u0000')[0] as EffectStat;
    const c = channels.get(key)!;
    totals.set(stat, (totals.get(stat) ?? 0) + c.up + c.down + c.sum);
  }
  for (const [stat, total] of totals) out[stat] = wireRate(total);
  return out;
}
