// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <cstdint>

// ---------------------------------------------------------------------------
// The wire, both directions, is BINARY as of 2026-08-12.
//
// Client -> server was JSON text frames until then: every input packet -- a
// rotation, a keypress -- arrived as `JSON.stringify([6, 217])` and was parsed
// TWICE, once in Connection::onRead to recover the opcode byte and again in
// ProtocolGame::parsePacket to recover the arguments, allocating a
// boost::json::array to deliver one uint16. Text frames are now refused on the
// game port outright (Connection::onRead); JSON survives only on STATUS_PORT,
// where ProtocolStatus answers monitoring queries that external tooling reads.
//
// FRAME LAYOUT, client -> server:
//
//     [u8 opcode][payload]
//
// Payloads are TIGHTLY PACKED, little-endian, no padding. The server reads
// through NetworkMessage::get<T>(), which memcpys and so has no alignment
// requirement -- unlike the other direction, where client.js's Uint16Array
// views can only address even offsets and every 16-bit field therefore sits
// behind a pad byte. New server -> client messages avoid that by being read
// with a DataView on the client instead (see Packet.Reader in client.js).
//
// Strings are [u16 byteLength][UTF-8 bytes] -- NetworkMessage::getString.
//
// Every payload below is a FIXED size except the three marked variable. That is
// what lets parsePacket bounds-check a packet once, up front, against
// clientPayloadBytes() instead of once per field, and reject an overlong packet
// as firmly as a truncated one.
// ---------------------------------------------------------------------------

enum class ClientOpcode : uint8_t {

    PING_MESSAGE = 0,
    CHAT_MESSAGE = 1,
    MOVE = 2,
    MOUSE_DIRECTION = 3,
    MOUSE_DOWN = 4,
    MOUSE_UP = 5,
    ROTATION = 6,
    SHIFT = 7,
    EQUIP_ITEM = 8,
    THROW_ITEM = 9,
    STACK_ITEM = 10,
    SPLIT_ITEM = 11,
    TAKE_LOOT = 12,
    PLACE_OBJECT = 14,
    OPEN_STATION_15 = 15,
    OPEN_STATION_16 = 16,
    CLOSE_CONTAINER = 17,
    START_CRAFT_STATION = 18,
    UNLOCK_SKILL = 21,
    START_CRAFT_MANUAL = 22,
    CANCEL_CRAFT = 23,
    ADD_FUEL = 24,            // [u8 amount], 1..254 fuel items requested
    OPEN_CONTAINER = 25,
    STORE_ITEM = 26,
    TAKE_ITEM = 27,
    TAKE_FROM_STATION = 19,
    RELOAD = 13,
    INTERACT_LAMP = 36,
    INTERACT_SWITCH = 37,
    INTERACT_TIMER = 38,
    CREATE_TEAM = 28,
    DELETE_TEAM = 29,
    REQUEST_JOIN_TEAM = 30,
    ACCEPT_JOIN_TEAM = 31,
    KICK_TEAM = 32,
    LOCK_TEAM = 33,
    UNLOCK_TEAM = 34,
    LEAVE_TEAM = 35,
    CONTENT_REQUEST = 39,

