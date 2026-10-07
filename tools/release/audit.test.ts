// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../assets/original-assets';
import {
  findDevastNames,
  findLocalPaths,
  findOriginalAssets,
  findPrivatePaths,
  findSessionLinks,
} from './audit';

describe('findOriginalAssets', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-'));
    mkdirSync(join(root, 'original-assets', 'img'), { recursive: true });
    writeFileSync(join(root, 'original-assets', 'img', 'wood.png'), 'original wood');
    mkdirSync(join(root, 'apps'));
    writeFileSync(join(root, 'apps', 'renamed.png'), 'original wood');
    writeFileSync(join(root, 'apps', 'own.png'), 'our own art');
    writeFileSync(join(root, 'apps', 'same-size.png'), 'original food');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('flags a tracked copy of an original file under any name, by content', () => {
    const manifest = buildManifest(join(root, 'original-assets'));
    const files = ['apps/renamed.png', 'apps/own.png', 'apps/same-size.png'];
    expect(findOriginalAssets(root, files, manifest)).toEqual([
      { check: 'original-asset', file: 'apps/renamed.png', detail: 'same content as original img/wood.png' },
    ]);
  });

  it('flags anything tracked under original-assets/ except its README and manifest', () => {
    const manifest = buildManifest(join(root, 'original-assets'));
    const files = ['original-assets/README.md', 'original-assets/manifest.json', 'original-assets/img/wood.png'];
    expect(findOriginalAssets(root, files, manifest).map((f) => f.file)).toEqual(['original-assets/img/wood.png']);
  });
});

describe('text checks', () => {
  it('finds absolute local paths with their line numbers', () => {
    const text = 'ok line\nsee D:\\Projects\\thing\nand /Users/me/file\nregex /^[A-Za-z]:\\\\/ is fine';
    expect(findLocalPaths('a.md', text).map((f) => f.detail)).toEqual([
      'line 2: see D:\\Projects\\thing',
      'line 3: and /Users/me/file',
    ]);
  });

  it('finds private session links', () => {
    expect(findSessionLinks('a.txt', 'x https://claude.ai/code/session_016224 y')).toHaveLength(1);
    expect(findSessionLinks('a.txt', 'nothing here')).toEqual([]);
  });

  it('allows the original game name, original sprite names and the legacy scenario ids only', () => {
    const allowed = [
      'Works with Devast.io.',
      "sprite('devaster0out')",
      "const LEGACY_FORMAT = 'devast-scenario';",
      "'devast-template'",
      'old files end in .devast.json',
    ].join('\n');
    expect(findDevastNames('a.ts', allowed)).toEqual([]);
    expect(findDevastNames('a.cpp', 'constexpr auto LEGACY = "devast-scenario";')).toEqual([]);
    expect(findDevastNames('a.md', 'the earlier `devast-scenario` id')).toEqual([]);
    expect(findDevastNames('a.ts', "Devast Open Server\nlocalStorage 'devast.options'").map((f) => f.detail)).toEqual([
      'line 1: Devast Open Server',
      "line 2: localStorage 'devast.options'",
    ]);
  });
});

describe('findPrivatePaths', () => {
  it('flags files that stay in the private archive', () => {
    const files = [
      'docs/archive/old.md',
      'docs/superpowers/specs/x.md',
      'docs/plans/p.md',
      'tests/fixtures/legacy/client.js',
      'tools/migrations/migrate-client-tables.ts',
      'docs/HANDOFF.md',
      'devast.code-workspace',
      'docs/architecture.md',
    ];
    expect(findPrivatePaths(files).map((f) => f.file)).toEqual(files.slice(0, -1));
  });
});
