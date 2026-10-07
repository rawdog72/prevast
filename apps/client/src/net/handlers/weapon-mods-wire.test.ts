// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { NetEventBus, type FullChestEvent, type TradeStateEvent } from '../events';
import { ServerOpcode } from '../opcodes';

const u16 = (v: number) => [v & 0xff, v >> 8];

function capture<T>(event: string, bytes: number[]): T | undefined {
  const bus = new NetEventBus();
  let got: T | undefined;
  bus.on(event as never, ((e: T) => (got = e)) as never);
  dispatchServerMessage(new Uint8Array(bytes), bus);
  return got;
}

describe('weapon mods on the wire (protocol 1414)', () => {
  it('ITEM_MODS states the whole fitted list of one inventory item', () => {
    const e = capture<{ uid: number; mods: { slot: number; iid: number }[] }>('itemMods', [
      ServerOpcode.ITEM_MODS,
      7,
      2,
      0,
      ...u16(174),
      6,
      ...u16(183),
    ]);
    expect(e).toEqual({
      uid: 7,
      mods: [
        { slot: 0, iid: 174 },
        { slot: 6, iid: 183 },
      ],
    });
  });

  it('ITEM_MODS with n = 0 clears the list, and a truncated one is dropped', () => {
    expect(capture('itemMods', [ServerOpcode.ITEM_MODS, 7, 0])).toEqual({ uid: 7, mods: [] });
    expect(capture('itemMods', [ServerOpcode.ITEM_MODS, 7, 2, 0, ...u16(174)])).toBeUndefined();
  });

  it('CONTAINER_CONTENTS carries a two-byte iid and each item`s mods', () => {
    const e = capture<FullChestEvent>('fullChest', [
      ServerOpcode.CONTAINER_CONTENTS,
      1,
      ...u16(172),
      1,
      12,
      1,
      0,
      ...u16(174),
      ...u16(0),
      0,
      0,
      0,
      ...u16(300),
      5,
      0,
      0,
    ]);
    expect(e!.firstOpen).toBe(true);
    expect(e!.items).toEqual([
      { iid: 172, count: 1, ammo: 12, mods: [{ slot: 0, iid: 174 }] },
      { iid: 0, count: 0, ammo: 0, mods: [] },
      { iid: 300, count: 5, ammo: 0, mods: [] },
    ]);
  });

  it('TRADE_STATE offers carry mods', () => {
    const header = [ServerOpcode.TRADE_STATE, 1, 0, 0, 0, 3, 0, 0, 0, 9, 2, 0, 2];
    const own = [1, 4, ...u16(172), 1, 0, 1, 1, ...u16(177)];
    const theirs = [0];
    const e = capture<TradeStateEvent>('tradeState', [...header, ...own, ...theirs]);
    expect(e!.own).toEqual([
      { uid: 4, iid: 172, count: 1, ammo: 0, mods: [{ slot: 1, iid: 177 }] },
    ]);
    expect(e!.theirs).toEqual([]);
  });
});
