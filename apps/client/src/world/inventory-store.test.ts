// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { NetEventBus } from '../net/events';
import { InventoryStore } from './inventory-store';

describe('InventoryStore', () => {
  it('manages inventory slots and active item', () => {
    const store = new InventoryStore();
    expect(store.slots).toHaveLength(10);
    expect(store.getActiveItem()).toBeNull();

    store.setSlot(0, { iid: 1, count: 50, ammo: 0 });
    expect(store.getActiveItem()).toEqual({
      uid: 0,
      iid: 1,
      count: 50,
      ammo: 0,
    });

    expect(store.getItemCount(1)).toBe(50);
    expect(store.hasIngredients([{ iid: 1, amount: 20 }])).toBe(true);
    expect(store.hasIngredients([{ iid: 1, amount: 100 }])).toBe(false);

    // Switch active slot to empty slot 1
    store.activeSlot = 1;
    expect(store.getActiveItem()).toBeNull();
  });

  it('puts an item taken from a container into the slot it was dragged onto', () => {
    const inv = new InventoryStore();
    inv.applySlot(40, 2, 5, 0); // stone lands in slot 0
    inv.preferArrival(15, 0);
    inv.applySlot(41, 15, 1, 0); // hatchet would land in slot 1...
    expect(inv.getSlot(0)).toMatchObject({ uid: 41, iid: 15 }); // ...but goes where it was dropped
    expect(inv.getSlot(1)).toMatchObject({ uid: 40, iid: 2 }); // and the stone moves over
    // One wish, one arrival.
    inv.applySlot(42, 15, 1, 0);
    expect(inv.getSlot(2)).toMatchObject({ uid: 42 });
    // A wish for another item, or an expired one, changes nothing.
    inv.preferArrival(99, 5);
    inv.applySlot(43, 15, 1, 0);
    expect(inv.getSlot(3)).toMatchObject({ uid: 43 });
    inv.preferArrival(15, 6, Date.now() - 10_000);
    inv.applySlot(44, 15, 1, 0);
    expect(inv.getSlot(4)).toMatchObject({ uid: 44 });
  });

  it('keeps a placement preference through a timed install and cancels only its own request', () => {
    const inv = new InventoryStore();
    inv.preferArrival(174, 8, Date.now() - 5000, 10000);
    inv.applySlot(40, 174, 1, 12);
    expect(inv.getSlot(8)).toMatchObject({ uid: 40, ammo: 12 });
    const cancelOld = inv.preferArrival(174, 7);
    inv.preferArrival(174, 6);
    cancelOld();
    inv.applySlot(41, 174, 1, 8);
    expect(inv.getSlot(6)).toMatchObject({ uid: 41 });
    const cancel = inv.preferArrival(174, 7);
    cancel();
    inv.applySlot(42, 174, 1, 4);
    expect(inv.getSlot(7)?.iid).toBe(0);
    inv.preferArrival(174, 7);
    inv.reset();
    inv.applySlot(43, 174, 1, 4);
    expect(inv.getSlot(7)?.iid).toBe(0);
  });

  it('updates via NetEventBus events', () => {
    const bus = new NetEventBus();
    const store = new InventoryStore();
    const unbind = store.attachBus(bus);

    // fullInventory event
    bus.emit('fullInventory', {
      slots: [
        { uid: 0, iid: 7, count: 1, ammo: 0 },
        { uid: 1, iid: 2, count: 15, ammo: 0 },
      ],
    });

    expect(store.getSlot(0)?.iid).toBe(7);
    expect(store.getSlot(1)?.iid).toBe(2);
    expect(store.getSlot(1)?.count).toBe(15);

    // inventorySlot event
    bus.emit('inventorySlot', {
      uid: 1,
      iid: 2,
      count: 20,
      ammo: 0,
    });
    expect(store.getSlot(1)?.count).toBe(20);

    // fullChest: the first-open packet opens the box; refreshes only replace contents
    bus.emit('fullChest', {
      firstOpen: true,
      slots: 4,
      items: [
        { iid: 1, count: 100, ammo: 0, mods: [] },
        { iid: 3, count: 5, ammo: 0, mods: [] },
        { iid: 0, count: 0, ammo: 0, mods: [] },
        { iid: 0, count: 0, ammo: 0, mods: [] },
      ],
    });
    expect(store.isChestOpen).toBe(true);
    expect(store.chestCapacity).toBe(4);
    expect(store.chestItems).toHaveLength(4);
    store.closeContainers();
    bus.emit('fullChest', {
      firstOpen: false,
      slots: 4,
      items: [{ iid: 0, count: 0, ammo: 0, mods: [] }],
    });
    expect(store.isChestOpen).toBe(false);

    // LOST_BUILDING: the server took the container away (walked off, destroyed)
    bus.emit('fullChest', {
      firstOpen: true,
      slots: 1,
      items: [{ iid: 1, count: 1, ammo: 0, mods: [] }],
    });
    bus.emit('lostBuilding', undefined);
    expect(store.isChestOpen).toBe(false);

    // station event & fuel
    bus.emit('openBuilding', {
      area: 3,
      progress: 0,
      activeSlot: 0,
      queue: [10, 0, 0, 0],
      isLogin: 0,
      fuel: 90,
      fuelMs: 1345000,
    });
    expect(store.isStationOpen).toBe(true);
    expect(store.stationArea).toBe(3);
    expect(store.stationQueue).toEqual([10, 0, 0, 0]);
    expect(store.fuel).toBe(90);
    bus.emit('newFuelValue', { fuel: 180, fuelMs: 2695000 });
    expect(store.fuel).toBe(180);
    store.closeContainers();
    bus.emit('openBuilding', {
      area: 3,
      progress: 100,
      activeSlot: 0,
      queue: [10, 12, 0, 0],
      isLogin: 1,
      fuel: 80,
      fuelMs: 1195000,
    });
    expect(store.isStationOpen).toBe(false); // an update never re-opens the window
    expect(store.stationQueue).toEqual([10, 12, 0, 0]);

    bus.emit('startCraft', { iid: 15 });
    expect(store.crafting?.iid).toBe(15);

    // BLUEPRINT: the piece the server has us holding for building (0 = none),
    // sent when the equip countdown completes, never before.
    bus.emit('blueprint', { iid: 27 });
    expect(store.blueprintIid).toBe(27);
    bus.emit('blueprint', { iid: 0 });
    expect(store.blueprintIid).toBe(0);

    // skills event: level + xp-in-level + unlocked item ids
    bus.emit('playerXpSkill', { level: 3, xp: 120, skills: [10, 11] });
    expect(store.level).toBe(3);
    expect(store.xp).toBe(120);
    expect(store.unlockedSkills.has(10)).toBe(true);
    expect(store.unlockedSkills.has(11)).toBe(true);

    bus.emit('boughtSkill', { iid: 12 });
    expect(store.unlockedSkills.has(12)).toBe(true);

    // death event
    bus.emit('playerDie', { kills: 3 });
    expect(store.isDead).toBe(true);
    expect(store.kills).toBe(3);
    expect(store.deathItems.map((i) => i.iid)).toEqual([7, 2]);

    unbind();
    // Subsequent events after unbind should not affect store
    bus.emit('playerXp', { xp: 500 });
    expect(store.xp).toBe(120);
  });

  it('a hand craft starts on START_CRAFT, is cleared by Cancel, and dies with the player', () => {
    const bus = new NetEventBus();
    const store = new InventoryStore();
    store.attachBus(bus);
    bus.emit('startCraft', { iid: 15 });
    expect(store.crafting?.iid).toBe(15);
    store.cancelCraft();
    expect(store.crafting).toBeNull();
    bus.emit('startCraft', { iid: 33 });
    bus.emit('playerDie', { kills: 0 });
    expect(store.crafting).toBeNull();
  });

  it('fuel is stamped when stated so the gauge can burn it down between packets', () => {
    const bus = new NetEventBus();
    const store = new InventoryStore();
    store.attachBus(bus);
    const before = Date.now();
    bus.emit('openBuilding', {
      area: 6,
      progress: 0,
      activeSlot: 0,
      queue: [0, 0, 0, 0],
      isLogin: 0,
      fuel: 3,
      fuelMs: 32000,
    });
    expect(store.fuel).toBe(3);
    expect(store.fuelMs).toBe(32000);
    expect(store.fuelStatedAt).toBeGreaterThanOrEqual(before);
    store.fuelStatedAt = 0;
    bus.emit('newFuelValue', { fuel: 2, fuelMs: 29750 });
    expect(store.fuel).toBe(2);
    expect(store.fuelMs).toBe(29750);
    expect(store.fuelStatedAt).toBeGreaterThanOrEqual(before);
  });

  it("spends skill points by each unlocked item's cost, out of one point per level (old client)", () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);
    const cost = (iid: number) => ({ 10: 1, 11: 2, 12: 3 })[iid] ?? 1;

    bus.emit('playerXpSkill', { level: 5, xp: 0, skills: [10, 11] });
    expect(store.skillPointsLeft(cost)).toBe(2);
    bus.emit('boughtSkill', { iid: 12 });
    expect(store.skillPointsLeft(cost)).toBe(0);
  });
});

