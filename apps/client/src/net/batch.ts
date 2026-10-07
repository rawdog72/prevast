// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export const BATCH_OPCODE = 75;

/**
 * Unwraps a received WebSocket frame into an array of individual protocol messages.
 *
 * If the frame begins with ServerOpcode::BATCH (75), the envelope layout is:
 *   [75][0] then repeated [u16 length LE][message bytes]
 *
 * Each sub-message is sliced into its own standalone buffer with byteOffset 0
 * so that downstream decoders indexing from offset 0 or building typed views
 * operate on exactly the intended payload.
 *
 * A non-batched frame is returned directly as a single-element array.
 */
export function unwrapBatch(frame: Uint8Array): Uint8Array[] {
  if (frame.length === 0) return [];
  if (frame[0] !== BATCH_OPCODE) return [frame];

  // Malformed envelope: must have at least 2 bytes and byte 1 must be 0
  if (frame.length < 2 || frame[1] !== 0) return [];

  const out: Uint8Array[] = [];
  let off = 2;
  const total = frame.length;

  while (off + 2 <= total) {
    const len = frame[off]! | (frame[off + 1]! << 8);
    off += 2;
    // Malformed/truncated message length stops the walk
    if (len < 1 || off + len > total) break;

    // Standalone slice with byteOffset 0
    const slice = frame.slice(off, off + len);
    out.push(slice);
    off += len;
  }

  return out;
}

/**
 * Builds a ServerOpcode::BATCH frame containing multiple messages.
 * Layout: [75][0] repeated [u16 length LE][message bytes]
 */
export function wrapBatch(messages: Uint8Array[]): Uint8Array {
  let totalBytes = 2;
  for (const m of messages) totalBytes += 2 + m.length;

  const out = new Uint8Array(totalBytes);
  out[0] = BATCH_OPCODE;
  out[1] = 0;

  let off = 2;
  const view = new DataView(out.buffer);
  for (const m of messages) {
    view.setUint16(off, m.length, true);
    off += 2;
    out.set(m, off);
    off += m.length;
  }

  return out;
}
