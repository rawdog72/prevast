// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import type { WorldEntity } from '../../world/entity-types';
import { InventoryStore } from '../../world/inventory-store';
import { NetEventBus } from '../../net/events';
import { handleOpenBuilding, handleNewFuelValue } from '../../net/handlers/interaction';
import {
  CraftingWindow,
  type CraftingWindowCallbacks,
  type StationInReach,
} from './crafting-window';

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      wood: { key: 'wood', id: 1, clientItemId: 1, name: 'Wood', properties: { stack: 255 } },
      stone: { key: 'stone', id: 2, clientItemId: 2, name: 'Stone', properties: { stack: 255 } },
      shaped_metal: {
        key: 'shaped_metal',
        id: 8,
        clientItemId: 8,
        name: 'Shaped Metal',
        properties: { stack: 255 },
      },
      hatchet: {
        key: 'hatchet',
        id: 15,
        clientItemId: 15,
        name: 'Hatchet',
        properties: { stack: 1 },
        skill: { type: 'tool' },
        crafting: {
          recipe: {
            ingredient: [
              { itemKey: 'wood', amount: 10 },
              { itemKey: 'stone', amount: 2 },
            ],
          },
          stations: { station: [{ key: 'player', timeMs: 4000 }] },
        },
        client: { icon: 'inv-hachet' },
      },
      campfire: {
        key: 'campfire',
        id: 33,
        clientItemId: 33,
        name: 'Campfire',
        properties: { stack: 1 },
        skill: { type: 'survival' },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'wood', amount: 30 }] },
          stations: { station: [{ key: 'player', timeMs: 2000 }] },
        },
        client: { icon: 'inv-campfire' },
      },
      metal_pickaxe: {
        key: 'metal_pickaxe',
        id: 17,
        clientItemId: 17,
        name: 'Metal Pickaxe',
        properties: { stack: 1 },
        skill: { type: 'tool', requiredLevel: 6, skillCost: 1 },
        crafting: {
          recipe: { ingredient: [{ itemKey: 'shaped_metal', amount: 6 }] },
          stations: { station: [{ key: 'workbench', timeMs: 15000 }] },
        },
        client: { icon: 'inv-steel-pickaxe' },
      },
      stone_wall: {
        key: 'stone_wall',
        id: 28,
        clientItemId: 28,
        name: 'Stone Wall',
        properties: { stack: 255 },
        skill: { type: 'building', requiredLevel: 3, skillCost: 1 },
        crafting: {
          yield: 2,
          recipe: { ingredient: [{ itemKey: 'stone', amount: 20 }] },
          stations: { station: [{ key: 'workbench', timeMs: 8000 }] },
        },
        client: { icon: 'inv-stone-wall' },
      },
      inv1: {
        key: 'inv1',
        id: 162,
        clientItemId: 162,
        name: 'Inventory 1',
        properties: {},
        skill: { type: 'skill', requiredLevel: 0, skillCost: 1 },
        bag: { addSlots: 1 },
        client: { icon: 'skill-inv1', description: 'One more inventory slot.' },
      },
      workbench: {
        key: 'workbench',
        id: 40,
        clientItemId: 40,
        name: 'Workbench',
        properties: { stack: 1 },
        client: { icon: 'inv-workbench' },
      },
    },
  });
  store.load({
    name: 'objects',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      workbench: {
        key: 'workbench',
        itemKey: 'workbench',
        category: 'station',
        healthMax: 500,
        layer: 'top',
        station: { key: 'workbench', areaId: 2 },
        fuel: { itemKey: 'wood', burnDurationPerUnitMs: 15000, addAmount: 15 },
      },
    },
  });
  store.load({
    name: 'skills',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      skill: { key: 'skill', name: 'Skills', icon: 'skill-button' },
      survival: { key: 'survival', name: 'Survival', icon: 'survival-button' },
      building: { key: 'building', name: 'Building', icon: 'building-button' },
      tool: { key: 'tool', name: 'Tools', icon: 'tool-button' },
    },
  });
  return store;
}

function entity(id: number): WorldEntity {
  return { id, pid: 0, type: 5, x: 0, y: 0 } as unknown as WorldEntity;
}

