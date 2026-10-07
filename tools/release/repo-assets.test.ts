// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Part of `npm run check`: no original Devast.io asset may be committed, under
// any name. The full release audit is `npm run release:audit`.

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ORIGINAL_ASSETS_DIR, readManifest } from '../assets/original-assets';
import { findOriginalAssets, listTrackedFiles } from './audit';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = listTrackedFiles(root);

describe('repository', () => {
  it.skipIf(files === null)('commits none of the original assets', () => {
    const manifest = readManifest(`${root}${ORIGINAL_ASSETS_DIR}`);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(4000);
    expect(findOriginalAssets(root, files!, manifest)).toEqual([]);
  });
});
