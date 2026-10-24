// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/ui/hud/hud-hotbar.ts
// DOM hotbar after the old client's _Inventory / mouseUp: one slot per
// inventory slot (the first ten in a row at the bottom, the rest behind a bag
// button that stacks them up in columns of three), the item's own button
// sprite as the slot face, the "dark box" tooltip over the hovered slot, and
// the whole interaction set -- click to equip (or store while a chest is open),
// ctrl+click to split, right-click for the item menu (look, trade with…,
// drop), drag to reorder (same stackable item: a server STACK; different: a
// swap the server is told of), drag onto the world to throw (or onto an open
// container to store). Esc or a right-click cancels a drag, and letting go
// anywhere that is not a slot, a window that takes items, or the world itself
// cancels it too, so an item is never thrown by a near miss.
//
// What is on comes from the server (EQUIPMENT_STATE), by item uid: the item in
// hand wears the strong mark and a hand badge, the clothes worn a quieter one
// and a clothing badge, and an equip under way fills its slot as it runs. A
// slot whose stack grows (a pickup, a take, a stack) flashes once.

import { itemIconUrl } from '../../assets/asset-loader';
import type { ContentStore } from '../../content/store';
import type { InventoryItem, InventoryStore } from '../../world/inventory-store';
import { magazineCapacity, modByIid, takesMods, type FittedMod } from '../../world/weapon-mods';
import { icon } from '../dom/icons';
import { cardKey, itemCard, renderItemCard } from './weapon-card';

export const HOTBAR_SLOTS = 10;
/** Own px between the tooltip's bottom edge and the top of the slot it names. */
const TOOLTIP_GAP = 5;
/** Own px the tooltip keeps from the window's side edges. */
const TOOLTIP_EDGE = 8;
const BAG_COLUMN = 3;
const DRAG_THRESHOLD_PX = 4;
/** How long a slot glows after its stack grows. */
export const PICKUP_FLASH_MS = 450;
/** rotten0..rotten19: the old client's 20-step freshness bar (Math.floor(ammo / 12.8)). */
const ROT_STAGES = 20;

/** Freshness stage of a perishable item (0 rotten .. 19 fresh), or -1 when it does not rot. */
export function rotStage(item: InventoryItem, content: ContentStore): number {
  if (!content.has('items')) return -1;
  const def = content.byId('items', item.iid) as { decay?: unknown } | undefined;
  if (!def?.decay) return -1;
  return Math.min(ROT_STAGES - 1, Math.floor(item.ammo / (256 / ROT_STAGES)));
}

export interface Magazine {
  /** Rounds in the gun: the slot's ammo byte (Player::syncEquippedAmmo). */
  ammo: number;
  /** The weapon's `ammo.magazineSize`, or the fitted magazine's capacity for a gun that takes mods. */
  size: number;
}

/**
 * The magazine of a gun that reloads from the bag, or null for anything else.
 * Old _buttonInv drew the slot's ammo byte on every item with a `bullet`
 * except the bow (mMVwm), which fires arrows straight from the inventory --
 * here that is exactly the equipables with an `ammo` block. A loose magazine
 * mod shows its own rounds; a gun that takes mods reads its capacity from the
 * magazine fitted in `mods`.
 */
export function magazine(
  item: Pick<InventoryItem, 'iid' | 'ammo'>,
  content: ContentStore,
  mods: readonly FittedMod[] = [],
): Magazine | null {
  if (item.iid <= 0 || !content.has('items')) return null;
  // A loose magazine carries its own rounds.
  const mod = modByIid(content, item.iid);
  if (mod) return mod.slot === 'magazine' ? { ammo: item.ammo, size: mod.capacity ?? 0 } : null;
  if (!content.has('equipables')) return null;
  const size = magazineCapacity(content, item.iid, mods);
  if (size === null) return null;
  // A gun with a magazine slot shows 0/0 when none is fitted, so it reads as
  // "needs a magazine" rather than as a gun that takes no ammo.
  return size > 0 || takesMods(content, item.iid) ? { ammo: item.ammo, size } : null;
}

