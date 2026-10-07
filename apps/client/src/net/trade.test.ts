// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { BinaryWriter } from './binary-stream';
import { dispatchServerMessage } from './dispatcher';
import { NetEventBus } from './events';
import {
  buildTradeAcceptMessage,
  buildTradeCancelMessage,
  buildTradeOfferMessage,
  buildTradeReplyMessage,
  buildTradeRequestMessage,
  buildLookAtMessage,
} from './outbound';

describe('trade wire', () => {
  it('encodes session and exact offer revision, with quantities and item identity', () => {
    expect([...buildTradeOfferMessage(0x12345678, 9, 300, 250, 17)]).toEqual([
      43, 120, 86, 52, 18, 9, 0, 0, 0, 44, 1, 250, 17,
    ]);
    expect([...buildTradeAcceptMessage(7, 12)]).toEqual([44, 7, 0, 0, 0, 12, 0, 0, 0]);
    expect([...buildTradeReplyMessage(7, true)]).toEqual([42, 7, 0, 0, 0, 1]);
    expect([...buildTradeCancelMessage(7)]).toEqual([45, 7, 0, 0, 0]);
    expect([...buildTradeRequestMessage(3)]).toEqual([41, 3]);
    expect([...buildLookAtMessage(0x010203, 3)]).toEqual([46, 3, 2, 1, 0, 3]);
  });
  it('decodes both offers and rejects every truncated or overlong state', () => {
    const bus = new NetEventBus(),
      state = vi.fn();
    bus.on('tradeState', state);
    const w = new BinaryWriter();
    w.u8(93);
    w.u32(7);
    w.u32(9);
    w.u8(3);
    w.u8(2);
    w.u8(1);
    w.u8(2);
    w.u8(1);
    w.u8(250);
    w.u16(300);
    w.u8(17);
    w.u8(231);
    w.u8(0); // no mods fitted
    w.u8(0);
    const packet = w.build();
    dispatchServerMessage(packet, bus);
    expect(state).toHaveBeenCalledWith({
      id: 7,
      revision: 9,
      peer: 3,
      phase: 2,
      accepted: 1,
      rangeTiles: 2,
      own: [{ uid: 250, iid: 300, count: 17, ammo: 231, mods: [] }],
      theirs: [],
    });
    state.mockClear();
    for (let i = 1; i < packet.length; i++) dispatchServerMessage(packet.slice(0, i), bus);
    dispatchServerMessage(new Uint8Array([...packet, 0]), bus);
    const bad = packet.slice();
    bad[13] = 255;
    dispatchServerMessage(bad, bus);
    expect(state).not.toHaveBeenCalled();
  });
});
