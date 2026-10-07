// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  AccountApiError,
  createAccountApi,
  describeFailure,
  OFFLINE_MESSAGE,
  TIMEOUT_MESSAGE,
} from './account-api';

const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('account api', () => {
  it('posts JSON with credentials and unwraps results', async () => {
    const fetchImpl = vi.fn(() => reply(200, { ticket: 'T' }));
    const api = createAccountApi(fetchImpl as unknown as typeof fetch);
    expect(await api.ticket('srv', '[2001:db8::1]', 7172)).toBe('T');
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/ticket', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv', host: '[2001:db8::1]', port: 7172 }),
      signal: expect.any(AbortSignal),
    });
  });

  it('turns error bodies into AccountApiError', async () => {
    const api = createAccountApi((() =>
      reply(401, { error: 'Wrong name or password.' })) as unknown as typeof fetch);
    await expect(api.login('a', 'b')).rejects.toEqual(
      new AccountApiError(401, 'Wrong name or password.'),
    );
  });

  it('reports an unreachable host as status 0 with a readable message', async () => {
    const api = createAccountApi((() =>
      Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch);
    await expect(api.me()).rejects.toEqual(new AccountApiError(0, OFFLINE_MESSAGE));
  });

  it('gives up on a host that does not answer', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const api = createAccountApi(hang, '', 10);
    await expect(api.login('a', 'b')).rejects.toEqual(new AccountApiError(0, TIMEOUT_MESSAGE));
  });
});

describe('describeFailure', () => {
  it('keeps the host sentences and rewrites machine codes', () => {
    expect(describeFailure(409, 'That name is taken.')).toBe('That name is taken.');
    expect(describeFailure(429, 'Too many failed logins. Try again in a few minutes.')).toMatch(
      /few minutes/,
    );
    expect(describeFailure(429, 'rate limit')).toMatch(/Too many attempts/);
    expect(describeFailure(429, 'busy')).toMatch(/Too many attempts/);
    expect(describeFailure(503, 'accounts-disabled')).toMatch(/guest/);
    expect(
      describeFailure(503, 'Email delivery is not configured. Use your recovery code.'),
    ).toMatch(/recovery code/);
    expect(
      describeFailure(503, 'The email could not be sent. Wait a minute and try again.'),
    ).toMatch(/email could not be sent/);
    expect(describeFailure(500, 'Internal error.')).toMatch(/our side/);
    expect(describeFailure(400, 'Bad Request')).toMatch(/Reload/);
    expect(describeFailure(415, undefined)).toMatch(/Reload/);
  });
});
