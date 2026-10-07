// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  accountNameError,
  hashPassword,
  hashSessionToken,
  nameKey,
  newSessionToken,
  passwordError,
  verifyPassword,
} from './credentials';

describe('account names', () => {
  it.each(['Bob', 'Mr Smith', 'a_b-c.d', 'x1y', 'ABCDEFGHIJKLMNOP'])('accepts %j', (name) => {
    expect(accountNameError(name)).toBeNull();
  });
  it.each(['ab', 'ABCDEFGHIJKLMNOPQ', '1234', ' Bob', 'Bob ', 'Mr  Smith', 'Bób', 'a|b', '___'])(
    'rejects %j',
    (name) => {
      expect(accountNameError(name)).toEqual(expect.any(String));
    },
  );
  it('keys names case-insensitively', () => {
    expect(nameKey('BoB')).toBe(nameKey('bob'));
  });
});

describe('passwords', () => {
  it('enforces 8..128 characters', () => {
    expect(passwordError('1234567')).toEqual(expect.any(String));
    expect(passwordError('12345678')).toBeNull();
    expect(passwordError('x'.repeat(129))).toEqual(expect.any(String));
  });
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse', 1000);
    const b = await hashPassword('correct horse', 1000);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash).toHaveLength(32);
    expect(a.iterations).toBe(1000);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
  });
});

describe('session tokens', () => {
  it('returns a token and its SHA-256', () => {
    const { token, tokenHash } = newSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashSessionToken(token).equals(tokenHash)).toBe(true);
  });
});
