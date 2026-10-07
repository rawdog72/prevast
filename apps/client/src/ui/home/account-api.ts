// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The web host's account API (apps/web/src/accounts/account-routes.ts). The
// session is an HttpOnly cookie, so JavaScript never sees the session token.
import type {
  AccountProgressInfo,
  AccountSecurityInfo,
  AccountSessionInfo,
} from '../../../../../shared/typescript/account-profile';
import type { CommunityProfile, ClanCommand, ClanView, Rankings } from '../../../../../shared/typescript/account-community';
export interface AccountCommunityApi {
  profile(): Promise<CommunityProfile>;
  command(command: ClanCommand): Promise<{clanId:number|null}>;
  roster(offset?:number,search?:string): Promise<ClanView>;
  rankings(season?:string,metric?:Rankings['metric'],offset?:number): Promise<Rankings>;
  clan(id:number,offset?:number): Promise<ClanView>;
  player(id:number): Promise<Pick<CommunityProfile,'accountId'|'name'|'completedRuns'|'averageScore'|'bestScore'>>;
}
export interface AccountInfo {
  id: number;
  name: string;
  groupId: number;
  createdAt: number;
}

export interface AccountStatus {
  enabled: boolean;
  account?: AccountInfo;
}

/**
 * A refused or failed call. `message` is always fit to show a player; status 0
 * means the request never got an answer (offline, timeout).
 */
export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountApiError';
  }
}

export interface AccountApi {
  community?: AccountCommunityApi;
  me(): Promise<AccountStatus>;
  register(name: string, password: string, email: string, remember?: boolean): Promise<AccountInfo>;
  login(name: string, password: string, remember?: boolean): Promise<AccountInfo>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  security(): Promise<AccountSecurityInfo>;
  sessions(): Promise<AccountSessionInfo[]>;
  revokeSession(id: string): Promise<boolean>;
  recoveryCode(current: string): Promise<string>;
  verifyEmail(email: string, current: string): Promise<void>;
  confirmEmail(token: string): Promise<void>;
  requestReset(name: string, email: string): Promise<void>;
  resetPassword(body: {
    token?: string;
    code?: string;
    name?: string;
    next: string;
  }): Promise<void>;
  progress(): Promise<AccountProgressInfo>;
  /**
   * A 60-second login ticket for one listed server, at the address the client
   * will connect to (the list entry's host and port, as the list gave them).
   * 409 when the web host's list has moved on since.
   */
  ticket(serverId: string, host: string, port: number): Promise<string>;
}

export const OFFLINE_MESSAGE =
  'Could not reach the account service. Check your connection and try again.';
export const TIMEOUT_MESSAGE =
  'The account service is taking too long to answer. Try again in a moment.';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The host's own messages are written for players; the few machine codes
 * (rate limiter, disabled accounts, framework errors) are not.
 */
export function describeFailure(status: number, error: unknown): string {
  // Recovery may be unavailable while sign-in still works. Keep actionable
  // mail/recovery guidance from the host instead of claiming accounts are off.
  if (status === 503 && typeof error === 'string' && /[.!?]$/.test(error)) return error;
  if (status === 503 || error === 'accounts-disabled')
    return 'Accounts are unavailable right now. You can still play as a guest.';
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  if (typeof error === 'string' && /[.!?]$/.test(error)) return error;
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  return 'The request was refused. Reload the page and try again.';
}

export function createAccountApi(
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  base = '',
  timeoutMs = REQUEST_TIMEOUT_MS,
): AccountApi {
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(
        `${base}${path}`,
        body === undefined
          ? { credentials: 'same-origin', signal: controller.signal }
          : {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            },
      );
    } catch {
      throw new AccountApiError(0, controller.signal.aborted ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AccountApiError(res.status, describeFailure(res.status, data.error));
    return data as T;
  }
  return {
    community: {
      profile: () => call('/api/account/community'),
      command: (command) => call('/api/account/clan', command),
      roster: (offset=0,search='') => call('/api/account/clan/roster?'+new URLSearchParams({offset:String(offset),search})),
      rankings: (season,metric='score',offset=0) => call('/api/community/rankings?'+new URLSearchParams({...(season?{season}:{}),metric,offset:String(offset)})),
      clan: (id,offset=0) => call('/api/community/clans/'+id+'?offset='+offset),
      player: (id) => call('/api/community/players/'+id),
    },
    me: () => call<AccountStatus>('/api/account/me'),
    register: async (name, password, email, remember = true) =>
      (
        await call<{ account: AccountInfo }>('/api/account/register', {
          name,
          password,
          email,
          remember,
        })
      ).account,
    login: async (name, password, remember = true) =>
      (await call<{ account: AccountInfo }>('/api/account/login', { name, password, remember }))
        .account,
    security: () => call<AccountSecurityInfo>('/api/account/security'),
    sessions: async () =>
      (await call<{ sessions: AccountSessionInfo[] }>('/api/account/sessions')).sessions,
    revokeSession: async (id) =>
      (await call<{ signedOut: boolean }>('/api/account/sessions/revoke', { id })).signedOut,
    recoveryCode: async (current) =>
      (await call<{ code: string }>('/api/account/recovery-code', { current })).code,
    verifyEmail: async (email, current) => {
      await call('/api/account/email', { email, current });
    },
    confirmEmail: async (token) => {
      await call('/api/account/email/confirm', { token });
    },
    requestReset: async (name, email) => {
      await call('/api/account/recovery/request', { name, email });
    },
    resetPassword: async (body) => {
      await call('/api/account/recovery/reset', body);
    },
    progress: () => call<AccountProgressInfo>('/api/account/progress'),
    logout: async () => {
      await call('/api/account/logout', {});
    },
    changePassword: async (current, next) => {
      await call('/api/account/password', { current, next });
    },
    ticket: async (serverId, host, port) =>
      (await call<{ ticket: string }>('/api/account/ticket', { serverId, host, port })).ticket,
  };
}
