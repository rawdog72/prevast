// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { npcStateSchema } from '../../../../../shared/typescript/npc-protocol';
import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export function handleNpcState(bytes: Uint8Array, bus: NetEventBus): void {
  if (bytes.length > 8195) return;
  const r = new BinaryReader(bytes, 1);
  const json = r.str();
  if (r.hasError || r.remaining()) return;
  try {
    const parsed = npcStateSchema.safeParse(JSON.parse(json));
    if (parsed.success) bus.emit('npcState', parsed.data);
  } catch { /* A malformed snapshot must never partially enter client state. */ }
}
export function handleNpcClosed(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const session = r.u32(), reason = r.str();
  if (!r.hasError && !r.remaining() && session) bus.emit('npcClosed', { session, reason });
}
