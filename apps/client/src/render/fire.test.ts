// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import { AFTERBURN_MS, FireEffects, type FireSource, flameScale, tileHeat } from './fire';

function fire(over: Partial<FireSource> = {}): FireSource {
  return {
    id: 1,
    tileX: 10,
    tileY: 10,
    growMs: 500,
    holdMs: 8000,
    fadeMs: 1500,
    ageMs: 0,
    cells: [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
    ],
    ...over,
  };
}

/** A repeatable random stream. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Runs `ms` of updates at 60 fps, the fire ageing with the clock as the cloud layer does. */
function run(
  effects: FireEffects,
  f: FireSource | null,
  ms: number,
  extra: Parameters<FireEffects['update']>[1] = { fires: [] },
) {
  for (let t = 0; t < ms; t += 16) {
    if (f) f.ageMs += 16;
    effects.update(16, { ...extra, fires: f ? [f] : [] });
  }
}

function wideCamera(): Camera {
  const camera = new Camera({ viewportWidth: 8000, viewportHeight: 8000 });
  camera.x = 1000;
  camera.y = 1000;
  return camera;
}

describe('tileHeat', () => {
  it('catches tile by tile over the growth, holds, and dies down over the fade', () => {
    const f = fire();
    expect(tileHeat({ ...f, ageMs: 0 }, 0)).toBe(0);
    expect(tileHeat({ ...f, ageMs: 400 }, 0)).toBeCloseTo(1);
    expect(tileHeat({ ...f, ageMs: 100 }, 3)).toBe(0); // not reached yet
    expect(tileHeat({ ...f, ageMs: 2000 }, 3)).toBe(1);
    expect(tileHeat({ ...f, ageMs: 8500 + 750 }, 2)).toBeCloseTo(0.5);
    expect(tileHeat({ ...f, ageMs: 10000 }, 2)).toBe(0);
  });
});

describe('flameScale', () => {
  it('swells from nothing, peaks early, and shrinks back to nothing', () => {
    expect(flameScale(0)).toBe(0);
    expect(flameScale(0.14)).toBeCloseTo(1);
    // It spends most of its life near full size: small flames read as clutter.
    expect(flameScale(0.6)).toBeGreaterThan(0.8);
    expect(flameScale(0.5)).toBeGreaterThan(0.3);
    expect(flameScale(0.5)).toBeLessThan(1);
    expect(flameScale(1)).toBeCloseTo(0);
  });
});

