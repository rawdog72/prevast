// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, HandshakePlayer } from '../events';
import type { DisconnectReason } from '../opcodes';

export function handleHandshake(bytes: Uint8Array, bus: NetEventBus): void {
  // Head: [HANDSHAKE][ownGuid u8][unitsPerPlayer u16 LE][playerCount u8][modeId u8] -> 6 bytes
  const r = new BinaryReader(bytes, 1);
  const ownGuid = r.u8();
  const unitsPerPlayer = r.u16();
  const playerCount = r.u8();
  const modeId = r.u8();

  const players: HandshakePlayer[] = [];
  // Each player record is 8 bytes: [guid u8][team u8][repellent u8][withdrawal u8][ghoul u8][pad u8][tokenId u16 LE][score u16 LE]
  while (r.remaining() >= 8) {
    const guid = r.u8();
    const team = r.u8();
    const repellent = r.u8();
    const withdrawal = r.u8();
    const ghoul = r.u8();
    r.u8(); // pad
    const tokenId = r.u16();
    const score = r.u16();
    players.push({ guid, team, repellent, withdrawal, ghoul, tokenId, score });
  }

  bus.emit('handshake', { ownGuid, unitsPerPlayer, playerCount, modeId, players });
}

export function handleAlert(bytes: Uint8Array, bus: NetEventBus): void {
  const r = new BinaryReader(bytes, 1);
  const text = r.str();
  bus.emit('alert', { text });
}

export function handleDisconnectReason(bytes: Uint8Array, bus: NetEventBus): void {
  // [DISCONNECT_REASON][reason u8][str detail]
  const r = new BinaryReader(bytes, 1);
  const reason = r.u8() as DisconnectReason;
  const detail = r.str();
  bus.emit('disconnectReason', { reason, detail });
}

export function handleSessionTaken(_bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('stoleYourSession', undefined as unknown as void);
}

