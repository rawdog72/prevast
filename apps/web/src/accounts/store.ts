// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Persistence boundary for accounts. MysqlAccountStore is production,
// MemoryAccountStore is tests; both must pass store-contract.ts.
import type { PasswordHash } from './credentials';

export interface AccountRecord {
  id: number;
  name: string;
  nameKey: string;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordIter: number;
  email: string;
  groupId: number;
  /** Unix ms. */
  createdAt: number;
  failedLogins: number;
  /** Unix ms; 0 = not locked. */
  lockedUntil: number;
}

export type NewAccount = Omit<AccountRecord, 'id' | 'failedLogins' | 'lockedUntil'>;

export interface SessionRecord {
  tokenHash: Buffer;
  accountId: number;
  createdAt: number;
  expiresAt: number;
  device?: string;
  lastUsedAt?: number;
}

export interface AccountSecurity {
  verifiedEmail: string;
  recoveryHash: Buffer | null;
  mailSentAt: number;
}

export interface AccountAction {
  tokenHash: Buffer;
  accountId: number;
  kind: 'verify' | 'reset';
  email: string;
  createdAt: number;
  expiresAt: number;
}

/** An account's stats (id -> value) and unlocked achievements, as stored. */
export interface ProgressSnapshot {
  stats: Record<number, number>;
  achievements: { id: number; unlockedAt: number }[];
}

/**
 * What one game server learned about one account since its last batch.
 * Deltas, not totals, so the same account on two servers adds up.
 */
export interface ProgressDelta {
  accountId: number;
  /** stat id -> amount to add. */
  add: Record<number, number>;
  /** stat id -> a record; the stored value becomes the larger of the two. */
  max: Record<number, number>;
  unlock: { id: number; at: number }[];
  revoke: number[];
}

/** Stat values stay exact in JSON and BIGINT alike. */
export const MAX_STAT_VALUE = Number.MAX_SAFE_INTEGER;
/** A batch id is remembered this long, so a retry within it is not counted twice. */
export const BATCH_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccountStore {
  init(): Promise<void>;
  close(): Promise<void>;
  /** null when the name key is taken. */
  createAccount(account: NewAccount): Promise<AccountRecord | null>;
  findAccountById(id: number): Promise<AccountRecord | null>;
  findAccountByNameKey(key: string): Promise<AccountRecord | null>;
  setLoginFailures(id: number, failedLogins: number, lockedUntil: number): Promise<void>;
  /**
   * One more failed login, atomically: the count goes up by one, and on
   * reaching `max` it resets to 0 with `lockedUntil = now + lockMs`.
   */
  recordLoginFailure(id: number, now: number, max: number, lockMs: number): Promise<void>;
  setPassword(id: number, hash: PasswordHash): Promise<void>;
  /** Compare-and-set: false when the current group is not `fromGroupId`. */
  setGroup(id: number, fromGroupId: number, toGroupId: number): Promise<boolean>;
  createSession(session: SessionRecord, expectedPassword?: Buffer): Promise<boolean>;
  findSession(tokenHash: Buffer): Promise<SessionRecord | null>;
  deleteSession(tokenHash: Buffer): Promise<void>;
  /** Deletes every session of the account except `keep` (null deletes all). */
  deleteSessionsExcept(accountId: number, keep: Buffer | null): Promise<void>;
  listSessions(accountId: number, now: number): Promise<SessionRecord[]>;
  touchSession(tokenHash: Buffer, now: number): Promise<void>;
  cleanup(now: number): Promise<void>;
  getSecurity(accountId: number): Promise<AccountSecurity>;
  /** Password replacement, session revocation and recovery invalidation are one transaction. */
  changePassword(
    accountId: number,
    expected: Buffer,
    next: PasswordHash,
    keep: Buffer | null,
  ): Promise<boolean>;
  upgradePassword(accountId: number, expected: Buffer, next: PasswordHash): Promise<void>;
  setRecoveryCode(accountId: number, expected: Buffer, hash: Buffer): Promise<boolean>;
  /** One outstanding link per purpose, with a shared 60-second mail cooldown. */
  issueAction(action: AccountAction, expectedPassword?: Buffer): Promise<boolean>;
  completeAction(hash: Buffer, now: number, next?: PasswordHash): Promise<boolean>;
  recoverWithCode(accountId: number, hash: Buffer, next: PasswordHash): Promise<boolean>;
  getProgress(accountId: number): Promise<ProgressSnapshot>;
  /**
   * Applies a game server's batch at once. False, and nothing changes, when
   * `batchId` was applied before (a retry). Deltas for unknown accounts are
   * skipped. Batch ids older than BATCH_MEMORY_MS are forgotten.
   */
  applyProgress(
    batchId: string,
    now: number,
    deltas: ProgressDelta[],
    legacyBatchId?: string,
  ): Promise<boolean>;
}
