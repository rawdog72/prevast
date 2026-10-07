// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Builds dist/client/sprite-manifest.json from the sprite folders: for every PNG its
// pixel size and a short content hash. The client uses the hash to version
// sprite URLs (`/img/<name>.png?v=<hash>`), which the host serves with an
// immutable one-year cache, and the name list to skip sprites that do not
// exist instead of requesting a 404 for each one.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The project's own art first, then the user's original copy; the first folder holding a name wins. */
export const SPRITE_DIRS = ['apps/client/public/img', 'original-assets/img'];

export interface SpriteEntry {
  w: number;
  h: number;
  v: string;
}

export function buildSpriteManifest(imgDirs = SPRITE_DIRS, outFile = 'dist/client/sprite-manifest.json'): number {
  const manifest: Record<string, SpriteEntry> = {};
  for (const dir of imgDirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const name = file.slice(0, -4);
      if (!file.endsWith('.png') || name in manifest) continue;
      const buf = readFileSync(join(dir, file));
      // PNG: 8-byte signature, then the IHDR chunk with width/height at bytes 16..23.
      if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) continue;
      const v = createHash('sha1').update(buf).digest('hex').slice(0, 8);
      manifest[name] = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), v };
    }
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest));
  return Object.keys(manifest).length;
}
