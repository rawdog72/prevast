// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export const GAME_PROTOCOL_IDENTIFIER = 30;
/** Must equal CLIENT_VERSION_MIN..MAX in apps/server/src/core/definitions.h. */
export const PROTOCOL_VERSION = 1417;

export const ClientOpcode = {
  PING_MESSAGE: 0,
  CHAT_MESSAGE: 1,
  MOVE: 2,
  MOUSE_DIRECTION: 3,
  MOUSE_DOWN: 4,
  MOUSE_UP: 5,
  ROTATION: 6,
  SHIFT: 7,
  EQUIP_ITEM: 8,
  THROW_ITEM: 9,
  STACK_ITEM: 10,
  SPLIT_ITEM: 11,
  TAKE_LOOT: 12,
  RELOAD: 13,
  PLACE_OBJECT: 14,
  OPEN_STATION_15: 15,
  OPEN_STATION_16: 16,
  CLOSE_CONTAINER: 17,
  START_CRAFT_STATION: 18,
  TAKE_FROM_STATION: 19,
  UNLOCK_SKILL: 21,
  START_CRAFT_MANUAL: 22,
  CANCEL_CRAFT: 23,
  ADD_FUEL: 24, // [u8 amount], 1..254
  OPEN_CONTAINER: 25,
  STORE_ITEM: 26,
  TAKE_ITEM: 27,
  CREATE_TEAM: 28,
  DELETE_TEAM: 29,
  REQUEST_JOIN_TEAM: 30,
  ACCEPT_JOIN_TEAM: 31,
  KICK_TEAM: 32,
  LOCK_TEAM: 33,
  UNLOCK_TEAM: 34,
  LEAVE_TEAM: 35,
  INTERACT_LAMP: 36,
  INTERACT_SWITCH: 37,
  INTERACT_TIMER: 38,
  CONTENT_REQUEST: 39,
  /** [channel u8][target u8][str text] -- target = peer guid for PRIVATE, else 0. */
  CHAT_CHANNEL: 40,
  NPC_ACTION: 47,
  TRADE_REQUEST: 41,
  TRADE_REPLY: 42,
  TRADE_OFFER: 43,
  TRADE_ACCEPT: 44,
  TRADE_CANCEL: 45,
  /** [entityId u32][pid u8]; entityId 0 = the player with guid pid. */
  LOOK_AT: 46,
  /** [from u8][to u8] -- swap two slots of the open container. */
  MOVE_CONTAINER_ITEM: 48,
  /** [guid u8][blocked u8] -- 1 blocks that player's chat to us, 0 lifts it. */
  BLOCK_PLAYER: 49,
  /** [guid u8] -- the clan leader invites a player with no clan. */
  INVITE_TEAM: 50,
  /** [clanId u8] -- take up that clan's invitation. */
  ACCEPT_TEAM_INVITE: 51,
  /** [policy u8] -- PrivateMessagePolicy: who may message us privately. */
  PRIVATE_MESSAGES: 52,
  /** [questId u16][action u8] -- QuestAction: abandon a quest, or ask for a resync. */
  QUEST_ACTION: 53,
  /** [weaponUid u8][slot u8][fit u8][modUid u8] -- fit 1 fits/swaps that mod in, fit 0 removes what is in the slot. */
  WEAPON_MOD: 54,
  /** [held u8] -- 1 while the aim button is held, 0 on release. */
  AIM: 55,
} as const;

/** ClientOpcode.PRIVATE_MESSAGES values (wire format, never renumbered). */
export const PrivateMessagePolicy = {
  EVERYONE: 0,
  CLAN: 1,
  NOBODY: 2,
} as const;

export type ClientOpcode = (typeof ClientOpcode)[keyof typeof ClientOpcode];

