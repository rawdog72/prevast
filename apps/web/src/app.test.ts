// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, parseTrustProxy } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOKEN = 't'.repeat(40);
// One of the project's own sprites, so the test needs no original assets.
const OWN_SPRITE = 'inv-npc-cap-out.png';
const originalAssets = mkdtempSync(path.join(tmpdir(), 'original-assets-'));
let server: Server;
let base = '';

beforeAll(async () => {
  mkdirSync(path.join(originalAssets, 'img'));
  mkdirSync(path.join(originalAssets, 'audio'));
  writeFileSync(path.join(originalAssets, 'img', 'only-original.png'), 'original sprite');
  writeFileSync(path.join(originalAssets, 'img', OWN_SPRITE), 'original copy of a project sprite');
  writeFileSync(path.join(originalAssets, 'audio', 'craft.mp3'), 'original sound');
  writeFileSync(path.join(originalAssets, 'manifest.json'), '{}');
  const app = createApp({ root, validToken: (t) => t === TOKEN, originalAssets });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(originalAssets, { recursive: true, force: true });
});

const beat = (body: Record<string, unknown>) =>
  fetch(`${base}/api/servers/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('host', () => {
  it('lists a visible server after a heartbeat, as objects', async () => {
    const posted = await beat({
      token: TOKEN,
      id: 'a',
      host: '127.0.0.1',
      port: 7172,
      statusPort: 7171,
      visible: 1,
      name: 'Local',
    });
    expect(posted.status).toBe(200);
    const list = await (await fetch(`${base}/api/servers/list`)).json();
    expect(list).toEqual([
      expect.objectContaining({
        id: 'a',
        host: '127.0.0.1',
        port: 7172,
        statusPort: 7171,
        name: 'Local',
      }),
    ]);
  });

  it('rejects a bad token and guards the operator list with a bearer token', async () => {
    expect((await beat({ token: 'nope', id: 'b', host: '127.0.0.1', port: 7172 })).status).toBe(
      403,
    );
    expect((await fetch(`${base}/api/servers`)).status).toBe(403);
    const ok = await fetch(`${base}/api/servers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    // Not `secondsSinceBeat: 0`: a loaded parallel run can cross a second boundary.
    expect(await ok.json()).toEqual([
      expect.objectContaining({ id: 'a', secondsSinceBeat: expect.any(Number) }),
    ]);
  });

  it('serves index.html from public/', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="prevast-home"');
  });

  it('revalidates the page and stylesheets on every load but lets images cache', async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const css = await fetch(`${base}/css/hud.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('cache-control')).toBe('no-cache');
    const img = await fetch(`${base}/img/${OWN_SPRITE}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('cache-control')).toContain('max-age=86400');
    // A sprite addressed by its manifest hash never changes: cache it for good.
    const versioned = await fetch(`${base}/img/${OWN_SPRITE}?v=abc12345`);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves the original assets folder after the project art, with the same caching', async () => {
    const original = await fetch(`${base}/img/only-original.png?v=abc12345`);
    expect(original.status).toBe(200);
    expect(await original.text()).toBe('original sprite');
    expect(original.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const sound = await fetch(`${base}/audio/craft.mp3`);
    expect(sound.status).toBe(200);
    expect(sound.headers.get('cache-control')).toContain('max-age=86400');
  });

  it('prefers the project art when the original folder has a file of the same name', async () => {
    const res = await fetch(`${base}/img/${OWN_SPRITE}`);
    const own = readFileSync(path.join(root, 'apps', 'client', 'public', 'img', OWN_SPRITE));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(own);
  });

  it('serves only img/ and audio/ from the original assets folder', async () => {
    expect((await fetch(`${base}/manifest.json`)).status).toBe(404);
  });

  it('gzips the bundle and the content tables', async () => {
    const res = await fetch(`${base}/content/items.json`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
  });

  it('serves generated content tables from dist/content/ at /content', async () => {
    const res = await fetch(`${base}/content/config.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const config = await res.json();
    expect(config).toHaveProperty('name', 'config');
    expect(config.entries).toHaveProperty('maxClans');
  });

  it('404s unknown paths as plain text', async () => {
    const missing = await fetch(`${base}/definitely-not-here`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/plain');
  });
});

describe('trust proxy', () => {
  it('parses hop counts as numbers and keeps address lists as strings', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('is off unless TRUST_PROXY is set', () => {
    vi.stubEnv('TRUST_PROXY', '');
    try {
      expect(createApp({ root, validToken: () => false }).get('trust proxy')).toBe(false);
      vi.stubEnv('TRUST_PROXY', '1');
      expect(createApp({ root, validToken: () => false }).get('trust proxy')).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
