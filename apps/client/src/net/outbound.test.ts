// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

import { describe, expect, it } from 'vitest';
import {
  buildAcceptJoinTeamMessage,
  buildAddFuelMessage,
  buildCancelCraftMessage,
  buildChatMessage,
  buildChatChannelMessage,
  buildCloseContainerMessage,
  buildCreateTeamMessage,
  buildDeleteTeamMessage,
  buildEquipItemMessage,
  buildInteractMessage,
  buildKickTeamMessage,
  buildLeaveTeamMessage,
  buildInviteTeamMessage,
  buildAcceptTeamInviteMessage,
  buildBlockPlayerMessage,
  buildPrivateMessagesMessage,
  buildLockTeamMessage,
  buildLoginMessage,
  buildMouseDownMessage,
  buildMouseDirectionMessage,
  buildMouseUpMessage,
  buildMoveMessage,
  buildPingMessage,
  buildPlaceObjectMessage,
  buildReloadMessage,
  buildRequestJoinTeamMessage,
  buildRotationMessage,
  buildShiftMessage,
  buildSplitItemMessage,
  buildStackItemMessage,
  buildStartCraftManualMessage,
  buildStartCraftStationMessage,
  buildStoreItemMessage,
  buildMoveContainerItemMessage,
  buildTakeFromStationMessage,
  buildTakeItemMessage,
  buildTakeLootMessage,
  buildThrowItemMessage,
  buildUnlockSkillMessage,
  buildUnlockTeamMessage,
  buildWeaponModMessage,
} from './outbound';
import { ClientOpcode, GAME_PROTOCOL_IDENTIFIER, PROTOCOL_VERSION } from './opcodes';

