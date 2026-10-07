// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// RFC 7386 JSON merge patch: the shape CONTENT_PATCH carries. Content never
// contains null (XML has none), so null-as-delete is unambiguous.
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function applyMergePatch(
  target: JsonValue | undefined,
  patch: JsonValue,
): JsonValue | undefined {
  if (!isObject(patch)) return patch;
  const out: { [key: string]: JsonValue } = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else {
      const merged = applyMergePatch(Object.hasOwn(out, key) ? out[key] : undefined, value);
      if (merged !== undefined)
        Object.defineProperty(out, key, {
          value: merged,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  return out;
}

export function diffMergePatch(from: JsonValue, to: JsonValue): JsonValue {
  if (!isObject(from) || !isObject(to)) return to;
  const patch: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(from))
    if (!Object.hasOwn(to, key))
      Object.defineProperty(patch, key, {
        value: null,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  for (const [key, value] of Object.entries(to)) {
    const before = Object.hasOwn(from, key) ? from[key] : undefined;
    if (before === undefined)
      Object.defineProperty(patch, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else if (isObject(before) && isObject(value)) {
      const inner = diffMergePatch(before, value);
      if (isObject(inner) && Object.keys(inner).length > 0)
        Object.defineProperty(patch, key, {
          value: inner,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    } else if (JSON.stringify(before) !== JSON.stringify(value))
      Object.defineProperty(patch, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return patch;
}