function setup(
  opts: { level?: number; unlocked?: number[]; station?: number; reach?: StationInReach[] } = {},
) {
  const store = content();
  const inventory = new InventoryStore();
  inventory.level = opts.level ?? 0;
  for (const iid of opts.unlocked ?? []) inventory.unlockedSkills.add(iid);
  inventory.setAllSlots([
    { iid: 1, count: 40, uid: 1, ammo: 0 },
    { iid: 2, count: 1, uid: 2, ammo: 0 },
  ]);
  if (opts.station !== undefined) {
    inventory.isStationOpen = true;
    inventory.stationArea = opts.station;
    inventory.stationQueue = [0, 0, 0, 0];
  }
  const callbacks: CraftingWindowCallbacks = {
    onCraft: vi.fn(),
    onCancel: vi.fn(),
    onUnlock: vi.fn(),
    onAddFuel: vi.fn(),
    onOpenStation: vi.fn(),
    onLeaveStation: vi.fn(),
    onTakeFromStation: vi.fn(),
    stationsInReach: () => opts.reach ?? [],
  };
  const body = document.createElement('div');
  const head = { title: document.createElement('h2'), sub: document.createElement('div') };
  const win = new CraftingWindow();
  win.mount(body, head, store, inventory, callbacks, { now: () => 1000 });
  const cells = () => Array.from(body.querySelectorAll<HTMLElement>('.dv-craft-cell'));
  const whereTabs = () => Array.from(body.querySelectorAll<HTMLElement>('.dv-craft-where .dv-tab'));
  const skillTabs = () =>
    Array.from(body.querySelectorAll<HTMLElement>('.dv-craft-unlock-tabs .is-skill'));
  const at = (now: number) => win.refresh(store, inventory, callbacks, { now: () => now });
  return { store, inventory, callbacks, body, head, win, cells, whereTabs, skillTabs, at };
}

const tabName = (t: HTMLElement) => t.querySelector('.dv-tab-name')!.textContent;

