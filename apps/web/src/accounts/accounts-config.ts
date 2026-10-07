// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Account settings, same pattern as .listing-token: an environment variable
// wins over a file in the runtime directory. A variable that is SET but empty
// counts as "off", so an isolated run (npm run smoke) can switch accounts off
// without touching the developer's files.
import fs from 'node:fs';
import path from 'node:path';

export interface AccountsConfig {
  dbUrl: string;
  signingKeyPem: string;
  adminToken: string;
  progressTokens: Record<string, string>;
}

function secret(dir: string, file: string, envValue: string | undefined): string {
  if (envValue !== undefined) return envValue.trim();
  const full = path.join(dir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').trim() : '';
}

export function loadAccountsConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountsConfig | null {
  const dbUrl = secret(dir, '.accounts-db', env.ACCOUNTS_DB_URL);
  if (!dbUrl) return null;
  const signingKeyPem = secret(dir, '.account-signing-key', env.ACCOUNT_SIGNING_KEY);
  if (!signingKeyPem) {
    throw new Error(
      'Accounts are enabled (.accounts-db / ACCOUNTS_DB_URL) but there is no signing key: run npm run setup.',
    );
  }
  const adminToken = secret(dir, '.account-admin-token', env.ACCOUNT_ADMIN_TOKEN);
  if (adminToken && adminToken.length < 32)
    throw new Error('ACCOUNT_ADMIN_TOKEN must be 32+ characters.');
  const rawProgress = secret(dir, '.account-progress-tokens', env.ACCOUNT_PROGRESS_TOKENS);
  const progressTokens: Record<string, string> = rawProgress
    ? (JSON.parse(rawProgress) as Record<string, string>)
    : {};
  if (!progressTokens || typeof progressTokens !== 'object' || Array.isArray(progressTokens))
    throw new Error('ACCOUNT_PROGRESS_TOKENS must map server ids to tokens.');
  const seen = new Set<string>();
  for (const [id, token] of Object.entries(progressTokens)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
      typeof token !== 'string' ||
      token.length < 32 ||
      token === adminToken ||
      seen.has(token)
    )
      throw new Error(
        'Progress servers need unique 32+ character tokens distinct from the admin token.',
      );
    seen.add(token);
  }
  return { dbUrl, signingKeyPem, adminToken, progressTokens };
}
