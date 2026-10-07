// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// apps/web/src/accounts/mysql-store.test.ts
// Runs the shared store contract against a real MariaDB when one is offered:
//   ACCOUNTS_TEST_DB_URL=mysql://root@127.0.0.1:3306/prevast_accounts_test npx vitest run apps/web/src/accounts/mysql-store.test.ts
// The database is dropped and recreated per test. Skipped otherwise.
import mysql from 'mysql2/promise';
import { describe, it } from 'vitest';
import { MysqlAccountStore } from './mysql-store';
import { describeAccountStore } from './store-contract';

const url = process.env.ACCOUNTS_TEST_DB_URL;

if (url) {
  describeAccountStore('mysql', async () => {
    const parsed = new URL(url);
    const database = parsed.pathname.slice(1);
    if (!/^prevast_[a-z0-9_]*test(?:_\d+)?$/.test(database))
      throw new Error('Refusing to reset a database without an isolated prevast_*test name.');
    parsed.pathname = '/';
    const admin = await mysql.createConnection(parsed.toString());
    await admin.query('DROP DATABASE IF EXISTS ??', [database]);
    await admin.end();
    const store = new MysqlAccountStore(url);
    await store.init();
    return store;
  });
} else {
  describe.skip('mysql account store (set ACCOUNTS_TEST_DB_URL)', () => {
    it('is skipped', () => {});
  });
}
