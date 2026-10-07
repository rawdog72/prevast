// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { BinaryReader } from '../binary-stream';
import type { NetEventBus, TeamPosition } from '../events';

// Membership packets are broadcast to everyone and name the PLAYER they are
// about (game_clans.cpp), so every client can keep the roster of every clan.
export function handleTeamMemberJoined(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_MEMBER_JOINED][pid u8][clanId u8]
  bus.emit('acceptedTeam', { pid: bytes[1] ?? 0, clanId: bytes[2] ?? 0 });
}

export function handleTeamMemberLeft(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_MEMBER_LEFT][pid u8] -- kicked, left, or the clan was deleted
  bus.emit('kickedTeam', { pid: bytes[1] ?? 0 });
}

export function handleTeamDeleted(bytes: Uint8Array, bus: NetEventBus): void {
  bus.emit('deleteTeam', { clanId: bytes[1] ?? 0 });
}

export function handleTeamJoinRequest(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_JOIN_REQUEST][pid u8] -- sent to the leader: this player asks to join
  bus.emit('joinTeam', { pid: bytes[1] ?? 0 });
}

export function handleTeamInvite(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_INVITE][clanId u8][inviterGuid u8] -- to us alone: that clan's leader invites us
  bus.emit('teamInvite', { clanId: bytes[1] ?? 0, inviterGuid: bytes[2] ?? 0 });
}

export function handleTeamLocked(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_LOCKED][clanId u8][locked u8] -- broadcast on lock / unlock, and at login per locked clan
  bus.emit('teamLocked', { clanId: bytes[1] ?? 0, locked: (bytes[2] ?? 0) !== 0 });
}

export function handlePlayerPositions(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [PLAYER_POSITIONS] then repeated [x u8][y u8][guid u8]; x/y are the position
  // scaled to 0..255 over the map width/height (Game clan sync).
  const r = new BinaryReader(bytes, 1);
  const positions: TeamPosition[] = [];
  while (r.remaining() >= 3) {
    const x = r.u8();
    const y = r.u8();
    const guid = r.u8();
    positions.push({ guid, x, y });
  }
  bus.emit('teamPosition', { positions });
}

export function handleTeamCreated(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_CREATED][clanId u8][leaderGuid u32 LE][str name]
  const r = new BinaryReader(bytes, 1);
  const clanId = r.u8();
  const leaderGuid = r.u32();
  const name = r.str();
  bus.emit('teamCreated', { clanId, leaderGuid, name });
}

export function handleTeamNames(bytes: Uint8Array, bus: NetEventBus): void {
  // Layout: [TEAM_NAMES][slotCount u8][str name]*slotCount
  const r = new BinaryReader(bytes, 1);
  const slotCount = r.u8();
  const names: string[] = [];
  for (let i = 0; i < slotCount && !r.done(); i++) {
    names.push(r.str());
  }
  bus.emit('teamNames', { names });
}
