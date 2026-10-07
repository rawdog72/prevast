// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Password hashing and session tokens. Only the web host ever sees a
// password; game servers receive signed tickets instead. The name and password
// rules live in shared/typescript/account-rules.ts, which the start page
// checks too.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

export {
  accountNameError,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordError,
} from '../../../../shared/typescript/account-rules';

const pbkdf2 = promisify(crypto.pbkdf2);

export const PASSWORD_ITERATIONS = 600_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

export interface PasswordHash {
  hash: Buffer;
  salt: Buffer;
  iterations: number;
}

export const nameKey = (name: string): string => name.toLowerCase();

export async function hashPassword(
  password: string,
  iterations = PASSWORD_ITERATIONS,
): Promise<PasswordHash> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await pbkdf2(password, salt, iterations, HASH_BYTES, 'sha256');
  return { hash, salt, iterations };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const hash = await pbkdf2(password, stored.salt, stored.iterations, HASH_BYTES, 'sha256');
  return hash.length === stored.hash.length && crypto.timingSafeEqual(hash, stored.hash);
}

export const hashSessionToken = (token: string): Buffer =>
  crypto.createHash('sha256').update(token).digest();

export function newSessionToken(): { token: string; tokenHash: Buffer } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}
