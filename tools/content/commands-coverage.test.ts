// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// tools/content/commands-coverage.test.ts
// data/XML/commands.xml must name exactly the commands game_admin.cpp
// dispatches: a missing one would silently need the highest rank, a stale
// one documents a command that does not exist.
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';

const source = readFileSync('apps/server/src/gameplay/game_admin.cpp', 'utf8');
const dispatched = new Set([...source.matchAll(/cmd == "([^"]+)"/g)].map((m) => m[1]!));
const doc = new DOMParser().parseFromString(readFileSync('data/XML/commands.xml', 'utf8'), 'text/xml');
const listed = new Set<string>();
for (const node of Array.from(doc.getElementsByTagName('command'))) {
  listed.add(node.getAttribute('name') ?? '');
  for (const alias of (node.getAttribute('aliases') ?? '').split(/\s+/).filter(Boolean)) listed.add(alias);
}

describe('commands.xml', () => {
  it('lists every command game_admin.cpp dispatches', () => {
    expect([...dispatched].filter((c) => !listed.has(c))).toEqual([]);
  });
  it('lists nothing game_admin.cpp does not dispatch', () => {
    expect([...listed].filter((c) => !dispatched.has(c))).toEqual([]);
  });
});
