// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdmission } from './rate-limit';

let server: Server | null = null;

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(trustProxy: string | number | boolean): Promise<string> {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', createAdmission({ perIpTokens: 1, perIpRefillPerMs: 0 }), (_req, res) => {
    res.json({ ok: true });
  });
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
}

const from = (base: string, ip: string) => fetch(base, { headers: { 'x-forwarded-for': ip } });

describe('admission', () => {
  it('budgets each client behind a trusted proxy separately', async () => {
    const base = await start('loopback');
    expect((await from(base, '203.0.113.1')).status).toBe(200);
    expect((await from(base, '203.0.113.1')).status).toBe(429);
    expect((await from(base, '203.0.113.2')).status).toBe(200);
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const base = await start(false);
    expect((await from(base, '203.0.113.1')).status).toBe(200);
    expect((await from(base, '203.0.113.2')).status).toBe(429);
  });
});
