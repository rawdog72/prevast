// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, FullChestSlot } from '../events';
import { readFittedMods } from './inventory';

export function handleStartInteraction(bytes: Uint8Array, bus: NetEventBus): void {
  const delayMultiplier = bytes.length >= 3 ? bytes[1]! | (bytes[2]! << 8) : (bytes[1] ?? 1);
  bus.emit('startInteraction', { delayMultiplier });
}

export function handleInterruptInteraction(_bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('interruptInteraction', undefined as unknown as void);
}

export function handleOpenBuilding(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendOpenStation): [46][area u8][progress u8, inverted:
  // 255 = nothing elapsed][activeSlot u8][queue iid u8 x4][isLogin u8: 0 = open
  // the window, 1 = contents update][fuel u8][fuelMs u32 LE]
  if (bytes.length < 14) return;
  const area = bytes[1] ?? 0;
  const progress = 255 - (bytes[2] ?? 255);
  const activeSlot = bytes[3] ?? 0;
  const queue = [bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0];
  const isLogin = bytes[8] ?? 0;
  const fuel = bytes[9] ?? 0;
  const fuelMs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(10, true);
  bus.emit('openBuilding', { area, progress, activeSlot, queue, isLogin, fuel, fuelMs });
}

export function handleLostBuilding(_bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('lostBuilding', undefined as unknown as void);
}

export function handleNewFuelValue(bytes: Uint8Array, bus: NetEventBus): void {
  if (bytes.length < 6) return;
  const fuel = bytes[1] ?? 0;
  const fuelMs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true);
  bus.emit('newFuelValue', { fuel, fuelMs });
}

export function handleWrongTool(bytes: Uint8Array, bus: NetEventBus): void {
  const toolIid = bytes[1] ?? 0;
  bus.emit('wrongTool', { toolIid });
}

export function handleFullChest(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendFullChest): [53][firstOpen u8] then, per storage
  // slot, [iid u16][count u8][ammo u8][n u8]([slot u8][modIid u16])*n.
  // firstOpen 1 means "you just opened it" (old client: open the box + sound);
  // 0 is a contents refresh after a take or store. The slot count is whatever
  // the packet carries.
  const r = new BinaryReader(bytes, 1);
  const firstOpen = r.u8() === 1;
  const items: FullChestSlot[] = [];
  while (r.remaining() >= 5) {
    const iid = r.u16();
    const count = r.u8();
    const ammo = r.u8();
    const mods = readFittedMods(r);
    if (r.hasError) return;
    items.push({ iid, count, ammo, mods });
  }
  bus.emit('fullChest', { firstOpen, slots: items.length, items });
}
