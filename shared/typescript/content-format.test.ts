// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  ARRAY_PAIRS,
  canonicalJson,
  fnv1a64,
  isNameAttribute,
  parseScalar,
  tableHash,
} from './content-format';

describe('parseScalar', () => {
  it('types booleans, numbers and strings by pattern', () => {
    expect(parseScalar('collision', 'true')).toBe(true);
    expect(parseScalar('stack', '255')).toBe(255);
    expect(parseScalar('multiplier', '0.00085')).toBe(0.00085);
    expect(parseScalar('x', '-80')).toBe(-80);
    expect(parseScalar('x', '+5')).toBe(5);
    expect(parseScalar('x', '.5')).toBe(0.5);
    expect(parseScalar('x', '1e3')).toBe(1000);
    expect(parseScalar('ratesMs', '500,1000')).toBe('500,1000');
    expect(parseScalar('key', '9mm_bullet')).toBe('9mm_bullet');
    expect(parseScalar('name', '762 Round')).toBe('762 Round');
    expect(parseScalar('x', '0.0.1')).toBe('0.0.1');
  });
  it('never types name attributes', () => {
    expect(parseScalar('key', '12')).toBe('12');
    expect(parseScalar('itemKey', '12')).toBe('12');
    expect(isNameAttribute('produceItemKey')).toBe(true);
    expect(isNameAttribute('Key')).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('fnv1a64', () => {
  it('matches the reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
  it('hashes tables over their canonical form', () => {
    const h = tableHash({}, { wood: { id: 1, key: 'wood' } });
    expect(h).toBe(fnv1a64('{"attributes":{},"entries":{"wood":{"id":1,"key":"wood"}}}'));
  });
});

describe('ARRAY_PAIRS', () => {
  it('names parent>child pairs, never bare tags', () => {
    for (const pair of ARRAY_PAIRS) expect(pair).toMatch(/^[A-Za-z]+>[A-Za-z]+$/);
    expect(ARRAY_PAIRS.has('stations>station')).toBe(true);
    expect(ARRAY_PAIRS.has('object>station')).toBe(false);
  });
});
