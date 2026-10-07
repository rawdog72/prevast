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

export function handleExplosionShake(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('shakeExplosionState', { shake: bytes[1] ?? 0 });
}
