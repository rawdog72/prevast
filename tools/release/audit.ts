// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// What must never reach the public repository: copies of the original
// Devast.io assets (matched by content, so a renamed copy is caught too),
// absolute paths from someone's machine, private session links, this
// project's old name, and the files kept only in the private archive.
// `npm run release:audit` runs every check over the tracked files; the
// asset check also runs in `npm run check` (repo-assets.test.ts).

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type AssetManifest, sha256File } from '../assets/original-assets';

export interface AuditFinding {
  check: string;
  file: string;
  detail: string;
}

const ASSET_FOLDER_FILES = new Set(['original-assets/README.md', 'original-assets/manifest.json']);

/** Tracked files (forward slashes), or null outside a Git checkout. */
export function listTrackedFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

export function findOriginalAssets(root: string, files: string[], manifest: AssetManifest): AuditFinding[] {
  const bySize = new Map<number, Map<string, string>>();
  for (const [rel, { size, sha256 }] of Object.entries(manifest.files)) {
    if (!bySize.has(size)) bySize.set(size, new Map());
    bySize.get(size)!.set(sha256, rel);
  }
  const findings: AuditFinding[] = [];
  for (const file of files) {
    if (ASSET_FOLDER_FILES.has(file)) continue;
    if (file.startsWith('original-assets/')) {
      findings.push({ check: 'original-asset', file, detail: 'original-assets/ holds the user\'s own copy and is never committed' });
      continue;
    }
    const path = join(root, file);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // Deleted in the working tree.
    }
    const original = bySize.get(size)?.get(sha256File(path));
    if (original) findings.push({ check: 'original-asset', file, detail: `same content as original ${original}` });
  }
  return findings;
}

function lineFindings(check: string, file: string, text: string, match: (line: string) => boolean): AuditFinding[] {
  const findings: AuditFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (match(line)) findings.push({ check, file, detail: `line ${i + 1}: ${line.trim().slice(0, 160)}` });
  });
  return findings;
}

const WINDOWS_PATH = /(?<![A-Za-z0-9\]])[A-Za-z]:\\[A-Za-z0-9_.$-]/;
const UNIX_HOME = /(?:^|[\s'"`(=])\/(?:Users|home)\/[A-Za-z]/;

export function findLocalPaths(file: string, text: string): AuditFinding[] {
  return lineFindings('local-path', file, text, (line) => WINDOWS_PATH.test(line) || UNIX_HOME.test(line));
}

export function findSessionLinks(file: string, text: string): AuditFinding[] {
  return lineFindings('session-link', file, text, (line) => line.includes('claude.ai/code/session'));
}

// The original game is named as Devast.io; its sprite files keep their names;
// scenario files saved before the rename still load.
const ALLOWED_DEVAST = [/Devast\.io/g, /devaster\d/gi, /['"`]devast-(?:scenario|template)['"`]/g, /\.devast\.json/g];

export function findDevastNames(file: string, text: string): AuditFinding[] {
  return lineFindings('old-name', file, text, (line) => {
    let rest = line;
    for (const allowed of ALLOWED_DEVAST) rest = rest.replace(allowed, '');
    return /devast/i.test(rest);
  });
}

const PRIVATE_PREFIXES = [
  'docs/archive/',
  'docs/superpowers/',
  'docs/plans/',
  '.superpowers/',
  'tools/migrations/',
  'tests/fixtures/legacy/',
];
const PRIVATE_FILES = new Set([
  'docs/HANDOFF.md',
  'docs/migration.md',
  'docs/migration-file-map.json',
  'docs/verification.md',
  'docs/dependencies-local.txt',
  'devast.code-workspace',
]);

export function findPrivatePaths(files: string[]): AuditFinding[] {
  return files
    .filter((file) => PRIVATE_FILES.has(file) || PRIVATE_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .map((file) => ({ check: 'private-path', file, detail: 'kept in the private archive only' }));
}

// The audit's own sources and tests spell out what they look for.
const TEXT_CHECK_EXEMPT = /^tools\/release\//;

export function auditRepo(root: string, files: string[], manifest: AssetManifest): AuditFinding[] {
  const findings = [...findOriginalAssets(root, files, manifest), ...findPrivatePaths(files)];
  for (const file of files) {
    if (TEXT_CHECK_EXEMPT.test(file) || file === 'original-assets/manifest.json') continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // Binary.
    const text = buf.toString('utf8');
    findings.push(...findLocalPaths(file, text), ...findSessionLinks(file, text), ...findDevastNames(file, text));
  }
  return findings;
}
