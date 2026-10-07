# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

"""Wire protocol for the Prevast server.

Mirrors opcodes.h and the message shapes in client.js.

Every frame on this socket is BINARY, in both directions, as of 2026-08-12.
The first byte is an opcode; the payload layout is per-opcode, little-endian
and tightly packed, and strings are ``[u16 byteLength][UTF-8 bytes]``. Text
frames used to carry the client -> server input as JSON arrays and a handful of
server -> client packets (roster, player info, alert, teams); the game port now
refuses a text frame outright, and those five packets have binary opcodes
(76-81).

The very first client frame is the login frame and its first byte must be the
protocol identifier 30 (protocolgame.h: protocol_identifier = 30) or
ServicePort::make_protocol will not select the game protocol at all. That byte
is NOT a ClientOpcode -- 30 is REQUEST_TEAM_JOIN in the in-game opcode space.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum


GAME_PROTOCOL_IDENTIFIER = 30


class ClientOp:
    """opcodes.h ClientOpcode (sent as binary frames)."""

    # Connection
    PING = 0
    REQUEST_CONTENT = 1

    # Movement and combat
    MOVE = 10
    ROTATE = 11
    FACE = 12
    ATTACK_START = 13
    ATTACK_STOP = 14
    SPRINT = 15
    AIM = 16
    RELOAD = 17

    # Items
    EQUIP_ITEM = 20
    DROP_ITEM = 21
    STACK_ITEM = 22
    SPLIT_ITEM = 23
    PICK_UP_LOOT = 24
    FIT_WEAPON_MOD = 25

    # Interaction and containers
    INTERACT = 30
    CLOSE_CONTAINER = 31
    STORE_ITEM = 32
    TAKE_ITEM = 33
    MOVE_CONTAINER_ITEM = 34
    LOOK_AT = 35

    # Building and crafting
    PLACE_BUILDING = 40
    CRAFT_AT_STATION = 41
    CRAFT_BY_HAND = 42
    CANCEL_CRAFT = 43
    TAKE_FROM_STATION = 44
    ADD_FUEL = 45
    UNLOCK_SKILL = 46

    # Chat and social
    CHAT_LOCAL = 50
    SEND_CHAT = 51
    BLOCK_PLAYER = 52
    SET_PRIVATE_MESSAGES = 53

    # Teams
    CREATE_TEAM = 60
    DELETE_TEAM = 61
    REQUEST_TEAM_JOIN = 62
    ACCEPT_TEAM_JOIN = 63
    KICK_FROM_TEAM = 64
    LOCK_TEAM = 65
    UNLOCK_TEAM = 66
    LEAVE_TEAM = 67
    INVITE_TO_TEAM = 68
    ACCEPT_TEAM_INVITE = 69

    # Trade and NPCs
    TRADE_REQUEST = 70
    TRADE_REPLY = 71
    TRADE_OFFER = 72
    TRADE_ACCEPT = 73
    TRADE_CANCEL = 74
    NPC_ACTION = 75

    # Quests
    QUEST_ACTION = 80


class ServerOp:
    """opcodes.h ServerOpcode (first byte of binary frames). Layouts are in opcodes.h."""

    # Connection and session
    HANDSHAKE = 0
    BATCH = 1
    PONG = 2
    ALERT = 3
    DISCONNECT_REASON = 4
    SESSION_TAKEN = 5
    STATUS_MESSAGE = 6
    SERVER_LOG = 7

    # Content
    CONTENT_MANIFEST = 10
    CONTENT_TABLE = 11
    CONTENT_PATCH = 12

    # World
    ENTITY_UPDATES = 20
    MAP_SIZE = 21
    WORLD_TIME = 22
    CITY_LOCATIONS = 23
    LEADERBOARD = 24
    DAMAGE_INDICATOR = 25
    EXPLOSION_SHAKE = 26
    OVERHEAD_ALERT = 27
    PLAYER_HIT = 28
    PLAYER_HEALED = 29
    PLAYER_ATE = 30
    PLAYER_DIED = 31

    # Players
    PLAYER_INFO = 40
    PLAYER_NAMES = 41
    GROUPS = 42
    BLOCKED_PLAYERS = 43
    PLAYER_POSITIONS = 44
    WORST_KARMA_PLAYER = 45

    # Your character
    YOU_DIED = 50
    GAUGE_VALUES = 51
    GAUGE_RATES = 52
    GAUGE_DIRECTIONS = 53
    STAMINA = 54
    SCORE = 55
    XP = 56
    LEVEL_STATE = 57
    SKILL_UNLOCKED = 58
    KARMA = 59
    POISONED = 60
    REPELLENT_ACTIVE = 61
    LAPADONE_ACTIVE = 62
    DRUG_RESET = 63
    COUNTDOWN = 64
    AIM_STATE = 65
    INTERACTION_STARTED = 66
    INTERACTION_CANCELLED = 67

    # Inventory
    INVENTORY = 80
    INVENTORY_SLOT = 81
    ITEM_MODS = 82
    SELECTED_ITEM = 83
    WRONG_TOOL = 84

    # Crafting and stations
    BLUEPRINT = 90
    CRAFT_STARTED = 91
    STATION_OPENED = 92
    STATION_CLOSED = 93
    STATION_FUEL = 94
    CONTAINER_CONTENTS = 95

    # Teams
    TEAM_CREATED = 100
    TEAM_NAMES = 101
    TEAM_DELETED = 102
    TEAM_JOIN_REQUEST = 103
    TEAM_MEMBER_JOINED = 104
    TEAM_MEMBER_LEFT = 105
    TEAM_INVITE = 106
    TEAM_LOCKED = 107

    # Chat
    CHAT_LINE = 110
    CHAT_ACCESS = 111

    # Trade and NPCs
    TRADE_STATE = 120
    TRADE_CLOSED = 121
    NPC_STATE = 122
    NPC_CLOSED = 123

    # Quests, progress and account
    QUEST_STATE = 130
    QUEST_PROGRESS = 131
    QUEST_MARKERS = 132
    PROGRESS_STATE = 133
    PROGRESS_UPDATE = 134
    ACHIEVEMENT_UNLOCKED = 135
    ACCOUNT_RUN = 136
    ACCOUNT_CLANS = 137


class GaugeDir(IntEnum):
    """Which way one gauge is running. Mirrors GaugeDirection in opcodes.h."""
    HOLD = 0
    RISE = 1
    FALL = 2


# Bit-pair order inside GAUGE_DIRECTIONS. Mirrors GaugeSlot in opcodes.h, and is also
# the order GAUGE_RATES lays its (max, inc, dec) triples out in.
GAUGE_SLOTS = ("life", "food", "warmth", "stamina", "radiation")


def gauge_state(payload: bytes) -> dict:
    """Unpack a GAUGE_DIRECTIONS payload into {slot name: GaugeDir}.

    `payload` is a whole message including the opcode byte, as `messages()`
    yields it.
    """
    if len(payload) < 3 or payload[0] != ServerOp.GAUGE_DIRECTIONS:
        raise ValueError(f"not a GAUGE_DIRECTIONS message: {payload[:4]!r}")
    packed = int.from_bytes(payload[1:3], "little")
    return {name: GaugeDir((packed >> (i * 2)) & 3) for i, name in enumerate(GAUGE_SLOTS)}


def map_size(payload: bytes) -> tuple:
    """A MAP_SIZE payload as (tilesX, tilesY).

    Layout is [MAP_SIZE][pad][u16 tilesX][u16 tilesY] -- the pad byte is not a spare
    field, it is what puts the two uint16s on even offsets so client.js can read
    them through a Uint16Array view. See ProtocolGame::sendMapSize.
    """
    if len(payload) < 6 or payload[0] != ServerOp.MAP_SIZE:
        raise ValueError(f"not a MAP_SIZE message: {payload[:4]!r}")
    return (int.from_bytes(payload[2:4], "little"),
            int.from_bytes(payload[4:6], "little"))


def gauge_rates(payload: bytes) -> dict:
    """Unpack GAUGE_RATES into {slot name: (max, speedInc, speedDec)}.

    The server sends these as raw integers scaled by 10000 (GAUGE_RATE_SCALE);
    they are returned unscaled so a caller can compare them against the server's
    own numbers without a float round-trip.
    """
    if len(payload) < 2 + len(GAUGE_SLOTS) * 3 * 2 or payload[0] != ServerOp.GAUGE_RATES:
        raise ValueError(f"not a GAUGE_RATES message: {payload[:4]!r}")
    # ui16[0] is the opcode padded to 16 bits; the triples start at ui16[1].
    vals = [int.from_bytes(payload[i:i + 2], "little") for i in range(2, len(payload) - 1, 2)]
    return {name: tuple(vals[i * 3:i * 3 + 3]) for i, name in enumerate(GAUGE_SLOTS)}


def messages(frame: bytes) -> list:
    """The protocol messages carried by one received binary frame.

    Use this at every receive point instead of looking at ``frame[0]``. Since
    the BATCH envelope landed, one frame is no longer one message: a script
    that switches on the first byte sees BATCH and silently drops a whole
    tick's worth of everything -- ENTITY_UPDATES included -- which reads as a server bug
    rather than a decoder that was never updated.

    A non-batched frame comes back as itself, so this is safe on any frame.
    """
    if not frame:
        return []
    if frame[0] != ServerOp.BATCH:
        return [frame]
    return list(iter_batch(frame))


def iter_batch(data: bytes):
    """Yield each message inside a ServerOp.BATCH frame.

    Envelope layout (opcodes.h): ``[BATCH][0]`` then, repeated, a little-endian
    uint16 length followed by that many bytes. Each payload is byte-identical
    to the frame that message would have arrived as on its own, so the caller
    unwraps by re-dispatching each slice.

    Ignoring this opcode does not cost one message, it costs a whole tick's
    worth -- ENTITY_UPDATES included. A truncated envelope stops the walk rather than
    yielding garbage.
    """
    n = len(data)
    off = 2
    while off + 2 <= n:
        length = data[off] | (data[off + 1] << 8)
        off += 2
        if length < 1 or off + length > n:
            return
        yield data[off:off + length]
        off += length


SERVER_OP_NAMES = {
    value: name for name, value in vars(ServerOp).items() if not name.startswith("_")
}

# Move mask bits (client.js sendMove).
MOVE_LEFT = 1
MOVE_RIGHT = 2
MOVE_DOWN = 4
MOVE_UP = 8

# Mouse direction values (client.js sendMouseRightLeft).
MOUSE_LEFT = 0
MOUSE_RIGHT = 1


# ---------------------------------------------------------------------------
# Client -> server message builders (BINARY frames)
# ---------------------------------------------------------------------------
#
# These returned JSON arrays until 2026-08-12. The game port now refuses text
# frames outright, so every one of these is bytes and goes out as a binary
# frame: [u8 opcode][payload], little-endian, tightly packed, no alignment
# padding. Strings are [u16 byteLength][UTF-8 bytes].
#
# The payload sizes here must match clientPayloadBytes() in opcodes.h exactly.
# The server checks the whole payload length up front and drops a packet that
# is the wrong size in EITHER direction -- an extra trailing byte is refused as
# firmly as a missing one -- so a builder that is one byte off does not degrade,
# it goes silently unhandled.

def _str(value: str) -> bytes:
    encoded = ("" if value is None else str(value)).encode("utf-8")
    return struct.pack("<H", len(encoded)) + encoded


def login_message(token: str, nickname: str, skin: int = 0, password: str = "",
                  token_id: int = 0, user_id: int = -1,
                  account_ticket: str = "") -> bytes:
    """First frame after connect (client.js onFirstMessage).

    [u8 30][u16 protocolVersion][str token][u32 tokenId][u32 playerId]
    [str nickname][u8 adBlocker][str password][str accountTicket]

    The leading byte MUST be 30: it is the protocol identifier, which
    ServicePort::make_protocol consumes to select the game protocol, and it is
    not a ClientOpcode.

    protocolVersion is sent as 0, which the server's gate treats as "exempt"
    (`data.version != 0 && ...`). That is deliberate and long-standing: the
    harness is not the shipped client and should not have to be rebuilt in
    lockstep with every wire bump. `skin` is accepted and ignored -- the skin is
    server state, owned by the equipped wearable, and is no longer on the wire.
    """
    return (
        struct.pack("<BH", GAME_PROTOCOL_IDENTIFIER, 0)
        + _str(token)
        + struct.pack("<II", int(token_id) & 0xFFFFFFFF,
                      0 if user_id < 0 else (int(user_id) & 0xFFFFFFFF))
        + _str(nickname)
        + struct.pack("<B", 0)
        + _str(password)
        + _str(account_ticket)
    )


def ping() -> bytes:
    return struct.pack("<B", ClientOp.PING)


def chat(text: str) -> bytes:
    return struct.pack("<B", ClientOp.CHAT_LOCAL) + _str(text)


def move(mask: int) -> bytes:
    """mask = OR of MOVE_* bits; 0 stops."""
    return struct.pack("<BB", ClientOp.MOVE, mask & 0xFF)


def mouse_direction(direction: int) -> bytes:
    """MOUSE_LEFT / MOUSE_RIGHT (which way the player sprite faces)."""
    return struct.pack("<BB", ClientOp.FACE, direction & 0xFF)


def mouse_down() -> bytes:
    return struct.pack("<B", ClientOp.ATTACK_START)


def mouse_up() -> bytes:
    return struct.pack("<B", ClientOp.ATTACK_STOP)


def rotation(degrees: int) -> bytes:
    """Aim angle in whole degrees 0..359 (server rescales to 0..255)."""
    return struct.pack("<BH", ClientOp.ROTATE, int(degrees) % 360)


def shift(enabled: bool) -> bytes:
    """Sprint on/off."""
    return struct.pack("<BB", ClientOp.SPRINT, 1 if enabled else 0)


def equip_item(iid: int, uid: int) -> bytes:
    """Equip an inventory item.

    [u16 iid][u8 count][u32 uid][u8 ammo]; the server reads iid and uid. The uid
    must match the low byte of the server-side item UID, which is exactly what
    INVENTORY_SLOT / INVENTORY report (they send ``uid & 0xFF``), so pass
    the byte straight through.
    """
    return struct.pack("<BHBIB", ClientOp.EQUIP_ITEM, int(iid) & 0xFFFF, 0,
                       int(uid) & 0xFF, 0)


def reload_weapon() -> bytes:
    return struct.pack("<B", ClientOp.RELOAD)


# weapon_mod_types.h ModSlot::Optic.
OPTIC_SLOT = 1


def weapon_mod(weapon_uid: int, slot: int, mod_uid: int) -> bytes:
    """Fit a carried mod into a weapon's slot.

    [u8 weaponUid][u8 slot][u8 fit=1][u8 modUid]. The uids are the low bytes
    INVENTORY_SLOT reports; `slot` is a ModSlot number (OPTIC_SLOT for a scope).
    """
    return struct.pack("<BBBBB", ClientOp.FIT_WEAPON_MOD, weapon_uid & 0xFF, slot & 0xFF, 1, mod_uid & 0xFF)


def aim(held: bool) -> bytes:
    """The aim button, [u8 held]. The server decides when aiming is active."""
    return struct.pack("<BB", ClientOp.AIM, 1 if held else 0)


def place_object(rotation_index: int, tile_x: int, tile_y: int) -> bytes:
    """[u8 rotation][u16 tileX][u16 tileY]. TILE coordinates, not world units."""
    return struct.pack("<BBHH", ClientOp.PLACE_BUILDING, rotation_index & 0xFF,
                       int(tile_x) & 0xFFFF, int(tile_y) & 0xFFFF)


def interact(entity_id: int, pid: int = 0) -> bytes:
    """INTERACT [u32 entityId][u8 pid]: doors, stations, containers, lamps, switches and timers."""
    return struct.pack("<BIB", ClientOp.INTERACT, int(entity_id) & 0xFFFFFFFF, pid & 0xFF)


def take_loot(loot_id: int) -> bytes:
    return struct.pack("<BI", ClientOp.PICK_UP_LOOT, int(loot_id) & 0xFFFFFFFF)


def start_craft_manual(iid: int) -> bytes:
    return struct.pack("<BH", ClientOp.CRAFT_BY_HAND, int(iid) & 0xFFFF)


def start_craft_station(iid: int) -> bytes:
    return struct.pack("<BH", ClientOp.CRAFT_AT_STATION, int(iid) & 0xFFFF)


def unlock_skill(iid: int) -> bytes:
    return struct.pack("<BH", ClientOp.UNLOCK_SKILL, int(iid) & 0xFFFF)


def create_team(name: str) -> bytes:
    return struct.pack("<B", ClientOp.CREATE_TEAM) + _str(name)


# ---------------------------------------------------------------------------
# Server -> client binary parsing
# ---------------------------------------------------------------------------

@dataclass
class HandshakePlayer:
    guid: int
    team: int
    ghoul: int
    token_id: int
    score: int
    # The two drug timers, in the units client.js multiplies them by: repellent
    # x2000ms, withdrawal x1000ms. Both were hardcoded 0 on the server until
    # 2026-08-13, so a client logging in was told nobody was drugged.
    repellent: int = 0
    withdrawal: int = 0


@dataclass
class Handshake:
    own_guid: int
    units_per_player: int
    player_count: int
    mode_id: int
    players: list[HandshakePlayer]


# The head was "<BBHBBH" -- 8 bytes, ending in a u16 `timeSync` -- until
# 2026-08-12. The world clock is ServerOp.WORLD_TIME now, and the roster moved
# from offset 8 to 6.
_HANDSHAKE_HEAD = struct.Struct("<BBHBB")           # op, ownGuid, unitsPerPlayer, count, modeId
# guid, team, repellent, withdrawal, ghoul, pad, tokenId, score
_HANDSHAKE_PLAYER = struct.Struct("<BBBBBBHH")


def parse_handshake(data: bytes) -> Handshake:
    op, own_guid, units_per_player, player_count, mode_id = \
        _HANDSHAKE_HEAD.unpack_from(data, 0)
    players = []
    offset = _HANDSHAKE_HEAD.size
    while offset + _HANDSHAKE_PLAYER.size <= len(data):
        guid, team, repellent, withdrawal, ghoul, _, token_id, score = \
            _HANDSHAKE_PLAYER.unpack_from(data, offset)
        players.append(HandshakePlayer(guid, team, ghoul, token_id, score,
                                       repellent, withdrawal))
        offset += _HANDSHAKE_PLAYER.size
    return Handshake(own_guid, units_per_player, player_count, mode_id, players)


_WORLD_TIME = struct.Struct("<BII")                 # op, cycleMs, phaseMs


def parse_world_time(data: bytes) -> tuple[int, int]:
    """ServerOp.WORLD_TIME -> (cycle_ms, phase_ms). Night is phase >= cycle//2."""
    _, cycle_ms, phase_ms = _WORLD_TIME.unpack_from(data, 0)
    return cycle_ms, phase_ms


