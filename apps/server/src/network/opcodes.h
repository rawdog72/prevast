// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <cstdint>

// ---------------------------------------------------------------------------
// Game protocol opcodes. Both directions are binary WebSocket frames; JSON is
// used only on the separate status port (ProtocolStatus).
//
// Client -> server:  [u8 opcode][payload]
//   Payloads are tightly packed, little-endian, with no padding; the server
//   reads them with NetworkMessage::get<T>(), which has no alignment rules.
//   Strings are [u16 byteLength][UTF-8 bytes]. Every payload has a fixed size
//   except the ones clientPayloadBytes() marks variable, so parsePacket can
//   bounds-check a packet once, up front, and refuse overlong ones too.
//
// Server -> client:  [u8 opcode][payload], or a BATCH envelope of several.
//   The client reads most messages with a DataView. A few older layouts are
//   read as 16-bit words and keep a pad byte after the opcode (MAP_SIZE,
//   CITY_LOCATIONS, ENTITY_UPDATES, SCORE, GAUGE_RATES); see each sender.
//
// Numbers are grouped by area, each group starting on a round number with
// room to grow. apps/client/src/net/opcodes.ts mirrors this file; change both
// together and bump CLIENT_VERSION_MIN/MAX and PROTOCOL_VERSION.
// ---------------------------------------------------------------------------

enum class ClientOpcode : uint8_t {
    // Connection
    PING = 0,                  // keepalive; answered with PONG
    REQUEST_CONTENT = 1,       // [str json]

    // Movement and combat
    MOVE = 10,                 // [u8 direction bitmask]
    ROTATE = 11,               // [u16 degrees 0-359]
    FACE = 12,                 // [u8 0 left, 1 right]
    ATTACK_START = 13,
    ATTACK_STOP = 14,
    SPRINT = 15,               // [u8 0 or 1]
    AIM = 16,                  // [u8 held]: 1 while the aim button is held, 0 on release
    RELOAD = 17,

    // Items
    EQUIP_ITEM = 20,           // [u16 iid][u8 count][u32 uid][u8 ammo]
    DROP_ITEM = 21,            // [u16 iid][u8 count][u32 uid][u8 ammo]
    STACK_ITEM = 22,           // [u16 dragIid][u8 dragCount][u32 dragUid][u8 targetCount][u32 targetUid]
    SPLIT_ITEM = 23,           // [u16 iid][u8 count][u32 uid]
    PICK_UP_LOOT = 24,         // [u32 entityId]
    FIT_WEAPON_MOD = 25,       // [u8 weaponUid][u8 slot][u8 fit][u8 modUid]; fit 0 removes (modUid ignored)

    // Interaction and containers
    INTERACT = 30,             // [u32 entityId][u8 pid]: use a door, station, container, lamp, switch or timer
    CLOSE_CONTAINER = 31,
    STORE_ITEM = 32,           // [u16 iid][u8 count][u32 uid][u8 ammo][u8 containerSlot], 255 = first free
    TAKE_ITEM = 33,            // [u8 containerSlot]
    MOVE_CONTAINER_ITEM = 34,  // [u8 from][u8 to]: swap two slots of the open container
    LOOK_AT = 35,              // [u32 entityId][u8 pid]; entityId 0 = the player with guid pid

    // Building and crafting
    PLACE_BUILDING = 40,       // [u8 rotation][u16 tileX][u16 tileY]
    CRAFT_AT_STATION = 41,     // [u16 iid]
    CRAFT_BY_HAND = 42,        // [u16 iid]
    CANCEL_CRAFT = 43,
    TAKE_FROM_STATION = 44,    // [u8 slot]
    ADD_FUEL = 45,             // [u8 amount], 1..254 fuel items
    UNLOCK_SKILL = 46,         // [u16 iid]

    // Chat and social
    CHAT_LOCAL = 50,           // [str text]: a LOCAL line (the stress bots still send it)
    SEND_CHAT = 51,            // [u8 channel][u8 target][str text]; target is the peer's guid for PRIVATE, else 0
    BLOCK_PLAYER = 52,         // [u8 guid][u8 blocked]
    SET_PRIVATE_MESSAGES = 53, // [u8 policy]: PrivateMessagePolicy

