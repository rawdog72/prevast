// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { AccountService, TEMPORARY_SESSION_MS } from './account-service';
import { MemoryAccountStore } from './memory-store';
import { TicketSigner } from './tickets';
import { hashSessionToken } from './credentials';

const signer = TicketSigner.fromPem(TicketSigner.generatePem());
let now: number;
let store: MemoryAccountStore;
let service: AccountService;
let mail: { email: string; purpose: string; token: string }[];
beforeEach(() => {
  now = 1_800_000_000_000;
  store = new MemoryAccountStore();
  mail = [];
  service = new AccountService(store, signer, {
    now: () => now,
    passwordIterations: 1000,
    serverAddress: () => 'localhost:7172',
    mail: {
      send: async (email, purpose, token) => {
        mail.push({ email, purpose, token });
      },
    },
  });
});
async function register(name = 'Alice') {
  const r = await service.register({ name, password: 'password1', email: 'alice@example.com' });
  if (!r.ok) throw new Error(r.error);
  return r;
}
async function verify(session: string) {
  expect(
    await service.verifyEmail(session, { email: 'alice@example.com', current: 'password1' }),
  ).toEqual({ ok: true });
  expect(await service.confirmEmail({ token: mail.at(-1)!.token })).toEqual({ ok: true });
  now += 60_000;
}

