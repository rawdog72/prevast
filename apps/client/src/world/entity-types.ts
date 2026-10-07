// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Typed entity definitions matching server opcodes and wire representation.

export const EntityType = {
  PLAYER: 0,
  LOOT: 1,
  BULLET: 2,
  BUILD_TOP: 3,
  BUILD_DOWN: 4,
  BUILD_GROUND: 5,
  BUILD_GROUND2: 6,
  PARTICLES: 7,
  RES_TOP: 8,
  RES_DOWN: 9,
  RES_MID: 10,
  RES_STOP: 11,
  EXPLOSION: 12,
  AI: 13,
  NPC: 14,
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export interface WorldEntity {
  pid: number;
  id: number;
  type: number;
  rotation: number;
  state: number;
  extra: number;

  /** Current interpolated position and orientation */
  x: number;
  y: number;
  angle: number;

  /** Raw start and end targets from server packets */
  rx: number;
  ry: number;
  nx: number;
  ny: number;
  nangle: number;

  /** Tile grid coordinates (each tile is 100 units) */
  tileX: number;
  tileY: number;

  /** Dead-reckoning speed in world units per ms (wire: (state >> 8) / 100). */
  speed: number;
  /** Visual smoothing factor per 60 fps frame. */
  lerp: number;

  removed: boolean;
  retracted?: boolean;
  updateCount: number;
  stale: number;

  /**
   * One-tick server pulses latched at packet time so a frame that runs late
   * (or a packet pair that lands between two frames) cannot miss them. The
   * animator consumes and clears these.
   */
  attackPulse: boolean;
  hurtPulse: boolean;
  /** Hurt direction in 31 steps around the circle (agents: extra bits 5-9). */
  hurtPulseDir: number;
  /**
   * Buildings: bit 5 of `state` arrived in a packet. On a door that is the
   * server's one-update "could not open" pulse (Object::setOpenFailed); on a
   * station it is the working level, which the animator reads off `state`
   * itself and ignores here.
   */
  failPulse: boolean;
  /** Loot only: ms spent flying to its taker (the magnet pull ramps with it). */
  flightMs: number;
}
