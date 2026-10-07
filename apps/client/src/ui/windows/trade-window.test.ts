// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { NetEventBus } from '../../net/events';
import { GameSocket } from '../../net/socket';
import { InventoryStore } from '../../world/inventory-store';
import { TradeStore } from '../../world/trade-store';
import { WorldState, newPlayerInfo } from '../../world/world-state';
import { TradeWindow } from './trade-window';

describe('TradeWindow', () => {
  it('invites first, shows both offers, handles quantities and never renders player names as HTML', () => {
    const body = document.createElement('div'),
      trade = new TradeStore(),
      world = new WorldState();
    const inventory = new InventoryStore(),
      content = new ContentStore(),
      bus = new NetEventBus();
    const socket = new GameSocket({ url: 'ws://localhost', login: { nickname: 'Test' }, bus });
    const win = new TradeWindow();
    const deps = { trade, world, inventory, content, socket };
    world.players.set(2, newPlayerInfo(2, '<img src=x onerror=alert(1)>'));
    trade.attachBus(bus);
    vi.spyOn(socket, 'tradeReply').mockImplementation(() => {});
    vi.spyOn(socket, 'tradeOffer').mockImplementation(() => {});
    const state = {
      id: 1,
      revision: 1,
      peer: 2,
      phase: 1 as const,
      accepted: 0,
      rangeTiles: 2,
      own: [],
      theirs: [],
    };
    bus.emit('tradeState', state);
    win.mount(body, deps);
    expect(body.querySelector('img')).toBeNull();
    expect(body.textContent).toContain('wants to trade');
    (body.querySelector('.dv-trade-primary') as HTMLButtonElement).click();
    expect(socket.tradeReply).toHaveBeenCalledWith(1, true);
    const item = { iid: 2, uid: 7, count: 5, ammo: 0 };
    inventory.slots[0] = { ...item, count: 20 };
    bus.emit('tradeState', {
      ...state,
      phase: 2,
      revision: 2,
      own: [{ ...item, mods: [] }],
      theirs: [{ ...item, uid: 9, count: 8, mods: [] }],
      accepted: 2,
    });
    win.refresh(deps);
    expect(body.querySelectorAll('.dv-trade-side')).toHaveLength(2);
    expect(body.querySelector('.dv-trade-side:not(.is-own)')!.classList.contains('is-accepted')).toBe(true);
    expect(body.textContent).toContain('is ready');
    const input = body.querySelector('input')!;
    input.value = '12';
    input.dispatchEvent(new Event('change'));
    expect(socket.tradeOffer).toHaveBeenCalledWith(1, 2, 2, 7, 12);
    expect(inventory.slots[0]?.count).toBe(20);
    win.refresh(deps);
    expect(body.querySelector('input')?.disabled).toBe(true);
  });
});
