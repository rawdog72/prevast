// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/quest-store.ts
// The player's quest journal as the server states it (QUEST_STATE,
// QUEST_PROGRESS) plus the NPC markers (QUEST_MARKERS). Nothing here is
// decided on the client except which quests the HUD tracker pins, a per-viewer
// preference kept in localStorage.

import {
  QuestAction,
  QuestCause,
  type QuestEntry,
} from '../../../../shared/typescript/quest-protocol';
import { readSetting, writeSetting } from '../core/storage';
import type { NetEventBus } from '../net/events';

export const MAX_TRACKED = 3;
const TRACKED_SETTING = 'prevast.quests.tracked';
/** A resync is asked for at most this often, however many bad entries arrive. */
const RESYNC_INTERVAL_MS = 3000;
/** How long a just-finished objective row stays highlighted in the tracker. */
export const FLASH_MS = 1600;

export interface QuestRecord {
  id: number;
  entry: QuestEntry;
}

interface QuestSender {
  questAction(questId: number, action: number): void;
}

export class QuestStore {
  private readonly byId = new Map<number, QuestEntry>();
  /** npcs.xml id -> QuestMarker kind. */
  markers = new Map<number, number>();
  /** Bumped on every change, so windows can skip redrawing when nothing moved. */
  version = 0;
  /** Objective rows that just completed: `${questKey}/${objectiveKey}` -> when. */
  readonly flashes = new Map<string, number>();
  private tracked: string[];
  private needsResync = false;
  private lastResyncAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.tracked = parseTracked(readSetting(TRACKED_SETTING));
  }

  attachBus(bus: NetEventBus): () => void {
    const offs = [
      bus.on('questState', (ev) => {
        if (ev.cause === QuestCause.RESET) this.clear();
        else if (ev.cause === QuestCause.REMOVED) this.remove(ev.questId);
        else if (ev.entry) this.put(ev.questId, ev.entry, ev.cause === QuestCause.STARTED);
        else this.needsResync = true;
      }),
      bus.on('questProgress', (ev) => this.progress(ev.questId, ev.objective, ev.count)),
      bus.on('questMarkers', (ev) => {
        this.markers = ev.markers;
        this.version++;
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  /** Per frame: sends a pending resync (rate-limited). */
  update(socket: QuestSender): void {
    if (!this.needsResync) return;
    const t = this.now();
    if (t - this.lastResyncAt < RESYNC_INTERVAL_MS) return;
    this.lastResyncAt = t;
    this.needsResync = false;
    socket.questAction(0, QuestAction.RESYNC);
  }

  get all(): QuestRecord[] {
    return [...this.byId].map(([id, entry]) => ({ id, entry })).sort((a, b) => a.id - b.id);
  }

  get active(): QuestRecord[] {
    return this.all.filter((r) => r.entry.state === 'active');
  }

  get finished(): QuestRecord[] {
    return this.all.filter((r) => r.entry.state !== 'active');
  }

  byKey(key: string): QuestRecord | undefined {
    return this.all.find((r) => r.entry.key === key);
  }

  isTracked(key: string): boolean {
    return this.tracked.includes(key);
  }

  /** Active quests the tracker shows, in the order they were pinned. */
  get trackedRecords(): QuestRecord[] {
    const out: QuestRecord[] = [];
    for (const key of this.tracked) {
      const record = this.byKey(key);
      if (record && record.entry.state === 'active') out.push(record);
    }
    return out;
  }

  /** Pins or unpins a quest; pinning a fourth drops the oldest pin. */
  toggleTrack(key: string): void {
    if (this.isTracked(key)) this.tracked = this.tracked.filter((k) => k !== key);
    else this.tracked = [...this.tracked.filter((k) => this.byKey(k)?.entry.state === 'active'), key].slice(-MAX_TRACKED);
    writeSetting(TRACKED_SETTING, JSON.stringify(this.tracked));
    this.version++;
  }

  abandon(socket: QuestSender, key: string): void {
    const record = this.byKey(key);
    if (record && record.entry.state === 'active') socket.questAction(record.id, QuestAction.ABANDON);
  }

  isFlashing(questKey: string, objectiveKey: string): boolean {
    const at = this.flashes.get(`${questKey}/${objectiveKey}`);
    return at !== undefined && this.now() - at < FLASH_MS;
  }

  private put(id: number, entry: QuestEntry, started: boolean): void {
    // One key per id: a reload may have moved a quest to another id.
    for (const [other, existing] of this.byId) if (other !== id && existing.key === entry.key) this.byId.delete(other);
    this.byId.set(id, entry);
    // A new quest is pinned while there is room.
    if (started && entry.state === 'active' && !this.isTracked(entry.key) && this.trackedRecords.length < MAX_TRACKED) {
      this.tracked = [...this.tracked.filter((k) => this.byKey(k)?.entry.state === 'active'), entry.key];
      writeSetting(TRACKED_SETTING, JSON.stringify(this.tracked));
    }
    this.version++;
  }

  private progress(id: number, index: number, count: number): void {
    const entry = this.byId.get(id);
    const stage = entry?.stages.find((s) => s.current);
    const objective = stage?.objectives[index];
    if (!entry || !stage || !objective) {
      this.needsResync = true;
      return;
    }
    if (objective.count === count) return;
    const finished = count >= objective.required && objective.count < objective.required;
    objective.count = Math.min(count, objective.required);
    if (finished) {
      this.flashes.set(`${entry.key}/${objective.key}`, this.now());
      // Whatever waited on this objective is open now.
      for (const other of stage.objectives) {
        if (other.after === objective.key) other.locked = false;
      }
    }
    this.version++;
  }

  private remove(id: number): void {
    if (this.byId.delete(id)) this.version++;
  }

  private clear(): void {
    this.byId.clear();
    this.flashes.clear();
    this.version++;
  }
}

function parseTracked(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string').slice(0, MAX_TRACKED) : [];
  } catch {
    return [];
  }
}
