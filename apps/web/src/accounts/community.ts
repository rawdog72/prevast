// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import {
  clanCommandSchema,
  runReportSchema,
  seasonAt,
  nextSeasonAt,
  type ProgressionRules,
  type CommunityProfile,
  type ClanView,
  type ClanIdentity,
  type Rankings,
  type RankingRow,
} from '../../../../shared/typescript/account-community';

type DB = Pool | PoolConnection;
const num = (v: unknown): number => Number(v ?? 0);
const DAY = 86400000;
const MAX = Number.MAX_SAFE_INTEGER;
export class CommunityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function refuse(status: number, text: string): never {
  throw new CommunityError(status, text);
}
async function rows(db: DB, sql: string, args: unknown[] = []): Promise<RowDataPacket[]> {
  return (await db.query<RowDataPacket[]>(sql, args))[0];
}
async function write(db: DB, sql: string, args: unknown[] = []): Promise<ResultSetHeader> {
  return (await db.query<ResultSetHeader>(sql, args))[0];
}

/** All balances, run receipts and membership changes commit in the accounts database. */
export class AccountCommunity {
  constructor(
    private readonly pool: () => Pool,
    readonly rules: ProgressionRules,
    private readonly rankedServers: ReadonlySet<string>,
    private readonly now = Date.now,
  ) {}

  private async transaction<T>(fn: (db: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = await this.pool().getConnection();
      try {
        await db.beginTransaction();
        const result = await fn(db);
        await db.commit();
        return result;
      } catch (e) {
        await db.rollback().catch(() => {});
        if (
          attempt < 2 &&
          ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes((e as { code?: string }).code ?? '')
        )
          continue;
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY')
          refuse(409, 'That clan name or tag is already taken.');
        throw e;
      } finally {
        db.release();
      }
    }
  }
  private async wallet(db: DB, accountId: number): Promise<RowDataPacket> {
    if (!(await rows(db, 'SELECT id FROM accounts WHERE id=?', [accountId])).length)
      refuse(404, 'Account not found.');
    await write(db, 'INSERT IGNORE INTO account_wallets(account_id) VALUES (?)', [accountId]);
    return (
      await rows(db, 'SELECT * FROM account_wallets WHERE account_id=? FOR UPDATE', [accountId])
    )[0]!;
  }
  private async credit(
    db: DB,
    accountId: number,
    receipt: string,
    amount: number,
    reason: string,
    at: number,
  ): Promise<boolean> {
    const inserted = await write(
      db,
      `INSERT IGNORE INTO wallet_transactions(account_id,receipt,amount,reason,at) VALUES (?,?,?,?,?)`,
      [accountId, receipt, amount, reason, at],
    );
    if (!inserted.affectedRows) return false;
    const updated = await write(
      db,
      `UPDATE account_wallets SET balance=balance+? WHERE account_id=? AND balance>=? AND balance<=?`,
      [amount, accountId, Math.max(0, -amount), MAX - Math.max(0, amount)],
    );
    if (!updated.affectedRows)
      refuse(
        409,
        amount < 0
          ? 'You need ' + this.rules.clanCreationCost + ' golden caps to create a clan.'
          : 'The wallet balance limit was reached.',
      );
    return true;
  }
  private async membership(db: DB, id: number): Promise<RowDataPacket | undefined> {
    return (
      await rows(
        db,
        `SELECT m.*,c.tag,c.name FROM clan_members m JOIN account_clans c ON c.id=m.clan_id
      WHERE m.account_id=? AND c.deleted_at IS NULL`,
        [id],
      )
    )[0];
  }
  private async audit(
    db: DB,
    clanId: number,
    actor: number,
    action: string,
    target: number | null,
    at: number,
  ): Promise<void> {
    await write(
      db,
      'INSERT INTO clan_audit(clan_id,actor_id,action,target_id,at) VALUES (?,?,?,?,?)',
      [clanId, actor, action, target, at],
    );
  }
  private checkJoin(wallet: RowDataPacket, now: number): void {
    if (
      num(wallet.last_joined_at) &&
      now < num(wallet.last_joined_at) + this.rules.clanSwitchCooldownHours * 3600000
    )
      refuse(409, 'Wait 24 hours after your previous clan join before joining another clan.');
  }
  private async join(
    db: DB,
    account: number,
    clan: number,
    role: string,
    now: number,
  ): Promise<void> {
    await write(
      db,
      'INSERT INTO clan_members(account_id,clan_id,role,joined_at) VALUES (?,?,?,?)',
      [account, clan, role, now],
    );
    await write(
      db,
      'INSERT INTO clan_membership_history(account_id,clan_id,joined_at) VALUES (?,?,?)',
      [account, clan, now],
    );
    await write(db, 'UPDATE account_wallets SET last_joined_at=? WHERE account_id=?', [
      now,
      account,
    ]);
    await write(db, 'DELETE FROM clan_invitations WHERE account_id=?', [account]);
  }

