// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

export const GAME_PROTOCOL_IDENTIFIER = 30;
/** Must equal CLIENT_VERSION_MIN..MAX in apps/server/src/core/definitions.h. */
export const PROTOCOL_VERSION = 1418;

/**
 * Client -> server opcodes, grouped by area. Payload layouts are documented in
 * apps/server/src/network/opcodes.h, which this file mirrors.
 */
export const ClientOpcode = {
  // Connection
  PING: 0,
  REQUEST_CONTENT: 1,

  // Movement and combat
  MOVE: 10,
  ROTATE: 11,
  FACE: 12,
  ATTACK_START: 13,
  ATTACK_STOP: 14,
  SPRINT: 15,
  AIM: 16,
  RELOAD: 17,

  // Items
  EQUIP_ITEM: 20,
  DROP_ITEM: 21,
  STACK_ITEM: 22,
  SPLIT_ITEM: 23,
  PICK_UP_LOOT: 24,
  FIT_WEAPON_MOD: 25,

  // Interaction and containers
  INTERACT: 30,
  CLOSE_CONTAINER: 31,
  STORE_ITEM: 32,
  TAKE_ITEM: 33,
  MOVE_CONTAINER_ITEM: 34,
  LOOK_AT: 35,

  // Building and crafting
  PLACE_BUILDING: 40,
  CRAFT_AT_STATION: 41,
  CRAFT_BY_HAND: 42,
  CANCEL_CRAFT: 43,
  TAKE_FROM_STATION: 44,
  ADD_FUEL: 45,
  UNLOCK_SKILL: 46,

  // Chat and social
  CHAT_LOCAL: 50,
  SEND_CHAT: 51,
  BLOCK_PLAYER: 52,
  SET_PRIVATE_MESSAGES: 53,

  // Teams
  CREATE_TEAM: 60,
  DELETE_TEAM: 61,
  REQUEST_TEAM_JOIN: 62,
  ACCEPT_TEAM_JOIN: 63,
  KICK_FROM_TEAM: 64,
  LOCK_TEAM: 65,
  UNLOCK_TEAM: 66,
  LEAVE_TEAM: 67,
  INVITE_TO_TEAM: 68,
  ACCEPT_TEAM_INVITE: 69,

  // Trade and NPCs
  TRADE_REQUEST: 70,
  TRADE_REPLY: 71,
  TRADE_OFFER: 72,
  TRADE_ACCEPT: 73,
  TRADE_CANCEL: 74,
  NPC_ACTION: 75,

  // Quests
  QUEST_ACTION: 80,
} as const;

/** ClientOpcode.SET_PRIVATE_MESSAGES values (wire format, never renumbered). */
export const PrivateMessagePolicy = {
  EVERYONE: 0,
  CLAN: 1,
  NOBODY: 2,
} as const;

export type ClientOpcode = (typeof ClientOpcode)[keyof typeof ClientOpcode];

/** Server -> client opcodes, grouped by area (layouts in opcodes.h). */
export const ServerOpcode = {
  // Connection and session
  HANDSHAKE: 0,
  BATCH: 1,
  PONG: 2,
  ALERT: 3,
  DISCONNECT_REASON: 4,
  SESSION_TAKEN: 5,
  STATUS_MESSAGE: 6,
  SERVER_LOG: 7,

  // Content
  CONTENT_MANIFEST: 10,
  CONTENT_TABLE: 11,
  CONTENT_PATCH: 12,

  // World
  ENTITY_UPDATES: 20,
  MAP_SIZE: 21,
  WORLD_TIME: 22,
  CITY_LOCATIONS: 23,
  LEADERBOARD: 24,
  DAMAGE_INDICATOR: 25,
  EXPLOSION_SHAKE: 26,
  OVERHEAD_ALERT: 27,
  PLAYER_HIT: 28,
  PLAYER_HEALED: 29,
  PLAYER_ATE: 30,
  PLAYER_DIED: 31,

  // Players
  PLAYER_INFO: 40,
  PLAYER_NAMES: 41,
  GROUPS: 42,
  BLOCKED_PLAYERS: 43,
  PLAYER_POSITIONS: 44,
  WORST_KARMA_PLAYER: 45,

  // Your character
  YOU_DIED: 50,
  GAUGE_VALUES: 51,
  GAUGE_RATES: 52,
  GAUGE_DIRECTIONS: 53,
  STAMINA: 54,
  SCORE: 55,
  XP: 56,
  LEVEL_STATE: 57,
  SKILL_UNLOCKED: 58,
  KARMA: 59,
  POISONED: 60,
  REPELLENT_ACTIVE: 61,
  LAPADONE_ACTIVE: 62,
  DRUG_RESET: 63,
  COUNTDOWN: 64,
  AIM_STATE: 65,
  INTERACTION_STARTED: 66,
  INTERACTION_CANCELLED: 67,

  // Inventory
  INVENTORY: 80,
  INVENTORY_SLOT: 81,
  ITEM_MODS: 82,
  SELECTED_ITEM: 83,
  WRONG_TOOL: 84,

  // Crafting and stations
  BLUEPRINT: 90,
  CRAFT_STARTED: 91,
  STATION_OPENED: 92,
  STATION_CLOSED: 93,
  STATION_FUEL: 94,
  CONTAINER_CONTENTS: 95,

  // Teams
  TEAM_CREATED: 100,
  TEAM_NAMES: 101,
  TEAM_DELETED: 102,
  TEAM_JOIN_REQUEST: 103,
  TEAM_MEMBER_JOINED: 104,
  TEAM_MEMBER_LEFT: 105,
  TEAM_INVITE: 106,
  TEAM_LOCKED: 107,

  // Chat
  CHAT_LINE: 110,
  CHAT_ACCESS: 111,

  // Trade and NPCs
  TRADE_STATE: 120,
  TRADE_CLOSED: 121,
  NPC_STATE: 122,
  NPC_CLOSED: 123,

  // Quests, progress and account
  QUEST_STATE: 130,
  QUEST_PROGRESS: 131,
  QUEST_MARKERS: 132,
  PROGRESS_STATE: 133,
  PROGRESS_UPDATE: 134,
  ACHIEVEMENT_UNLOCKED: 135,
  ACCOUNT_RUN: 136,
  ACCOUNT_CLANS: 137,
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

/** CHAT_LINE `flags`: the speaker is an admin. */
export const CHAT_FLAG_ADMIN = 1;
/** `from` of a CHAT_LINE line the server wrote itself. */
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
