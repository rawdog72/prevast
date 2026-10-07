// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_SCALE,
  UI_SCALE_REGIONS,
  applyUiScale,
  effectiveUiScale,
  fitScale,
  parseUiScale,
  serializeUiScale,
  stepUiScale,
} from './ui-scale';

describe('fitScale (the old client scaled its HUD with the window: 1.0 at 1280x880)', () => {
  it('is 1 at the old client view and follows the tighter axis', () => {
    expect(fitScale(1280, 880)).toBe(1);
    expect(fitScale(1920, 1080)).toBeCloseTo(1080 / 880, 5);
    expect(fitScale(1280, 1600)).toBe(1);
  });

  it('is clamped so a tiny or huge window never makes the HUD unusable', () => {
    expect(fitScale(640, 400)).toBe(0.7);
    expect(fitScale(3840, 2160)).toBe(1.6);
    expect(fitScale(0, 0)).toBe(0.7);
  });
});

describe('stepUiScale', () => {
  it('moves one 10% notch, snapped to the step, clamped to 60%..200%', () => {
    expect(stepUiScale(DEFAULT_UI_SCALE, 'inventory', 1).inventory).toBeCloseTo(1.1, 9);
    expect(stepUiScale({ ...DEFAULT_UI_SCALE, vitals: 0.65 }, 'vitals', -1).vitals).toBeCloseTo(
      0.6,
      9,
    );
    expect(stepUiScale({ ...DEFAULT_UI_SCALE, hud: 2.0 }, 'hud', 1).hud).toBe(2.0);
    expect(stepUiScale({ ...DEFAULT_UI_SCALE, hud: 0.6 }, 'hud', -1).hud).toBe(0.6);
  });

  it('returns a new object and leaves the other regions alone', () => {
    const next = stepUiScale(DEFAULT_UI_SCALE, 'minimap', 1);
    expect(next).not.toBe(DEFAULT_UI_SCALE);
    expect(DEFAULT_UI_SCALE.minimap).toBe(1);
    for (const r of UI_SCALE_REGIONS) if (r !== 'minimap') expect(next[r]).toBe(1);
  });
});

describe('parseUiScale / serializeUiScale (the prevast.ui-scale localStorage value)', () => {
  it('round-trips every region', () => {
    const s = { ...DEFAULT_UI_SCALE, inventory: 1.3, windows: 0.8 };
    expect(parseUiScale(serializeUiScale(s))).toEqual(s);
  });

  it('falls back to the defaults for a missing, broken or out-of-range value', () => {
    expect(parseUiScale(null)).toEqual(DEFAULT_UI_SCALE);
    expect(parseUiScale('not json')).toEqual(DEFAULT_UI_SCALE);
    expect(parseUiScale('[1,2]')).toEqual(DEFAULT_UI_SCALE);
    expect(parseUiScale('{"inventory":"big","vitals":9,"minimap":1.2}')).toEqual({
      ...DEFAULT_UI_SCALE,
      minimap: 1.2,
    });
  });
});

describe('effectiveUiScale', () => {
  it('multiplies the window fit by the HUD scale, then by the region scale', () => {
    const eff = effectiveUiScale({ ...DEFAULT_UI_SCALE, hud: 1.5, inventory: 1.2 }, 0.8);
    expect(eff.hud).toBeCloseTo(1.2, 9);
    expect(eff.inventory).toBeCloseTo(1.44, 9);
    expect(eff.vitals).toBeCloseTo(1.2, 9);
  });
});

describe('applyUiScale', () => {
  it('writes one --hud-z-<region> custom property per region on every root', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    applyUiScale([a, b], { ...DEFAULT_UI_SCALE, inventory: 1.25, hud: 0.75 });
    expect(a.style.getPropertyValue('--hud-z-inventory')).toBe('1.25');
    expect(a.style.getPropertyValue('--hud-z-hud')).toBe('0.75');
    expect(b.style.getPropertyValue('--hud-z-vitals')).toBe('1');
  });
});