    // [u8 channel][u8 target][str text] -- ChatChannel below; `target` is the
    // peer's guid for PRIVATE and 0 otherwise. CHAT_MESSAGE stays as the
    // LOCAL-only form (the stress tester still sends it).
    CHAT_CHANNEL = 40,
    TRADE_REQUEST = 41, // [target guid u8]
    TRADE_REPLY = 42,   // [session u32][accept u8]
    TRADE_OFFER = 43,   // [session u32][revision u32][iid u16][uid u8][count u8], 0 removes
    TRADE_ACCEPT = 44,  // [session u32][revision u32]
    TRADE_CANCEL = 45,  // [session u32]
    NPC_ACTION = 47, // session/revision/request u32, action u8, target/amount u32, text str
    LOOK_AT = 46,       // [entityId u32][pid u8]; entityId 0 = the player with guid pid
    MOVE_CONTAINER_ITEM = 48, // [from u8][to u8]: swap two slots of the open container
    BLOCK_PLAYER = 49,        // [guid u8][blocked u8]: 1 blocks that player's chat to us, 0 lifts it
    INVITE_TEAM = 50,         // [guid u8]: the clan leader invites a player with no clan
    ACCEPT_TEAM_INVITE = 51,  // [clanId u8]: take up an invitation from that clan
    PRIVATE_MESSAGES = 52,    // [policy u8]: PrivateMessagePolicy -- who may message us privately
    QUEST_ACTION = 53,        // [questId u16][action u8]: QuestAction -- abandon a quest, or ask for a resync
    WEAPON_MOD = 54,          // [u8 weaponUid][u8 slot][u8 fit][u8 modUid]; fit 0 = remove (modUid ignored)
    AIM = 55,                 // [u8 held]: 1 while the aim button is held, 0 on release
};

// There is no LOGIN opcode here on purpose. A connection's FIRST frame is not
// in this space at all: its leading byte is the PROTOCOL IDENTIFIER
// (ProtocolGame::protocol_identifier = 30, ProtocolStatus = 0xFF), which
// ServicePort::make_protocol consumes to decide which protocol the socket is
// even speaking, before ProtocolGame::onRecvFirstMessage sees the rest. Adding
// LOGIN here would also collide -- 30 is already REQUEST_JOIN_TEAM in-game.
// See ProtocolGame::parseFirstMessage for what follows that byte.