describe('account recovery and session lifecycle', () => {
  it('does not trust legacy registration emails and gives the same reset response for unknown accounts', async () => {
    await register();
    expect(await service.requestReset({ name: 'Alice', email: 'alice@example.com' })).toEqual(
      await service.requestReset({ name: 'Nobody', email: 'alice@example.com' }),
    );
    await service.finishMail();
    expect(mail).toHaveLength(0);
  });

  it('requires reauthentication, enforces cooldown and consumes verification links once', async () => {
    const a = await register();
    expect(
      await service.verifyEmail(a.sessionToken, { email: 'new@example.com', current: 'wrong' }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await service.verifyEmail(a.sessionToken, { email: 'new@example.com', current: 'password1' }),
    ).toEqual({ ok: true });
    expect(await service.security(a.sessionToken)).toMatchObject({
      email: 'alice@example.com',
      emailVerified: false,
    });
    expect(
      await service.verifyEmail(a.sessionToken, { email: 'new@example.com', current: 'password1' }),
    ).toMatchObject({ status: 429 });
    const token = mail[0]!.token;
    expect(await service.resetPassword({ token, next: 'next-password' })).toMatchObject({
      ok: false,
    });
    expect(await service.confirmEmail({ token })).toEqual({ ok: true });
    expect(await service.confirmEmail({ token })).toMatchObject({ ok: false });
    expect(await service.security(a.sessionToken)).toMatchObject({
      email: 'new@example.com',
      emailVerified: true,
    });
  });

  it('resets once under concurrent requests and atomically revokes every browser session', async () => {
    const a = await register();
    await verify(a.sessionToken);
    const b = await service.login({ name: 'Alice', password: 'password1' });
    if (!b.ok) throw new Error(b.error);
    await service.requestReset({ name: 'Alice', email: 'alice@example.com' });
    await service.finishMail();
    const token = mail.at(-1)!.token;
    const results = await Promise.all(
      [1, 2].map(() => service.resetPassword({ token, next: 'new-password' })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await service.me(a.sessionToken)).toBeNull();
    expect(await service.me(b.sessionToken)).toBeNull();
    expect(await service.login({ name: 'Alice', password: 'password1' })).toMatchObject({
      ok: false,
    });
    expect(await service.login({ name: 'Alice', password: 'new-password' })).toMatchObject({
      ok: true,
    });
  });

  it('expires reset links and rejects reset tokens as verification links', async () => {
    const a = await register();
    await verify(a.sessionToken);
    await service.requestReset({ name: 'Alice', email: 'alice@example.com' });
    await service.finishMail();
    const token = mail.at(-1)!.token;
    expect(await service.confirmEmail({ token })).toMatchObject({ ok: false });
    now += 15 * 60_000;
    expect(await service.resetPassword({ token, next: 'new-password' })).toMatchObject({
      ok: false,
    });
    expect(await service.me(a.sessionToken)).not.toBeNull();
  });

  it('rotates recovery codes, requires the owner name, and consumes the code once', async () => {
    const a = await register();
    const first = await service.recoveryCode(a.sessionToken, { current: 'password1' });
    const second = await service.recoveryCode(a.sessionToken, { current: 'password1' });
    if (!first.ok || !second.ok) throw new Error('code generation failed');
    expect(
      await service.resetPassword({ name: 'Alice', code: first.code, next: 'new-password' }),
    ).toMatchObject({ ok: false });
    expect(
      await service.resetPassword({ name: 'Nobody', code: second.code, next: 'new-password' }),
    ).toMatchObject({ ok: false });
    expect(
      await service.resetPassword({ name: 'Alice', code: second.code, next: 'new-password' }),
    ).toEqual({ ok: true });
    expect(
      await service.resetPassword({ name: 'Alice', code: second.code, next: 'other-password' }),
    ).toMatchObject({ ok: false });
    expect(await service.me(a.sessionToken)).toBeNull();
  });

  it('invalidates outstanding recovery links and codes on ordinary password changes', async () => {
    const a = await register();
    const code = await service.recoveryCode(a.sessionToken, { current: 'password1' });
    if (!code.ok) throw new Error(code.error);
    await service.verifyEmail(a.sessionToken, { email: 'new@example.com', current: 'password1' });
    await service.changePassword(a.sessionToken, { current: 'password1', next: 'new-password' });
    expect(await service.confirmEmail({ token: mail[0]!.token })).toMatchObject({ ok: false });
    expect(
      await service.resetPassword({ name: 'Alice', code: code.code, next: 'other-password' }),
    ).toMatchObject({ ok: false });
    expect(await service.me(a.sessionToken)).not.toBeNull();
  });

  it('lists only owned sessions, hides token hashes, and refuses revocation across accounts', async () => {
    const a = await register();
    const b = await register('Bob');
    const sessions = await service.sessions(a.sessionToken);
    if (!sessions.ok) throw new Error(sessions.error);
    expect(sessions.sessions).toHaveLength(1);
    const id = sessions.sessions[0]!.id;
    expect(JSON.stringify(sessions)).not.toContain(
      hashSessionToken(a.sessionToken).toString('hex'),
    );
    expect(await service.revokeSession(b.sessionToken, { id })).toMatchObject({ status: 404 });
    expect(await service.revokeSession(a.sessionToken, { id: 'all' })).toEqual({
      ok: true,
      signedOut: true,
    });
    expect(await service.me(a.sessionToken)).toBeNull();
    expect(await service.me(b.sessionToken)).not.toBeNull();
  });

  it('uses a shorter absolute lifetime when remembered sign-in is declined', async () => {
    const a = await service.register(
      { name: 'Alice', password: 'password1', remember: false },
      'Firefox on Windows',
    );
    if (!a.ok) throw new Error(a.error);
    expect(await service.sessions(a.sessionToken)).toMatchObject({
      sessions: [{ device: 'Firefox on Windows', expiresAt: now + TEMPORARY_SESSION_MS }],
    });
    now += TEMPORARY_SESSION_MS;
    expect(await service.me(a.sessionToken)).toBeNull();
  });

  it('rehashes old credentials after successful login', async () => {
    await register();
    const stronger = new AccountService(store, signer, {
      passwordIterations: 2000,
      now: () => now,
      serverAddress: () => null,
    });
    expect(await stronger.login({ name: 'Alice', password: 'password1' })).toMatchObject({
      ok: true,
    });
    expect((await store.findAccountById(1))!.passwordIter).toBe(2000);
  });

  it('isolates batch ids by server while preserving legacy retries during migration', async () => {
    const a = await register();
    const batch = { batchId: 'one', accounts: [{ accountId: a.account.id, add: { 1: 2 } }] };
    expect(await service.applyProgress(batch, 'server-a')).toEqual({ ok: true, applied: true });
    expect(await service.applyProgress(batch, 'server-a')).toEqual({ ok: true, applied: false });
    expect(await service.applyProgress(batch, 'server-b')).toEqual({ ok: true, applied: true });
    await service.applyProgress({ ...batch, batchId: 'legacy' });
    expect(await service.applyProgress({ ...batch, batchId: 'legacy' }, 'server-a')).toEqual({
      ok: true,
      applied: false,
    });
    expect((await store.getProgress(a.account.id)).stats[1]).toBe(6);
  });
});
