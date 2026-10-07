// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, checkOriginalAssets, readManifest, sha256File, writeManifest } from './original-assets';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'original-assets-'));
  mkdirSync(join(dir, 'img'));
  mkdirSync(join(dir, 'audio'));
  writeFileSync(join(dir, 'img', 'wood.png'), 'wood');
  writeFileSync(join(dir, 'audio', 'craft.mp3'), 'craft!');
  writeFileSync(join(dir, 'README.md'), 'not an asset');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildManifest', () => {
  it('lists every file under img/ and audio/ with its size and hash, keyed by forward-slash path', () => {
    const manifest = buildManifest(dir);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.files)).toEqual(['audio/craft.mp3', 'img/wood.png']);
    expect(manifest.files['img/wood.png']).toEqual({ size: 4, sha256: sha256File(join(dir, 'img', 'wood.png')) });
  });

  it('round-trips through manifest.json', () => {
    writeManifest(buildManifest(dir), dir);
    expect(readManifest(dir)).toEqual(buildManifest(dir));
  });
});

describe('checkOriginalAssets', () => {
  it('reports nothing wrong when every file is present and unchanged', () => {
    const manifest = buildManifest(dir);
    expect(checkOriginalAssets(manifest, dir)).toEqual({ matching: 2, missing: [], changed: [] });
  });

  it('reports missing and changed files', () => {
    const manifest = buildManifest(dir);
    rmSync(join(dir, 'audio', 'craft.mp3'));
    writeFileSync(join(dir, 'img', 'wood.png'), 'other wood');
    expect(checkOriginalAssets(manifest, dir)).toEqual({
      matching: 0,
      missing: ['audio/craft.mp3'],
      changed: ['img/wood.png'],
    });
  });

  it('treats a folder that does not exist as every file missing', () => {
    const manifest = buildManifest(dir);
    expect(checkOriginalAssets(manifest, join(dir, 'nowhere')).missing).toHaveLength(2);
  });
});
