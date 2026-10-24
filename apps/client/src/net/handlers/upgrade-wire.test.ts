// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it, vi } from 'vitest';
import { dispatchServerMessage } from '../dispatcher';
import { NetEventBus } from '../events';
import { ClientOpcode, ServerOpcode } from '../opcodes';
import {
  buildCancelUpgradeMessage,
  buildOpenUpgradeMessage,
  buildStartUpgradeMessage,
} from '../outbound';

/** What Game::sendUpgradeState writes. */
function upgradeState(
  firstOpen: number,
  entityId: number,
  iid: number,
  targetIid: number,
  running: number,
  durationMs: number,
  remainingMs: number,
): Uint8Array {
  const bytes = new Uint8Array(19);
  const v = new DataView(bytes.buffer);
  v.setUint8(0, ServerOpcode.UPGRADE_STATE);
  v.setUint8(1, firstOpen);
  v.setUint32(2, entityId, true);
  v.setUint16(6, iid, true);
  v.setUint16(8, targetIid, true);
  v.setUint8(10, running);
  v.setUint32(11, durationMs, true);
  v.setUint32(15, remainingMs, true);
  return bytes;
}

describe('upgrade wire', () => {
  it('decodes UPGRADE_STATE', () => {
    const bus = new NetEventBus();
    const seen = vi.fn();
    bus.on('upgradeState', seen);
    dispatchServerMessage(upgradeState(1, 0x123456, 27, 28, 0, 30000, 0), bus);
    dispatchServerMessage(upgradeState(0, 9, 28, 29, 1, 60000, 41250), bus);
    expect(seen).toHaveBeenNthCalledWith(1, {
      firstOpen: true,
      entityId: 0x123456,
      iid: 27,
      targetIid: 28,
      running: false,
      durationMs: 30000,
      remainingMs: 0,
    });
    expect(seen).toHaveBeenNthCalledWith(2, {
      firstOpen: false,
      entityId: 9,
      iid: 28,
      targetIid: 29,
      running: true,
      durationMs: 60000,
      remainingMs: 41250,
    });
  });

  it('ignores a truncated UPGRADE_STATE', () => {
    const bus = new NetEventBus();
    const seen = vi.fn();
    bus.on('upgradeState', seen);
    dispatchServerMessage(upgradeState(1, 1, 27, 28, 0, 1, 0).subarray(0, 18), bus);
    expect(seen).not.toHaveBeenCalled();
  });

  it('decodes UPGRADE_FINISHED', () => {
    const bus = new NetEventBus();
    const seen = vi.fn();
    bus.on('upgradeFinished', seen);
    const bytes = new Uint8Array(7);
    const v = new DataView(bytes.buffer);
    v.setUint8(0, ServerOpcode.UPGRADE_FINISHED);
    v.setUint16(1, 1250, true);
    v.setUint16(3, 3450, true);
    v.setUint16(5, 28, true);
    dispatchServerMessage(bytes, bus);
    expect(seen).toHaveBeenCalledWith({ x: 1250, y: 3450, iid: 28 });
  });

  it('builds the three client messages at the sizes the server expects', () => {
    // opcodes.h clientPayloadBytes: OPEN_UPGRADE 5, START/CANCEL_UPGRADE 0.
    const open = buildOpenUpgradeMessage(0x00abcdef, 3);
    expect(Array.from(open)).toEqual([ClientOpcode.OPEN_UPGRADE, 0xef, 0xcd, 0xab, 0x00, 3]);
    expect(Array.from(buildStartUpgradeMessage())).toEqual([ClientOpcode.START_UPGRADE]);
    expect(Array.from(buildCancelUpgradeMessage())).toEqual([ClientOpcode.CANCEL_UPGRADE]);
  });
});
