// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/building-animator.ts
// Per-structure animation clocks for buildings and resources, mirroring the
// old client's _Buildings / _Resources renderers: the hurt knock (server pulses
// bit 1 of `state`), door swing and lid/in-use progress, lit and working
// ramps, growth-stage cross-fades and the destruction fade. The renderer reads
// these and draws; nothing here touches the canvas.

import { EntityType, type WorldEntity } from '../world/entity-types';
import type { WorldState } from '../world/world-state';

export const STRUCTURE_HURT_MS = 250;
/** The tree top's sway after a blow (old hurt2): a little longer than the trunk knock. */
export const TOP_HURT_MS = 300;
const OPEN_MS = 500; // door swing / lid / lit fade
const WORK_MS = 10000; // working wobble ramp
const FAIL_MS = 600; // old _Door: breath = 600 when bit 5 arrives
const SPIN_RATE = 1 / 300; // rad per ms at full working ramp

export interface BuildingAnimState {
  /** Hurt knock: ms left and the direction the blow came from. */
  hurt: number;
  hurtAngle: number;
  /** Tree top sway: ms left (old hurt2, only re-armed once it has settled). */
  hurtTop: number;
  /** ms since removal (shrink-and-fade clock). */
  death: number;
  /** Door open progress 0..500 (also automatic doors). */
  open: number;
  /** In-use (lid) progress 0..500. */
  use: number;
  /** Lit / powered progress 0..500 (campfire). */
  lit: number;
  /**
   * Powered progress 0..500 from bit 7 alone (lamp). A lamp's colour rides in
   * bits 4-6, so `lit`, which also follows bit 5, stayed on for every colour
   * with that bit set once the power went off.
   */
  power: number;
  /** Working ramp 0..10000 (smelter, agitator...) and the accumulated spinner angle. */
  work: number;
  spin: number;
  /** Free-running cycle for pulses (seeds breathe, dynamite blinks, lights flicker). */
  breath: number;
  /** Growth/construction stage last seen and ms since it changed. */
  stage: number;
  stageT: number;
  /** Fade-in on first sight (hidden wiring, mines, spikes): 0..300. */
  reveal: number;
  /** Door "can't open" flash: ms left of 600. */
  fail: number;
  /** Spike trigger jitter: ms since triggered (0..300). */
  jitter: number;
}

/** Knock distance (world units) `remaining` ms into a hurt pulse: out fast, back slow. */
export function hurtKnock(remaining: number): number {
  if (remaining <= 0 || remaining >= STRUCTURE_HURT_MS) return 0;
  return remaining > 200 ? (20 * (STRUCTURE_HURT_MS - remaining)) / 50 : (20 * remaining) / 200;
}

function ramp(value: number, on: boolean, delta: number, max: number): number {
  return on ? Math.min(max, value + delta) : Math.max(0, value - delta);
}

function freshState(): BuildingAnimState {
  return {
    hurt: 0,
    hurtAngle: 0,
    hurtTop: 0,
    death: 0,
    open: 0,
    use: 0,
    lit: 0,
    power: 0,
    work: 0,
    spin: 0,
    breath: Math.random() * 1000,
    stage: -1,
    stageT: 0,
    reveal: 0,
    fail: 0,
    jitter: 0,
  };
}

const STRUCTURE_TYPES = [
  EntityType.BUILD_TOP,
  EntityType.BUILD_DOWN,
  EntityType.BUILD_GROUND,
  EntityType.BUILD_GROUND2,
  EntityType.RES_TOP,
  EntityType.RES_DOWN,
  EntityType.RES_MID,
  EntityType.RES_STOP,
];

export class BuildingAnimator {
  private readonly states = new WeakMap<WorldEntity, BuildingAnimState>();

  get(entity: WorldEntity): BuildingAnimState | undefined {
    return this.states.get(entity);
  }

  stateFor(entity: WorldEntity): BuildingAnimState {
    let s = this.states.get(entity);
    if (!s) {
      s = freshState();
      this.states.set(entity, s);
    }
    return s;
  }

  update(world: WorldState, deltaMs: number): void {
    for (const type of STRUCTURE_TYPES) {
      for (const entity of world.entities.getByType(type)) {
        const s = this.stateFor(entity);

        if (entity.removed) {
          s.death += deltaMs;
          continue;
        }

        if (entity.retracted) {
          s.reveal = Math.max(0, s.reveal - deltaMs);
          continue;
        }

        if (entity.hurtPulse) {
          entity.hurtPulse = false;
          s.hurt = STRUCTURE_HURT_MS;
          s.hurtAngle = (Math.PI * 2 * entity.hurtPulseDir) / 31;
          if (s.hurtTop <= 0) s.hurtTop = TOP_HURT_MS;
        }
        if (s.hurt > 0) s.hurt = Math.max(0, s.hurt - deltaMs);
        if (s.hurtTop > 0) s.hurtTop = Math.max(0, s.hurtTop - deltaMs);
        // A door that would not open: the server pulses bit 5 once, the old
        // client cleared it and flashed day-unusable for 600 ms. Only the door
        // renderer draws `fail`; on a station the same bit is the working level.
        if (entity.failPulse) {
          entity.failPulse = false;
          s.fail = FAIL_MS;
        }

        const state = entity.state;
        const inUse = (state & 16) !== 0;
        const working = (state & 32) !== 0;
        const powered = (state & 128) !== 0;

        s.open = ramp(s.open, inUse || powered, deltaMs, OPEN_MS);
        s.use = ramp(s.use, inUse, deltaMs, OPEN_MS);
        s.lit = ramp(s.lit, working || powered, deltaMs, OPEN_MS);
        s.power = ramp(s.power, powered, deltaMs, OPEN_MS);
        s.work = ramp(s.work, working, deltaMs, WORK_MS);
        if (s.work > 0) {
          const value = s.work / WORK_MS;
          s.spin += value * (2 - value) * deltaMs * SPIN_RATE; // outQuad(work) * delta / 300
        }

        s.breath += deltaMs;
        s.reveal = Math.min(300, s.reveal + deltaMs);
        if (s.fail > 0) s.fail = Math.max(0, s.fail - deltaMs);
        if (inUse) s.jitter = Math.min(300, s.jitter + deltaMs);
        else s.jitter = 0;

        const stage = (state >> 4) & 15;
        if (stage !== s.stage) {
          s.stage = stage;
          s.stageT = 0;
        }
        s.stageT += deltaMs;
      }
    }
  }
}
