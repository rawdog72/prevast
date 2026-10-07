// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/windows/chest-window.ts
// The old client's _Chest: a compact box with the container's storage slots
// (the server states how many), each drawn with the item's own button sprite;
// click a filled slot, or drag it out of the box, to take it (TAKE_ITEM), and
// right-click it for its menu (look, take). There is no inventory grid in
// here: the hotbar stays live underneath, and clicking an item there (or
// dragging it onto this box) stores it. Clicking outside the box closes it.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { InventoryStore } from '../../world/inventory-store';
import { magazine, magazineLevel, rotStage } from '../hud/hud-hotbar';
import { hoverCard } from '../hud/weapon-card';

export interface ChestWindowCallbacks {
  /** `inventorySlot`: the hotbar slot it was dragged onto, when it was. */
  onTake: (chestSlotIndex: number, inventorySlot?: number) => void;
  /** Dragged onto another slot of this container: the two swap. */
  onMove?: (from: number, to: number) => void;
  /** Right-click on a filled slot, at the pointer's client position. */
  onMenu?: (chestSlotIndex: number, clientX: number, clientY: number) => void;
}

const DRAG_THRESHOLD_PX = 4;

interface ChestDrag {
  index: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

export class ChestWindow {
  private slots: HTMLElement[] = [];
  private grid!: HTMLElement;
  private capacity!: HTMLElement;
  private callbacks!: ChestWindowCallbacks;
  private inventory!: InventoryStore;
  private content!: ContentStore;
  private drag: ChestDrag | null = null;
  private ghost: HTMLElement | null = null;

  mount(
    body: HTMLElement,
    inventory: InventoryStore,
    content: ContentStore,
    callbacks: ChestWindowCallbacks,
  ): void {
    this.callbacks = callbacks;
    this.inventory = inventory;
    this.content = content;
    this.endDrag();
    body.innerHTML = '';
    this.slots = [];

    this.grid = document.createElement('div');
    this.grid.className = 'dv-slot-grid dv-chest-grid';
    // Filled / capacity, as plain muted text under the glass (not a badge).
    this.capacity = document.createElement('div');
    this.capacity.className = 'dv-chest-capacity';

    body.append(this.grid, this.capacity);
    this.refresh(inventory, content);
  }

  refresh(inventory: InventoryStore, content: ContentStore): void {
    const count = Math.max(1, inventory.chestCapacity || inventory.chestItems.length || 4);
    const filled = inventory.chestItems.filter((it) => it.iid > 0).length;
    const capacity = `${filled} / ${count}`;
    if (this.capacity.textContent !== capacity) this.capacity.textContent = capacity;
    while (this.slots.length < count) {
      const index = this.slots.length;
      const slot = document.createElement('div');
      slot.className = 'dv-item-slot';
      slot.dataset.index = String(index);
      slot.innerHTML =
        '<span class="count"></span><span class="dv-slot-rot" hidden></span><span class="dv-slot-ammo" hidden></span>';
      slot.addEventListener('pointerdown', (ev) => this.onPointerDown(ev, index));
      slot.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
      slot.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
      slot.addEventListener('pointercancel', () => this.endDrag());
      slot.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (this.hasItem(index)) this.callbacks.onMenu?.(index, ev.clientX, ev.clientY);
      });
      hoverCard().attach(slot, this.content, () => {
        const it = this.inventory.chestItems[index];
        return it && it.iid > 0 ? it : null;
      });
      this.grid.appendChild(slot);
      this.slots.push(slot);
    }
    while (this.slots.length > count) this.slots.pop()!.remove();
    this.grid.style.gridTemplateColumns = `repeat(${Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))))}, 64px)`;

    this.slots.forEach((slot, i) => {
      const it = inventory.chestItems[i];
      const iconName =
        it && it.iid > 0 && content.has('items')
          ? content.byId('items', it.iid)?.client?.icon
          : undefined;
      slot.classList.toggle('has-item', !!iconName);
      if (iconName) {
        slot.style.setProperty('--icon', `url(${itemIconUrl(iconName)})`);
      } else {
        slot.style.removeProperty('--icon');
      }
      slot.querySelector('.count')!.textContent =
        it && it.iid > 0 && it.count > 1 ? String(it.count) : '';
      // Food keeps rotting in a chest (a fridge just slows it): same freshness bar as the hotbar.
      const stage = it && it.iid > 0 ? rotStage({ uid: 0, ...it }, content) : -1;
      const rot = slot.querySelector<HTMLElement>('.dv-slot-rot')!;
      rot.hidden = stage < 0;
      rot.style.backgroundImage = stage < 0 ? '' : `url(/img/rotten${stage}.png)`;
      // A stored gun keeps its rounds (CONTAINER_CONTENTS carries the ammo byte).
      const mag = it && it.iid > 0 ? magazine(it, content, it.mods) : null;
      const ammo = slot.querySelector<HTMLElement>('.dv-slot-ammo')!;
      ammo.hidden = !mag;
      ammo.textContent = mag ? `${mag.ammo}/${mag.size}` : '';
      if (mag) ammo.dataset.level = magazineLevel(mag);
      else delete ammo.dataset.level;
    });
  }

  private hasItem(index: number): boolean {
    const it = this.inventory.chestItems[index];
    return !!it && it.iid > 0;
  }

  private onPointerDown(ev: PointerEvent, index: number): void {
    if (ev.button !== 0 || !this.hasItem(index)) return;
    this.drag = { index, startX: ev.clientX, startY: ev.clientY, dragging: false };
    const target = ev.currentTarget as HTMLElement;
    try {
      target.setPointerCapture?.(ev.pointerId);
    } catch {
      // jsdom / synthetic events: capture is only an optimisation here.
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.dragging) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) <= DRAG_THRESHOLD_PX)
        return;
      drag.dragging = true;
      hoverCard().hide();
      this.ghost = document.createElement('div');
      this.ghost.className = 'hud-drag-ghost';
      this.ghost.style.backgroundImage =
        this.slots[drag.index]?.style.getPropertyValue('--icon') ?? '';
      document.body.append(this.ghost);
    }
    if (this.ghost) {
      this.ghost.style.left = `${ev.clientX}px`;
      this.ghost.style.top = `${ev.clientY}px`;
    }
  }

  /**
   * A click takes the item. A drag that ends on a hotbar slot takes it into
   * that slot (anywhere else outside the box: the first free one), and one
   * that ends on another slot of this box swaps the two.
   */
  private onPointerUp(ev: PointerEvent): void {
    const drag = this.drag;
    this.endDrag();
    if (!drag || !this.hasItem(drag.index)) return;
    if (!drag.dragging) {
      this.callbacks.onTake(drag.index);
      return;
    }
    const under =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(ev.clientX, ev.clientY)
        : null;
    if (under && this.grid.contains(under)) {
      const to = under.closest<HTMLElement>('.dv-item-slot')?.dataset.index;
      if (to !== undefined && Number(to) !== drag.index)
        this.callbacks.onMove?.(drag.index, Number(to));
      return;
    }
    const hotbar = under?.closest<HTMLElement>('.hud-slot')?.dataset.index;
    this.callbacks.onTake(drag.index, hotbar === undefined ? undefined : Number(hotbar));
  }

  private endDrag(): void {
    this.drag = null;
    hoverCard().hide();
    this.ghost?.remove();
    this.ghost = null;
  }
}
