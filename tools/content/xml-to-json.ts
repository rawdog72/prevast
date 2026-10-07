// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Generic XML -> JSON, the TypeScript half of the exporter pair. The C++ half is
// apps/server/src/content/contentexport.cpp; tools/content-parity.ts keeps them equal.
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import {
  ARRAY_PAIRS,
  ID_ATTRIBUTE,
  NON_INHERITED_ATTRIBUTES,
  TABLE_FILES,
  parseScalar,
  tableHash,
  type ContentEntry,
  type ContentObject,
  type ContentTable,
  type Scalar,
  type XmlTableName,
} from '../../shared/typescript/content-format';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;

export interface RawEntry {
  key: string;
  abstract: boolean;
  base?: string;
  object: ContentObject;
}

export function parseXml(text: string, fileName: string): Document {
  const parser = new DOMParser({
    onError: (level, message) => {
      throw new Error(`${fileName}: ${level}: ${message}`);
    },
  });
  return parser.parseFromString(text, 'text/xml');
}

function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes.item(i);
    if (node && node.nodeType === ELEMENT_NODE) out.push(node as Element);
  }
  return out;
}

function ownAttributes(el: Element): Record<string, Scalar> {
  const out: Record<string, Scalar> = Object.create(null);
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes.item(i);
    if (attr) out[attr.name] = parseScalar(attr.name, attr.value);
  }
  return out;
}

export function elementToObject(el: Element, path: string): ContentObject {
  const out: ContentObject = ownAttributes(el);
  const groups = new Map<string, ContentObject[]>();
  let text = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes.item(i);
    if (!node) continue;
    if (node.nodeType === ELEMENT_NODE) {
      const child = node as Element;
      const list = groups.get(child.tagName) ?? [];
      list.push(elementToObject(child, `${path}/${child.tagName}`));
      groups.set(child.tagName, list);
    } else if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      text += node.nodeValue ?? '';
    }
  }
  for (const [tag, list] of groups) {
    const pair = `${el.tagName}>${tag}`;
    if (Object.hasOwn(out, tag)) throw new Error(`${path}: attribute/child collision '${tag}'`);
    if (ARRAY_PAIRS.has(pair)) out[tag] = list;
    else if (list.length === 1) out[tag] = list[0]!;
    else
      throw new Error(
        `${path}: <${tag}> occurs ${list.length}x under <${el.tagName}> but '${pair}' is not in ARRAY_PAIRS`,
      );
  }
  const trimmed = text.trim();
  if (trimmed) {
    if (Object.hasOwn(out, 'text')) throw new Error(`${path}: attribute/text collision`);
    out.text = trimmed;
  }
  return out;
}

export function resolveInheritance(
  raw: RawEntry[],
  fileName: string,
): Record<string, ContentEntry> {
  const resolved = new Map<string, ContentObject>();
  const out: Record<string, ContentEntry> = Object.create(null);
  for (const entry of raw) {
    let merged: ContentObject = { ...entry.object };
    if (entry.base !== undefined) {
      const base = resolved.get(entry.base);
      if (!base)
        throw new Error(
          `${fileName}: '${entry.key}' has base="${entry.base}" which is not declared above it`,
        );
      merged = Object.create(null);
      for (const [k, v] of Object.entries(base)) if (!NON_INHERITED_ATTRIBUTES.has(k)) merged[k] = v;
      for (const [k, v] of Object.entries(entry.object)) merged[k] = v;
    }
    delete merged.base;
    delete merged.abstract;
    resolved.set(entry.key, merged);
    if (entry.abstract) continue;
    if (Object.hasOwn(out, entry.key)) throw new Error(`${fileName}: duplicate key '${entry.key}'`);
    out[entry.key] = merged;
  }
  return out;
}

export function convertTable(
  xmlText: string,
  table: XmlTableName,
  fileName: string = TABLE_FILES[table].file,
): ContentTable {
  const { root: rootName, entry: entryName } = TABLE_FILES[table];
  const doc = parseXml(xmlText, fileName);
  const root = doc.documentElement;
  if (!root || root.tagName !== rootName)
    throw new Error(`${fileName}: expected <${rootName}> root, got <${root?.tagName ?? 'nothing'}>`);

  const attributes = ownAttributes(root);
  const raw: RawEntry[] = [];
  let index = 0;
  for (const child of elementChildren(root)) {
    if (child.tagName !== entryName) continue;
    // Only public appearance enters the content cache. Shop rolls, dialogue,
    // scripts, spawn positions and quest rewards stay on the server.
    const publicNode = table === 'npcs' ? child.cloneNode(false) as Element
      : table === 'stats' || table === 'achievements' ? child.cloneNode(true) as Element : child;
    if (table === 'npcs') {
      for (const attribute of Array.from({ length: publicNode.attributes.length }, (_, i) => publicNode.attributes.item(i)!.name))
        if (!['key', 'id', 'name', 'rangeTiles'].includes(attribute)) publicNode.removeAttribute(attribute);
      for (const section of elementChildren(child)) if (section.tagName === 'client') publicNode.appendChild(section.cloneNode(true));
    }
    // Stats keep no <count> rules; a secret achievement keeps nothing but its identity.
    if (table === 'stats' || table === 'achievements') {
      const secret = table === 'achievements' && child.getAttribute('secret') === 'true';
      if (table === 'stats' || secret) for (const section of [...elementChildren(publicNode)]) publicNode.removeChild(section);
      if (secret) for (const attribute of ['name', 'description']) publicNode.removeAttribute(attribute);
    }
    const object = elementToObject(publicNode, `${fileName}/${entryName}[${index}]`);
    if (table !== 'kits' && (typeof object.key !== 'string' || object.key.length === 0))
      throw new Error(`${fileName}: ${entryName}[${index}] is missing key`);
    raw.push({
      key: typeof object.key === 'string' ? object.key : String(index),
      abstract: object.abstract === true,
      base: typeof object.base === 'string' ? object.base : undefined,
      object,
    });
    index++;
  }

  const entries = resolveInheritance(raw, fileName);
  const idAttribute = ID_ATTRIBUTE[table];
  if (idAttribute) {
    for (const [key, entry] of Object.entries(entries)) {
      const id = entry[idAttribute];
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0)
        throw new Error(`${fileName}: entry '${key}' has no numeric ${idAttribute}`);
      entry.id = id;
    }
  }
  return { name: table, version: 1, hash: tableHash(attributes, entries), attributes, entries };
}
