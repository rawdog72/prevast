// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { stripButtonFrame } from './button-frame';
import { decodePng, encodePng, type RgbaImage } from './png';

const SIZE = 40;
const BORDER = 5;

function image(paint: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) data.set(paint(x, y), (y * SIZE + x) * 4);
  return { width: SIZE, height: SIZE, data };
}

const at = (img: RgbaImage, x: number, y: number) =>
  Array.from(img.data.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

/** Porter-Duff over, straight alpha in and out. */
function over(
  top: [number, number, number, number],
  bottom: [number, number, number, number],
): [number, number, number, number] {
  const ta = top[3] / 255;
  const ba = bottom[3] / 255;
  const a = ta + ba * (1 - ta);
  const c = (i: number) => Math.round((top[i] * ta + bottom[i] * ba * (1 - ta)) / a);
  return [c(0), c(1), c(2), Math.round(a * 255)];
}

/** An old-client button: transparent corners, a black border, `fill` inside, `art` over it. */
function button(
  fill: [number, number, number, number],
  art: (x: number, y: number) => [number, number, number, number] | null,
): RgbaImage {
  return image((x, y) => {
    const corner = (x < 2 || x >= SIZE - 2) && (y < 2 || y >= SIZE - 2);
    if (corner) return [0, 0, 0, 0];
    if (x < BORDER || y < BORDER || x >= SIZE - BORDER || y >= SIZE - BORDER) return [0, 0, 0, 255];
    const a = art(x, y);
    return a ? over(a, fill) : fill;
  });
}

const inArt = (x: number, y: number) => x >= 16 && x < 24 && y >= 16 && y < 24;

describe('stripButtonFrame', () => {
  it('removes the border and un-composites a translucent fill exactly', () => {
    const fill: [number, number, number, number] = [219, 201, 57, 99];
    const src = button(fill, (x, y) =>
      inArt(x, y) ? [200, 30, 30, 255] : x === 24 && inArt(23, y) ? [200, 30, 30, 128] : null,
    );
    const out = stripButtonFrame(src)!;
    expect(out).not.toBeNull();
    expect(at(out, 0, 20)[3]).toBe(0); // border
    expect(at(out, BORDER + 3, 20)[3]).toBe(0); // fill
    expect(at(out, 20, 20)).toEqual([200, 30, 30, 255]); // art
    const rim = at(out, 24, 20); // half-covered art pixel, fill tint gone
    expect(rim[3]).toBeGreaterThanOrEqual(126);
    expect(rim[3]).toBeLessThanOrEqual(130);
    expect(Math.abs(rim[0] - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(rim[1] - 30)).toBeLessThanOrEqual(3);
  });

  it('keys a light glyph off an opaque tab-button fill', () => {
    const out = stripButtonFrame(
      button([100, 98, 98, 255], (x, y) => (inArt(x, y) ? [250, 250, 250, 255] : null)),
    )!;
    expect(out).not.toBeNull();
    expect(at(out, BORDER + 3, 20)[3]).toBe(0);
    expect(at(out, 20, 20)[3]).toBe(255);
  });

  it('leaves art without a frame alone', () => {
    const disc = image((x, y) =>
      (x - 20) ** 2 + (y - 20) ** 2 < 14 ** 2 ? [37, 44, 41, 255] : [0, 0, 0, 0],
    );
    expect(stripButtonFrame(disc)).toBeNull();
  });
});

describe('png', () => {
  it('round-trips RGBA', () => {
    const src = image((x, y) => [x * 6, y * 6, (x + y) % 256, (x * y) % 256]);
    const back = decodePng(encodePng(src));
    expect(back.width).toBe(SIZE);
    expect(back.height).toBe(SIZE);
    expect(Array.from(back.data)).toEqual(Array.from(src.data));
  });
});
