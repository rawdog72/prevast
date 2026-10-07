// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  LEAF_BREATH_MS,
  LOOT_BREATH_MS,
  leafBreathScale,
  leafSway,
  lootBreathScale,
} from './breath';

describe('leafBreathScale (old _Resources imgTop breath, 6 s triangle, +2.5 %)', () => {
  it('is largest at the cycle ends and 1.0 in the middle', () => {
    expect(LEAF_BREATH_MS).toBe(6000);
    expect(leafBreathScale(0)).toBeCloseTo(1.025, 6);
    expect(leafBreathScale(1500)).toBeCloseTo(1.0125, 6);
    expect(leafBreathScale(3000)).toBeCloseTo(1.0, 6);
    expect(leafBreathScale(4500)).toBeCloseTo(1.0125, 6);
    expect(leafBreathScale(5999)).toBeCloseTo(1.025, 3);
  });
  it('wraps any phase into the cycle', () => {
    expect(leafBreathScale(9000)).toBeCloseTo(leafBreathScale(3000), 6);
    expect(leafBreathScale(6000)).toBeCloseTo(leafBreathScale(0), 6);
  });
});

describe('lootBreathScale (old _Loots, 1.5 s inOutQuad between 0.95 and 1.05)', () => {
  it('grows to 1.05 at half cycle and back to 0.95', () => {
    expect(LOOT_BREATH_MS).toBe(1500);
    expect(lootBreathScale(0)).toBeCloseTo(0.95, 6);
    expect(lootBreathScale(375)).toBeCloseTo(0.95 + 0.5 * 0.5 * 2 * 0.1, 6); // inOutQuad(.5) = .5
    expect(lootBreathScale(750)).toBeCloseTo(1.05, 6);
    expect(lootBreathScale(1125)).toBeCloseTo(1.0, 6);
    expect(lootBreathScale(1500)).toBeCloseTo(0.95, 6);
  });
});

describe('leafSway (old hurt2: 300 ms, out fast to 10 units, back slow)', () => {
  it('is 0 at rest, peaks at 10 when 250 ms remain, and eases back to 0', () => {
    expect(leafSway(0)).toBe(0);
    expect(leafSway(300)).toBe(0);
    expect(leafSway(250)).toBeCloseTo(10, 6);
    expect(leafSway(125)).toBeCloseTo(10 * (1 - 0.25), 6); // outQuad(.5) = .75
    expect(leafSway(275)).toBeCloseTo(10 * 0.25, 6); // inQuad(.5) = .25
  });
});
