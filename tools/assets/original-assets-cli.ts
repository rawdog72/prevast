// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// npm run assets:check [-- --strict]   compare original-assets/ with its manifest
// npm run assets:manifest              rewrite the manifest from original-assets/
//
// A partial or missing copy is not an error: the game runs with blanks where
// sprites are missing. --strict exits 1 unless every file matches.

import { buildManifest, checkOriginalAssets, ORIGINAL_ASSETS_DIR, readManifest, writeManifest } from './original-assets';

const [command = 'check', ...flags] = process.argv.slice(2);

if (command === 'manifest') {
  const manifest = buildManifest();
  writeManifest(manifest);
  console.log(`${ORIGINAL_ASSETS_DIR}/manifest.json: ${Object.keys(manifest.files).length} files`);
} else if (command === 'check') {
  const manifest = readManifest();
  const total = Object.keys(manifest.files).length;
  const result = checkOriginalAssets(manifest);
  console.log(`original assets: ${result.matching} of ${total} present and matching`);
  const list = (label: string, files: string[]) => {
    if (files.length === 0) return;
    console.log(`${files.length} ${label}:`);
    for (const file of files.slice(0, 20)) console.log(`  ${file}`);
    if (files.length > 20) console.log(`  ... and ${files.length - 20} more`);
  };
  list('missing', result.missing);
  list('different from the expected version', result.changed);
  if (result.matching < total) console.log(`See ${ORIGINAL_ASSETS_DIR}/README.md for where these files go.`);
  if (flags.includes('--strict') && result.matching < total) process.exit(1);
} else {
  console.error(`Unknown command "${command}". Use "check" or "manifest".`);
  process.exit(2);
}
