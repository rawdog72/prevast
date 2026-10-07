// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import type { NpcCommand } from '../../../../shared/typescript/npc-protocol';
import { BinaryWriter } from './binary-stream';
import {
  ClientOpcode,
  GAME_PROTOCOL_IDENTIFIER,
  PROTOCOL_VERSION,
  type ChatChannel,
  type MouseDirection,
  type MoveMask,
} from './opcodes';

export interface LoginOptions {
  version?: number;
  token?: string;
  tokenId?: number;
  playerId?: number;
  nickname: string;
  adBlocker?: boolean;
  password?: string;
  /** Signed login ticket from the web account service; empty = guest. */
  accountTicket?: string;
}

export function buildLoginMessage(opts: LoginOptions): Uint8Array {
  const w = new BinaryWriter();
  w.u8(GAME_PROTOCOL_IDENTIFIER);
  w.u16(opts.version ?? PROTOCOL_VERSION);
  w.str(opts.token ?? '');
  w.u32(opts.tokenId ?? 0);
  w.u32(opts.playerId ?? 0);
  w.str(opts.nickname);
  w.u8(opts.adBlocker ? 1 : 0);
  w.str(opts.password ?? '');
  w.str(opts.accountTicket ?? '');
  return w.build();
}

export function buildNpcActionMessage(command: NpcCommand): Uint8Array {
  for (const value of [
    command.session,
    command.revision,
    command.request,
    command.target ?? 0,
    command.amount ?? 0,
  ])
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError('Invalid NPC command number');
  if (
    command.action < 0 ||
    command.action > 8 ||
    !Number.isInteger(command.action) ||
    new TextEncoder().encode(command.text ?? '').length > 256
  )
    throw new RangeError('Invalid NPC action');
  const w = new BinaryWriter();
  w.u8(ClientOpcode.NPC_ACTION);
  w.u32(command.session);
  w.u32(command.revision);
  w.u32(command.request);
  w.u8(command.action);
  w.u32(command.target ?? 0);
  w.u32(command.amount ?? 0);
  w.str(command.text ?? '');
  return w.build();
}

export function buildPingMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.PING]);
}

export function buildChatMessage(text: string): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.CHAT_LOCAL);
  w.str(text);
  return w.build();
}

export function buildChatChannelMessage(
  channel: ChatChannel,
  target: number,
  text: string,
): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.SEND_CHAT);
  w.u8(channel);
  w.u8(target & 0xff);
  w.str(text);
  return w.build();
}

export function buildMoveMessage(mask: MoveMask): Uint8Array {
  return new Uint8Array([ClientOpcode.MOVE, mask & 0xff]);
}

export function buildMouseDirectionMessage(dir: MouseDirection): Uint8Array {
  return new Uint8Array([ClientOpcode.FACE, dir & 0xff]);
}

export function buildMouseDownMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.ATTACK_START]);
}

export function buildMouseUpMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.ATTACK_STOP]);
}

export function buildRotationMessage(degrees: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.ROTATE);
  w.u16(Math.round(degrees) % 360);
  return w.build();
}

export function buildShiftMessage(enabled: boolean): Uint8Array {
  return new Uint8Array([ClientOpcode.SPRINT, enabled ? 1 : 0]);
}

/** AIM: 1 while the aim button is held, 0 on release. The server answers with AIM_STATE. */
export function buildAimMessage(held: boolean): Uint8Array {
  return new Uint8Array([ClientOpcode.AIM, held ? 1 : 0]);
}

export function buildEquipItemMessage(iid: number, uid: number, count = 0, ammo = 0): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.EQUIP_ITEM);
  w.u16(iid);
  w.u8(count);
  w.u32(uid);
  w.u8(ammo);
  return w.build();
}

export function buildThrowItemMessage(iid: number, uid: number, count = 1, ammo = 0): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.DROP_ITEM);
  w.u16(iid);
  w.u8(count);
  w.u32(uid);
  w.u8(ammo);
  return w.build();
}

/** `containerSlot`: the container slot it was dropped on (used when free); 255 = first free. */
export function buildStoreItemMessage(
  iid: number,
  uid: number,
  count = 1,
  ammo = 0,
  containerSlot = 255,
): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.STORE_ITEM);
  w.u16(iid);
  w.u8(count);
  w.u32(uid);
  w.u8(ammo);
  w.u8(containerSlot & 0xff);
  return w.build();
}

/** Drag one container slot onto another: the two swap. */
export function buildMoveContainerItemMessage(from: number, to: number): Uint8Array {
  return new Uint8Array([ClientOpcode.MOVE_CONTAINER_ITEM, from & 0xff, to & 0xff]);
}

export function buildSplitItemMessage(iid: number, count: number, uid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.SPLIT_ITEM);
  w.u16(iid);
  w.u8(count);
  w.u32(uid);
  return w.build();
}

export function buildStackItemMessage(
  dragIid: number,
  dragCount: number,
  dragUid: number,
  targetCount: number,
  targetUid: number,
): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.STACK_ITEM);
  w.u16(dragIid);
  w.u8(dragCount);
  w.u32(dragUid);
  w.u8(targetCount);
  w.u32(targetUid);
  return w.build();
}

export function buildTakeLootMessage(lootId: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.PICK_UP_LOOT);
  w.u32(lootId);
  return w.build();
}

export function buildReloadMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.RELOAD]);
}

/**
 * [PLACE_BUILDING][rotation][u16 row i][u16 column j] -- row BEFORE column, the old
 * Writer(14).u8(buildRotate).u16(iBuild).u16(jBuild); the server's
 * playerPlaceObject(rotation, i, j) reads them in that order.
 */
