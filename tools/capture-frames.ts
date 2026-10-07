// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// CLI tool to capture raw WebSocket binary frames from a running Prevast server.
// Usage:
//   tsx tools/capture-frames.ts [--url ws://127.0.0.1:7172] [--output tests/fixtures/net/login-and-ticks.bin] [--seconds 4]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import WebSocket from 'ws';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg('--url', process.env.PREVAST_SERVER_WS ?? 'ws://127.0.0.1:7172');
const outFile = arg('--output', 'tests/fixtures/net/login-and-ticks.bin');
const durationSec = Number(arg('--seconds', '4'));

function makeLoginPacket(nickname: string): Buffer {
  const parts: Buffer[] = [];
  // 1 byte protocol identifier (30) + 2 bytes version (0 = exempt in server)
  const head = Buffer.alloc(3);
  head.writeUInt8(30, 0);
  head.writeUInt16LE(0, 1);
  parts.push(head);

  // token: [u16 len][utf8] (empty token)
  const token = Buffer.alloc(2);
  token.writeUInt16LE(0, 0);
  parts.push(token);

  // tokenId: u32 LE, userId: u32 LE
  const ids = Buffer.alloc(8);
  ids.writeUInt32LE(0, 0);
  ids.writeUInt32LE(0, 4);
  parts.push(ids);

  // nickname: [u16 len][utf8]
  const nickBuf = Buffer.from(nickname, 'utf8');
  const nickLen = Buffer.alloc(2);
  nickLen.writeUInt16LE(nickBuf.length, 0);
  parts.push(nickLen, nickBuf);

  // adBlocker: u8
  const ad = Buffer.alloc(1);
  ad.writeUInt8(0, 0);
  parts.push(ad);

  // password: [u16 len][utf8]
  const pass = Buffer.alloc(2);
  pass.writeUInt16LE(0, 0);
  parts.push(pass);

  // accountTicket: [u16 len][utf8] (empty = guest)
  parts.push(Buffer.alloc(2));

  return Buffer.concat(parts);
}

console.log(`Connecting to ${url}...`);
const ws = new WebSocket(url, { perMessageDeflate: false });
const frames: Buffer[] = [];

ws.on('open', () => {
  console.log(`Connected. Sending login frame (${durationSec}s capture)...`);
  ws.send(makeLoginPacket('CaptureBot'));

  setTimeout(() => {
    console.log(`Capture complete: received ${frames.length} frames.`);
    ws.close();
  }, durationSec * 1000);
});

ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  frames.push(buf);
  const opcode = buf[0];
  console.log(`  Frame #${frames.length}: ${buf.length} bytes (opcode ${opcode})`);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  if (frames.length === 0) {
    console.error('No frames captured.');
    process.exit(1);
  }

  // Pack each frame as [u32 length LE][frame bytes]
  const outParts: Buffer[] = [];
  for (const f of frames) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(f.length, 0);
    outParts.push(len, f);
  }
  const packed = Buffer.concat(outParts);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, packed);
  console.log(`Wrote ${frames.length} frames (${packed.length} bytes) to ${outFile}`);
});
