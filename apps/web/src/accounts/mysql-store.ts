// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/web/src/accounts/mysql-store.ts
// MariaDB/MySQL account storage. init() creates the database and tables when
// missing, so a fresh XAMPP needs nothing but a running server.
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { migrateAccounts } from './migrations';
import { AccountCommunity } from './community';
import type { ProgressionRules } from '../../../../shared/typescript/account-community';
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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(16) NOT NULL,
    name_key VARCHAR(16) NOT NULL,
    password_hash BINARY(32) NOT NULL,
    password_salt BINARY(16) NOT NULL,
    password_iter INT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL DEFAULT '',
    group_id SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    failed_logins SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY accounts_name_key (name_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash BINARY(32) NOT NULL PRIMARY KEY,
    account_id INT UNSIGNED NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    KEY sessions_account (account_id),
    CONSTRAINT sessions_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Account progress (the game server's ProgressSystem). Ids come from the
  // server's stats.xml / achievements.xml and are never reused.
  `CREATE TABLE IF NOT EXISTS account_stats (
    account_id INT UNSIGNED NOT NULL,
    stat_id SMALLINT UNSIGNED NOT NULL,
    value BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (account_id, stat_id),
    CONSTRAINT account_stats_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS account_achievements (
    account_id INT UNSIGNED NOT NULL,
    achievement_id SMALLINT UNSIGNED NOT NULL,
    unlocked_at BIGINT NOT NULL,
    PRIMARY KEY (account_id, achievement_id),
    CONSTRAINT account_achievements_account_fk FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Batches already applied, so a game server's retry is not counted twice.
  `CREATE TABLE IF NOT EXISTS progress_batches (
    batch_id VARCHAR(96) NOT NULL PRIMARY KEY,
    received_at BIGINT NOT NULL,
    KEY progress_batches_received (received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

interface AccountRow extends RowDataPacket {
  id: number;
  name: string;
  name_key: string;
  password_hash: Buffer;
  password_salt: Buffer;
  password_iter: number;
  email: string;
  group_id: number;
  created_at: number | string;
  failed_logins: number;
  locked_until: number | string;
}

interface SessionRow extends RowDataPacket {
  token_hash: Buffer;
  account_id: number;
  created_at: number | string;
  expires_at: number | string;
}

const toAccount = (r: AccountRow): AccountRecord => ({
  id: r.id,
  name: r.name,
  nameKey: r.name_key,
  passwordHash: r.password_hash,
  passwordSalt: r.password_salt,
  passwordIter: r.password_iter,
  email: r.email,
  groupId: r.group_id,
  createdAt: Number(r.created_at),
  failedLogins: r.failed_logins,
  lockedUntil: Number(r.locked_until),
});

export class MysqlAccountStore implements AccountStore {
  private pool: Pool | null = null;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    const parsed = new URL(this.url);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    if (!database)
      throw new Error(
        'The accounts database URL needs a database name, e.g. mysql://root@127.0.0.1:3306/prevast_accounts',
      );
    parsed.pathname = '/';
    // Nothing is left open when a step fails, so the web host can simply
    // call init() again later (index.ts retries while the database is down).
    const admin = await mysql.createConnection(parsed.toString());
    try {
      await admin.query('CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4', [database]);
    } finally {
      await admin.end().catch(() => {});
    }
    const pool = mysql.createPool({ uri: this.url, connectionLimit: 8 });
    try {
      for (const statement of SCHEMA) await pool.query(statement);
      await migrateAccounts(pool);
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
    this.pool = pool;
  }

  community(rules: ProgressionRules, rankedServers: ReadonlySet<string>, now?: () => number): AccountCommunity {
    return new AccountCommunity(() => this.db, rules, rankedServers, now);
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private get db(): Pool {
    if (!this.pool) throw new Error('MysqlAccountStore.init() was not called');
    return this.pool;
  }

  async createAccount(a: NewAccount): Promise<AccountRecord | null> {
    try {
      const [result] = await this.db.execute<mysql.ResultSetHeader>(
        `INSERT INTO accounts (name, name_key, password_hash, password_salt, password_iter, email, group_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.name,
          a.nameKey,
          a.passwordHash,
          a.passwordSalt,
          a.passwordIter,
          a.email,
          a.groupId,
          a.createdAt,
        ],
      );
      return this.findAccountById(result.insertId);
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return null;
      throw error;
    }
  }

  async findAccountById(id: number): Promise<AccountRecord | null> {
    const [rows] = await this.db.execute<AccountRow[]>('SELECT * FROM accounts WHERE id = ?', [id]);
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async findAccountByNameKey(key: string): Promise<AccountRecord | null> {
    const [rows] = await this.db.execute<AccountRow[]>(
      'SELECT * FROM accounts WHERE name_key = ?',
      [key],
    );
    return rows[0] ? toAccount(rows[0]) : null;
  }

  async setLoginFailures(id: number, failedLogins: number, lockedUntil: number): Promise<void> {
    await this.db.execute('UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?', [
      failedLogins,
      lockedUntil,
      id,
    ]);
  }

  async recordLoginFailure(id: number, now: number, max: number, lockMs: number): Promise<void> {
    // One statement, so concurrent failures cannot overwrite each other.
    // MySQL applies SET assignments left to right, so locked_until goes first
    // while failed_logins still holds its old value.
    await this.db.execute(
      `UPDATE accounts SET
         locked_until = IF(failed_logins + 1 >= ?, ?, locked_until),
         failed_logins = IF(failed_logins + 1 >= ?, 0, failed_logins + 1)
       WHERE id = ?`,
      [max, now + lockMs, max, id],
    );
  }

  async setPassword(id: number, h: PasswordHash): Promise<void> {
    await this.db.execute(
      'UPDATE accounts SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?',
      [h.hash, h.salt, h.iterations, id],
    );
  }

  async setGroup(id: number, fromGroupId: number, toGroupId: number): Promise<boolean> {
    const [result] = await this.db.execute<mysql.ResultSetHeader>(
      'UPDATE accounts SET group_id = ? WHERE id = ? AND group_id = ?',
      [toGroupId, id, fromGroupId],
    );
    return result.affectedRows === 1;
  }

  async createSession(s: SessionRecord, expectedPassword?: Buffer): Promise<boolean> {
    return this.locked(s.accountId, async (db, account) => {
      if (!account || (expectedPassword && !account.password_hash.equals(expectedPassword)))
        return false;
      const [old] = await db.execute<SessionRow[]>(
        'SELECT * FROM sessions WHERE account_id = ? ORDER BY created_at DESC',
        [s.accountId],
      );
      for (const row of old.slice(19))
        await db.execute('DELETE FROM sessions WHERE token_hash = ?', [row.token_hash]);
      await db.execute(
        'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [s.tokenHash, s.accountId, s.createdAt, s.expiresAt],
      );
      await db.execute(
        'INSERT INTO session_activity (token_hash, device, last_used_at) VALUES (?, ?, ?)',
        [s.tokenHash, s.device ?? '', s.lastUsedAt ?? s.createdAt],
      );
      return true;
    });
  }

  async findSession(tokenHash: Buffer): Promise<SessionRecord | null> {
    const [rows] = await this.db.execute<SessionRow[]>(
      'SELECT * FROM sessions WHERE token_hash = ?',
      [tokenHash],
    );
    const r = rows[0];
    return r
      ? {
          tokenHash: r.token_hash,
          accountId: r.account_id,
          createdAt: Number(r.created_at),
          expiresAt: Number(r.expires_at),
        }
      : null;
  }

  async deleteSession(tokenHash: Buffer): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteSessionsExcept(accountId: number, keep: Buffer | null): Promise<void> {
    if (keep)
      await this.db.execute('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?', [
        accountId,
        keep,
      ]);
    else await this.db.execute('DELETE FROM sessions WHERE account_id = ?', [accountId]);
  }

  async listSessions(id: number, now: number): Promise<SessionRecord[]> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT s.*, a.device, a.last_used_at FROM sessions s LEFT JOIN session_activity a USING (token_hash)
       WHERE s.account_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`,
      [id, now],
    );
    return rows.map((r) => ({
      tokenHash: r.token_hash as Buffer,
      accountId: Number(r.account_id),
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      device: String(r.device ?? ''),
      lastUsedAt: Number(r.last_used_at ?? r.created_at),
    }));
  }

  async touchSession(hash: Buffer, now: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO session_activity (token_hash, device, last_used_at)
      SELECT token_hash, '', ? FROM sessions WHERE token_hash = ?
      ON DUPLICATE KEY UPDATE last_used_at = IF(last_used_at < ? - 60000, ?, last_used_at)`,
      [now, hash, now, now],
    );
  }

  async cleanup(now: number): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE expires_at <= ?', [now]);
    await this.db.execute('DELETE FROM account_actions WHERE expires_at <= ?', [now]);
  }

  async getSecurity(id: number): Promise<AccountSecurity> {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT * FROM account_security WHERE account_id = ?',
      [id],
    );
    const r = rows[0];
    return {
      verifiedEmail: String(r?.verified_email ?? ''),
      recoveryHash: (r?.recovery_hash as Buffer | null) ?? null,
      mailSentAt: Number(r?.mail_sent_at ?? 0),
    };
  }

  private async locked<T>(
    id: number,
    fn: (db: PoolConnection, account: AccountRow | undefined) => Promise<T>,
  ): Promise<T> {
    const db = await this.db.getConnection();
    try {
      await db.beginTransaction();
      const [rows] = await db.execute<AccountRow[]>(
        'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
        [id],
      );
      const result = await fn(db, rows[0]);
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback().catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }

  private async replacePassword(
    db: PoolConnection,
    id: number,
    h: PasswordHash,
    keep: Buffer | null,
  ): Promise<void> {
    await db.execute(
      'UPDATE accounts SET password_hash = ?, password_salt = ?, password_iter = ?, failed_logins = 0, locked_until = 0 WHERE id = ?',
      [h.hash, h.salt, h.iterations, id],
    );
    await db.execute('UPDATE account_security SET recovery_hash = NULL WHERE account_id = ?', [id]);
    await db.execute('DELETE FROM account_actions WHERE account_id = ?', [id]);
    if (keep)
      await db.execute('DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?', [id, keep]);
    else await db.execute('DELETE FROM sessions WHERE account_id = ?', [id]);
  }

  async changePassword(
    id: number,
    expected: Buffer,
    next: PasswordHash,
    keep: Buffer | null,
  ): Promise<boolean> {
    return this.locked(id, async (db, a) => {
      if (!a?.password_hash.equals(expected)) return false;
      await this.replacePassword(db, id, next, keep);
      return true;
    });
  }

  async upgradePassword(id: number, expected: Buffer, h: PasswordHash): Promise<void> {
    await this.db.execute(
      'UPDATE accounts SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ? AND password_hash = ?',
      [h.hash, h.salt, h.iterations, id, expected],
    );
  }

  async setRecoveryCode(id: number, expected: Buffer, hash: Buffer): Promise<boolean> {
    return this.locked(id, async (db, a) => {
      if (!a?.password_hash.equals(expected)) return false;
      await db.execute(
        'INSERT INTO account_security (account_id, recovery_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE recovery_hash = VALUES(recovery_hash)',
        [id, hash],
      );
      return true;
    });
  }

  async issueAction(action: AccountAction, expectedPassword?: Buffer): Promise<boolean> {
    return this.locked(action.accountId, async (db, a) => {
      if (!a || (expectedPassword && !a.password_hash.equals(expectedPassword))) return false;
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT * FROM account_security WHERE account_id = ?',
        [a.id],
      );
      const s = rows[0];
      if (Number(s?.mail_sent_at) && action.createdAt - Number(s?.mail_sent_at) < 60_000)
        return false;
      if (action.kind === 'reset' && (!s?.verified_email || s.verified_email !== action.email))
        return false;
      await db.execute(
        'INSERT INTO account_security (account_id, mail_sent_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE mail_sent_at = VALUES(mail_sent_at)',
        [a.id, action.createdAt],
      );
      await db.execute('DELETE FROM account_actions WHERE account_id = ? AND kind = ?', [
        a.id,
        action.kind,
      ]);
      await db.execute(
        'INSERT INTO account_actions (token_hash, account_id, kind, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [action.tokenHash, a.id, action.kind, action.email, action.createdAt, action.expiresAt],
      );
      return true;
    });
  }

  async completeAction(hash: Buffer, now: number, next?: PasswordHash): Promise<boolean> {
    const [initial] = await this.db.execute<RowDataPacket[]>(
      'SELECT account_id FROM account_actions WHERE token_hash = ?',
      [hash],
    );
    if (!initial[0]) return false;
    return this.locked(Number(initial[0].account_id), async (db, a) => {
      if (!a) return false;
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT * FROM account_actions WHERE token_hash = ?',
        [hash],
      );
      const action = rows[0];
      if (!action || Number(action.expires_at) <= now || (action.kind === 'reset') !== !!next)
        return false;
      if (next) {
        const [security] = await db.execute<RowDataPacket[]>(
          'SELECT verified_email FROM account_security WHERE account_id = ?',
          [a.id],
        );
        if (security[0]?.verified_email !== action.email) return false;
        await this.replacePassword(db, a.id, next, null);
      } else {
        await db.execute('UPDATE accounts SET email = ? WHERE id = ?', [action.email, a.id]);
        await db.execute('UPDATE account_security SET verified_email = ? WHERE account_id = ?', [
          action.email,
          a.id,
        ]);
        await db.execute('DELETE FROM account_actions WHERE account_id = ?', [a.id]);
      }
      return true;
    });
  }

  async recoverWithCode(id: number, hash: Buffer, next: PasswordHash): Promise<boolean> {
    return this.locked(id, async (db, a) => {
      if (!a) return false;
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT recovery_hash FROM account_security WHERE account_id = ?',
        [id],
      );
      if (!(rows[0]?.recovery_hash as Buffer | null)?.equals(hash)) return false;
      await this.replacePassword(db, id, next, null);
      return true;
    });
  }

  async getProgress(accountId: number): Promise<ProgressSnapshot> {
    const [stats] = await this.db.execute<RowDataPacket[]>(
      'SELECT stat_id, value FROM account_stats WHERE account_id = ?',
      [accountId],
    );
    const [achievements] = await this.db.execute<RowDataPacket[]>(
      'SELECT achievement_id, unlocked_at FROM account_achievements WHERE account_id = ? ORDER BY achievement_id',
      [accountId],
    );
    const out: ProgressSnapshot = { stats: {}, achievements: [] };
    for (const row of stats) out.stats[row.stat_id as number] = Number(row.value);
    for (const row of achievements)
      out.achievements.push({
        id: row.achievement_id as number,
        unlockedAt: Number(row.unlocked_at),
      });
    return out;
  }

  async applyProgress(
    batchId: string,
    now: number,
    deltas: ProgressDelta[],
    legacyBatchId?: string,
  ): Promise<boolean> {
    const db = await this.db.getConnection();
    try {
      await db.beginTransaction();
      await db.execute('DELETE FROM progress_batches WHERE received_at < ?', [
        now - BATCH_MEMORY_MS,
      ]);
      if (legacyBatchId) {
        const [legacy] = await db.execute<RowDataPacket[]>(
          'SELECT batch_id FROM progress_batches WHERE batch_id = ?',
          [legacyBatchId],
        );
        if (legacy.length) {
          await db.rollback();
          return false;
        }
      }
      try {
        await db.execute('INSERT INTO progress_batches (batch_id, received_at) VALUES (?, ?)', [
          batchId,
          now,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
        await db.rollback();
        return false;
      }
      const ids = [...new Set(deltas.map((d) => d.accountId))];
      const known = new Set<number>();
      if (ids.length) {
        const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM accounts WHERE id IN (?)', [
          ids,
        ]);
        for (const row of rows) known.add(row.id as number);
      }
      for (const d of deltas) {
        if (!known.has(d.accountId)) continue;
        for (const [id, n] of Object.entries(d.add))
          await db.execute(
            `INSERT INTO account_stats (account_id, stat_id, value, updated_at) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE value = LEAST(value + VALUES(value), ${MAX_STAT_VALUE}), updated_at = VALUES(updated_at)`,
            [d.accountId, Number(id), n, now],
          );
        for (const [id, n] of Object.entries(d.max))
          await db.execute(
            `INSERT INTO account_stats (account_id, stat_id, value, updated_at) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE value = GREATEST(value, VALUES(value)), updated_at = VALUES(updated_at)`,
            [d.accountId, Number(id), n, now],
          );
        for (const id of d.revoke)
          await db.execute(
            'DELETE FROM account_achievements WHERE account_id = ? AND achievement_id = ?',
            [d.accountId, id],
          );
        for (const u of d.unlock)
          await db.execute(
            'INSERT IGNORE INTO account_achievements (account_id, achievement_id, unlocked_at) VALUES (?, ?, ?)',
            [d.accountId, u.id, u.at],
          );
      }
      await db.commit();
      return true;
    } catch (error) {
      await db.rollback().catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
