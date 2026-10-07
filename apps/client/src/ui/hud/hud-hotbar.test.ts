// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { InventoryStore } from '../../world/inventory-store';
import { MODS_IID, modsContent } from '../../world/weapon-mods.fixtures';
import { HudHotbar, magazine, type HotbarCallbacks } from './hud-hotbar';
import { itemTooltip } from './hud-item-tooltip';

function content(): ContentStore {
  const store = new ContentStore();
  store.load({
    name: 'items',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      stone: {
        key: 'stone',
        id: 2,
        clientItemId: 2,
        name: 'Stone',
        properties: { stack: 255 },
        client: { icon: 'inv-stone', description: 'Find it on the ground.' },
      },
      hatchet: {
        key: 'hatchet',
        id: 15,
        clientItemId: 15,
        name: 'Hatchet',
        properties: { stack: 1 },
        equipable: { key: 'hatchet', equipTimeMs: 1000 },
        client: { icon: 'inv-hachet', description: 'Chops wood and breaks stone.' },
      },
      steak: {
        key: 'cooked_steak',
        id: 10,
        clientItemId: 10,
        name: 'Cooked Steak',
        properties: { stack: 10 },
        equipable: { key: 'cooked_steak', equipTimeMs: 500 },
        decay: { transformTo: 'rotten_steak', timeMs: 840000 },
        client: { icon: 'inv-cooked-steak', description: 'Hot off the fire.' },
      },
      pistol: {
        key: 'pistol',
        id: 22,
        clientItemId: 22,
        name: '9MM',
        properties: { stack: 1 },
        equipable: { key: 'pistol', equipTimeMs: 1000 },
        client: { icon: 'inv-9mm', description: 'A small sidearm. Aim carefully.' },
      },
      bow: {
        key: 'wood_bow',
        id: 18,
        clientItemId: 18,
        name: 'Wood Bow',
        properties: { stack: 1 },
        equipable: { key: 'wood_bow', equipTimeMs: 1000 },
        client: { icon: 'inv-wood-bow', description: 'Arrows fly from the bag.' },
      },
      wall: {
        key: 'wood_wall',
        id: 27,
        clientItemId: 27,
        name: 'Wooden Wall',
        properties: { stack: 255 },
        equipable: { key: 'place_object', equipTimeMs: 1000 },
        client: { icon: 'inv-wood-wall', description: 'Keeps the wind and the ghouls out.' },
      },
    },
  });
  store.load({
    name: 'equipables',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      hatchet: {
        key: 'hatchet',
        id: 3,
        idWeapon: 3,
        typeId: 1,
        damage: { amount: 26, type: 'melee', knockback: 4 },
      },
      cooked_steak: {
        key: 'cooked_steak',
        id: 10,
        idWeapon: 10,
        typeId: 5,
        consumable: {
          effect: [
            { type: 'food', amount: 60 },
            { type: 'energy', amount: 20 },
            { type: 'heal', amount: 10 },
          ],
        },
      },
      place_object: { key: 'place_object', id: 21, idWeapon: 21, typeId: 6 },
      pistol: {
        key: 'pistol',
        id: 8,
        idWeapon: 8,
        typeId: 2,
        damage: { amount: 28, type: 'piercing', knockback: 1 },
        ammo: { key: '9mm_bullet', magazineSize: 20, reloadMs: 2200 },
      },
      wood_bow: {
        key: 'wood_bow',
        id: 6,
        idWeapon: 6,
        typeId: 2,
        damage: { amount: 40, type: 'piercing', knockback: 3 },
        fire: { mode: 'semi', projectileKey: 'wood_arrow' },
      },
    },
  });
  store.load({
    name: 'objects',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: { wood_wall: { key: 'wood_wall', category: 'wall', healthMax: 3000, layer: 'top' } },
  });
  return store;
}

