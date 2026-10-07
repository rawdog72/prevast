// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// 2D Vector and Trigonometry utilities for the game client.
// NOTE: Clean room implementation; avoid old client's line 1919 Math.acos/asin swap.

export function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function distSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

export function fastDist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x2 - x1) + Math.abs(y2 - y1);
}

export function angle(x1: number, y1: number, x2: number, y2: number): number {
  return Math.atan2(y2 - y1, x2 - x1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

const FRAME_60HZ_MS = 1000 / 60;

/**
 * Rescales a per-frame lerp factor tuned at 60 fps to an arbitrary frame time,
 * so `lerp(a, b, frameLerp(k, delta))` converges at the same rate per second
 * whatever the refresh rate.
 */
export function frameLerp(perFrame: number, deltaMs: number): number {
  return 1 - Math.pow(1 - perFrame, deltaMs / FRAME_60HZ_MS);
}

/**
 * Normalizes rotation target so the difference (to - from) stays within [-PI, PI].
 * Prevents full-circle spins when interpolating angles across the 0 / 2*PI boundary.
 */
export function reduceAngle(from: number, to: number): number {
  const pi2 = Math.PI * 2;
  let diff = (to - from) % pi2;
  if (diff > Math.PI) diff -= pi2;
  else if (diff < -Math.PI) diff += pi2;
  return from + diff;
}
