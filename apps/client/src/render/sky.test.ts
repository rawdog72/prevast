// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { nightAt, SKY_FADE_MS } from './sky';

// The shipped cycle (modes.xml dayNightCycle): an 8 minute day, an 8 minute night.
const CYCLE = 960000;
const HALF = CYCLE / 2;

describe('nightAt', () => {
  it('is the plain day palette at midday and the plain night palette all night', () => {
    expect(nightAt(HALF / 2, CYCLE)).toBe(0);
    expect(nightAt(HALF, CYCLE)).toBe(1);
    expect(nightAt(HALF + HALF / 2, CYCLE)).toBe(1);
    expect(nightAt(CYCLE - 1, CYCLE)).toBe(1);
  });

  it('fades the night palette in over the last stretch of the day, full by nightfall', () => {
    const dusk = HALF - SKY_FADE_MS;
    expect(nightAt(dusk, CYCLE)).toBe(0);
    expect(nightAt(dusk + SKY_FADE_MS / 2, CYCLE)).toBeCloseTo(0.5, 6);
    let last = 0;
    for (let t = dusk; t < HALF; t += 250) {
      const now = nightAt(t, CYCLE);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBeGreaterThan(0.99);
  });

  it('fades it back out over the first stretch of the day', () => {
    expect(nightAt(0, CYCLE)).toBe(1);
    expect(nightAt(SKY_FADE_MS / 2, CYCLE)).toBeCloseTo(0.5, 6);
    expect(nightAt(SKY_FADE_MS, CYCLE)).toBe(0);
  });

  it('never jumps: the whole cycle, sampled every 10 ms, moves in small steps', () => {
    let prev = nightAt(CYCLE - 10, CYCLE);
    let step = 0;
    for (let t = 0; t < CYCLE; t += 10) {
      const now = nightAt(t, CYCLE);
      step = Math.max(step, Math.abs(now - prev));
      prev = now;
    }
    expect(step).toBeLessThan(0.002);
  });

  it('fits the fades inside the half on a short cycle, leaving plain day between them', () => {
    expect(nightAt(2500, 10000)).toBe(0);
    expect(nightAt(4999, 10000)).toBeGreaterThan(0.99);
    expect(nightAt(1, 10000)).toBeGreaterThan(0.99);
  });

  it('reads a phase outside the cycle modulo the cycle, and a degenerate cycle as day', () => {
    expect(nightAt(CYCLE + HALF / 2, CYCLE)).toBe(nightAt(HALF / 2, CYCLE));
    expect(nightAt(500, 0)).toBe(0);
  });
});