function setup(slotCount = 8) {
  const inventory = new InventoryStore();
  const empty = { iid: 0, count: 0, uid: 0, ammo: 0 };
  const records = Array.from({ length: slotCount }, () => ({ ...empty }));
  records[0] = { iid: 2, count: 5, uid: 40, ammo: 0 };
  records[1] = { iid: 2, count: 7, uid: 41, ammo: 0 };
  records[2] = { iid: 15, count: 1, uid: 42, ammo: 0 };
  inventory.setAllSlots(records);
  const callbacks: HotbarCallbacks = {
    onSelect: vi.fn(),
    onStore: vi.fn(),
    onSplit: vi.fn(),
    onThrow: vi.fn(),
    onMenu: vi.fn(),
    onStack: vi.fn(),
    onSwap: vi.fn(),
    onBag: vi.fn(),
    onDropOnMods: vi.fn(),
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const hotbar = new HudHotbar();
  hotbar.mount(root, callbacks);
  const store = content();
  hotbar.update(inventory, store);
  const slots = () => Array.from(root.querySelectorAll<HTMLElement>('.hud-slot'));
  return { inventory, callbacks, root, hotbar, store, slots };
}

function pointer(
  type: string,
  target: Element,
  x: number,
  y: number,
  extra: Partial<PointerEventInit> = {},
) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
}