    // Teams
    CREATE_TEAM = 60,          // [str name]
    DELETE_TEAM = 61,
    REQUEST_TEAM_JOIN = 62,    // [u8 clanId]
    ACCEPT_TEAM_JOIN = 63,     // [u32 guid]
    KICK_FROM_TEAM = 64,       // [u32 guid]
    LOCK_TEAM = 65,
    UNLOCK_TEAM = 66,
    LEAVE_TEAM = 67,
    INVITE_TO_TEAM = 68,       // [u8 guid]: the leader invites a player with no clan
    ACCEPT_TEAM_INVITE = 69,   // [u8 clanId]

    // Trade and NPCs
    TRADE_REQUEST = 70,        // [u8 targetGuid]
    TRADE_REPLY = 71,          // [u32 session][u8 accept]
    TRADE_OFFER = 72,          // [u32 session][u32 revision][u16 iid][u8 uid][u8 count]; count 0 removes
    TRADE_ACCEPT = 73,         // [u32 session][u32 revision]
    TRADE_CANCEL = 74,         // [u32 session]
    NPC_ACTION = 75,           // [u32 session][u32 revision][u32 request][u8 action][u32 target][u32 amount][str text]

    // Quests
    QUEST_ACTION = 80,         // [u16 questId][u8 action]: QuestAction
};

// There is no login opcode. A connection's first frame starts with the
// protocol identifier (ProtocolGame::protocol_identifier = 30,
// ProtocolStatus = 0xFF), which ServicePort::make_protocol consumes before
// ProtocolGame::parseFirstMessage reads the rest.

// Payload size in bytes, excluding the opcode byte. -1 means variable length
// (the payload ends with a string) and is bounds-checked field by field. -2
// means the server does not accept the opcode. Keep this in step with the
// switch in ProtocolGame::parsePacket: a missing entry refuses the opcode,
// which is the safe direction to fail.
constexpr int clientPayloadBytes(ClientOpcode op)
{
    switch (op) {
    case ClientOpcode::PING:
    case ClientOpcode::ATTACK_START:
    case ClientOpcode::ATTACK_STOP:
    case ClientOpcode::RELOAD:
    case ClientOpcode::CLOSE_CONTAINER:
    case ClientOpcode::CANCEL_CRAFT:
    case ClientOpcode::DELETE_TEAM:
    case ClientOpcode::LOCK_TEAM:
    case ClientOpcode::UNLOCK_TEAM:
    case ClientOpcode::LEAVE_TEAM:
        return 0;

    case ClientOpcode::MOVE:
    case ClientOpcode::FACE:
    case ClientOpcode::SPRINT:
    case ClientOpcode::AIM:
    case ClientOpcode::TAKE_ITEM:
    case ClientOpcode::TAKE_FROM_STATION:
    case ClientOpcode::ADD_FUEL:
    case ClientOpcode::SET_PRIVATE_MESSAGES:
    case ClientOpcode::REQUEST_TEAM_JOIN:
    case ClientOpcode::INVITE_TO_TEAM:
    case ClientOpcode::ACCEPT_TEAM_INVITE:
    case ClientOpcode::TRADE_REQUEST:
        return 1;

    case ClientOpcode::ROTATE:
    case ClientOpcode::CRAFT_AT_STATION:
    case ClientOpcode::CRAFT_BY_HAND:
    case ClientOpcode::UNLOCK_SKILL:
    case ClientOpcode::MOVE_CONTAINER_ITEM:
    case ClientOpcode::BLOCK_PLAYER:
        return 2;

    case ClientOpcode::QUEST_ACTION:
        return 3;

    case ClientOpcode::PICK_UP_LOOT:
    case ClientOpcode::ACCEPT_TEAM_JOIN:
    case ClientOpcode::KICK_FROM_TEAM:
    case ClientOpcode::FIT_WEAPON_MOD:
    case ClientOpcode::TRADE_CANCEL:
        return 4;

    case ClientOpcode::INTERACT:
    case ClientOpcode::LOOK_AT:
    case ClientOpcode::PLACE_BUILDING:
    case ClientOpcode::TRADE_REPLY:
        return 5;

    case ClientOpcode::SPLIT_ITEM:
        return 7;

    case ClientOpcode::EQUIP_ITEM:
    case ClientOpcode::DROP_ITEM:
    case ClientOpcode::TRADE_ACCEPT:
        return 8;

    case ClientOpcode::STORE_ITEM:
        return 9;

    case ClientOpcode::STACK_ITEM:
    case ClientOpcode::TRADE_OFFER:
        return 12;

    case ClientOpcode::REQUEST_CONTENT:
    case ClientOpcode::CHAT_LOCAL:
    case ClientOpcode::SEND_CHAT:
    case ClientOpcode::CREATE_TEAM:
    case ClientOpcode::NPC_ACTION:
        return -1;
    }
    return -2;
}

