// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Runs the C++ exporter and the TS exporter over the same XML and compares `attributes`
// and `entries` table by table (parsed values, so number formatting cannot differ). Hashes
// are printed but not compared: each implementation hashes its own canonical text (D1.1).
//   npm run content:parity [-- --server dist/server/Release --xml <dir>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TABLE_FILES, XML_TABLES, type ContentTable } from '../../shared/typescript/content-format';
import { convertTable } from './xml-to-json';
import { readContentXml } from './read-content';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const serverDir = arg('--server', process.env.PREVAST_SERVER_DIR ?? 'dist/server/Release');
const xmlDir = arg('--xml', resolve('data/XML'));
const runtimeDir = arg('--runtime', resolve('runtime/development'));
const outDir = mkdtempSync(join(tmpdir(), 'prevast-export-'));

const run = spawnSync(resolve(serverDir, 'prevast_server.exe'), ['--export-content', outDir], { cwd: runtimeDir, encoding: 'utf8' });
process.stdout.write(run.stdout);
if (run.status !== 0) {
  console.error(run.stderr || `exporter exited ${run.status}`);
  process.exit(1);
}

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`;
    for (const k of ka) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`; // === so 0 and -0 agree
}

let failed = false;
for (const table of XML_TABLES) {
  const cpp = JSON.parse(readFileSync(join(outDir, `${table}.json`), 'utf8')) as ContentTable;
  const ts = convertTable(readContentXml(join(xmlDir, TABLE_FILES[table].file)), table);
  const diff = firstDifference({ attributes: cpp.attributes, entries: cpp.entries }, { attributes: ts.attributes, entries: ts.entries }, table);
  if (diff) {
    failed = true;
    console.error(`DIFFERS ${diff}`);
  } else console.log(`${table}: equal (${Object.keys(ts.entries).length} entries; hashes cpp ${cpp.hash} ts ${ts.hash})`);
}
process.exit(failed ? 1 : 0);
