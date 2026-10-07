// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../core/camera';
import { NetEventBus, type TradeStateEvent } from '../net/events';
import { GameSocket } from '../net/socket';
import { InventoryStore } from '../world/inventory-store';
import { TradeStore } from '../world/trade-store';
import { WorldState, newPlayerInfo } from '../world/world-state';
import { TradeTargeting, playerAt } from './trade-targeting';

const orange = { iid: 2, uid: 7, count: 3, ammo: 200 };
const invite: TradeStateEvent = {
  id: 8,
  revision: 1,
  peer: 2,
  phase: 0,
  accepted: 0,
  rangeTiles: 2,
  own: [],
  theirs: [],
};

function world() {
  const world = new WorldState();
  world.ownGuid = 1;
  for (const [pid, x] of [
    [1, 500],
    [2, 600],
  ] as const) {
    world.players.set(pid, newPlayerInfo(pid, `Player ${pid}`));
    world.entities.processUnits([
      {
        pid,
        id: 0,
        type: 0,
        rotation: 0,
        state: 1,
        startX: x,
        startY: 500,
        endX: x,
        endY: 500,
        extra: 0,
      },
    ]);
  }
  const camera = new Camera({ viewportWidth: 800, viewportHeight: 600 });
  camera.x = 500;
  camera.y = 500;
  return { world, camera };
}

function setup() {
  const bus = new NetEventBus(),
    trade = new TradeStore(),
    inventory = new InventoryStore(),
    targeting = new TradeTargeting();
  trade.attachBus(bus);
  inventory.slots[0] = { ...orange };
  const socket = new GameSocket({ url: 'ws://localhost', login: { nickname: 'Test' }, bus });
  vi.spyOn(socket, 'tradeRequest').mockImplementation(() => {});
  vi.spyOn(socket, 'tradeOffer').mockImplementation(() => {});
  targeting.attachBus(bus, trade, inventory, socket);
  return { bus, trade, inventory, socket, targeting };
}

describe('playerAt', () => {
  it('picks the visible interpolated player body and excludes our own character', () => {
    const { world: w, camera } = world();
    w.entities.get(2, 0)!.x = 650;
    const pos = camera.worldToScreen(650, 500);
    expect(playerAt(w, camera, pos.x, pos.y)).toBe(2);
    const own = camera.worldToScreen(500, 500);
    expect(playerAt(w, camera, own.x, own.y)).toBeNull();
  });
});

describe('TradeTargeting', () => {
  it('requests the clicked player and offers the picked item once they accept', () => {
    const { bus, socket, targeting } = setup();
    targeting.begin(orange);
    expect(targeting.active).toBe(true);
    expect(targeting.pick(2, socket, 0)).toBe(true);
    expect(targeting.active).toBe(false);
    expect(socket.tradeRequest).toHaveBeenCalledWith(2);

    bus.emit('tradeState', structuredClone(invite));
    expect(socket.tradeOffer).not.toHaveBeenCalled();
    bus.emit('tradeState', { ...invite, revision: 2, phase: 2 });
    expect(socket.tradeOffer).toHaveBeenCalledWith(8, 2, 2, 7, 3);

    // Offered once: later states of the same session are the trade window's.
    bus.emit('tradeState', { ...invite, revision: 3, phase: 2 });
    expect(socket.tradeOffer).toHaveBeenCalledTimes(1);
  });

  it('spends a click on empty ground without requesting anything', () => {
    const { socket, targeting } = setup();
    targeting.begin(orange);
    expect(targeting.pick(null, socket, 0)).toBe(false);
    expect(targeting.active).toBe(false);
    expect(socket.tradeRequest).not.toHaveBeenCalled();
  });

  it('forgets a declined or refused request', () => {
    const { bus, socket, targeting } = setup();
    targeting.begin(orange);
    targeting.pick(2, socket, 0);
    bus.emit('tradeState', structuredClone(invite));
    bus.emit('tradeClosed', { id: 8, reason: 'Trade request declined.' });
    bus.emit('tradeState', { ...invite, id: 9, phase: 2 });
    expect(socket.tradeOffer).not.toHaveBeenCalled();

    // Refused outright (out of range): the server sends no session at all.
    targeting.begin(orange);
    targeting.pick(2, socket, 1000);
    targeting.update(5000);
    bus.emit('tradeState', { ...invite, id: 10, phase: 1 });
    bus.emit('tradeState', { ...invite, id: 10, phase: 2 });
    expect(socket.tradeOffer).not.toHaveBeenCalled();
  });

  it('offers nothing when the item left the inventory before the trade opened', () => {
    const { bus, inventory, socket, targeting } = setup();
    targeting.begin(orange);
    targeting.pick(2, socket, 0);
    bus.emit('tradeState', structuredClone(invite));
    inventory.slots[0] = { iid: 0, uid: 0, count: 0, ammo: 0 };
    bus.emit('tradeState', { ...invite, revision: 2, phase: 2 });
    expect(socket.tradeOffer).not.toHaveBeenCalled();
  });
});