enum class ServerOpcode : uint8_t {
    // --- Connection and session -------------------------------------------
    HANDSHAKE = 0,
    // Several complete messages in one frame:
    //     [BATCH][0] then, repeated: [u16 length LE][length bytes]
    // Byte 1 is reserved and keeps every sub-header at an even offset. Each
    // slice is byte-identical to the frame it would have been on its own, so
    // receivers unwrap by re-dispatching each one. ProtocolGame::flushBatch
    // never wraps a single message.
    BATCH = 1,
    PONG = 2,                  // answers PING; carries nothing
    ALERT = 3,                 // [str text], shown before a disconnect; every protocol version decodes it
    // [u8 reason][str detail], sent right before the server closes the socket
    // for a refused login or a kick. reason is DisconnectReason; detail holds
    // only variable data and the client owns the wording.
    DISCONNECT_REASON = 4,
    SESSION_TAKEN = 5,         // another login took over this character
    STATUS_MESSAGE = 6,        // [u8 kind][str text]: one line over the hotbar; kind is StatusKind
    SERVER_LOG = 7,            // [u8 kind][u8 a][u8 b][str text]: ServerLogKind, for the Server chat tab

    // --- Content ----------------------------------------------------------
    CONTENT_MANIFEST = 10,     // pre-join content manifest
    CONTENT_TABLE = 11,        // one content table
    CONTENT_PATCH = 12,        // a live hot-reload patch

    // --- World ------------------------------------------------------------
    ENTITY_UPDATES = 20,       // the per-tick entity records (18 bytes each)
    // World size in tiles. Sent first at login and again on resize, before any
    // entity record: the client sizes its tile matrix from it.
    MAP_SIZE = 21,
    // [u32 cycleMs LE][u32 phaseMs LE]: the day/night clock stated whole.
    // phaseMs is the position in the cycle; day is [0, half), night the rest.
    // Sent at login, at every boundary and every WorldClock::RESYNC_INTERVAL_MS.
    WORLD_TIME = 22,
    CITY_LOCATIONS = 23,
    LEADERBOARD = 24,
    DAMAGE_INDICATOR = 25,     // [u16 x][u16 y][i16 amount][u8 pct]; amount < 0 is damage, > 0 healing
    EXPLOSION_SHAKE = 26,      // [u8 shake]
    OVERHEAD_ALERT = 27,       // [u8 pid][u8 type][u8 level]: health, hunger, cold or radiation bubble
    PLAYER_HIT = 28,           // [u8 pid][u8 angle]
    PLAYER_HEALED = 29,        // [u8 pid]
    PLAYER_ATE = 30,
    PLAYER_DIED = 31,          // [u8 pid]: another player died

