// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ContentStore } from '../../content/store';
import { InventoryStore } from '../../world/inventory-store';
import { ChestWindow } from './chest-window';

function setup() {
  const inventory = new InventoryStore();
  inventory.isChestOpen = true;
  inventory.chestCapacity = 4;
  inventory.chestItems = [
    { iid: 2, count: 20, ammo: 0, mods: [] },
    { iid: 0, count: 0, ammo: 0, mods: [] },
    { iid: 15, count: 1, ammo: 0, mods: [] },
    { iid: 0, count: 0, ammo: 0, mods: [] },
  ];
  const content = new ContentStore();
  content.load({
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
        client: { icon: 'inv-stone' },
      },
      hatchet: {
        key: 'hatchet',
        id: 15,
        clientItemId: 15,
        name: 'Hatchet',
        properties: { stack: 1 },
        client: { icon: 'inv-hachet' },
      },
      pistol: {
        key: 'pistol',
        id: 22,
        clientItemId: 22,
        name: '9MM',
        properties: { stack: 1 },
        equipable: { key: 'pistol', equipTimeMs: 1000 },
        client: { icon: 'inv-9mm' },
      },
    },
  });
  content.load({
    name: 'equipables',
    version: 1,
    hash: 'h',
    attributes: {},
    entries: {
      pistol: {
        key: 'pistol',
        id: 8,
        idWeapon: 8,
        typeId: 2,
        ammo: { key: '9mm_bullet', magazineSize: 20, reloadMs: 2200 },
      },
    },
  });
  const body = document.createElement('div');
  document.body.append(body);
  const onTake = vi.fn();
  const onMenu = vi.fn();
  const onMove = vi.fn();
  const win = new ChestWindow();
  win.mount(body, inventory, content, { onTake, onMenu, onMove });
  return { inventory, content, body, onTake, onMenu, onMove, win };
}

function pointer(type: string, target: Element, x: number, y: number) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
}

function click(target: Element) {
  pointer('pointerdown', target, 10, 10);
  pointer('pointerup', target, 10, 10);
}

describe('ChestWindow (old client _Chest)', () => {
  it('shows one slot per storage slot with the item button sprite, and click takes only a filled slot', () => {
    const { body, onTake } = setup();
    const slots = Array.from(body.querySelectorAll<HTMLElement>('.dv-item-slot'));
    expect(slots).toHaveLength(4);
    expect(slots[0].style.getPropertyValue('--icon')).toContain('/icons/inv-stone.png');
    expect(slots[0].querySelector('.count')!.textContent).toBe('20');
    expect(slots[1].style.getPropertyValue('--icon')).toBe('');
    expect(slots[2].querySelector('.count')!.textContent).toBe('');

    click(slots[1]);
    expect(onTake).not.toHaveBeenCalled();
    click(slots[2]);
    expect(onTake).toHaveBeenCalledWith(2);
  });

  it('drags out to a hotbar slot or anywhere, swaps inside the box, and opens the menu on right-click', () => {
    const { body, onTake, onMenu, onMove } = setup();
    const slots = Array.from(body.querySelectorAll<HTMLElement>('.dv-item-slot'));
    let under: Element | null = null;
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => under;

    under = slots[3];
    pointer('pointerdown', slots[0], 10, 10);
    pointer('pointermove', slots[0], 40, 10);
    expect(document.querySelector('.hud-drag-ghost')).not.toBeNull();
    pointer('pointerup', slots[0], 40, 10);
    expect(onTake).not.toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledWith(0, 3);
    expect(document.querySelector('.hud-drag-ghost')).toBeNull();

    under = document.body;
    pointer('pointerdown', slots[0], 10, 10);
    pointer('pointermove', slots[0], 10, 200);
    pointer('pointerup', slots[0], 10, 200);
    expect(onTake).toHaveBeenLastCalledWith(0, undefined);

    const hotbarSlot = document.createElement('div');
    hotbarSlot.className = 'hud-slot';
    hotbarSlot.dataset.index = '6';
    document.body.append(hotbarSlot);
    under = hotbarSlot;
    pointer('pointerdown', slots[2], 10, 10);
    pointer('pointermove', slots[2], 10, 200);
    pointer('pointerup', slots[2], 10, 200);
    expect(onTake).toHaveBeenLastCalledWith(2, 6);
    hotbarSlot.remove();

    slots[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onMenu).not.toHaveBeenCalled();
    slots[2].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }),
    );
    expect(onMenu).toHaveBeenCalledWith(2, 5, 6);
  });

  it('has no inventory grid of its own -- the hotbar stores while the box is open', () => {
    const { body } = setup();
    expect(body.querySelectorAll('.dv-slot-grid')).toHaveLength(1);
    // Plain filled / capacity under the glass; no hint line, no title.
    expect(body.querySelector('.dv-chest-capacity')!.textContent).toBe('2 / 4');
  });

  it('shows a stored gun rounds/capacity like the hotbar does', () => {
    const { body, inventory, content, win } = setup();
    inventory.chestItems[3] = { iid: 22, count: 1, ammo: 3, mods: [] };
    win.refresh(inventory, content);
    const slots = Array.from(body.querySelectorAll<HTMLElement>('.dv-item-slot'));
    const ammo = slots[3].querySelector<HTMLElement>('.dv-slot-ammo')!;
    expect(ammo.hidden).toBe(false);
    expect(ammo.textContent).toBe('3/20');
    expect(ammo.dataset.level).toBe('empty');
    expect(slots[0].querySelector<HTMLElement>('.dv-slot-ammo')!.hidden).toBe(true);
  });

  it('refreshes contents in place when the server restates them', () => {
    const { body, inventory, content, win } = setup();
    inventory.chestItems[1] = { iid: 15, count: 1, ammo: 0, mods: [] };
    win.refresh(inventory, content);
    const slots = Array.from(body.querySelectorAll<HTMLElement>('.dv-item-slot'));
    expect(slots[1].style.getPropertyValue('--icon')).toContain('/icons/inv-hachet.png');
  });
});
