// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Wire protocol for the Prevast server, bot side.
//
// Mirrors opcodes.h and the message shapes in client.js. Every frame is BINARY,
// both directions, as of 2026-08-12: [u8 opcode][payload], little-endian,
// tightly packed, strings as [u16 byteLength][UTF-8 bytes]. Outgoing frames
// used to be JSON arrays on TEXT frames; the game port refuses those now.
//
// The first client frame must begin with 30 (protocolgame.h
// protocol_identifier) or ServicePort::make_protocol never selects the game
// protocol. That byte is NOT a ClientOp -- 30 is REQUEST_TEAM_JOIN in the
// in-game opcode space; the two spaces only meet on the first frame.
//
// Payload sizes must match clientPayloadBytes() in opcodes.h exactly. The
// server length-checks a packet before decoding it and drops one that is the
// wrong size in EITHER direction, so a builder that is one byte off is not
// lenient, it is silently ignored.

#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

namespace bot::proto {

inline constexpr int GAME_PROTOCOL_IDENTIFIER = 30;

enum class ClientOp : uint8_t {
	// Connection
	PING = 0,
	REQUEST_CONTENT = 1,

	// Movement and combat
	MOVE = 10,
	ROTATE = 11,
	FACE = 12,
	ATTACK_START = 13,
	ATTACK_STOP = 14,
	SPRINT = 15,
	AIM = 16,
	RELOAD = 17,

	// Items
	EQUIP_ITEM = 20,
	DROP_ITEM = 21,
	STACK_ITEM = 22,
	SPLIT_ITEM = 23,
	PICK_UP_LOOT = 24,
	FIT_WEAPON_MOD = 25,

	// Interaction and containers
	INTERACT = 30,
	CLOSE_CONTAINER = 31,
	STORE_ITEM = 32,
	TAKE_ITEM = 33,
	MOVE_CONTAINER_ITEM = 34,
	LOOK_AT = 35,

	// Building and crafting
	PLACE_BUILDING = 40,
	CRAFT_AT_STATION = 41,
	CRAFT_BY_HAND = 42,
	CANCEL_CRAFT = 43,
	TAKE_FROM_STATION = 44,
	ADD_FUEL = 45,
	UNLOCK_SKILL = 46,

	// Chat and social
	CHAT_LOCAL = 50,
	SEND_CHAT = 51,
	BLOCK_PLAYER = 52,
	SET_PRIVATE_MESSAGES = 53,

	// Teams
	CREATE_TEAM = 60,
	DELETE_TEAM = 61,
	REQUEST_TEAM_JOIN = 62,
	ACCEPT_TEAM_JOIN = 63,
	KICK_FROM_TEAM = 64,
	LOCK_TEAM = 65,
	UNLOCK_TEAM = 66,
	LEAVE_TEAM = 67,
	INVITE_TO_TEAM = 68,
	ACCEPT_TEAM_INVITE = 69,

	// Trade and NPCs
	TRADE_REQUEST = 70,
	TRADE_REPLY = 71,
	TRADE_OFFER = 72,
	TRADE_ACCEPT = 73,
	TRADE_CANCEL = 74,
	NPC_ACTION = 75,

	// Quests
	QUEST_ACTION = 80,
};

enum class ServerOp : uint8_t {
	// Connection and session
	HANDSHAKE = 0,
	BATCH = 1,
	PONG = 2,
	ALERT = 3,
	DISCONNECT_REASON = 4,
	SESSION_TAKEN = 5,
	STATUS_MESSAGE = 6,
	SERVER_LOG = 7,

	// Content
	CONTENT_MANIFEST = 10,
	CONTENT_TABLE = 11,
	CONTENT_PATCH = 12,

	// World
	ENTITY_UPDATES = 20,
	MAP_SIZE = 21,
	WORLD_TIME = 22,
	CITY_LOCATIONS = 23,
	LEADERBOARD = 24,
	DAMAGE_INDICATOR = 25,
	EXPLOSION_SHAKE = 26,
	OVERHEAD_ALERT = 27,
	PLAYER_HIT = 28,
	PLAYER_HEALED = 29,
	PLAYER_ATE = 30,
	PLAYER_DIED = 31,

