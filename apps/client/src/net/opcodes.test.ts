// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClientOpcode, PROTOCOL_VERSION, ServerOpcode } from './opcodes';

// The C++ header is the reference; this file must say exactly the same thing.
const header = readFileSync('apps/server/src/network/opcodes.h', 'utf8');
const definitions = readFileSync('apps/server/src/core/definitions.h', 'utf8');

function cppEnum(name: string): Record<string, number> {
  const start = header.indexOf(`enum class ${name} : uint8_t {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = header.slice(start, header.indexOf('};', start));
  const out: Record<string, number> = {};
  for (const [, key, value] of body.matchAll(/^\s+([A-Z][A-Z_0-9]*) = (\d+),/gm)) out[key!] = Number(value);
  return out;
}

describe('opcodes', () => {
  it('match the C++ ClientOpcode enum name for name and number', () => {
    expect({ ...ClientOpcode }).toEqual(cppEnum('ClientOpcode'));
  });

  it('match the C++ ServerOpcode enum name for name and number', () => {
    expect({ ...ServerOpcode }).toEqual(cppEnum('ServerOpcode'));
  });

  it('give every opcode its own number in each direction', () => {
    for (const table of [ClientOpcode, ServerOpcode]) {
      const values = Object.values(table);
      expect(new Set(values).size).toBe(values.length);
      expect(Math.max(...values)).toBeLessThan(256);
    }
  });

  it('use the protocol version the server accepts', () => {
    expect(definitions).toContain(`CLIENT_VERSION_MIN = ${PROTOCOL_VERSION};`);
    expect(definitions).toContain(`CLIENT_VERSION_MAX = ${PROTOCOL_VERSION};`);
  });
});
