// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/render/poison-effect.ts
// The old client's poison screen (_SetPoisonEffect / nmmMm, client.js 19210):
// for the POISONED duration the view throbs -- the zoom multiplier runs
// 1 + v and the canvas draws at 1 / (1 + 20v) of its resolution -- on a 1.5 s
// eased triangle. After the first 750 ms the throb floors at half (v =
// 0.5 + 0.5v) so the picture never settles; the last down-half ramps to 0 so
// the effect always ends on a cycle boundary, looking normal. A zero delay
// (server syncPoisonScreen) stops it at the next boundary the same way.

import { easeInOutQuad } from './character-animator';

export const POISON_CYCLE_MS = 1500;
const HALF = POISON_CYCLE_MS / 2;
/** Resolution divisor at full throb, i.e. `1 + 20v` in the old client. */
const PIXELATION = 20;

export class PoisonEffect {
  private remainingMs = 0;
  private elapsedMs = 0;
  private phaseMs = 0;
  private active = false;
  /** Throb 0..1 for this frame. */
  value = 0;

  get isActive(): boolean {
    return this.active;
  }

  /** POISONED with a duration: (re)arm the timer; the throb keeps its phase if already running. */
  start(durationMs: number): void {
    if (durationMs <= 0) {
      this.stop();
      return;
    }
    if (!this.active) {
      this.active = true;
      this.elapsedMs = 0;
      this.phaseMs = 0;
      this.value = 0;
    }
    this.remainingMs = durationMs;
  }

  /** POISONED 0: run the timer out so the current cycle finishes and ends clean. */
  stop(): void {
    this.remainingMs = 0;
  }

  update(deltaMs: number): void {
    if (!this.active) return;
    if (this.remainingMs <= 0 && this.phaseMs + deltaMs >= POISON_CYCLE_MS) {
      this.active = false;
      this.phaseMs = 0;
      this.value = 0;
      return;
    }
    this.remainingMs -= deltaMs;
    this.elapsedMs += deltaMs;
    this.phaseMs = (this.phaseMs + deltaMs) % POISON_CYCLE_MS;

    const down = this.phaseMs > HALF;
    let v = easeInOutQuad((down ? POISON_CYCLE_MS - this.phaseMs : this.phaseMs) / HALF);
    const toCycleEnd = POISON_CYCLE_MS - this.phaseMs;
    if (this.remainingMs < HALF && down && toCycleEnd > this.remainingMs) {
      // Final descent: blend towards the straight ramp so v reaches 0 at the boundary.
      v = 0.5 * (toCycleEnd / HALF) + v * 0.5;
    } else if (this.elapsedMs > HALF) {
      v = 0.5 + v * 0.5;
    }
    this.value = v;
  }

  /** Multiply the camera zoom by this. */
  get zoomMultiplier(): number {
    return 1 + this.value;
  }

  /** Divide the canvas backing resolution by this. */
  get resolutionDivisor(): number {
    return 1 + this.value * PIXELATION;
  }
}
