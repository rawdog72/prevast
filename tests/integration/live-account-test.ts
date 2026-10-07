// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Register -> ticket -> join -> see ourselves verified. Needs a smoke run with
// SMOKE_ACCOUNTS_DB_URL (see run-smoke.mjs).
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { unwrapBatch } from '../../apps/client/src/net/batch';
import { dispatchServerMessage } from '../../apps/client/src/net/dispatcher';
import { NetEventBus } from '../../apps/client/src/net/events';
import { buildChatMessage, buildLoginMessage } from '../../apps/client/src/net/outbound';
import { ProgressStore } from '../../apps/client/src/world/progress-store';
import { WorldState } from '../../apps/client/src/world/world-state';

const webUrl = process.env.SMOKE_WEB_URL!;
const gamePort = Number(process.env.SMOKE_GAME_PORT);
const adminToken = process.env.SMOKE_ACCOUNT_ADMIN_TOKEN ?? '';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ticketFor(cookie: string): Promise<string> {
  const t = await fetch(`${webUrl}/api/account/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ serverId: 'isolated-smoke', host: '127.0.0.1', port: gamePort }),
  });
  const { ticket } = (await t.json()) as { ticket: string };
  if (!ticket) throw new Error(`ticket: HTTP ${t.status}`);
  return ticket;
}

/** Joins with a ticket and hands back the socket, the bus and our own guid. */
async function join(ticket: string, progress: ProgressStore, token = '') {
  const bus = new NetEventBus();
  const world = new WorldState();
  world.attachBus(bus);
  let sessionToken = '';
  bus.on('nicknames', (ev) => {
    if (ev.sessionToken) sessionToken = ev.sessionToken;
  });
  progress.attachBus(bus);
  const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`);
  ws.on('message', (data) => {
    const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    for (const message of unwrapBatch(bytes)) dispatchServerMessage(message, bus);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      ws.send(buildLoginMessage({ nickname: 'ignored', version: 0, accountTicket: ticket, token }));
      resolve();
    });
    ws.on('error', reject);
  });
  const deadline = Date.now() + 8000;
  while (world.ownGuid < 0 || !progress.loaded) {
    if (Date.now() > deadline)
      throw new Error(
        `never loaded account progress (guid ${world.ownGuid}, enabled ${progress.enabled})`,
      );
    await wait(50);
  }
  return { ws, bus, world, sessionToken, guid: world.ownGuid };
}