  async command(accountId: number, input: unknown): Promise<{ clanId: number | null }> {
    const parsed = clanCommandSchema.safeParse(input);
    if (!parsed.success) refuse(400, 'Check the clan name, tag and action details.');
    const command = parsed.data;
    return this.transaction(async (db) => {
      // Serialize clan mutations, including cross-account role changes, while run reporting
      // continues independently. This is a database row lock, released on commit/rollback.
      await write(db, "INSERT IGNORE INTO community_seasons(season) VALUES ('clans')");
      await rows(db, "SELECT season FROM community_seasons WHERE season='clans' FOR UPDATE");
      const now = this.now(),
        wallet = await this.wallet(db, accountId);
      const own = await this.membership(db, accountId);
      if (command.action === 'create') {
        const prior = (
          await rows(db, 'SELECT clan_id FROM clan_requests WHERE account_id=? AND request_id=?', [
            accountId,
            command.requestId,
          ])
        )[0];
        if (prior) return { clanId: num(prior.clan_id) };
        if (own) refuse(409, 'Leave your current clan before creating another.');
        this.checkJoin(wallet, now);
        const result = await write(
          db,
          'INSERT INTO account_clans(name,name_key,tag,tag_key,created_at) VALUES (?,?,?,?,?)',
          [
            command.name,
            command.name.toLowerCase(),
            command.tag.toUpperCase(),
            command.tag.toUpperCase(),
            now,
          ],
        );
        await this.credit(
          db,
          accountId,
          'clan:' + command.requestId,
          -this.rules.clanCreationCost,
          'Created clan ' + command.tag.toUpperCase(),
          now,
        );
        await this.join(db, accountId, result.insertId, 'owner', now);
        await this.audit(db, result.insertId, accountId, 'created', null, now);
        await write(db, 'INSERT INTO clan_requests(account_id,request_id,clan_id) VALUES (?,?,?)', [
          accountId,
          command.requestId,
          result.insertId,
        ]);
        return { clanId: result.insertId };
      }
      if (command.action === 'accept' || command.action === 'decline') {
        if (command.action === 'decline') {
          await write(db, 'DELETE FROM clan_invitations WHERE clan_id=? AND account_id=?', [
            command.clanId,
            accountId,
          ]);
          return { clanId: own ? num(own.clan_id) : null };
        }
        if (own) refuse(409, 'Leave your current clan before accepting an invitation.');
        this.checkJoin(wallet, now);
        const invitation = await rows(
          db,
          `SELECT i.clan_id FROM clan_invitations i JOIN account_clans c ON c.id=i.clan_id
          WHERE i.clan_id=? AND i.account_id=? AND i.expires_at>? AND c.deleted_at IS NULL`,
          [command.clanId, accountId, now],
        );
        if (!invitation.length) refuse(404, 'That invitation expired or the clan was disbanded.');
        await this.join(db, accountId, command.clanId, 'member', now);
        await this.audit(db, command.clanId, accountId, 'joined', accountId, now);
        return { clanId: command.clanId };
      }
      if (!own) refuse(409, 'You do not belong to a clan.');
      const clanId = num(own.clan_id);
      if (command.action === 'invite') {
        if (own.role === 'member') refuse(403, 'Only the owner and officers can invite members.');
        const target = (
          await rows(db, 'SELECT id FROM accounts WHERE name_key=?', [
            command.account.toLowerCase(),
          ])
        )[0];
        if (!target) refuse(404, 'Account not found.');
        const targetId = num(target.id);
        await this.wallet(db, targetId);
        if (await this.membership(db, targetId))
          refuse(409, 'That account already belongs to a clan.');
        const count = (
          await rows(
            db,
            'SELECT COUNT(*) n FROM clan_invitations WHERE account_id=? AND expires_at>?',
            [targetId, now],
          )
        )[0]!;
        if (num(count.n) >= 100) refuse(409, 'That account has too many pending invitations.');
        await write(
          db,
          `INSERT INTO clan_invitations(clan_id,account_id,expires_at) VALUES (?,?,?)
          ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at)`,
          [clanId, targetId, now + 7 * DAY],
        );
        await this.audit(db, clanId, accountId, 'invited', targetId, now);
      } else if (command.action === 'leave' || command.action === 'kick') {
        const targetId = command.action === 'leave' ? accountId : command.accountId;
        await this.wallet(db, targetId);
        const target = await this.membership(db, targetId);
        if (!target || num(target.clan_id) !== clanId)
          refuse(404, 'That account is not in your clan.');
        if (target.role === 'owner')
          refuse(409, 'Transfer ownership or disband the clan before leaving.');
        if (
          command.action === 'kick' &&
          (own.role === 'member' || (own.role === 'officer' && target.role !== 'member'))
        )
          refuse(403, 'You cannot remove that member.');
        await write(
          db,
          'UPDATE clan_membership_history SET left_at=? WHERE account_id=? AND left_at IS NULL',
          [now, targetId],
        );
        await write(db, 'DELETE FROM clan_members WHERE account_id=?', [targetId]);
        await this.audit(
          db,
          clanId,
          accountId,
          command.action === 'leave' ? 'left' : 'removed',
          targetId,
          now,
        );
        if (targetId === accountId) return { clanId: null };
      } else if (command.action === 'disband') {
        if (own.role !== 'owner') refuse(403, 'Only the owner can disband the clan.');
        if (command.confirmTag.toUpperCase() !== own.tag)
          refuse(400, 'Type your clan tag to confirm disbanding.');
        await rows(
          db,
          `SELECT w.account_id FROM account_wallets w JOIN clan_members m ON m.account_id=w.account_id
          WHERE m.clan_id=? FOR UPDATE`,
          [clanId],
        );
        await write(
          db,
          'UPDATE clan_membership_history SET left_at=? WHERE clan_id=? AND left_at IS NULL',
          [now, clanId],
        );
        await write(db, 'DELETE FROM clan_members WHERE clan_id=?', [clanId]);
        await write(db, 'DELETE FROM clan_invitations WHERE clan_id=?', [clanId]);
        await write(
          db,
          'UPDATE account_clans SET deleted_at=?,name_key=NULL,tag_key=NULL WHERE id=?',
          [now, clanId],
        );
        await this.audit(db, clanId, accountId, 'disbanded', null, now);
        return { clanId: null };
      } else {
        if (own.role !== 'owner')
          refuse(403, 'Only the owner can change roles or transfer ownership.');
        if (command.accountId === accountId) refuse(400, 'Choose another member.');
        await this.wallet(db, command.accountId);
        const target = await this.membership(db, command.accountId);
        if (!target || num(target.clan_id) !== clanId)
          refuse(404, 'That account is not in your clan.');
        if (command.action === 'transfer') {
          await write(db, "UPDATE clan_members SET role='officer' WHERE account_id=?", [accountId]);
          await write(db, "UPDATE clan_members SET role='owner' WHERE account_id=?", [
            command.accountId,
          ]);
        } else
          await write(db, 'UPDATE clan_members SET role=? WHERE account_id=?', [
            command.action === 'promote' ? 'officer' : 'member',
            command.accountId,
          ]);
        await this.audit(db, clanId, accountId, command.action, command.accountId, now);
      }
      return { clanId };
    });
  }

