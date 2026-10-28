// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { type AreaEffectEvent, NetEventBus } from '../events';
import { ServerOpcode } from '../opcodes';

const u16 = (v: number) => [v & 0xff, v >> 8];
const i8 = (v: number) => [v & 0xff];

function capture(bytes: number[]): AreaEffectEvent | undefined {
  const bus = new NetEventBus();
  let got: AreaEffectEvent | undefined;
  bus.on('areaEffect', (e) => (got = e));
  dispatchServerMessage(new Uint8Array(bytes), bus);
  return got;
}

const head = (n: number) => [
  ServerOpcode.AREA_EFFECT,
  ...u16(7), // id
  1, // kind: gas
  ...u16(3), // effectId: toxic_gas
  0, // flags
  ...u16(120),
  ...u16(340), // origin tile
  ...u16(2500),
  ...u16(10000),
  ...u16(3000), // grow, hold, fade
  ...u16(1200), // age
  n,
];

describe('zones on the wire (protocol 1426)', () => {
  it('AREA_EFFECT carries the cloud, its timing and its tiles in growth order', () => {
    const ev = capture([...head(3), ...i8(0), ...i8(0), ...i8(-1), ...i8(0), ...i8(1), ...i8(-2)]);
    expect(ev).toEqual({
      id: 7,
      kind: 1,
      effectId: 3,
      hides: false,
      tileX: 120,
      tileY: 340,
      growMs: 2500,
      holdMs: 10000,
      fadeMs: 3000,
      ageMs: 1200,
      cells: [
        [0, 0],
        [-1, 0],
        [1, -2],
      ],
    });
  });

  it('says whether the zone blocks vision', () => {
    const bytes = [...head(1), ...i8(0), ...i8(0)];
    bytes[6] = 1; // flags: AREA_EFFECT_HIDES
    expect(capture(bytes)?.hides).toBe(true);
  });

  it('drops a truncated or overlong AREA_EFFECT', () => {
    expect(capture([...head(2), ...i8(0), ...i8(0)])).toBeUndefined();
    expect(capture([...head(1), ...i8(0), ...i8(0), 9])).toBeUndefined();
    expect(capture([ServerOpcode.AREA_EFFECT, ...u16(7)])).toBeUndefined();
  });
});