	// Players
	PLAYER_INFO = 40,
	PLAYER_NAMES = 41,
	GROUPS = 42,
	BLOCKED_PLAYERS = 43,
	PLAYER_POSITIONS = 44,
	WORST_KARMA_PLAYER = 45,

	// Your character
	YOU_DIED = 50,
	GAUGE_VALUES = 51,
	GAUGE_RATES = 52,
	GAUGE_DIRECTIONS = 53,
	STAMINA = 54,
	SCORE = 55,
	XP = 56,
	LEVEL_STATE = 57,
	SKILL_UNLOCKED = 58,
	KARMA = 59,
	POISONED = 60,
	REPELLENT_ACTIVE = 61,
	LAPADONE_ACTIVE = 62,
	DRUG_RESET = 63,
	COUNTDOWN = 64,
	AIM_STATE = 65,
	INTERACTION_STARTED = 66,
	INTERACTION_CANCELLED = 67,

	// Inventory
	INVENTORY = 80,
	INVENTORY_SLOT = 81,
	ITEM_MODS = 82,
	SELECTED_ITEM = 83,
	WRONG_TOOL = 84,

	// Crafting and stations
	BLUEPRINT = 90,
	CRAFT_STARTED = 91,
	STATION_OPENED = 92,
	STATION_CLOSED = 93,
	STATION_FUEL = 94,
	CONTAINER_CONTENTS = 95,

	// Teams
	TEAM_CREATED = 100,
	TEAM_NAMES = 101,
	TEAM_DELETED = 102,
	TEAM_JOIN_REQUEST = 103,
	TEAM_MEMBER_JOINED = 104,
	TEAM_MEMBER_LEFT = 105,
	TEAM_INVITE = 106,
	TEAM_LOCKED = 107,

	// Chat
	CHAT_LINE = 110,
	CHAT_ACCESS = 111,

	// Trade and NPCs
	TRADE_STATE = 120,
	TRADE_CLOSED = 121,
	NPC_STATE = 122,
	NPC_CLOSED = 123,

	// Quests, progress and account
	QUEST_STATE = 130,
	QUEST_PROGRESS = 131,
	QUEST_MARKERS = 132,
	PROGRESS_STATE = 133,
	PROGRESS_UPDATE = 134,
	ACHIEVEMENT_UNLOCKED = 135,
	ACCOUNT_RUN = 136,
	ACCOUNT_CLANS = 137,
};

// ServerOp::BATCH envelope: [BATCH][0] then, repeated, [u16 length LE][length
// bytes]. Each payload is byte-identical to the frame that message would have
// arrived as unbatched, so a receiver unwraps by re-dispatching each slice.
// Ignoring this opcode does not lose one message, it loses a whole tick's
// worth. See opcodes.h and ProtocolGame::flushBatch.
inline constexpr size_t BATCH_HEADER_BYTES = 2;
inline constexpr size_t BATCH_SUBHEADER_BYTES = 2;

// Move mask bits (client.js sendMove).
inline constexpr int MOVE_LEFT = 1;
inline constexpr int MOVE_RIGHT = 2;
inline constexpr int MOVE_DOWN = 4;
inline constexpr int MOVE_UP = 8;

inline constexpr int MOUSE_LEFT = 0;
inline constexpr int MOUSE_RIGHT = 1;

// Entity type ids as they appear in a ENTITY_UPDATES record's `type` field.
inline constexpr uint8_t TYPE_PLAYER = 0;
inline constexpr uint8_t TYPE_LOOT = 1;
inline constexpr uint8_t TYPE_PROJECTILE = 2;
inline constexpr uint8_t TYPE_AGENT = 13;

// --- outgoing (binary) -----------------------------------------------------
//
// Frames are built into a std::string used as a byte buffer, which is what the
// websocket send path already takes. Every packet here is at most a few bytes,
// so there is nothing to pool.

inline void putU8(std::string& out, uint8_t v) { out.push_back(static_cast<char>(v)); }

inline void putU16(std::string& out, uint16_t v)
{
	out.push_back(static_cast<char>(v & 0xFF));
	out.push_back(static_cast<char>((v >> 8) & 0xFF));
}

inline void putU32(std::string& out, uint32_t v)
{
	out.push_back(static_cast<char>(v & 0xFF));
	out.push_back(static_cast<char>((v >> 8) & 0xFF));
	out.push_back(static_cast<char>((v >> 16) & 0xFF));
	out.push_back(static_cast<char>((v >> 24) & 0xFF));
}

// [u16 byteLength][bytes]. The bot's strings (token, nickname, chat commands)
// are ASCII it generates itself, so they are already valid UTF-8.
inline void putString(std::string& out, std::string_view s)
{
	putU16(out, static_cast<uint16_t>(s.size()));
	out.append(s);
}

// [u8 30][u16 protocolVersion][str token][u32 tokenId][u32 playerId]
// [str nickname][u8 adBlocker][str password][str accountTicket]
//
// Version 0 is the harness's long-standing exemption from the client version
// gate (`data.version != 0 && ...` in onRecvFirstMessage): the bot is not the
// shipped client and should not need rebuilding for every wire bump.
//
// `skin` is accepted and ignored -- the skin is server state, owned by the
// equipped wearable, and is no longer on the wire at all.
inline std::string login(std::string_view token, std::string_view nickname,
                         int /*skin*/, std::string_view password)
{
	std::string s;
	s.reserve(32 + token.size() + nickname.size() + password.size());
	putU8(s, GAME_PROTOCOL_IDENTIFIER);
	putU16(s, 0);
	putString(s, token);
	putU32(s, 0); // tokenId
	putU32(s, 0); // playerId
	putString(s, nickname);
	putU8(s, 0);  // adBlocker
	putString(s, password);
	putString(s, {}); // accountTicket: empty = guest
	return s;
}

inline std::string op0(ClientOp op)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(op));
	return s;
}