describe('HudHotbar (old client _Inventory + mouseUp)', () => {
  it('previews the hovered or dragged inventory item and routes mod drops to the exact container', () => {
    const { hotbar, slots, callbacks, root, inventory, store } = setup(13);
    const modal = document.createElement('div');
    modal.className = 'dv-modal-mods';
    modal.innerHTML = '<button class="dv-mods-slot" data-mod-slot="optic"><span>Optic</span></button>';
    document.body.append(modal);
    let under: Element = modal.querySelector('span')!;
    document.elementFromPoint = () => under;
    const source = slots()[0];
    pointer('pointerenter', source, 10, 10);
    expect(hotbar.previewIndex).toBe(0);
    pointer('pointerdown', source, 10, 10);
    pointer('pointermove', source, 50, 50);
    pointer('pointerleave', source, 50, 50);
    expect(hotbar.previewIndex).toBe(0);
    pointer('pointerup', source, 50, 50);
    expect(callbacks.onDropOnMods).toHaveBeenLastCalledWith(0, 'optic');
    expect(hotbar.previewIndex).toBeNull();

    under = modal;
    pointer('pointerdown', source, 10, 10);
    pointer('pointermove', source, 50, 50);
    pointer('pointerup', source, 50, 50);
    expect(callbacks.onDropOnMods).toHaveBeenLastCalledWith(0, null);
    expect(callbacks.onThrow).not.toHaveBeenCalled();

    inventory.setSlot(11, { iid: 2, uid: 90, count: 1 });
    root.querySelector<HTMLButtonElement>('.hud-bag')!.click();
    hotbar.update(inventory, store);
    pointer('pointerenter', slots()[11], 10, 10);
    expect(hotbar.previewIndex).toBe(11);
    root.querySelector<HTMLButtonElement>('.hud-bag')!.click();
    hotbar.update(inventory, store);
    expect(hotbar.previewIndex).toBeNull();
  });

  it('renders one slot per inventory slot up to 10, and a bag for the rest', () => {
    const small = setup(8);
    expect(small.slots()).toHaveLength(8);
    expect(small.root.querySelector<HTMLElement>('.hud-bag')!.hidden).toBe(true);

    const big = setup(15);
    expect(big.slots().filter((s) => !s.hidden)).toHaveLength(10);
    const bag = big.root.querySelector<HTMLButtonElement>('.hud-bag')!;
    expect(bag.hidden).toBe(false);
    bag.click();
    expect(big.callbacks.onBag).toHaveBeenCalledWith(true);
    big.hotbar.update(big.inventory, big.store);
    expect(big.slots().filter((s) => !s.hidden)).toHaveLength(15);
  });

  it('draws the item button sprite as the slot face with its count, and marks the active slot', () => {
    const { root, slots, inventory, hotbar, store } = setup();
    expect(slots()[0].style.getPropertyValue('--icon')).toContain('/icons/inv-stone.png');
    expect(slots()[0].querySelector('.hud-slot-count')!.textContent).toBe('5');
    expect(slots()[3].style.getPropertyValue('--icon')).toBe('');
    inventory.activeSlot = 2;
    hotbar.update(inventory, store);
    expect(slots()[2].classList.contains('is-active')).toBe(true);
    expect(root.querySelector('.hud-slot.is-active')).toBe(slots()[2]);
  });

  it('shows the freshness bar on food that rots: 20 stages from the slot ammo byte, none on other items', () => {
    const { slots, inventory, hotbar, store } = setup();
    const bar = (i: number) => slots()[i].querySelector<HTMLElement>('.hud-slot-rot')!;
    // Old client _buttonInv: img/rotten<floor(ammo / 12.8)>.png when the item perishes.
    inventory.applySlot(60, 10, 1, 255); // fresh steak
    hotbar.update(inventory, store);
    const steak = slots().findIndex((s) =>
      s.style.getPropertyValue('--icon').includes('steak'),
    );
    expect(bar(steak).hidden).toBe(false);
    expect(bar(steak).style.backgroundImage).toContain('rotten19.png');
    inventory.applySlot(60, 10, 1, 100);
    hotbar.update(inventory, store);
    expect(bar(steak).style.backgroundImage).toContain('rotten7.png');
    inventory.applySlot(60, 10, 1, 0);
    hotbar.update(inventory, store);
    expect(bar(steak).style.backgroundImage).toContain('rotten0.png');
    // Stone does not rot.
    expect(bar(0).hidden).toBe(true);
  });

  it('magazine(): rounds/capacity for a gun with a magazine, nothing for a bow or a tool', () => {
    const store = content();
    expect(magazine({ iid: 22, ammo: 7 }, store)).toEqual({ ammo: 7, size: 20 });
    expect(magazine({ iid: 18, ammo: 0 }, store)).toBeNull();
    expect(magazine({ iid: 15, ammo: 0 }, store)).toBeNull();
    expect(magazine({ iid: 0, ammo: 0 }, store)).toBeNull();
  });

  it('shows rounds/capacity on a gun slot, coloured by how full the magazine is', () => {
    const { slots, inventory, hotbar, store } = setup();
    const ammoEl = (i: number) => slots()[i].querySelector<HTMLElement>('.hud-slot-ammo')!;
    inventory.applySlot(70, 22, 1, 20); // full pistol
    hotbar.update(inventory, store);
    const gun = slots().findIndex((s) => s.style.getPropertyValue('--icon').includes('9mm'));
    expect(ammoEl(gun).hidden).toBe(false);
    expect(ammoEl(gun).textContent).toBe('20/20');
    expect(ammoEl(gun).dataset.level).toBe('ok');
    inventory.applySlot(70, 22, 1, 10); // 50 %
    hotbar.update(inventory, store);
    expect(ammoEl(gun).textContent).toBe('10/20');
    expect(ammoEl(gun).dataset.level).toBe('low');
    inventory.applySlot(70, 22, 1, 4); // 20 %
    hotbar.update(inventory, store);
    expect(ammoEl(gun).dataset.level).toBe('empty');
    inventory.applySlot(70, 22, 1, 0);
    hotbar.update(inventory, store);
    expect(ammoEl(gun).textContent).toBe('0/20');
    expect(ammoEl(gun).dataset.level).toBe('empty');
    // The count label stays empty on a gun (stack 1) so the two never collide.
    expect(slots()[gun].querySelector('.hud-slot-count')!.textContent).toBe('');
    // Stone and the hatchet have no magazine.
    expect(ammoEl(0).hidden).toBe(true);
    expect(ammoEl(2).hidden).toBe(true);
  });

  it('click selects, ctrl+click splits, right-click opens the item menu, and a click stores while a chest is open', () => {
    const { slots, callbacks, inventory, hotbar, store } = setup();
    const s0 = slots()[0];
    pointer('pointerdown', s0, 10, 10);
    pointer('pointerup', s0, 10, 10);
    expect(callbacks.onSelect).toHaveBeenCalledWith(0);

    pointer('pointerdown', s0, 10, 10, { ctrlKey: true });
    pointer('pointerup', s0, 10, 10, { ctrlKey: true });
    expect(callbacks.onSplit).toHaveBeenCalledWith(0);

    s0.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
    );
    expect(callbacks.onMenu).toHaveBeenCalledWith(0, 30, 40);
    expect(callbacks.onThrow).not.toHaveBeenCalled();

    inventory.isChestOpen = true;
    hotbar.update(inventory, store);
    pointer('pointerdown', s0, 10, 10);
    pointer('pointerup', s0, 10, 10);
    expect(callbacks.onStore).toHaveBeenCalledWith(0);
    expect(callbacks.onSelect).toHaveBeenCalledTimes(1);

    // Empty slots select (the hotkey highlight) but never store / split / throw.
    const s3 = slots()[3];
    pointer('pointerdown', s3, 10, 10);
    pointer('pointerup', s3, 10, 10);
    expect(callbacks.onStore).toHaveBeenCalledTimes(1);
  });

  it('drag beyond 4px then drop: swap onto a different item, stack onto the same stackable item, throw when dropped outside', () => {
    const { slots, callbacks, inventory } = setup();
    const [s0, s1, s2] = slots();
    let under: Element | null = null;
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => under;

    // 0 (stone) onto 2 (hatchet): different items -> local swap
    under = s2;
    pointer('pointerdown', s0, 10, 10);
    pointer('pointermove', s0, 30, 10);
    pointer('pointerup', s0, 30, 10);
    expect(callbacks.onSwap).toHaveBeenCalledWith(0, 2);
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    // 0 (stone x5) onto 1 (stone x7), both under the 255 stack -> server stack
    under = s1;
    pointer('pointerdown', s0, 10, 10);
    pointer('pointermove', s0, 40, 10);
    pointer('pointerup', s0, 40, 10);
    expect(callbacks.onStack).toHaveBeenCalledWith(0, 1);

    // dropped on nothing -> throw
    under = document.body;
    pointer('pointerdown', s0, 10, 10);
    pointer('pointermove', s0, 10, 80);
    pointer('pointerup', s0, 10, 80);
    expect(callbacks.onThrow).toHaveBeenCalledWith(0);

    // dropped on an open container -> store, not throw; on one of its slots -> into that slot
    const chest = document.createElement('div');
    chest.className = 'dv-modal-chest';
    chest.innerHTML =
      '<div class="dv-chest-grid"><div class="dv-item-slot" data-index="3"></div></div>';
    document.body.append(chest);
    under = chest;
    inventory.isChestOpen = true;
    pointer('pointerdown', s1, 10, 10);
    pointer('pointermove', s1, 10, 80);
    pointer('pointerup', s1, 10, 80);
    expect(callbacks.onStore).toHaveBeenCalledWith(1);
    under = chest.querySelector('.dv-item-slot');
    pointer('pointerdown', s1, 10, 10);
    pointer('pointermove', s1, 10, 80);
    pointer('pointerup', s1, 10, 80);
    expect(callbacks.onStore).toHaveBeenLastCalledWith(1, 3);
    expect(callbacks.onThrow).toHaveBeenCalledTimes(1);
    chest.remove();
    inventory.isChestOpen = false;

    // under 4px is a click, not a drag
    under = s2;
    pointer('pointerdown', s0, 10, 10);
    pointer('pointermove', s0, 12, 11);
    pointer('pointerup', s0, 12, 11);
    expect(callbacks.onSelect).toHaveBeenCalledWith(0);
    expect(callbacks.onSwap).toHaveBeenCalledTimes(1);
  });
});

