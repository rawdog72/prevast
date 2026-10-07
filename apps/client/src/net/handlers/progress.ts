// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/net/handlers/progress.ts
// PROGRESS_STATE, PROGRESS_UPDATE and ACHIEVEMENT_UNLOCKED. A malformed message
// is dropped whole.
import {
  achievementTextSchema,
  progressStateSchema,
  type ProgressState,
} from '../../../../../shared/typescript/progress-protocol';
import { BinaryReader } from '../binary-stream';
import type { NetEventBus } from '../events';

export interface ProgressUpdateEvent {
  /** stat id -> value. */
  stats: Map<number, number>;
}
export interface AchievementUnlockedEvent {
  id: number;
  /** Unix seconds. */
  at: number;
  name: string;
  description: string;
}
export type ProgressStateEvent = ProgressState;

export function handleProgressState(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const json = r.str();
  if (r.hasError || r.remaining()) return;
  try {
    const parsed = progressStateSchema.safeParse(JSON.parse(json));
    if (parsed.success) bus.emit('progressState', parsed.data);
  } catch {
    /* A malformed snapshot never enters client state. */
  }
}

export function handleProgressUpdate(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const n = r.u8();
  const stats = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const id = r.u16();
    stats.set(id, r.u32());
  }
  if (r.hasError || r.remaining()) return;
  bus.emit('progressUpdate', { stats });
}

export function handleAchievementUnlocked(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const id = r.u16();
  const at = r.u32();
  const json = r.str();
  if (r.hasError || r.remaining() || !id) return;
  try {
    const parsed = achievementTextSchema.safeParse(JSON.parse(json));
    if (parsed.success) bus.emit('achievementUnlocked', { id, at, ...parsed.data });
  } catch {
    /* dropped */
  }
}