inline std::string opU8(ClientOp op, uint8_t a)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(op));
	putU8(s, a);
	return s;
}

inline std::string ping()                  { return op0(ClientOp::PING); }
inline std::string mouseDown()             { return op0(ClientOp::ATTACK_START); }
inline std::string mouseUp()               { return op0(ClientOp::ATTACK_STOP); }
inline std::string reload()                { return op0(ClientOp::RELOAD); }
inline std::string move(int mask)          { return opU8(ClientOp::MOVE, static_cast<uint8_t>(mask)); }
inline std::string shift(bool on)          { return opU8(ClientOp::SPRINT, on ? 1 : 0); }
inline std::string mouseDirection(int dir) { return opU8(ClientOp::FACE, static_cast<uint8_t>(dir)); }

// Degrees, 0-359. The server rejects anything outside that range outright now,
// so the normalisation here is load-bearing rather than tidiness.
inline std::string rotation(int degrees)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::ROTATE));
	putU16(s, static_cast<uint16_t>(((degrees % 360) + 360) % 360));
	return s;
}

inline std::string takeLoot(uint32_t lootId)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::PICK_UP_LOOT));
	putU32(s, lootId);
	return s;
}

inline std::string chat(std::string_view text)
{
	std::string s;
	s.reserve(3 + text.size());
	putU8(s, static_cast<uint8_t>(ClientOp::CHAT_LOCAL));
	putString(s, text);
	return s;
}

// [u16 iid][u8 count][u32 uid][u8 ammo]. The server reads iid and uid.
inline std::string equipItem(int iid, int uid)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::EQUIP_ITEM));
	putU16(s, static_cast<uint16_t>(iid));
	putU8(s, 0);
	putU32(s, static_cast<uint32_t>(uid) & 0xFF);
	putU8(s, 0);
	return s;
}

// [u16 iid][u8 count][u32 uid][u8 ammo]. The server reads iid, count and uid.
inline std::string throwItem(int iid, int count, int uid)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::DROP_ITEM));
	putU16(s, static_cast<uint16_t>(iid));
	putU8(s, static_cast<uint8_t>(count));
	putU32(s, static_cast<uint32_t>(uid));
	putU8(s, 0);
	return s;
}

// --- incoming (binary) -----------------------------------------------------

// One 18-byte record of a ENTITY_UPDATES frame (ProtocolGame::flushUpdates).
// state == 0 is a removal.
//
// `id` is 24 bits and arrives SPLIT: the low 16 at an even offset (client.js
// can only read a uint16 there) and the high 8 in byte 1, which used to carry
// `uid`. uid is gone -- the server's id pool issues globally unique ids, so an
// id identifies an entity on its own. See WIRE ENCODING in definitions.h.
struct UnitRecord {
	uint8_t pid;
	uint8_t rotation;
	uint8_t type;
	uint16_t state;
	uint32_t id;
	uint16_t startX;
	uint16_t startY;
	uint16_t endX;
	uint16_t endY;
	uint16_t extra;
};

