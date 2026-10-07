// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Everything the account API does, without HTTP: account-routes.ts is a thin
// wrapper. Group ranks are NOT interpreted here -- they live in the game
// server's data/XML/groups.xml, which checks them before calling setGroup.
import { emailError } from '../../../../shared/typescript/account-rules';
import type {
  AccountSecurityInfo,
  AccountSessionInfo,
} from '../../../../shared/typescript/account-profile';
import type { AccountMail } from './mail';
import type { AccountCommunity } from './community';
import {
  accountNameError,
  hashPassword,
  hashSessionToken,
  nameKey,
  newSessionToken,
  PASSWORD_ITERATIONS,
  passwordError,
  verifyPassword,
  type PasswordHash,
} from './credentials';
import {
  MAX_STAT_VALUE,
  type AccountRecord,
  type AccountStore,
  type ProgressDelta,
  type ProgressSnapshot,
} from './store';
import { newNonce, TICKET_LIFETIME_S, type TicketSigner } from './tickets';

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const TEMPORARY_SESSION_MS = 8 * 60 * 60 * 1000;
export const MAX_FAILED_LOGINS = 10;
export const LOCK_MS = 15 * 60 * 1000;
const WRONG_LOGIN = 'Wrong name or password.';

export interface PublicAccount {
  id: number;
  name: string;
  groupId: number;
  createdAt: number;
}

export type ServiceResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface AccountServiceOptions {
  community?: AccountCommunity;
  /** `host:port` of a live listed server, or null (Registry.address). */
  serverAddress: (id: string) => string | null;
  now?: () => number;
  passwordIterations?: number;
  mail?: AccountMail;
}

const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const field = (body: unknown, name: string): unknown =>
  body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
const toPublic = (a: AccountRecord): PublicAccount => ({
  id: a.id,
  name: a.name,
  groupId: a.groupId,
  createdAt: a.createdAt,
});
const storedHash = (a: AccountRecord): PasswordHash => ({
  hash: a.passwordHash,
  salt: a.passwordSalt,
  iterations: a.passwordIter,
});
const MAX_BATCH_ACCOUNTS = 500;
const MAX_DELTA_ENTRIES = 1024;
const id16 = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
    ? (value as number)
    : null;
const statValue = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_STAT_VALUE
    ? (value as number)
    : null;

/** One account's delta from a game server's batch, or null when malformed. */
function parseDelta(value: unknown): ProgressDelta | null {
  const accountId = field(value, 'accountId');
  if (!Number.isSafeInteger(accountId) || (accountId as number) < 1) return null;
  const numbers = (name: string): Record<number, number> | null => {
    const raw = field(value, name) ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<number, number> = {};
    for (const [key, n] of Object.entries(raw)) {
      const id = id16(Number(key));
      const amount = statValue(n);
      if (id === null || amount === null || String(id) !== key) return null;
      out[id] = amount;
    }
    return out;
  };
  const add = numbers('add');
  const max = numbers('max');
  const unlockRaw = field(value, 'unlock') ?? [];
  const revokeRaw = field(value, 'revoke') ?? [];
  if (!add || !max || !Array.isArray(unlockRaw) || !Array.isArray(revokeRaw)) return null;
  const unlock: ProgressDelta['unlock'] = [];
  for (const u of unlockRaw) {
    const id = id16(field(u, 'id'));
    const at = statValue(field(u, 'at'));
    if (id === null || at === null) return null;
    unlock.push({ id, at });
  }
  const revoke: number[] = [];
  for (const r of revokeRaw) {
    const id = id16(r);
    if (id === null) return null;
    revoke.push(id);
  }
  const entries = Object.keys(add).length + Object.keys(max).length + unlock.length + revoke.length;
  if (entries > MAX_DELTA_ENTRIES) return null;
  return { accountId: accountId as number, add, max, unlock, revoke };
}

const groupId = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 255
    ? (value as number)
    : null;

