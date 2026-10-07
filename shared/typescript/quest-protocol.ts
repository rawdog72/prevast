// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// shared/typescript/quest-protocol.ts
// The QUEST_STATE journal entry (apps/server/src/gameplay/quests/
// quest_journal.cpp writes it) and the wire enums of the quest opcodes. An
// entry holds only what the player has reached: finished stages first, then
// the current one with its objectives.
import { z } from 'zod';

/** QUEST_STATE causes; mirror QuestCause in opcodes.h. */
export const QuestCause = {
  SYNC: 0,
  STARTED: 1,
  ADVANCED: 2,
  COMPLETED: 3,
  FAILED: 4,
  /** The entry is gone (abandoned, reset); the string is empty. */
  REMOVED: 5,
  /** questId 0xFFFF: drop every entry, fresh ones follow. */
  RESET: 6,
} as const;
export type QuestCause = (typeof QuestCause)[keyof typeof QuestCause];

/** QUEST_ACTION actions; mirror QuestAction in opcodes.h. */
export const QuestAction = { ABANDON: 1, RESYNC: 2 } as const;
export type QuestAction = (typeof QuestAction)[keyof typeof QuestAction];

/** QUEST_MARKERS kinds: a quest to start here, or a step to finish here. */
export const QuestMarker = { START: 1, TURN_IN: 2 } as const;
export type QuestMarker = (typeof QuestMarker)[keyof typeof QuestMarker];

export const QUEST_RESET_ID = 0xffff;

const text = z.string().max(512);
const key = z.string().min(1).max(48);
const count = z.number().int().min(0).max(4096);

export const questObjectiveSchema = z.object({
  key,
  text,
  type: z.enum(['kill', 'bounty', 'craft', 'gather', 'destroy', 'build', 'pickup', 'use', 'talk', 'give', 'enter_area']),
  count,
  required: count.min(1),
  /** The objective of this stage it waits on (after=), or ''. */
  after: z.string().max(48),
  /** Still waiting on `after`. */
  locked: z.boolean(),
  /** The item key for give / craft / pickup / use objectives, else ''. */
  item: z.string().max(48),
});

export const questStageSchema = z.object({
  key,
  journal: text,
  current: z.boolean(),
  /** How a finished stage ended: an objective key, "all" or "any"; '' for the current stage. */
  outcome: z.string().max(48),
  /** What that ending paid, in words; '' when nothing. */
  rewards: text,
  /** The current stage's objectives; empty for finished stages. */
  objectives: z.array(questObjectiveSchema).max(8),
});

export const questEntrySchema = z.object({
  key,
  name: z.string().min(1).max(64),
  category: z.enum(['main', 'side', 'daily']),
  description: text,
  /** The player may abandon it (abandon="false" in the quest file says no). */
  abandon: z.boolean(),
  state: z.enum(['active', 'completed', 'failed']),
  /** Current stage key; '' once the quest has ended. */
  stage: z.string().max(48),
  /** The ending's journal text once completed, else ''. */
  ending: text,
  stages: z.array(questStageSchema).max(40),
});

export type QuestEntry = z.infer<typeof questEntrySchema>;
export type QuestStage = z.infer<typeof questStageSchema>;
export type QuestObjective = z.infer<typeof questObjectiveSchema>;
