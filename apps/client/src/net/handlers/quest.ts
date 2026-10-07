// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/net/handlers/quest.ts
// QUEST_STATE, QUEST_PROGRESS and QUEST_MARKERS. A malformed message is
// dropped whole; a QUEST_STATE whose JSON fails the schema asks the store to
// resync rather than keep a half-understood entry.
import {
  QUEST_RESET_ID,
  QuestCause,
  questEntrySchema,
  type QuestEntry,
} from '../../../../../shared/typescript/quest-protocol';
import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export interface QuestStateEvent {
  questId: number;
  cause: QuestCause;
  /** null for REMOVED and RESET, or when the JSON did not parse (see `invalid`). */
  entry: QuestEntry | null;
  /** The JSON was there but unreadable: the client should ask for a resync. */
  invalid: boolean;
}
export interface QuestProgressEvent {
  questId: number;
  objective: number;
  count: number;
}
export interface QuestMarkersEvent {
  /** npcs.xml id -> QuestMarker kind. */
  markers: Map<number, number>;
}

export function handleQuestState(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const questId = r.u16();
  const cause = r.u8();
  const json = r.str();
  if (r.hasError || r.remaining() || cause > QuestCause.RESET) return;
  if (cause === QuestCause.RESET) {
    if (questId === QUEST_RESET_ID) bus.emit('questState', { questId, cause, entry: null, invalid: false });
    return;
  }
  if (cause === QuestCause.REMOVED) {
    bus.emit('questState', { questId, cause, entry: null, invalid: false });
    return;
  }
  let entry: QuestEntry | null = null;
  try {
    const parsed = questEntrySchema.safeParse(JSON.parse(json));
    if (parsed.success) entry = parsed.data;
  } catch {
    /* handled below */
  }
  bus.emit('questState', { questId, cause: cause as QuestCause, entry, invalid: entry === null });
}

export function handleQuestProgress(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const questId = r.u16();
  const objective = r.u8();
  const count = r.u32();
  if (r.hasError || r.remaining()) return;
  bus.emit('questProgress', { questId, objective, count });
}

export function handleQuestMarkers(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const n = r.u8();
  const markers = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const npcId = r.u16();
    const kind = r.u8();
    markers.set(npcId, kind);
  }
  if (r.hasError || r.remaining()) return;
  bus.emit('questMarkers', { markers });
}
