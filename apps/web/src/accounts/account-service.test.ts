// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { AccountService, LOCK_MS, SESSION_LIFETIME_MS } from './account-service';
import { MemoryAccountStore } from './memory-store';
import { readTicket, TicketSigner } from './tickets';

let now = 1_800_000_000_000;
let service: AccountService;
let store: MemoryAccountStore;
const signer = TicketSigner.fromPem(TicketSigner.generatePem());

beforeEach(() => {
  now = 1_800_000_000_000;
  store = new MemoryAccountStore();
  service = new AccountService(store, signer, {
    serverAddress: (id) => (id === 'srv' ? '203.0.113.5:7172' : null),
    now: () => now,
    passwordIterations: 1000,
  });
});

async function registered(name = 'Alice', password = 'password1') {
  const r = await service.register({ name, password });
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('register', () => {
  it('creates a player-group account and a session', async () => {
    const r = await registered();
    expect(r.account).toEqual({ id: 1, name: 'Alice', groupId: 1, createdAt: now });
    expect(await service.me(r.sessionToken)).toEqual(r.account);
  });

  it('rejects bad input and taken names', async () => {
    await registered();
    expect(await service.register({ name: 'alice', password: 'password1' })).toMatchObject({ ok: false, status: 409 });
    expect(await service.register({ name: 'x', password: 'password1' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.register({ name: 'Bob', password: 'short' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.register({ name: 'Bob', password: 'password1', email: 'nope' })).toMatchObject({ ok: false, status: 400 });
    expect(await service.register(null)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('login', () => {
  it('logs in case-insensitively and rejects wrong passwords generically', async () => {
    await registered();
    expect(await service.login({ name: 'ALICE', password: 'password1' })).toMatchObject({ ok: true });
    const wrong = await service.login({ name: 'Alice', password: 'nope-nope' });
    const unknown = await service.login({ name: 'Nobody', password: 'nope-nope' });
    expect(wrong).toEqual({ ok: false, status: 401, error: 'Wrong name or password.' });
    expect(unknown).toEqual(wrong);
  });

  it('locks after 10 failures for 15 minutes, then unlocks', async () => {
    await registered();
    for (let i = 0; i < 10; i++) await service.login({ name: 'Alice', password: 'bad-password' });
    expect(await service.login({ name: 'Alice', password: 'password1' })).toMatchObject({ ok: false, status: 429 });
    now += LOCK_MS + 1;
    expect(await service.login({ name: 'Alice', password: 'password1' })).toMatchObject({ ok: true });
    expect((await store.findAccountByNameKey('alice'))!.failedLogins).toBe(0);
  });

  it('counts concurrent failures without losing any', async () => {
    await registered();
    await Promise.all(Array.from({ length: 10 }, () => service.login({ name: 'Alice', password: 'bad-password' })));
    expect(await service.login({ name: 'Alice', password: 'password1' })).toMatchObject({ ok: false, status: 429 });
  });
});

describe('sessions', () => {
  it('expires sessions and logs out', async () => {
    const r = await registered();
    await service.logout(r.sessionToken);
    expect(await service.me(r.sessionToken)).toBeNull();
    const again = await service.login({ name: 'Alice', password: 'password1' });
    if (!again.ok) throw new Error();
    now += SESSION_LIFETIME_MS + 1;
    expect(await service.me(again.sessionToken)).toBeNull();
    expect(await service.me(undefined)).toBeNull();
  });

  it('changes the password and revokes other sessions', async () => {
    const first = await registered();
    const second = await service.login({ name: 'Alice', password: 'password1' });
    if (!second.ok) throw new Error();
    expect(await service.changePassword(first.sessionToken, { current: 'wrong-one', next: 'password2' })).toMatchObject({ ok: false, status: 403 });
    expect(await service.changePassword(first.sessionToken, { current: 'password1', next: 'password2' })).toEqual({ ok: true });
    expect(await service.me(first.sessionToken)).not.toBeNull();
    expect(await service.me(second.sessionToken)).toBeNull();
    expect(await service.login({ name: 'Alice', password: 'password2' })).toMatchObject({ ok: true });
  });
});

describe('tickets', () => {
  const srv = { serverId: 'srv', host: '203.0.113.5', port: 7172 };

  it('issues a ticket for the address the client will join, bound to it', async () => {
    const r = await registered();
    const t = await service.issueTicket(r.sessionToken, srv);
    if (!t.ok) throw new Error(t.error);
    expect(readTicket(t.ticket, service.publicKeyRaw)).toMatchObject({
      accountId: 1,
      name: 'Alice',
      groupId: 1,
      serverId: 'srv@203.0.113.5:7172',
      expiresAt: Math.floor(now / 1000) + 60,
    });
    expect(await service.issueTicket('nope', srv)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses unknown servers, a changed address and bad input', async () => {
    const r = await registered();
    const issue = (body: unknown) => service.issueTicket(r.sessionToken, body);
    expect(await issue({ ...srv, serverId: 'other' })).toMatchObject({ ok: false, status: 404 });
    // The registry now holds another address for this id than the list the
    // client joined from: never sign for the registry's side of that.
    expect(await issue({ ...srv, host: '198.51.100.7' })).toEqual({
      ok: false,
      status: 409,
      error: 'The server list changed; refresh and try again.',
    });
    expect(await issue({ ...srv, port: 7173 })).toMatchObject({ ok: false, status: 409 });
    for (const bad of [{ serverId: 'srv' }, { ...srv, host: '' }, { ...srv, port: '7172' }, { ...srv, port: 0 }, { ...srv, port: 70000 }, { ...srv, port: 1.5 }, { ...srv, host: 7 }]) {
      expect(await issue(bad)).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe('groups', () => {
  it('looks up by name or #id and changes group with compare-and-set', async () => {
    await registered();
    expect(await service.lookup('alice')).toMatchObject({ id: 1, groupId: 1 });
    expect(await service.lookup('#1')).toMatchObject({ name: 'Alice' });
    expect(await service.lookup('#99')).toBeNull();
    expect(await service.setGroup({ ref: 'Alice', fromGroupId: 1, toGroupId: 4 })).toMatchObject({ ok: true, account: { groupId: 4 } });
    expect(await service.setGroup({ ref: 'Alice', fromGroupId: 1, toGroupId: 2 })).toMatchObject({ ok: false, status: 409 });
    expect(await service.setGroup({ ref: 'Nobody', fromGroupId: 1, toGroupId: 2 })).toMatchObject({ ok: false, status: 404 });
    expect(await service.setGroup({ ref: 'Alice', fromGroupId: 4, toGroupId: 0 })).toMatchObject({ ok: false, status: 400 });
  });
});