/** Colour band of a magazine readout by how full it is: past half, half or less, a fifth or less. */
export function magazineLevel(m: Magazine): 'ok' | 'low' | 'empty' {
  const pct = m.size > 0 ? m.ammo / m.size : 0;
  if (pct <= 0.2) return 'empty';
  return pct <= 0.5 ? 'low' : 'ok';
}

export interface HotbarCallbacks {
  onSelect: (index: number) => void;
  /** `containerSlot`: the open container's slot it was dropped on, when there was one. */
  onStore: (index: number, containerSlot?: number) => void;
  onSplit: (index: number) => void;
  onThrow: (index: number) => void;
  /** null means the window background, rather than an attachment container. */
  onDropOnMods?: (index: number, slot: string | null) => void;
  /** Right-click on an item: its menu, at the pointer's client position. */
  onMenu: (index: number, clientX: number, clientY: number) => void;
  onStack: (from: number, to: number) => void;
  onSwap: (from: number, to: number) => void;
  onBag: (open: boolean) => void;
}

/** What dropping slot `from` onto slot `to` means (old client mouseUp). */
export function dropAction(
  inventory: InventoryStore,
  content: ContentStore,
  from: number,
  to: number,
): 'stack' | 'swap' | 'none' {
  if (from === to) return 'none';
  const a = inventory.getSlot(from);
  const b = inventory.getSlot(to);
  if (!a || !b || a.iid === 0) return 'none';
  if (a.iid === b.iid) {
    const stack =
      (content.has('items') ? content.byId('items', a.iid)?.properties?.stack : undefined) ?? 1;
    if (stack > a.count && stack > b.count) return 'stack';
  }
  return 'swap';
}

/** Where a dragged item would land if let go here. */
export type DropTarget =
  | { kind: 'slot'; index: number }
  | { kind: 'mods'; slot: string | null }
  | { kind: 'store'; slot?: number }
  | { kind: 'world' }
  | { kind: 'none' };

/**
 * The world canvas, as opposed to any piece of UI over it: the HUD and the
 * window layers are pointer-events:none except their real controls, so a
 * point over open ground hits the canvas itself.
 */
export function isWorldElement(el: Element): boolean {
  return el.tagName === 'CANVAS' && !el.closest('.hud-root, .dv-modal-root');
}

interface DragState {
  index: number;
  /** The pressed item's uid, null on an empty slot: if the slot stops holding it, the press is over. */
  uid: number | null;
  startX: number;
  startY: number;
  dragging: boolean;
}

type Badge = '' | 'held' | 'worn';

export class HudHotbar {
  bagOpen = false;

  private mounted = false;
  private root!: HTMLElement;
  private row!: HTMLElement;
  private bagArea!: HTMLElement;
  private bagBtn!: HTMLButtonElement;
  private ghost!: HTMLElement;
  private tooltip!: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private callbacks!: HotbarCallbacks;
  private inventory: InventoryStore | null = null;
  private content: ContentStore | null = null;
  private drag: DragState | null = null;
  /** The slot under the pointer (old client activeInventorySlot, set from mouseMove), -1 for none. */
  private hoverSlot = -1;
  private lastTooltipKey = '';
  private lastTooltipLayout = '';
  private readonly slotIcons: string[] = [];
  /** Freshness stage last written per slot (-1 = no bar), so the style is only touched on change. */
  private readonly slotRot: number[] = [];
  /** Magazine text last written per slot ('' = none). */
  private readonly slotAmmo: string[] = [];
  /** Held / worn badge last written per slot. */
  private readonly slotBadge: Badge[] = [];
  /** Equip progress last written per slot, in whole percent (-1 = none). */
  private readonly slotEquip: number[] = [];
  /** The slot last drawn as the drop target, -1 for none. */
  private dropSlot = -1;
  /** Every item seen on the last update, by uid, to tell a stack that grew. */
  private lastSeen = new Map<number, { iid: number; count: number }>();
  /** When each item's pickup flash ends, by uid, so it follows the item if dragged. */
  private readonly flashUntil = new Map<number, number>();

