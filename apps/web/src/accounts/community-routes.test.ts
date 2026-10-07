// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from './account-service';
import { createAccountRouter } from './account-routes';
import { MemoryAccountStore } from './memory-store';
import { TicketSigner } from './tickets';
import type { AccountCommunity } from './community';

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);
async function start() {
  const report = vi.fn(async () => ({ applied: true })),
    command = vi.fn(async () => ({ clanId: 1 }));
  const community = {
    report,
    command,
    profile: async () => ({ wallet: 9 }),
    rankings: async () => ({ players: [], clans: [] }),
  } as unknown as AccountCommunity;
  const service = new AccountService(
    new MemoryAccountStore(),
    TicketSigner.fromPem(TicketSigner.generatePem()),
    { serverAddress: () => null, passwordIterations: 1000, community },
  );
  const app = express();
  app.use(
    createAccountRouter({
      service: () => service,
      validAdminToken: (t) => t === 'admin',
      progressServer: (t) => (t === 'progress' ? 'ranked' : null),
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server!.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { base, post, report, command };
}
describe('community authorization', () => {
  it('keeps server rewards separate from browser and admin credentials', async () => {
    const { post, report } = await start();
    expect(
      (await post('/api/servers/community/report', {}, { 'x-account-admin-token': 'admin' }))
        .status,
    ).toBe(403);
    expect(
      (await post('/api/servers/community/report', {}, { 'x-account-progress-token': 'progress' }))
        .status,
    ).toBe(200);
    expect(report).toHaveBeenCalledExactlyOnceWith('ranked', {});
  });
  it('requires an authenticated same-origin account for clan mutations', async () => {
    const { post, base, command } = await start();
    expect((await post('/api/account/clan', {})).status).toBe(401);
    const registered = await post('/api/account/register', {
      name: 'Alice',
      password: 'test-password',
    });
    const cookie = registered.headers.get('set-cookie')!.split(';')[0]!;
    expect(
      (await post('/api/account/clan', {}, { cookie, origin: 'https://elsewhere.example' })).status,
    ).toBe(403);
    expect(
      (await post('/api/account/clan', { action: 'leave' }, { cookie, origin: base })).status,
    ).toBe(200);
    expect(command).toHaveBeenCalledExactlyOnceWith(1, { action: 'leave' });
  });
  it('rejects invalid public identities and page values', async () => {
    const { base } = await start();
    expect((await fetch(base + '/api/community/clans/NaN')).status).toBe(400);
    expect((await fetch(base + '/api/community/players/-1')).status).toBe(400);
    expect((await fetch(base + '/api/community/rankings?offset=-1')).status).toBe(400);
  });
});
