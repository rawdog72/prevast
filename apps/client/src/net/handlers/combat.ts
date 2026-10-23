// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export function handleDamageIndicator(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [DAMAGE_INDICATOR][x u16 LE][y u16 LE][amount i16 LE][pct u8]
  const r = new BinaryReader(bytes, 1);
  const x = r.u16();
  const y = r.u16();
  const amount = r.i16();
  const pct = r.u8();
  bus.emit('damageIndicator', { x, y, amount, pct });
}

export function handleAreaEffect(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [AREA_EFFECT][id u16][kind u8][tileX u16][tileY u16][growMs u16]
  // [holdMs u16][fadeMs u16][ageMs u16][n u8]([dx i8][dy i8])*n, all LE.
  const r = new BinaryReader(bytes, 1);
  const id = r.u16();
  const kind = r.u8();
  const tileX = r.u16();
  const tileY = r.u16();
  const growMs = r.u16();
  const holdMs = r.u16();
  const fadeMs = r.u16();
  const ageMs = r.u16();
  const n = r.u8();
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) cells.push([r.i8(), r.i8()]);
  if (r.hasError || r.remaining() !== 0) return;
  bus.emit('areaEffect', { id, kind, tileX, tileY, growMs, holdMs, fadeMs, ageMs, cells });
}

export function handleExplosionShake(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('shakeExplosionState', { shake: bytes[1] ?? 0 });
}
