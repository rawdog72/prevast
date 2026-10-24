// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { UpgradePuffs } from './upgrade-puffs';

describe('UpgradePuffs', () => {
  it('bursts round the building, then is gone within a second and a bit', () => {
    const puffs = new UpgradePuffs(() => 0.5);
    expect(puffs.idle).toBe(true);
    puffs.burst(1050, 2050);
    expect(puffs.idle).toBe(false);
    expect(puffs.puffCount).toBe(17);
    for (let t = 0; t < 1200; t += 50) puffs.update(50);
    expect(puffs.idle).toBe(true);
  });

  it('thins out with the particles switch', () => {
    const puffs = new UpgradePuffs(() => 0.5);
    puffs.reduced = true;
    puffs.burst(0, 0);
    expect(puffs.puffCount).toBe(7);
  });

  it('never grows past its pool, however many finish at once', () => {
    const puffs = new UpgradePuffs(() => 0.5);
    for (let i = 0; i < 20; i++) puffs.burst(i * 100, 0);
    expect(puffs.puffCount).toBe(96);
  });
});
