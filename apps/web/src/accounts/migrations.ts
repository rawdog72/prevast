// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { Pool, RowDataPacket } from 'mysql2/promise';
import { COMMUNITY_SCHEMA } from './community-schema';

// Additive migrations preserve legacy accounts and sessions. Existing email
// addresses deliberately remain unverified. DDL is restartable (MySQL commits
// DDL implicitly), and a database lock serializes concurrent web-host boots.
const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS account_security (
    account_id INT UNSIGNED NOT NULL PRIMARY KEY,
    verified_email VARCHAR(255) NOT NULL DEFAULT '',
    recovery_hash BINARY(32) NULL,
    mail_sent_at BIGINT NOT NULL DEFAULT 0,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS account_actions (
    token_hash BINARY(32) NOT NULL PRIMARY KEY,
    account_id INT UNSIGNED NOT NULL,
    kind VARCHAR(8) NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    UNIQUE KEY account_action_kind (account_id, kind),
    KEY account_action_expiry (expires_at),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS session_activity (
    token_hash BINARY(32) NOT NULL PRIMARY KEY,
    device VARCHAR(160) NOT NULL DEFAULT '',
    last_used_at BIGINT NOT NULL,
    FOREIGN KEY (token_hash) REFERENCES sessions(token_hash) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  { version: 2, statements: COMMUNITY_SCHEMA },
];

export async function migrateAccounts(pool: Pool): Promise<void> {
  const db = await pool.getConnection();
  let locked = false;
  try {
    const [rows] = await db.query<RowDataPacket[]>(
      "SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':account-migrations'), 256), 10) AS acquired",
    );
    if (Number(rows[0]?.acquired) !== 1)
      throw new Error('Account schema migration is busy; retry startup.');
    locked = true;
    await db.query(
      'CREATE TABLE IF NOT EXISTS account_schema_versions (version INT NOT NULL PRIMARY KEY) ENGINE=InnoDB',
    );
    for (const migration of migrations) {
      const [done] = await db.execute<RowDataPacket[]>(
        'SELECT version FROM account_schema_versions WHERE version = ?',
        [migration.version],
      );
      if (done.length) continue;
      for (const sql of migration.statements) await db.query(sql);
      await db.execute('INSERT INTO account_schema_versions (version) VALUES (?)', [
        migration.version,
      ]);
    }
  } finally {
    if (locked)
      await db
        .query("SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':account-migrations'), 256))")
        .catch(() => {});
    db.release();
  }
}