describe('FireEffects', () => {
  it('keeps flames burning on a held fire, and none once it is out', () => {
    const fx = new FireEffects(seeded());
    const f = fire();
    fx.ignite(f);
    run(fx, f, 3000);
    expect(fx.flameCount).toBeGreaterThan(10);
    f.ageMs = 10000;
    run(fx, null, 2000);
    expect(fx.flameCount).toBe(0);
  });

  it('keeps a full molotov fire to a modest number of flames: they are the cost', () => {
    const fx = new FireEffects(seeded());
    const nine = fire({
      ageMs: 2000,
      cells: [
        [0, 0],
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ],
    });
    run(fx, nine, 3000);
    expect(fx.flameCount).toBeGreaterThan(30);
    expect(fx.flameCount).toBeLessThan(90);
  });

  it('keeps the live particles packed at the front of their pools', () => {
    const fx = new FireEffects(seeded());
    const f = fire({ ageMs: 2000 });
    fx.ignite(fire({ id: 5, ageMs: 10 }));
    for (let step = 0; step < 6; step++) {
      run(fx, f, 337);
      const flames = (fx as unknown as { flames: Array<{ active: boolean }> }).flames;
      const n = fx.flameCount;
      expect(flames.slice(0, n).every((p) => p.active)).toBe(true);
      expect(flames.slice(n).some((p) => p.active)).toBe(false);
    }
  });

  it('draws two fires on the same spot as one: stacked molotovs do not stack flames', () => {
    const one = new FireEffects(seeded());
    const three = new FireEffects(seeded());
    const at = (id: number) => fire({ id, ageMs: 2000 });
    const single = [at(1)];
    const stacked = [at(1), at(2), at(3)];
    for (let t = 0; t < 3000; t += 16) {
      for (const f of [...single, ...stacked]) f.ageMs += 16;
      one.update(16, { fires: single });
      three.update(16, { fires: stacked });
    }
    expect(three.flameCount).toBeLessThan(one.flameCount * 1.4);
    // ...and one light and one scorch, not three.
    const lights = (fx: FireEffects) => (fx as unknown as { lights: unknown[] }).lights.length;
    expect(lights(three)).toBe(1);
  });

  it('breaks another bottle when a fire it fed is restated', () => {
    const fx = new FireEffects(seeded());
    const f = fire({ ageMs: 3000 });
    fx.ignite(f);
    expect(fx.lastShatter).toBeNull();
    fx.update(16, { fires: [f], projectiles: [{ id: 9, x: 1130, y: 1060 }] });
    fx.rekindle({ ...f, ageMs: 500 });
    expect(fx.lastShatter).toEqual({ x: 1130, y: 1060 });
  });

  it('breaks the bottle once for a fresh fire, never for one already burning', () => {
    const fresh = new FireEffects(seeded());
    fresh.ignite(fire({ ageMs: 50 }));
    expect(fresh.shardCount).toBeGreaterThan(0);
    expect(fresh.lastShatter).toEqual({ x: 1050, y: 1050 });

    const restated = new FireEffects(seeded());
    const f = fire({ ageMs: 50 });
    restated.ignite(f);
    restated.lastShatter = null;
    restated.ignite(f);
    expect(restated.lastShatter).toBeNull();

    const old = new FireEffects(seeded());
    old.ignite(fire({ ageMs: 4000 }));
    expect(old.shardCount).toBe(0);
    expect(old.lastShatter).toBeNull();
  });

  it('breaks the bottle where it was last seen flying, not in the middle of the tile', () => {
    const fx = new FireEffects(seeded());
    fx.update(16, { fires: [], projectiles: [{ id: 3, x: 1010, y: 1030 }] });
    fx.update(16, { fires: [], projectiles: [{ id: 3, x: 1022, y: 1041 }] });
    fx.ignite(fire({ ageMs: 30 }));
    expect(fx.lastShatter).toEqual({ x: 1022, y: 1041 });
  });

  it('ignores a bottle seen far away or long ago', () => {
    const fx = new FireEffects(seeded());
    fx.update(16, { fires: [], projectiles: [{ id: 3, x: 3000, y: 3000 }] });
    fx.ignite(fire({ ageMs: 30 }));
    expect(fx.lastShatter).toEqual({ x: 1050, y: 1050 });

    const stale = new FireEffects(seeded());
    stale.update(16, { fires: [], projectiles: [{ id: 3, x: 1020, y: 1040 }] });
    run(stale, null, 1000);
    stale.ignite(fire({ id: 2, ageMs: 30 }));
    expect(stale.lastShatter).toEqual({ x: 1050, y: 1050 });
  });

  it('sets whoever stands in it alight, and they burn on a moment after stepping out', () => {
    const fx = new FireEffects(seeded());
    const f = fire({ ageMs: 2000 });
    const walker = { x: 1050, y: 1050 };
    run(fx, f, 500, { fires: [], creatures: [walker] });
    const inFire = fx.flameCount;
    walker.x = 2000; // out of it
    run(fx, f, AFTERBURN_MS / 2, { fires: [], creatures: [walker] });
    // Flames still being born on the walker, far from the fire.
    const near = (
      fx as unknown as { flames: Array<{ active: boolean; x: number; over: boolean }> }
    ).flames.filter((p) => p.active && p.over && Math.abs(p.x - 2000) < 60);
    expect(near.length).toBeGreaterThan(0);
    expect(inFire).toBeGreaterThan(0);
    run(fx, f, AFTERBURN_MS, { fires: [], creatures: [walker] });
    const later = (
      fx as unknown as { flames: Array<{ active: boolean; x: number; over: boolean }> }
    ).flames.filter((p) => p.active && p.over && Math.abs(p.x - 2000) < 60);
    expect(later).toHaveLength(0);
  });

  it('leaves scorch behind that outlasts the fire, then is gone', () => {
    const fx = new FireEffects(seeded());
    const f = fire();
    fx.ignite(f);
    run(fx, f, 10000); // grown, held and faded
    run(fx, null, 3000);
    expect(fx.idle).toBe(false);
    run(fx, null, 20000);
    expect(fx.idle).toBe(true);
  });

  it('thins its decoration out when particles are switched off, but keeps the flames', () => {
    const full = new FireEffects(seeded());
    const thin = new FireEffects(seeded());
    thin.reduced = true;
    full.ignite(fire({ ageMs: 10 }));
    thin.ignite(fire({ ageMs: 10 }));
    expect(thin.shardCount).toBeLessThan(full.shardCount);
    const f1 = fire({ ageMs: 2000 });
    const f2 = fire({ ageMs: 2000 });
    run(full, f1, 1000);
    run(thin, f2, 1000);
    expect(thin.flameCount).toBeGreaterThan(0);
  });

  /** A context that records fills and the circles and flames added to the path. */
  function recording() {
    const fills: Array<{ style: string; alpha: number; points: Array<[number, number]> }> = [];
    let points: Array<[number, number]> = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      globalAlpha: 1,
      fillStyle: '',
      beginPath: () => (points = []),
      moveTo: (x: number, y: number) => points.push([x, y]),
      lineTo: () => {},
      bezierCurveTo: () => {},
      closePath: () => {},
      arc: (x: number, y: number) => points.push([x, y]),
      fill() {
        fills.push({ style: String(this.fillStyle), alpha: this.globalAlpha, points });
      },
      createRadialGradient: () => {
        throw new Error('gradients are not the game style');
      },
      createLinearGradient: () => {
        throw new Error('gradients are not the game style');
      },
      drawImage: () => {
        throw new Error('no bitmaps: flat shapes only');
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
  }

  it('fills each flame colour as one flat shape, however many flames there are', () => {
    const fx = new FireEffects(seeded());
    const f = fire({ ageMs: 2000 });
    run(fx, f, 1000);
    expect(fx.flameCount).toBeGreaterThan(10);
    const { ctx, fills } = recording();
    fx.renderGround(ctx, wideCamera(), 0);
    const flames = fills.filter((x) => ['#d9573b', '#ee8f45', '#f2cf68'].includes(x.style));
    expect(flames.map((x) => x.style)).toEqual(['#d9573b', '#ee8f45', '#f2cf68']);
    for (const layer of flames) {
      expect(layer.alpha).toBe(1);
      // Everything on or around the four tiles (x 900..1200, y 1000..1200).
      for (const [x, y] of layer.points) {
        expect(x).toBeGreaterThan(860);
        expect(x).toBeLessThan(1240);
        expect(y).toBeGreaterThan(880);
        expect(y).toBeLessThan(1260);
      }
    }
  });

  it("lights the ground with the campfire light's flat discs, cream at night", () => {
    const fx = new FireEffects(seeded());
    run(fx, fire({ ageMs: 2000 }), 200);
    const day = recording();
    fx.renderGround(day.ctx, wideCamera(), 0, 0);
    expect(day.fills.some((x) => x.style === 'rgb(232,176,112)')).toBe(true);
    const night = recording();
    fx.renderGround(night.ctx, wideCamera(), 0, 1);
    expect(night.fills.some((x) => x.style === 'rgb(248,248,224)')).toBe(true);
  });

  it('draws smoke, embers and glass as flat shapes too', () => {
    const fx = new FireEffects(seeded());
    fx.ignite(fire({ ageMs: 10 }));
    run(fx, fire({ ageMs: 2000 }), 300);
    const { ctx, fills } = recording();
    expect(() => fx.renderTop(ctx, wideCamera(), 0)).not.toThrow();
    expect(fills.length).toBeGreaterThan(2);
  });
});
