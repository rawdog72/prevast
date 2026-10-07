// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The shared secret game servers present in heartbeats. Env wins over the file. */
export function loadListingToken(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = path.join(root, '.listing-token');
  const token =
    env.LISTING_TOKEN || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
  if (token.length < 32 || token === 'change-me') {
    throw new Error(
      'Configure LISTING_TOKEN (32+ characters) in the environment or in .listing-token.',
    );
  }
  return token;
}

export function tokenValidator(token: string): (value: unknown) => boolean {
  const expected = Buffer.from(token);
  return (value) => {
    if (typeof value !== 'string') return false;
    const given = Buffer.from(value);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
}
