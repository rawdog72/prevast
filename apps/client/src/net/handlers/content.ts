// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { ContentManifest, ContentPatch, ContentTable } from '../../../../../shared/typescript/content-format';
import type { NetEventBus } from '../events';

const textDecoder = new TextDecoder('utf-8');

export function handleContentManifest(bytes: Uint8Array, bus: NetEventBus): void {
  try {
    const jsonStr = textDecoder.decode(bytes.subarray(1));
    const manifest = JSON.parse(jsonStr) as ContentManifest;
    bus.emit('contentManifest', manifest);
  } catch (err) {
    console.warn('[net] Failed to parse CONTENT_MANIFEST:', err);
  }
}

export function handleContentTable(bytes: Uint8Array, bus: NetEventBus): void {
  try {
    const jsonStr = textDecoder.decode(bytes.subarray(1));
    const table = JSON.parse(jsonStr) as ContentTable;
    bus.emit('contentTable', table);
  } catch (err) {
    console.warn('[net] Failed to parse CONTENT_TABLE:', err);
  }
}

export function handleContentPatch(bytes: Uint8Array, bus: NetEventBus): void {
  try {
    const jsonStr = textDecoder.decode(bytes.subarray(1));
    const patch = JSON.parse(jsonStr) as ContentPatch;
    bus.emit('contentPatch', patch);
  } catch (err) {
    console.warn('[net] Failed to parse CONTENT_PATCH:', err);
  }
}
