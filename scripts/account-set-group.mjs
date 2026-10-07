// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// scripts/account-set-group.mjs
// Sets an account's group directly in the accounts database. For the first
// admin, before anyone can use !setgroup:
//   npm run account:set-group -- <name> <groupId>
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const [name, group] = process.argv.slice(2);
const groupId = Number(group);
if (!name || !Number.isInteger(groupId) || groupId < 1 || groupId > 255) {
  console.error('Usage: npm run account:set-group -- <name> <groupId 1-255>');
  process.exit(2);
}
const file = resolve(fileURLToPath(new URL('../', import.meta.url)), 'runtime/development/.accounts-db');
const url = process.env.ACCOUNTS_DB_URL || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
if (!url) {
  console.error('No accounts database: set ACCOUNTS_DB_URL or runtime/development/.accounts-db');
  process.exit(2);
}
const db = await mysql.createConnection(url);
const [result] = await db.execute('UPDATE accounts SET group_id = ? WHERE name_key = ?', [groupId, name.toLowerCase()]);
await db.end();
if (result.affectedRows !== 1) {
  console.error(`No account named ${name}.`);
  process.exit(1);
}
console.log(`${name} is now in group ${groupId}. It applies on their next login.`);