@dataclass
class UnitRecord:
    """One 18-byte record of a ENTITY_UPDATES frame (ProtocolGame::flushUpdates).

    For players: pid == GUID and id == 0. (end_x, end_y) is the position the
    entity is moving toward this tick, ``rotation`` is the aim angle scaled
    0..255, ``state`` packs speed/flags, ``extra`` packs held-item IID / skin.
    A record with state == 0 is a removal (entity left the viewport / died).

    ``id`` is 24 bits and does NOT arrive as one field: the low 16 sit at an
    even offset (client.js can only read a uint16 there) and the high 8 ride in
    byte 1, which used to carry ``uid``. There is no uid any more -- the pool
    issues globally unique ids, so an id identifies an entity on its own. See
    WIRE ENCODING in definitions.h.
    """

    pid: int
    rotation: int
    type: int
    state: int
    id: int
    start_x: int
    start_y: int
    end_x: int
    end_y: int
    extra: int


# pid, id-high, rotation, type, state, id-low, startX, startY, endX, endY, extra
_UNIT_RECORD = struct.Struct("<BBBBHHHHHHH")  # 18 bytes


def parse_units(data: bytes) -> tuple[bool, list[UnitRecord]]:
    """Returns (login_flag, records). login_flag means: clear all known
    entities, this is a full snapshot (sent on login/reconnect)."""
    login_flag = len(data) > 1 and data[1] == 0x01
    records = []
    offset = 2
    while offset + _UNIT_RECORD.size <= len(data):
        (pid, id_high, rotation, rtype, state, id_low,
         start_x, start_y, end_x, end_y, extra) = _UNIT_RECORD.unpack_from(data, offset)
        records.append(UnitRecord(pid, rotation, rtype, state,
                                  id_low | (id_high << 16),
                                  start_x, start_y, end_x, end_y, extra))
        offset += _UNIT_RECORD.size
    return login_flag, records


