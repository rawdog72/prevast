// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readContentXml } from './read-content';
import { convertTable } from './xml-to-json';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(index: string, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prevast-content-'));
  temporary.push(root);
  mkdirSync(join(root, 'data/XML'), { recursive: true });
  const file = join(root, 'data/XML/agents.xml');
  writeFileSync(file, index);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return file;
}
describe('modular content files', () => {
  it('preserves ordered inheritance and public identifiers', () => {
    const file = fixture('<agents limit="20"><include file="../agents/base.xml"/><include file="../agents/fast.xml"/></agents>', {
      'data/agents/base.xml': '<agent key="base" abstract="true"><body radius="28"/></agent>',
      'data/agents/fast.xml': '<agent key="fast" base="base" sprite="1"><movement speed="60"/></agent>',
    });
    const table = convertTable(readContentXml(file), 'agents');
    expect(table.attributes.limit).toBe(20);
    expect(table.entries.fast).toMatchObject({ id: 1, body: { radius: 28 }, movement: { speed: 60 } });
  });
  it('rejects missing, duplicate, wrong-root, nested and escaping includes', () => {
    const files = { 'data/agents/good.xml': '<agent key="a" sprite="1"/>', 'data/agents/wrong.xml': '<npc/>', 'data/agents/nested.xml': '<agent><include file="good.xml"/></agent>', 'outside.xml': '<agent/>' };
    for (const includes of [
      '<include file="../agents/missing.xml"/>',
      '<include file="../agents/good.xml"/><include file="../agents/good.xml"/>',
      '<include file="../agents/wrong.xml"/>',
      '<include file="../agents/nested.xml"/>',
      '<include file="../../outside.xml"/>',
    ]) expect(() => readContentXml(fixture(`<agents>${includes}</agents>`, files))).toThrow();
  });
  it('keeps private NPC data out of expanded public exports', () => {
    const file = fixture('<npcs><include file="../npc/mara.xml"/></npcs>', {
      'data/npc/mara.xml': '<npc key="merchant" id="1" name="Mara" script="secret.lua"><client head="h"/><shop restockSeconds="60"><offer key="x"/></shop></npc>',
    });
    expect(convertTable(readContentXml(file), 'npcs').entries.merchant).toEqual({ key: 'merchant', id: 1, name: 'Mara', client: { head: 'h' } });
  });
});
