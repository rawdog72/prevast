// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, InventorySlotData } from '../events';
import type { FittedMod } from '../../world/weapon-mods';

/** [n u8]([slot u8][modIid u16])*n, shared by ITEM_MODS, CONTAINER_CONTENTS and TRADE_STATE. */
export function readFittedMods(r: BinaryReader): FittedMod[] {
  const n = r.u8();
  if (n > 7 || r.remaining() < n * 3) {
    r.hasError = true;
    return [];
  }
  return Array.from({ length: n }, () => ({ slot: r.u8(), iid: r.u16() }));
}

export function handleItemMods(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [ITEM_MODS][uid u8][n u8]([slot u8][modIid u16 LE])*n
  const r = new BinaryReader(bytes, 1);
  const uid = r.u8();
  const mods = readFittedMods(r);
  if (!r.hasError && r.remaining() === 0) bus.emit('itemMods', { uid, mods });
}

export function handleInventorySlot(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [INVENTORY_SLOT][uid u8][iid u16 LE][count u8][ammo u8]
  const r = new BinaryReader(bytes, 1);
  const uid = r.u8();
  const iid = r.u16();
  const count = r.u8();
  const ammo = r.u8();
  bus.emit('inventorySlot', { uid, iid, count, ammo });
}

export function handleInventory(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [INVENTORY] then repeated [iid u16 LE][count u8][uid u8][ammo u8] (5 bytes per slot)
  const r = new BinaryReader(bytes, 1);
  const slots: InventorySlotData[] = [];
  while (r.remaining() >= 5) {
    const iid = r.u16();
    const count = r.u8();
    const uid = r.u8();
    const ammo = r.u8();
    slots.push({ iid, count, uid, ammo });
  }
  bus.emit('fullInventory', { slots });
}

export function handleSelectedItem(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendSelectedItem): [SELECTED_ITEM][iid high u8][iid low u8] --
  // big-endian, as the old client read it ((data[1] << 8) + data[2]).
  const iid = bytes.length >= 3 ? (bytes[1]! << 8) | bytes[2]! : (bytes[1] ?? 0);
  bus.emit('selectedItem', { iid });
}
