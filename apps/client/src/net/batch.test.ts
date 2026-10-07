// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { BATCH_OPCODE, unwrapBatch, wrapBatch } from './batch';

describe('unwrapBatch and wrapBatch', () => {
  it('returns non-batched frames as a single message directly', () => {
    const frame = new Uint8Array([8, 1, 2, 3]);
    const unwrapped = unwrapBatch(frame);
    expect(unwrapped).toHaveLength(1);
    expect(unwrapped[0]).toEqual(frame);
  });

  it('unwraps empty frame to empty list', () => {
    expect(unwrapBatch(new Uint8Array(0))).toEqual([]);
  });

  it('unwraps a batch containing multiple messages into standalone slices', () => {
    const m1 = new Uint8Array([9, 10, 11, 12]);
    const m2 = new Uint8Array([85, 1, 2, 3, 4, 5, 6, 7, 8]);
    const m3 = new Uint8Array([82]); // PONG

    const batched = wrapBatch([m1, m2, m3]);
    expect(batched[0]).toBe(BATCH_OPCODE);
    expect(batched[1]).toBe(0);

    const unwrapped = unwrapBatch(batched);
    expect(unwrapped).toHaveLength(3);
    expect(unwrapped[0]).toEqual(m1);
    expect(unwrapped[1]).toEqual(m2);
    expect(unwrapped[2]).toEqual(m3);

    // Each message must have its own byteOffset = 0
    expect(unwrapped[0]!.byteOffset).toBe(0);
    expect(unwrapped[1]!.byteOffset).toBe(0);
    expect(unwrapped[2]!.byteOffset).toBe(0);
  });

  it('stops walk safely on truncated or malformed batch frames', () => {
    // Envelope claiming byte 1 is not 0
    expect(unwrapBatch(new Uint8Array([BATCH_OPCODE, 1, 4, 0, 1, 2, 3, 4]))).toEqual([]);

    // Envelope with truncated length header (only 1 byte after prefix)
    expect(unwrapBatch(new Uint8Array([BATCH_OPCODE, 0, 5]))).toEqual([]);

    // Message claiming 100 bytes when only 2 remain
    const truncated = new Uint8Array([BATCH_OPCODE, 0, 100, 0, 1, 2]);
    expect(unwrapBatch(truncated)).toEqual([]);

    // One valid message followed by a truncated second message
    const valid = wrapBatch([new Uint8Array([1, 2, 3])]);
    const partiallyTruncated = new Uint8Array(valid.length + 3);
    partiallyTruncated.set(valid);
    partiallyTruncated[valid.length] = 50; // length 50
    partiallyTruncated[valid.length + 1] = 0;
    partiallyTruncated[valid.length + 2] = 99; // only 1 byte

    const result = unwrapBatch(partiallyTruncated);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(new Uint8Array([1, 2, 3]));
  });
});
