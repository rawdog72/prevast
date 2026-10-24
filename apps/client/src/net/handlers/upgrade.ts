// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/net/handlers/upgrade.ts
// Upgrading a building in place: the window's state, and the puff when one
// finishes. Layouts in apps/server/src/network/opcodes.h.

import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export function handleUpgradeState(bytes: Uint8Array, bus: NetEventBus): void {
  // [UPGRADE_STATE][firstOpen u8][entityId u32][iid u16][targetIid u16][running u8]
  // [durationMs u32][remainingMs u32]
  const r = new BinaryReader(bytes, 1);
  const firstOpen = r.u8() === 1;
  const entityId = r.u32();
  const iid = r.u16();
  const targetIid = r.u16();
  const running = r.u8() === 1;
  const durationMs = r.u32();
  const remainingMs = r.u32();
  if (r.hasError) return;
  bus.emit('upgradeState', {
    firstOpen,
    entityId,
    iid,
    targetIid,
    running,
    durationMs,
    remainingMs,
  });
}

export function handleUpgradeFinished(bytes: Uint8Array, bus: NetEventBus): void {
  // [UPGRADE_FINISHED][x u16][y u16][iid u16]
  const r = new BinaryReader(bytes, 1);
  const x = r.u16();
  const y = r.u16();
  const iid = r.u16();
  if (r.hasError) return;
  bus.emit('upgradeFinished', { x, y, iid });
}