describe('CraftingWindow (old client _Craft)', () => {
  it('by hand: lists the hand recipes in a grid, greys the ones missing ingredients, selects the first', () => {
    const { body, cells, head, whereTabs } = setup();
    expect(head.title.textContent).toBe('Crafting');
    expect(whereTabs().map(tabName)).toEqual(['By hand']);
    expect(whereTabs()[0]!.classList.contains('is-active')).toBe(true);
    expect(cells().map((c) => c.dataset.iid)).toEqual(['15', '33']);
    expect(cells()[0]!.classList.contains('is-selected')).toBe(true);
    expect(cells()[0]!.classList.contains('is-off')).toBe(true); // 1 stone of 2
    expect(cells()[1]!.classList.contains('is-off')).toBe(false); // 40 wood of 30
    expect(body.querySelector('.dv-craft-preview .name')!.textContent).toBe('Hatchet');
    const ings = Array.from(body.querySelectorAll('.dv-craft-ing'));
    expect(ings.map((e) => e.querySelector('.dv-craft-ing-count')!.textContent)).toEqual([
      '40/10',
      '1/2',
    ]);
    expect(ings.map((e) => e.getAttribute('aria-label'))).toEqual([
      'Wood: 40/10',
      'Stone: 1/2 — missing ingredients',
    ]);
    document.body.appendChild(body);
    (ings[0] as HTMLElement).focus();
    expect(body.querySelector('.dv-craft-ingredients-label')!.textContent).toBe('Wood');
    (ings[0] as HTMLElement).blur();
    expect(body.querySelector('.dv-craft-ingredients-label')!.textContent).toBe('Ingredients');
    body.remove();
    expect(body.querySelector<HTMLButtonElement>('button.dv-craft-go')!.disabled).toBe(true);
    expect(body.querySelector<HTMLElement>('.dv-craft-station-reveal')!.inert).toBe(true);
  });

  it('ingredient counts follow the inventory while the window is open, craftable or not', () => {
    const { body, inventory, at } = setup();
    const ings = () =>
      Array.from(body.querySelectorAll('.dv-craft-ing-count')).map((e) => e.textContent);
    expect(ings()).toEqual(['40/10', '1/2']);
    // More wood, still one stone short: the hatchet stays uncraftable, the count moves.
    inventory.setAllSlots([
      { iid: 1, count: 45, uid: 1, ammo: 0 },
      { iid: 2, count: 1, uid: 2, ammo: 0 },
    ]);
    at(1000);
    expect(ings()).toEqual(['45/10', '1/2']);
    // Wood dropped: 45 -> 5 still reads, and the row turns short.
    inventory.setAllSlots([
      { iid: 1, count: 5, uid: 1, ammo: 0 },
      { iid: 2, count: 1, uid: 2, ammo: 0 },
    ]);
    at(1000);
    expect(ings()).toEqual(['5/10', '1/2']);
    expect(body.querySelector('.dv-craft-ing')!.classList.contains('is-short')).toBe(true);
  });

  it('craft becomes one cancel button with a live progress fill and countdown', () => {
    const { body, cells, callbacks, inventory, at } = setup();
    cells()[1]!.click();
    expect(cells()[1]!.classList.contains('is-selected')).toBe(true);
    const go = body.querySelector<HTMLButtonElement>('button.dv-craft-go')!;
    expect(go.disabled).toBe(false);
    go.click();
    expect(callbacks.onCraft).toHaveBeenCalledWith(33, 0);

    inventory.crafting = { iid: 33, startedAt: 0 };
    at(1000); // 1 s of 2 s: inOutQuad(0.5) = 0.5
    const fill = body.querySelector<HTMLElement>('.dv-craft-progress-fill')!;
    const cancel = body.querySelector<HTMLButtonElement>('.dv-craft-cancel')!;
    expect(body.querySelectorAll('.dv-craft-actions button')).toHaveLength(1);
    expect(cancel.contains(fill)).toBe(true);
    expect(cancel.getAttribute('aria-label')).toBe('Cancel crafting Campfire');
    expect(fill.style.getPropertyValue('--val')).toBe('50.0%');
    expect(cancel.textContent).toBe('Cancel · 1.0 s');
    at(1500); // same element, further along (no rebuild between frames)
    expect(body.querySelector<HTMLElement>('.dv-craft-progress-fill')).toBe(fill);
    expect(fill.style.getPropertyValue('--val')).toBe('87.5%');
    expect(body.querySelector('.dv-craft-cancel')).toBe(cancel);
    expect(cancel.textContent).toBe('Cancel · 0.5 s');

    body.querySelector<HTMLButtonElement>('button.dv-craft-cancel')!.click();
    expect(callbacks.onCancel).toHaveBeenCalled();
    expect(inventory.crafting).toBeNull();
    expect(body.querySelector('.dv-craft-progress')).toBeNull();
    expect(body.querySelector('button.dv-craft-go')).not.toBeNull();

    // The old client zeroed the craft when its clock ran out.
    inventory.crafting = { iid: 33, startedAt: 0 };
    at(2500);
    expect(inventory.crafting).toBeNull();
    at(2501);
    expect(body.querySelectorAll('.dv-craft-actions button')).toHaveLength(1);
    expect(body.querySelector('.dv-craft-cancel')).toBeNull();
    expect(body.querySelector('.dv-craft-go')).not.toBeNull();
  });

  it('keeps the running craft cancellable when inspecting a locked recipe', () => {
    const { body, cells, skillTabs, inventory, callbacks, at } = setup();
    inventory.crafting = { iid: 33, startedAt: 0 };
    skillTabs()[3]!.click();
    cells()[1]!.click();
    at(1000);
    expect(body.querySelector('.dv-craft-preview .name')!.textContent).toBe('Metal Pickaxe');
    const cancel = body.querySelector<HTMLButtonElement>('.dv-craft-cancel')!;
    expect(cancel.getAttribute('aria-label')).toBe('Cancel crafting Campfire');
    expect(cancel.textContent).toBe('Cancel · 1.0 s');
    cancel.click();
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(body.querySelector<HTMLButtonElement>('.dv-craft-unlock')!.disabled).toBe(true);
    expect(body.querySelector('.dv-craft-go')).toBeNull();
  });

  it('stations in reach are tabs in the WHERE group; one sends the E interaction, By hand leaves an open station', () => {
    const bench: StationInReach = { areaId: 2, entity: entity(77) };
    const { body, callbacks, whereTabs, inventory, at } = setup({ reach: [bench] });
    expect(whereTabs().map(tabName)).toEqual(['By hand', 'Workbench']);
    expect(body.querySelector<HTMLElement>('.dv-craft-station-reveal')!.inert).toBe(true);
    whereTabs()[1]!.click();
    expect(callbacks.onOpenStation).toHaveBeenCalledWith(bench);

    // The server opened it: the open station is the active tab and is marked open.
    inventory.isStationOpen = true;
    inventory.stationArea = 2;
    at(1000);
    expect(body.querySelector<HTMLElement>('.dv-craft-station-reveal')!.inert).toBe(false);
    expect(whereTabs().map(tabName)).toEqual(['By hand', 'Workbench']);
    expect(whereTabs()[1]!.classList.contains('is-active')).toBe(true);
    expect(whereTabs()[1]!.classList.contains('is-open')).toBe(true);
    whereTabs()[0]!.click();
    expect(callbacks.onLeaveStation).toHaveBeenCalled();
  });

  it('inside a station: the queue shows ready / in progress / queued, a click takes or cancels, the fuel gauge counts units and time', () => {
    const { body, cells, inventory, callbacks, store, win, head, at } = setup({
      station: 2,
      unlocked: [28],
    });
    expect(head.title.textContent).toBe('Workbench');
    expect(cells().map((c) => c.dataset.iid)).toEqual(['17', '28']);
    expect(cells()[0]!.classList.contains('is-locked')).toBe(true);
    expect(body.querySelector<HTMLButtonElement>('.dv-craft-unlock')!.disabled).toBe(true);
    cells()[1]!.click();
    expect(body.querySelectorAll('.dv-craft-queue .dv-craft-queue-slot')).toHaveLength(4);

    // Slot 0 done, slot 1 half way (stated at t=1000), slot 2 waiting.
    inventory.stationQueue = [28, 28, 28, 0];
    inventory.stationActiveSlot = 1;
    inventory.stationProgress = 128;
    inventory.stationStatedAt = 1000;
    inventory.fuel = 2;
    inventory.fuelMs = 30000;
    inventory.fuelStatedAt = 1000;
    at(1000);
    const slots = Array.from(body.querySelectorAll<HTMLElement>('.dv-craft-queue-slot'));
    expect(
      slots.map((s) => s.className.replace('dv-item-slot dv-craft-queue-slot', '').trim()),
    ).toEqual(['has-item is-ready', 'has-item is-active', 'has-item is-queued', '']);
    expect(slots[0]!.title).toBe('Take Stone Wall');
    expect(slots[1]!.title).toBe('Cancel Stone Wall — ingredients drop at your feet');
    const activeFill = slots[1]!.querySelector<HTMLElement>('.dv-craft-queue-fill')!;
    expect(activeFill.style.getPropertyValue('--val')).toBe('50.2%');
    expect(slots[1]!.querySelector('.dv-craft-queue-label')!.textContent).toBe('4.0 s');
    at(3000); // 2 s later of the 8 s job: +25 %
    expect(activeFill.style.getPropertyValue('--val')).toBe('75.2%');
    slots[0]!.click();
    expect(callbacks.onTakeFromStation).toHaveBeenCalledWith(0);
    slots[2]!.click();
    expect(callbacks.onTakeFromStation).toHaveBeenCalledWith(2);
    slots[3]!.click();
    expect(callbacks.onTakeFromStation).toHaveBeenCalledTimes(2);

    // Fuel: 2 units of 15 s, stated at t=1000 -> 0:30 burning down, eased.
    const fuelText = body.querySelector('.dv-craft-fuel-text')!;
    expect(fuelText.textContent).toBe('2 / 254 · 0:28');
    const fuelFill = body.querySelector<HTMLElement>('.dv-craft-fuel-fill')!;
    const before = parseFloat(fuelFill.style.getPropertyValue('--val'));
    at(3400);
    expect(fuelFill.style.getPropertyValue('--val')).not.toBe('');
    expect(parseFloat(fuelFill.style.getPropertyValue('--val'))).toBeLessThan(before);
    expect(body.querySelector<HTMLElement>('.dv-craft-fuel-fill')).toBe(fuelFill);
    const add = body.querySelector<HTMLButtonElement>('button.dv-craft-fuel-add')!;
    expect(add.getAttribute('aria-label')).toBe('Add 15 Wood; 40 in bag');
    expect(add.disabled).toBe(false);
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenCalledWith(15);

    // No fuel: the job stalls and the Craft button says why (ingredients in hand).
    inventory.setAllSlots([{ iid: 2, count: 20, uid: 2, ammo: 0 }]);
    inventory.fuel = 0;
    inventory.fuelMs = 0;
    win.refresh(store, inventory, callbacks, { now: () => 4000 });
    expect(
      body.querySelector('.dv-craft-queue-slot.is-active .dv-craft-queue-label')!.textContent,
    ).toBe('No fuel');
    expect(body.querySelector('.dv-craft-reason')!.textContent).toBe('Needs fuel');
  });

  it('opens midway through a fuel unit and resyncs the clock immediately on updates and reopening', () => {
    const { body, inventory, at } = setup();
    const bus = new NetEventBus();
    const detach = inventory.attachBus(bus);
    let now = 1000;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const open = (fuel: number, fuelMs: number, update = 0) => {
      // Use a subarray, as packets inside a network batch have nonzero offsets.
      const bytes = new Uint8Array(20).subarray(3, 17);
      bytes.set([46, 2, 255, 0, 0, 0, 0, 0, update, fuel]);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(10, fuelMs, true);
      handleOpenBuilding(bytes, bus);
      at(now);
    };
    const text = () => body.querySelector('.dv-craft-fuel-text')!.textContent;
    try {
      open(3, 32000); // Three units, but only 32 seconds, not 45.
      expect(text()).toBe('3 / 254 · 0:32');
      expect(body.querySelector('.dv-craft-station')!.classList.contains('is-running')).toBe(true);
      const cycle = body.querySelector<HTMLElement>('.dv-craft-fuel-cycle')!;
      expect(cycle.style.getPropertyValue('--burn-angle')).toBe('48.0deg');
      now = 2000;
      at(now);
      expect(text()).toBe('3 / 254 · 0:31');
      open(3, 30500, 1); // Queue refresh with the same rounded fuel count.
      expect(inventory.fuelMs).toBe(30500);
      now = 6000;
      const refill = new Uint8Array([47, 4, 0, 0, 0, 0]);
      new DataView(refill.buffer).setUint32(2, 56900, true);
      handleNewFuelValue(refill, bus);
      at(now);
      expect(text()).toBe('4 / 254 · 0:57');
      inventory.closeContainers();
      at(now);
      const reveal = body.querySelector<HTMLElement>('.dv-craft-station-reveal')!;
      expect(reveal.inert).toBe(true);
      expect(reveal.classList.contains('is-open')).toBe(false);
      open(1, 8000); // Another instance of the same station type.
      expect(text()).toBe('1 / 254 · 0:08');
      expect(reveal.inert).toBe(false);
      expect(body.querySelector('.dv-craft-fuel-cycle')).toBe(cycle);
      now += 9000;
      at(now);
      expect(text()).toBe('1 / 254 · 0:00');
      expect(body.querySelector('.dv-craft-station')!.classList.contains('is-running')).toBe(false);
      expect(body.querySelector('.dv-craft-fuel-status')!.textContent).toBe('Empty');
    } finally {
      date.mockRestore();
      detach();
    }
  });

  it('selects a precise fuel amount, remembers it across recipe changes and waits for server inventory updates', () => {
    const { body, cells, inventory, callbacks, at } = setup({ station: 2 });
    const slider = body.querySelector<HTMLInputElement>('.dv-craft-fuel-amount')!;
    const add = body.querySelector<HTMLButtonElement>('.dv-craft-fuel-add')!;
    expect(slider.value).toBe('15');
    expect(slider.max).toBe('40');
    slider.value = '7';
    slider.dispatchEvent(new Event('input'));
    body.querySelector<HTMLButtonElement>('[aria-label="Increase fuel amount"]')!.click();
    expect(slider.value).toBe('8');
    body.querySelector<HTMLButtonElement>('[aria-label="Decrease fuel amount"]')!.click();
    expect(slider.value).toBe('7');
    expect(callbacks.onAddFuel).not.toHaveBeenCalled();
    cells()[1]!.click();
    inventory.fuel = 1;
    at(2000);
    expect(body.querySelector('.dv-craft-fuel-amount')).toBe(slider);
    expect(slider.value).toBe('7');
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenCalledWith(7);
    expect(inventory.getItemCount(1)).toBe(40);
    expect(inventory.fuel).toBe(1);
    body.querySelector<HTMLButtonElement>('.dv-craft-fuel-max')!.click();
    expect(slider.value).toBe('40');
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenLastCalledWith(40);
    inventory.isStationOpen = false;
    at(3000);
    expect(body.querySelector<HTMLElement>('.dv-craft-station-reveal')!.inert).toBe(true);
    expect(body.querySelector('.dv-craft-station-reveal')!.classList.contains('is-open')).toBe(
      false,
    );
    inventory.isStationOpen = true;
    at(4000);
    expect(body.querySelector<HTMLInputElement>('.dv-craft-fuel-amount')!.value).toBe('40');
  });

  it('limits fuel by bag contents and free capacity, including empty bags and full stations', () => {
    const { body, inventory, callbacks, at } = setup({ station: 2 });
    const slider = body.querySelector<HTMLInputElement>('.dv-craft-fuel-amount')!;
    const add = body.querySelector<HTMLButtonElement>('.dv-craft-fuel-add')!;
    inventory.fuel = 250;
    at(2000);
    expect(slider.max).toBe('4');
    expect(slider.value).toBe('4');
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenLastCalledWith(4);
    inventory.setAllSlots([{ iid: 1, count: 2, uid: 1, ammo: 0 }]);
    // Even before the next render, submission uses the current inventory.
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenLastCalledWith(2);
    expect(add.getAttribute('aria-label')).toBe('Add 2 Wood; 2 in bag');
    inventory.fuel = 254;
    at(3000);
    expect(add.disabled).toBe(true);
    expect(slider.disabled).toBe(true);
    expect(add.textContent).toBe('Full2 in bag');
    inventory.fuel = 0;
    inventory.setAllSlots([]);
    at(4000);
    expect(slider.value).toBe('0');
    expect(add.disabled).toBe(true);
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenCalledTimes(2);
    inventory.setAllSlots([{ iid: 1, count: 1, uid: 1, ammo: 0 }]);
    at(5000);
    expect(slider.value).toBe('1');
    expect(slider.disabled).toBe(true);
    expect(add.disabled).toBe(false);
    add.click();
    expect(callbacks.onAddFuel).toHaveBeenLastCalledWith(1);
  });

  it('categories highlight affordable skills and show crafting and unlocking in the same grid', () => {
    const { body, cells, callbacks, skillTabs, inventory, at } = setup({ level: 6 });
    expect(skillTabs().map(tabName)).toEqual(['Skills', 'Survival', 'Building', 'Tools']);
    expect(body.querySelector('.dv-craft-points')!.textContent).toBe('6 skill points');
    expect(body.querySelector('.dv-craft-points')!.classList.contains('is-empty')).toBe(false);
    // Survival only has a free recipe: listed, but nothing to buy.
    expect(skillTabs().map((t) => t.classList.contains('has-available'))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(body.querySelector('[data-badge]')).toBeNull();

    // A tab lists its free recipes too, marked unlocked, beside the ones to buy.
    skillTabs()[3]!.click();
    expect(cells().map((c) => c.dataset.iid)).toEqual(['15', '17']);
    expect(cells()[0]!.classList.contains('is-unlocked')).toBe(true);
    const free = body.querySelector<HTMLButtonElement>('button.dv-craft-go')!;
    expect(free.textContent).toBe('Craft · 4.0 s');
    expect(free.disabled).toBe(true);
    expect(body.querySelector('.dv-craft-unlock')).toBeNull();

    cells()[1]!.click();
    const unlock = body.querySelector<HTMLButtonElement>('button.dv-craft-unlock')!;
    expect(unlock.textContent).toBe('Unlock · 1 skill point');
    expect(unlock.disabled).toBe(false);
    unlock.click();
    expect(callbacks.onUnlock).toHaveBeenCalledWith(17);

    inventory.level = 2;
    at(1000);
    expect(body.querySelector<HTMLButtonElement>('button.dv-craft-unlock')!.disabled).toBe(true);
    expect(Array.from(body.querySelectorAll('.dv-craft-reason')).map((e) => e.textContent)).toEqual(
      ['Require level 6 or higher'],
    );
    expect(skillTabs().map((t) => t.classList.contains('has-available'))).toEqual([
      true,
      false,
      false,
      false,
    ]);

    // Perks (no recipe) are in the Skills tab with no ingredient list.
    skillTabs()[0]!.click();
    expect(cells().map((c) => c.dataset.iid)).toEqual(['162']);
    expect(body.querySelector('.dv-craft-ings')).toBeNull();
    expect(body.querySelector('.dv-craft-desc')!.textContent).toBe('One more inventory slot.');

    // Every point spent: still display the balance.
    inventory.unlockedSkills.add(162);
    inventory.unlockedSkills.add(28);
    at(1000);
    expect(body.querySelector('.dv-craft-points')!.classList.contains('is-empty')).toBe(true);
    expect(body.querySelector('.dv-craft-points')!.textContent).toBe('0 skill points');
  });

  it('an unlock becomes craftable in its category after the server confirms it and the right station opens', () => {
    const bench: StationInReach = { areaId: 2, entity: entity(77) };
    const { body, cells, skillTabs, whereTabs, inventory, callbacks, at, win } = setup({
      level: 6,
      reach: [bench],
    });
    inventory.setAllSlots([{ iid: 8, count: 6, uid: 1, ammo: 0 }]);
    skillTabs()[3]!.click();
    cells()[1]!.click();
    body.querySelector<HTMLButtonElement>('.dv-craft-unlock')!.click();
    expect(callbacks.onUnlock).toHaveBeenCalledWith(17);
    expect(body.querySelector('.dv-craft-go')).toBeNull();
    expect(cells()[1]!.getAttribute('aria-label')).toContain('Ready to unlock');

    inventory.unlockedSkills.add(17);
    at(1000);
    expect(cells()[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(body.querySelector('.dv-craft-unlock')).toBeNull();
    expect(body.querySelector<HTMLButtonElement>('.dv-craft-go')!.disabled).toBe(true);
    expect(body.querySelector('.dv-craft-reason')!.textContent).toBe('Use Workbench');

    whereTabs()[1]!.click();
    expect(callbacks.onOpenStation).toHaveBeenCalledWith(bench);
    expect(win.tab).toBe('tool');
    inventory.isStationOpen = true;
    inventory.stationArea = 2;
    inventory.fuel = 2;
    at(1000);
    expect(win.selectedIid).toBe(17);
    const craft = body.querySelector<HTMLButtonElement>('.dv-craft-go')!;
    expect(craft.disabled).toBe(false);
    craft.click();
    expect(callbacks.onCraft).toHaveBeenCalledWith(17, 2);

    inventory.stationQueue = [17, 17, 17, 17];
    at(1000);
    expect(body.querySelector<HTMLButtonElement>('.dv-craft-go')!.disabled).toBe(true);
    expect(body.querySelector('.dv-craft-reason')!.textContent).toBe('Queue is full');
  });

  it('K opens the first skill tab and the layout keeps its size classes on every tab', () => {
    const { body, win, skillTabs, at } = setup({ level: 3 });
    win.showSkills();
    at(1000);
    expect(body.querySelector('.dv-craft-unlock-tabs .dv-tab.is-active')!.textContent).toContain(
      'Skills',
    );
    for (const tab of skillTabs()) {
      tab.click();
      expect(body.querySelector('.dv-craft')).not.toBeNull();
      expect(body.querySelector('.dv-craft-grid')).not.toBeNull();
      expect(body.querySelector('.dv-craft-station')).not.toBeNull();
    }
  });
});