/** Reconnection preserves the real C++ run; account reports exercise the wallet/clan HTTP path. */
async function communityRoundTrip(cookie: string, accountId: number): Promise<void> {
  const until = async (test: () => boolean, label: string) => {
    const deadline = Date.now() + 12000;
    while (!test()) {
      if (Date.now() > deadline) throw Error(label);
      await wait(100);
    }
  };
  const first = await join(await ticketFor(cookie), new ProgressStore());
  await until(() => !!first.world.ownRun?.ranked, 'ranked account run did not arrive');
  const runId = first.world.ownRun!.runId;
  first.ws.close();
  await wait(300);
  const again = await join(await ticketFor(cookie), new ProgressStore(), first.sessionToken);
  await until(() => !!again.world.ownRun, 'reconnected run did not arrive');
  assert.equal(again.world.ownRun!.runId, runId);
  assert.equal(again.world.ownRun!.scoreCaps, 0, 'starting kit must not earn golden caps');
  console.log('  ✓ Reconnection retains the survivor life and starting kits earn no caps');
  const headers = {
    'content-type': 'application/json',
    'x-account-progress-token': process.env.SMOKE_ACCOUNT_PROGRESS_TOKEN ?? '',
  };
  const report = async (score: number, key: string) => {
    const at = Date.now();
    const body = {
      runId: 'smoke:' + accountId + ':' + key,
      bootId: 'smoke-http',
      accountId,
      revision: 1,
      startedAt: at - 60000,
      at,
      mode: 'survival',
      rulesVersion: 1,
      score,
      earnedScore: score,
      kills: 1,
      survivedSeconds: 60,
      end: 'death',
      eligible: true,
      events: [{ seq: 1, at, score, kills: 1 }],
      awards: [],
    };
    const send = () =>
      fetch(webUrl + '/api/servers/community/report', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
  };
  const profile = async () =>
    await (await fetch(webUrl + '/api/account/community', { headers: { cookie } })).json();
  await report(99000, 'wallet');
  assert.equal((await profile()).wallet, 9);
  const create = {
    action: 'create',
    name: 'Smoke clan ' + accountId,
    tag: 'S' + String(accountId).slice(-4),
    requestId: crypto.randomUUID(),
  };
  const command = () =>
    fetch(webUrl + '/api/account/clan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(create),
    });
  assert.equal((await command()).status, 200);
  assert.equal((await command()).status, 200);
  assert.equal((await profile()).wallet, 4);
  await report(20000, 'clan');
  const p = await profile();
  assert.equal(p.wallet, 6);
  assert.equal(p.clan.score, 20000);
  assert.equal(p.clan.average, 20000);
  again.ws.close();
  await wait(300);
  const withClan = await join(await ticketFor(cookie), new ProgressStore(), again.sessionToken);
  await until(
    () => !!withClan.world.players.get(withClan.guid)?.accountClan,
    'account clan shield did not arrive',
  );
  assert.equal(withClan.world.players.get(withClan.guid)!.accountClan!.id, p.clan.id);
  assert.equal(
    withClan.world.players.get(withClan.guid)!.team,
    -1,
    'account clan must not join a temporary team',
  );
  withClan.ws.close();
  console.log(
    '  ✓ Durable score rewards, idempotent clan creation, contributor averages and C++ clan identity',
  );
}

/** Account stats and achievements: game server -> web host -> MariaDB and back. */
async function progressRoundTrip(cookie: string, accountId: number): Promise<void> {
  const admin = { 'x-account-admin-token': adminToken, 'content-type': 'application/json' };
  const group = await fetch(`${webUrl}/api/servers/accounts/group`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ ref: `#${accountId}`, fromGroupId: 1, toGroupId: 4 }),
  });
  if (group.status !== 200) throw new Error(`promote: HTTP ${group.status} ${await group.text()}`);

  const progress = new ProgressStore();
  const { ws, guid } = await join(await ticketFor(cookie), progress);
  if (!progress.enabled) throw new Error('the server does not record account progress');
  console.log('  ✓ Account progress loaded on join');
  ws.send(buildChatMessage(`!achievement=grant:${guid}:ghoul_hunter`));
  const deadline = Date.now() + 5000;
  while (!progress.unlocked.has(1)) {
    if (Date.now() > deadline) throw new Error('ACHIEVEMENT_UNLOCKED never arrived');
    await wait(50);
  }
  console.log('  ✓ Achievement unlocked in game');
  // Leaving stores what the character did on the next tick.
  ws.close();
  const stored = Date.now() + 15000;
  for (;;) {
    const r = await fetch(`${webUrl}/api/servers/progress/${accountId}`, {
      headers: { 'x-account-progress-token': process.env.SMOKE_ACCOUNT_PROGRESS_TOKEN ?? '' },
    });
    const body = (await r.json()) as { achievements: { id: number }[] };
    if (body.achievements?.some((a) => a.id === 1)) break;
    if (Date.now() > stored) throw new Error(`achievement never stored: ${JSON.stringify(body)}`);
    await wait(250);
  }
  console.log('  ✓ Achievement stored on the web host');

  const again = new ProgressStore();
  const second = await join(await ticketFor(cookie), again);
  second.ws.close();
  if (!again.unlocked.has(1)) throw new Error('a reconnect lost the achievement');
  console.log('  ✓ A reconnect still has it');
}
const name = `Smoke${Date.now() % 100000}`;

