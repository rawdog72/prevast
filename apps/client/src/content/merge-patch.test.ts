// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { applyMergePatch, diffMergePatch } from './merge-patch';

describe('RFC 7386 merge patch', () => {
  it('applies the RFC examples', () => {
    expect(applyMergePatch({ a: 'b' }, { a: 'c' })).toEqual({ a: 'c' });
    expect(applyMergePatch({ a: 'b' }, { b: 'c' })).toEqual({ a: 'b', b: 'c' });
    expect(applyMergePatch({ a: 'b' }, { a: null })).toEqual({});
    expect(applyMergePatch({ a: 'b', b: 'c' }, { a: null })).toEqual({ b: 'c' });
    expect(applyMergePatch({ a: ['b'] }, { a: 'c' })).toEqual({ a: 'c' });
    expect(applyMergePatch({ a: 'c' }, { a: ['b'] })).toEqual({ a: ['b'] });
    expect(applyMergePatch({ a: { b: 'c' } }, { a: { b: 'd', c: null } })).toEqual({
      a: { b: 'd' },
    });
    expect(applyMergePatch({ a: [{ b: 'c' }] }, { a: [1] })).toEqual({ a: [1] });
    expect(applyMergePatch(['a', 'b'], ['c', 'd'])).toEqual(['c', 'd']);
    expect(applyMergePatch({ a: 'b' }, ['c'])).toEqual(['c']);
    expect(applyMergePatch({ a: 'foo' }, null)).toBeNull();
    expect(applyMergePatch({ a: 'foo' }, 'bar')).toBe('bar');
    expect(applyMergePatch({ e: null }, { a: 1 })).toEqual({ e: null, a: 1 });
    expect(applyMergePatch([1, 2], { a: 'b', c: null })).toEqual({ a: 'b' });
    expect(applyMergePatch({}, { a: { bb: { ccc: null } } })).toEqual({ a: { bb: {} } });
  });
  it('does not mutate its input', () => {
    const target = { a: { b: 1 } };
    applyMergePatch(target, { a: { b: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });
  it('diffs to a patch that applies back (arrays whole, removals as null)', () => {
    const from = { hatchet: { damage: 10, client: { icon: 'a' }, list: [1, 2] }, gone: { x: 1 } };
    const to = { hatchet: { damage: 12, client: { icon: 'a' }, list: [1] }, added: { y: 2 } };
    const patch = diffMergePatch(from, to);
    expect(patch).toEqual({ hatchet: { damage: 12, list: [1] }, gone: null, added: { y: 2 } });
    expect(applyMergePatch(from, patch)).toEqual(to);
    expect(diffMergePatch(from, from)).toEqual({});
  });
});

it('does not allow prototype keys to change merge behavior', () => {
  const target = JSON.parse('{"__proto__":{"old":1},"constructor":{"a":1}}');
  const patch = JSON.parse('{"__proto__":{"new":2},"constructor":{"a":null,"b":3},"toString":4}');
  const result = applyMergePatch(target, patch);
  expect(Object.prototype).not.toHaveProperty('new');
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(JSON.stringify(result)).toBe(
    '{"__proto__":{"old":1,"new":2},"constructor":{"b":3},"toString":4}',
  );
  expect(applyMergePatch(target, diffMergePatch(target, result!))).toEqual(result);
});
