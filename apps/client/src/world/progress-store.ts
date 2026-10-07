// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/client/src/world/progress-store.ts
// The account's stats and unlocked achievements as the server states them
// (PROGRESS_STATE, PROGRESS_UPDATE, ACHIEVEMENT_UNLOCKED). Definitions come
// from the `stats` and `achievements` content tables.

import type { NetEventBus } from '../net/events';

export class ProgressStore {
  /** false: a guest, or a server that records nothing. */
  enabled = false;
  /** Why not enabled: true for a guest. */
  guest = true;
  /** false until the server has the account's progress. */
  loaded = false;
  readonly stats = new Map<number, number>();
  /** achievement id -> unlocked at (unix seconds). */
  readonly unlocked = new Map<number, number>();
  /** Text of unlocked secret achievements (the content table leaves it out). */
  readonly secrets = new Map<number, { name: string; description: string }>();
  /** Unlocked this session, newest last, for highlighting. */
  readonly fresh = new Set<number>();
  /** Bumped on every change. */
  version = 0;

  attachBus(bus: NetEventBus): () => void {
    const offs = [
      bus.on('progressState', (s) => {
        this.enabled = s.enabled;
        this.guest = s.guest ?? !s.enabled;
        this.loaded = s.loaded;
        this.stats.clear();
        for (const [id, value] of s.stats) this.stats.set(id, value);
        this.unlocked.clear();
        for (const [id, at] of s.achievements) this.unlocked.set(id, at);
        this.secrets.clear();
        for (const secret of s.secrets) this.secrets.set(secret.id, { name: secret.name, description: secret.description });
        this.version++;
      }),
      bus.on('progressUpdate', (u) => {
        for (const [id, value] of u.stats) this.stats.set(id, value);
        this.version++;
      }),
      bus.on('achievementUnlocked', (a) => {
        this.unlocked.set(a.id, a.at);
        this.secrets.set(a.id, { name: a.name, description: a.description });
        this.fresh.add(a.id);
        this.version++;
      }),
    ];
    return () => offs.forEach((off) => off());
  }

  stat(id: number): number {
    return this.stats.get(id) ?? 0;
  }
}
