// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildItemIcons } from './item-icons';
import { encodePng } from './png';
import { buildSpriteManifest } from './sprite-manifest';

let root: string;
let ours: string;
let originals: string;

/** A solid w x h PNG; the colour tells the copies apart. */
function png(w: number, h: number, shade: number): Buffer {
  return encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(shade) });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprite-folders-'));
  ours = join(root, 'public-img');
  originals = join(root, 'original-img');
  mkdirSync(ours);
  mkdirSync(originals);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildSpriteManifest', () => {
  it('lists sprites from every folder, the first folder winning a shared name', () => {
    writeFileSync(join(ours, 'shared.png'), png(2, 2, 10));
    writeFileSync(join(originals, 'shared.png'), png(4, 4, 20));
    writeFileSync(join(originals, 'only-original.png'), png(3, 5, 30));
    const out = join(root, 'out', 'sprite-manifest.json');

    expect(buildSpriteManifest([ours, originals], out)).toBe(2);
    const manifest = JSON.parse(readFileSync(out, 'utf8'));
    expect(manifest.shared).toMatchObject({ w: 2, h: 2 });
    expect(manifest['only-original']).toMatchObject({ w: 3, h: 5 });
  });

  it('skips a folder that does not exist', () => {
    writeFileSync(join(ours, 'a.png'), png(1, 1, 0));
    const out = join(root, 'out', 'sprite-manifest.json');
    expect(buildSpriteManifest([ours, join(root, 'missing')], out)).toBe(1);
  });
});

describe('buildItemIcons', () => {
  it('builds icons from every folder, the first folder winning a shared name', () => {
    writeFileSync(join(ours, 'axe-out.png'), png(2, 2, 10));
    writeFileSync(join(originals, 'axe-out.png'), png(2, 2, 200));
    writeFileSync(join(originals, 'wood-out.png'), png(2, 2, 50));
    const outDir = join(root, 'icons');

    const result = buildItemIcons([ours, originals, join(root, 'missing')], outDir);
    expect(result.stripped + result.copied).toBe(2);
    expect(readFileSync(join(outDir, 'axe.png'))).toEqual(png(2, 2, 10));
    expect(readFileSync(join(outDir, 'wood.png'))).toEqual(png(2, 2, 50));
  });
});
