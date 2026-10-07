// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Export authored XML into generated browser startup content in dist/content.
// Test snapshots under tests/fixtures are updated only deliberately.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TABLE_FILES,
  XML_TABLES,
  type ContentTable,
  type ContentValue,
} from '../../shared/typescript/content-format';
import { validateTable } from '../../shared/typescript/content-schema';
import { buildConfigTable } from './config-table';
import { convertTable } from './xml-to-json';
import { readContentXml } from './read-content';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

export function exportAll(
  xmlDir: string,
  configLua: string,
  outDir: string,
): Record<string, ContentTable<ContentValue>> {
  const tables: Record<string, ContentTable<ContentValue>> = {};
  for (const table of XML_TABLES) {
    const converted = convertTable(
      readContentXml(join(xmlDir, TABLE_FILES[table].file)),
      table,
    );
    tables[table] = validateTable(table, converted);
  }
  tables.config = buildConfigTable({
    configLua: readFileSync(configLua, 'utf8'),
    modes: validateTable('modes', tables.modes),
  });
  mkdirSync(outDir, { recursive: true });
  for (const [name, table] of Object.entries(tables)) {
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(table, null, 2)}\n`);
    console.log(`${name}: ${Object.keys(table.entries).length} entries, hash ${table.hash}`);
  }
  return tables;
}

if (process.argv[1]?.endsWith('export-content.ts')) {
  exportAll(
    arg('--xml', process.env.PREVAST_SERVER_XML ?? 'data/XML'),
    arg('--config', process.env.PREVAST_SERVER_CONFIG ?? 'config/development.lua'),
    arg('--out', 'dist/content'),
  );
}
