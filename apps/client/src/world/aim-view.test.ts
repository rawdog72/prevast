// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aimOf,
  aimedView,
  aimedZoom,
  describeView,
  effectiveView,
  isStrong,
  scopeOutline,
  type Offset,
  type StrongViewDef,
  type ViewDef,
} from './aim-view';
import { MODS_IID, modsContent } from './weapon-mods.fixtures';

interface ViewCase {
  name: string;
  view: ViewDef | null;
  viewX: number;
  viewY: number;
  angleDeg: number;
  expect: {
    minDX: number;
    maxDX: number;
    minDY: number;
    maxDY: number;
    offX: number;
    offY: number;
  };
}
interface ShapeCase {
  name: string;
  view: StrongViewDef;
  angleDeg: number;
  points: { at: [number, number]; inner: boolean; outer: boolean; why: string }[];
}
const fixture = JSON.parse(readFileSync('tests/fixtures/weapon-mods/view-cases.json', 'utf8')) as {
  cases: ViewCase[];
  shapeCases: ShapeCase[];
};

describe('aimedView (tests/fixtures/weapon-mods/view-cases.json, shared with the C++ self-test)', () => {
  it.each(fixture.cases)('$name', (c) => {
    // The same expression as aim_view_selftest.cpp, so both compute the same angle.
    const v = aimedView(c.view, c.viewX, c.viewY, (c.angleDeg * Math.PI) / 180);
    expect({ ...v.box, offX: v.offX, offY: v.offY }).toEqual(c.expect);
  });
});

describe('the view a held gun shows', () => {
  const content = modsContent();
  it('is the fitted optic`s view, or none', () => {
    expect(effectiveView(content, MODS_IID.gun, [])).toBeNull();
    expect(effectiveView(content, MODS_IID.gun, [{ slot: 1, iid: MODS_IID.scope }])).toEqual({
      shape: 'shift',
      ahead: 450,
      zoom: 0.85,
      extend: 500,
    });
  });
  it('is the gun`s own built-in view when no optic gives one', () => {
    const view = effectiveView(content, MODS_IID.sniper, []);
    expect(isStrong(view)).toBe(true);
    expect(view).toMatchObject({ shape: 'rect', length: 1900, rearRadius: 250 });
  });
  it('knows which guns can aim', () => {
    expect(aimOf(content, MODS_IID.gun, [])).not.toBeNull();
    expect(aimOf(content, MODS_IID.bandage, [])).toBeNull();
  });
});

/** Ray casting: whether (x, y) is inside the polygon. */
function inside(poly: readonly Offset[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

describe('scopeOutline (view-cases.json shapeCases, shared with the C++ self-test)', () => {
  it.each(fixture.shapeCases)('$name: the lit area is the inner shape and the rear circle', (c) => {
    // The same expression as aim_view_selftest.cpp, so both compute the same angle.
    const outline = scopeOutline(c.view, (c.angleDeg * Math.PI) / 180);
    for (const p of c.points) {
      const [x, y] = p.at;
      const lit = inside(outline, x, y) || Math.hypot(x, y) <= c.view.rearRadius;
      expect(lit, `${p.why} (${x}, ${y})`).toBe(p.inner);
    }
  });

  it('puts a rect`s corners at its back and length, half its width either side', () => {
    const rect = { shape: 'rect', length: 1900, width: 500, back: 100, zoom: 0.55, rearRadius: 250 } as const;
    expect(scopeOutline(rect, 0).map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([
      [-100, -250],
      [1900, -250],
      [1900, 250],
      [-100, 250],
    ]);
    // Left out, back is 0. (toBeCloseTo: a corner on the player can come out as -0.)
    const noBack = { shape: 'rect', length: 1900, width: 500, zoom: 0.55, rearRadius: 250 } as const;
    expect(scopeOutline(noBack, 0)[0]!.x).toBeCloseTo(0, 9);
  });
});

describe('aimedZoom', () => {
  const weak: ViewDef = { shape: 'shift', ahead: 450, zoom: 0.85, extend: 500 };
  const strong: ViewDef = { shape: 'rect', length: 1900, width: 500, back: 100, zoom: 0.55, rearRadius: 250 };
  it('leaves the player`s zoom alone without a view or before the blend starts', () => {
    expect(aimedZoom(1.3, null, 1, 0.5)).toBe(1.3);
    expect(aimedZoom(1.3, strong, 0, 0.5)).toBe(1.3);
  });
  it('multiplies by a weak view`s zoom, never past the furthest zoom', () => {
    expect(aimedZoom(1, weak, 1, 0.5)).toBeCloseTo(0.85, 9);
    expect(aimedZoom(0.5, weak, 1, 0.5)).toBe(0.5);
    expect(aimedZoom(1, weak, 0.5, 0.5)).toBeCloseTo(0.925, 9);
  });
  it('replaces the zoom with a strong view`s own, past the furthest zoom too', () => {
    expect(aimedZoom(2, strong, 1, 0.5)).toBeCloseTo(0.55, 9);
    expect(aimedZoom(0.5, { ...strong, zoom: 0.4 } as ViewDef, 1, 0.5)).toBeCloseTo(0.4, 9);
    expect(aimedZoom(1, strong, 0.5, 0.5)).toBeCloseTo(0.775, 9);
  });
});

describe('describeView', () => {
  it('says what each kind of view does', () => {
    expect(describeView(null)).toBe('Standard aimed view.');
    expect(describeView({ shape: 'shift', ahead: 450, zoom: 0.85, extend: 500 })).toBe(
      'View shifts forward; rear coverage is reduced. Look ahead 450 · camera ×0.85.',
    );
    expect(describeView({ shape: 'stretch', ahead: 250, zoom: 0.95, extend: 250 })).toBe(
      'View extends forward; rear coverage is preserved. Look ahead 250 · camera ×0.95.',
    );
    expect(
      describeView({ shape: 'rect', length: 1900, width: 500, back: 100, zoom: 0.55, rearRadius: 250 }),
    ).toBe('Scope view: 1900 ahead, 500 wide. Only that and 250 around you are shown. Camera fixed at ×0.55.');
    expect(
      describeView({ shape: 'cone', reach: 1500, halfAngleDeg: 20, zoom: 0.7, rearRadius: 250 }),
    ).toBe('Scope view: a 40° cone reaching 1500. Only that and 250 around you are shown. Camera fixed at ×0.70.');
  });
});