// Payload size in bytes, EXCLUDING the opcode byte. -1 means variable length
// (the payload ends with, or consists of, a string) and is bounds-checked field
// by field instead. -2 means the opcode is not one this server accepts.
//
// This exists so parsePacket can validate a whole packet in one comparison
// before decoding any of it, and so an OVERLONG packet is rejected too: a
// sender whose layout has drifted from ours is a bug or an attack, and either
// way its arguments must not be acted on. Keep it in step with the switch in
// ProtocolGame::parsePacket -- a missing entry here means the opcode is refused,
// which is the safe direction to fail.
constexpr int clientPayloadBytes(ClientOpcode op)
{
    switch (op) {
    case ClientOpcode::NPC_ACTION: return -1;
    case ClientOpcode::TRADE_REQUEST: return 1;
    case ClientOpcode::LOOK_AT: return 5;
    case ClientOpcode::MOVE_CONTAINER_ITEM: return 2;
    case ClientOpcode::BLOCK_PLAYER: return 2;
    case ClientOpcode::INVITE_TEAM: return 1;
    case ClientOpcode::ACCEPT_TEAM_INVITE: return 1;
    case ClientOpcode::PRIVATE_MESSAGES: return 1;
    case ClientOpcode::QUEST_ACTION: return 3;
    case ClientOpcode::WEAPON_MOD: return 4;
    case ClientOpcode::AIM: return 1;
    case ClientOpcode::TRADE_REPLY: return 5;
    case ClientOpcode::TRADE_OFFER: return 12;
    case ClientOpcode::TRADE_ACCEPT: return 8;
    case ClientOpcode::TRADE_CANCEL: return 4;
    // No arguments.
    case ClientOpcode::PING_MESSAGE:
    case ClientOpcode::MOUSE_DOWN:
    case ClientOpcode::MOUSE_UP:
    case ClientOpcode::RELOAD:
    case ClientOpcode::CLOSE_CONTAINER:
    case ClientOpcode::CANCEL_CRAFT:
    case ClientOpcode::DELETE_TEAM:
    case ClientOpcode::LOCK_TEAM:
    case ClientOpcode::UNLOCK_TEAM:
    case ClientOpcode::LEAVE_TEAM:
        return 0;

    // [u8]
    case ClientOpcode::ADD_FUEL:
    case ClientOpcode::MOVE:            // direction bitmask
    case ClientOpcode::MOUSE_DIRECTION: // 0 = left, 1 = right
    case ClientOpcode::SHIFT:           // 0 or 1
    case ClientOpcode::TAKE_ITEM:       // container slot
    case ClientOpcode::TAKE_FROM_STATION:
    case ClientOpcode::REQUEST_JOIN_TEAM:
        return 1;

    // [u16]
    case ClientOpcode::ROTATION:            // degrees, 0-359
    case ClientOpcode::START_CRAFT_STATION: // item id
    case ClientOpcode::START_CRAFT_MANUAL:
    case ClientOpcode::UNLOCK_SKILL:
        return 2;

    // [u32]
    case ClientOpcode::TAKE_LOOT:        // ClientEntityId (24-bit)
    case ClientOpcode::ACCEPT_JOIN_TEAM: // player guid
    case ClientOpcode::KICK_TEAM:
        return 4;

    // [u32 entityId][u8 pid]
    case ClientOpcode::OPEN_STATION_15:
    case ClientOpcode::OPEN_STATION_16:
    case ClientOpcode::OPEN_CONTAINER:
    case ClientOpcode::INTERACT_LAMP:
    case ClientOpcode::INTERACT_SWITCH:
    case ClientOpcode::INTERACT_TIMER:
        return 5;

    // [u8 rotation][u16 tileX][u16 tileY]
    case ClientOpcode::PLACE_OBJECT:
        return 5;

    // [u16 iid][u8 count][u32 uid]
    case ClientOpcode::SPLIT_ITEM:
        return 7;

    // [u16 iid][u8 count][u32 uid][u8 ammo]
    case ClientOpcode::EQUIP_ITEM:
    case ClientOpcode::THROW_ITEM:
        return 8;

    // [u16 iid][u8 count][u32 uid][u8 ammo][u8 containerSlot], 255 = first free
    case ClientOpcode::STORE_ITEM:
        return 9;

    // [u16 dragIid][u8 dragCount][u32 dragUid][u8 targetCount][u32 targetUid]
    case ClientOpcode::STACK_ITEM:
        return 12;

    // Ends in a string.
    case ClientOpcode::CHAT_MESSAGE:    // [str text]
    case ClientOpcode::CHAT_CHANNEL:    // [u8 channel][u8 target][str text]
    case ClientOpcode::CREATE_TEAM:     // [str name]
    case ClientOpcode::CONTENT_REQUEST: // [str json]
        return -1;
    }
    return -2;
}

enum class ServerOpcode : uint8_t {

