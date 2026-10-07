// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// tools/assets/item-icons.ts
// Build step: the HUD's frameless icons. For every `<name>-out.png` in the
// sprite folders it writes dist/client/icons/<name>.png with the old
// button frame taken off (button-frame.ts), or an untouched copy when the
// sprite has no frame to take off. The client asks for /icons/<name>.png
// (itemIconUrl); the source sprites stay as they are for anything still drawing them.
// Outputs newer than their source are kept, so a rebuild only redoes changes.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stripButtonFrame } from './button-frame';
import { decodePng, encodePng } from './png';
import { SPRITE_DIRS } from './sprite-manifest';

export interface IconBuildResult {
  stripped: number;
  copied: number;
  unchanged: number;
}

/** The first folder holding a sprite name wins, as in the sprite manifest. */
export function buildItemIcons(imgDirs = SPRITE_DIRS, outDir = 'dist/client/icons'): IconBuildResult {
  mkdirSync(outDir, { recursive: true });
  const result: IconBuildResult = { stripped: 0, copied: 0, unchanged: 0 };
  const seen = new Set<string>();
  const sources = imgDirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).map((file) => ({ dir, file })));
  for (const { dir, file } of sources) {
    if (!file.endsWith('-out.png') || seen.has(file)) continue;
    seen.add(file);
    const src = join(dir, file);
    const dest = join(outDir, `${file.slice(0, -'-out.png'.length)}.png`);
    try {
      if (statSync(dest).mtimeMs >= statSync(src).mtimeMs) {
        result.unchanged++;
        continue;
      }
    } catch {
      // Not built yet.
    }
    let stripped: Buffer | null = null;
    try {
      const icon = stripButtonFrame(decodePng(readFileSync(src)));
      if (icon) stripped = encodePng(icon);
    } catch {
      // An encoding this decoder does not read: ship the sprite as it is.
    }
    if (stripped) {
      writeFileSync(dest, stripped);
      result.stripped++;
    } else {
      copyFileSync(src, dest);
      result.copied++;
    }
  }
  return result;
}
