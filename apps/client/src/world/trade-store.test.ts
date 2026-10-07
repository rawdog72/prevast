// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { NetEventBus, type TradeStateEvent } from '../net/events';
import { GameSocket } from '../net/socket';
import { InventoryStore } from './inventory-store';
import { TradeStore } from './trade-store';

const item = { iid: 2, uid: 7, count: 20, ammo: 0, mods: [] };
const state: TradeStateEvent = {
  id: 8,
  revision: 3,
  peer: 2,
  phase: 2,
  accepted: 0,
  rangeTiles: 2,
  own: [],
  theirs: [],
};
function setup() {
  const bus = new NetEventBus(),
    trade = new TradeStore(),
    inventory = new InventoryStore();
  trade.attachBus(bus);
  inventory.attachBus(bus);
  inventory.slots[0] = { ...item };
  const socket = new GameSocket({ url: 'ws://localhost', login: { nickname: 'Test' }, bus });
  vi.spyOn(socket, 'tradeOffer').mockImplementation(() => {});
  vi.spyOn(socket, 'tradeAccept').mockImplementation(() => {});
  vi.spyOn(socket, 'tradeCancel').mockImplementation(() => {});
  bus.emit('tradeState', structuredClone(state));
  return { bus, trade, socket, inventory };
}
describe('TradeStore', () => {
  it('keeps items in inventory, waits for the offer acknowledgement and accepts only the new revision', () => {
    const { bus, trade, socket, inventory } = setup();
    trade.offer(socket, item, 5);
    trade.accept(socket);
    expect(socket.tradeOffer).toHaveBeenCalledWith(8, 3, 2, 7, 5);
    expect(socket.tradeAccept).not.toHaveBeenCalled();
    expect(inventory.slots[0]).toEqual(item);
    bus.emit('tradeState', { ...state, revision: 4, own: [{ ...item, count: 5 }] });
    trade.accept(socket);
    trade.accept(socket);
    expect(socket.tradeAccept).toHaveBeenCalledExactlyOnceWith(8, 4);
  });
  it('does not deadlock on an unchanged quantity or accept an empty trade', () => {
    const { bus, trade, socket } = setup();
    trade.accept(socket);
    expect(socket.tradeAccept).not.toHaveBeenCalled();
    bus.emit('tradeState', { ...state, own: [item] });
    trade.offer(socket, item);
    expect(trade.pending).toBe(false);
    trade.offer(socket, item, 0);
    expect(socket.tradeOffer).toHaveBeenCalledWith(8, 3, 2, 7, 0);
  });
  it('ignores a previous session close and clears on death or cancellation without moving inventory', () => {
    const { bus, trade, socket, inventory } = setup();
    bus.emit('tradeClosed', { id: 6, reason: 'old' });
    expect(trade.state).not.toBeNull();
    trade.cancel(socket);
    bus.emit('tradeState', { ...state, accepted: 1 });
    expect(trade.closing).toBe(true);
    bus.emit('tradeClosed', { id: 8, reason: 'Cancelled' });
    expect(trade.state).toBeNull();
    expect(inventory.slots[0]).toEqual(item);
    bus.emit('tradeState', state);
    bus.emit('playerDie', { kills: 0 });
    expect(trade.state).toBeNull();
  });
});
