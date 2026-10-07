// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/gauge-model.ts
// The old client's Gauge / updateGauge: the server states a gauge's value
// (GAUGE_VALUES, STAMINA), its rates (GAUGE_RATES,
// wire units /10000 per ms) and its direction (GAUGE_DIRECTIONS), and both sides
// integrate the same numbers between statements -- so a bar moves smoothly
// instead of jumping on every server push. `value` is what the model believes
// the server has; `current` eases toward it for drawing (10 % per frame).

import type { NetEventBus } from '../net/events';
import { GAUGE_SLOTS, GaugeDirection, type GaugeSlotName } from '../net/opcodes';

/** One frame never applies more than this: a hidden tab's absence must not land as one step. */
const MAX_STEP_MS = 250;
const RATE_SCALE = 10000;
const EASE = 0.1;

export interface Gauge {
  value: number;
  current: number;
  max: number;
  /** Per millisecond. */
  speedInc: number;
  speedDec: number;
  dir: GaugeDirection;
}

function newGauge(): Gauge {
  return { value: 255, current: 255, max: 255, speedInc: 0, speedDec: 0, dir: GaugeDirection.HOLD };
}

export class GaugeModel {
  private readonly gauges: Record<GaugeSlotName, Gauge> = {
    life: newGauge(),
    food: newGauge(),
    warmth: newGauge(),
    stamina: newGauge(),
    radiation: newGauge(),
  };

  gauge(name: GaugeSlotName): Gauge {
    return this.gauges[name];
  }

  /** Drawn fill, 0..1. */
  fraction(name: GaugeSlotName): number {
    const g = this.gauges[name];
    return g.max > 0 ? Math.max(0, Math.min(1, g.current / g.max)) : 0;
  }

  setValue(name: GaugeSlotName, value: number): void {
    const g = this.gauges[name];
    g.value = Math.max(0, Math.min(g.max, value));
  }

  /** Rates arrive in wire units: 1/10000 of a gauge unit per millisecond. */
  setRates(name: GaugeSlotName, max: number, inc: number, dec: number): void {
    const g = this.gauges[name];
    g.max = max;
    g.speedInc = inc / RATE_SCALE;
    g.speedDec = dec / RATE_SCALE;
    g.value = Math.min(g.value, max);
    g.current = Math.min(g.current, max);
  }

  setDirection(name: GaugeSlotName, dir: GaugeDirection): void {
    this.gauges[name].dir = dir;
  }

  update(deltaMs: number): void {
    const step = Math.min(deltaMs, MAX_STEP_MS);
    for (const name of GAUGE_SLOTS) {
      const g = this.gauges[name];
      if (g.dir === GaugeDirection.FALL) g.value = Math.max(0, g.value - step * g.speedDec);
      else if (g.dir === GaugeDirection.RISE)
        g.value = Math.min(g.max, g.value + step * g.speedInc);
      g.current += (g.value - g.current) * EASE;
    }
  }

  /** Snap the drawn values to the stated ones (login / respawn). */
  snap(): void {
    for (const name of GAUGE_SLOTS) this.gauges[name].current = this.gauges[name].value;
  }

  attachBus(bus: NetEventBus): () => void {
    const cleanups: (() => void)[] = [];
    cleanups.push(
      bus.on('gauges', (ev) => {
        for (const name of GAUGE_SLOTS) this.setValue(name, ev[name]);
      }),
    );
    cleanups.push(
      bus.on('gaugeRates', (ev) => {
        for (const name of GAUGE_SLOTS)
          this.setRates(name, ev[name].max, ev[name].inc, ev[name].dec);
      }),
    );
    cleanups.push(
      bus.on('gaugeState', (ev) => {
        for (const name of GAUGE_SLOTS) this.setDirection(name, ev[name]);
      }),
    );
    cleanups.push(bus.on('playerStamina', (ev) => this.setValue('stamina', ev.stamina)));
    // A fresh session starts every bar where the server says, not easing from full.
    cleanups.push(bus.on('handshake', () => this.snap()));
    return () => {
      for (const c of cleanups) c();
    };
  }
}