    // --- Players ----------------------------------------------------------
    // [u8 guid][u32 tokenId][u8 skin][u8 ghoul][str name][u8 groupId][u8 identityFlags]
    // groupId is data/XML/groups.xml's id; identityFlags bit 0 = verified account.
    PLAYER_INFO = 40,
    // The roster at login: [u16 slotCount][str name] * slotCount, then [str sessionToken].
    // Slot i is guid i; an empty slot is a zero-length string, which the
    // client turns back into 0 so its online count stays right.
    PLAYER_NAMES = 41,
    GROUPS = 42,               // [u8 count] then per group [u8 id][str name][str badge]; badge-less groups left out
    BLOCKED_PLAYERS = 43,      // [u8 count][u8 guid]*count: every blocked player online now
    PLAYER_POSITIONS = 44,     // repeated [u8 x][u8 y][u8 guid], positions scaled to 0..255 over the map
    WORST_KARMA_PLAYER = 45,   // [u8 guid][u8 x][u8 y][u8 karmaIcon]: the worst-karma player's position

    // --- Your character ---------------------------------------------------
    YOU_DIED = 50,
    GAUGE_VALUES = 51,
    // [u16 opcode][u16 * 15]: max, increase and decrease rates for life, food,
    // warmth, stamina and radiation. Read as 16-bit words, so the opcode is
    // written as a u16.
    GAUGE_RATES = 52,
    // [u16 packed LE]: two bits per gauge in GaugeSlot order, each a
    // GaugeDirection. One message, so the five directions can never be applied
    // out of order. See Player::flushGaugeDirections.
    GAUGE_DIRECTIONS = 53,
    STAMINA = 54,              // [u8 value]
    SCORE = 55,                // [u8 pad][u16 high][u16 low]
    XP = 56,
    LEVEL_STATE = 57,          // [u8 level][u32 xpInLevel BE][u8 unlocked iid]*
    SKILL_UNLOCKED = 58,       // [u8 iid low byte]
    KARMA = 59,                // [u8 icon]
    POISONED = 60,             // [u8 delaySec]
    REPELLENT_ACTIVE = 61,
    LAPADONE_ACTIVE = 62,
    DRUG_RESET = 63,           // [u8 withdrawn]
    COUNTDOWN = 64,            // [u8 tenSecondUnits], rounded up and capped at 255
    // [u8 active][u16 viewX][u16 viewY], on a change only (Player::updateAim).
    // viewX/viewY are config.lua maxViewportX/Y, the box a weak scope stretches
    // or shifts, which the client draws its scope mask from.
    AIM_STATE = 65,
    INTERACTION_STARTED = 66,
    INTERACTION_CANCELLED = 67,

    // --- Inventory --------------------------------------------------------
    // The login snapshot, and the only message that carries the inventory's
    // size: per slot [u16 iid][u8 count][u8 uid][u8 ammo], iid 0 = empty.
    INVENTORY = 80,
    // One slot stated whole, keyed by the item's uid:
    //     [u8 uid][u16 iid][u8 count][u8 ammo]     iid 0 = the slot is empty
    // The client needs no prior belief about the slot to apply it. Safe only
    // because Inventory::makeItem keeps the uid byte unique in an inventory.
    INVENTORY_SLOT = 81,
    // One item's fitted mods, keyed like INVENTORY_SLOT:
    //     [u8 uid][u8 n]([u8 slot][u16 modIid])*n     n = 0: nothing fitted
    // Sent right after the INVENTORY_SLOT or INVENTORY that states a moddable
    // weapon. slot is ModSlot (weapon_mod_types.h).
    ITEM_MODS = 82,
    SELECTED_ITEM = 83,        // [u8 iid high byte][u8 iid low byte]
    WRONG_TOOL = 84,           // [u8 toolIid]

    // --- Crafting and stations --------------------------------------------
    BLUEPRINT = 90,            // [u8 iid]
    CRAFT_STARTED = 91,        // [u8 iid low byte]
    STATION_OPENED = 92,       // station and queue fields, then [u8 fuel units][u32 fuelMs]
    STATION_CLOSED = 93,       // the open station is gone
    STATION_FUEL = 94,         // [u8 fuel units][u32 remainingMs]
    // [u8 firstOpen], then per storage slot
    // [u16 iid][u8 count][u8 ammo][u8 n]([u8 slot][u16 modIid])*n
    CONTAINER_CONTENTS = 95,

