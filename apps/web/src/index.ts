// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import path from 'node:path';
import fs from 'node:fs';
import { progressionRulesSchema } from '../../../shared/typescript/account-community';
import { fileURLToPath } from 'node:url';
import { AccountService } from './accounts/account-service';
import { loadAccountsConfig } from './accounts/accounts-config';
import { MysqlAccountStore } from './accounts/mysql-store';
import { TicketSigner } from './accounts/tickets';
import { createAccountMail, loadMailConfig } from './accounts/mail';
import { createApp } from './app';
import { loadListingToken, tokenValidator } from './listing-token';
import { Registry } from './registry';
import { RegistrySnapshotStore } from './registry-store';

// dist/web/index.js -> repository root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtime = path.join(root, 'runtime/development');
const port = Number(process.env.PORT ?? 3100);
const DB_RETRY_MS = 30_000;

async function main(): Promise<void> {
  const listingToken = loadListingToken(runtime);
  const validToken = tokenValidator(listingToken);
  const registry = new Registry(validToken);
  const snapshotPath =
    process.env.LISTING_SNAPSHOT_PATH || path.join(runtime, `.server-registry-${port}.json`);
  const snapshots = new RegistrySnapshotStore(
    registry,
    snapshotPath,
    listingToken,
    `web-port:${port}`,
  );
  await snapshots.load();
  snapshots.start();

  let accounts: AccountService | null = null;
  let validAccountAdminToken: (token: unknown) => boolean = () => false;
  let accountProgressServer: (token: unknown) => string | null = () => null;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const accountsConfig = loadAccountsConfig(runtime);
  if (accountsConfig) {
    // A bad key is a configuration error and stops the boot; an unreachable
    // database is not -- guests and the server list work without it.
    const signer = TicketSigner.fromPem(accountsConfig.signingKeyPem);
    const store = new MysqlAccountStore(accountsConfig.dbUrl);
    const progressionRules = progressionRulesSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'data/account-progression.json'), 'utf8')));
    const rankedServers = new Set((process.env.ACCOUNT_RANKED_SERVERS ?? '').split(',').map(s => s.trim()).filter(Boolean));
    for (const id of rankedServers) if (!accountsConfig.progressTokens[id]) throw new Error('Ranked servers require their own progress credential.');
    const mailConfig = loadMailConfig(runtime);
    const mail = mailConfig ? createAccountMail(mailConfig) : undefined;
    const enable = async (): Promise<void> => {
      try {
        await store.init();
      } catch (error) {
        console.error(
          `Accounts database unavailable; accounts stay off, retrying in ${DB_RETRY_MS / 1000} s:`,
          error,
        );
        setTimeout(() => void enable(), DB_RETRY_MS);
        return;
      }
      accounts = new AccountService(store, signer, {
        serverAddress: (id) => registry.address(id),
        community: store.community(progressionRules, rankedServers),
        mail,
      });
      const cleanup = () =>
        void accounts?.cleanup().catch(() => console.warn('[accounts] Session cleanup failed.'));
      const settle = () => void accounts?.community?.settleSeasons().catch(() => console.warn('[accounts] Season settlement failed.'));
      settle();
      const seasonTimer = setInterval(settle, 60 * 60_000);
      seasonTimer.unref();
      cleanup();
      cleanupTimer = setInterval(cleanup, 60 * 60_000);
      cleanupTimer.unref();
      console.log('Accounts enabled.');
    };
    await enable();
    if (accountsConfig.adminToken)
      validAccountAdminToken = tokenValidator(accountsConfig.adminToken);
    const progressKeys = Object.entries(accountsConfig.progressTokens).map(([id, key]) => ({
      id,
      valid: tokenValidator(key),
    }));
    accountProgressServer = (token) => progressKeys.find((entry) => entry.valid(token))?.id ?? null;
  } else {
    console.log('Accounts disabled (no .accounts-db / ACCOUNTS_DB_URL).');
  }

  const app = createApp({
    root,
    validToken,
    registry,
    accounts: () => accounts,
    validAccountAdminToken,
    accountProgressServer,
  });
  const server = app.listen(port, () => {
    console.log(`prevast-open-server listening on http://localhost:${port}`);
  });
  server.on('close', () => {
    clearInterval(cleanupTimer);
    void snapshots.close();
  });
  // Bound incomplete HTTP requests and idle keep-alive connections.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 1024;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
