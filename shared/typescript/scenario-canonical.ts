// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Canonical form and hashes of a scenario project. The rule, which the C++ compiler must
// reproduce byte for byte (fixtures in tests/fixtures/scenarios/canonical):
//
//   * object keys sorted by UTF-16 code unit order, no whitespace, JSON string escaping as
//     JSON.stringify does it;
//   * every number is an integer and is written in plain decimal;
//   * `entities`, `groups`, `regions`, `templates` and `lootTables` arrays (and a template's own lists) are
//     sorted by `id`, since their order carries no meaning;
//   * the gameplay view drops `editor`, `title`, `revision`, `nextId` and `content`: authoring
//     state that cannot change what a server runs.
//
// The hash is SHA-256 over the UTF-8 bytes of the canonical text, lowercase hex.
import type { ScenarioProject } from './scenario-schema';

const ID_SORTED = new Set(['entities', 'groups', 'regions', 'templates', 'lootTables']);

function write(value: unknown, key: string | null, out: string[]): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonical form cannot hold ${value}`);
    out.push(Number.isInteger(value) ? String(value) : JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    let items: readonly unknown[] = value;
    if (key !== null && ID_SORTED.has(key))
      items = [...value].sort((a, b) => compare((a as { id: string }).id, (b as { id: string }).id));
    out.push('[');
    items.forEach((item, i) => {
      if (i) out.push(',');
      write(item, null, out);
    });
    out.push(']');
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compare(a, b));
    out.push('{');
    entries.forEach(([k, v], i) => {
      if (i) out.push(',');
      out.push(JSON.stringify(k), ':');
      write(v, k, out);
    });
    out.push('}');
    return;
  }
  throw new Error(`canonical form cannot hold a ${typeof value}`);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, null, out);
  return out.join('');
}

/** The part of a project that can change what a server runs. */
export function gameplayView(project: ScenarioProject): Record<string, unknown> {
  return {
    format: project.format,
    schemaVersion: project.schemaVersion,
    id: project.id,
    requiredFeatures: [...project.requiredFeatures].sort(),
    world: project.world,
    entities: project.entities,
    groups: project.groups,
    regions: project.regions,
    templates: project.templates,
    lootTables: project.lootTables,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Identifies exactly what would run: equal hashes, equal gameplay. */
export function gameplayHash(project: ScenarioProject): Promise<string> {
  return sha256Hex(canonicalJson(gameplayView(project)));
}
