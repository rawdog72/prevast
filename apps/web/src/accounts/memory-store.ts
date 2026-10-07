// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { PasswordHash } from './credentials';
import {
  BATCH_MEMORY_MS,
  MAX_STAT_VALUE,
  type AccountRecord,
  type AccountStore,
  type NewAccount,
  type ProgressDelta,
  type ProgressSnapshot,
  type SessionRecord,
  type AccountSecurity,
  type AccountAction,
} from './store';

const key = (hash: Buffer): string => hash.toString('hex');

export class MemoryAccountStore implements AccountStore {
  private nextId = 1;
  private readonly accounts = new Map<number, AccountRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly stats = new Map<number, Map<number, number>>();
  private readonly achievements = new Map<number, Map<number, number>>();
  private readonly batches = new Map<string, number>();
  private readonly security = new Map<number, AccountSecurity>();
  private readonly actions = new Map<string, AccountAction>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async createAccount(account: NewAccount): Promise<AccountRecord | null> {
    for (const a of this.accounts.values()) if (a.nameKey === account.nameKey) return null;
    const record: AccountRecord = {
      ...account,
      id: this.nextId++,
      failedLogins: 0,
      lockedUntil: 0,
    };
    this.accounts.set(record.id, record);
    return { ...record };
  }

  async findAccountById(id: number): Promise<AccountRecord | null> {
    const a = this.accounts.get(id);
    return a ? { ...a } : null;
  }

  async findAccountByNameKey(nameKey: string): Promise<AccountRecord | null> {
    for (const a of this.accounts.values()) if (a.nameKey === nameKey) return { ...a };
    return null;
  }

  async setLoginFailures(id: number, failedLogins: number, lockedUntil: number): Promise<void> {
    const a = this.accounts.get(id);
    if (a) Object.assign(a, { failedLogins, lockedUntil });
  }

  async recordLoginFailure(id: number, now: number, max: number, lockMs: number): Promise<void> {
    const a = this.accounts.get(id);
    if (!a) return;
    if (a.failedLogins + 1 >= max) Object.assign(a, { failedLogins: 0, lockedUntil: now + lockMs });
    else a.failedLogins += 1;
  }

  async setPassword(id: number, hash: PasswordHash): Promise<void> {
    const a = this.accounts.get(id);
    if (a)
      Object.assign(a, {
        passwordHash: hash.hash,
        passwordSalt: hash.salt,
        passwordIter: hash.iterations,
      });
  }

  async setGroup(id: number, fromGroupId: number, toGroupId: number): Promise<boolean> {
    const a = this.accounts.get(id);
    if (!a || a.groupId !== fromGroupId) return false;
    a.groupId = toGroupId;
    return true;
  }

