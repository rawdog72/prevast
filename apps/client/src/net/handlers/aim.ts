// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export function handleAimState(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [110][active u8][viewX u16 LE][viewY u16 LE]
  const r = new BinaryReader(bytes, 1);
  const active = r.u8() !== 0;
  const viewX = r.u16();
  const viewY = r.u16();
  if (!r.hasError && r.remaining() === 0) bus.emit('aimState', { active, viewX, viewY });
}
