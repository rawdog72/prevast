// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../net/events';
import { AIM_BLEND_MS, AIM_PREDICT_MS, AimController } from './aim-controller';

function setup() {
  const socket = { aim: vi.fn() };
  const aim = new AimController(socket);
  return { socket, aim };
}

describe('AimController', () => {
  it('sends AIM once per press and once per release', () => {
    const { socket, aim } = setup();
    aim.press(true);
    aim.press(true);
    aim.release();
    aim.release();
    expect(socket.aim.mock.calls).toEqual([[true], [false]]);
  });

  it('expects the server to agree on a press, and stops expecting it after a silence', () => {
    const { aim } = setup();
    aim.press(true);
    expect(aim.active).toBe(true);
    aim.update(AIM_PREDICT_MS + 1);
    expect(aim.active).toBe(false);
    aim.release();
    aim.press(false);
    expect(aim.active).toBe(false);
  });

  it('follows AIM_STATE while held, and lets go at once on release', () => {
    const { aim } = setup();
    const bus = new NetEventBus();
    aim.attachBus(bus);
    aim.press(false);
    bus.emit('aimState', { active: true, viewX: 1400, viewY: 900 });
    expect(aim.active).toBe(true);
    expect(aim.viewport).toEqual({ viewX: 1400, viewY: 900 });
    bus.emit('aimState', { active: false, viewX: 1400, viewY: 900 }); // a reload started
    expect(aim.active).toBe(false);
    bus.emit('aimState', { active: true, viewX: 1400, viewY: 900 });
    aim.release();
    expect(aim.active).toBe(false);
  });

  it('eases the blend in and out over AIM_BLEND_MS', () => {
    const { aim } = setup();
    aim.press(true);
    aim.update(AIM_BLEND_MS / 2);
    expect(aim.blend).toBeCloseTo(0.5, 6);
    aim.update(AIM_BLEND_MS);
    expect(aim.blend).toBe(1);
    aim.release();
    aim.update(AIM_BLEND_MS);
    expect(aim.blend).toBe(0);
  });
});
