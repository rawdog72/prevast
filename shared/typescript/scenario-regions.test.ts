// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The same cases, and the same numbers, as runRegionSelfTest in
// apps/server/src/gameplay/scenarios/scenario_regions.cpp.
import { describe, expect, it } from 'vitest';
import { effectiveRate, permissionAt, ratesAt, regionContains, resolveRegions, wireRate } from './scenario-regions';
import type { RegionEffect, ScenarioEntity, ScenarioRegion } from './scenario-schema';

const circle = (id: string, x: number, y: number, r: number, extra: Partial<ScenarioRegion> = {}): ScenarioRegion => ({
  id,
  name: id,
  shape: { type: 'circle', x, y, r },
  priority: 0,
  ...extra,
});
const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<ScenarioRegion> = {}): ScenarioRegion => ({
  id,
  name: id,
  shape: { type: 'rect', x, y, w, h },
  priority: 0,
  ...extra,
});
const fx = (stat: RegionEffect['stat'], perMinute: number, more: Partial<RegionEffect> = {}): RegionEffect => ({
  stat,
  perMinute,
  falloff: 'none',
  ...more,
});
const build = (regions: ScenarioRegion[], entities: ScenarioEntity[] = []) => resolveRegions({ entities, regions });

describe('scenario region rules (mirrors the server self-test)', () => {
  it('contains points like the server', () => {
    const [c, r, p] = build([
      circle('c', 1000, 1000, 300),
      rect('r', 2000, 2000, 400, 200),
      { id: 'p', name: 'p', priority: 0, shape: { type: 'polygon', points: [[0, 0], [1000, 0], [1000, 1000], [500, 300], [0, 1000]] } },
    ]);
    expect(regionContains(c!, 1000, 1000) && regionContains(c!, 1300, 1000) && !regionContains(c!, 1301, 1000)).toBe(true);
    expect(regionContains(r!, 2000, 2000) && regionContains(r!, 2399, 2199) && !regionContains(r!, 2400, 2100)).toBe(true);
    expect(regionContains(p!, 100, 100) && regionContains(p!, 900, 800) && !regionContains(p!, 500, 800)).toBe(true);
    expect(regionContains(p!, 1500, 500)).toBe(false);
  });

  it('fades and rounds like the server', () => {
    const regions = build([
      circle('c', 1000, 1000, 400, { effects: [fx('radiation', 90, { falloff: 'linear' })] }),
      rect('r', 3000, 3000, 400, 200, { effects: [fx('warmth', 60, { falloff: 'linear' })] }),
    ]);
    expect(ratesAt(regions, 1000, 1000).radiation).toBe(15);
    expect(ratesAt(regions, 1200, 1000).radiation).toBe(8);
    expect(ratesAt(regions, 1400, 1000).radiation).toBe(0);
    expect([ratesAt(regions, 3200, 3100).warmth, ratesAt(regions, 3300, 3100).warmth, ratesAt(regions, 3200, 3150).warmth]).toEqual([10, 5, 5]);
    expect([wireRate(-9), wireRate(3), wireRate(2)]).toEqual([-2, 1, 0]);
    expect(effectiveRate(10)).toBe(12);
  });

  it('stacks like the server', () => {
    const regions = build([
      circle('a', 1000, 1000, 500, { effects: [fx('radiation', 60)] }),
      circle('b', 1000, 1000, 500, { effects: [fx('radiation', 120)] }),
      circle('n', 1000, 1000, 500, { effects: [fx('radiation', -30)] }),
      circle('o', 1000, 1000, 500, { effects: [fx('radiation', 30, { channel: 'shelter' })] }),
      circle('d1', 5000, 5000, 500, { effects: [fx('food', 60, { stacking: 'additive' })] }),
      circle('d2', 5000, 5000, 500, { effects: [fx('food', 120, { stacking: 'additive' })] }),
    ]);
    expect(ratesAt(regions, 1000, 1000).radiation).toBe(20);
    expect(ratesAt(regions, 5000, 5000).food).toBe(30);
  });

  it('resolves permissions like the server', () => {
    const regions = build([
      rect('low', 0, 0, 1000, 1000, { priority: 1, permissions: { pvp: 'deny', build: 'deny' } }),
      rect('high', 0, 0, 500, 500, { priority: 5, permissions: { pvp: 'allow' } }),
      rect('tie', 0, 0, 500, 500, { priority: 1, permissions: { build: 'allow' } }),
    ]);
    expect(permissionAt(regions, 'pvp', 100, 100)).toBe(true);
    expect(permissionAt(regions, 'pvp', 800, 800)).toBe(false);
    expect(permissionAt(regions, 'build', 100, 100)).toBe(false);
    expect(permissionAt(regions, 'spawn', 100, 100)).toBeUndefined();
    expect(permissionAt(regions, 'pvp', 5000, 5000)).toBeUndefined();
  });

  it('places attached regions on their placement', () => {
    const regions = build(
      [circle('f', 0, 0, 200, { attach: 'barrel', effects: [fx('radiation', 60)] })],
      [{ id: 'barrel', kind: 'object', ref: 'barrel', x: 2050, y: 2050 }],
    );
    expect(ratesAt(regions, 2100, 2050).radiation).toBe(10);
  });
});
