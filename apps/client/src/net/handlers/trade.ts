// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, TradeItem, TradeStateEvent } from '../events';
import { readFittedMods } from './inventory';

export function handleTradeState(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const id = r.u32(),
    revision = r.u32(),
    peer = r.u8(),
    phase = r.u8();
  const accepted = r.u8(),
    rangeTiles = r.u8();
  const offer = (): TradeItem[] => {
    const count = r.u8();
    if (count > 32) {
      r.hasError = true;
      return [];
    }
    const items: TradeItem[] = [];
    for (let i = 0; i < count && !r.hasError; i++) {
      if (r.remaining() < 6) {
        r.hasError = true;
        break;
      }
      const uid = r.u8(),
        iid = r.u16(),
        amount = r.u8(),
        ammo = r.u8();
      items.push({ uid, iid, count: amount, ammo, mods: readFittedMods(r) });
    }
    return items;
  };
  const own = offer(),
    theirs = offer();
  if (r.hasError || r.remaining() !== 0 || phase > 2 || accepted > 3 || !id || !rangeTiles) return;
  bus.emit('tradeState', {
    id,
    revision,
    peer,
    phase: phase as TradeStateEvent['phase'],
    accepted,
    rangeTiles,
    own,
    theirs,
  });
}

export function handleTradeClosed(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const id = r.u32(),
    reason = r.str();
  if (!r.hasError && r.remaining() === 0) bus.emit('tradeClosed', { id, reason });
}
