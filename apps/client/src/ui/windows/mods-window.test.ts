// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetEventBus } from '../../net/events';
import { StatusKind } from '../../net/opcodes';
import { InventoryStore } from '../../world/inventory-store';
import { MODS_IID, modsContent } from '../../world/weapon-mods.fixtures';
import { ModsWindow } from './mods-window';

const empty = { uid: 0, iid: 0, count: 0, ammo: 0 };
function setup() {
  const bus = new NetEventBus(),
    inventory = new InventoryStore();
  inventory.attachBus(bus);
  bus.emit('fullInventory', {
    slots: [
      { uid: 7, iid: MODS_IID.gun, count: 1, ammo: 12 },
      { uid: 2, iid: MODS_IID.mag40, count: 1, ammo: 8 },
      { uid: 3, iid: MODS_IID.scope, count: 1, ammo: 0 },
      { uid: 9, iid: MODS_IID.bandage, count: 2, ammo: 0 },
      ...Array.from({ length: 6 }, () => ({ ...empty })),
    ],
  });
  bus.emit('itemMods', { uid: 7, mods: [{ slot: 0, iid: MODS_IID.mag30 }] });
  const socket = { weaponMod: vi.fn() };
  const deps = { inventory, content: modsContent(), socket, onStatus: vi.fn() };
  const win = new ModsWindow();
  win.attachBus(bus);
  win.open(7);
  const body = document.createElement('div');
  win.mount(body, deps);
  const slot = (name: string) =>
    body.querySelector<HTMLButtonElement>(`[data-mod-slot="${name}"]`)!;
  const row = (name: string) => body.querySelector<HTMLElement>(`[data-stat="${name}"]`)!;
  const preview = (index: number | null) => {
    win.previewInventory(inventory, index);
    win.refresh(deps);
  };
  return { bus, inventory, socket, deps, win, body, slot, row, preview };
}
const pointer = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ModsWindow attachment containers', () => {
  it('draws the full assembled gun and all supported containers, without duplicating inventory', () => {
    const { body, slot } = setup();
    expect(body.querySelectorAll('.dv-mods-slot')).toHaveLength(4);
    expect(slot('magazine').textContent).toContain('12/30');
    expect(slot('optic').textContent).toContain('Empty');
    expect(body.querySelectorAll('[data-stat]')).toHaveLength(13);
    expect(body.querySelectorAll('.dv-mods-choices, .inventory-grid, .hud-slot')).toHaveLength(0);
    expect(
      [...body.querySelectorAll<HTMLImageElement>('.dv-mods-picture img')].map((i) =>
        i.getAttribute('src'),
      ),
    ).toEqual(['/img/mods/mag-30.svg', '/img/mods/gun-body.svg']);
  });

  it('shows total effects and hover differences separately, with the incoming magazine rounds', () => {
    const { bus, win, deps, row, preview, socket } = setup();
    bus.emit('itemMods', {
      uid: 7,
      mods: [
        { slot: 0, iid: MODS_IID.mag30 },
        { slot: 3, iid: MODS_IID.grip },
      ],
    });
    win.refresh(deps);
    expect(row('recoil').querySelector('.dv-mods-total')?.textContent).toBe('−0.21');
    preview(1);
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('8/40');
    expect(row('magazineSize').querySelector('.dv-mods-total')?.textContent).toBe('+40');
    expect(row('magazineSize').querySelector('.dv-mods-delta')?.textContent).toBe('+10');
    expect(row('reloadMs').querySelector('.dv-mods-delta')?.classList.contains('is-worse')).toBe(
      true,
    );
    expect(row('recoil').querySelector('.dv-mods-value')?.textContent).toBe('0.49');
    expect(row('recoil').querySelector('.dv-mods-delta')?.textContent).toBe('—');
    expect(socket.weaponMod).not.toHaveBeenCalled();
    preview(null);
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('12/30');
  });

  it('previews replacement artwork and scope view effects from the existing inventory', () => {
    const { body, slot, preview } = setup();
    preview(2);
    expect(slot('optic').classList.contains('is-compatible')).toBe(true);
    expect(
      body.querySelector('.dv-mods-picture img[src="/img/mods/sight-tube.svg"]'),
    ).not.toBeNull();
    expect(body.querySelector('.dv-mods-view')?.textContent).toContain('rear coverage is reduced');
    preview(null);
    expect(body.querySelector('.dv-mods-picture img[src="/img/mods/sight-tube.svg"]')).toBeNull();
  });

  it('previews removal on hover or focus and restores the fitted build when leaving', () => {
    const { slot, row, body, socket } = setup();
    slot('magazine').dispatchEvent(new Event('pointerenter'));
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('0/0');
    expect(row('magazineSize').querySelector('.dv-mods-delta')?.textContent).toBe('−30');
    expect(body.querySelector('.dv-mods-picture img[src="/img/mods/mag-30.svg"]')).toBeNull();
    slot('magazine').dispatchEvent(new Event('pointerleave'));
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('12/30');
    slot('magazine').dispatchEvent(new Event('focus'));
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('0/0');
    expect(socket.weaponMod).not.toHaveBeenCalled();
  });

  it('does not preview an unrelated item or a stale item identity', () => {
    const { win, deps, inventory, row, preview } = setup();
    preview(3);
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('12/30');
    preview(1);
    inventory.applySlot(2, 0, 0, 0);
    inventory.setSlot(1, { uid: 12, iid: MODS_IID.mag15, count: 1, ammo: 2 });
    win.refresh(deps);
    expect(row('magazineSize').querySelector('.dv-mods-value')?.textContent).toBe('12/30');
  });

  it('rejects drops on the wrong container or window background without a request', () => {
    const { win, deps, socket } = setup();
    win.fitFromInventory(deps, 2, 'magazine');
    win.fitFromInventory(deps, 2, null);
    win.fitFromInventory(deps, 3, 'optic');
    expect(socket.weaponMod).not.toHaveBeenCalled();
    expect(deps.onStatus).toHaveBeenCalled();
  });

  it('fits by click, locks pending operations, and waits for the server to start and finish', () => {
    const { win, deps, socket, slot, bus, body } = setup();
    expect(win.inventoryClick(deps, 2)).toBe(true);
    slot('optic').click();
    expect(socket.weaponMod).toHaveBeenCalledWith(7, 1, 3);
    expect(slot('optic').textContent).toContain('Empty');
    expect(body.querySelector('.dv-mods-status')?.textContent).toContain('waiting for server');
    win.fitFromInventory(deps, 1, 'magazine');
    expect(socket.weaponMod).toHaveBeenCalledTimes(1);
    bus.emit('startInteraction', { delayMultiplier: 25 });
    win.refresh(deps);
    expect(body.querySelector('.dv-mods-status')?.textContent).toContain('Fitting Tube scope');
    bus.emit('inventorySlot', { uid: 3, iid: 0, count: 0, ammo: 0 });
    bus.emit('itemMods', {
      uid: 7,
      mods: [
        { slot: 0, iid: MODS_IID.mag30 },
        { slot: 1, iid: MODS_IID.scope },
      ],
    });
    win.refresh(deps);
    expect(slot('optic').textContent).toContain('Tube scope');
    expect(body.querySelector<HTMLElement>('.dv-mods-progress')!.hidden).toBe(true);
  });

  it('keeps installation pending across closing and reopening the window', () => {
    const { win, deps, socket, body, bus } = setup();
    win.fitFromInventory(deps, 2, 'optic');
    win.unmount();
    win.open(7);
    win.mount(body, deps);
    win.fitFromInventory(deps, 1, 'magazine');
    expect(socket.weaponMod).toHaveBeenCalledTimes(1);
    bus.emit('interruptInteraction', undefined);
    win.refresh(deps);
    expect(body.querySelector('.dv-mods-status')?.textContent).toBe('Modification interrupted.');
    win.fitFromInventory(deps, 1, 'magazine');
    expect(socket.weaponMod).toHaveBeenCalledTimes(2);
  });

  it('swaps a magazine into a full inventory and returns the outgoing magazine to its cell', () => {
    const { win, deps, inventory, bus, socket } = setup();
    for (let i = 4; i < 10; i++)
      inventory.setSlot(i, { uid: i + 20, iid: MODS_IID.bandage, count: 1 });
    win.fitFromInventory(deps, 1, 'magazine');
    expect(socket.weaponMod).toHaveBeenCalledWith(7, 0, 2);
    bus.emit('inventorySlot', { uid: 2, iid: 0, count: 0, ammo: 0 });
    bus.emit('inventorySlot', { uid: 20, iid: MODS_IID.mag30, count: 1, ammo: 12 });
    bus.emit('inventorySlot', { uid: 7, iid: MODS_IID.gun, count: 1, ammo: 8 });
    bus.emit('itemMods', { uid: 7, mods: [{ slot: 0, iid: MODS_IID.mag40 }] });
    expect(inventory.getSlot(1)).toMatchObject({ iid: MODS_IID.mag30, ammo: 12 });
    expect(inventory.getSlot(0)?.ammo).toBe(8);
  });

  it('drags an installed mod into a chosen empty inventory cell without optimistic removal', () => {
    const { slot, win, deps, inventory, socket, bus } = setup();
    const target = document.createElement('div');
    target.className = 'hud-slot';
    target.dataset.index = '8';
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    const magazine = slot('magazine');
    pointer(magazine, 'pointerdown', 10, 10);
    pointer(magazine, 'pointermove', 30, 30);
    expect(document.querySelector('.hud-drag-ghost')).not.toBeNull();
    pointer(magazine, 'pointerup', 30, 30);
    expect(document.querySelector('.hud-drag-ghost')).toBeNull();
    expect(socket.weaponMod).toHaveBeenCalledWith(7, 0, null);
    expect(inventory.modsOf(7)).toEqual([{ slot: 0, iid: MODS_IID.mag30 }]);
    bus.emit('inventorySlot', { uid: 20, iid: MODS_IID.mag30, count: 1, ammo: 12 });
    bus.emit('itemMods', { uid: 7, mods: [] });
    win.refresh(deps);
    expect(inventory.getSlot(8)).toMatchObject({ iid: MODS_IID.mag30, ammo: 12 });
    expect(slot('magazine').textContent).toContain('Empty');
  });

  it('does not remove on a cancelled drag or a drop outside inventory', () => {
    const { slot, socket, win } = setup();
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.body,
    });
    pointer(slot('magazine'), 'pointerdown', 10, 10);
    pointer(slot('magazine'), 'pointermove', 30, 30);
    pointer(slot('magazine'), 'pointerup', 30, 30);
    expect(socket.weaponMod).not.toHaveBeenCalled();
    pointer(slot('magazine'), 'pointerdown', 10, 10);
    pointer(slot('magazine'), 'pointermove', 30, 30);
    win.unmount();
    expect(document.querySelector('.hud-drag-ghost')).toBeNull();
  });

  it('blocks removal with a full bag and clears a refused operation’s placement preference', () => {
    const { slot, win, deps, inventory, socket, bus, body } = setup();
    slot('magazine').click();
    win.inventoryClick(deps, 8);
    bus.emit('interruptInteraction', undefined);
    bus.emit('statusMessage', {
      kind: StatusKind.FAILURE,
      text: 'Take it out of the trade first.',
    });
    win.refresh(deps);
    expect(body.querySelector('.dv-mods-status')?.textContent).toContain(
      'Take it out of the trade first.',
    );
    inventory.applySlot(25, MODS_IID.mag30, 1, 4);
    expect(inventory.getSlot(8)?.iid).toBe(0);
    for (let i = 4; i < 10; i++)
      inventory.setSlot(i, { uid: i + 20, iid: MODS_IID.bandage, count: 1 });
    socket.weaponMod.mockClear();
    slot('magazine').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(socket.weaponMod).not.toHaveBeenCalled();
    expect(body.querySelector('.dv-mods-status')?.textContent).toContain('Make room');
  });
});
