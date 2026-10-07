// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The original Devast.io images and sounds are not part of this repository.
// Each person copies their own into original-assets/img and original-assets/audio;
// original-assets/manifest.json names every file the project expects, with its
// size and SHA-256, so a copy can be checked without the files ever being
// committed. The web host serves the folder after the project's own art.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ORIGINAL_ASSETS_DIR = 'original-assets';
export const ASSET_FOLDERS = ['img', 'audio'] as const;

export interface ManifestEntry {
  size: number;
  sha256: string;
}

export interface AssetManifest {
  version: 1;
  /** Keyed by path relative to original-assets, with forward slashes: `img/wood.png`. */
  files: Record<string, ManifestEntry>;
}

export interface AssetCheck {
  /** Files that exist and match the manifest. */
  matching: number;
  missing: string[];
  changed: string[];
}

export function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listFiles(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function buildManifest(dir: string = ORIGINAL_ASSETS_DIR): AssetManifest {
  const files: Record<string, ManifestEntry> = {};
  const paths = ASSET_FOLDERS.flatMap((folder) => listFiles(join(dir, folder), folder)).sort();
  for (const rel of paths) {
    const file = join(dir, rel);
    files[rel] = { size: statSync(file).size, sha256: sha256File(file) };
  }
  return { version: 1, files };
}

export function readManifest(dir: string = ORIGINAL_ASSETS_DIR): AssetManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
}

export function writeManifest(manifest: AssetManifest, dir: string = ORIGINAL_ASSETS_DIR): void {
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
}

/** Compares a folder against the manifest: what matches, what is missing, what differs. */
export function checkOriginalAssets(manifest: AssetManifest, dir: string = ORIGINAL_ASSETS_DIR): AssetCheck {
  const result: AssetCheck = { matching: 0, missing: [], changed: [] };
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = join(dir, rel);
    if (!existsSync(file)) {
      result.missing.push(rel);
      continue;
    }
    // Size first: a different size never needs the hash.
    if (statSync(file).size !== expected.size || sha256File(file) !== expected.sha256) result.changed.push(rel);
    else result.matching++;
  }
  return result;
}
