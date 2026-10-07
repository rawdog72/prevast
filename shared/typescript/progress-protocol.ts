// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// shared/typescript/progress-protocol.ts
// PROGRESS_STATE, the account's stats and achievements from scratch (the game
// server's ProgressSystem::sendState writes it). Definitions -- names, points,
// requirements -- are the `stats` and `achievements` content tables; secret
// achievements arrive there without text, and their text comes here once
// unlocked.
import { z } from 'zod';

const id = z.number().int().min(1).max(65535);
const value = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const progressStateSchema = z.object({
  /** false: a guest, or a server that records no account progress. */
  enabled: z.boolean(),
  /** With enabled false: a guest (true), or a server that records nothing (false). */
  guest: z.boolean().optional(),
  /** false while the server is still fetching the account's progress. */
  loaded: z.boolean(),
  /** [stat id, value], non-zero stats only. */
  stats: z.array(z.tuple([id, value])).max(512),
  /** [achievement id, unlocked at (unix seconds)]. */
  achievements: z.array(z.tuple([id, value])).max(1024),
  secrets: z.array(z.object({ id, name: z.string().max(64), description: z.string().max(256) })).max(1024),
});
export type ProgressState = z.infer<typeof progressStateSchema>;

export const achievementTextSchema = z.object({
  name: z.string().max(64),
  description: z.string().max(256),
});
