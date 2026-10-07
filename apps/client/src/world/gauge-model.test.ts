// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../net/events';
import { GaugeDirection } from '../net/opcodes';
import { GaugeModel } from './gauge-model';

describe('GaugeModel (old client updateGauge)', () => {
  it('integrates the server rate in the server direction and eases the drawn value toward it', () => {
    const m = new GaugeModel();
    m.setRates('food', 255, 120, 200); // wire units: /10000 per ms
    m.setValue('food', 255);
    m.setDirection('food', GaugeDirection.FALL);

    m.update(100);
    expect(m.gauge('food').value).toBeCloseTo(255 - 100 * 0.02, 5);
    // current lerps 10% of the way each frame
    expect(m.gauge('food').current).toBeCloseTo(255 + (m.gauge('food').value - 255) * 0.1, 5);

    m.setDirection('food', GaugeDirection.RISE);
    for (let i = 0; i < 200; i++) m.update(100);
    expect(m.gauge('food').value).toBe(255); // capped at max

    m.setDirection('food', GaugeDirection.HOLD);
    m.update(1000);
    expect(m.gauge('food').value).toBe(255);
  });

  it('clamps one step at 250 ms so a hidden tab does not apply its whole absence at once', () => {
    const m = new GaugeModel();
    m.setRates('life', 255, 0, 10000); // 1 per ms
    m.setValue('life', 255);
    m.setDirection('life', GaugeDirection.FALL);
    m.update(5000);
    expect(m.gauge('life').value).toBe(5);
    m.update(5000);
    expect(m.gauge('life').value).toBe(0);
  });

  it('is fed by GAUGES / MODDED_GAUGES_VALUES / GAUGE_STATE / PLAYER_LIFE / PLAYER_STAMINA', () => {
    const m = new GaugeModel();
    const bus = new NetEventBus();
    m.attachBus(bus);
    bus.emit('gaugeRates', {
      life: { max: 255, inc: 50, dec: 0 },
      food: { max: 255, inc: 12, dec: 12 },
      warmth: { max: 255, inc: 50, dec: 35 },
      stamina: { max: 255, inc: 150, dec: 300 },
      radiation: { max: 255, inc: 30, dec: 240 },
    });
    bus.emit('gauges', { life: 200, food: 180, warmth: 40, stamina: 255, radiation: 10 });
    expect(m.gauge('food').value).toBe(180);
    expect(m.gauge('food').speedDec).toBeCloseTo(0.0012, 8);
    bus.emit('gaugeState', {
      life: GaugeDirection.HOLD,
      food: GaugeDirection.FALL,
      warmth: GaugeDirection.RISE,
      stamina: GaugeDirection.HOLD,
      radiation: GaugeDirection.HOLD,
    });
    expect(m.gauge('food').dir).toBe(GaugeDirection.FALL);
    bus.emit('playerLife', { life: 77 });
    bus.emit('playerStamina', { stamina: 33 });
    expect(m.gauge('life').value).toBe(77);
    expect(m.gauge('stamina').value).toBe(33);
    expect(m.fraction('life')).toBe(1); // the drawn value eases in update(), it has not moved yet
    m.snap();
    expect(m.fraction('life')).toBeCloseTo(77 / 255, 5);
  });
});
