// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import { z } from 'zod';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const progressionRulesSchema = z.strictObject({
  version: z.number().int().positive(),
  scorePerGoldenCap: z.number().int().positive(),
  clanCreationCost: z.number().int().positive(),
  clanSwitchCooldownHours: integer,
  averageLeaderboardMinimumRuns: z.number().int().positive(),
  rankedModes: z.array(z.string().min(1).max(64)).min(1),
  outlawMinKarma: z.number().int().min(0).max(255),
  pvpRepeatVictimCooldownSeconds: integer,
  achievementRewards: z.record(z.string(), integer),
  eventRewards: z.record(z.string(), integer),
});
export type ProgressionRules = z.infer<typeof progressionRulesSchema>;
export const clanIdentitySchema = z.object({
  id: integer.positive(),
  name: z.string().max(40),
  tag: z.string().max(5),
  rank: integer,
});
export type ClanIdentity = z.infer<typeof clanIdentitySchema>;
export const runLiveSchema = z.object({
  runId: z.string().max(96),
  earnedScore: integer,
  scorePerCap: integer.positive(),
  scoreCaps: integer,
  rewardCaps: integer,
  survivedSeconds: integer,
  bestScore: integer,
  clanContribution: integer,
  ranked: z.boolean(),
});
export type RunLive = z.infer<typeof runLiveSchema>;
export const accountIdentityPacketSchema = z.object({
  players: z
    .array(z.object({ pid: integer.max(255), clan: clanIdentitySchema.nullable() }))
    .max(255),
});
export const runReportSchema = z.strictObject({
  runId: z.string().regex(/^[A-Za-z0-9:._-]{1,96}$/),
  bootId: z.string().regex(/^[A-Za-z0-9:._-]{1,80}$/),
  accountId: integer.positive(),
  revision: integer.positive(),
  startedAt: integer.positive(),
  at: integer.positive(),
  mode: z.string().min(1).max(64),
  rulesVersion: integer.positive(),
  score: integer.max(0xffffffff),
  earnedScore: integer,
  kills: integer,
  survivedSeconds: integer,
  end: z.enum(['alive', 'death', 'interrupted']),
  eligible: z.boolean(),
  events: z
    .array(
      z.strictObject({
        seq: integer.positive(),
        at: integer.positive(),
        score: integer,
        kills: integer.max(1),
      }),
    )
    .max(2048),
  awards: z
    .array(
      z.strictObject({
        kind: z.enum(['achievement', 'event']),
        key: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
        occurrence: z.string().regex(/^[A-Za-z0-9:._-]{1,96}$/),
        at: integer.positive(),
      }),
    )
    .max(256),
});
export type RunReport = z.infer<typeof runReportSchema>;
export interface RunRecord {
  id: string;
  mode: string;
  startedAt: number;
  endedAt: number | null;
  end: string;
  score: number;
  earnedScore: number;
  kills: number;
  survivedSeconds: number;
  goldenCaps: number;
}
export interface WalletEntry {
  id: number;
  at: number;
  amount: number;
  reason: string;
}
export type ClanRole = 'owner' | 'officer' | 'member';
export interface ClanMember {
  id: number;
  name: string;
  role: ClanRole;
  joinedAt: number;
  contribution: number;
}
export interface ClanView extends ClanIdentity {
  role: ClanRole | null;
  members: number;
  contributors: number;
  score: number;
  average: number | null;
  yourContribution: number;
  roster: ClanMember[];
  nextOffset: number | null;
  audit: { at: number; actor: string; action: string; target: string }[];
  trophies: { season: string; rank: number; score: number }[];
}
export interface CommunityProfile {
  accountId: number;
  name: string;
  completedRuns: number;
  totalFinalScore: number;
  averageScore: number | null;
  bestScore: number;
  recentRuns: RunRecord[];
  wallet: number;
  transactions: WalletEntry[];
  clan: ClanView | null;
  invitations: { clanId: number; name: string; tag: string }[];
  canJoinAt: number;
  rules: Pick<
    ProgressionRules,
    'scorePerGoldenCap' | 'clanCreationCost' | 'averageLeaderboardMinimumRuns'
  >;
}
export interface RankingRow {
  rank: number;
  id: number;
  name: string;
  tag?: string;
  score: number;
  contributors?: number;
  members?: number;
  average?: number | null;
  sessions?: number;
}
export interface Rankings {
  season: string;
  nextResetAt: number;
  players: RankingRow[];
  clans: RankingRow[];
  metric: 'score' | 'best' | 'average' | 'kills';
  nextOffset: number | null;
}
export const clanCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    name: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 '-]*$/),
    tag: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{2,5}$/),
    requestId: z.string().uuid(),
  }),
  z.strictObject({ action: z.literal('invite'), account: z.string().min(1).max(32) }),
  z.strictObject({ action: z.literal('accept'), clanId: integer.positive() }),
  z.strictObject({ action: z.literal('decline'), clanId: integer.positive() }),
  z.strictObject({ action: z.literal('kick'), accountId: integer.positive() }),
  z.strictObject({ action: z.literal('promote'), accountId: integer.positive() }),
  z.strictObject({ action: z.literal('demote'), accountId: integer.positive() }),
  z.strictObject({ action: z.literal('transfer'), accountId: integer.positive() }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('disband'), confirmTag: z.string().min(2).max(5) }),
]);
export type ClanCommand = z.infer<typeof clanCommandSchema>;
export function seasonAt(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}
export function nextSeasonAt(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export function clanShieldColor(rank: number): string {
  return rank === 1
    ? '#f4c542'
    : rank === 2
      ? '#d8e1ec'
      : rank === 3
        ? '#ce9059'
        : rank >= 4 && rank <= 10
          ? '#b794f6'
          : '#8394a8';
}
