// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function decodeUtf8(bytes: Uint8Array): string {
  if (textDecoder) return textDecoder.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[++i]! & 0x3f));
    else if (c < 0xf0)
      out += String.fromCharCode(
        ((c & 0x0f) << 12) | ((bytes[++i]! & 0x3f) << 6) | (bytes[++i]! & 0x3f),
      );
    else {
      let cp =
        ((c & 0x07) << 18) |
        ((bytes[++i]! & 0x3f) << 12) |
        ((bytes[++i]! & 0x3f) << 6) |
        (bytes[++i]! & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function encodeUtf8(str: string): Uint8Array {
  if (textEncoder) return textEncoder.encode(str);
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
      i++;
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

export class BinaryReader {
  readonly view: DataView;
  readonly ui8: Uint8Array;
  pos: number;
  readonly limit: number;
  hasError = false;

  constructor(source: ArrayBuffer | Uint8Array, offset = 0) {
    if (source instanceof Uint8Array) {
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      this.ui8 = source;
      this.limit = source.byteLength;
    } else {
      this.view = new DataView(source);
      this.ui8 = new Uint8Array(source);
      this.limit = source.byteLength;
    }
    this.pos = offset;
  }

  u8(): number {
    if (this.pos + 1 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getUint8(this.pos);
    this.pos += 1;
    return val;
  }

  i8(): number {
    if (this.pos + 1 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getInt8(this.pos);
    this.pos += 1;
    return val;
  }

  u16(): number {
    if (this.pos + 2 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return val;
  }

  i16(): number {
    if (this.pos + 2 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return val;
  }

  u32(): number {
    if (this.pos + 4 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return val;
  }

  i32(): number {
    if (this.pos + 4 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return val;
  }

  f32(): number {
    if (this.pos + 4 > this.limit) {
      this.hasError = true;
      return 0;
    }
    const val = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return val;
  }

  str(): string {
    const len = this.u16();
    if (len === 0) return '';
    if (this.pos + len > this.limit) {
      this.hasError = true;
      return '';
    }
    const slice = this.ui8.subarray(this.pos, this.pos + len);
    this.pos += len;
    return decodeUtf8(slice);
  }

  bytes(count: number): Uint8Array {
    if (this.pos + count > this.limit) {
      this.hasError = true;
      return new Uint8Array(0);
    }
    const slice = this.ui8.subarray(this.pos, this.pos + count);
    this.pos += count;
    return slice;
  }

  skip(count: number): void {
    if (this.pos + count > this.limit) {
      this.hasError = true;
      this.pos = this.limit;
    } else {
      this.pos += count;
    }
  }

  remaining(): number {
    return Math.max(0, this.limit - this.pos);
  }

  done(): boolean {
    return this.pos >= this.limit;
  }
}

export class BinaryWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private ui8: Uint8Array;
  pos = 0;

  constructor(initialCapacity = 32) {
    this.buf = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this.buf);
    this.ui8 = new Uint8Array(this.buf);
  }

  private reserve(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return;
    let size = this.buf.byteLength;
    while (size < this.pos + extra) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf);
    this.ui8 = new Uint8Array(this.buf);
  }

  u8(val: number): this {
    this.reserve(1);
    this.view.setUint8(this.pos, val & 0xff);
    this.pos += 1;
    return this;
  }

  i8(val: number): this {
    this.reserve(1);
    this.view.setInt8(this.pos, val);
    this.pos += 1;
    return this;
  }

  u16(val: number): this {
    this.reserve(2);
    this.view.setUint16(this.pos, val & 0xffff, true);
    this.pos += 2;
    return this;
  }

  i16(val: number): this {
    this.reserve(2);
    this.view.setInt16(this.pos, val, true);
    this.pos += 2;
    return this;
  }

  u32(val: number): this {
    this.reserve(4);
    this.view.setUint32(this.pos, val >>> 0, true);
    this.pos += 4;
    return this;
  }

  i32(val: number): this {
    this.reserve(4);
    this.view.setInt32(this.pos, val, true);
    this.pos += 4;
    return this;
  }

  f32(val: number): this {
    this.reserve(4);
    this.view.setFloat32(this.pos, val, true);
    this.pos += 4;
    return this;
  }

  str(val: string): this {
    const encoded = encodeUtf8(val ?? '');
    this.reserve(2 + encoded.length);
    this.view.setUint16(this.pos, encoded.length, true);
    this.pos += 2;
    this.ui8.set(encoded, this.pos);
    this.pos += encoded.length;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.reserve(b.length);
    this.ui8.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  build(): Uint8Array {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }

  buildBuffer(): ArrayBuffer {
    return this.buf.slice(0, this.pos);
  }
}
