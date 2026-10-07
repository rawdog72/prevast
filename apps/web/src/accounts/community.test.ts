// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import fs from 'node:fs';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MysqlAccountStore } from './mysql-store';
import { AccountCommunity } from './community';
import {
  progressionRulesSchema,
  seasonAt,
  nextSeasonAt,
  clanShieldColor,
  type RunReport,
} from '../../../../shared/typescript/account-community';

const rules = progressionRulesSchema.parse(
  JSON.parse(fs.readFileSync('data/account-progression.json', 'utf8')),
);
describe('account progression rules', () => {
  it('uses complete 10,000-score milestones and UTC month boundaries', () => {
    expect(
      [9999, 50000, 99000, 100000, 250000].map((s) => Math.floor(s / rules.scorePerGoldenCap)),
    ).toEqual([0, 5, 9, 10, 25]);
    const at = Date.parse('2026-12-31T23:59:59Z');
    expect(seasonAt(at)).toBe('2026-12');
    expect(nextSeasonAt(at)).toBe(Date.parse('2027-01-01T00:00:00Z'));
    expect(new Set([0, 1, 2, 3, 4].map(clanShieldColor)).size).toBe(5);
  });
});
const url = process.env.COMMUNITY_TEST_DB_URL;
describe.skipIf(!url)('community transactions (isolated MariaDB)', () => {
  let store: MysqlAccountStore, c: AccountCommunity, now: number, alice: number, bob: number;
  beforeEach(async () => {
    const parsed = new URL(url!);
    const name = parsed.pathname.slice(1);
    if (!/^prevast_[a-z0-9_]*test(?:_\d+)?$/.test(name))
      throw Error('Isolated prevast_*test database required.');
    parsed.pathname = '/';
    const admin = await mysql.createConnection(parsed.toString());
    try {
      await admin.query('DROP DATABASE IF EXISTS ??', [name]);
    } finally {
      await admin.end();
    }
    store = new MysqlAccountStore(url!);
    await store.init();
    now = Date.parse('2026-10-04T12:00:00Z');
    c = store.community(rules, new Set(['ranked']), () => now);
    const create = async (name: string) =>
      (await store.createAccount({
        name,
        nameKey: name.toLowerCase(),
        email: '',
        groupId: 1,
        passwordHash: Buffer.alloc(32),
        passwordSalt: Buffer.alloc(16),
        passwordIter: 1,
        createdAt: now,
      }))!.id;
    alice = await create('Alice');
    bob = await create('Bob');
  }, 60000);
  afterEach(async () => {
    await store?.close();
  });
  const report = (accountId: number, id: string, score = 100000): RunReport => ({
    runId: id,
    bootId: 'boot1',
    accountId,
    revision: 1,
    startedAt: now - 10000,
    at: now,
    mode: 'survival',
    rulesVersion: rules.version,
    score,
    earnedScore: score,
    kills: 1,
    survivedSeconds: 10,
    end: 'alive',
    eligible: true,
    events: [{ seq: 1, at: now, score, kills: 1 }],
    awards: [],
  });
  it('does not repay retries after spending, and finalizes each life exactly once', async () => {
    const first = report(alice, 'life1', 99000);
    await c.report('ranked', first);
    const request = {
      action: 'create',
      name: 'Wasteland Wolves',
      tag: 'WOLF',
      requestId: crypto.randomUUID(),
    };
    const [a, b] = await Promise.all([c.command(alice, request), c.command(alice, request)]);
    expect(a).toEqual(b);
    expect((await c.profile(alice)).wallet).toBe(4);
    expect(await c.report('ranked', first)).toEqual({ applied: false });
    now += 1000;
    const final = { ...first, at: now, revision: 2, end: 'death' as const, events: [] };
    await c.report('ranked', final);
    await c.report('ranked', final);
    const p = await c.profile(alice);
    expect(p.wallet).toBe(4);
    expect(p.completedRuns).toBe(1);
    expect(p.averageScore).toBe(99000);
    expect(p.transactions).toHaveLength(2);
    await expect(c.report('other', final)).rejects.toThrow('identity');
  });
  it('uses historical membership and keeps departed contributors in the divisor', async () => {
    await c.report('ranked', report(alice, 'seed', 50000));
    const clan = (
      await c.command(alice, {
        action: 'create',
        name: 'Wolves',
        tag: 'WOLF',
        requestId: crypto.randomUUID(),
      })
    ).clanId!;
    await c.command(alice, { action: 'invite', account: 'Bob' });
    await c.command(bob, { action: 'accept', clanId: clan });
    now += 1000;
    const delayed = report(bob, 'bob', 20000);
    now += 1000;
    await c.command(bob, { action: 'leave' });
    await c.report('ranked', delayed);
    await c.report('ranked', report(alice, 'alice', 100000));
    const board = await c.rankings();
    expect(board.clans[0]).toMatchObject({
      id: clan,
      score: 120000,
      contributors: 2,
      members: 1,
      average: 60000,
    });
    await expect(
      c.command(bob, {
        action: 'create',
        name: 'Ash Clan',
        tag: 'ASH',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('24 hours');
    expect((await c.profile(bob)).wallet).toBe(2);
  });
  it('rejects false progression and does not pay unapproved servers', async () => {
    await c.report('sandbox', report(alice, 'practice'));
    expect((await c.profile(alice)).wallet).toBe(0);
    const r = report(bob, 'ranked');
    await expect(c.report('ranked', { ...r, earnedScore: 200000 })).rejects.toThrow('invent');
    expect((await c.profile(bob)).recentRuns).toHaveLength(0);
    await expect(
      c.command(bob, {
        action: 'create',
        name: 'Ash Clan',
        tag: 'ASH',
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow('golden caps');
    expect((await c.profile(bob)).clan).toBeNull();
  });
  it('credits an achievement once across servers and keeps interruptions out of averages', async () => {
    const r = report(alice, 'first', 0);
    r.awards = [{ kind: 'achievement', key: 'ghoul_hunter', occurrence: '1', at: now }];
    await c.report('ranked', r);
    await c.report('ranked', { ...r, runId: 'second' });
    await c.boot('ranked', 'boot2');
    const p = await c.profile(alice);
    expect(p.wallet).toBe(rules.achievementRewards.ghoul_hunter);
    expect(p.averageScore).toBeNull();
    expect(p.recentRuns.every((r) => r.end === 'interrupted')).toBe(true);
  });
  it('protects owner roles and rolls back duplicate clan names without spending', async () => {
    await c.report('ranked', report(alice, 'a'));
    await c.report('ranked', report(bob, 'b'));
    const create = {
      action: 'create',
      name: 'Wolves',
      tag: 'WOLF',
      requestId: crypto.randomUUID(),
    };
    const clan = (await c.command(alice, create)).clanId!;
    await expect(c.command(bob, { ...create, requestId: crypto.randomUUID() })).rejects.toThrow(
      'taken',
    );
    expect((await c.profile(bob)).wallet).toBe(10);
    await c.command(alice, { action: 'invite', account: 'Bob' });
    await c.command(bob, { action: 'accept', clanId: clan });
    await expect(c.command(bob, { action: 'disband', confirmTag: 'WOLF' })).rejects.toThrow(
      'owner',
    );
    await expect(c.command(alice, { action: 'leave' })).rejects.toThrow('Transfer');
    await c.command(alice, { action: 'transfer', accountId: bob });
    await c.command(alice, { action: 'leave' });
    await c.command(bob, { action: 'disband', confirmTag: 'WOLF' });
    expect((await c.profile(bob)).clan).toBeNull();
    expect((await c.profile(alice)).wallet).toBe(5);
  });
  it('splits a run across UTC seasons, freezes trophies and excludes small average samples', async () => {
    await c.report('ranked', report(alice, 'seed', 50000));
    const clan = (
      await c.command(alice, {
        action: 'create',
        name: 'Season Wolves',
        tag: 'WOLF',
        requestId: crypto.randomUUID(),
      })
    ).clanId!;
    now = Date.parse('2026-11-01T00:00:01Z');
    const crossing = report(alice, 'crossing', 20000);
    crossing.events = [
      { seq: 1, at: now - 2000, score: 10000, kills: 0 },
      { seq: 2, at: now, score: 10000, kills: 1 },
    ];
    crossing.end = 'death';
    await c.report('ranked', crossing);
    expect((await c.rankings('2026-10')).clans[0]).toMatchObject({ id: clan, score: 10000 });
    expect((await c.rankings()).clans[0]).toMatchObject({ id: clan, score: 10000 });
    expect((await c.rankings(undefined, 'average')).players).toHaveLength(0);
    for (let i = 0; i < 9; i++) {
      now += 1000;
      await c.report('ranked', { ...report(alice, 'sample' + i, 10000), end: 'death' });
    }
    expect((await c.rankings(undefined, 'average')).players[0]).toMatchObject({
      id: alice,
      score: 11000,
      sessions: 10,
    });
    now = Date.parse('2026-11-09T00:00:00Z');
    await c.settleSeasons();
    const late = report(alice, 'late', 90000);
    late.at = late.events[0]!.at = Date.parse('2026-10-31T23:59:58Z');
    late.startedAt = late.at - 10000;
    await c.report('ranked', late);
    expect((await c.rankings('2026-10')).clans[0]!.score).toBe(10000);
    expect((await c.clan(clan, alice)).trophies[0]).toMatchObject({
      season: '2026-10',
      rank: 1,
      score: 10000,
    });
    expect((await c.profile(alice)).wallet).toBe(20);
  });
  it('deduplicates configured event occurrences and rejects changed or out-of-order runs', async () => {
    c = store.community({ ...rules, eventRewards: { winter: 3 } }, new Set(['ranked']), () => now);
    const r = report(alice, 'event', 0);
    r.awards = [{ kind: 'event', key: 'winter', occurrence: '2026-day1', at: now }];
    await c.report('ranked', r);
    await c.report('ranked', { ...r, runId: 'event-again' });
    expect((await c.profile(alice)).wallet).toBe(3);
    await expect(c.report('ranked', { ...r, revision: 2, startedAt: now - 9000 })).rejects.toThrow(
      'identity',
    );
    await expect(
      c.report('ranked', { ...r, revision: 2, events: [{ seq: 3, at: now, score: 0, kills: 0 }] }),
    ).rejects.toThrow('order');
    await c.report('ranked', {
      ...r,
      runId: 'event-next',
      awards: [{ ...r.awards[0]!, occurrence: '2026-day2' }],
    });
    expect((await c.profile(alice)).wallet).toBe(6);
  });
});
