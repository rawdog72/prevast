// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { Camera } from '../core/camera';
import {
  DAMAGE_NUMBER_LIFE_MS,
  DamageNumbers,
  damageNumberFontPx,
  MAX_DAMAGE_NUMBERS,
} from './damage-numbers';

describe('DamageNumbers (DAMAGE_INDICATOR)', () => {
  it('sizes the text by the share of full health the hit took', () => {
    expect(damageNumberFontPx(0)).toBe(14);
    expect(damageNumberFontPx(20)).toBe(22);
    expect(damageNumberFontPx(100)).toBe(32);
    expect(damageNumberFontPx(255)).toBe(32);
  });

  it('rises and fades over its life, then is dropped', () => {
    const numbers = new DamageNumbers();
    numbers.push(1000, 2000, -12, 10);
    expect(numbers.count).toBe(1);

    const start = numbers.frame(0)!;
    expect(start.text).toBe('-12');
    expect(start.alpha).toBe(1);
    expect(start.rise).toBe(0);

    numbers.update(DAMAGE_NUMBER_LIFE_MS / 2);
    const mid = numbers.frame(0)!;
    expect(mid.rise).toBeGreaterThan(30);
    expect(mid.alpha).toBe(1);

    numbers.update(DAMAGE_NUMBER_LIFE_MS / 2 - 100);
    const late = numbers.frame(0)!;
    expect(late.alpha).toBeGreaterThan(0);
    expect(late.alpha).toBeLessThan(0.5);
    expect(late.rise).toBeLessThanOrEqual(60);

    numbers.update(200);
    expect(numbers.count).toBe(0);
  });

  it('labels heals with a plus and colours them apart from damage', () => {
    const numbers = new DamageNumbers();
    numbers.push(0, 0, 7, 3);
    numbers.push(0, 0, -7, 3);
    expect(numbers.frame(0)!.text).toBe('+7');
    expect(numbers.frame(0)!.fill).not.toBe(numbers.frame(1)!.fill);
  });

  it('alternates a small sideways offset so stacked hits do not overprint', () => {
    const numbers = new DamageNumbers();
    numbers.push(0, 0, -1, 1);
    numbers.push(0, 0, -1, 1);
    numbers.push(0, 0, -1, 1);
    const xs = [0, 1, 2].map((i) => numbers.frame(i)!.dx);
    expect(xs[0]).not.toBe(xs[1]);
    expect(xs[0]).toBe(xs[2]);
  });

  it('caps the live set, dropping the oldest', () => {
    const numbers = new DamageNumbers();
    for (let i = 0; i < MAX_DAMAGE_NUMBERS + 5; i++) numbers.push(i, 0, -1, 1);
    expect(numbers.count).toBe(MAX_DAMAGE_NUMBERS);
    expect(numbers.frame(0)!.x).toBe(5);
  });

  it('draws in screen space above the hit position with the frame alpha', () => {
    const numbers = new DamageNumbers();
    numbers.push(500, 500, -30, 40);
    const camera = new Camera({ viewportWidth: 800, viewportHeight: 600, zoom: 1 });
    camera.update(500, 500);
    const calls: { text: string; x: number; y: number; alpha: number; font: string }[] = [];
    let alpha = 1;
    let font = '';
    const ctx = {
      save() {},
      restore() {},
      set globalAlpha(v: number) {
        alpha = v;
      },
      get globalAlpha() {
        return alpha;
      },
      set font(v: string) {
        font = v;
      },
      get font() {
        return font;
      },
      textAlign: '',
      textBaseline: '',
      lineWidth: 0,
      lineJoin: '',
      strokeStyle: '',
      fillStyle: '',
      strokeText() {},
      fillText(text: string, x: number, y: number) {
        calls.push({ text, x, y, alpha, font });
      },
    } as unknown as CanvasRenderingContext2D;

    numbers.render(ctx, camera);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('-30');
    expect(calls[0]!.font).toContain(`${damageNumberFontPx(40)}px`);
    // Player at the screen centre; the number starts DAMAGE_NUMBER_OFFSET_Y above.
    expect(calls[0]!.y).toBeLessThan(300);
    expect(Math.abs(calls[0]!.x - 400)).toBeLessThanOrEqual(14);
  });
});
