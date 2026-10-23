// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { NetEventBus } from '../events';
import { PROTOCOL_VERSION, ServerOpcode } from '../opcodes';

// Protocol 1420 drew a frag's fragments from one SHRAPNEL_BURST cosmetic
// (opcode 32). Since 1422 they are real projectiles, sent as ordinary entity
// records like any bullet, and 32 means nothing.
describe('frag fragments on the wire (protocol 1422)', () => {
  it('no longer has a SHRAPNEL_BURST opcode', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1422);
    expect('SHRAPNEL_BURST' in ServerOpcode).toBe(false);
    expect(Object.values(ServerOpcode)).not.toContain(32);
  });

  it('ignores a stray frame with the retired opcode', () => {
    const bus = new NetEventBus();
    let events = 0;
    for (const name of ['damageIndicator', 'areaEffect', 'shakeExplosionState'] as const) {
      bus.on(name, () => events++);
    }
    const u16 = (v: number) => [v & 0xff, v >> 8];
    const old = [32, ...u16(1200), ...u16(3400), ...u16(16384), 1, ...u16(350)];
    expect(() => dispatchServerMessage(new Uint8Array(old), bus)).not.toThrow();
    expect(events).toBe(0);
  });
});