def find_self_record(data: bytes, guid: int):
    """Return just this bot's own UnitRecord from a ENTITY_UPDATES frame, or None.

    The measurement-preserving counterpart to parse_units. A ENTITY_UPDATES frame
    carries one 18-byte record per entity in view, and parse_units allocates a
    UnitRecord for every one of them; at 500 bots x 20Hz that is the dominant
    cost in the harness, and it is spent building a `view.others` dict that no
    shipped behavior reads.

    That cost is not merely wasteful, it corrupts the benchmark: the harness is
    single-threaded asyncio, so it caps at one core, and once it saturates it
    stops keeping up with the server. The server then looks faster than it is
    (less input arriving) while the bot-side tick-rate metric looks worse than
    it is (frames not drained promptly) -- the measurement stops describing the
    server at all.

    So this scans the fixed-size records and unpacks only the matching one.
    pid is byte 0 of a record and type is byte 3, so the filter is two byte
    compares per record with no allocation.
    """
    size = _UNIT_RECORD.size
    offset = 2
    n = len(data)
    while offset + size <= n:
        # Same predicate as the full path: own pid, and not a type-12 record.
        if data[offset] == guid and data[offset + 3] != 12:
            (pid, id_high, rotation, rtype, state, id_low,
             start_x, start_y, end_x, end_y, extra) = _UNIT_RECORD.unpack_from(data, offset)
            return UnitRecord(pid, rotation, rtype, state,
                              id_low | (id_high << 16),
                              start_x, start_y, end_x, end_y, extra)
        offset += size
    return None


@dataclass
class InventorySlot:
    iid: int   # 0 = the slot is now empty
    count: int
    uid: int   # low byte only, which is all the protocol carries
    ammo: int


def parse_inventory_slot(data: bytes) -> InventorySlot | None:
    """INVENTORY_SLOT: [INVENTORY_SLOT][u8 uid][u16 iid LE][u8 count][u8 ammo].

    Note the field order: the uid comes FIRST because it is the key. This one
    message replaced NEW_ITEM/DELETE_ITEM/REPLACE_*/SPLIT_ITEM, so a caller
    that wants "an item arrived" wants ``iid != 0``.
    """
    if len(data) < 6:
        return None
    uid = data[1]
    iid = data[2] | (data[3] << 8)
    return InventorySlot(iid, count=data[4], uid=uid, ammo=data[5])


def parse_player_die(data: bytes) -> int:
    """YOU_DIED carries the final score as a big-endian u16."""
    if len(data) >= 3:
        return (data[1] << 8) | data[2]
    return 0