export class AccountService {
  private readonly now: () => number;
  private readonly iterations: number;
  private dummyHash: Promise<PasswordHash> | null = null;
  private readonly mailJobs = new Set<Promise<void>>();

  constructor(
    private readonly store: AccountStore,
    private readonly signer: TicketSigner,
    private readonly options: AccountServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.iterations = options.passwordIterations ?? PASSWORD_ITERATIONS;
  }

  get community(): AccountCommunity | undefined { return this.options.community; }

  get publicKeyRaw(): string {
    return this.signer.publicKeyRaw;
  }

  async register(
    body: unknown,
    device = '',
  ): Promise<ServiceResult<{ account: PublicAccount; sessionToken: string }>> {
    const name = str(field(body, 'name'));
    const password = str(field(body, 'password'));
    const email = str(field(body, 'email')).trim();
    const problem = accountNameError(name) ?? passwordError(password) ?? emailError(email);
    if (problem) return fail(400, problem);
    const hash = await hashPassword(password, this.iterations);
    const created = await this.store.createAccount({
      name,
      nameKey: nameKey(name),
      passwordHash: hash.hash,
      passwordSalt: hash.salt,
      passwordIter: hash.iterations,
      email,
      groupId: 1,
      createdAt: this.now(),
    });
    if (!created) return fail(409, 'That name is taken.');
    const sessionToken = await this.openSession(
      created.id,
      created.passwordHash,
      field(body, 'remember') !== false,
      device,
    );
    if (!sessionToken) return fail(409, 'Account changed. Sign in again.');
    return { ok: true, account: toPublic(created), sessionToken };
  }