describe('outbound encoders', () => {
  it('encodes login message with protocol identifier 30', () => {
    const msg = buildLoginMessage({ nickname: 'Dev' });
    expect(msg[0]).toBe(GAME_PROTOCOL_IDENTIFIER);
    // [30][ver u16][token 0,0][tokId 4][pId 4][nick 3,0, D,e,v][ad 0][pass 0,0][ticket 0,0]
    // length = 1 + 2 + 2 + 4 + 4 + 2 + 3 + 1 + 2 + 2 = 23
    expect(msg.length).toBe(23);
    expect(Array.from(msg.slice(1, 3))).toEqual([PROTOCOL_VERSION & 0xff, PROTOCOL_VERSION >> 8]);
    expect(Array.from(msg.slice(-4))).toEqual([0x00, 0x00, 0x00, 0x00]);
  });

  it('appends the account ticket to the login frame', () => {
    const bytes = buildLoginMessage({ nickname: 'A', accountTicket: 'T.S' });
    const tail = Array.from(bytes.slice(-5));
    expect(tail).toEqual([3, 0, 0x54, 0x2e, 0x53]);
    expect(bytes[1]! | (bytes[2]! << 8)).toBe(PROTOCOL_VERSION);
  });

  it('encodes simple 1-byte messages (0 args)', () => {
    expect(buildPingMessage()).toEqual(new Uint8Array([ClientOpcode.PING]));
    expect(buildMouseDownMessage()).toEqual(new Uint8Array([ClientOpcode.ATTACK_START]));
    expect(buildMouseUpMessage()).toEqual(new Uint8Array([ClientOpcode.ATTACK_STOP]));
    expect(buildReloadMessage()).toEqual(new Uint8Array([ClientOpcode.RELOAD]));
    expect(buildCloseContainerMessage()).toEqual(new Uint8Array([ClientOpcode.CLOSE_CONTAINER]));
    expect(buildCancelCraftMessage()).toEqual(new Uint8Array([ClientOpcode.CANCEL_CRAFT]));
    expect(buildDeleteTeamMessage()).toEqual(new Uint8Array([ClientOpcode.DELETE_TEAM]));
    expect(buildLockTeamMessage()).toEqual(new Uint8Array([ClientOpcode.LOCK_TEAM]));
    expect(buildUnlockTeamMessage()).toEqual(new Uint8Array([ClientOpcode.UNLOCK_TEAM]));
    expect(buildLeaveTeamMessage()).toEqual(new Uint8Array([ClientOpcode.LEAVE_TEAM]));
  });

  it('encodes 1-arg byte messages (1 byte payload)', () => {
    expect(buildAddFuelMessage(37)).toEqual(new Uint8Array([ClientOpcode.ADD_FUEL, 37]));
    expect(buildAddFuelMessage(254)).toEqual(new Uint8Array([ClientOpcode.ADD_FUEL, 254]));
    expect(buildMoveMessage(3)).toEqual(new Uint8Array([ClientOpcode.MOVE, 3]));
    expect(buildMouseDirectionMessage(1)).toEqual(
      new Uint8Array([ClientOpcode.FACE, 1]),
    );
    expect(buildShiftMessage(true)).toEqual(new Uint8Array([ClientOpcode.SPRINT, 1]));
    expect(buildTakeItemMessage(5)).toEqual(new Uint8Array([ClientOpcode.TAKE_ITEM, 5]));
    expect(buildTakeFromStationMessage(2)).toEqual(
      new Uint8Array([ClientOpcode.TAKE_FROM_STATION, 2]),
    );
    expect(buildRequestJoinTeamMessage(7)).toEqual(
      new Uint8Array([ClientOpcode.REQUEST_TEAM_JOIN, 7]),
    );
    expect(buildInviteTeamMessage(9)).toEqual(new Uint8Array([ClientOpcode.INVITE_TO_TEAM, 9]));
    expect(buildAcceptTeamInviteMessage(3)).toEqual(
      new Uint8Array([ClientOpcode.ACCEPT_TEAM_INVITE, 3]),
    );
  });

  it('rejects invalid fuel quantities instead of wrapping or truncating them', () => {
    for (const amount of [0, -1, 255, 256, 1.5, NaN, Infinity])
      expect(() => buildAddFuelMessage(amount)).toThrow(RangeError);
  });

  it('encodes SET_PRIVATE_MESSAGES as [policy u8]', () => {
    expect(buildPrivateMessagesMessage(2)).toEqual(
      new Uint8Array([ClientOpcode.SET_PRIVATE_MESSAGES, 2]),
    );
  });

  it('encodes BLOCK_PLAYER as [guid u8][blocked u8] (the server expects exactly 2 bytes)', () => {
    expect(buildBlockPlayerMessage(9, true)).toEqual(
      new Uint8Array([ClientOpcode.BLOCK_PLAYER, 9, 1]),
    );
    expect(buildBlockPlayerMessage(9, false)).toEqual(
      new Uint8Array([ClientOpcode.BLOCK_PLAYER, 9, 0]),
    );
  });

  it('encodes u16 payload messages (2 bytes payload)', () => {
    const rot = buildRotationMessage(180);
    expect(rot.length).toBe(3);
    expect(rot[0]).toBe(ClientOpcode.ROTATE);
    expect(rot[1]! | (rot[2]! << 8)).toBe(180);

    const craftStn = buildStartCraftStationMessage(42);
    expect(craftStn.length).toBe(3);
    expect(craftStn[0]).toBe(ClientOpcode.CRAFT_AT_STATION);
    expect(craftStn[1]! | (craftStn[2]! << 8)).toBe(42);

    const craftMan = buildStartCraftManualMessage(15);
    expect(craftMan.length).toBe(3);

    const skill = buildUnlockSkillMessage(8);
    expect(skill.length).toBe(3);
  });

  it('encodes u32 payload messages (4 bytes payload)', () => {
    const loot = buildTakeLootMessage(0x123456);
    expect(loot.length).toBe(5);
    expect(loot[0]).toBe(ClientOpcode.PICK_UP_LOOT);

    const accept = buildAcceptJoinTeamMessage(123);
    expect(accept.length).toBe(5);

    const kick = buildKickTeamMessage(456);
    expect(kick.length).toBe(5);
  });

  it('encodes composite fixed-payload messages', () => {
    // PLACE_BUILDING: 5 bytes payload -> total 6
    // PLACE_BUILDING: [opcode][rotation][u16 row i][u16 column j], the old client's
    // Writer(14).u8(buildRotate).u16(iBuild).u16(jBuild) -- row before column.
    const place = buildPlaceObjectMessage(2, 50, 60);
    expect(place.length).toBe(6);
    expect(place[0]).toBe(ClientOpcode.PLACE_BUILDING);
    expect(Array.from(place)).toEqual([ClientOpcode.PLACE_BUILDING, 2, 50, 0, 60, 0]);

    // INTERACT: 5 bytes payload -> total 6
    const interact = buildInteractMessage(999, 1);
    expect(interact.length).toBe(6);

    // SPLIT_ITEM: 7 bytes payload -> total 8
    const split = buildSplitItemMessage(10, 5, 20);
    expect(split.length).toBe(8);

    // EQUIP_ITEM: 8 bytes payload -> total 9
    const equip = buildEquipItemMessage(18, 1, 0, 0);
    expect(equip.length).toBe(9);

    // DROP_ITEM: 8 bytes payload -> total 9
    const thr = buildThrowItemMessage(18, 1, 1, 0);
    expect(thr.length).toBe(9);

    // STORE_ITEM: 9 bytes payload (the last is the container slot, 255 = first free) -> total 10
    const store = buildStoreItemMessage(18, 1, 1, 0);
    expect(store.length).toBe(10);
    expect(store[9]).toBe(255);
    expect(buildStoreItemMessage(18, 1, 1, 0, 3)[9]).toBe(3);
    expect([...buildMoveContainerItemMessage(2, 5)]).toEqual([ClientOpcode.MOVE_CONTAINER_ITEM, 2, 5]);

    // STACK_ITEM: 12 bytes payload -> total 13
    const stack = buildStackItemMessage(1, 10, 2, 5, 3);
    expect(stack.length).toBe(13);
  });

  it('encodes string payload messages', () => {
    const chat = buildChatMessage('test message');
    expect(chat[0]).toBe(ClientOpcode.CHAT_LOCAL);
    expect(chat.length).toBe(1 + 2 + 12);

    // [SEND_CHAT][channel][target][str]
    const channelChat = buildChatChannelMessage(4, 9, 'psst');
    expect(Array.from(channelChat.slice(0, 3))).toEqual([ClientOpcode.SEND_CHAT, 4, 9]);
    expect(channelChat.length).toBe(3 + 2 + 4);

    const team = buildCreateTeamMessage('Alpha');
    expect(team[0]).toBe(ClientOpcode.CREATE_TEAM);
    expect(team.length).toBe(1 + 2 + 5);
  });
});

describe('buildWeaponModMessage', () => {
  it('fits a mod: [FIT_WEAPON_MOD][weaponUid][slot][1][modUid]', () => {
    expect([...buildWeaponModMessage(7, 1, 3)]).toEqual([ClientOpcode.FIT_WEAPON_MOD, 7, 1, 1, 3]);
  });
  it('removes with fit 0, and 0 stays a real uid when fitting', () => {
    expect([...buildWeaponModMessage(7, 0, null)]).toEqual([ClientOpcode.FIT_WEAPON_MOD, 7, 0, 0, 0]);
    expect([...buildWeaponModMessage(7, 0, 0)]).toEqual([ClientOpcode.FIT_WEAPON_MOD, 7, 0, 1, 0]);
  });
});
