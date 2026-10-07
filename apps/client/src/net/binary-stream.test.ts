// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import { BinaryReader, BinaryWriter } from './binary-stream';

describe('BinaryWriter and BinaryReader', () => {
  it('round-trips all numeric primitives little-endian', () => {
    const w = new BinaryWriter();
    w.u8(0x42).i8(-5).u16(0x1234).i16(-1234).u32(0xdeadbeef).i32(-987654).f32(3.140000104904175);

    const buf = w.build();
    expect(buf.length).toBe(1 + 1 + 2 + 2 + 4 + 4 + 4);

    const r = new BinaryReader(buf);
    expect(r.u8()).toBe(0x42);
    expect(r.i8()).toBe(-5);
    expect(r.u16()).toBe(0x1234);
    expect(r.i16()).toBe(-1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.i32()).toBe(-987654);
    expect(r.f32()).toBeCloseTo(3.14, 2);
    expect(r.done()).toBe(true);
    expect(r.hasError).toBe(false);
  });

  it('round-trips UTF-8 strings including empty and multibyte unicode', () => {
    const w = new BinaryWriter();
    w.str('').str('hello world').str('🔥🌲🛡️');

    const buf = w.build();
    const r = new BinaryReader(buf);

    expect(r.str()).toBe('');
    expect(r.str()).toBe('hello world');
    expect(r.str()).toBe('🔥🌲🛡️');
    expect(r.done()).toBe(true);
    expect(r.hasError).toBe(false);
  });

  it('handles buffer growth dynamically beyond initial capacity', () => {
    const w = new BinaryWriter(16);
    const longString = 'a'.repeat(500);
    w.str(longString);

    const buf = w.build();
    expect(buf.length).toBe(2 + 500);

    const r = new BinaryReader(buf);
    expect(r.str()).toBe(longString);
    expect(r.done()).toBe(true);
  });

  it('safely handles truncated reads without throwing', () => {
    const r = new BinaryReader(new Uint8Array([1, 2]));
    expect(r.u8()).toBe(1);
    expect(r.u8()).toBe(2);
    expect(r.u8()).toBe(0); // overflow
    expect(r.hasError).toBe(true);

    const r2 = new BinaryReader(new Uint8Array([10, 0, 65])); // claims 10 bytes, only 1 provided
    expect(r2.str()).toBe('');
    expect(r2.hasError).toBe(true);
  });

  it('handles bytes slicing and skipping', () => {
    const w = new BinaryWriter();
    w.u8(1)
      .bytes(new Uint8Array([10, 20, 30]))
      .u8(2);

    const r = new BinaryReader(w.build());
    expect(r.u8()).toBe(1);
    expect(r.bytes(3)).toEqual(new Uint8Array([10, 20, 30]));
    expect(r.u8()).toBe(2);
    expect(r.done()).toBe(true);
  });
});