  async login(
    body: unknown,
    device = '',
  ): Promise<ServiceResult<{ account: PublicAccount; sessionToken: string }>> {
    const name = str(field(body, 'name'));
    const password = str(field(body, 'password'));
    const account = name ? await this.store.findAccountByNameKey(nameKey(name)) : null;
    if (!account) {
      // Same cost as a real check, so response time does not reveal which names exist.
      await verifyPassword(password, await this.dummy());
      return fail(401, WRONG_LOGIN);
    }
    const now = this.now();
    if (account.lockedUntil > now)
      return fail(429, 'Too many failed logins. Try again in a few minutes.');
    if (!(await verifyPassword(password, storedHash(account)))) {
      await this.store.recordLoginFailure(account.id, now, MAX_FAILED_LOGINS, LOCK_MS);
      return fail(401, WRONG_LOGIN);
    }
    if (account.failedLogins !== 0 || account.lockedUntil !== 0) {
      await this.store.setLoginFailures(account.id, 0, 0);
    }
    if (account.passwordIter < this.iterations) {
      const upgraded = await hashPassword(password, this.iterations);
      await this.store.upgradePassword(account.id, account.passwordHash, upgraded);
      account.passwordHash = upgraded.hash;
    }
    const sessionToken = await this.openSession(
      account.id,
      account.passwordHash,
      field(body, 'remember') !== false,
      device,
    );
    if (!sessionToken) return fail(409, 'Account changed. Sign in again.');
    return { ok: true, account: toPublic(account), sessionToken };
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken) await this.store.deleteSession(hashSessionToken(sessionToken));
  }

  async me(sessionToken: string | undefined): Promise<PublicAccount | null> {
    const found = await this.session(sessionToken);
    return found ? toPublic(found.account) : null;
  }

  async changePassword(
    sessionToken: string | undefined,
    body: unknown,
  ): Promise<ServiceResult<object>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    const next = str(field(body, 'next'));
    const problem = passwordError(next);
    if (problem) return fail(400, problem);
    if (!(await verifyPassword(str(field(body, 'current')), storedHash(found.account)))) {
      return fail(403, 'Current password is wrong.');
    }
    if (
      !(await this.store.changePassword(
        found.account.id,
        found.account.passwordHash,
        await hashPassword(next, this.iterations),
        found.tokenHash,
      ))
    )
      return fail(409, 'Account changed. Try again.');
    return { ok: true };
  }

  async security(sessionToken: string | undefined): Promise<ServiceResult<AccountSecurityInfo>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    const s = await this.store.getSecurity(found.account.id);
    return {
      ok: true,
      email: found.account.email,
      emailVerified: !!s.verifiedEmail && s.verifiedEmail === found.account.email,
      emailAvailable: !!this.options.mail,
      hasRecoveryCode: !!s.recoveryHash,
    };
  }

  async sessions(
    sessionToken: string | undefined,
  ): Promise<ServiceResult<{ sessions: AccountSessionInfo[] }>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    const list = await this.store.listSessions(found.account.id, this.now());
    return {
      ok: true,
      sessions: list.map((s) => ({
        id: this.sessionId(s.tokenHash),
        device: s.device || 'Browser (details unavailable)',
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt ?? s.createdAt,
        expiresAt: s.expiresAt,
        current: s.tokenHash.equals(found.tokenHash),
      })),
    };
  }

  async revokeSession(
    sessionToken: string | undefined,
    body: unknown,
  ): Promise<ServiceResult<{ signedOut: boolean }>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    const id = str(field(body, 'id'));
    if (id === 'all') {
      await this.store.deleteSessionsExcept(found.account.id, null);
      return { ok: true, signedOut: true };
    }
    const target = (await this.store.listSessions(found.account.id, this.now())).find(
      (s) => this.sessionId(s.tokenHash) === id,
    );
    if (!target) return fail(404, 'That session is no longer active.');
    await this.store.deleteSession(target.tokenHash);
    return { ok: true, signedOut: target.tokenHash.equals(found.tokenHash) };
  }

  async recoveryCode(
    sessionToken: string | undefined,
    body: unknown,
  ): Promise<ServiceResult<{ code: string }>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    if (!(await verifyPassword(str(field(body, 'current')), storedHash(found.account))))
      return fail(403, 'Current password is wrong.');
    const code = newSessionToken().token;
    if (
      !(await this.store.setRecoveryCode(
        found.account.id,
        found.account.passwordHash,
        hashSessionToken(code),
      ))
    )
      return fail(409, 'Account changed. Try again.');
    return { ok: true, code };
  }

  async verifyEmail(
    sessionToken: string | undefined,
    body: unknown,
  ): Promise<ServiceResult<object>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    if (!this.options.mail)
      return fail(503, 'Email delivery is not configured. You can use a recovery code.');
    const email = str(field(body, 'email')).trim().toLowerCase();
    const problem = !email ? 'Enter an email address.' : emailError(email);
    if (problem) return fail(400, problem);
    if (!(await verifyPassword(str(field(body, 'current')), storedHash(found.account))))
      return fail(403, 'Current password is wrong.');
    const { token, tokenHash } = newSessionToken();
    if (
      !(await this.store.issueAction(
        {
          tokenHash,
          accountId: found.account.id,
          kind: 'verify',
          email,
          createdAt: this.now(),
          expiresAt: this.now() + 30 * 60_000,
        },
        found.account.passwordHash,
      ))
    )
      return fail(429, 'Wait a minute before requesting another email, then try again.');
    try {
      await this.options.mail.send(email, 'verify', token);
    } catch {
      return fail(503, 'The email could not be sent. Wait a minute and try again.');
    }
    return { ok: true };
  }

  async confirmEmail(body: unknown): Promise<ServiceResult<object>> {
    const token = str(field(body, 'token'));
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !(await this.store.completeAction(hashSessionToken(token), this.now()))
    )
      return fail(400, 'This verification link is invalid or expired. Request a new one.');
    return { ok: true };
  }

  async requestReset(body: unknown): Promise<ServiceResult<object>> {
    if (!this.options.mail)
      return fail(503, 'Email delivery is not configured. Use your recovery code.');
    // Every request returns before lookup and delivery, including unknown names.
    // The bounded queue prevents anonymous requests from accumulating mail jobs.
    if (this.mailJobs.size >= 20) return fail(429, 'Too many requests. Try again shortly.');
    const name = str(field(body, 'name'));
    const email = str(field(body, 'email')).trim().toLowerCase();
    const job = Promise.resolve()
      .then(async () => {
        const a = await this.store.findAccountByNameKey(nameKey(name));
        if (!a || !email) return;
        const s = await this.store.getSecurity(a.id);
        if (!s.verifiedEmail || s.verifiedEmail !== email) return;
        const { token, tokenHash } = newSessionToken();
        if (
          await this.store.issueAction({
            tokenHash,
            accountId: a.id,
            kind: 'reset',
            email,
            createdAt: this.now(),
            expiresAt: this.now() + 15 * 60_000,
          })
        )
          await this.options.mail!.send(email, 'reset', token);
      })
      .catch(() => {
        console.warn('[accounts] Recovery email delivery failed.');
      });
    this.mailJobs.add(job);
    void job.finally(() => this.mailJobs.delete(job));
    return { ok: true };
  }

  /** Also used at shutdown/tests, so pending mail does not outlive its store. */
  async finishMail(): Promise<void> {
    await Promise.all(this.mailJobs);
  }

  async resetPassword(body: unknown): Promise<ServiceResult<object>> {
    const next = str(field(body, 'next'));
    const problem = passwordError(next);
    if (problem) return fail(400, problem);
    const token = str(field(body, 'token'));
    const code = str(field(body, 'code')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || code))
      return fail(400, 'The recovery link or code is invalid or expired.');
    const hash = await hashPassword(next, this.iterations);
    const a = code
      ? await this.store.findAccountByNameKey(nameKey(str(field(body, 'name'))))
      : null;
    const changed = token
      ? await this.store.completeAction(hashSessionToken(token), this.now(), hash)
      : a && (await this.store.recoverWithCode(a.id, hashSessionToken(code), hash));
    if (!changed) return fail(400, 'The recovery link or code is invalid or expired.');
    return { ok: true };
  }

  async myProgress(sessionToken: string | undefined): Promise<ServiceResult<ProgressSnapshot>> {
    const found = await this.session(sessionToken);
    return found
      ? { ok: true, ...(await this.store.getProgress(found.account.id)) }
      : fail(401, 'Log in first.');
  }

  async cleanup(): Promise<void> {
    await this.store.cleanup(this.now());
  }

  private sessionId(hash: Buffer): string {
    return hashSessionToken(hash.toString('hex')).toString('hex');
  }

  async issueTicket(
    sessionToken: string | undefined,
    body: unknown,
  ): Promise<ServiceResult<{ ticket: string }>> {
    const found = await this.session(sessionToken);
    if (!found) return fail(401, 'Log in first.');
    const listingId = str(field(body, 'serverId'));
    const host = str(field(body, 'host'));
    const port = field(body, 'port');
    if (
      !listingId ||
      !host ||
      host.length > 255 ||
      !Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535
    ) {
      return fail(400, 'Say which server (serverId, host, port) the ticket is for.');
    }
    const address = this.options.serverAddress(listingId);
    if (!address) return fail(404, 'That server is not on the list.');
    // The client names the address it is about to connect to (from the list it
    // loaded earlier). If the registry now holds another one for this id --
    // someone heartbeating the id from elsewhere, or a real move -- sign
    // nothing: a ticket for the registry's address, sent to the client's, is
    // exactly what a hijacker would replay.
    if (address !== `${host}:${port as number}`)
      return fail(409, 'The server list changed; refresh and try again.');
    const ticket = this.signer.sign({
      accountId: found.account.id,
      name: found.account.name,
      groupId: found.account.groupId,
      // Bound to the address the registry holds for this id, not the id alone:
      // any listed server can heartbeat any id, so only a ticket for the real
      // server's own host:port is useful to it (see ticketServerId in C++).
      serverId: `${listingId}@${address}`,
      expiresAt: Math.floor(this.now() / 1000) + TICKET_LIFETIME_S,
      nonce: newNonce(),
    });
    return { ok: true, ticket };
  }

  async lookup(ref: string): Promise<PublicAccount | null> {
    const account = await this.find(ref);
    return account ? toPublic(account) : null;
  }

  async setGroup(body: unknown): Promise<ServiceResult<{ account: PublicAccount }>> {
    const from = groupId(field(body, 'fromGroupId'));
    const to = groupId(field(body, 'toGroupId'));
    if (from === null || to === null) return fail(400, 'Group ids are 1-255.');
    const account = await this.find(str(field(body, 'ref')));
    if (!account) return fail(404, 'No such account.');
    if (!(await this.store.setGroup(account.id, from, to)))
      return fail(409, 'Group changed meanwhile; try again.');
    return { ok: true, account: { ...toPublic(account), groupId: to } };
  }

  /** A game server loading an account's stats and achievements at login. */
  async progress(accountId: number): Promise<ServiceResult<ProgressSnapshot>> {
    if (!Number.isSafeInteger(accountId) || accountId < 1)
      return fail(400, 'Account ids are positive integers.');
    if (!(await this.store.findAccountById(accountId))) return fail(404, 'No such account.');
    return { ok: true, ...(await this.store.getProgress(accountId)) };
  }

  /** A game server storing a batch of progress deltas; a repeated batch id is acknowledged, not applied again. */
  async applyProgress(
    body: unknown,
    serverId?: string,
  ): Promise<ServiceResult<{ applied: boolean }>> {
    const batchId = str(field(body, 'batchId'));
    if (!/^[A-Za-z0-9:._-]{1,96}$/.test(batchId))
      return fail(400, 'batchId must be 1-96 characters of A-Z, 0-9, : . _ -');
    const list = field(body, 'accounts');
    if (!Array.isArray(list) || list.length > MAX_BATCH_ACCOUNTS)
      return fail(400, `accounts must be an array of at most ${MAX_BATCH_ACCOUNTS}.`);
    const deltas: ProgressDelta[] = [];
    for (const item of list) {
      const delta = parseDelta(item);
      if (!delta) return fail(400, 'Malformed account delta.');
      deltas.push(delta);
    }
    const storedId = serverId
      ? hashSessionToken(`${serverId}\n${batchId}`).toString('hex')
      : batchId;
    return {
      ok: true,
      applied: await this.store.applyProgress(
        storedId,
        this.now(),
        deltas,
        serverId ? batchId : undefined,
      ),
    };
  }

  private async find(ref: string): Promise<AccountRecord | null> {
    if (/^#\d+$/.test(ref)) return this.store.findAccountById(Number(ref.slice(1)));
    return ref ? this.store.findAccountByNameKey(nameKey(ref)) : null;
  }

  private async openSession(
    accountId: number,
    expected: Buffer,
    remember: boolean,
    device: string,
  ): Promise<string | null> {
    const { token, tokenHash } = newSessionToken();
    const now = this.now();
    const created = await this.store.createSession(
      {
        tokenHash,
        accountId,
        createdAt: now,
        expiresAt: now + (remember ? SESSION_LIFETIME_MS : TEMPORARY_SESSION_MS),
        device: device.slice(0, 160),
        lastUsedAt: now,
      },
      expected,
    );
    return created ? token : null;
  }

  private async session(
    sessionToken: string | undefined,
  ): Promise<{ account: AccountRecord; tokenHash: Buffer } | null> {
    if (!sessionToken) return null;
    const tokenHash = hashSessionToken(sessionToken);
    const session = await this.store.findSession(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      await this.store.deleteSession(tokenHash);
      return null;
    }
    const account = await this.store.findAccountById(session.accountId);
    if (account) await this.store.touchSession(tokenHash, this.now());
    return account ? { account, tokenHash } : null;
  }

  private dummy(): Promise<PasswordHash> {
    this.dummyHash ??= hashPassword('not-a-real-password', this.iterations);
    return this.dummyHash;
  }
}