describe('InventoryStore slots (old client rules)', () => {
  it('fullInventory: record n is slot n and the record count is the inventory size', () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);

    const empty = { iid: 0, count: 0, uid: 0, ammo: 0 };
    bus.emit('fullInventory', {
      slots: [
        { iid: 2, count: 2, uid: 171, ammo: 0 },
        empty,
        { iid: 15, count: 1, uid: 9, ammo: 0 },
        ...Array(9).fill(empty),
      ],
    });

    expect(store.slotCount).toBe(12);
    expect(store.slots[0]).toEqual({ iid: 2, count: 2, uid: 171, ammo: 0 });
    expect(store.slots[1].iid).toBe(0);
    expect(store.slots[2]).toEqual({ iid: 15, count: 1, uid: 9, ammo: 0 });
    expect(store.slots).toHaveLength(12);
  });

  it('a later fullInventory keeps the slots the player arranged; new items take the first empty', () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);
    const empty = { iid: 0, count: 0, uid: 0, ammo: 0 };
    const stone = { iid: 2, count: 2, uid: 171, ammo: 0 };
    const hatchet = { iid: 15, count: 1, uid: 9, ammo: 0 };
    const wood = { iid: 3, count: 4, uid: 12, ammo: 0 };
    bus.emit('fullInventory', { slots: [stone, hatchet, wood, empty, empty] });

    // The player rearranges -- the server never hears of it.
    store.swapSlots(0, 3); // stone -> 3
    store.swapSlots(1, 4); // hatchet -> 4

    // A failed pickup, trade or quest reward restates the whole inventory in
    // the server's order: wood's count changed, the hatchet is gone, a reward arrived.
    const reward = { iid: 40, count: 1, uid: 77, ammo: 0 };
    bus.emit('fullInventory', { slots: [stone, reward, { ...wood, count: 9 }, empty, empty] });

    expect(store.slots.map((s) => s.uid)).toEqual([77, 0, 12, 171, 0]);
    expect(store.slots[2]!.count).toBe(9);

    // A uid now naming another item is a new item, not the old one in place.
    bus.emit('fullInventory', { slots: [{ iid: 5, count: 1, uid: 171, ammo: 0 }, reward, wood, empty, empty] });
    expect(store.slots.map((s) => s.iid)).toEqual([40, 5, 3, 0, 0]);

    // The inventory shrinking moves whatever sat past its end into a free slot.
    store.swapSlots(0, 4); // reward -> 4
    bus.emit('fullInventory', { slots: [reward, empty, wood, empty] });
    expect(store.slots.map((s) => s.uid)).toEqual([77, 0, 12, 0]);
  });

  it('inventorySlot is keyed by uid: updates that slot, clears it on iid 0, places unknown uids first-empty', () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);
    const empty = { iid: 0, count: 0, uid: 0, ammo: 0 };
    bus.emit('fullInventory', { slots: [{ iid: 2, count: 2, uid: 171, ammo: 0 }, empty, empty] });

    bus.emit('inventorySlot', { uid: 171, iid: 2, count: 5, ammo: 0 });
    expect(store.slots[0]).toEqual({ iid: 2, count: 5, uid: 171, ammo: 0 });

    bus.emit('inventorySlot', { uid: 40, iid: 15, count: 1, ammo: 7 });
    expect(store.slots[1]).toEqual({ iid: 15, count: 1, uid: 40, ammo: 7 });

    bus.emit('inventorySlot', { uid: 171, iid: 0, count: 0, ammo: 0 });
    expect(store.slots[0].iid).toBe(0);

    // inventory full and the uid is unknown: nowhere to put it, dropped
    bus.emit('inventorySlot', { uid: 41, iid: 16, count: 1, ammo: 0 });
    bus.emit('inventorySlot', { uid: 42, iid: 17, count: 1, ammo: 0 });
    bus.emit('inventorySlot', { uid: 43, iid: 18, count: 1, ammo: 0 });
    expect(store.slots.map((s) => s.iid)).toEqual([16, 15, 17]);
  });

  it('playerXp is an increment within the level; playerXpSkill is a full sync', () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);

    bus.emit('playerXpSkill', { level: 2, xp: 100, skills: [] });
    bus.emit('playerXp', { xp: 50 });
    bus.emit('playerXp', { xp: 25 });
    expect(store.level).toBe(2);
    expect(store.xp).toBe(175);
    // 900 * 1.105^2 floored per step: 900 -> 994 -> 1098
    expect(store.xpForLevel(2)).toBe(1098);
    expect(store.xpForLevel(0)).toBe(900);
  });

  it('selectedItem is the active item effect, not a hotbar selection', () => {
    const store = new InventoryStore();
    const bus = new NetEventBus();
    store.attachBus(bus);
    const empty = { iid: 0, count: 0, uid: 0, ammo: 0 };
    bus.emit('fullInventory', { slots: [empty, { iid: 15, count: 1, uid: 9, ammo: 0 }] });
    store.activeSlot = 0;

    bus.emit('selectedItem', { iid: 15 });
    expect(store.activeSlot).toBe(0);
    expect(store.selectedIid).toBe(15);
  });
});

