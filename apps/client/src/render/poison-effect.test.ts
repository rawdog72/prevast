// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { POISON_CYCLE_MS, PoisonEffect } from './poison-effect';

function run(fx: PoisonEffect, ms: number, step = 50): number[] {
  const values: number[] = [];
  for (let t = 0; t < ms; t += step) {
    fx.update(step);
    values.push(fx.value);
  }
  return values;
}

describe('PoisonEffect (old client _SetPoisonEffect)', () => {
  it('is inert until started and exposes neutral multipliers', () => {
    const fx = new PoisonEffect();
    fx.update(100);
    expect(fx.isActive).toBe(false);
    expect(fx.zoomMultiplier).toBe(1);
    expect(fx.resolutionDivisor).toBe(1);
  });

  it('throbs on a 1.5 s cycle: up to 1 at 750 ms, back down, floored at 0.5 after the first half', () => {
    const fx = new PoisonEffect();
    fx.start(10_000);
    const v = run(fx, POISON_CYCLE_MS * 2);
    // First rise reaches the peak at 750 ms.
    expect(v[14]).toBeCloseTo(1, 5);
    // The first cycle's descent goes to (nearly) the floor: elapsed > 750 -> 0.5 + 0.5v.
    expect(v[29]).toBeCloseTo(0.5, 2);
    // The second cycle stays between 0.5 and 1.
    for (const x of v.slice(30)) {
      expect(x).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(fx.zoomMultiplier).toBe(1 + fx.value);
    expect(fx.resolutionDivisor).toBe(1 + fx.value * 20);
  });

  it('ends only on a cycle boundary, ramping to 0 through the last descent', () => {
    const fx = new PoisonEffect();
    fx.start(2000);
    // 2000 ms of poison means the timer runs out mid-second-cycle; the effect
    // finishes that cycle (at 3000 ms) and is clean at the end.
    const v = run(fx, 2950);
    expect(fx.isActive).toBe(true);
    // Last descent: monotonically down to ~0.
    const tail = v.slice(45);
    for (let i = 1; i < tail.length; i++) expect(tail[i]).toBeLessThanOrEqual(tail[i - 1]! + 1e-9);
    expect(v[v.length - 1]).toBeLessThan(0.1);

    fx.update(60);
    expect(fx.isActive).toBe(false);
    expect(fx.value).toBe(0);
    expect(fx.zoomMultiplier).toBe(1);
  });

  it('start(0) / stop() run the timer out; start() while running keeps the phase', () => {
    const fx = new PoisonEffect();
    fx.start(60_000);
    run(fx, 400);
    const phaseValue = fx.value;
    fx.start(60_000);
    fx.update(50);
    expect(fx.value).toBeGreaterThan(phaseValue);

    fx.start(0);
    run(fx, POISON_CYCLE_MS + 100);
    expect(fx.isActive).toBe(false);
  });
});
