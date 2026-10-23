// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import type { AreaEffectEvent } from '../net/events';
import { CloudKind, CloudLayer, cloudFrame, obscures, smokeHeld, softMask } from './clouds';

function gas(over: Partial<AreaEffectEvent> = {}): AreaEffectEvent {
  return {
    id: 1,
    kind: CloudKind.GAS,
    tileX: 10,
    tileY: 10,
    growMs: 2000,
    holdMs: 4000,
    fadeMs: 1000,
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

/** Counts the circles drawn and where. */
function recordingContext() {
  const centres: Array<[number, number]> = [];
  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    fill: () => {},
    arc: (x: number, y: number) => centres.push([x, y]),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '' as unknown,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, centres };
}

function wideCamera(): Camera {
  const camera = new Camera({ viewportWidth: 8000, viewportHeight: 8000 });
  camera.x = 1000;
  camera.y = 1000;
  return camera;
}

describe('cloudFrame', () => {
  it('uncovers tiles in order over growMs, then holds them all', () => {
    const c = gas();
    expect(cloudFrame({ ...c, ageMs: 0 }).covered).toBe(1);
    expect(cloudFrame({ ...c, ageMs: 500 }).covered).toBe(1);
    expect(cloudFrame({ ...c, ageMs: 1000 }).covered).toBe(2);
    expect(cloudFrame({ ...c, ageMs: 1999 }).covered).toBe(4);
    expect(cloudFrame({ ...c, ageMs: 5000 })).toEqual({ covered: 4, opacity: 1 });
  });

  it('matches the server: the first ceil(n * age / grow) tiles are covered', () => {
    const c = gas();
    for (const age of [1, 499, 501, 1000, 1001, 1500, 1501]) {
      expect(cloudFrame({ ...c, ageMs: age }).covered).toBe(Math.max(1, Math.ceil((4 * age) / 2000)));
    }
  });

  it('thins out over fadeMs', () => {
    const c = gas();
    expect(cloudFrame({ ...c, ageMs: 6500 }).opacity).toBeCloseTo(0.5);
    expect(cloudFrame({ ...c, ageMs: 7000 }).opacity).toBe(0);
  });
});

describe('CloudLayer', () => {
  it('draws the covered tiles where the server put them', () => {
    const layer = new CloudLayer();
    layer.apply(gas({ ageMs: 3000 }));
    const { ctx, centres } = recordingContext();
    layer.render(ctx, wideCamera(), 0);
    expect(centres).toHaveLength(4);
    // Tile (10, 10) is centred on (1050, 1050), give or take the drift.
    expect(Math.abs(centres[0][0] - 1050)).toBeLessThanOrEqual(12);
    expect(Math.abs(centres[0][1] - 1050)).toBeLessThanOrEqual(12);
  });

  it('is gone once grown, held and faded, with no removal message', () => {
    const layer = new CloudLayer();
    layer.apply(gas());
    layer.update(6999);
    expect(layer.count).toBe(1);
    layer.update(2);
    expect(layer.count).toBe(0);
  });

  it('takes a restated age only when it has drifted, and keeps its own clock otherwise', () => {
    const layer = new CloudLayer();
    layer.apply(gas({ ageMs: 0 }));
    layer.update(2000);
    layer.apply(gas({ ageMs: 2100 })); // within slack: ignored
    const draw = () => {
      const { ctx, centres } = recordingContext();
      layer.render(ctx, wideCamera(), 0);
      return centres.length;
    };
    expect(draw()).toBe(4);
    layer.apply(gas({ ageMs: 6900 })); // far off: adopted
    layer.update(200);
    expect(layer.count).toBe(0);
  });

  it('shows a player who walks into view a cloud that is already half grown', () => {
    const layer = new CloudLayer();
    layer.apply(gas({ ageMs: 1000 }));
    const { ctx, centres } = recordingContext();
    layer.render(ctx, wideCamera(), 0);
    expect(centres).toHaveLength(2);
  });

  it('replaces a cloud whose id the server has reused elsewhere', () => {
    const layer = new CloudLayer();
    layer.apply(gas({ ageMs: 3000 }));
    layer.apply(gas({ tileX: 50, ageMs: 3000, cells: [[0, 0]] }));
    const { ctx, centres } = recordingContext();
    layer.render(ctx, wideCamera(), 0);
    expect(centres).toHaveLength(1);
    expect(Math.abs(centres[0][0] - 5050)).toBeLessThanOrEqual(12);
  });
});

/** Records what a smoke render does: colour stops, mask rectangles and how it filled. */
function smokeContext(transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  const stops: string[] = [];
  const rects: number[][] = [];
  const fills: Array<string | undefined> = [];
  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    fill: (rule?: string) => fills.push(rule),
    arc: () => {},
    rect: () => {},
    fillRect: (...r: number[]) => rects.push(r),
    getTransform: () => transform,
    setTransform: () => {},
    createRadialGradient: () => ({ addColorStop: (_o: number, c: string) => stops.push(c) }),
    fillStyle: '' as unknown,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, stops, rects, fills };
}

