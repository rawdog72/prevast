// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { EquipmentStateEvent, NetEventBus, UpgradeStateEvent } from '../net/events';
import type { FittedMod } from './weapon-mods';

export interface InventoryItem {
  uid: number;
  iid: number;
  count: number;
  ammo: number;
}

export interface ChestItem {
  iid: number;
  count: number;
  ammo: number;
  mods: FittedMod[];
}

/** How long a take-into-this-slot wish waits for the item to arrive. */
const ARRIVAL_WISH_MS = 3000;

/** An equip the server has under way (EQUIPMENT_STATE), on the item with this wire uid. */
export interface PendingEquip {
  uid: number;
  /** Date.now() it began and ends, for the slot's progress sweep. */
  startedAt: number;
  endsAt: number;
}

/** SWAP_SLOTS: what we believed each slot held (wire uid, or null for empty). */
export type SwapListener = (
  from: number,
  to: number,
  fromUid: number | null,
  toUid: number | null,
) => void;

const EMPTY_SLOT = (): InventoryItem => ({ uid: 0, iid: 0, count: 0, ammo: 0 });
const DEFAULT_SLOT_COUNT = 10;

/** XP curve (server player.cpp / old client getXpFromLevel): 900 * 1.105^level, floored per step. */
export const XP_START = 900;
export const XP_GROWTH = 1.105;

export class InventoryStore {
  /**
   * Slot n of INVENTORY is slot n here; the record count is the inventory
   * size (a bag skill widens it), so the array grows to match. 0..9 is the
   * hotbar, anything past that lives in the bag. `uid` is the item's wire id
   * byte -- INVENTORY_SLOT addresses items by it, never by position.
   */
  slots: InventoryItem[] = Array.from({ length: DEFAULT_SLOT_COUNT }, EMPTY_SLOT);

  /** ITEM_MODS: what is fitted to each weapon in the inventory, by wire uid. */
  private readonly mods = new Map<number, FittedMod[]>();

  /**
   * EQUIPMENT_STATE: the wire uid of the weapon or tool in hand and of the
   * wearable worn, null for none, and the equip under way. Keyed by uid rather
   * than slot, so an item keeps its mark wherever it is dragged.
   */
  equippedWeaponUid: number | null = null;
  equippedWearableUid: number | null = null;
  pendingEquip: PendingEquip | null = null;

  /** Told of every swap, so the server keeps the same slot order (SWAP_SLOTS). */
  onSwap: SwapListener | null = null;
  /**
   * BLUEPRINT: the building piece the server has us holding (0 = none). Sent
   * when an equip countdown completes and cleared when the piece is put away,
   * so it -- not the local active slot -- says whether we are building.
   */
  blueprintIid = 0;
  /** SELECTED_ITEM: the item whose effect the server considers active (old client interactionEffect). */
  selectedIid = 0;

  // Chest / Container state
  isChestOpen = false;
  chestCapacity = 0;
  chestItems: ChestItem[] = [];
  /** preferArrival's pending wish, if any. */
  private arrival: { iid: number; slot: number; until: number } | null = null;

  // Station state (STATION_OPENED): the station we are in and its queue.
  isStationOpen = false;
  stationArea = 0;
  /** Four queue slots, iid or 0 (old client PLAYER.building.queue). */
  stationQueue: number[] = [0, 0, 0, 0];
  stationActiveSlot = 0;
  /** 0..255 of the active slot's craft elapsed when the server last stated it. */
  stationProgress = 0;
  stationStatedAt = 0;
  /** Fuel units, exact remaining burn time, and when the server last stated them. */
  fuel = 0;
  fuelMs = 0;
  fuelStatedAt = 0;

  /**
   * UPGRADE_STATE: the building whose upgrade window the server has open for
   * us, or null. `statedAt` is when `remainingMs` was true, so the window can
   * count down without another message.
   */
  upgrade: (Omit<UpgradeStateEvent, 'firstOpen'> & { statedAt: number }) | null = null;

  /** A manual craft in progress (CRAFT_STARTED): the item and when it began. */
  crafting: { iid: number; startedAt: number } | null = null;

