// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { NetEventBus } from '../events';

export function handleBlueprint(bytes: Uint8Array, bus: NetEventBus): void {
  const iid = bytes.length >= 3 ? bytes[1]! | (bytes[2]! << 8) : (bytes[1] ?? 0);
  bus.emit('blueprint', { iid });
}

export function handleStartCraft(bytes: Uint8Array, bus: NetEventBus): void {
  const iid = bytes.length >= 3 ? bytes[1]! | (bytes[2]! << 8) : (bytes[1] ?? 0);
  bus.emit('startCraft', { iid });
}
