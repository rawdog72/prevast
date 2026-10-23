// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { NetEventBus } from '../events';
import { ClientOpcode, ServerOpcode } from '../opcodes';
import { buildAimMessage, buildThrowTargetMessage } from '../outbound';

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

  it('COOK_STATE carries the fuse and what is left of it; 0 ends the cook', () => {
    expect(capture('cookState', [ServerOpcode.COOK_STATE, ...u16(3000), ...u16(2750)])).toEqual({
      fuseMs: 3000,
      remainingMs: 2750,
    });
    expect(capture('cookState', [ServerOpcode.COOK_STATE, ...u16(0), ...u16(0)])).toEqual({
      fuseMs: 0,
      remainingMs: 0,
    });
    expect(capture('cookState', [ServerOpcode.COOK_STATE, ...u16(3000)])).toBeUndefined();
  });

  it('THROW_TARGET is [THROW_TARGET][i16 dx][i16 dy], rounded and kept in range', () => {
    expect([...buildThrowTargetMessage(212.6, -40.2)]).toEqual([
      ClientOpcode.THROW_TARGET,
      ...u16(213),
      ...u16(0x10000 - 40),
    ]);
    expect([...buildThrowTargetMessage(0, 0)]).toEqual([ClientOpcode.THROW_TARGET, 0, 0, 0, 0]);
    expect([...buildThrowTargetMessage(1e6, -1e6)]).toEqual([
      ClientOpcode.THROW_TARGET,
      0xff,
      0x7f,
      0x00,
      0x80,
    ]);
  });

  it('AIM is [AIM][held]', () => {
    expect([...buildAimMessage(true)]).toEqual([ClientOpcode.AIM, 1]);
    expect([...buildAimMessage(false)]).toEqual([ClientOpcode.AIM, 0]);
  });
});