function smoke(over: Partial<AreaEffectEvent> = {}): AreaEffectEvent {
  return gas({ kind: CloudKind.SMOKE, growMs: 0, holdMs: 10000, fadeMs: 2000, ageMs: 1000, ...over });
}

function peakAlpha(stops: string[]): number {
  return Math.max(...stops.map((c) => Number(c.slice(c.lastIndexOf(',') + 1, -1))));
}

/** Total area of the rectangles, and whether any two overlap. */
function coverage(rects: number[][]): { area: number; overlaps: boolean } {
  let area = 0;
  let overlaps = false;
  rects.forEach(([x, y, w, h], i) => {
    area += w * h;
    for (const [x2, y2, w2, h2] of rects.slice(i + 1)) {
      if (x < x2 + w2 && x2 < x + w && y < y2 + h2 && y2 < y + h) overlaps = true;
    }
  });
  return { area, overlaps };
}

/** Whether device point (px, py) is under one of the rectangles. */
function covered(rects: number[][], px: number, py: number): boolean {
  return rects.some(([x, y, w, h]) => px >= x && px < x + w && py >= y && py < y + h);
}

describe('smoke', () => {
  it('hides until half faded, like the server', () => {
    const s = smoke();
    expect(obscures({ ...s, ageMs: 10999 })).toBe(true);
    expect(obscures({ ...s, ageMs: 11000 })).toBe(false);
    expect(obscures({ ...gas(), ageMs: 0 })).toBe(false);
  });

  it('is thick from outside and thin from inside', () => {
    const outside = new CloudLayer();
    outside.apply(smoke());
    const far = smokeContext();
    outside.render(far.ctx, wideCamera(), 0, { x: 300, y: 300 });
    const near = smokeContext();
    outside.render(near.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(peakAlpha(far.stops)).toBeGreaterThan(0.8);
    expect(peakAlpha(near.stops)).toBeLessThan(0.35);
  });

  it('darkens everything but the smoke while you stand in it', () => {
    const layer = new CloudLayer();
    layer.apply(smoke());
    expect(layer.inSmoke(1050, 1050)).toBe(true);
    expect(layer.inSmoke(300, 300)).toBe(false);

    const inside = smokeContext();
    layer.render(inside.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    // Plain rectangles, no even-odd path to rasterise.
    expect(inside.fills).not.toContain('evenodd');
    // The smoke tiles -- (10,10), (11,10), (10,11), (9,10) -- are the holes...
    for (const [tx, ty] of [[10, 10], [11, 10], [10, 11], [9, 10]]) {
      expect(covered(inside.rects, tx * 100 + 50, ty * 100 + 50)).toBe(false);
    }
    // ...and everything else is dark: the clear corners of the box, and far out.
    for (const [px, py] of [[950, 1150], [1150, 1150], [950, 950], [-5000, 1050], [1050, 9000]]) {
      expect(covered(inside.rects, px, py)).toBe(true);
    }
    // Exactly the reach square minus the four smoke tiles, each pixel once.
    const { area, overlaps } = coverage(inside.rects);
    expect(overlaps).toBe(false);
    expect(area).toBe(16000 * 16000 - 4 * 100 * 100);

    const outside = smokeContext();
    layer.render(outside.ctx, wideCamera(), 0, { x: 300, y: 300 });
    expect(outside.rects).toHaveLength(0);
  });

  it('snaps the mask to whole device pixels, so neighbouring rectangles meet without a seam', () => {
    const layer = new CloudLayer();
    layer.apply(smoke());
    // A zoom and offset that put tile edges between pixels.
    const inside = smokeContext({ a: 1.37, b: 0, c: 0, d: 1.37, e: -803.3, f: -611.9 });
    layer.render(inside.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    for (const r of inside.rects) for (const v of r) expect(Number.isInteger(v)).toBe(true);
    expect(coverage(inside.rects).overlaps).toBe(false);
  });

  it('works the smoke cover out again only when it changes', () => {
    const layer = new CloudLayer();
    layer.apply(smoke({ growMs: 2000, ageMs: 0 }));
    const cover = () => (layer as unknown as { smokeCover(): object }).smokeCover();
    const first = cover();
    expect(cover()).toBe(first); // same frame, same cover
    layer.update(1000); // grown to two tiles
    const grown = cover();
    expect(grown).not.toBe(first);
    expect(layer.inSmoke(1150, 1050)).toBe(true);
    layer.update(5000); // fully out and holding
    const held = cover();
    layer.update(16);
    expect(cover()).toBe(held);
  });

  it('does not mask for gas, nor once the smoke has thinned', () => {
    const gasLayer = new CloudLayer();
    gasLayer.apply(gas({ ageMs: 3000 }));
    const inGas = smokeContext();
    gasLayer.render(inGas.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(inGas.rects).toHaveLength(0);

    const thin = new CloudLayer();
    thin.apply(smoke({ ageMs: 11500 }));
    const late = smokeContext();
    thin.render(late.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(late.rects).toHaveLength(0);
  });
});

describe('fire', () => {
  function fire(over: Partial<AreaEffectEvent> = {}): AreaEffectEvent {
    return gas({ kind: CloudKind.FIRE, growMs: 600, holdMs: 8000, fadeMs: 1500, ageMs: 2000, ...over });
  }

  it('leaves its drawing to the fire effects: no puffs, but flames on the ground', () => {
    const layer = new CloudLayer(() => null);
    layer.apply(fire());
    const { ctx, centres } = recordingContext();
    layer.render(ctx, wideCamera(), 0);
    expect(centres).toHaveLength(0);
    for (let i = 0; i < 30; i++) layer.update(16);
    expect(layer.fire.flameCount).toBeGreaterThan(0);
  });

  it('plays a bottle breaking when the server feeds a fire another molotov', () => {
    const layer = new CloudLayer(() => null);
    layer.apply(fire({ ageMs: 4000 }));
    expect(layer.fire.lastShatter).toBeNull();
    // Same id, clock wound back to the end of its growth: a merge, not drift.
    layer.apply(fire({ ageMs: 600 }));
    expect(layer.fire.lastShatter).not.toBeNull();
    // A merge that also added tiles is still the same fire, and still a bottle.
    layer.fire.lastShatter = null;
    for (let i = 0; i < 100; i++) layer.update(16);
    layer.apply(fire({ ageMs: 600, cells: [[0, 0], [1, 0], [0, 1], [-1, 0], [2, 0]] }));
    expect(layer.fire.lastShatter).not.toBeNull();
    expect(layer.count).toBe(1);
  });

  it('takes a small restated drift quietly', () => {
    const layer = new CloudLayer(() => null);
    layer.apply(fire({ ageMs: 4000 }));
    layer.apply(fire({ ageMs: 3900 }));
    expect(layer.fire.lastShatter).toBeNull();
  });

  it('never masks the screen: fire is not smoke', () => {
    const layer = new CloudLayer();
    layer.apply(fire());
    expect(layer.inSmoke(1050, 1050)).toBe(false);
  });
});

describe('puff bitmaps', () => {
  /** A canvas whose context counts the gradients drawn on it. */
  function fakeCanvasFactory() {
    let made = 0;
    let gradients = 0;
    const factory = () => {
      made++;
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createRadialGradient: () => {
            gradients++;
            return { addColorStop: () => {} };
          },
          fillRect: () => {},
          fillStyle: '' as unknown,
        }),
      } as unknown as HTMLCanvasElement;
    };
    return { factory, made: () => made, gradients: () => gradients };
  }

  /** Records drawImage calls: centre, radius and the alpha they were drawn at. */
  function imageContext() {
    const draws: Array<{ x: number; y: number; r: number; alpha: number }> = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      globalAlpha: 1,
      drawImage(_img: unknown, x: number, y: number, w: number) {
        draws.push({ x: x + w / 2, y: y + w / 2, r: w / 2, alpha: this.globalAlpha });
      },
      createRadialGradient: () => {
        throw new Error('built a gradient per frame');
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
  }

  it('makes one bitmap per kind and draws every puff from it, never a gradient per frame', () => {
    const canvases = fakeCanvasFactory();
    const layer = new CloudLayer(canvases.factory);
    layer.apply(smoke());
    layer.apply(gas({ id: 2, tileX: 30, ageMs: 3000 }));
    for (let frame = 0; frame < 5; frame++) {
      const { ctx, draws } = imageContext();
      layer.render(ctx, wideCamera(), frame * 16, { x: 300, y: 300 });
      expect(draws).toHaveLength(8);
    }
    expect(canvases.made()).toBe(2);
    expect(canvases.gradients()).toBe(2);
  });

  it('draws puffs where the server put them, thick from outside and thin from inside', () => {
    const layer = new CloudLayer(fakeCanvasFactory().factory);
    layer.apply(smoke());
    const far = imageContext();
    layer.render(far.ctx, wideCamera(), 0, { x: 300, y: 300 });
    expect(Math.abs(far.draws[0].x - 1050)).toBeLessThanOrEqual(12);
    expect(Math.abs(far.draws[0].y - 1050)).toBeLessThanOrEqual(12);
    expect(Math.max(...far.draws.map((d) => d.alpha))).toBeCloseTo(0.85);

    const near = imageContext();
    (near.ctx as unknown as { fillRect: () => void }).fillRect = () => {};
    layer.render(near.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(Math.max(...near.draws.map((d) => d.alpha))).toBeCloseTo(0.3);
  });

});

describe('smoke fading from the edge in', () => {
  // Four tiles, no growth, holds to 10000, fades 10000..12000: hides until 11000.
  const s = () => smoke();

  it('gives its tiles back last-grown first over the first half of the fade', () => {
    expect(smokeHeld({ ...s(), ageMs: 9999 })).toBe(4);
    expect(smokeHeld({ ...s(), ageMs: 10000 })).toBe(4);
    expect(smokeHeld({ ...s(), ageMs: 10250 })).toBe(3);
    expect(smokeHeld({ ...s(), ageMs: 10500 })).toBe(2);
    expect(smokeHeld({ ...s(), ageMs: 10999 })).toBe(1);
    expect(smokeHeld({ ...s(), ageMs: 11000 })).toBe(0);
  });

  it('matches the server: ceil(n * left / half), whole ms of half', () => {
    // fadeMs 2001: the server's half is 1000, not 1000.5.
    const odd = smoke({ fadeMs: 2001 });
    for (let age = 10000; age < 11000; age += 37) {
      expect(smokeHeld({ ...odd, ageMs: age })).toBe(Math.max(1, Math.ceil((4 * (11000 - age)) / 1000)));
    }
    expect(smokeHeld({ ...odd, ageMs: 11000 })).toBe(0);
    expect(obscures({ ...odd, ageMs: 11000 })).toBe(false);
  });

  it('is nothing for gas or fire', () => {
    expect(smokeHeld({ ...gas(), ageMs: 3000 })).toBe(0);
  });

  it('shrinks the cover, and with it the dark mask, as it thins', () => {
    const layer = new CloudLayer();
    layer.apply(smoke({ ageMs: 10600 })); // two tiles left: (10,10) and (11,10)
    expect(layer.inSmoke(1050, 1050)).toBe(true);
    expect(layer.inSmoke(1150, 1050)).toBe(true);
    expect(layer.inSmoke(1050, 1150)).toBe(false); // (10,11), given back
    expect(layer.inSmoke(950, 1050)).toBe(false); // (9,10), given back first

    const inside = smokeContext();
    layer.render(inside.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(coverage(inside.rects).area).toBe(16000 * 16000 - 2 * 100 * 100);
  });

  it('draws each tile thinner as it nears its release, and under half once released', () => {
    const alphas = (ageMs: number) => {
      const layer = new CloudLayer();
      layer.apply(smoke({ ageMs }));
      const { ctx, stops } = smokeContext();
      layer.render(ctx, wideCamera(), 0, { x: 300, y: 300 });
      // One peak per drawn puff, in growth order (three stops each).
      const peaks: number[] = [];
      for (let i = 0; i < stops.length; i += 3) peaks.push(Number(stops[i].slice(stops[i].lastIndexOf(',') + 1, -1)));
      return peaks;
    };
    expect(alphas(9000)).toEqual([0.85, 0.85, 0.85, 0.85]);
    const thinning = alphas(10600);
    // Tiles 0 and 1 still hide: drawn at more than half. 2 and 3 are released.
    expect(thinning[0]).toBeGreaterThan(0.85 / 2);
    expect(thinning[1]).toBeGreaterThan(0.85 / 2);
    for (const a of thinning.slice(2)) expect(a).toBeLessThan(0.85 / 2);
    // The middle is the last to go.
    expect(thinning[0]).toBeGreaterThanOrEqual(thinning[1]);
    // Well after the last release everything is gone, ahead of the cloud's end.
    expect(alphas(11600)).toEqual([]);
  });
});

describe('the soft edge of the mask', () => {
  const key = (tx: number, ty: number) => (tx + 0x8000) * 0x10000 + (ty + 0x8000);
  /** A 5 x 5 block of smoke tiles at (10..14, 20..24). */
  function block() {
    const tiles = new Set<number>();
    for (let y = 20; y < 25; y++) for (let x = 10; x < 15; x++) tiles.add(key(x, y));
    return softMask({ tiles, minX: 10, minY: 20, maxX: 14, maxY: 24 });
  }
  /** Alpha at a point given in tiles. */
  const alphaAt = (m: ReturnType<typeof softMask>, tx: number, ty: number) => {
    const ppt = m.width / m.tilesW;
    const px = Math.floor((tx - m.tileX) * ppt);
    const py = Math.floor((ty - m.tileY) * ppt);
    return m.data[(py * m.width + px) * 4 + 3];
  };
  const FULL = Math.round(255 * 0.94);

  it('is fully dark on every tile that is not smoke -- never a lit band outside it', () => {
    const m = block();
    const ppt = m.width / m.tilesW;
    for (let py = 0; py < m.height; py++) {
      for (let px = 0; px < m.width; px++) {
        const tx = m.tileX + Math.floor(px / ppt);
        const ty = m.tileY + Math.floor(py / ppt);
        const smoke = tx >= 10 && tx < 15 && ty >= 20 && ty < 25;
        if (!smoke) expect(m.data[(py * m.width + px) * 4 + 3]).toBe(FULL);
      }
    }
  });

  it('is still all but fully dark just inside the edge, and clear in the middle', () => {
    const m = block();
    expect(alphaAt(m, 10.04, 22.5)).toBeGreaterThan(FULL * 0.95);
    expect(alphaAt(m, 12.5, 20.04)).toBeGreaterThan(FULL * 0.95);
    expect(alphaAt(m, 12.5, 22.5)).toBe(0);
    expect(alphaAt(m, 11.5, 21.5)).toBe(0);
  });

  it('ramps rather than steps, and rounds the corners', () => {
    const m = block();
    // Along a row from the left edge into the middle: never lighter going out,
    // and no jump bigger than a smooth ramp makes.
    let last = 255;
    for (let x = 10.05; x < 12.5; x += 0.1) {
      const a = alphaAt(m, x, 22.5);
      expect(a).toBeLessThanOrEqual(last);
      expect(last - a).toBeLessThan(90);
      last = a;
    }
    // A corner is darker than the middle of an edge at the same depth.
    expect(alphaAt(m, 10.35, 20.35)).toBeGreaterThan(alphaAt(m, 10.35, 22.5));
  });

  /** A canvas that counts the times its pixels are rewritten. */
  function canvases() {
    let puts = 0;
    const factory = () =>
      ({
        width: 0,
        height: 0,
        getContext: () => ({
          createRadialGradient: () => ({ addColorStop: () => {} }),
          fillRect: () => {},
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: () => puts++,
          fillStyle: '' as unknown,
        }),
      }) as unknown as HTMLCanvasElement;
    return { factory, puts: () => puts };
  }

  /** Records the mask: rectangles and images, with the alpha each was drawn at. */
  function maskContext() {
    const rects: number[][] = [];
    const images: number[][] = [];
    const alphas: number[] = [];
    const ctx = {
      save: () => {},
      restore: () => {},
      globalAlpha: 1,
      imageSmoothingEnabled: false,
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      setTransform: () => {},
      fillRect(...r: number[]) {
        rects.push(r);
        alphas.push(this.globalAlpha);
      },
      drawImage(img: { width: number }, ...r: number[]) {
        // Puffs are SPRITE_SIZE (128) square; the mask is not.
        if (img.width !== 128) images.push(r);
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, images, alphas };
  }

  it('draws the bitmap over the smoke and plain dark around it, meeting without overlap', () => {
    const c = canvases();
    const layer = new CloudLayer(c.factory);
    layer.apply(smoke());
    const m = maskContext();
    layer.render(m.ctx, wideCamera(), 0, { x: 1050, y: 1050 });
    expect(m.images).toHaveLength(1);
    const all = [...m.rects, m.images[0]];
    expect(coverage(all).overlaps).toBe(false);
    expect(coverage(all).area).toBe(16000 * 16000);
  });

  it('redraws the bitmap only when the smoke cover changes', () => {
    const c = canvases();
    const layer = new CloudLayer(c.factory);
    layer.apply(smoke());
    for (let t = 0; t < 10; t++) layer.render(maskContext().ctx, wideCamera(), t * 16, { x: 1050, y: 1050 });
    expect(c.puts()).toBe(1);
    layer.update(10600 - 1000); // two tiles given back
    layer.render(maskContext().ctx, wideCamera(), 200, { x: 1050, y: 1050 });
    expect(c.puts()).toBe(2);
  });

  it('comes down over a moment as you step in, and lifts as you step out', () => {
    const layer = new CloudLayer(canvases().factory);
    layer.apply(smoke());
    const at = (timeMs: number, viewer: { x: number; y: number }) => {
      const m = maskContext();
      layer.render(m.ctx, wideCamera(), timeMs, viewer);
      return m.alphas.length ? Math.max(...m.alphas) : 0;
    };
    const outside = { x: 300, y: 300 };
    const inside = { x: 1050, y: 1050 };
    expect(at(1000, outside)).toBe(0);
    const early = at(1016, inside);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.2);
    expect(at(1100, inside)).toBeLessThan(1);
    expect(at(1300, inside)).toBe(1);
    const leaving = at(1316, outside);
    expect(leaving).toBeGreaterThan(0.8);
    expect(leaving).toBeLessThan(1);
    expect(at(1600, outside)).toBe(0);
  });
});