/** Recovery and browser revocation against the real HTTP host and MariaDB. */
async function accountControls(cookie: string): Promise<void> {
  const post = async (route: string, body: unknown, session = cookie) => {
    // Stay within the production write budget while testing several flows.
    await wait(550);
    return fetch(`${webUrl}/api/account/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session },
      body: JSON.stringify(body),
    });
  };
  const get = (route: string, session = cookie) =>
    fetch(`${webUrl}/api/account/${route}`, { headers: { cookie: session } });
  assert.equal((await get('progress', '')).status, 401);
  const profile = await (await get('progress')).json();
  assert(
    profile.achievements.some(
      (a: { id: number; unlockedAt: number | null }) => a.id === 1 && a.unlockedAt !== null,
    ),
  );
  const login = await post('login', { name, password: 'smoke-password', remember: false }, '');
  assert.equal(login.status, 200);
  assert(!login.headers.get('set-cookie')?.includes('Max-Age'));
  const other = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const sessions = (await (await get('sessions')).json()).sessions as {
    id: string;
    current: boolean;
  }[];
  assert.equal(sessions.length, 2);
  assert.equal(
    (await post('sessions/revoke', { id: sessions.find((s) => !s.current)!.id })).status,
    200,
  );
  assert.equal((await get('security', other)).status, 401);
  const recovery = await post('recovery-code', { current: 'smoke-password' });
  assert.equal(recovery.status, 200);
  const { code } = await recovery.json();
  assert.equal(
    (await post('recovery/reset', { name, code, next: 'new-smoke-password' }, '')).status,
    200,
  );
  assert.equal((await get('security')).status, 401);
  assert.equal(
    (await post('recovery/reset', { name, code, next: 'another-password' }, '')).status,
    400,
  );
  const next = await post('login', { name, password: 'new-smoke-password' }, '');
  assert.equal(next.status, 200);
  const restored = (next.headers.get('set-cookie') ?? '').split(';')[0]!;
  const after = await (await get('progress', restored)).json();
  assert.deepEqual(after, profile);
  assert.equal((await post('logout', {}, restored)).status, 200);
  console.log(
    '  ✓ Private profile, device revocation and one-use recovery preserve account progress',
  );
}

async function main(): Promise<void> {
  const reg = await fetch(`${webUrl}/api/account/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: 'smoke-password' }),
  });
  if (reg.status !== 200) throw new Error(`register: HTTP ${reg.status} ${await reg.text()}`);
  const { account } = (await reg.clone().json()) as { account: { id: number } };
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const t = await fetch(`${webUrl}/api/account/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ serverId: 'isolated-smoke', host: '127.0.0.1', port: gamePort }),
  });
  const { ticket } = (await t.json()) as { ticket: string };
  if (!ticket) throw new Error(`ticket: HTTP ${t.status}`);
  // The ticket names the server by listing id AND the address it registered.
  const serverId = Buffer.from(ticket.split('.')[0]!, 'base64url').toString('utf8').split('|')[4];
  if (serverId !== `isolated-smoke@127.0.0.1:${gamePort}`)
    throw new Error(`ticket is for ${serverId}`);
  console.log(`  ✓ Registered ${name} and got a ticket for ${serverId}`);

  await new Promise<void>((resolve, reject) => {
    const bus = new NetEventBus();
    const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('never saw our verified PLAYER_INFO'));
    }, 8000);
    bus.on('playerInfo', (ev) => {
      if (ev.name === name && ev.verified) {
        clearTimeout(timer);
        ws.close();
        console.log(`  ✓ Joined as ${ev.name}, verified, group ${ev.groupId}`);
        resolve();
      }
    });
    ws.on('open', () =>
      ws.send(buildLoginMessage({ nickname: 'ignored', version: 0, accountTicket: ticket })),
    );
    ws.on('message', (data) => {
      const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      for (const message of unwrapBatch(bytes)) dispatchServerMessage(message, bus);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

  if (adminToken) {
    await communityRoundTrip(cookie, account.id);
    await progressRoundTrip(cookie, account.id);
    await accountControls(cookie);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
