// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  coldLevel,
  healthLevel,
  heartbeatBpm,
  heartbeatShape,
  radiationLevel,
  StatusVignette,
  type Vitals,
} from './status-vignette';

const healthy: Vitals = { life: 1, warmth: 1, irradiation: 0 };

function settle(fx: StatusVignette, vitals: Vitals | null, ms = 3000, step = 16): void {
  for (let t = 0; t < ms; t += step) fx.update(step, vitals);
}

/** Records the canvas calls the vignette makes; enough of the 2D context for it. */
function fakeCtx() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '' as unknown,
    globalAlpha: 1,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: () => calls.push('translate'),
    scale: () => calls.push('scale'),
    fillRect: () => calls.push('fillRect'),
    createRadialGradient: () => {
      calls.push('gradient');
      return { addColorStop: () => undefined };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('status vignette levels', () => {
  it('health: nothing above half life, ramping to full at 10 %', () => {
    expect(healthLevel(1)).toBe(0);
    expect(healthLevel(0.5)).toBe(0);
    expect(healthLevel(0.3)).toBeGreaterThan(0.3);
    expect(healthLevel(0.3)).toBeLessThan(0.7);
    expect(healthLevel(0.1)).toBe(1);
    expect(healthLevel(0)).toBe(1);
  });

  it('health rises monotonically as life drains', () => {
    let prev = -1;
    for (let life = 1; life >= 0; life -= 0.02) {
      const v = healthLevel(life);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('radiation: nothing up to 30 % irradiated, showing just past it, 80 % irradiated is full', () => {
    expect(radiationLevel(0)).toBe(0);
    expect(radiationLevel(0.3)).toBe(0);
    expect(radiationLevel(0.35)).toBeGreaterThan(0);
    expect(radiationLevel(0.8)).toBe(1);
    expect(radiationLevel(1)).toBe(1);
  });

  it('cold: nothing while warm, full when warmth is gone', () => {
    expect(coldLevel(1)).toBe(0);
    expect(coldLevel(0.35)).toBe(0);
    expect(coldLevel(0.2)).toBeGreaterThan(0);
    expect(coldLevel(0)).toBe(1);
  });

  it('the heartbeat only starts below 30 % life and quickens toward death', () => {
    expect(heartbeatBpm(0.5)).toBe(0);
    expect(heartbeatBpm(0.3)).toBe(0);
    const slow = heartbeatBpm(0.25);
    const fast = heartbeatBpm(0.05);
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
  });

  it('beats as a double thump: a strong lub, a weaker dub, then rest', () => {
    const lub = heartbeatShape(0);
    const dub = heartbeatShape(0.24);
    expect(lub).toBeCloseTo(1, 5);
    expect(dub).toBeGreaterThan(0.3);
    expect(dub).toBeLessThan(lub);
    expect(heartbeatShape(0.6)).toBe(0);
  });
});

describe('StatusVignette', () => {
  it('is invisible for a healthy player', () => {
    const fx = new StatusVignette();
    settle(fx, healthy);
    expect(fx.isVisible).toBe(false);
    const { ctx, calls } = fakeCtx();
    fx.render(ctx, 1280, 720);
    expect(calls).toEqual([]);
  });

  it('eases toward the stated level instead of popping in', () => {
    const fx = new StatusVignette();
    fx.update(16, { ...healthy, life: 0.05 });
    expect(fx.health).toBeGreaterThan(0);
    expect(fx.health).toBeLessThan(0.2);
    settle(fx, { ...healthy, life: 0.05 });
    expect(fx.health).toBeCloseTo(1, 2);
  });

  it('fades out when there is no local player (death, menu)', () => {
    const fx = new StatusVignette();
    settle(fx, { life: 0.05, warmth: 0, irradiation: 1 });
    expect(fx.isVisible).toBe(true);
    settle(fx, null);
    expect(fx.isVisible).toBe(false);
  });

  it('pulses the heartbeat only while critically hurt', () => {
    const fx = new StatusVignette();
    let peak = 0;
    for (let t = 0; t < 3000; t += 16) {
      fx.update(16, { ...healthy, life: 0.4 });
      peak = Math.max(peak, fx.beat);
    }
    expect(peak).toBe(0);
    for (let t = 0; t < 3000; t += 16) {
      fx.update(16, { ...healthy, life: 0.1 });
      peak = Math.max(peak, fx.beat);
    }
    expect(peak).toBeGreaterThan(0.5);
  });

  it('flashes on a hit and the flash dies away within half a second', () => {
    const fx = new StatusVignette();
    settle(fx, healthy);
    fx.hit();
    expect(fx.flash).toBe(1);
    expect(fx.isVisible).toBe(true);
    settle(fx, healthy, 500);
    expect(fx.flash).toBe(0);
    expect(fx.isVisible).toBe(false);
  });

  it('draws each active layer, leaving the canvas state balanced', () => {
    const fx = new StatusVignette();
    settle(fx, { life: 0.05, warmth: 0, irradiation: 1 });
    const { ctx, calls } = fakeCtx();
    fx.render(ctx, 1280, 720, () => 0.5);
    expect(calls.filter((c) => c === 'gradient').length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c === 'save').length).toBe(
      calls.filter((c) => c === 'restore').length,
    );
    expect(ctx.globalAlpha).toBe(1);
  });
});
