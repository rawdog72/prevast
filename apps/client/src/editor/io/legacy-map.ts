// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Converter for the old editor's map code (`!b=` records, optionally in a .map file with
// `key = ...` / `origin = x,y` header lines) and for structures.xml templates. The old
// format can only say "this item on this tile at this rotation", so the result is plain
// placements: nothing about groups, overrides or gameplay is inferred. The record format is
// documented in apps/server/src/world/mapimport.h.
import { tileCentre, type ScenarioEntity } from '../../../../../shared/typescript/scenario-schema';
import type { ContentStore } from '../../content/store';
import type { EditorCatalog } from '../catalog/catalog';
import type { Fragment } from '../document/ops';
import { cellKey, footprint, slotOf } from '../document/spatial';

export interface LegacyHeader {
  key?: string;
  origin?: { x: number; y: number };
  respawnMs?: number;
  mode?: string;
}

export interface LegacyImport {
  fragment: Fragment;
  header: LegacyHeader;
  accepted: number;
  malformed: number;
  unknownItems: Map<string, number>;
  overlaps: number;
}

interface LegacyRecord {
  itemId: number;
  subtype?: number;
  tx: number;
  ty: number;
  rotation: number;
}

function parseHeader(line: string, header: LegacyHeader): void {
  const sep = line.search(/[=:]/);
  if (sep < 0) return;
  const k = line.slice(0, sep).trim().toLowerCase();
  const v = line.slice(sep + 1).trim();
  if (k === 'key') header.key = v;
  else if (k === 'origin') {
    const [x, y] = v.split(',').map((n) => Number.parseInt(n, 10));
    if (Number.isInteger(x) && Number.isInteger(y)) header.origin = { x: x!, y: y! };
  } else if (k === 'respawn') header.respawnMs = v === 'off' || v === 'never' ? 0 : Number.parseInt(v, 10) || 0;
  else if (k === 'mode') header.mode = v;
}

/** Parses records; 4 fields = item:x:y:rot, 5 fields = item:subtype:x:y:rot. */
export function parseLegacyCode(code: string): { records: LegacyRecord[]; header: LegacyHeader; malformed: number } {
  const header: LegacyHeader = {};
  const records: LegacyRecord[] = [];
  let malformed = 0;
  let body = '';
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('!')) body += line;
    else parseHeader(line, header);
  }
  for (const piece of body.split('!')) {
    const text = piece.trim();
    if (!text.startsWith('b=')) continue;
    const fields = text.slice(2).split(':').map((f) => (/^\d+$/.test(f.trim()) ? Number(f.trim()) : Number.NaN));
    if ((fields.length !== 4 && fields.length !== 5) || fields.some((f) => !Number.isInteger(f))) {
      malformed++;
      continue;
    }
    const five = fields.length === 5;
    const [itemId, a, b, c, d] = fields as number[];
    const rotation = (five ? d : c)!;
    if (itemId! <= 0 || rotation > 3) {
      malformed++;
      continue;
    }
    records.push({
      itemId: itemId!,
      subtype: five ? a : undefined,
      tx: (five ? b : a)!,
      ty: (five ? c : b)!,
      rotation,
    });
  }
  return { records, header, malformed };
}

/**
 * Resolves records to placements relative to (0, 0). Unknown item ids are counted per id
 * (never silently substituted); a record landing on an already-filled slot is dropped and
 * counted, as the server's importer would refuse it too.
 */
export function convertLegacy(code: string, content: ContentStore, catalog: EditorCatalog): LegacyImport {
  const { records, header, malformed } = parseLegacyCode(code);
  const unknownItems = new Map<string, number>();
  const entities: ScenarioEntity[] = [];
  const claimed = new Set<string>();
  let overlaps = 0;
  let maxX = 0;
  let maxY = 0;
  let n = 0;
  for (const r of records) {
    const object =
      (r.subtype !== undefined ? content.objectForItem(r.itemId, r.subtype) : undefined) ??
      content.objectForItem(r.itemId, 0);
    const variantCarrier = object?.key === 'road';
    const entry = object
      ? catalog.resolve('object', object.key, variantCarrier ? r.subtype ?? 0 : undefined)
      : undefined;
    if (!object || !entry) {
      const label = r.subtype !== undefined ? `${r.itemId}:${r.subtype}` : String(r.itemId);
      unknownItems.set(label, (unknownItems.get(label) ?? 0) + 1);
      continue;
    }
    const entity: ScenarioEntity = {
      id: `legacy${++n}`,
      kind: 'object',
      ref: object.key,
      x: tileCentre(r.tx),
      y: tileCentre(r.ty),
      rotation: entry.rotatable ? r.rotation : 0,
    };
    if (variantCarrier) entity.variant = r.subtype ?? 0;
    const cells = footprint(entity, entry);
    const slot = slotOf(entry);
    if (cells.some(([tx, ty]) => claimed.has(`${slot}:${cellKey(tx, ty)}`))) {
      overlaps++;
      continue;
    }
    for (const [tx, ty] of cells) {
      claimed.add(`${slot}:${cellKey(tx, ty)}`);
      maxX = Math.max(maxX, tx);
      maxY = Math.max(maxY, ty);
    }
    entities.push(entity);
  }
  return {
    fragment: { entities, groups: [], regions: [], size: { w: maxX + 1, h: maxY + 1 } },
    header,
    accepted: entities.length,
    malformed,
    unknownItems,
    overlaps,
  };
}

/** structures.xml templates (house0, city0, ...) as fragments, keyed by structure key. */
export function legacyStructures(content: ContentStore, catalog: EditorCatalog): { key: string; result: LegacyImport }[] {
  if (!content.has('structures')) return [];
  const out: { key: string; result: LegacyImport }[] = [];
  for (const s of Object.values(content.table('structures'))) {
    const text = s.code?.text;
    if (!text) continue;
    const result = convertLegacy(text, content, catalog);
    if (s.width && s.height)
      result.fragment.size = {
        w: Math.max(result.fragment.size.w, s.width),
        h: Math.max(result.fragment.size.h, s.height),
      };
    out.push({ key: s.key, result });
  }
  return out;
}

export function describeImport(result: LegacyImport): string {
  const parts = [`${result.accepted} pieces`];
  if (result.malformed) parts.push(`${result.malformed} malformed records skipped`);
  if (result.overlaps) parts.push(`${result.overlaps} overlapping records dropped`);
  if (result.unknownItems.size)
    parts.push(
      `unknown items ${[...result.unknownItems].map(([id, count]) => `${id}×${count}`).join(', ')} skipped`,
    );
  return parts.join('; ');
}
