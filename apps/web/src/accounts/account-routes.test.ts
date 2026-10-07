// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from './account-service';
import { createAccountRouter, SESSION_COOKIE } from './account-routes';
import { MemoryAccountStore } from './memory-store';
import { readTicket, TicketSigner } from './tickets';

const ADMIN = 'a'.repeat(40);
const PROGRESS = 'p'.repeat(40);
let server: Server | null = null;

function makeService(): AccountService {
  return new AccountService(
    new MemoryAccountStore(),
    TicketSigner.fromPem(TicketSigner.generatePem()),
    {
      serverAddress: (id) => (id === 'srv' ? '[2001:db8::1]:7172' : null),
      passwordIterations: 1000,
    },
  );
}

async function start(service: AccountService | null | undefined = makeService()): Promise<string> {
  const app = express();
  app.use(
    createAccountRouter({
      service: () => service ?? null,
      validAdminToken: (t) => t === ADMIN,
      progressServer: (t) => (t === PROGRESS ? 'server-a' : null),
    }),
  );
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const post = (
  base: string,
  path: string,
  body: unknown,
  cookie = '',
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('account routes', () => {
  it('reports disabled accounts', async () => {
    const base = await start(null);
    expect(await (await fetch(`${base}/api/account/me`)).json()).toEqual({ enabled: false });
    expect((await post(base, '/api/account/login', {})).status).toBe(503);
    expect((await fetch(`${base}/api/account/public-key`)).status).toBe(503);
  });

  it('picks up a service enabled after startup', async () => {
    let service: AccountService | null = null;
    const app = express();
    app.use(createAccountRouter({ service: () => service, validAdminToken: () => false }));
    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    expect(await (await fetch(`${base}/api/account/me`)).json()).toEqual({ enabled: false });
    expect(
      (await post(base, '/api/account/register', { name: 'Late', password: 'password1' })).status,
    ).toBe(503);
    service = makeService();
    expect(await (await fetch(`${base}/api/account/me`)).json()).toEqual({ enabled: true });
    expect(
      (await post(base, '/api/account/register', { name: 'Late', password: 'password1' })).status,
    ).toBe(200);
  });

  it('treats a malformed session cookie as no session', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/account/me`, {
      headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it('answers body-parser errors with their own status as JSON', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await start();
    const send = (body: string) =>
      fetch(`${base}/api/account/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    const broken = await send('{"name":');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: expect.any(String) });
    const huge = await send(JSON.stringify({ name: 'x'.repeat(5000) }));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('answers the public key when accounts are enabled', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/account/public-key`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: expect.any(String) });
  });

  it('registers with a hardened cookie, answers me, issues tickets, logs out', async () => {
    const base = await start();
    const reg = await post(base, '/api/account/register', { name: 'Alice', password: 'password1' });
    expect(reg.status).toBe(200);
    const setCookie = reg.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/api/);
    const cookie = cookieOf(reg);
    const me = await (await fetch(`${base}/api/account/me`, { headers: { cookie } })).json();
    expect(me).toMatchObject({ enabled: true, account: { name: 'Alice', groupId: 1 } });
    const srv = { serverId: 'srv', host: '[2001:db8::1]', port: 7172 };
    const ticket = await post(base, '/api/account/ticket', srv, cookie);
    const { ticket: signed } = (await ticket.json()) as { ticket: string };
    const publicKey = (
      (await (await fetch(`${base}/api/account/public-key`)).json()) as { publicKey: string }
    ).publicKey;
    expect(readTicket(signed, publicKey)).toMatchObject({
      name: 'Alice',
      serverId: 'srv@[2001:db8::1]:7172',
    });
    expect(
      (await post(base, '/api/account/ticket', { ...srv, serverId: 'unknown' }, cookie)).status,
    ).toBe(404);
    const moved = await post(base, '/api/account/ticket', { ...srv, host: '203.0.113.9' }, cookie);
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({
      error: 'The server list changed; refresh and try again.',
    });
    expect((await post(base, '/api/account/ticket', { serverId: 'srv' }, cookie)).status).toBe(400);
    expect((await post(base, '/api/account/logout', {}, cookie)).headers.get('set-cookie')).toMatch(
      /Max-Age=0/,
    );
    expect(await (await fetch(`${base}/api/account/me`, { headers: { cookie } })).json()).toEqual({
      enabled: true,
    });
  });

  it('marks the session cookie Secure in production', async () => {
    const base = await start();
    const dev = await post(base, '/api/account/register', { name: 'Dora', password: 'password1' });
    expect(dev.headers.get('set-cookie')).not.toMatch(/Secure/);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const prod = await post(base, '/api/account/register', {
        name: 'Erik',
        password: 'password1',
      });
      expect(prod.headers.get('set-cookie')).toMatch(/; Secure/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses non-JSON posts', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/account/login`, { method: 'POST', body: 'name=a' });
    expect(res.status).toBe(415);
  });

  it('rejects foreign origins and keeps temporary sign-ins out of persistent cookies', async () => {
    const base = await start();
    const body = { name: 'Origin', password: 'password1', remember: false };
    expect(
      (await post(base, '/api/account/register', body, '', { origin: 'https://other.example' }))
        .status,
    ).toBe(403);
    const response = await post(base, '/api/account/register', body, '', { origin: base });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).not.toMatch(/Max-Age|Expires/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookie = cookieOf(response);
    for (const route of ['security', 'sessions', 'progress']) {
      const anonymous = await fetch(`${base}/api/account/${route}`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('cache-control')).toBe('no-store');
    }
    const sessions = await (
      await fetch(`${base}/api/account/sessions`, { headers: { cookie } })
    ).json();
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].current).toBe(true);
    const revoked = await post(base, '/api/account/sessions/revoke', { id: 'all' }, cookie);
    expect(revoked.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${base}/api/account/security`, { headers: { cookie } })).status).toBe(401);
  });

  it('guards the server-facing group routes with the admin token', async () => {
    const base = await start();
    await post(base, '/api/account/register', { name: 'Bob', password: 'password1' });
    expect((await fetch(`${base}/api/servers/accounts/Bob`)).status).toBe(403);
    const h = { 'x-account-admin-token': ADMIN };
    expect(
      await (await fetch(`${base}/api/servers/accounts/Bob`, { headers: h })).json(),
    ).toMatchObject({ name: 'Bob', groupId: 1 });
    expect((await fetch(`${base}/api/servers/accounts/Nobody`, { headers: h })).status).toBe(404);
    const changed = await post(
      base,
      '/api/servers/accounts/group',
      { ref: '#1', fromGroupId: 1, toGroupId: 3 },
      '',
      h,
    );
    expect(await changed.json()).toMatchObject({ account: { groupId: 3 } });
    expect(
      (
        await post(
          base,
          '/api/servers/accounts/group',
          { ref: '#1', fromGroupId: 1, toGroupId: 3 },
          '',
          h,
        )
      ).status,
    ).toBe(409);
  });

  it('changes password with the correct current password, refuses a wrong one', async () => {
    const base = await start();
    const reg = await post(base, '/api/account/register', { name: 'Carol', password: 'password1' });
    const cookie = cookieOf(reg);
    const wrong = await post(
      base,
      '/api/account/password',
      { current: 'nope', next: 'password2' },
      cookie,
    );
    expect(wrong.status).toBe(403);
    const ok = await post(
      base,
      '/api/account/password',
      { current: 'password1', next: 'password2' },
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('answers 500 JSON, not a stack trace, when a route handler throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = makeService();
    Object.assign(service, {
      me: async () => {
        throw new Error('boom');
      },
    });
    const base = await start(service);
    const res = await fetch(`${base}/api/account/me`);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal error.' });
    spy.mockRestore();
  });
});

describe('account progress routes', () => {
  const admin = { 'x-account-progress-token': PROGRESS };
  it('separates progress credentials from role changes in both directions', async () => {
    const base = await start();
    const progressHeaders = {
      'x-account-progress-token': PROGRESS,
      'x-account-admin-token': PROGRESS,
    };
    expect(
      (
        await post(
          base,
          '/api/servers/accounts/group',
          { ref: 'Alice', fromGroupId: 1, toGroupId: 4 },
          '',
          progressHeaders,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(base, '/api/servers/progress', { batchId: 'test', accounts: [] }, '', {
          'x-account-admin-token': ADMIN,
          'x-account-progress-token': ADMIN,
        })
      ).status,
    ).toBe(403);
  });
  async function withAccount() {
    const service = makeService();
    const base = await start(service);
    const reg = await post(base, '/api/account/register', { name: 'Pia', password: 'password1' });
    const { account } = (await reg.json()) as { account: { id: number } };
    return { base, id: account.id };
  }

  it('needs the admin token', async () => {
    const { base, id } = await withAccount();
    expect((await fetch(`${base}/api/servers/progress/${id}`)).status).toBe(403);
    expect((await post(base, '/api/servers/progress', { batchId: 'a', accounts: [] })).status).toBe(
      403,
    );
  });

  it('stores a batch once and reads it back', async () => {
    const { base, id } = await withAccount();
    const batch = {
      batchId: 'srv-1:1',
      accounts: [
        {
          accountId: id,
          add: { 1: 4 },
          max: { 11: 30 },
          unlock: [{ id: 2, at: 1700 }],
          revoke: [],
        },
      ],
    };
    expect(await (await post(base, '/api/servers/progress', batch, '', admin)).json()).toEqual({
      ok: true,
      applied: true,
    });
    expect(await (await post(base, '/api/servers/progress', batch, '', admin)).json()).toEqual({
      ok: true,
      applied: false,
    });
    const read = await fetch(`${base}/api/servers/progress/${id}`, { headers: admin });
    expect(await read.json()).toEqual({
      stats: { 1: 4, 11: 30 },
      achievements: [{ id: 2, unlockedAt: 1700 }],
    });
  });

  it('refuses malformed batches whole and unknown accounts on read', async () => {
    const { base, id } = await withAccount();
    for (const bad of [
      { batchId: 'bad id!', accounts: [] },
      {
        batchId: 'x',
        accounts: [{ accountId: id, add: { 0: 1 }, max: {}, unlock: [], revoke: [] }],
      },
      {
        batchId: 'x',
        accounts: [{ accountId: id, add: { 1: -1 }, max: {}, unlock: [], revoke: [] }],
      },
      {
        batchId: 'x',
        accounts: [{ accountId: id, add: {}, max: {}, unlock: [{ id: 70000, at: 1 }], revoke: [] }],
      },
      { batchId: 'x', accounts: 'nope' },
    ])
      expect((await post(base, '/api/servers/progress', bad, '', admin)).status).toBe(400);
    expect((await fetch(`${base}/api/servers/progress/999999`, { headers: admin })).status).toBe(
      404,
    );
    expect((await fetch(`${base}/api/servers/progress/${id}`, { headers: admin })).status).toBe(
      200,
    );
  });
});