describe('weapon mods in the inventory store', () => {
  it('keeps mods per uid and forgets them when the slot changes item or empties', () => {
    const bus = new NetEventBus();
    const store = new InventoryStore();
    store.attachBus(bus);
    bus.emit('fullInventory', { slots: [{ uid: 7, iid: 172, count: 1, ammo: 0 }] });
    bus.emit('itemMods', { uid: 7, mods: [{ slot: 0, iid: 174 }] });
    expect(store.modsOf(7)).toEqual([{ slot: 0, iid: 174 }]);
    bus.emit('inventorySlot', { uid: 7, iid: 172, count: 1, ammo: 30 }); // same gun, reloaded
    expect(store.modsOf(7)).toEqual([{ slot: 0, iid: 174 }]);
    bus.emit('inventorySlot', { uid: 7, iid: 0, count: 0, ammo: 0 });
    expect(store.modsOf(7)).toEqual([]);
    bus.emit('itemMods', { uid: 8, mods: [{ slot: 1, iid: 177 }] });
    bus.emit('fullInventory', { slots: [] });
    expect(store.modsOf(8)).toEqual([]);
  });

  it('keeps the mods of chest items', () => {
    const bus = new NetEventBus();
    const store = new InventoryStore();
    store.attachBus(bus);
    bus.emit('fullChest', {
      firstOpen: true,
      slots: 1,
      items: [{ iid: 172, count: 1, ammo: 3, mods: [{ slot: 0, iid: 174 }] }],
    });
    expect(store.chestItems[0]!.mods).toEqual([{ slot: 0, iid: 174 }]);
  });
});
