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
// protocol. That byte is NOT a ClientOp -- 30 is REQUEST_JOIN_TEAM in the
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
	PING = 0,
	CHAT = 1,
	MOVE = 2,
	MOUSE_DIRECTION = 3,
	MOUSE_DOWN = 4,
	MOUSE_UP = 5,
	ROTATION = 6,
	SHIFT = 7,
	EQUIP_ITEM = 8,
	THROW_ITEM = 9,
	TAKE_LOOT = 12,
	RELOAD = 13,
};

enum class ServerOp : uint8_t {
	UNITS = 0,
	PLAYER_DIE = 3,
	HANDSHAKE = 9,
	FULL_INVENTORY = 15,
	BATCH = 75,
	INVENTORY_SLOT = 84,
	DAMAGE_INDICATOR = 86,
};

// ServerOp::BATCH envelope: [75][0] then, repeated, [u16 length LE][length
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

// Entity type ids as they appear in a UNITS record's `type` field.
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
// [str nickname][u8 adBlocker][str password]
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
inline std::string mouseDown()             { return op0(ClientOp::MOUSE_DOWN); }
inline std::string mouseUp()               { return op0(ClientOp::MOUSE_UP); }
inline std::string reload()                { return op0(ClientOp::RELOAD); }
inline std::string move(int mask)          { return opU8(ClientOp::MOVE, static_cast<uint8_t>(mask)); }
inline std::string shift(bool on)          { return opU8(ClientOp::SHIFT, on ? 1 : 0); }
inline std::string mouseDirection(int dir) { return opU8(ClientOp::MOUSE_DIRECTION, static_cast<uint8_t>(dir)); }

// Degrees, 0-359. The server rejects anything outside that range outright now,
// so the normalisation here is load-bearing rather than tidiness.
inline std::string rotation(int degrees)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::ROTATION));
	putU16(s, static_cast<uint16_t>(((degrees % 360) + 360) % 360));
	return s;
}

inline std::string takeLoot(uint32_t lootId)
{
	std::string s;
	putU8(s, static_cast<uint8_t>(ClientOp::TAKE_LOOT));
	putU32(s, lootId);
	return s;
}

inline std::string chat(std::string_view text)
{
	std::string s;
	s.reserve(3 + text.size());
	putU8(s, static_cast<uint8_t>(ClientOp::CHAT));
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
	putU8(s, static_cast<uint8_t>(ClientOp::THROW_ITEM));
	putU16(s, static_cast<uint16_t>(iid));
	putU8(s, static_cast<uint8_t>(count));
	putU32(s, static_cast<uint32_t>(uid));
	putU8(s, 0);
	return s;
}

// --- incoming (binary) -----------------------------------------------------

// One 18-byte record of a UNITS frame (ProtocolGame::flushUpdates).
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

// Decodes record `i` of a UNITS frame. The caller has already bounds-checked
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
// now starts. ServerOpcode::WORLD_TIME (85) carries the clock instead.
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

// INVENTORY_SLOT: [84][u8 uid][u16 iid LE][u8 count][u8 ammo]. One slot's
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

// FULL_INVENTORY: [15, (u16 iid, count, uid, ammo) x slotCount] -- FIVE bytes
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