  /**
   * The Cancel click (old client: `PLAYER.crafting = 0` before the packet).
   * The server's reply is INTERACTION_CANCELLED, which it also sends for a
   * cancelled collect or reload, so it cannot be what clears this.
   */
  cancelCraft(): void {
    this.crafting = null;
  }

  // Skills & XP
  /** Progression: level, XP progress within the level, and unlocked item ids. */
  level = 1;
  xp = 0;
  readonly unlockedSkills = new Set<number>();

  // Alerts
  readonly alerts: { text: string; timestamp: number }[] = [];

  // Death
  isDead = false;
  kills = 0;
  /** The bag as it was when we died: the death screen shows it (old client death items row). */
  deathItems: InventoryItem[] = [];

  /**
   * Old client: a player earns one skill point per level and each unlock
   * spends the item's skillCost; what is left is what they can still spend.
   */
  skillPointsLeft(costOf: (iid: number) => number): number {
    let spent = 0;
    for (const iid of this.unlockedSkills) spent += costOf(iid);
    return Math.max(0, this.level - spent);
  }

  modsOf(uid: number): FittedMod[] {
    return this.mods.get(uid) ?? [];
  }

  /** The slot holding the item with this wire uid, or -1. */
  slotOfUid(uid: number | null): number {
    if (uid === null) return -1;
    return this.slots.findIndex((s) => s.iid !== 0 && s.uid === uid);
  }

  /** The weapon or tool in hand, by EQUIPMENT_STATE's uid. */
  getHeldItem(): InventoryItem | null {
    return this.slots[this.slotOfUid(this.equippedWeaponUid)] ?? null;
  }

  applyEquipmentState(ev: EquipmentStateEvent, now = Date.now()): void {
    this.equippedWeaponUid = ev.weaponUid;
    this.equippedWearableUid = ev.wearableUid;
    if (!ev.pending) {
      this.pendingEquip = null;
      return;
    }
    const endsAt = now + ev.pending.remainingMs;
    // A restatement of the same equip keeps its start, so the sweep does not jump back.
    const same =
      this.pendingEquip?.uid === ev.pending.uid &&
      Math.abs(this.pendingEquip.endsAt - endsAt) < 250;
    this.pendingEquip = {
      uid: ev.pending.uid,
      startedAt: same ? this.pendingEquip!.startedAt : now,
      endsAt,
    };
  }

  /** How far the pending equip on `uid` has got, 0..1, or null when there is none on it. */
  equipProgress(uid: number, now = Date.now()): number | null {
    const p = this.pendingEquip;
    if (!p || p.uid !== uid) return null;
    const span = p.endsAt - p.startedAt;
    return span <= 0 ? 1 : Math.min(1, Math.max(0, (now - p.startedAt) / span));
  }

  private clearEquipment(): void {
    this.equippedWeaponUid = null;
    this.equippedWearableUid = null;
    this.pendingEquip = null;
  }

  get slotCount(): number {
    return this.slots.length;
  }

  getSlot(index: number): InventoryItem | undefined {
    return this.slots[index];
  }

  setSlot(index: number, item: Partial<InventoryItem>): void {
    if (index < 0 || index >= this.slots.length) return;
    this.slots[index] = {
      uid: item.uid ?? 0,
      iid: item.iid ?? 0,
      count: item.count ?? 0,
      ammo: item.ammo ?? 0,
    };
  }

  /**
   * INVENTORY: every slot, occupied or not, in the server's slot order --
   * which is ours too, since every swap we make is sent as SWAP_SLOTS. So a
   * restatement (login, a trade, a bag skill, a resync after a refused swap)
   * is simply taken as it is.
   */
  setAllSlots(records: InventoryItem[]): void {
    this.arrival = null;
    // The server restates every moddable gun's mods (ITEM_MODS) right after.
    this.mods.clear();
    if (records.length === 0) {
      this.slots = Array.from({ length: DEFAULT_SLOT_COUNT }, EMPTY_SLOT);
      return;
    }
    this.slots = records.map((r) =>
      r.iid === 0 ? EMPTY_SLOT() : { uid: r.uid, iid: r.iid, count: r.count, ammo: r.ammo },
    );
  }