export function buildPlaceObjectMessage(rotationIndex: number, i: number, j: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.PLACE_BUILDING);
  w.u8(rotationIndex);
  w.u16(i);
  w.u16(j);
  return w.build();
}

export function buildInteractMessage(entityId: number, pid = 0): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.INTERACT);
  w.u32(entityId);
  w.u8(pid);
  return w.build();
}

export function buildTakeItemMessage(containerSlot: number): Uint8Array {
  return new Uint8Array([ClientOpcode.TAKE_ITEM, containerSlot & 0xff]);
}

export function buildTakeFromStationMessage(stationSlot: number): Uint8Array {
  return new Uint8Array([ClientOpcode.TAKE_FROM_STATION, stationSlot & 0xff]);
}

export function buildCloseContainerMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.CLOSE_CONTAINER]);
}

export function buildStartCraftStationMessage(iid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.CRAFT_AT_STATION);
  w.u16(iid);
  return w.build();
}

export function buildStartCraftManualMessage(iid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.CRAFT_BY_HAND);
  w.u16(iid);
  return w.build();
}

export function buildCancelCraftMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.CANCEL_CRAFT]);
}

export function buildUnlockSkillMessage(iid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.UNLOCK_SKILL);
  w.u16(iid);
  return w.build();
}

export function buildAddFuelMessage(amount: number): Uint8Array {
  if (!Number.isInteger(amount) || amount < 1 || amount > 254)
    throw new RangeError('Fuel amount must be between 1 and 254');
  return new Uint8Array([ClientOpcode.ADD_FUEL, amount]);
}

export function buildCreateTeamMessage(name: string): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.CREATE_TEAM);
  w.str(name);
  return w.build();
}

export function buildDeleteTeamMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.DELETE_TEAM]);
}

export function buildRequestJoinTeamMessage(clanId: number): Uint8Array {
  return new Uint8Array([ClientOpcode.REQUEST_TEAM_JOIN, clanId & 0xff]);
}

export function buildAcceptJoinTeamMessage(guid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.ACCEPT_TEAM_JOIN);
  w.u32(guid);
  return w.build();
}

export function buildInviteTeamMessage(guid: number): Uint8Array {
  return new Uint8Array([ClientOpcode.INVITE_TO_TEAM, guid & 0xff]);
}

export function buildAcceptTeamInviteMessage(clanId: number): Uint8Array {
  return new Uint8Array([ClientOpcode.ACCEPT_TEAM_INVITE, clanId & 0xff]);
}

export function buildPrivateMessagesMessage(policy: number): Uint8Array {
  return new Uint8Array([ClientOpcode.SET_PRIVATE_MESSAGES, policy & 0xff]);
}

/** QUEST_ACTION: QuestAction on the quest with that id (0 for a resync). */
export function buildQuestActionMessage(questId: number, action: number): Uint8Array {
  return new Uint8Array([ClientOpcode.QUEST_ACTION, questId & 0xff, (questId >> 8) & 0xff, action & 0xff]);
}

/**
 * FIT_WEAPON_MOD: fit (or swap in) the mod with `modUid` into `slot`, or remove
 * what is fitted there when `modUid` is null. Fit/remove is its own byte
 * because 0 is a real wire uid.
 */
export function buildWeaponModMessage(weaponUid: number, slot: number, modUid: number | null): Uint8Array {
  return new Uint8Array([
    ClientOpcode.FIT_WEAPON_MOD,
    weaponUid & 0xff,
    slot & 0xff,
    modUid === null ? 0 : 1,
    (modUid ?? 0) & 0xff,
  ]);
}

export function buildBlockPlayerMessage(guid: number, blocked: boolean): Uint8Array {
  return new Uint8Array([ClientOpcode.BLOCK_PLAYER, guid & 0xff, blocked ? 1 : 0]);
}

export function buildKickTeamMessage(guid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.KICK_FROM_TEAM);
  w.u32(guid);
  return w.build();
}

export function buildLockTeamMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.LOCK_TEAM]);
}

export function buildUnlockTeamMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.UNLOCK_TEAM]);
}

export function buildLeaveTeamMessage(): Uint8Array {
  return new Uint8Array([ClientOpcode.LEAVE_TEAM]);
}

export function buildContentRequestMessage(names: string[]): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.REQUEST_CONTENT);
  w.str(JSON.stringify(names));
  return w.build();
}

export function buildTradeRequestMessage(target: number): Uint8Array {
  return new Uint8Array([ClientOpcode.TRADE_REQUEST, target]);
}
/** Right-click > Look: a world entity by id16, or a player (entityId 0) by guid. */
export function buildLookAtMessage(entityId: number, pid: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.LOOK_AT);
  w.u32(entityId);
  w.u8(pid);
  return w.build();
}
export function buildTradeReplyMessage(id: number, accept: boolean): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.TRADE_REPLY);
  w.u32(id);
  w.u8(accept ? 1 : 0);
  return w.build();
}
export function buildTradeOfferMessage(
  id: number,
  revision: number,
  iid: number,
  uid: number,
  count: number,
): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.TRADE_OFFER);
  w.u32(id);
  w.u32(revision);
  w.u16(iid);
  w.u8(uid);
  w.u8(count);
  return w.build();
}
export function buildTradeAcceptMessage(id: number, revision: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.TRADE_ACCEPT);
  w.u32(id);
  w.u32(revision);
  return w.build();
}
export function buildTradeCancelMessage(id: number): Uint8Array {
  const w = new BinaryWriter();
  w.u8(ClientOpcode.TRADE_CANCEL);
  w.u32(id);
  return w.build();
}
