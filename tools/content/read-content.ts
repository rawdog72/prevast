// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { XMLSerializer, type Element } from '@xmldom/xmldom';
import { parseXml } from './xml-to-json';

/** Expand the same ordered, single-definition includes as content_files.h. */
export function readContentXml(file: string, includedFiles?: string[]): string {
  const doc = parseXml(readFileSync(file, 'utf8'), file);
  const root = doc.documentElement!;
  const entry = ({ npcs: 'npc', agents: 'agent' } as Record<string, string>)[root.tagName];
  const directory = realpathSync(dirname(file));
  const data = dirname(directory);
  const loaded = new Set<string>();
  let bytes = 0;
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1 || (child as Element).tagName !== 'include') continue;
    if (!entry) throw new Error(`${file}: includes are not supported for this table`);
    const name = (child as Element).getAttribute('file') ?? '';
    if (!name || isAbsolute(name) || /^[A-Za-z]:/.test(name) || extname(name) !== '.xml')
      throw new Error(`${file}: include requires a relative XML path`);
    const path = realpathSync(resolve(directory, name));
    const within = relative(data, path);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error(`${file}: include escapes the data directory`);
    const stat = statSync(path);
    if (!stat.isFile() || loaded.has(path) || loaded.size >= 256 || stat.size > 1024 * 1024 || (bytes += stat.size) > 4 * 1024 * 1024)
      throw new Error(`${file}: duplicate or oversized include`);
    loaded.add(path);
    includedFiles?.push(path);
    const definition = parseXml(readFileSync(path, 'utf8'), path);
    if (definition.documentElement?.tagName !== entry || definition.getElementsByTagName('include').length)
      throw new Error(`${path}: expected one <${entry}> definition without includes`);
    root.insertBefore(doc.importNode(definition.documentElement, true), child);
    root.removeChild(child);
  }
  return new XMLSerializer().serializeToString(doc);
}