  /** The inventory region's CSS zoom: the fixed drag ghost converts pointer px through it. */
  private scale = 1;

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !this.drag?.dragging) return;
    // The drag eats this Escape: it should not also close the window behind it.
    ev.preventDefault();
    ev.stopPropagation();
    this.endDrag();
  };
  private readonly onContextMenu = (ev: MouseEvent): void => {
    if (!this.drag?.dragging) return;
    ev.preventDefault();
    this.endDrag();
  };
  private readonly onBlur = (): void => {
    if (this.drag) this.endDrag();
  };

  /**
   * `bagRoot` is the bottom-right corner (its own grid cell, zoomed like the
   * hotbar) the bag button and its columns live in; by default the hotbar root.
   */
  mount(root: HTMLElement, callbacks: HotbarCallbacks, bagRoot: HTMLElement = root): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root = root;
    this.callbacks = callbacks;
    root.innerHTML = '';
    if (bagRoot !== root) bagRoot.innerHTML = '';

    this.row = document.createElement('div');
    this.row.className = 'hud-hotbar-row';
    this.bagArea = document.createElement('div');
    this.bagArea.className = 'hud-bag-area';
    this.bagArea.hidden = true;
    this.bagBtn = document.createElement('button');
    this.bagBtn.type = 'button';
    this.bagBtn.className = 'hud-btn hud-bag';
    this.bagBtn.innerHTML = icon('bag');
    this.bagBtn.setAttribute('data-hint', 'Bag');
    this.bagBtn.hidden = true;
    this.bagBtn.addEventListener('click', () => {
      this.bagOpen = !this.bagOpen;
      this.callbacks.onBag(this.bagOpen);
    });
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'hud-item-tooltip dv-panel';
    this.tooltip.hidden = true;
    this.ghost = document.createElement('div');
    this.ghost.className = 'hud-drag-ghost';
    this.ghost.hidden = true;

    root.append(this.tooltip, this.row);
    bagRoot.append(this.bagArea, this.bagBtn);
  }

  /** Options > Interface size: the effective zoom of the inventory region. */
  setScale(scale: number): void {
    this.scale = scale || 1;
  }

  /** The existing inventory drives mod previews, including during pointer capture. */
  get previewIndex(): number | null {
    const index = this.drag?.dragging ? this.drag.index : this.hoverSlot;
    return index >= 0 && !this.slots[index]?.hidden && this.hasItem(index) ? index : null;
  }

  /** True while an item is being dragged (past the click threshold). */
  get isDragging(): boolean {
    return !!this.drag?.dragging;
  }

  toggleBag(): void {
    if (!this.mounted) return;
    const count = this.inventory?.slotCount ?? 0;
    if (count <= HOTBAR_SLOTS) return;
    this.bagOpen = !this.bagOpen;
    this.bagArea.hidden = !this.bagOpen;
    this.callbacks.onBag(this.bagOpen);
  }

  update(inventory: InventoryStore, content: ContentStore, now = Date.now()): void {
    this.inventory = inventory;
    this.content = content;
    const count = inventory.slotCount;
    while (this.slots.length < count) this.slots.push(this.createSlot(this.slots.length));
    while (this.slots.length > count) {
      this.slots.pop()!.remove();
      // A slot made again later starts from nothing written.
      this.slotIcons.length = this.slotRot.length = this.slotAmmo.length = this.slots.length;
      this.slotBadge.length = this.slotEquip.length = this.slots.length;
    }

    const hasBag = count > HOTBAR_SLOTS;
    this.bagBtn.hidden = !hasBag;
    this.bagArea.hidden = !hasBag || !this.bagOpen;

    // The item being dragged went away (eaten, dropped, traded, a resync moved
    // it) or its slot was hidden: the drag has nothing left to carry.
    const drag = this.drag;
    if (drag && drag.uid !== null) {
      const pressed = inventory.getSlot(drag.index);
      const hidden = drag.index >= HOTBAR_SLOTS && !this.bagOpen;
      if (!pressed || pressed.iid === 0 || pressed.uid !== drag.uid || hidden) this.endDrag();
    }

    const heldSlot = inventory.slotOfUid(inventory.equippedWeaponUid);
    const wornSlot = inventory.slotOfUid(inventory.equippedWearableUid);
    const seen = new Map<number, { iid: number; count: number }>();
    // Nothing to compare against at login, or right after the bag was empty: no flashes.
    const compare = this.lastSeen.size > 0;

    for (let i = 0; i < count; i++) {
      const slot = this.slots[i];
      const inBag = i >= HOTBAR_SLOTS;
      slot.hidden = inBag && !this.bagOpen;

      const item = inventory.getSlot(i);
      const hasItem = !!item && item.iid > 0;
      slot.classList.toggle('has-item', hasItem);
      slot.classList.toggle('is-held', hasItem && i === heldSlot);
      slot.classList.toggle('is-worn', hasItem && i === wornSlot);

      const badge: Badge = !hasItem ? '' : i === heldSlot ? 'held' : i === wornSlot ? 'worn' : '';
      if (this.slotBadge[i] !== badge) {
        this.slotBadge[i] = badge;
        const badgeEl = slot.querySelector<HTMLElement>('.hud-slot-badge')!;
        badgeEl.hidden = !badge;
        badgeEl.innerHTML =
          badge === 'held' ? icon('hand') : badge === 'worn' ? icon('clothing') : '';
        if (badge) badgeEl.dataset.kind = badge;
        else delete badgeEl.dataset.kind;
        badgeEl.title = badge === 'held' ? 'In hand' : badge === 'worn' ? 'Wearing' : '';
      }

      // An equip under way fills the slot from the bottom as it runs.
      const progress = hasItem ? inventory.equipProgress(item.uid, now) : null;
      const pct = progress === null ? -1 : Math.round(progress * 100);
      if (this.slotEquip[i] !== pct) {
        this.slotEquip[i] = pct;
        slot.classList.toggle('is-equipping', pct >= 0);
        if (pct >= 0) slot.style.setProperty('--equip', `${pct}%`);
        else slot.style.removeProperty('--equip');
      }

      if (hasItem) {
        seen.set(item.uid, { iid: item.iid, count: item.count });
        const before = this.lastSeen.get(item.uid);
        const grew = before ? before.iid === item.iid && item.count > before.count : compare;
        if (grew) this.flash(slot, item.uid, now);
      }
      const flashing = hasItem && (this.flashUntil.get(item.uid) ?? 0) > now;
      if (!flashing && slot.classList.contains('is-flash')) slot.classList.remove('is-flash');
      else if (flashing && !slot.classList.contains('is-flash')) slot.classList.add('is-flash');

      const iconName = hasItem
        ? content.has('items')
          ? content.byId('items', item.iid)?.client?.icon
          : undefined
        : undefined;
      // Per-frame update: only write styles when the icon actually changed.
      if (this.slotIcons[i] !== (iconName ?? '')) {
        this.slotIcons[i] = iconName ?? '';
        if (iconName) {
          slot.style.setProperty('--icon', `url(${itemIconUrl(iconName)})`);
        } else {
          slot.style.removeProperty('--icon');
        }
      }
      const countText = hasItem && item.count > 1 ? String(item.count) : '';
      const countEl = slot.querySelector('.hud-slot-count')!;
      if (countEl.textContent !== countText) countEl.textContent = countText;

      // Old _buttonInv: food that perishes wears img/rotten<stage>.png, the
      // stage being the slot's ammo byte (255 fresh .. 0 rotten) in 20 steps.
      const stage = hasItem ? rotStage(item, content) : -1;
      if (this.slotRot[i] !== stage) {
        this.slotRot[i] = stage;
        const rot = slot.querySelector<HTMLElement>('.hud-slot-rot')!;
        rot.hidden = stage < 0;
        rot.style.backgroundImage = stage < 0 ? '' : `url(/img/rotten${stage}.png)`;
      }

      // A gun's magazine, where the old client put its yellow "x<ammo>":
      // rounds/capacity, dimming to amber at half and red near empty.
      const mag = hasItem ? magazine(item, content, inventory.modsOf(item.uid)) : null;
      const ammoText = mag ? `${mag.ammo}/${mag.size}` : '';
      if (this.slotAmmo[i] !== ammoText) {
        this.slotAmmo[i] = ammoText;
        const ammoEl = slot.querySelector<HTMLElement>('.hud-slot-ammo')!;
        ammoEl.hidden = !mag;
        ammoEl.textContent = ammoText;
        if (mag) ammoEl.dataset.level = magazineLevel(mag);
        else delete ammoEl.dataset.level;
      }
    }
    this.lastSeen = seen;
    for (const [uid, until] of this.flashUntil) {
      if (until <= now || !seen.has(uid)) this.flashUntil.delete(uid);
    }

    this.updateTooltip(inventory, content);
  }

  /** Start (or restart) a slot's pickup flash. */
  private flash(slot: HTMLElement, uid: number, now: number): void {
    const running = (this.flashUntil.get(uid) ?? 0) > now;
    this.flashUntil.set(uid, now + PICKUP_FLASH_MS);
    if (running && slot.classList.contains('is-flash')) {
      // Restart the animation: off, a layout read, on again.
      slot.classList.remove('is-flash');
      void slot.offsetWidth;
      slot.classList.add('is-flash');
    }
  }

  private createSlot(index: number): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'hud-slot';
    slot.dataset.index = String(index);
    const key = document.createElement('span');
    key.className = 'hud-slot-key';
    key.textContent = index < HOTBAR_SLOTS ? (index === 9 ? '0' : String(index + 1)) : '';
    const count = document.createElement('span');
    count.className = 'hud-slot-count';
    const rot = document.createElement('span');
    rot.className = 'hud-slot-rot';
    rot.hidden = true;
    const ammo = document.createElement('span');
    ammo.className = 'hud-slot-ammo';
    ammo.hidden = true;
    const badge = document.createElement('span');
    badge.className = 'hud-slot-badge';
    badge.hidden = true;
    slot.append(key, count, rot, ammo, badge);

    slot.addEventListener('pointerdown', (ev) => this.onPointerDown(ev, index));
    slot.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    slot.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    slot.addEventListener('pointercancel', () => this.endDrag());
    slot.addEventListener('pointerenter', () => {
      this.hoverSlot = index;
    });
    slot.addEventListener('pointerleave', () => {
      if (this.hoverSlot === index) this.hoverSlot = -1;
    });
    slot.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      // A right-click during a drag only cancels it (see onContextMenu).
      if (this.drag?.dragging) return;
      if (this.hasItem(index)) this.callbacks.onMenu(index, ev.clientX, ev.clientY);
    });

    if (index < HOTBAR_SLOTS) {
      this.row.appendChild(slot);
    } else {
      // Old client: bag slots climb in columns of three, newest column leftmost.
      const column = Math.floor((index - HOTBAR_SLOTS) / BAG_COLUMN);
      let col = this.bagArea.children[column] as HTMLElement | undefined;
      if (!col) {
        col = document.createElement('div');
        col.className = 'hud-bag-column';
        this.bagArea.appendChild(col);
      }
      col.prepend(slot);
    }
    return slot;
  }

  private hasItem(index: number): boolean {
    const item = this.inventory?.getSlot(index);
    return !!item && item.iid > 0;
  }

  private onPointerDown(ev: PointerEvent, index: number): void {
    if (ev.button !== 0) {
      // Any other button while dragging calls the drag off.
      if (this.drag?.dragging) this.endDrag();
      return;
    }
    const item = this.inventory?.getSlot(index);
    const uid = item && item.iid > 0 ? item.uid : null;
    this.drag = { index, uid, startX: ev.clientX, startY: ev.clientY, dragging: false };
    const target = ev.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(ev.pointerId);
      } catch {
        // jsdom / synthetic events: capture is only an optimisation here.
      }
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.dragging && typeof ev.buttons === 'number' && ev.buttons & 2) {
      // The right button went down mid-drag (a chord reaches us as a move).
      this.endDrag();
      return;
    }
    if (!drag.dragging) {
      if (!this.hasItem(drag.index)) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      const iconOut = this.slots[drag.index]?.style.getPropertyValue('--icon') ?? '';
      this.ghost.style.backgroundImage = iconOut;
      // On the page itself for the length of the drag, not inside the hotbar:
      // the hotbar is its own stacking context under the windows, so a ghost in
      // it slid beneath an open container instead of over it. It carries the
      // inventory zoom itself so it keeps the size it had there.
      this.ghost.style.zoom = String(this.scale);
      this.ghost.hidden = false;
      document.body.append(this.ghost);
      this.slots[drag.index]?.classList.add('is-drag-source');
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('contextmenu', this.onContextMenu, true);
      window.addEventListener('blur', this.onBlur);
    }
    // position:fixed with its own zoom: its px are zoomed, the pointer's are not.
    this.ghost.style.left = `${ev.clientX / this.scale}px`;
    this.ghost.style.top = `${ev.clientY / this.scale}px`;
    this.showDropTarget(this.dropTargetAt(ev.clientX, ev.clientY));
  }

  private onPointerUp(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.dragging) {
      this.endDrag();
      this.click(drag.index, ev.ctrlKey);
      return;
    }
    const target = this.dropTargetAt(ev.clientX, ev.clientY);
    this.endDrag();
    switch (target.kind) {
      case 'slot': {
        if (!this.inventory || !this.content) return;
        const action = dropAction(this.inventory, this.content, drag.index, target.index);
        if (action === 'stack') this.callbacks.onStack(drag.index, target.index);
        else if (action === 'swap') this.callbacks.onSwap(drag.index, target.index);
        return;
      }
      case 'mods':
        this.callbacks.onDropOnMods?.(drag.index, target.slot);
        return;
      case 'store':
        if (target.slot === undefined) this.callbacks.onStore(drag.index);
        else this.callbacks.onStore(drag.index, target.slot);
        return;
      case 'world':
        this.callbacks.onThrow(drag.index);
        return;
      case 'none':
        return;
    }
  }

  private click(index: number, ctrl: boolean): void {
    if (!this.hasItem(index)) {
      this.callbacks.onSelect(index);
      return;
    }
    if (this.inventory?.isChestOpen) this.callbacks.onStore(index);
    else if (ctrl) this.callbacks.onSplit(index);
    else this.callbacks.onSelect(index);
  }

  /**
   * What letting go at this point would do. A slot (any of ours, the source
   * included -- dropping back is a no-op), an attachment window, an open
   * container, or open ground; anything else (the gap between slots, chat,
   * the minimap, another window, off the page) is nothing.
   */
  dropTargetAt(x: number, y: number): DropTarget {
    const el =
      typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    if (!(el instanceof Element)) return { kind: 'none' };
    const slot = el.closest<HTMLElement>('.hud-slot');
    if (slot && (this.root.contains(slot) || this.bagArea.contains(slot))) {
      const index = Number(slot.dataset.index);
      return Number.isFinite(index) ? { kind: 'slot', index } : { kind: 'none' };
    }
    if (el.closest('.dv-modal-mods')) {
      return {
        kind: 'mods',
        slot: el.closest<HTMLElement>('.dv-mods-slot')?.dataset.modSlot ?? null,
      };
    }
    if (this.inventory?.isChestOpen && el.closest('.dv-modal-chest')) {
      // The open container's slot under the point (chest-window.ts), or its box but no slot.
      const index = el.closest<HTMLElement>('.dv-chest-grid .dv-item-slot')?.dataset.index;
      return index === undefined ? { kind: 'store' } : { kind: 'store', slot: Number(index) };
    }
    if (isWorldElement(el)) return { kind: 'world' };
    return { kind: 'none' };
  }

  /** Mark where the drag would land: the target slot (stack or swap) and the ghost's state. */
  private showDropTarget(target: DropTarget): void {
    const drag = this.drag;
    let slotIndex = -1;
    let action: 'stack' | 'swap' | 'none' = 'none';
    if (
      drag &&
      target.kind === 'slot' &&
      target.index !== drag.index &&
      this.inventory &&
      this.content
    ) {
      action = dropAction(this.inventory, this.content, drag.index, target.index);
      if (action !== 'none') slotIndex = target.index;
    }
    if (this.dropSlot !== slotIndex) {
      const old = this.slots[this.dropSlot];
      if (old) {
        old.classList.remove('is-drop-target');
        delete old.dataset.drop;
      }
      this.dropSlot = slotIndex;
    }
    const next = this.slots[slotIndex];
    if (next) {
      next.classList.add('is-drop-target');
      next.dataset.drop = action;
    }
    const ghostState =
      target.kind === 'world'
        ? 'drop'
        : target.kind === 'store' || target.kind === 'mods'
          ? 'store'
          : target.kind === 'slot'
            ? 'slot'
            : 'cancel';
    if (this.ghost.dataset.drop !== ghostState) this.ghost.dataset.drop = ghostState;
  }

  private endDrag(): void {
    if (this.drag?.dragging) {
      this.hoverSlot = -1;
      this.slots[this.drag.index]?.classList.remove('is-drag-source');
    }
    const old = this.slots[this.dropSlot];
    if (old) {
      old.classList.remove('is-drop-target');
      delete old.dataset.drop;
    }
    this.dropSlot = -1;
    this.drag = null;
    if (this.ghost) {
      this.ghost.hidden = true;
      delete this.ghost.dataset.drop;
      this.ghost.remove();
    }
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('contextmenu', this.onContextMenu, true);
    window.removeEventListener('blur', this.onBlur);
  }

  private updateTooltip(inventory: InventoryStore, content: ContentStore): void {
    // The old client's box followed the slot under the mouse, not the equipped
    // one (activeInventorySlot was set from mouseMove and reset to -1 each move).
    const active = this.hoverSlot;
    const item = active >= 0 ? inventory.getSlot(active) : undefined;
    const cardItem = item && item.iid > 0 ? { ...item, mods: inventory.modsOf(item.uid) } : null;
    const card = cardItem ? itemCard(content, cardItem) : null;
    const slot = this.slots[active];
    if (!card || !slot || slot.hidden || this.drag?.dragging) {
      this.tooltip.hidden = true;
      this.lastTooltipKey = '';
      return;
    }
    const key = `${active}:${cardKey(cardItem!)}`;
    if (key !== this.lastTooltipKey) {
      this.lastTooltipKey = key;
      renderItemCard(this.tooltip, card);
    }
    this.tooltip.hidden = false;
    // Centred over the hovered slot with its bottom edge just above it (the
    // old client's box sat above the slot). The box is position: fixed inside
    // the zoomed hotbar root, so the slot's screen rect (visual px, wherever
    // the slot lives -- hotbar row or a bag column in the corner root) is
    // divided by the zoom to land there. Reading the rect forces a synchronous
    // layout, so only do it when the slot or the layout (bag open/closed,
    // window size, zoom) changed.
    const layoutKey = `${active}:${this.bagOpen}:${window.innerWidth}:${window.innerHeight}:${this.scale}`;
    if (layoutKey !== this.lastTooltipLayout) {
      this.lastTooltipLayout = layoutKey;
      const rect = slot.getBoundingClientRect();
      const col = slot.closest<HTMLElement>('.hud-bag-column');
      const topSlot = (col?.firstElementChild as HTMLElement) ?? slot;
      const topRect = topSlot.getBoundingClientRect();
      const bottom = (window.innerHeight - topRect.top) / this.scale + TOOLTIP_GAP;
      // Centred on the slot, but held inside the window: the last bag column
      // sits on the right edge and a centred box would run off it.
      const half = this.tooltip.offsetWidth / 2;
      const minX = half + TOOLTIP_EDGE;
      const maxX = window.innerWidth / this.scale - half - TOOLTIP_EDGE;
      const centerX = (rect.left + rect.width / 2) / this.scale;
      this.tooltip.style.left = `${Math.max(minX, Math.min(maxX, centerX))}px`;
      this.tooltip.style.bottom = `${bottom}px`;
    }
  }
}