export const ServerOpcode = {
  UNITS: 0,
  OLD_VERSION: 1,
  FULL: 2,
  PLAYER_DIE: 3,
  OTHER_DIE: 4,
  FAIL_RESTORE_SESSION: 5,
  STOLE_YOUR_SESSION: 6,
  MUTE: 7,
  LEADERBOARD: 8,
  HANDSHAKE: 9,
  KICK_INACTIVITY: 10,
  NOTIFICATION: 11,
  GAUGES: 12,
  SCORE: 13,
  PLAYER_HIT: 14,
  FULL_INVENTORY: 15,
  PLAYER_LIFE: 18,
  SELECTED_ITEM: 20,
  PLAYER_HEAL: 22,
  PLAYER_STAMINA: 29,
  START_INTERACTION: 35,
  INTERRUPT_INTERACTION: 36,
  BLUEPRINT: 38,
  PLAYER_XP: 41,
  PLAYER_XP_SKILL: 42,
  BOUGHT_SKILL: 43,
  START_CRAFT: 44,
  LOST_BUILDING: 45,
  OPEN_BUILDING: 46, // station/queue fields, then [u8 fuel units][u32 fuelMs]
  NEW_FUEL_VALUE: 47, // [u8 fuel units][u32 fuelMs]
  WRONG_TOOL: 52,
  FULL_CHEST: 53,
  ACCEPTED_TEAM: 54,
  KICKED_TEAM: 55,
  DELETE_TEAM: 56,
  JOIN_TEAM: 57,
  TEAM_POSITION: 58,
  KARMA: 59,
  BAD_KARMA: 60,
  AREAS: 61,
  WRONG_PASSWORD: 62,
  MODDED_GAUGES_VALUES: 63,
  SHAKE_EXPLOSION_STATE: 64,
  PLAYER_EAT: 65,
  CITIES_LOCATION: 66,
  POISONED: 67,
  REPELLENT: 68,
  LAPADOINE: 69,
  RESET_DRUG: 70,
  DRAMATIC_CHRONO: 71,
  MAP_SIZE: 74,
  BATCH: 75,
  /** Retired: every chat line is CHAT_CHANNEL now. Number reserved. */
  CHAT: 76,
  PLAYER_INFO: 77,
  NICKNAMES: 78,
  ALERT: 79,
  TEAM_CREATED: 80,
  TEAM_NAMES: 81,
  PONG: 82,
  GAUGE_STATE: 83,
  INVENTORY_SLOT: 84,
  WORLD_TIME: 85,
  DAMAGE_INDICATOR: 86,
  CONTENT_MANIFEST: 87,
  CONTENT_TABLE: 88,
  CONTENT_PATCH: 89,
  /** [channel u8][from u8][peer u8][flags u8][str text]; from 255 = a line the server wrote. */
  CHAT_CHANNEL: 90,
  /** [kind u8][a u8][b u8][str text] -- a server-wide event for the Server tab. */
  SERVER_LOG: 91,
  /** [mask u8] -- bit (1 << channel) set = this player may write there. */
  CHAT_ACCESS: 92,
  TRADE_STATE: 93,
  NPC_STATE: 95,
  NPC_CLOSED: 96,
  TRADE_CLOSED: 94,
  GROUPS: 97,
  /** [kind u8][str text] -- one line on the status line over the hotbar. */
  STATUS_MESSAGE: 98,
  /** [reason u8][str detail] -- why the server is closing this socket; see DisconnectReason. */
  DISCONNECT_REASON: 99,
  /** [count u8][guid u8]*count -- the players we have blocked who are online, the whole list. */
  BLOCKED_PLAYERS: 100,
  /** [clanId u8][inviterGuid u8] -- that clan's leader invites us. */
  TEAM_INVITE: 101,
  /** [clanId u8][locked u8] -- a locked clan takes invitations only, no join requests. */
  TEAM_LOCKED: 102,
  /** [questId u16][cause u8][str json] -- one quest's journal entry (quest-protocol.ts). */
  QUEST_STATE: 103,
  /** [questId u16][objective u8][count u32] -- a counter of the current stage. */
  QUEST_PROGRESS: 104,
  /** [n u8]([npcId u16][kind u8])*n -- which NPCs have quest business with us. */
  QUEST_MARKERS: 105,
  /** [str json] -- the account's stats and achievements from scratch (progress-protocol.ts). */
  PROGRESS_STATE: 106,
  /** [n u8]([statId u16][value u32])*n -- stats that changed. */
  PROGRESS_UPDATE: 107,
  /** [achievementId u16][at u32][str json {name, description}] -- just unlocked. */
  ACHIEVEMENT_UNLOCKED: 108,
  /** [uid u8][n u8]([slot u8][modIid u16])*n -- the complete fitted list of one inventory item. */
  ITEM_MODS: 109,
  /** [active u8][viewX u16][viewY u16] -- aiming turned on or off; the server's maxViewportX/Y. */
  AIM_STATE: 110,
  ACCOUNT_RUN: 111,
  ACCOUNT_CLANS: 112,
} as const;