describe('HudHotbar under the inventory zoom (Options > Interface size)', () => {
  it('mounts the bag button and its columns into the bottom-right corner root when given one', () => {
    const { root, callbacks } = setup(15);
    const corner = document.createElement('div');
    const hb = new HudHotbar();
    const other = document.createElement('div');
    hb.mount(other, callbacks, corner);
    expect(corner.querySelector('.hud-bag')).not.toBeNull();
    expect(corner.querySelector('.hud-bag-area')).not.toBeNull();
    expect(other.querySelector('.hud-bag')).toBeNull();
    // Without one, everything stays in the hotbar root (as the older tests mount it).
    expect(root.querySelector('.hud-bag')).not.toBeNull();
  });

  it('draws the drag ghost on the page, over any window, at clientX / zoom so it follows the pointer', () => {
    const { slots, hotbar, root } = setup();
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => document.body;
    hotbar.setScale(2);
    pointer('pointerdown', slots()[0], 10, 10);
    pointer('pointermove', slots()[0], 100, 60);
    const ghost = document.querySelector<HTMLElement>('.hud-drag-ghost')!;
    expect(ghost.parentElement).toBe(document.body);
    expect(root.contains(ghost)).toBe(false);
    expect(ghost.hidden).toBe(false);
    expect(ghost.style.zoom).toBe('2');
    expect(ghost.style.left).toBe('50px');
    expect(ghost.style.top).toBe('30px');
    pointer('pointerup', slots()[0], 100, 60);
    expect(document.querySelector('.hud-drag-ghost')).toBeNull();
  });
});