    // --- Teams ------------------------------------------------------------
    TEAM_CREATED = 100,        // [u8 clanId][u32 leaderGuid][str name]
    TEAM_NAMES = 101,          // [u8 slotCount][str name] * slotCount, empty for a free slot
    TEAM_DELETED = 102,
    TEAM_JOIN_REQUEST = 103,   // [u8 pid], to the leader: this player asks to join
    TEAM_MEMBER_JOINED = 104,  // [u8 pid][u8 clanId]
    TEAM_MEMBER_LEFT = 105,    // [u8 pid]: kicked, left, or the clan was deleted
    TEAM_INVITE = 106,         // [u8 clanId][u8 inviterGuid], to the invited player
    TEAM_LOCKED = 107,         // [u8 clanId][u8 locked]: a locked clan takes invitations only

    // --- Chat -------------------------------------------------------------
    // [u8 channel][u8 from][u8 peer][u8 flags][str text]
    //   channel: ChatChannel.  from: the speaker's guid, or CHAT_SYSTEM_PID.
    //   peer: PRIVATE only, the other party, so the line lands in the right tab.
    //   flags: CHAT_FLAG_*.
    // The sender gets its own line back on every channel; the client never
    // echoes locally.
    CHAT_LINE = 110,
    CHAT_ACCESS = 111,         // [u8 mask], bit (1 << ChatChannel); sent once after HANDSHAKE

    // --- Trade and NPCs ---------------------------------------------------
    // session, revision, peer, phase, accepts, range, own offer, peer offer; an offer is
    // [u8 n] then per item [u8 uid][u16 iid][u8 count][u8 ammo][u8 m]([u8 slot][u16 modIid])*m
    TRADE_STATE = 120,
    TRADE_CLOSED = 121,        // [u32 session][str reason]
    NPC_STATE = 122,           // [str json], bounded snapshot
    NPC_CLOSED = 123,          // [u32 session][str reason]

    // --- Quests, progress and account -------------------------------------
    // [u16 questId][u8 cause][str json]: one quest's whole journal entry
    // (QuestCause says why). REMOVED carries an empty string; RESET with
    // questId 0xFFFF drops every entry. Hidden quests are never sent.
    QUEST_STATE = 130,
    QUEST_PROGRESS = 131,      // [u16 questId][u8 objective][u32 count]
    QUEST_MARKERS = 132,       // [u8 n]([u16 npcId][u8 kind])*n; kind 1 = quest to start, 2 = step to finish
    PROGRESS_STATE = 133,      // [str json]: account progress from scratch
    PROGRESS_UPDATE = 134,     // [u8 n]([u16 statId][u32 value])*n, at most every 2 s
    ACHIEVEMENT_UNLOCKED = 135, // [u16 id][u32 unlockedAt][str json {name, description}]
    ACCOUNT_RUN = 136,         // [str json]: own survivor run and cap progress
    ACCOUNT_CLANS = 137,       // [str json {players:[{pid,clan}]}]: online permanent clan identities
};

// QUEST_STATE causes. Wire values: never renumber.
enum class QuestCause : uint8_t {
    SYNC = 0,
    STARTED = 1,
    ADVANCED = 2,
    COMPLETED = 3,
    FAILED = 4,
    REMOVED = 5,
    RESET = 6,
};

// QUEST_ACTION actions. Wire values: never renumber.
enum class QuestAction : uint8_t {
    ABANDON = 1,
    RESYNC = 2,
};

enum class StatusKind : uint8_t {
    INFO = 0,
    FAILURE = 1,
};

// DISCONNECT_REASON codes. The values are wire format: never renumber.
enum class DisconnectReason : uint8_t {
    OTHER = 0,
    SERVER_FULL = 1,
    SERVER_CLOSED = 2,
    STARTING_UP = 3,
    MAINTENANCE = 4,
    SHUTTING_DOWN = 5,
    INVALID_LOGIN = 6,
    IP_BANNED = 7,
    TOO_MANY_FROM_IP = 8,
    ADMIN_AUTH_REQUIRED = 9,
    SPAWN_FAILED = 10,
    KICKED = 11,
    IDLE = 12,
    LOGGED_IN_ELSEWHERE = 13,
    PLAYER_LIMIT_LOWERED = 14,
    ACCOUNT_REQUIRED = 15,
};

