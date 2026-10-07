// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// How far the world has turned from the day palette to the night palette.
//
// Dusk and dawn are the two palettes cross-fading -- the old client's
// DAY_TRANSITION_MS fade, stretched from one second to SKY_FADE_MS. Each
// sprite goes from its own day art to its own night art, so what the night
// art keeps bright (lamps, screens, fire) comes up on its own, and the lamp
// and fire glows, which are the same art in both palettes, stay as they are.
// A screen-wide tint was tried and dropped: it darkened those glows too, so
// they dimmed into the dusk and jumped back at the swap.
//
// Dusk ends as the night half begins and dawn starts as the day half does, so
// the look never disagrees with the clock about which half it is. A pure
// function of the phase: joining mid-dusk, the periodic WORLD_TIME correction
// and `!set-daynight` all land on the right look with no fade of their own
// (the old client's "no cross-fade on the login frame").

/** How long dusk fades the night palette in, and dawn fades it out. */
export const SKY_FADE_MS = 30_000;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Opacity of the night palette over the day palette: 0 day, 1 night. */
export function nightAt(phaseMs: number, cycleMs: number): number {
  if (cycleMs < 2) return 0;
  const half = Math.floor(cycleMs / 2);
  const p = ((phaseMs % cycleMs) + cycleMs) % cycleMs;
  if (p >= half) return 1;
  // A short cycle keeps plain day between the two fades.
  const fade = Math.min(SKY_FADE_MS, half / 4);
  if (p < fade) return 1 - smoothstep(p / fade);
  if (p > half - fade) return smoothstep((p - (half - fade)) / fade);
  return 0;
}