    UNITS = 0,
    OLD_VERSION = 1,
    FULL = 2,
    PLAYER_DIE = 3,
    OTHER_DIE = 4,
    FAIL_RESTORE_SESSION = 5,
    STOLE_YOUR_SESSION = 6,
    MUTE = 7,
    LEADERBOARD = 8,
    HANDSHAKE = 9,
    KICK_INACTIVITY = 10,
    NOTIFICATION = 11,
    GAUGES = 12,
    SCORE = 13,
    PLAYER_HIT = 14,
    // The login snapshot, and the only message that carries the inventory's
    // SIZE -- a bag skill expands it and client.js sizes its model from the
    // record count here. [15] then, per slot: [u16 iid][u8 count][u8 uid]
    // [u8 ammo], iid 0 meaning empty. Stride 5, not 4: the iid used to be
    // truncated to a byte against a table already at 168 entries.
    FULL_INVENTORY = 15,
    PLAYER_LIFE = 18,
    SELECTED_ITEM = 20,
    PLAYER_HEAL = 22,
    PLAYER_STAMINA = 29,
    START_INTERACTION = 35,
    INTERRUPT_INTERACTION = 36,
    BLUEPRINT = 38,
    PLAYER_XP = 41,
    PLAYER_XP_SKILL = 42,
    BOUGHT_SKILL = 43,
    START_CRAFT = 44,
    LOST_BUILDING = 45,
    OPEN_BUILDING = 46,      // station/queue fields, [u8 fuel units][u32 fuelMs]
    NEW_FUEL_VALUE = 47,      // [u8 units][u32 remainingMs]
    WRONG_TOOL = 52,
    FULL_CHEST = 53,          // [u8 firstOpen], then per storage slot [u16 iid][u8 count][u8 ammo][u8 n]([u8 slot][u16 modIid])*n
    ACCEPTED_TEAM = 54,
    KICKED_TEAM = 55,
    DELETE_TEAM = 56,
    JOIN_TEAM = 57,
    TEAM_POSITION = 58,
    KARMA = 59,
    BAD_KARMA = 60,
    AREAS = 61,
    WRONG_PASSWORD = 62,
    MODDED_GAUGES_VALUES = 63,
    SHAKE_EXPLOSION_STATE = 64,
    PLAYER_EAT = 65,
    CITIES_LOCATION = 66,
    POISONED = 67,
    REPELLENT = 68,
    LAPADOINE = 69,
    RESET_DRUG = 70,
    DRAMATIC_CHRONO = 71,

    // 19, 21, 23, 24, 25, 26, 27, 28, 30, 48, 49, 50, 51, 72 and 73 are RETIRED
    // and must not be reused. They were the fifteen single-gauge direction
    // edges that GAUGE_STATE (83) replaced; a client older than 1403 still
    // dispatches on them, and the version gate is what keeps one from ever
    // reaching this server -- but a NEW message reusing those numbers would be
    // acted on by such a client rather than ignored by it. Deleted rather than
    // kept as named constants so anything still sending one fails to compile.
    //
    // 16, 17, 31, 32, 33, 34 and 37 are RETIRED on the same terms — the seven
    // item messages INVENTORY_SLOT (84) replaced. 32 (STACK_ITEM) was never
    // sent by this server at all; the other six all said "slot N now holds X"
    // and differed only in which fields they bothered to send.
    //
    // 39 (DAY) and 40 (NIGHT) are RETIRED on the same terms — WORLD_TIME (85)
    // replaced them. They were EDGES on a continuous quantity: each announced
    // that a half had begun and carried no time, so they could say where the
    // clock was only at the two instants it crossed a boundary. See the note on
    // 85 for what that cost.

    // World size, in tiles. Must reach a client BEFORE any entity record does:
    // client.js allocates a tile-indexed `matrix` from it and the wall/floor
    // autotiling writes straight into matrix[i][j], so a build record that
    // arrives while the client still believes in the previous size indexes off
    // the end of it. Sent first thing in sendLoginSetup and again on resize.
    MAP_SIZE = 74,

    // Envelope carrying several complete messages in one WebSocket frame:
    //
    //     [75][0] then, repeated: [u16 length LE][length bytes]
    //
    // Byte 1 is reserved and keeps every sub-header at an even offset. Each
    // payload is byte-identical to the frame that message would have been sent
    // as on its own, so a receiver unwraps by re-dispatching each slice --
    // client.js onBatch, Bot::handleBinary, bot.py _handle_binary.
    //
    // Never carries a single message: ProtocolGame::flushBatch strips the
    // envelope in that case, so an envelope always saves at least one frame.
    BATCH = 75,

