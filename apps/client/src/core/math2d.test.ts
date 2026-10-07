// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { angle, clamp, distSq, distance, fastDist, lerp, reduceAngle } from './math2d';

describe('math2d', () => {
  it('calculates euclidean distance and squared distance', () => {
    expect(distance(0, 0, 3, 4)).toBe(5);
    expect(distSq(0, 0, 3, 4)).toBe(25);
    expect(distance(10, 20, 10, 20)).toBe(0);
  });

  it('calculates fast manhattan distance', () => {
    expect(fastDist(0, 0, 3, 4)).toBe(7);
    expect(fastDist(-5, 10, 5, -10)).toBe(30);
  });

  it('calculates correct angles across quadrants', () => {
    expect(angle(0, 0, 10, 0)).toBeCloseTo(0);
    expect(angle(0, 0, 0, 10)).toBeCloseTo(Math.PI / 2);
    expect(angle(0, 0, -10, 0)).toBeCloseTo(Math.PI);
    expect(angle(0, 0, 0, -10)).toBeCloseTo(-Math.PI / 2);
  });

  it('lerps correctly and handles edge weights', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it('clamps values within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('reduces angles to take the shortest path around the circle', () => {
    // 0.1 to 6.2 (near 2*PI): shortest path is backwards across 0
    const near2Pi = Math.PI * 2 - 0.1;
    const reduced = reduceAngle(0.1, near2Pi);
    expect(reduced).toBeCloseTo(-0.1);

    // 6.2 to 0.1: shortest path is forwards across 2*PI
    const reducedForward = reduceAngle(near2Pi, 0.1);
    expect(reducedForward).toBeCloseTo(Math.PI * 2 + 0.1);

    // Regular angle without wrap
    expect(reduceAngle(0.5, 1.5)).toBeCloseTo(1.5);
  });
});