constexpr uint8_t IDENTITY_FLAG_VERIFIED = 1 << 0;

enum class ChatChannel : uint8_t {
    LOCAL = 0,   // everyone who can see the speaker (also the speech bubble)
    GLOBAL = 1,  // everyone online
    CLAN = 2,    // the speaker's clan
    ADMIN = 3,   // admins only, both ways
    PRIVATE = 4, // one peer
    COUNT = 5,
};

// ClientOpcode::SET_PRIVATE_MESSAGES: who may send this player a PRIVATE line.
// The values are wire format: never renumber. Staff always may.
enum class PrivateMessagePolicy : uint8_t {
    EVERYONE = 0,
    CLAN = 1, // clan mates only
    NOBODY = 2,
};

// CHAT_LINE `flags`.
constexpr uint8_t CHAT_FLAG_ADMIN = 1; // the speaker is an admin

// `from` value of a CHAT_LINE line the server wrote itself. Guids are u8
// slots below the player cap, so this never collides with a player.
constexpr uint8_t CHAT_SYSTEM_PID = 255;

// `b` of a DEATH log when nobody in particular did it (starvation, radiation,
// a creature, an explosion with no owner).
constexpr uint8_t SERVER_LOG_NO_PLAYER = 255;

enum class ServerLogKind : uint8_t {
    JOIN = 0,           // a = pid
    LEAVE = 1,          // a = pid
    DEATH = 2,          // a = victim pid, b = killer pid or SERVER_LOG_NO_PLAYER
    CLAN_CREATED = 3,   // a = leader pid, text = clan name
    CLAN_DISBANDED = 4, // text = clan name
    CLAN_JOINED = 5,    // a = pid, text = clan name
    CLAN_LEFT = 6,      // a = pid, text = clan name
    CLAN_KICKED = 7,    // a = pid, text = clan name
    BROADCAST = 8,      // a = admin pid, text = the announcement
    SYSTEM = 9,         // text = anything the server wants everyone to read
};

// Which way one gauge is running. Two bits on the wire (ServerOpcode::
// GAUGE_DIRECTIONS), and the same three states the client's `gauge.decrease` has
// always had -- the mapping is explicit here rather than left as the client's
// magic 1/0/-1, because the sign is inverted from the name.
enum class GaugeDirection : uint8_t {
    HOLD = 0, // client `decrease` 0: not integrating
    RISE = 1, // client `decrease` -1: filling at speedInc
    FALL = 2, // client `decrease` 1: draining at speedDec
};

// Slot order for both GAUGE_DIRECTIONS's bit pairs and GAUGE_RATES's
// (max, inc, dec) triples. One enum so the two messages cannot drift: a gauge
// added to one is a compile error in the other.
enum class GaugeSlot : uint8_t {
    LIFE = 0,
    FOOD = 1,
    WARMTH = 2,
    STAMINA = 3,
    RADIATION = 4,
    COUNT = 5,
};

constexpr size_t GAUGE_SLOT_COUNT = static_cast<size_t>(GaugeSlot::COUNT);

// Fits in the u16 GAUGE_DIRECTIONS carries: 5 gauges x 2 bits = 10.
static_assert(GAUGE_SLOT_COUNT * 2 <= 16, "GAUGE_DIRECTIONS is a u16");

// Which of a gauge's three GAUGE_RATES fields.
enum class RateField : uint8_t {
    MAX = 0,
    INC = 1,
    DEC = 2,
    COUNT = 3,
};

constexpr size_t GAUGE_RATE_FIELD_COUNT = static_cast<size_t>(RateField::COUNT);

// Where one (gauge, field) pair sits in the flat rate array. Spelled once here
// so nothing has to open-code `slot * 3 + 2` and get it wrong -- the ghoul
// overrides in Player::computeGaugeRates were five such literals.
constexpr size_t gaugeRateIndex(GaugeSlot slot, RateField field)
{
    return static_cast<size_t>(slot) * GAUGE_RATE_FIELD_COUNT + static_cast<size_t>(field);
}