    // --- Formerly JSON text frames (76-81) ---------------------------------
    //
    // These six were the last messages on this wire that were not binary. They
    // went out as `JSON.stringify([opcode, ...])` on a TEXT frame, which meant
    // they could not ride in a BATCH envelope (it carries bytes) and each one
    // cost a serialize plus a frame of its own -- and, because a text frame had
    // to overtake nothing, forced Protocol::sendJSON to flush the whole pending
    // batch just to preserve ordering. As binary they are ordinary batched
    // messages and that flush is gone.
    //
    // Their old JSON opcodes were 0-5 and collided numerically with the binary
    // opcodes of the same value (JSON 0 = chat, binary 0 = UNITS); the two
    // spaces were only kept apart by the frame type. These numbers are new so
    // there is now ONE opcode space.
    //
    // Strings are [u16 byteLength][UTF-8 bytes]. Multi-byte fields are packed
    // tight: client.js reads these with a DataView, which -- unlike the
    // Uint16Array views the older messages use -- addresses odd offsets fine,
    // so none of them needs the pad byte that MAP_SIZE and CITIES_LOCATION do.

    // RETIRED: [u8 pid][str text], a speech line with no channel. Every chat
    // line is CHAT_CHANNEL now; the number stays reserved so nothing reuses it.
    CHAT = 76,

    // One player's identity.
    // [u8 guid][u32 tokenId][u8 skin][u8 ghoul][str name][u8 groupId][u8 identityFlags]
    // groupId is data/XML/groups.xml's id; identityFlags bit 0 = verified
    // account (IDENTITY_FLAG_VERIFIED). The client draws badges from both.
    PLAYER_INFO = 77,

    // The whole roster, at login. [u16 slotCount][str name] * slotCount, then
    // [str sessionToken].
    //
    // Slot i IS guid i -- the JSON version wrote guid g's name at array index
    // g+1, one slot late, which the per-player PLAYER_INFO messages that follow
    // happened to paper over for everyone currently online but not for names
    // carried by disconnected players.
    //
    // An unoccupied slot is a ZERO-LENGTH string, and the client turns that back
    // into the number 0 rather than "" before counting. That distinction is
    // load-bearing, not cosmetic: client.js counts live players with `!== 0`,
    // and in JavaScript `"" !== 0` is true, so empty-string slots once made
    // every client believe a one-player server was full -- which is the number
    // the ghoul HUD shows and what gates the last-few reveal.
    NICKNAMES = 78,

    // [str text]. Shown to the player, typically just before a disconnect.
    ALERT = 79,

    // A clan came into existence. [u8 clanId][u32 leaderGuid][str name]
    TEAM_CREATED = 80,

    // All clan names, at login. [u8 slotCount][str name] * slotCount, empty
    // string for a free slot.
    TEAM_NAMES = 81,

    // The answer to a client keepalive (ClientOpcode::PING_MESSAGE). Carries
    // nothing: the client resets its own disconnect watchdog on ANY inbound
    // frame, so the reply's only job is to be a frame.
    //
    // It exists as its own opcode because the pong used to be the literal byte
    // 0x1E -- which is 30, and 30 is LIFE_INCREASE. See sendPingBack.
    PONG = 82,

    // Which way all five gauges are running, in one atomic message.
    //
    //     [83][u16 packed LE]
    //
    // Two bits per gauge, in GaugeSlot order (life, food, warmth, stamina,
    // radiation), holding a GaugeDirection. Read with a DataView, so no pad
    // byte -- see the note above opcode 76.
    //
    // This replaces FIFTEEN opcodes: the LIFE/STAMINA/COLD increase-stop-
    // decrease triples (19/21/30, 23/24/25, 26/27/28) and the four area
    // latches (RAD_ON/OFF 48/49, WARM_ON/OFF 50/51, FEEDERON_WARM_ON/OFF
    // 72/73). Those encoded ten bits of state in fifteen separate edges, and
    // the split was not merely wasteful -- it was unsound:
    //
    //   - FOUR of them wrote the client's cold latch. WARM_ON/OFF and
    //     FEEDERON_WARM_ON/OFF both did, even though the feeder pair is a FOOD
    //     signal, so entering a feeder told the client it was freezing. DAY and
    //     NIGHT wrote it as a fourth source.
    //   - Two of those writers were wrong at the source. FEEDERON_WARM_OFF set
    //     "cold falling" with no day check at all, and WARM_OFF consulted the
    //     client's own `World.day`, which lags the DAY opcode by the length of
    //     the fade. Neither could be fixed where it stood.
    //   - Because they arrived as separate frames, the ORDER mattered: the food
    //     signal had to be sent before the warmth one or it undid it. That
    //     ordering constraint was load-bearing in three places in player.cpp.
    //   - FOOD had no direction on the wire at all. The client's food bar could
    //     only ever fall, so a feeder had to be expressed as "rate zero" plus a
    //     4 Hz stream of authoritative GAUGES value pushes to carry the climb.
    //
    // One packed field cannot be reordered against itself, has one writer on
    // each side, and can say "food is rising" -- which retires the value-push
    // hack with it. See Player::flushGaugeDirections.
    GAUGE_STATE = 83,

