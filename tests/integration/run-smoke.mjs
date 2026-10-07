// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Starts fresh local instances and leaves their logs under runtime/smoke/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = resolve(root, 'dist/server/Release/prevast_server.exe');
assert(existsSync(binary), 'Run npm run server:build first');
assert(existsSync(resolve(root, 'dist/web/index.js')), 'Run npm run build first');
const run = resolve(root, 'runtime/smoke', new Date().toISOString().replaceAll(/[:.]/g, '-'));
mkdirSync(run, { recursive: true });
cpSync(resolve(root, 'data'), join(run, 'data'), { recursive: true });
const ports = [];
while (ports.length < 4) {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  if (!ports.includes(port)) ports.push(port);
}
const [webPort, gamePort, statusPort, httpPort] = ports;
const token = randomBytes(32).toString('hex');
let config = readFileSync(resolve(root, 'config/development.lua'), 'utf8');
const settings = {
  contentPath: 'data/XML',
  storagePath: 'storage',
  ip: '127.0.0.1',
  gameProtocolPort: gamePort,
  statusProtocolPort: statusPort,
  httpPort,
  publicHost: '127.0.0.1',
  publicPort: 0,
  listingId: 'isolated-smoke',
  listingUrl: `http://127.0.0.1:${webPort}/api/servers/heartbeat`,
  listingToken: token,
  listingIntervalSeconds: 1,
  useDatabase: false,
  adminPassword: randomBytes(16).toString('hex'),
};
// Accounts stay off (ACCOUNTS_DB_URL='' also hides a developer's .accounts-db)
// unless SMOKE_ACCOUNTS_DB_URL names a MariaDB accounts database, e.g.
// mysql://root@127.0.0.1:3306/prevast_smoke_accounts; the game server then uses
// prevast_smoke_game on the same host.
const accountsDbUrl = process.env.SMOKE_ACCOUNTS_DB_URL ?? '';
const webEnv = {
  PORT: String(webPort),
  LISTING_TOKEN: token,
  ACCOUNTS_DB_URL: '',
  LISTING_SNAPSHOT_PATH: join(run, 'server-registry.json'),
};
if (accountsDbUrl) {
  // Same key format as scripts/setup.mjs: PKCS#8 PEM for the web host, base64
  // of the raw 65-byte P-256 point for the game server.
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64');
  const adminToken = randomBytes(32).toString('hex');
  const progressToken = randomBytes(32).toString('hex');
  const url = new URL(accountsDbUrl);
  url.pathname = '/';
  const mysql = await import('mysql2/promise');
  const db = await mysql.createConnection(url.toString());
  try {
    await db.query('CREATE DATABASE IF NOT EXISTS prevast_smoke_game');
  } finally {
    await db.end();
  }
  Object.assign(settings, {
    useDatabase: true,
    mysqlHost: url.hostname,
    mysqlPort: Number(url.port || 3306),
    mysqlUser: decodeURIComponent(url.username),
    mysqlPass: decodeURIComponent(url.password),
    mysqlDatabase: 'prevast_smoke_game',
    accountPublicKey: publicKey,
    accountAdminToken: adminToken,
    accountProgressToken: progressToken,
    accountServiceUrl: `http://127.0.0.1:${webPort}`,
  });
  Object.assign(webEnv, {
    ACCOUNTS_DB_URL: accountsDbUrl,
    ACCOUNT_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ACCOUNT_ADMIN_TOKEN: adminToken,
    ACCOUNT_PROGRESS_TOKENS: JSON.stringify({ 'isolated-smoke': progressToken }),
    ACCOUNT_RANKED_SERVERS: 'isolated-smoke',
    ACCOUNT_SMTP_HOST: '',
  });
}
for (const [key, value] of Object.entries(settings)) {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, 'm');
  config = pattern.test(config) ? config.replace(pattern, line) : config + '\n' + line + '\n';
}
writeFileSync(join(run, 'config.lua'), config);
const children = [];
function launch(name, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.failure = null;
  child.on('error', (error) => {
    child.failure = error;
  });
  const log = join(run, `${name}.log`);
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => appendFileSync(log, chunk));
  children.push(child);
  return child;
}
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function stop() {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null || child.failure) continue;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
try {
  const web = launch('web', process.execPath, [resolve(root, 'dist/web/index.js')], root, webEnv);
  const game = launch('server', binary, [], run, {
    PREVAST_ACCOUNT_ADMIN_TOKEN: settings.accountAdminToken ?? '',
    PREVAST_ACCOUNT_PROGRESS_TOKEN: settings.accountProgressToken ?? '',
  });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    for (const child of [web, game])
      assert(!child.failure && child.exitCode === null, `Process failed; see ${run}`);
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/api/servers/list`, {
        signal: AbortSignal.timeout(1000),
      });
      const list = await response.json();
      if (list.some((s) => s.id === 'isolated-smoke')) {
        ready = true;
        break;
      }
    } catch {
      /* Services are still starting. */
    }
    await wait(250);
  }
  assert(ready, `Startup timed out; see ${run}`);
  const testEnv = {
    SMOKE_WEB_URL: `http://127.0.0.1:${webPort}`,
    SMOKE_GAME_PORT: String(gamePort),
    SMOKE_STATUS_PORT: String(statusPort),
    SMOKE_ACCOUNT_ADMIN_TOKEN: settings.accountAdminToken ?? '',
    SMOKE_ACCOUNT_PROGRESS_TOKEN: settings.accountProgressToken ?? '',
    SMOKE_ADMIN_PASSWORD: settings.adminPassword,
  };
  async function runTest(name, file) {
    const test = launch(
      name,
      process.execPath,
      [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, file)],
      root,
      testEnv,
    );
    const [code] = await once(test, 'exit');
    const log = join(run, `${name}.log`);
    if (existsSync(log)) process.stdout.write(readFileSync(log, 'utf8'));
    assert.equal(code, 0, `${file} failed; see ${run}`);
  }
  await runTest('smoke', 'tests/integration/live-smoke-test.ts');
  if (!accountsDbUrl) await runTest('fuel', 'tests/integration/live-fuel-test.ts');
  if (!accountsDbUrl) await runTest('weapon-mods', 'tests/integration/live-weapon-mods-test.ts');
  if (!accountsDbUrl) await runTest('aim', 'tests/integration/live-aim-test.ts');
  if (accountsDbUrl) await runTest('account', 'tests/integration/live-account-test.ts');
  console.log(`Isolated integration passed. Logs: ${run}`);
} finally {
  await stop();
}
