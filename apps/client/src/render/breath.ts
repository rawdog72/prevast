// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/breath.ts
// The old client's idle "breathing" of things on the ground, as pure phase ->
// scale functions: tree tops (_Resources imgTop) swell 2.5 % over a 6 s
// triangle; loot (_Loots) pulses between 95 % and 105 % every 1.5 s. Plus the
// leaf sway when the trunk is hit (hurt2). The renderer feeds a phase built
// from its clock and the entity id so every tree breathes on its own beat.

export const LEAF_BREATH_MS = 6000;
export const LOOT_BREATH_MS = 1500;
export const LEAF_SWAY_MS = 300;

const inQuad = (t: number) => t * t;
const outQuad = (t: number) => t * (2 - t);
const inOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

/** Scale of a tree top `phaseMs` into its cycle: 1.025 at 0, 1.0 at 3000, back to 1.025. */
export function leafBreathScale(phaseMs: number): number {
  const p = ((phaseMs % LEAF_BREATH_MS) + LEAF_BREATH_MS) % LEAF_BREATH_MS;
  const half = LEAF_BREATH_MS / 2;
  return p > half ? 1 + (0.025 * (p - half)) / half : 1 + 0.025 - (0.025 * p) / half;
}

/** Scale of a pickup `phaseMs` into its cycle: 0.95 -> 1.05 -> 0.95, eased. */
export function lootBreathScale(phaseMs: number): number {
  const p = ((phaseMs % LOOT_BREATH_MS) + LOOT_BREATH_MS) % LOOT_BREATH_MS;
  const half = LOOT_BREATH_MS / 2;
  const t = p < half ? p / half : 1 - (p - half) / half;
  return 0.95 + inOutQuad(t) * 0.1;
}

/**
 * Leaf displacement (world units) with `remainingMs` of the 300 ms sway left:
 * out in the first 50 ms, back over the remaining 250. The old code eased the
 * out phase over 250 ms too, which jumped from 0.4 to 10 at the switch -- the
 * continuous version is what it was after.
 */
export function leafSway(remainingMs: number): number {
  if (remainingMs <= 0 || remainingMs >= LEAF_SWAY_MS) return 0;
  return remainingMs > 250
    ? 10 * inQuad((LEAF_SWAY_MS - remainingMs) / 50)
    : 10 * outQuad(remainingMs / 250);
}