    // ONE inventory slot's complete contents, keyed by the item's uid:
    //
    //     [84][u8 uid][u16 iid][u8 count][u8 ammo]     iid 0 = the slot is empty
    //
    // This is a STATEMENT, not an edit. It replaces NEW_ITEM, DELETE_ITEM,
    // REPLACE_ITEM, REPLACE_AMMO, REPLACE_ITEM_AND_AMMO and SPLIT_ITEM, five of
    // which said exactly this and differed only in which fields they sent.
    //
    // The uid is the whole of the key, and the receiver needs no prior belief
    // about the slot to apply it: "the item with uid U is now (iid, count,
    // ammo); if you do not have it, you do now; if iid is 0, you no longer do."
    // The retired messages instead carried the count and ammo the server
    // BELIEVED the client held and made the client scan for a four-field
    // match -- so a stale belief did not misapply the update, it dropped it,
    // silently and permanently. That failure mode is now unrepresentable.
    //
    // Safe only because Inventory::makeItem keeps the uid byte unique inside an
    // inventory; see the note above the sender in protocolgame.cpp.
    INVENTORY_SLOT = 84,

    // The world's day/night clock, stated whole:
    //
    //     [85][u32 cycleMs LE][u32 phaseMs LE]
    //
    // `phaseMs` is the position inside the current full cycle; day is
    // [0, half), night is [half, cycleMs). `cycleMs` is the active mode's
    // dayNightCycle, so the client sizes its own dial from the server rather
    // than from a constant of its own that a mode could contradict.
    //
    // Sent at login, at every boundary, and every WorldClock::RESYNC_INTERVAL_MS
    // in between. Read with a DataView, so no pad byte -- see the note above
    // opcode 76.
    //
    // This replaces DAY (39) and NIGHT (40), and the 16-bit `timeSync` field
    // that used to sit in HANDSHAKE. Those three were a clock described only at
    // its edges plus one lossy sample of it, and the split was not merely
    // redundant -- it was unsound:
    //
    //   - The login DAY/NIGHT was sent AFTER the handshake, and the client's
    //     handler for both reset its elapsed-time counter to zero. So the one
    //     packet carrying the real phase was immediately overwritten by one
    //     that carried none: every session started at sunrise or sunset no
    //     matter what time it actually was. That is the bug this replaces.
    //   - Between boundaries NOTHING re-stated the time. The client integrated
    //     its own clock from requestAnimationFrame deltas, which a background
    //     tab throttles and a hidden one stops, and the error stood until the
    //     next boundary -- up to half a cycle, eight minutes at the shipped
    //     length.
    //   - HANDSHAKE's field was quantised to 32 ms and capped at a u16, so it
    //     could not have expressed a cycle longer than ~35 minutes anyway,
    //     while dayNightCycle is a u32 and modes.xml is free to set one.
    //
    // A state the wire can only describe at its boundaries cannot be joined
    // between them. One message that states the phase makes the boundary
    // non-load-bearing: it is now just the moment the fade looks best starting.
    WORLD_TIME = 85,

