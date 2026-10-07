// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, UnitRecord } from '../events';

export function handleMapSize(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [74][pad u8][width u16 LE][height u16 LE]
  const r = new BinaryReader(bytes, 2);
  const width = r.u16();
  const height = r.u16();
  bus.emit('mapSize', { width, height });
}

export function handleWorldTime(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [85][cycleMs u32 LE][phaseMs u32 LE]
  const r = new BinaryReader(bytes, 1);
  const cycleMs = r.u32();
  const phaseMs = r.u32();
  const isNight = phaseMs >= Math.floor(cycleMs / 2);
  bus.emit('worldTime', { cycleMs, phaseMs, isNight });
}

export function handleUnits(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [0][loginFlag u8] followed by 18-byte records
  const isFullReset = (bytes[1] ?? 0) === 1;
  const units: UnitRecord[] = [];
  const total = bytes.length;
  let off = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (off + 18 <= total) {
    const pid = bytes[off]!;
    const idHigh = bytes[off + 1]!;
    const rotation = bytes[off + 2]!;
    const type = bytes[off + 3]!;
    const state = view.getUint16(off + 4, true);
    const idLow = view.getUint16(off + 6, true);
    const startX = view.getUint16(off + 8, true);
    const startY = view.getUint16(off + 10, true);
    const endX = view.getUint16(off + 12, true);
    const endY = view.getUint16(off + 14, true);
    const extra = view.getUint16(off + 16, true);

    const id = idLow | (idHigh << 16);
    units.push({ pid, id, rotation, type, state, startX, startY, endX, endY, extra });
    off += 18;
  }

  bus.emit('units', { isFullReset, units });
}

export function handleCitiesLocation(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendCitiesLocation): [66][pad u8][cityCount u16 LE]
  // then (y u16 LE, x u16 LE) TILE pairs to the end of the packet -- Y first.
  // The first cityCount pairs are cities, every remaining pair is a house.
  const r = new BinaryReader(bytes, 2);
  const cityCount = r.u16();
  const cities: { x: number; y: number }[] = [];
  const houses: { x: number; y: number }[] = [];
  while (r.remaining() >= 4) {
    const y = r.u16();
    const x = r.u16();
    (cities.length < cityCount ? cities : houses).push({ x, y });
  }
  bus.emit('citiesLocation', { cities, houses });
}

export function handleAreas(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [61] then u8 area ids
  const areas: number[] = [];
  for (let i = 1; i < bytes.length; i++) {
    areas.push(bytes[i]!);
  }
  bus.emit('areas', { areas });
}