  private async openSeason(db: DB, season: string): Promise<boolean> {
    if (season === 'all') return true;
    await write(db, 'INSERT IGNORE INTO community_seasons(season) VALUES (?)', [season]);
    const row = (
      await rows(db, 'SELECT settled_at FROM community_seasons WHERE season=? FOR UPDATE', [season])
    )[0]!;
    return row.settled_at === null;
  }
  private async addScores(
    db: DB,
    account: number,
    at: number,
    score: number,
    kills: number,
  ): Promise<void> {
    const historical = (
      await rows(
        db,
        `SELECT clan_id FROM clan_membership_history
      WHERE account_id=? AND joined_at<=? AND (left_at IS NULL OR left_at>?) ORDER BY joined_at DESC,id DESC LIMIT 1`,
        [account, at, at],
      )
    )[0];
    for (const season of ['all', seasonAt(at)]) {
      if (!(await this.openSeason(db, season))) continue;
      await write(
        db,
        `INSERT INTO account_rank_scores(account_id,season,score,kills) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE score=LEAST(?,score+VALUES(score)),kills=LEAST(?,kills+VALUES(kills))`,
        [account, season, score, kills, MAX, MAX],
      );
      if (historical && score > 0)
        await write(
          db,
          `INSERT INTO clan_contributions(clan_id,account_id,season,score) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE score=LEAST(?,score+VALUES(score))`,
          [historical.clan_id, account, season, score, MAX],
        );
    }
  }
  async report(serverId: string, input: unknown): Promise<{ applied: boolean }> {
    const parsed = runReportSchema.safeParse(input);
    if (!parsed.success) refuse(400, 'Malformed survivor run report.');
    const r = parsed.data,
      now = this.now();
    if (
      r.startedAt > r.at ||
      r.at > now + 30000 ||
      r.events.some((e) => e.at < r.startedAt || e.at > r.at) ||
      r.awards.some((a) => a.at < r.startedAt || a.at > r.at)
    )
      refuse(400, 'Invalid run timestamps.');
    return this.transaction(async (db) => {
      await this.wallet(db, r.accountId);
      await write(
        db,
        `INSERT IGNORE INTO survivor_runs(id,server_id,boot_id,account_id,mode,rules_version,started_at,reported_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        [r.runId, serverId, r.bootId, r.accountId, r.mode, r.rulesVersion, r.startedAt, r.at],
      );
      const old = (
        await rows(db, 'SELECT * FROM survivor_runs WHERE id=? FOR UPDATE', [r.runId])
      )[0]!;
      if (
        old.server_id !== serverId ||
        num(old.account_id) !== r.accountId ||
        old.boot_id !== r.bootId ||
        num(old.started_at) !== r.startedAt ||
        old.mode !== r.mode ||
        num(old.rules_version) !== r.rulesVersion
      )
        refuse(409, 'Run identity cannot change.');
      if (r.revision <= num(old.revision)) return { applied: false };
      if (old.ending !== 'alive') refuse(409, 'That run is already finalized.');
      let seq = num(old.event_seq),
        earned = num(old.earned_score),
        lastAt = num(old.revision) ? num(old.reported_at) : r.startedAt;
      for (const e of r.events) {
        if (e.seq !== ++seq || e.at < lastAt)
          refuse(409, 'Run events must arrive in order without gaps.');
        earned += e.score;
        lastAt = e.at;
      }
      if (
        !Number.isSafeInteger(earned) ||
        earned !== r.earnedScore ||
        r.at < num(old.reported_at) ||
        r.kills < num(old.kills) ||
        r.survivedSeconds < num(old.survived_seconds)
      )
        refuse(409, 'Run counters cannot lose or invent progress.');
      const approved =
        this.rankedServers.has(serverId) &&
        this.rules.rankedModes.includes(r.mode) &&
        r.rulesVersion === this.rules.version;
      let paid = num(old.paid_caps),
        rewardCaps = num(old.reward_caps);
      if (approved) {
        for (const e of r.events) await this.addScores(db, r.accountId, e.at, e.score, e.kills);
        const caps = Math.floor(earned / this.rules.scorePerGoldenCap);
        if (caps > paid) {
          await this.credit(
            db,
            r.accountId,
            'run:' + r.runId + ':through:' + caps,
            caps - paid,
            'Survivor score milestones',
            r.at,
          );
          paid = caps;
        }
        for (const award of r.awards) {
          const amount =
            (award.kind === 'achievement'
              ? this.rules.achievementRewards
              : this.rules.eventRewards)[award.key] ?? 0;
          const receipt =
            award.kind + ':' + award.key + (award.kind === 'event' ? ':' + award.occurrence : '');
          if (
            amount > 0 &&
            (await this.credit(
              db,
              r.accountId,
              receipt,
              amount,
              award.kind + ': ' + award.key,
              award.at,
            ))
          )
            rewardCaps += amount;
        }
      }
      const eligible = approved && r.eligible;
      if (r.end === 'death' && eligible) {
        for (const season of ['all', seasonAt(r.at)]) {
          if (!(await this.openSeason(db, season))) continue;
          await write(
            db,
            `INSERT INTO account_rank_scores(account_id,season,completed,final_score,best_score) VALUES (?,?,1,?,?)
            ON DUPLICATE KEY UPDATE completed=completed+1,final_score=LEAST(?,final_score+VALUES(final_score)),
            best_score=GREATEST(best_score,VALUES(best_score))`,
            [r.accountId, season, earned, earned, MAX],
          );
        }
      }
      await write(
        db,
        `UPDATE survivor_runs SET revision=?,event_seq=?,reported_at=?,ended_at=?,ending=?,score=?,
        earned_score=?,kills=?,survived_seconds=?,paid_caps=?,reward_caps=?,eligible=? WHERE id=?`,
        [
          r.revision,
          seq,
          r.at,
          r.end === 'alive' ? null : r.at,
          r.end,
          r.score,
          earned,
          r.kills,
          r.survivedSeconds,
          paid,
          rewardCaps,
          eligible,
          r.runId,
        ],
      );
      return { applied: true };
    });
  }
  /** Called after replaying the previous process's outbox, before new runs. */
  async boot(serverId: string, bootId: string): Promise<void> {
    if (!/^[A-Za-z0-9:._-]{1,80}$/.test(bootId)) refuse(400, 'Invalid server boot identity.');
    await write(
      this.pool(),
      `UPDATE survivor_runs SET ending='interrupted',ended_at=reported_at
      WHERE server_id=? AND boot_id<>? AND ending='alive'`,
      [serverId, bootId],
    );
  }

  private async clanRows(db: DB, season: string): Promise<RankingRow[]> {
    const values = await rows(
      db,
      `SELECT c.id,c.name,c.tag,SUM(v.score) score,COUNT(*) contributors,
      (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id=c.id) members
      FROM clan_contributions v JOIN account_clans c ON c.id=v.clan_id
      WHERE v.season=? AND v.score>0 AND (c.deleted_at IS NULL OR ?<>?)
      GROUP BY c.id,c.name,c.tag ORDER BY score DESC,c.id ASC`,
      [season, season, seasonAt(this.now())],
    );
    return values.map((r, i) => ({
      rank: i + 1,
      id: num(r.id),
      name: String(r.name),
      tag: String(r.tag),
      score: num(r.score),
      contributors: num(r.contributors),
      members: num(r.members),
      average: num(r.score) / num(r.contributors),
    }));
  }
  async rankings(
    season = seasonAt(this.now()),
    metric: Rankings['metric'] = 'score',
    offset = 0,
  ): Promise<Rankings> {
    if (season !== 'all' && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(season))
      refuse(400, 'Choose a valid season.');
    const expressions = {
      score: 's.score',
      kills: 's.kills',
      best: 's.best_score',
      average: 's.final_score / NULLIF(s.completed,0)',
    };
    if (!Object.hasOwn(expressions, metric)) refuse(400, 'Unknown leaderboard.');
    const expression = expressions[metric];
    const result = await rows(
      this.pool(),
      `SELECT a.id,a.name,${expression} score,s.completed sessions
      FROM account_rank_scores s JOIN accounts a ON a.id=s.account_id WHERE s.season=? AND ${expression}>0
      ${metric === 'average' ? 'AND s.completed >= ?' : ''} ORDER BY score DESC,a.id ASC LIMIT 51 OFFSET ?`,
      metric === 'average'
        ? [season, this.rules.averageLeaderboardMinimumRuns, offset]
        : [season, offset],
    );
    const clans = await this.clanRows(this.pool(), season);
    return {
      season,
      metric,
      nextResetAt: nextSeasonAt(this.now()),
      players: result.slice(0, 50).map((r, i) => ({
        rank: offset + i + 1,
        id: num(r.id),
        name: String(r.name),
        score: num(r.score),
        sessions: num(r.sessions),
      })),
      clans: clans.slice(offset, offset + 50),
      nextOffset: result.length > 50 || clans.length > offset + 50 ? offset + 50 : null,
    };
  }
  async clan(clanId: number, viewer: number, offset = 0, search = ''): Promise<ClanView> {
    const db = this.pool(),
      base = (
        await rows(db, 'SELECT * FROM account_clans WHERE id=? AND deleted_at IS NULL', [clanId])
      )[0];
    if (!base) refuse(404, 'Clan not found.');
    const own = await this.membership(db, viewer),
      season = seasonAt(this.now());
    const rank = (await this.clanRows(db, season)).find((c) => c.id === clanId);
    const count = (
      await rows(db, 'SELECT COUNT(*) n FROM clan_members WHERE clan_id=?', [clanId])
    )[0]!;
    const roster = await rows(
      db,
      `SELECT a.id,a.name,m.role,m.joined_at,COALESCE(v.score,0) contribution FROM clan_members m
      JOIN accounts a ON a.id=m.account_id LEFT JOIN clan_contributions v ON v.account_id=m.account_id AND v.clan_id=m.clan_id AND v.season=?
      WHERE m.clan_id=? AND LOCATE(?,LOWER(a.name))>0 ORDER BY m.account_id LIMIT 51 OFFSET ?`,
      [season, clanId, search.toLowerCase(), offset],
    );
    const contribution = (
      await rows(
        db,
        'SELECT score FROM clan_contributions WHERE clan_id=? AND account_id=? AND season=?',
        [clanId, viewer, season],
      )
    )[0];
    const audit =
      own && num(own.clan_id) === clanId
        ? await rows(
            db,
            `SELECT l.at,l.action,a.name actor,t.name target FROM clan_audit l
      LEFT JOIN accounts a ON a.id=l.actor_id LEFT JOIN accounts t ON t.id=l.target_id WHERE clan_id=? ORDER BY l.id DESC LIMIT 30`,
            [clanId],
          )
        : [];
    const trophies = await rows(
      db,
      'SELECT season,rank_value,score FROM clan_trophies WHERE clan_id=? ORDER BY season DESC LIMIT 24',
      [clanId],
    );
    return {
      id: clanId,
      name: String(base.name),
      tag: String(base.tag),
      rank: rank?.rank ?? 0,
      role: own && num(own.clan_id) === clanId ? own.role : null,
      members: num(count.n),
      contributors: rank?.contributors ?? 0,
      score: rank?.score ?? 0,
      average: rank?.average ?? null,
      yourContribution: num(contribution?.score),
      roster: roster
        .slice(0, 50)
        .map((r) => ({
          id: num(r.id),
          name: String(r.name),
          role: r.role,
          joinedAt: num(r.joined_at),
          contribution: num(r.contribution),
        })),
      nextOffset: roster.length > 50 ? offset + 50 : null,
      audit: audit.map((r) => ({
        at: num(r.at),
        actor: String(r.actor ?? 'Account'),
        action: String(r.action),
        target: String(r.target ?? ''),
      })),
      trophies: trophies.map((r) => ({
        season: String(r.season),
        rank: num(r.rank_value),
        score: num(r.score),
      })),
    };
  }
  async profile(accountId: number): Promise<CommunityProfile> {
    const db = this.pool(),
      account = (await rows(db, 'SELECT name FROM accounts WHERE id=?', [accountId]))[0];
    if (!account) refuse(404, 'Account not found.');
    const totals = (
      await rows(
        db,
        `SELECT COUNT(*) completed,COALESCE(SUM(score),0) total,COALESCE(MAX(score),0) best
      FROM survivor_runs WHERE account_id=? AND ending='death'`,
        [accountId],
      )
    )[0]!;
    const runs = await rows(
      db,
      'SELECT * FROM survivor_runs WHERE account_id=? ORDER BY started_at DESC,id DESC LIMIT 20',
      [accountId],
    );
    const wallet = (
      await rows(db, 'SELECT * FROM account_wallets WHERE account_id=?', [accountId])
    )[0];
    const transactions = await rows(
      db,
      'SELECT id,at,amount,reason FROM wallet_transactions WHERE account_id=? ORDER BY id DESC LIMIT 50',
      [accountId],
    );
    const membership = await this.membership(db, accountId);
    const invitations = await rows(
      db,
      `SELECT c.id,c.name,c.tag FROM clan_invitations i JOIN account_clans c ON c.id=i.clan_id
      WHERE i.account_id=? AND i.expires_at>? AND c.deleted_at IS NULL ORDER BY c.id`,
      [accountId, this.now()],
    );
    return {
      accountId,
      name: String(account.name),
      completedRuns: num(totals.completed),
      totalFinalScore: num(totals.total),
      averageScore: num(totals.completed) ? num(totals.total) / num(totals.completed) : null,
      bestScore: num(totals.best),
      recentRuns: runs.map((r) => ({
        id: String(r.id),
        mode: String(r.mode),
        startedAt: num(r.started_at),
        endedAt: r.ended_at === null ? null : num(r.ended_at),
        end: String(r.ending),
        score: num(r.score),
        earnedScore: num(r.earned_score),
        kills: num(r.kills),
        survivedSeconds: num(r.survived_seconds),
        goldenCaps: num(r.paid_caps) + num(r.reward_caps),
      })),
      wallet: num(wallet?.balance),
      transactions: transactions.map((r) => ({
        id: num(r.id),
        at: num(r.at),
        amount: num(r.amount),
        reason: String(r.reason),
      })),
      clan: membership ? await this.clan(num(membership.clan_id), accountId) : null,
      invitations: invitations.map((r) => ({
        clanId: num(r.id),
        name: String(r.name),
        tag: String(r.tag),
      })),
      canJoinAt: num(wallet?.last_joined_at)
        ? num(wallet?.last_joined_at) + this.rules.clanSwitchCooldownHours * 3600000
        : 0,
      rules: {
        scorePerGoldenCap: this.rules.scorePerGoldenCap,
        clanCreationCost: this.rules.clanCreationCost,
        averageLeaderboardMinimumRuns: this.rules.averageLeaderboardMinimumRuns,
      },
    };
  }
  async identities(ids: number[]): Promise<{ id: number; clan: ClanIdentity | null }[]> {
    if (!ids.length) return [];
    const values = await rows(
      this.pool(),
      `SELECT m.account_id,c.id,c.name,c.tag FROM clan_members m JOIN account_clans c ON c.id=m.clan_id
      WHERE m.account_id IN (?) AND c.deleted_at IS NULL`,
      [ids],
    );
    const ranks = await this.clanRows(this.pool(), seasonAt(this.now()));
    return ids.map((id) => {
      const v = values.find((r) => num(r.account_id) === id);
      return {
        id,
        clan: v
          ? {
              id: num(v.id),
              name: String(v.name),
              tag: String(v.tag),
              rank: ranks.find((r) => r.id === num(v.id))?.rank ?? 0,
            }
          : null,
      };
    });
  }
  async bests(ids: number[]): Promise<{ id: number; score: number }[]> {
    if (!ids.length) return [];
    const result = await rows(
      this.pool(),
      "SELECT account_id,MAX(score) score FROM survivor_runs WHERE account_id IN (?) AND ending='death' GROUP BY account_id",
      [ids],
    );
    return result.map((r) => ({ id: num(r.account_id), score: num(r.score) }));
  }
  serverRules(serverId: string): { rules: ProgressionRules; ranked: boolean } {
    return { rules: this.rules, ranked: this.rankedServers.has(serverId) };
  }
  /** Seven days allow queued reports to arrive. Later reports still count for lifetime and wallet. */
  async settleSeasons(): Promise<void> {
    const candidates = await rows(
      this.pool(),
      "SELECT season FROM community_seasons WHERE settled_at IS NULL AND season REGEXP '^20[0-9]{2}-[0-9]{2}$'",
    );
    for (const c of candidates) {
      const season = String(c.season),
        end = nextSeasonAt(Date.parse(season + '-01T00:00:00Z'));
      if (this.now() < end + 7 * DAY) continue;
      await this.transaction(async (db) => {
        if (!(await this.openSeason(db, season))) return;
        const winners = (await this.clanRows(db, season)).slice(0, 10);
        for (const winner of winners)
          await write(
            db,
            'INSERT IGNORE INTO clan_trophies(clan_id,season,rank_value,score) VALUES (?,?,?,?)',
            [winner.id, season, winner.rank, winner.score],
          );
        await write(db, 'UPDATE community_seasons SET settled_at=? WHERE season=?', [
          this.now(),
          season,
        ]);
      });
    }
  }
}
