// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, LeaderboardEntry } from '../events';
import {
  IDENTITY_FLAG_VERIFIED,
  type ChatChannel,
  type ServerLogKind,
  type StatusKind,
} from '../opcodes';

export function handleChatLine(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [CHAT_LINE][channel u8][from u8][peer u8][flags u8][str text]
  const r = new BinaryReader(bytes, 1);
  const channel = r.u8() as ChatChannel;
  const pid = r.u8();
  const peer = r.u8();
  const flags = r.u8();
  const text = r.str();
  bus.emit('chat', { channel, pid, peer, flags, text });
}

export function handleBlockedPlayers(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [BLOCKED_PLAYERS][count u8][guid u8]*count -- the whole list, after every change
  const count = bytes[1] ?? 0;
  bus.emit('blockedPlayers', { guids: Array.from(bytes.subarray(2, 2 + count)) });
}

export function handleServerLog(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [SERVER_LOG][kind u8][a u8][b u8][str text]
  const r = new BinaryReader(bytes, 1);
  const kind = r.u8() as ServerLogKind;
  const a = r.u8();
  const b = r.u8();
  const text = r.str();
  bus.emit('serverLog', { kind, a, b, text });
}

export function handleStatusMessage(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [STATUS_MESSAGE][kind u8][str text]
  const r = new BinaryReader(bytes, 1);
  const kind = r.u8() as StatusKind;
  const text = r.str();
  bus.emit('statusMessage', { kind, text });
}

export function handleChatAccess(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [CHAT_ACCESS][mask u8]
  bus.emit('chatAccess', { mask: bytes[1] ?? 0 });
}

export function handlePlayerInfo(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [PLAYER_INFO][guid u8][tokenId u32 LE][skin u8][ghoul u8][str name][groupId u8][identityFlags u8]
  const r = new BinaryReader(bytes, 1);
  const guid = r.u8();
  const tokenId = r.u32();
  const skin = r.u8();
  const ghoul = r.u8();
  const name = r.str();
  const groupId = r.u8();
  const verified = (r.u8() & IDENTITY_FLAG_VERIFIED) !== 0;
  bus.emit('playerInfo', { guid, tokenId, skin, ghoul, name, groupId, verified });
}

export function handleGroups(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [GROUPS][count u8] then [id u8][str name][str badge] per group
  const r = new BinaryReader(bytes, 1);
  const count = r.u8();
  const groups = [];
  for (let i = 0; i < count && !r.done(); i++)
    groups.push({ id: r.u8(), name: r.str(), badge: r.str() });
  bus.emit('groups', { groups });
}

export function handlePlayerNames(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [PLAYER_NAMES][slotCount u16 LE][str name]*slotCount [str sessionToken]
  const r = new BinaryReader(bytes, 1);
  const slotCount = r.u16();
  const names: (string | null)[] = [];
  for (let i = 0; i < slotCount && !r.done(); i++) {
    const s = r.str();
    names.push(s === '' ? null : s);
  }
  const sessionToken = r.done() ? '' : r.str();
  bus.emit('nicknames', { names, sessionToken });
}

/** Undoes ProtocolGame::deflateNumber: scores over 10k / 1M ride the wire in hundreds / thousands. */
export function inflateNumber(n: number): number {
  if (n >= 20000) return (n - 20000) * 1000;
  if (n >= 10000) return (n - 10000) * 100;
  return n;
}

export function handleLeaderboard(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (Game::buildLeaderboardMessage): [LEADERBOARD][pad u8] then ten slots of
  // [guid u8][karma u8][score u16 LE, deflated]. Empty slots have guid 0.
  const r = new BinaryReader(bytes, 2);
  const entries: LeaderboardEntry[] = [];
  while (r.remaining() >= 4) {
    const guid = r.u8();
    const karma = r.u8();
    const score = inflateNumber(r.u16());
    if (guid !== 0) entries.push({ guid, karma, score });
  }
  bus.emit('leaderboard', { entries });
}

export function handleScore(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (ProtocolGame::sendScore): [SCORE][pad u8][high u16 LE][low u16 LE]
  const r = new BinaryReader(bytes, 2);
  const high = r.u16();
  const low = r.u16();
  bus.emit('score', { score: high * 65536 + low });
}

export function handleYouDied(bytes: Uint8Array, bus: NetEventBus): void {
  // [YOU_DIED][kills u16 BE] -- the death screen's kill count (old client PLAYER.kill);
  // the score itself arrives through SCORE. The server closes the socket next.
  const kills = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  bus.emit('playerDie', { kills });
}

export function handlePlayerDied(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('otherDie', { pid: bytes[1] ?? 0 });
}

export function handleKarma(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('karma', { clientIcon: bytes[1] ?? 0 });
}

export function handleWorstKarmaPlayer(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout (Game::broadcastBadKarma): [WORST_KARMA_PLAYER][guid u8][x u8][y u8][karma icon u8],
  // the worst Savage/Devil player's position scaled to 0..255 over the map.
  bus.emit('badKarma', {
    guid: bytes[1] ?? 0,
    x: (bytes[2] ?? 0) / 255,
    y: (bytes[3] ?? 0) / 255,
    karma: bytes[4] ?? 0,
  });
}