    // Dynamic floating damage/healing number above a creature:
    //
    //     [86][u16 x LE][u16 y LE][i16 amount LE][u8 pct]
    //
    // `amount` is signed: negative for damage, positive for heal.
    // `pct` is 0..100 percentage of target's full health.
    DAMAGE_INDICATOR = 86,

    // Pre-join content manifest and table delivery, plus live hot-reload patches:
    CONTENT_MANIFEST = 87,
    CONTENT_TABLE = 88,
    CONTENT_PATCH = 89,

    // One chat line. [u8 channel][u8 from][u8 peer][u8 flags][str text]
    //   channel: ChatChannel below.
    //   from:    the speaker's guid, or CHAT_SYSTEM_PID for a line the server
    //            wrote itself (admin command replies, "X is not online").
    //   peer:    PRIVATE only -- the OTHER party of the conversation, so the
    //            receiver knows which private tab the line belongs to whether
    //            it is the echo of its own message or the reply. 0 otherwise.
    //   flags:   CHAT_FLAG_* -- what the client may not know about the
    //            speaker (an admin's name is drawn in its own colour).
    // The sender always gets its own line back on every channel: the client
    // never echoes locally, so what its console shows is what was delivered.
    CHAT_CHANNEL = 90,

    // A server-wide event for the read-only Server tab. [u8 kind][u8 a][u8 b][str text]
    // Fields per ServerLogKind below. The client formats the sentence; the
    // server only states what happened.
    SERVER_LOG = 91,

    // Which channels this client may write to, sent once after HANDSHAKE.
    // [u8 mask] -- bit (1 << ChatChannel). The ADMIN bit is what tells a client
    // to show the Admin tab at all.
    CHAT_ACCESS = 92,
    // session, revision, peer, phase, accepts, range, own offer, peer offer; an offer is
    // [u8 n] then per item [u8 uid][u16 iid][u8 count][u8 ammo][u8 m]([u8 slot][u16 modIid])*m
    TRADE_STATE = 93,
    NPC_STATE = 95, // bounded JSON snapshot str
    NPC_CLOSED = 96, // session u32, reason str
    TRADE_CLOSED = 94, // [session u32][str reason]

    // Badge-carrying groups, at login and after !reload=groups.
    // [u8 count] then per group [u8 id][str name][str badge]. Groups without a
    // badge are left out; the client draws nothing for an id it was not told.
    GROUPS = 97,

    // [u8 kind][str text]: one line on the status line over the hotbar
    // (Look results, and later other short notices). kind is StatusKind.
    STATUS_MESSAGE = 98,

    // [u8 reason][str detail], sent immediately before the server closes the
    // socket: every refused login and every kick. reason is DisconnectReason;
    // detail carries only variable data (ban text, an admin's message) -- the
    // client owns the wording. A client of another protocol version gets ALERT
    // instead, which every version can decode.
    DISCONNECT_REASON = 99,

    // [u8 count][u8 guid]*count: the players this client has blocked who are
    // online now, the whole list. Sent after every block / unblock and when a
    // blocked verified account comes back under a new guid. The server drops
    // every chat line from them to this player (private ones refused).
    BLOCKED_PLAYERS = 100,

    // [u8 clanId][u8 inviterGuid], to the invited player alone: that clan's
    // leader invites them. ACCEPT_TEAM_INVITE takes it up; declining sends
    // nothing (the invitation lapses when either side leaves or joins).
    TEAM_INVITE = 101,

    // [u8 clanId][u8 locked], to everyone: a locked clan takes no join
    // requests, only invitations. Broadcast on lock / unlock, and sent at
    // login for every clan that is locked (a new clan starts open).
    TEAM_LOCKED = 102,