describe('itemTooltip (old client itemstatsfunc)', () => {
  const store = content();
  it('names weapons with their damage, consumables with food / heal / energy, buildings with life', () => {
    expect(itemTooltip(store, 15)).toEqual({
      name: 'Hatchet',
      description: 'Chops wood and breaks stone.',
      stat: 'Damage: 26',
    });
    expect(itemTooltip(store, 10)).toEqual({
      name: 'Cooked Steak',
      description: 'Hot off the fire.',
      stat: 'Food: 60 Heal: 10 Energy: 20',
    });
    expect(itemTooltip(store, 27)).toEqual({
      name: 'Wooden Wall',
      description: 'Keeps the wind and the ghouls out.',
      stat: 'Life: 3000',
    });
    expect(itemTooltip(store, 2)).toEqual({
      name: 'Stone',
      description: 'Find it on the ground.',
      stat: 'Cannot be equipped',
    });
    expect(itemTooltip(store, 999)).toBeNull();
  });
});

describe('hotbar tooltip (old client drawDarkBox over activeInventorySlot = the hovered slot)', () => {
  it('is hidden until the pointer is over an item slot, then names that item, and hides on leave', () => {
    const { root, slots, inventory, hotbar, store } = setup();
    const tooltip = root.querySelector<HTMLElement>('.hud-item-tooltip')!;
    // Slot 0 is equipped on login; the box must NOT show for it.
    inventory.activeSlot = 0;
    hotbar.update(inventory, store);
    expect(tooltip.hidden).toBe(true);

    slots()[2].dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    hotbar.update(inventory, store);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.querySelector('.hud-item-tooltip-name')!.textContent).toBe('Hatchet');

    slots()[2].dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    hotbar.update(inventory, store);
    expect(tooltip.hidden).toBe(true);
  });

  it('stays hidden over an empty slot', () => {
    const { root, slots, inventory, hotbar, store } = setup();
    const tooltip = root.querySelector<HTMLElement>('.hud-item-tooltip')!;
    slots()[3].dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    hotbar.update(inventory, store);
    expect(tooltip.hidden).toBe(true);
  });

  it('sits over the hovered slot from its screen rect divided by the zoom -- bag slots included', () => {
    const { callbacks, inventory, store } = setup(15);
    // Slot 12 lives in a bag column in the bottom-right corner, a different root.
    for (let i = 0; i < inventory.slotCount; i++) inventory.setSlot(i, {});
    inventory.setSlot(12, { iid: 15, count: 1, uid: 60, ammo: 0 });
    const root = document.createElement('div');
    const corner = document.createElement('div');
    document.body.append(root, corner);
    const hotbar = new HudHotbar();
    hotbar.mount(root, callbacks, corner);
    hotbar.setScale(2);
    (window as unknown as { innerHeight: number }).innerHeight = 1000;
    (window as unknown as { innerWidth: number }).innerWidth = 2000;
    hotbar.update(inventory, store);
    corner.querySelector<HTMLButtonElement>('.hud-bag')!.click();
    hotbar.update(inventory, store);
    // Columns are prepended (newest on top), so slot 12 is the corner's first slot element.
    const slot = corner.querySelectorAll<HTMLElement>('.hud-slot')[0]!;
    expect(slot.hidden).toBe(false);
    slot.getBoundingClientRect = () =>
      ({ left: 1500, top: 700, width: 128, height: 128, right: 1628, bottom: 828 }) as DOMRect;

    slot.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    hotbar.update(inventory, store);
    const tooltip = root.querySelector<HTMLElement>('.hud-item-tooltip')!;
    expect(tooltip.hidden).toBe(false);
    // Centre x 1564 visual px -> 782 own px at zoom 2; bottom edge 5 px above the slot's top.
    expect(tooltip.style.left).toBe('782px');
    expect(tooltip.style.bottom).toBe('155px');

    // If hovering a lower slot in the same column, tooltip still sits above the topmost slot of the column
    const lowerSlot = corner.querySelectorAll<HTMLElement>('.hud-slot')[1]!;
    lowerSlot.getBoundingClientRect = () =>
      ({ left: 1500, top: 838, width: 128, height: 128, right: 1628, bottom: 966 }) as DOMRect;
    inventory.setSlot(12, {});
    inventory.setSlot(11, { iid: 15, count: 1, uid: 61, ammo: 0 });
    lowerSlot.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    hotbar.update(inventory, store);
    expect(tooltip.style.bottom).toBe('155px');
  });

  it('keeps the box inside the window when the slot sits at the edge (the last bag column)', () => {
    const { root, slots, inventory, hotbar, store } = setup();
    (window as unknown as { innerWidth: number }).innerWidth = 1000;
    const tooltip = root.querySelector<HTMLElement>('.hud-item-tooltip')!;
    Object.defineProperty(tooltip, 'offsetWidth', { value: 240, configurable: true });
    slots()[2].getBoundingClientRect = () =>
      ({ left: 960, top: 700, width: 40, height: 40, right: 1000, bottom: 740 }) as DOMRect;
    slots()[2].dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    hotbar.update(inventory, store);
    // Centre would be 980; the 240 px box is held 8 px in from the right edge instead.
    expect(tooltip.style.left).toBe('872px');
  });
});

describe('magazine with weapon mods', () => {
  const content = modsContent();
  it('reads capacity from the fitted magazine, and 0/0 with none fitted', () => {
    expect(
      magazine({ iid: MODS_IID.gun, ammo: 12 }, content, [{ slot: 0, iid: MODS_IID.mag40 }]),
    ).toEqual({ ammo: 12, size: 40 });
    expect(magazine({ iid: MODS_IID.gun, ammo: 0 }, content, [])).toEqual({ ammo: 0, size: 0 });
  });
  it('shows a loose magazine`s own rounds', () => {
    expect(magazine({ iid: MODS_IID.mag30, ammo: 22 }, content)).toEqual({ ammo: 22, size: 30 });
  });
  it('has no badge for a mod that is not a magazine', () => {
    expect(magazine({ iid: MODS_IID.scope, ammo: 0 }, content)).toBeNull();
  });
});
