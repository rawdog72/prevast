// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { NetEventBus } from '../events';
import { ServerOpcode } from '../opcodes';
import { buildAimMessage } from '../outbound';

const u16 = (v: number) => [v & 0xff, v >> 8];

function capture<T>(event: string, bytes: number[]): T | undefined {
  const bus = new NetEventBus();
  let got: T | undefined;
  bus.on(event as never, ((e: T) => (got = e)) as never);
  dispatchServerMessage(new Uint8Array(bytes), bus);
  return got;
}

describe('aiming on the wire (protocol 1415)', () => {
  it('AIM_STATE carries whether aiming is on and the server viewport', () => {
    expect(capture('aimState', [ServerOpcode.AIM_STATE, 1, ...u16(1400), ...u16(900)])).toEqual({
      active: true,
      viewX: 1400,
      viewY: 900,
    });
    expect(capture('aimState', [ServerOpcode.AIM_STATE, 0, ...u16(1400), ...u16(900)])).toEqual({
      active: false,
      viewX: 1400,
      viewY: 900,
    });
  });

  it('drops a truncated AIM_STATE', () => {
    expect(capture('aimState', [ServerOpcode.AIM_STATE, 1, ...u16(1400)])).toBeUndefined();
  });

  it('AIM is [55][held]', () => {
    expect([...buildAimMessage(true)]).toEqual([55, 1]);
    expect([...buildAimMessage(false)]).toEqual([55, 0]);
  });
});