export type ServerOpcode = (typeof ServerOpcode)[keyof typeof ServerOpcode];

/** PLAYER_INFO identityFlags bit: the player proved an account. */
export const IDENTITY_FLAG_VERIFIED = 1;

export const GaugeDirection = {
  HOLD: 0,
  RISE: 1,
  FALL: 2,
} as const;

export type GaugeDirection = (typeof GaugeDirection)[keyof typeof GaugeDirection];

export const GaugeSlot = {
  LIFE: 0,
  FOOD: 1,
  WARMTH: 2,
  STAMINA: 3,
  RADIATION: 4,
} as const;

export type GaugeSlot = (typeof GaugeSlot)[keyof typeof GaugeSlot];

export const GAUGE_SLOTS = ['life', 'food', 'warmth', 'stamina', 'radiation'] as const;
export type GaugeSlotName = (typeof GAUGE_SLOTS)[number];

export const MoveMask = {
  NONE: 0,
  LEFT: 1,
  RIGHT: 2,
  DOWN: 4,
  UP: 8,
} as const;

export type MoveMask = number;

export const MouseDirection = {
  LEFT: 0,
  RIGHT: 1,
} as const;

export type MouseDirection = (typeof MouseDirection)[keyof typeof MouseDirection];

export const ChatChannel = {
  LOCAL: 0,
  GLOBAL: 1,
  CLAN: 2,
  ADMIN: 3,
  PRIVATE: 4,
} as const;

export type ChatChannel = (typeof ChatChannel)[keyof typeof ChatChannel];

/** CHAT_CHANNEL `flags`: the speaker is an admin. */
export const CHAT_FLAG_ADMIN = 1;
/** `from` of a CHAT_CHANNEL line the server wrote itself. */
export const CHAT_SYSTEM_PID = 255;
/** `b` of a DEATH log when no player did it. */
export const SERVER_LOG_NO_PLAYER = 255;

export const ServerLogKind = {
  JOIN: 0,
  LEAVE: 1,
  DEATH: 2,
  CLAN_CREATED: 3,
  CLAN_DISBANDED: 4,
  CLAN_JOINED: 5,
  CLAN_LEFT: 6,
  CLAN_KICKED: 7,
  BROADCAST: 8,
  SYSTEM: 9,
} as const;

export type ServerLogKind = (typeof ServerLogKind)[keyof typeof ServerLogKind];

/** STATUS_MESSAGE kinds: plain information, or something that could not be done. */
export const StatusKind = {
  INFO: 0,
  FAILURE: 1,
} as const;

export type StatusKind = (typeof StatusKind)[keyof typeof StatusKind];

/** DISCONNECT_REASON codes; wire values, must match DisconnectReason in opcodes.h. */
export const DisconnectReason = {
  OTHER: 0,
  SERVER_FULL: 1,
  SERVER_CLOSED: 2,
  STARTING_UP: 3,
  MAINTENANCE: 4,
  SHUTTING_DOWN: 5,
  INVALID_LOGIN: 6,
  IP_BANNED: 7,
  TOO_MANY_FROM_IP: 8,
  ADMIN_AUTH_REQUIRED: 9,
  SPAWN_FAILED: 10,
  KICKED: 11,
  IDLE: 12,
  LOGGED_IN_ELSEWHERE: 13,
  PLAYER_LIMIT_LOWERED: 14,
  ACCOUNT_REQUIRED: 15,
} as const;

export type DisconnectReason = (typeof DisconnectReason)[keyof typeof DisconnectReason];
