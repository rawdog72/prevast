// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/ui-scale.ts
// How big the DOM HUD draws. The old client's canvas HUD scaled with the
// window (scaleby = the 1280x880 view fitted to the window), so a big screen
// got a big HUD; ours is DOM at CSS px, so the fit is computed here and
// applied as CSS `zoom` per region (hud.css reads the --hud-z-* properties).
// On top of the fit the player picks a global HUD size and one per region in
// Options; both persist in localStorage (`prevast.ui-scale`).

/** The old client's view the fit is 1.0 at. */
const FIT_VIEW_W = 1280;
const FIT_VIEW_H = 880;
const FIT_MIN = 0.7;
const FIT_MAX = 1.6;

export const UI_SCALE_MIN = 0.6;
export const UI_SCALE_MAX = 2.0;
export const UI_SCALE_STEP = 0.1;

export const UI_SCALE_REGIONS = [
  'hud',
  'inventory',
  'vitals',
  'minimap',
  'leaderboard',
  'windows',
  'chat',
  'notices',
] as const;
export type UiScaleRegion = (typeof UI_SCALE_REGIONS)[number];
export type UiScaleSettings = Record<UiScaleRegion, number>;

export const DEFAULT_UI_SCALE: Readonly<UiScaleSettings> = Object.freeze({
  hud: 1,
  inventory: 1,
  vitals: 1,
  minimap: 1,
  leaderboard: 1,
  windows: 1,
  chat: 1,
  notices: 1,
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Base scale for a window: the tighter axis against the 1280x880 view, clamped. */
export function fitScale(width: number, height: number): number {
  const fit = Math.min(width / FIT_VIEW_W, height / FIT_VIEW_H);
  return clamp(Number.isFinite(fit) ? fit : 1, FIT_MIN, FIT_MAX);
}

/** One notch up or down for a region, snapped to the step so values stay round. */
export function stepUiScale(
  settings: UiScaleSettings,
  region: UiScaleRegion,
  direction: 1 | -1,
): UiScaleSettings {
  const steps = Math.round(settings[region] / UI_SCALE_STEP) + direction;
  const value = clamp(Math.round(steps * UI_SCALE_STEP * 100) / 100, UI_SCALE_MIN, UI_SCALE_MAX);
  return { ...settings, [region]: value };
}

export function serializeUiScale(settings: UiScaleSettings): string {
  return JSON.stringify(settings);
}

/** Defaults for anything missing, non-numeric or out of range. */
export function parseUiScale(json: string | null): UiScaleSettings {
  const out: UiScaleSettings = { ...DEFAULT_UI_SCALE };
  if (!json) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const region of UI_SCALE_REGIONS) {
    const v = (raw as Record<string, unknown>)[region];
    if (typeof v === 'number' && v >= UI_SCALE_MIN && v <= UI_SCALE_MAX) out[region] = v;
  }
  return out;
}

/** The zoom each region root gets: fit x HUD, then x the region's own scale. */
export function effectiveUiScale(settings: UiScaleSettings, fit: number): UiScaleSettings {
  // Rounded so 0.7 x 1.1 lands as 0.77, not 0.7700000000000001, in the CSS.
  const hud = round4(fit * settings.hud);
  const out = { ...settings, hud };
  for (const region of UI_SCALE_REGIONS) {
    if (region !== 'hud') out[region] = round4(hud * settings[region]);
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Writes the effective scales as --hud-z-<region> on each root (hud.css applies them as zoom). */
export function applyUiScale(roots: Iterable<HTMLElement>, effective: UiScaleSettings): void {
  for (const root of roots) {
    for (const region of UI_SCALE_REGIONS) {
      root.style.setProperty(`--hud-z-${region}`, String(effective[region]));
    }
  }
}