  async createSession(session: SessionRecord, expectedPassword?: Buffer): Promise<boolean> {
    const a = this.accounts.get(session.accountId);
    if (!a || (expectedPassword && !a.passwordHash.equals(expectedPassword))) return false;
    const own = [...this.sessions.values()]
      .filter((s) => s.accountId === a.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (own.length >= 20) this.sessions.delete(key(own.shift()!.tokenHash));
    this.sessions.set(key(session.tokenHash), { ...session });
    return true;
  }

  async findSession(tokenHash: Buffer): Promise<SessionRecord | null> {
    const s = this.sessions.get(key(tokenHash));
    return s ? { ...s } : null;
  }

  async deleteSession(tokenHash: Buffer): Promise<void> {
    this.sessions.delete(key(tokenHash));
  }

  async deleteSessionsExcept(accountId: number, keep: Buffer | null): Promise<void> {
    const kept = keep ? key(keep) : null;
    for (const [k, s] of this.sessions)
      if (s.accountId === accountId && k !== kept) this.sessions.delete(k);
  }

  async listSessions(accountId: number, now: number): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.accountId === accountId && s.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({ ...s }));
  }

  async touchSession(hash: Buffer, now: number): Promise<void> {
    const s = this.sessions.get(key(hash));
    if (s) s.lastUsedAt = now;
  }

  async cleanup(now: number): Promise<void> {
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
    for (const [k, a] of this.actions) if (a.expiresAt <= now) this.actions.delete(k);
  }

  async getSecurity(accountId: number): Promise<AccountSecurity> {
    return {
      ...(this.security.get(accountId) ?? { verifiedEmail: '', recoveryHash: null, mailSentAt: 0 }),
    };
  }

  private securityOf(id: number): AccountSecurity {
    let s = this.security.get(id);
    if (!s) {
      s = { verifiedEmail: '', recoveryHash: null, mailSentAt: 0 };
      this.security.set(id, s);
    }
    return s;
  }

  private replacePassword(id: number, next: PasswordHash, keep: Buffer | null): void {
    const a = this.accounts.get(id)!;
    Object.assign(a, {
      passwordHash: next.hash,
      passwordSalt: next.salt,
      passwordIter: next.iterations,
      failedLogins: 0,
      lockedUntil: 0,
    });
    this.securityOf(id).recoveryHash = null;
    for (const [k, action] of this.actions) if (action.accountId === id) this.actions.delete(k);
    for (const [k, s] of this.sessions)
      if (s.accountId === id && (!keep || k !== key(keep))) this.sessions.delete(k);
  }

  async changePassword(
    id: number,
    expected: Buffer,
    next: PasswordHash,
    keep: Buffer | null,
  ): Promise<boolean> {
    if (!this.accounts.get(id)?.passwordHash.equals(expected)) return false;
    this.replacePassword(id, next, keep);
    return true;
  }

  async upgradePassword(id: number, expected: Buffer, next: PasswordHash): Promise<void> {
    const a = this.accounts.get(id);
    if (a?.passwordHash.equals(expected))
      Object.assign(a, {
        passwordHash: next.hash,
        passwordSalt: next.salt,
        passwordIter: next.iterations,
      });
  }

  async setRecoveryCode(id: number, expected: Buffer, hash: Buffer): Promise<boolean> {
    if (!this.accounts.get(id)?.passwordHash.equals(expected)) return false;
    this.securityOf(id).recoveryHash = hash;
    return true;
  }

  async issueAction(action: AccountAction, expectedPassword?: Buffer): Promise<boolean> {
    const a = this.accounts.get(action.accountId);
    if (!a || (expectedPassword && !a.passwordHash.equals(expectedPassword))) return false;
    const s = this.securityOf(a.id);
    if (s.mailSentAt && action.createdAt - s.mailSentAt < 60_000) return false;
    if (action.kind === 'reset' && (!s.verifiedEmail || s.verifiedEmail !== action.email))
      return false;
    s.mailSentAt = action.createdAt;
    for (const [k, old] of this.actions)
      if (old.accountId === a.id && old.kind === action.kind) this.actions.delete(k);
    this.actions.set(key(action.tokenHash), { ...action });
    return true;
  }

  async completeAction(hash: Buffer, now: number, next?: PasswordHash): Promise<boolean> {
    const action = this.actions.get(key(hash));
    if (!action || action.expiresAt <= now || (action.kind === 'reset') !== !!next) return false;
    const a = this.accounts.get(action.accountId)!;
    const s = this.securityOf(a.id);
    if (action.kind === 'reset') {
      if (s.verifiedEmail !== action.email) return false;
      this.replacePassword(a.id, next!, null);
    } else {
      a.email = action.email;
      s.verifiedEmail = action.email;
      for (const [k, old] of this.actions) if (old.accountId === a.id) this.actions.delete(k);
    }
    return true;
  }

  async recoverWithCode(id: number, hash: Buffer, next: PasswordHash): Promise<boolean> {
    if (!this.accounts.has(id) || !this.security.get(id)?.recoveryHash?.equals(hash)) return false;
    this.replacePassword(id, next, null);
    return true;
  }

  async getProgress(accountId: number): Promise<ProgressSnapshot> {
    const stats: Record<number, number> = {};
    for (const [id, value] of this.stats.get(accountId) ?? []) stats[id] = value;
    const achievements = [...(this.achievements.get(accountId) ?? [])]
      .map(([id, unlockedAt]) => ({ id, unlockedAt }))
      .sort((a, b) => a.id - b.id);
    return { stats, achievements };
  }

  async applyProgress(
    batchId: string,
    now: number,
    deltas: ProgressDelta[],
    legacyBatchId?: string,
  ): Promise<boolean> {
    for (const [id, at] of this.batches) if (at < now - BATCH_MEMORY_MS) this.batches.delete(id);
    if (this.batches.has(batchId) || (legacyBatchId && this.batches.has(legacyBatchId)))
      return false;
    this.batches.set(batchId, now);
    for (const d of deltas) {
      if (!this.accounts.has(d.accountId)) continue;
      const stats = this.stats.get(d.accountId) ?? new Map<number, number>();
      for (const [id, n] of Object.entries(d.add))
        stats.set(Number(id), Math.min((stats.get(Number(id)) ?? 0) + n, MAX_STAT_VALUE));
      for (const [id, n] of Object.entries(d.max))
        stats.set(Number(id), Math.max(stats.get(Number(id)) ?? 0, n));
      this.stats.set(d.accountId, stats);
      const unlocked = this.achievements.get(d.accountId) ?? new Map<number, number>();
      for (const id of d.revoke) unlocked.delete(id);
      for (const u of d.unlock) if (!unlocked.has(u.id)) unlocked.set(u.id, u.at);
      this.achievements.set(d.accountId, unlocked);
    }
    return true;
  }
}
