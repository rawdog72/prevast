// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Behaviour every AccountStore must have. Imported by the memory and MySQL
// store tests so the two cannot drift.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountStore, NewAccount } from './store';

export function sampleAccount(name: string, overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    name,
    nameKey: name.toLowerCase(),
    passwordHash: Buffer.alloc(32, 1),
    passwordSalt: Buffer.alloc(16, 2),
    passwordIter: 1000,
    email: '',
    groupId: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function describeAccountStore(label: string, make: () => Promise<AccountStore>): void {
  describe(`${label} account store`, () => {
    let store: AccountStore;
    beforeEach(async () => {
      store = await make();
    });
    afterEach(async () => {
      await store?.close();
    });

    it('preserves accounts and sessions across repeated additive migrations', async () => {
      const a = (await store.createAccount(sampleAccount('Migrated')))!;
      await store.createSession({
        tokenHash: Buffer.alloc(32, 1),
        accountId: a.id,
        createdAt: 1000,
        expiresAt: 10000,
      });
      await store.close();
      await store.init();
      expect(await store.findAccountById(a.id)).toMatchObject({ name: 'Migrated', email: '' });
      expect(await store.getSecurity(a.id)).toMatchObject({
        verifiedEmail: '',
        recoveryHash: null,
      });
      expect(await store.findSession(Buffer.alloc(32, 1))).not.toBeNull();
    });

    it('consumes recovery codes atomically and refuses stale logins after a password reset', async () => {
      const a = (await store.createAccount(sampleAccount('Recovered')))!;
      const hash = Buffer.alloc(32, 7),
        next = { hash: Buffer.alloc(32, 8), salt: Buffer.alloc(16, 9), iterations: 2000 };
      await store.createSession({
        tokenHash: Buffer.alloc(32, 1),
        accountId: a.id,
        createdAt: 1000,
        expiresAt: 10000,
      });
      expect(await store.setRecoveryCode(a.id, a.passwordHash, hash)).toBe(true);
      const results = await Promise.all([1, 2].map(() => store.recoverWithCode(a.id, hash, next)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.findSession(Buffer.alloc(32, 1))).toBeNull();
      expect(
        await store.createSession(
          { tokenHash: Buffer.alloc(32, 2), accountId: a.id, createdAt: 2000, expiresAt: 10000 },
          a.passwordHash,
        ),
      ).toBe(false);
    });

    it('verifies email and resets with expiring, single-use links under concurrent requests', async () => {
      const a = (await store.createAccount(
        sampleAccount('Verified', { email: 'old@example.com' }),
      ))!;
      const token = Buffer.alloc(32, 3),
        reset = Buffer.alloc(32, 4);
      const action = {
        accountId: a.id,
        tokenHash: token,
        kind: 'verify' as const,
        email: 'new@example.com',
        createdAt: 1000,
        expiresAt: 100000,
      };
      expect(await store.issueAction(action, a.passwordHash)).toBe(true);
      expect(await store.issueAction({ ...action, createdAt: 1001 }, a.passwordHash)).toBe(false);
      expect(await store.completeAction(token, 100000)).toBe(false);
      expect(await store.completeAction(token, 2000)).toBe(true);
      expect(await store.completeAction(token, 2000)).toBe(false);
      expect(await store.getSecurity(a.id)).toMatchObject({ verifiedEmail: 'new@example.com' });
      expect(
        await store.issueAction({ ...action, kind: 'reset', tokenHash: reset, createdAt: 62000 }),
      ).toBe(true);
      const next = { hash: Buffer.alloc(32, 8), salt: Buffer.alloc(16, 9), iterations: 2000 };
      const results = await Promise.all([1, 2].map(() => store.completeAction(reset, 63000, next)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.findAccountById(a.id))!.passwordHash.equals(next.hash)).toBe(true);
    });

    it('cleans expired sessions and keeps device activity scoped to its owner', async () => {
      const a = (await store.createAccount(sampleAccount('SessionOwner')))!;
      const tokenHash = Buffer.alloc(32, 5);
      await store.createSession({
        tokenHash,
        accountId: a.id,
        createdAt: 1000,
        expiresAt: 100000,
        device: 'Firefox on Windows',
      });
      await store.touchSession(tokenHash, 70000);
      expect(await store.listSessions(a.id, 70000)).toMatchObject([
        { device: 'Firefox on Windows', lastUsedAt: 70000 },
      ]);
      expect(await store.listSessions(a.id + 1, 70000)).toEqual([]);
      await store.cleanup(100000);
      expect(await store.findSession(tokenHash)).toBeNull();
    });

    it('creates accounts and refuses a taken name key', async () => {
      const created = await store.createAccount(sampleAccount('Alice'));
      expect(created).toMatchObject({
        name: 'Alice',
        nameKey: 'alice',
        failedLogins: 0,
        lockedUntil: 0,
      });
      expect(created!.id).toBeGreaterThan(0);
      expect(await store.createAccount(sampleAccount('ALICE', { nameKey: 'alice' }))).toBeNull();
      expect((await store.findAccountByNameKey('alice'))!.id).toBe(created!.id);
      expect(
        (await store.findAccountById(created!.id))!.passwordHash.equals(Buffer.alloc(32, 1)),
      ).toBe(true);
      expect(await store.findAccountById(999_999)).toBeNull();
    });

    it('records failures and password changes', async () => {
      const a = (await store.createAccount(sampleAccount('Bob')))!;
      await store.setLoginFailures(a.id, 3, 1234);
      expect(await store.findAccountById(a.id)).toMatchObject({
        failedLogins: 3,
        lockedUntil: 1234,
      });
      await store.setPassword(a.id, {
        hash: Buffer.alloc(32, 9),
        salt: Buffer.alloc(16, 8),
        iterations: 7,
      });
      const b = (await store.findAccountById(a.id))!;
      expect(b.passwordHash.equals(Buffer.alloc(32, 9))).toBe(true);
      expect(b.passwordSalt.equals(Buffer.alloc(16, 8))).toBe(true);
      expect(b.passwordIter).toBe(7);
    });

    it('counts login failures atomically and locks at the limit', async () => {
      const a = (await store.createAccount(sampleAccount('Erin')))!;
      await Promise.all([1, 2, 3].map(() => store.recordLoginFailure(a.id, 5000, 5, 100)));
      expect(await store.findAccountById(a.id)).toMatchObject({ failedLogins: 3, lockedUntil: 0 });
      await store.recordLoginFailure(a.id, 5000, 5, 100);
      await store.recordLoginFailure(a.id, 6000, 5, 100);
      expect(await store.findAccountById(a.id)).toMatchObject({
        failedLogins: 0,
        lockedUntil: 6100,
      });
      await store.recordLoginFailure(a.id, 7000, 5, 100);
      expect(await store.findAccountById(a.id)).toMatchObject({
        failedLogins: 1,
        lockedUntil: 6100,
      });
    });

    it('changes groups only from the expected group', async () => {
      const a = (await store.createAccount(sampleAccount('Carol')))!;
      expect(await store.setGroup(a.id, 2, 3)).toBe(false);
      expect(await store.setGroup(a.id, 1, 3)).toBe(true);
      expect((await store.findAccountById(a.id))!.groupId).toBe(3);
    });

    it('stores, finds and deletes sessions', async () => {
      const a = (await store.createAccount(sampleAccount('Dave')))!;
      const s1 = { tokenHash: Buffer.alloc(32, 1), accountId: a.id, createdAt: 1, expiresAt: 2 };
      const s2 = { tokenHash: Buffer.alloc(32, 2), accountId: a.id, createdAt: 1, expiresAt: 2 };
      await store.createSession(s1);
      await store.createSession(s2);
      expect(await store.findSession(Buffer.alloc(32, 1))).toMatchObject({
        accountId: a.id,
        expiresAt: 2,
      });
      await store.deleteSessionsExcept(a.id, s2.tokenHash);
      expect(await store.findSession(s1.tokenHash)).toBeNull();
      expect(await store.findSession(s2.tokenHash)).not.toBeNull();
      await store.deleteSession(s2.tokenHash);
      expect(await store.findSession(s2.tokenHash)).toBeNull();
    });

    it('adds stat deltas, keeps the larger record, and applies a batch id once', async () => {
      const a = (await store.createAccount(sampleAccount('Fay')))!;
      expect(await store.getProgress(a.id)).toEqual({ stats: {}, achievements: [] });
      const delta = { accountId: a.id, add: { 1: 3 }, max: { 9: 40 }, unlock: [], revoke: [] };
      expect(await store.applyProgress('srv:1', 1000, [delta])).toBe(true);
      expect(await store.applyProgress('srv:1', 1001, [delta])).toBe(false);
      expect(
        await store.applyProgress('srv:2', 1002, [
          { accountId: a.id, add: { 1: 2 }, max: { 9: 25 }, unlock: [], revoke: [] },
        ]),
      ).toBe(true);
      expect((await store.getProgress(a.id)).stats).toEqual({ 1: 5, 9: 40 });
    });

    it('unlocks achievements once, keeps the first time, revokes, and skips unknown accounts', async () => {
      const a = (await store.createAccount(sampleAccount('Gus')))!;
      await store.applyProgress('s:1', 1, [
        {
          accountId: a.id,
          add: {},
          max: {},
          unlock: [
            { id: 2, at: 100 },
            { id: 3, at: 100 },
          ],
          revoke: [],
        },
      ]);
      await store.applyProgress('s:2', 2, [
        { accountId: a.id, add: {}, max: {}, unlock: [{ id: 2, at: 999 }], revoke: [3] },
        { accountId: 999_999, add: { 1: 5 }, max: {}, unlock: [], revoke: [] },
      ]);
      expect((await store.getProgress(a.id)).achievements).toEqual([{ id: 2, unlockedAt: 100 }]);
      expect(await store.getProgress(999_999)).toEqual({ stats: {}, achievements: [] });
    });

    it('never overflows a sum and forgets old batch ids', async () => {
      const a = (await store.createAccount(sampleAccount('Hal')))!;
      await store.applyProgress('old', 0, [
        { accountId: a.id, add: { 1: Number.MAX_SAFE_INTEGER }, max: {}, unlock: [], revoke: [] },
      ]);
      await store.applyProgress('new', 1, [
        { accountId: a.id, add: { 1: 10 }, max: {}, unlock: [], revoke: [] },
      ]);
      expect((await store.getProgress(a.id)).stats[1]).toBe(Number.MAX_SAFE_INTEGER);
      expect(await store.applyProgress('old', 8 * 24 * 60 * 60 * 1000, [])).toBe(true);
    });
  });
}
