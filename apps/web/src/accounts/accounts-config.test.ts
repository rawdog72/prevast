// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAccountsConfig } from './accounts-config';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'accounts-'));

describe('loadAccountsConfig', () => {
  it('is disabled without a database url, and an empty env value disables a file', () => {
    expect(loadAccountsConfig(dir(), {})).toBeNull();
    const d = dir();
    writeFileSync(path.join(d, '.accounts-db'), 'mysql://root@127.0.0.1/x\n');
    expect(loadAccountsConfig(d, { ACCOUNTS_DB_URL: '' })).toBeNull();
  });

  it('reads files, env wins, and requires a signing key', () => {
    const d = dir();
    writeFileSync(path.join(d, '.accounts-db'), 'mysql://root@127.0.0.1/x\n');
    expect(() => loadAccountsConfig(d, {})).toThrow(/signing key/);
    writeFileSync(path.join(d, '.account-signing-key'), 'PEM\n');
    expect(loadAccountsConfig(d, {})).toEqual({
      dbUrl: 'mysql://root@127.0.0.1/x',
      signingKeyPem: 'PEM',
      adminToken: '',
      progressTokens: {},
    });
    expect(loadAccountsConfig(d, { ACCOUNTS_DB_URL: 'mysql://other/y' })!.dbUrl).toBe(
      'mysql://other/y',
    );
  });

  it('rejects a short admin token', () => {
    const d = dir();
    writeFileSync(path.join(d, '.accounts-db'), 'mysql://x/y');
    writeFileSync(path.join(d, '.account-signing-key'), 'PEM');
    expect(() => loadAccountsConfig(d, { ACCOUNT_ADMIN_TOKEN: 'short' })).toThrow(/32/);
  });

  it('requires independent progress credentials for each server and separates them from administration', () => {
    const d = dir();
    const env = {
      ACCOUNTS_DB_URL: 'mysql://x/y',
      ACCOUNT_SIGNING_KEY: 'PEM',
      ACCOUNT_ADMIN_TOKEN: 'a'.repeat(40),
    };
    const tokens = { development: 'b'.repeat(40), benchmark: 'c'.repeat(40) };
    writeFileSync(path.join(d, '.account-progress-tokens'), JSON.stringify(tokens));
    expect(loadAccountsConfig(d, env)?.progressTokens).toEqual(tokens);
    expect(loadAccountsConfig(d, { ...env, ACCOUNT_PROGRESS_TOKENS: '' })?.progressTokens).toEqual(
      {},
    );
    for (const bad of [
      { a: env.ACCOUNT_ADMIN_TOKEN },
      { a: tokens.development, b: tokens.development },
      { a: 'short' },
      [],
    ])
      expect(() =>
        loadAccountsConfig(d, { ...env, ACCOUNT_PROGRESS_TOKENS: JSON.stringify(bad) }),
      ).toThrow();
  });
});