    // [u16 questId][u8 cause][str json], to one player: the whole journal
    // entry for one quest (QuestCause says why). questId is the quest's index
    // in the loaded set. cause REMOVED carries an empty string and drops the
    // entry; cause RESET with questId 0xFFFF drops every entry (after a quest
    // reload, before the entries are sent again). Hidden quests are never sent.
    QUEST_STATE = 103,

    // [u16 questId][u8 objective][u32 count]: one objective of the quest's
    // current stage (its index in the last QUEST_STATE) now stands at count.
    QUEST_PROGRESS = 104,

    // [u8 n]([u16 npcId][u8 kind])*n, to one player: the NPCs (by their
    // npcs.xml id, the entity's extra) that have quest business with them.
    // kind 1 = a quest to start (!), 2 = a step to finish (?). The whole set,
    // sent when it changes.
    QUEST_MARKERS = 105,

    // [str json], to one player: their account progress from scratch --
    // {enabled, loaded, stats: [[id, value]], achievements: [[id, at]],
    // secrets: [{id, name, description}]} (only non-zero stats; the text of
    // unlocked secret achievements, which the content table leaves out).
    // enabled false: a guest or a server that records nothing.
    PROGRESS_STATE = 106,

    // [u8 n]([u16 statId][u32 value])*n: stats that changed, at most every 2 s.
    // Values above 2^32-1 read as 2^32-1.
    PROGRESS_UPDATE = 107,

    // [u16 achievementId][u32 unlockedAt][str json {name, description}]: just
    // unlocked, for the notification (and the text of a secret one).
    ACHIEVEMENT_UNLOCKED = 108,

    // ONE inventory item's complete fitted mods, keyed like INVENTORY_SLOT by
    // the uid's low byte:
    //
    //     [109][u8 uid][u8 n]([u8 slot][u16 modIid])*n     n = 0: nothing fitted
    //
    // Sent in the same flush right after the INVENTORY_SLOT that states a
    // moddable weapon (Inventory::syncSlot) and after FULL_INVENTORY for each
    // moddable weapon. `slot` is ModSlot (weapon_mod_types.h), never renumbered.
    ITEM_MODS = 109,

    // Aiming turned on or off (Player::updateAim, sent only on a change):
    //
    //     [110][u8 active][u16 viewX][u16 viewY]
    //
    // viewX/viewY are config.lua maxViewportX/Y: the box a weak scope view
    // stretches or shifts, which the client draws its scope mask from.
    AIM_STATE = 110,
    ACCOUNT_RUN = 111, // [str JSON] own survivor run and cap progress
    ACCOUNT_CLANS = 112, // [str JSON] online permanent clan identities
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

// ClientOpcode::PRIVATE_MESSAGES: who may send this player a PRIVATE line.
// The values are wire format: never renumber. Staff always may.
enum class PrivateMessagePolicy : uint8_t {
    EVERYONE = 0,
    CLAN = 1, // clan mates only
    NOBODY = 2,
};

// CHAT_CHANNEL `flags`.
constexpr uint8_t CHAT_FLAG_ADMIN = 1; // the speaker is an admin

// `from` value of a CHAT_CHANNEL line the server wrote itself. Guids are u8
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
// GAUGE_STATE), and the same three states the client's `gauge.decrease` has
// always had -- the mapping is explicit here rather than left as the client's
// magic 1/0/-1, because the sign is inverted from the name.
enum class GaugeDirection : uint8_t {
    HOLD = 0, // client `decrease` 0: not integrating
    RISE = 1, // client `decrease` -1: filling at speedInc
    FALL = 2, // client `decrease` 1: draining at speedDec
};

// Slot order for both GAUGE_STATE's bit pairs and MODDED_GAUGES_VALUES's
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

// Fits in the u16 GAUGE_STATE carries: 5 gauges x 2 bits = 10.
static_assert(GAUGE_SLOT_COUNT * 2 <= 16, "GAUGE_STATE is a u16");

// Which of a gauge's three MODDED_GAUGES_VALUES fields.
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