inline constexpr size_t UNIT_RECORD_BYTES = 18;
inline constexpr size_t UNITS_HEADER_BYTES = 2;

inline uint16_t readU16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return v; }

// Decodes record `i` of a ENTITY_UPDATES frame. The caller has already bounds-checked
// via unitRecordCount.
inline UnitRecord unitRecord(const uint8_t* data, size_t i)
{
	const uint8_t* p = data + UNITS_HEADER_BYTES + i * UNIT_RECORD_BYTES;
	UnitRecord r;
	r.pid      = p[0];
	r.rotation = p[2];
	r.type     = p[3];
	r.state    = readU16(p + 4);
	r.id       = static_cast<uint32_t>(readU16(p + 6)) | (static_cast<uint32_t>(p[1]) << 16);
	r.startX   = readU16(p + 8);
	r.startY   = readU16(p + 10);
	r.endX     = readU16(p + 12);
	r.endY     = readU16(p + 14);
	r.extra    = readU16(p + 16);
	return r;
}

inline size_t unitRecordCount(size_t frameBytes)
{
	return frameBytes < UNITS_HEADER_BYTES ? 0
	     : (frameBytes - UNITS_HEADER_BYTES) / UNIT_RECORD_BYTES;
}

inline bool unitsIsLogin(const uint8_t* data, size_t n) { return n > 1 && data[1] == 0x01; }

struct Handshake {
	uint8_t ownGuid;
	uint16_t unitsPerPlayer;
	uint8_t playerCount;
	uint8_t modeId;
};

// HANDSHAKE head: op, ownGuid, unitsPerPlayer(u16), playerCount, modeId -- 6
// bytes, then one 10-byte entry per player.
//
// The head was 8 bytes until 2026-08-12: a u16 `timeSync` sat where the roster
// now starts. ServerOpcode::WORLD_TIME carries the clock instead.
inline bool parseHandshake(const uint8_t* data, size_t n, Handshake& out)
{
	if (n < 6) return false;
	out.ownGuid        = data[1];
	out.unitsPerPlayer = readU16(data + 2);
	out.playerCount    = data[4];
	out.modeId         = data[5];
	return true;
}

struct ItemSlot {
	uint16_t iid;  // 0 = the slot is now empty
	uint8_t count;
	uint8_t uid;   // low byte only, which is all the protocol carries
	uint8_t ammo;
};

// INVENTORY_SLOT: [INVENTORY_SLOT][u8 uid][u16 iid LE][u8 count][u8 ammo]. One slot's
// complete contents, keyed by the uid -- it replaced NEW_ITEM, DELETE_ITEM and
// the REPLACE_* family, so callers wanting "an item arrived" want iid != 0.
inline bool parseInventorySlot(const uint8_t* data, size_t n, ItemSlot& out)
{
	if (n < 6) return false;
	out.uid = data[1];
	out.iid = static_cast<uint16_t>(data[2] | (data[3] << 8));
	out.count = data[4];
	out.ammo = data[5];
	return true;
}

// INVENTORY: [15, (u16 iid, count, uid, ammo) x slotCount] -- FIVE bytes
// per slot, all-zero for an empty one (sendFullInventory).
//
// This is the only reliable way for a bot to learn the uid of a stackable item
// it already holds. Waiting for an INVENTORY_SLOT is not: addItem stacks into
// an existing slot before it occupies an empty one, so asking for an item the
// starting kit already granted restates a slot the bot never saw created, and
// a bot waiting for a first sighting waits forever.
inline constexpr size_t FULL_INVENTORY_SLOT_BYTES = 5;

inline size_t inventorySlotCount(size_t frameBytes)
{
	return frameBytes < 1 ? 0 : (frameBytes - 1) / FULL_INVENTORY_SLOT_BYTES;
}

inline ItemSlot inventorySlot(const uint8_t* data, size_t i)
{
	const uint8_t* p = data + 1 + i * FULL_INVENTORY_SLOT_BYTES;
	return ItemSlot{ static_cast<uint16_t>(p[0] | (p[1] << 8)), p[2], p[3], p[4] };
}

} // namespace bot::proto