  /**
   * INVENTORY_SLOT (old client onInventorySlot): a statement about the item
   * with this uid -- update the slot holding it, empty it on iid 0, and put an
   * unknown uid in the first empty slot. A full inventory with an unknown uid
   * has nowhere to put it, so the statement is dropped.
   */
  applySlot(uid: number, iid: number, count: number, ammo: number): void {
    let slot = -1;
    let firstEmpty = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.iid !== 0 && s.uid === uid) {
        slot = i;
        break;
      }
      if (firstEmpty === -1 && s.iid === 0) firstEmpty = i;
    }
    // The uid now names nothing, or a different item: its mods went with it.
    // A gun that stays (a reload restates it with the same iid) keeps them.
    if (iid === 0 || slot === -1 || this.slots[slot]!.iid !== iid) this.mods.delete(uid);
    if (iid === 0) {
      if (slot !== -1) this.slots[slot] = EMPTY_SLOT();
      return;
    }
    const arriving = slot === -1;
    if (slot === -1) slot = firstEmpty;
    if (slot === -1) return;
    this.slots[slot] = { uid, iid, count, ammo };
    const wish = this.arrival;
    if (arriving && wish && wish.iid === iid) {
      this.arrival = null;
      // Whatever sat in the chosen slot moves to where the new stack landed.
      if (Date.now() <= wish.until) this.swapSlots(slot, wish.slot);
    }
  }

  /**
   * Put the next new stack of `iid` (from a container or removed mod) in `slot` instead
   * of the first empty one. Slot order is ours alone, so this needs nothing
   * from the server; a take that merges into an existing stack brings no new
   * uid, and the wish simply expires.
   */
  preferArrival(iid: number, slot: number, now = Date.now(), waitMs = ARRIVAL_WISH_MS): () => void {
    const wish = { iid, slot, until: now + waitMs };
    this.arrival = wish;
    // Timed mod changes cancel their placement preference when refused or interrupted.
    return () => {
      if (this.arrival === wish) this.arrival = null;
    };
  }

  /**
   * Swap two slots, and tell the server (onSwap -> SWAP_SLOTS) so its order
   * stays ours. It does not reply; a server that sees a different layout
   * resends INVENTORY.
   */
  swapSlots(a: number, b: number): void {
    if (a === b || a < 0 || b < 0 || a >= this.slots.length || b >= this.slots.length) return;
    const tmp = this.slots[a]!;
    const other = this.slots[b]!;
    this.onSwap?.(a, b, tmp.iid !== 0 ? tmp.uid : null, other.iid !== 0 ? other.uid : null);
    this.slots[a] = other;
    this.slots[b] = tmp;
  }

  /** XP needed to go from `level` to `level + 1`. */
  xpForLevel(level: number): number {
    let xp = XP_START;
    for (let i = 0; i < level; i++) xp = Math.floor(xp * XP_GROWTH);
    return xp;
  }

  getItemCount(iid: number): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot.iid === iid) {
        total += slot.count;
      }
    }
    return total;
  }

  hasIngredients(ingredients: { iid: number; amount: number }[]): boolean {
    for (const req of ingredients) {
      if (this.getItemCount(req.iid) < req.amount) {
        return false;
      }
    }
    return true;
  }

  closeContainers(): void {
    this.isChestOpen = false;
    this.isStationOpen = false;
    this.upgrade = null;
    this.stationQueue = [0, 0, 0, 0];
    this.chestItems = [];
    this.chestCapacity = 0;
  }

  reset(): void {
    this.arrival = null;
    this.slots = Array.from({ length: DEFAULT_SLOT_COUNT }, EMPTY_SLOT);
    this.mods.clear();
    this.clearEquipment();
    this.selectedIid = 0;
    this.blueprintIid = 0;
    this.closeContainers();
    this.level = 1;
    this.xp = 0;
    this.crafting = null;
    this.unlockedSkills.clear();
    this.alerts.length = 0;
    this.isDead = false;
    this.kills = 0;
    this.deathItems = [];
  }

  attachBus(bus: NetEventBus): () => void {
    const cleanups: (() => void)[] = [];

    cleanups.push(
      bus.on('inventorySlot', (ev) => {
        this.applySlot(ev.uid, ev.iid, ev.count, ev.ammo);
      }),
    );

    cleanups.push(
      bus.on('fullInventory', (ev) => {
        this.setAllSlots(ev.slots);
      }),
    );

    cleanups.push(
      bus.on('itemMods', (ev) => {
        if (ev.mods.length) this.mods.set(ev.uid, ev.mods);
        else this.mods.delete(ev.uid);
      }),
    );

    cleanups.push(
      bus.on('equipmentState', (ev) => {
        this.applyEquipmentState(ev);
      }),
    );

    cleanups.push(
      bus.on('selectedItem', (ev) => {
        this.selectedIid = ev.iid;
      }),
    );
    cleanups.push(
      bus.on('blueprint', (ev) => {
        this.blueprintIid = ev.iid;
      }),
    );

    // Old client onLostBuilding: the server closed what we had open.
    cleanups.push(
      bus.on('lostBuilding', () => {
        this.closeContainers();
      }),
    );

    cleanups.push(
      bus.on('openBuilding', (ev) => {
        this.stationArea = ev.area;
        this.stationQueue = ev.queue.slice(0, 4);
        this.stationActiveSlot = ev.activeSlot;
        this.stationProgress = ev.progress;
        this.stationStatedAt = Date.now();
        this.fuel = ev.fuel;
        this.fuelMs = ev.fuelMs;
        this.fuelStatedAt = Date.now();
        // isLogin 1 is a contents update for a station already open.
        if (ev.isLogin === 0) {
          this.isStationOpen = true;
          this.upgrade = null;
        }
      }),
    );

    // The server holds one thing open for us at a time: an upgrade window
    // opening means the chest or station before it is gone.
    cleanups.push(
      bus.on('upgradeState', (ev) => {
        if (ev.firstOpen) {
          this.isChestOpen = false;
          this.isStationOpen = false;
        } else if (!this.upgrade) {
          return; // an update to a window we already closed
        }
        const { firstOpen: _firstOpen, ...state } = ev;
        this.upgrade = { ...state, statedAt: Date.now() };
      }),
    );

    cleanups.push(
      bus.on('startCraft', (ev) => {
        this.crafting = { iid: ev.iid, startedAt: Date.now() };
      }),
    );

    cleanups.push(
      bus.on('fullChest', (ev) => {
        if (ev.firstOpen) {
          this.isChestOpen = true;
          this.upgrade = null;
        }
        this.chestCapacity = ev.slots;
        this.chestItems = ev.items.map((it) => ({
          iid: it.iid,
          count: it.count,
          ammo: it.ammo,
          mods: it.mods,
        }));
      }),
    );

    cleanups.push(
      bus.on('newFuelValue', (ev) => {
        this.fuel = ev.fuel;
        this.fuelMs = ev.fuelMs;
        this.fuelStatedAt = Date.now();
      }),
    );

    cleanups.push(
      bus.on('playerXp', (ev) => {
        // An increment (old client `PLAYER.xp += xp`); LEVEL_STATE resyncs.
        this.xp += ev.xp;
      }),
    );

    cleanups.push(
      bus.on('playerXpSkill', (ev) => {
        this.level = ev.level;
        this.xp = ev.xp;
        this.unlockedSkills.clear();
        for (const s of ev.skills) {
          this.unlockedSkills.add(s);
        }
      }),
    );

    cleanups.push(
      bus.on('boughtSkill', (ev) => {
        this.unlockedSkills.add(ev.iid);
      }),
    );

    cleanups.push(
      bus.on('alert', (ev) => {
        this.alerts.push({
          text: ev.text,
          timestamp: Date.now(),
        });
        if (this.alerts.length > 20) {
          this.alerts.shift();
        }
      }),
    );

    cleanups.push(
      bus.on('playerDie', (ev) => {
        this.isDead = true;
        this.kills = ev.kills;
        // The server refunds a running hand craft as loot at the body.
        this.crafting = null;
        this.deathItems = this.slots.filter((s) => s.iid > 0).map((s) => ({ ...s }));
        this.clearEquipment();
      }),
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }
}
