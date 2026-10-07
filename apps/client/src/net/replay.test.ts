// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unwrapBatch } from './batch';
import { dispatchServerMessage } from './dispatcher';
import {
  NetEventBus,
  type HandshakeEvent,
  type MapSizeEvent,
  type UnitsEvent,
  type WorldTimeEvent,
} from './events';
import { ServerOpcode } from './opcodes';

function loadRecordedFrames(binPath: string): Uint8Array[] {
  const buf = readFileSync(binPath);
  const frames: Uint8Array[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    const slice = new Uint8Array(buf.buffer, buf.byteOffset + off, len);
    frames.push(slice);
    off += len;
  }
  return frames;
}

describe('Replay tests over real server captured frames', () => {
  const fixturePath = join(__dirname, '../../../../tests/fixtures/net/login-and-ticks.bin');
  const frames = loadRecordedFrames(fixturePath);

  it('loaded recorded frames successfully', () => {
    expect(frames.length).toBeGreaterThan(0);
    // Frame 1 should be a BATCH frame (75)
    expect(frames[0]![0]).toBe(ServerOpcode.BATCH);
  });

  it('unwraps batch frames and processes all sub-messages without error', () => {
    const bus = new NetEventBus();

    let handshakeEvent: HandshakeEvent | null = null;
    let mapSizeEvent: MapSizeEvent | null = null;
    let worldTimeEvent: WorldTimeEvent | null = null;
    let unitsEvents: UnitsEvent[] = [];
    const nickListener = vi.fn();
    const leaderboardListener = vi.fn();

    bus.on('handshake', (ev) => {
      handshakeEvent = ev;
    });
    bus.on('mapSize', (ev) => {
      mapSizeEvent = ev;
    });
    bus.on('worldTime', (ev) => {
      worldTimeEvent = ev;
    });
    bus.on('units', (ev) => {
      unitsEvents.push(ev);
    });
    bus.on('nicknames', nickListener);
    bus.on('leaderboard', leaderboardListener);

    let totalSubMessages = 0;
    const opcodesSeen = new Set<number>();

    for (const frame of frames) {
      const messages = unwrapBatch(frame);
      totalSubMessages += messages.length;
      for (const msg of messages) {
        opcodesSeen.add(msg[0]!);
        expect(() => dispatchServerMessage(msg, bus)).not.toThrow();
      }
    }

    // Must have unwrap-flattened the batch into multiple distinct messages
    expect(totalSubMessages).toBeGreaterThan(5);

    // Verify key game setup packets were received and parsed
    expect(mapSizeEvent).toBeDefined();
    expect(mapSizeEvent!.width).toBe(150);
    expect(mapSizeEvent!.height).toBe(150);

    expect(handshakeEvent).toBeDefined();
    expect(handshakeEvent!.modeId).toBe(0); // survival mode

    expect(worldTimeEvent).toBeDefined();
    expect(worldTimeEvent!.cycleMs).toBe(960000);

    expect(nickListener).toHaveBeenCalled();
    expect(leaderboardListener).toHaveBeenCalled();

    // Check UNITS was processed
    expect(unitsEvents.length).toBeGreaterThan(0);
    const totalUnits = unitsEvents.reduce((acc, u) => acc + u.units.length, 0);
    expect(totalUnits).toBeGreaterThan(0);

    // Ensure common login opcodes were seen
    expect(opcodesSeen.has(ServerOpcode.MAP_SIZE)).toBe(true);
    expect(opcodesSeen.has(ServerOpcode.HANDSHAKE)).toBe(true);
    expect(opcodesSeen.has(ServerOpcode.WORLD_TIME)).toBe(true);
    expect(opcodesSeen.has(ServerOpcode.NICKNAMES)).toBe(true);
  });
});
