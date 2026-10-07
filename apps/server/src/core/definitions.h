// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_DEFINITIONS_H
#define FS_DEFINITIONS_H

#include <string>
#include <cstdint>
#include <cstdlib> // rand, for rollChance / ItemDrop::rollAmount

static constexpr auto STATUS_SERVER_NAME = "Prevast Open Server";

static constexpr auto STATUS_SERVER_VERSION = "0.12";
static constexpr auto STATUS_SERVER_DEVELOPERS = "rawdog72";
// The game protocol version. The client (PROTOCOL_VERSION in
// apps/client/src/net/opcodes.ts) and the server must match exactly: a mismatch
// is a refused login with ALERT, never a misparse. Bump it on any wire change.
// 1418: opcodes renamed and grouped by area (network/opcodes.h).
static constexpr auto CLIENT_VERSION_MIN = 1418;
static constexpr auto CLIENT_VERSION_MAX = 1418;
static constexpr auto CLIENT_VERSION_STR = "14.18";
static constexpr auto TILE_SIZE = 100;

// --- Math ---
static constexpr float MATH_PI     = 3.14159265358979f;
static constexpr float MATH_TWO_PI = 6.28318530717958f;

// --- Entity UID sentinels ---
// High nibble of a Thing's 32-bit id encodes its class. The wire only carries
// the low 16 bits; broadcastSurgicalUpdate rebuilds the full id from the
// update's TYPE, so the prefix never has to be recoverable from the id16.
static constexpr uint32_t NPC_ID_PREFIX = 0x30000000;
static constexpr uint32_t AGENT_ID_PREFIX      = 0x20000000;
static constexpr uint32_t RESOURCE_ID_PREFIX   = 0x40000000;
static constexpr uint32_t OBJECT_ID_PREFIX     = 0x50000000;
static constexpr uint32_t LOOT_ID_PREFIX       = 0x60000000;
// World units per second a projectile with baseSpeed 1.0 and a weapon
// multiplier of 1.0 travels. Both factors are expressed against this, so it is
// the one number to move if every shot should be faster.
static constexpr float PROJECTILE_REFERENCE_SPEED = 600.0f;

static constexpr uint32_t PROJECTILE_ID_PREFIX = 0x70000000;

static constexpr uint32_t PROJECTILE_ID_MIN = PROJECTILE_ID_PREFIX;

// Does this entity class change position between ticks?
//
// Only creatures (players 0x10000000-0x1FFFFFFF via Player::playerAutoID,
// agents 0x2xxxxxxx via AGENT_ID_PREFIX) and projectiles (0x7xxxxxxx) do.
// Resources, objects and loot are placed once and
// never move again: nothing calls setPosition on them after placement, and
// their isDirty() is either absent (Thing's default false, for objects,
// resources and projectiles) or only tracks a state flag that is broadcast
// separately (Loot::isTaken, pushed by playerTakeLoot).
//
// The per-player visibility diff leans on this: for a static entity the diff
// can only produce output when the entity enters or leaves the player's view,
// and since it cannot move, that happens only when the PLAYER moves -- or when
// the entity is created/destroyed, which broadcastSurgicalUpdate already tells
// every player who can see it. So the static half of the diff is dead work on
// any tick where the player's viewport box did not shift.
inline constexpr bool isMobileEntityId(uint32_t id)
{
	return id < RESOURCE_ID_PREFIX || id >= PROJECTILE_ID_PREFIX;
}

// --- Client entity index space ------------------------------------------
//
// client.js resolves a wire (pid, id) pair to a sprite through THREE separate
// caches (client.js `Entitie`), chosen by which address space the pair is in:
//
//     pid == 0   ->  worldCache, a Map keyed by the id alone
//     pid != 0   ->  playerCache, an array keyed by pid*unitsPerPlayer + id
//     particles  ->  localCache, entities the client invents; never sent by us
//
// This used to be ONE flat array indexed by
//     (pid == 0 ? 0 : localUnitsCount) + pid*unitsPerPlayer + id16
// where localUnitsCount came from `Entitie.init(600, maxUnitsMaster, ...)` and
// maxUnitsMaster had to equal this server's configured id space EXACTLY. Every
// id-aliasing bug this project has had came through that arithmetic: ghost
// loot (ids issued outside the pid-0 region, landing on the client's own
// particles), player-built objects (an object sent with the builder's pid),
// un-retracted resources. Separate caches make those collisions unrepresentable
// rather than merely avoided, and delete the shared constant along with them.
//
// THE RULE that still holds, and is the whole reason EntityIdPool exists:
// every entity sent with pid == 0 must have a GLOBALLY UNIQUE id, across all
// classes. worldCache does not partition by type, so a resource and a loot
// sharing an id still collide even though their 32-bit server ids differ.
// Player entities are exempt -- pid = GUID with id = 0 puts them in
// playerCache, addressed by pid.
//
// What a collision would still cost, if one were ever reintroduced: the client
// would render one sprite for two entities, and a removal for either would
// orphan the other permanently (Entitie.remove kills the first match and
// returns, and no second removal is ever coming).

// The type of an id16 -- which is now a misnomer kept for continuity: it is
// 24 bits, not 16. The name still means "the part of a Thing's id that
// addresses a client cache slot", as opposed to the class prefix above it.
//
// 16 bits capped a FULLY BUILT map at 181x181 (see maxStaticObjectsForMap),
// which is the wall a 655x655 map had to clear. 24 was chosen over 32 because
// the 32-bit server id is `classPrefix | id16` with the class in the top
// nibble: 28 bits is the structural roof, 24 leaves a nibble spare, and it
// costs nothing on the wire -- see WIRE ENCODING below.
using ClientEntityId = uint32_t;

// One past the largest expressible id16. Must stay a power of two: the mask
// below and Thing::setID derive from it. Must also stay <= 1<<28 so an id16
// can never run into the class prefix in entityClassFromId.
static constexpr uint32_t CLIENT_ENTITY_ID_SPACE_MAX = 1u << 24; // 16,777,216
static constexpr uint32_t CLIENT_ENTITY_ID_MASK = CLIENT_ENTITY_ID_SPACE_MAX - 1;

// --- WIRE ENCODING --------------------------------------------------------
//
// An id16 does NOT travel as one field. The entity record is 18 bytes and the
// low 16 bits sit at a 2-byte-aligned offset because client.js reads the whole
// frame through `new Uint16Array(data)`, which can only address even offsets.
// The high 8 bits ride in the byte that used to carry `uid`:
//
//     id = low16 | (idHigh << 16)
//
// `uid` was retired to make room, and was not a loss. It existed as a
// stale-slot guard for the client's cache, but Map::acquireUid8 draws from a
// 255-entry pool per type against thousands of entities, so it returned 0 for
// most of them -- the boot log warned about exactly this every startup. The
// guard it was supposed to provide is now structural: EntityIdPool issues
// globally unique id16s, so an id identifies an entity by itself.
//
// Anything that reads or writes the record must agree on this: the server's
// ProtocolGame::flushUpdates, client.js onUnits, and BOTH tools/stress harness
// decoders (cpp/protocol.h and protocol.py).
static constexpr uint32_t CLIENT_ENTITY_ID_WIRE_LOW_BITS = 16;
static constexpr uint32_t CLIENT_ENTITY_ID_WIRE_LOW_MASK = 0xFFFFu;

// Default size of the id space when `entityIdSpace` is 0 (auto). Sized from
// the map at startup -- see resolveEntityIdSpace in prevast_server.cpp -- since
// the demand is 2 ids per tile for a fully built world. This is only the floor
// that applies to a map small enough not to need more, and it is also what the
// pool's occupancy table costs in BYTES, which is why it is not simply
// CLIENT_ENTITY_ID_SPACE_MAX: that would allocate 16 MB on every server.
static constexpr uint32_t CLIENT_ENTITY_ID_SPACE_DEFAULT = 65536;

// --- Entity classes -------------------------------------------------------
//
// The class an id belongs to. All five draw from ONE shared id16 pool
// (EntityIdPool in map.h); the class is carried in the 32-bit server id's top
// nibble and is what the pool's occupancy table records per id16.
enum class EntityClass : uint8_t
{
	None = 0, // players, and anything not drawn from the pool
	Resource,
	Projectile,
	Object,
	Loot,
	Agent,
	Npc,
	Count
};

inline constexpr size_t ENTITY_CLASS_COUNT = static_cast<size_t>(EntityClass::Count);

inline constexpr uint32_t entityClassPrefix(EntityClass klass)
{
	switch (klass) {
		case EntityClass::Npc:        return NPC_ID_PREFIX;
		case EntityClass::Agent:      return AGENT_ID_PREFIX;
		case EntityClass::Resource:   return RESOURCE_ID_PREFIX;
		case EntityClass::Object:     return OBJECT_ID_PREFIX;
		case EntityClass::Loot:       return LOOT_ID_PREFIX;
		case EntityClass::Projectile: return PROJECTILE_ID_PREFIX;
		default:                      return 0;
	}
}

inline constexpr EntityClass entityClassFromId(uint32_t id)
{
	switch (id & 0xF0000000u) {
		case NPC_ID_PREFIX:        return EntityClass::Npc;
		case AGENT_ID_PREFIX:      return EntityClass::Agent;
		case RESOURCE_ID_PREFIX:   return EntityClass::Resource;
		case OBJECT_ID_PREFIX:     return EntityClass::Object;
		case LOOT_ID_PREFIX:       return EntityClass::Loot;
		case PROJECTILE_ID_PREFIX: return EntityClass::Projectile;
		default:                   return EntityClass::None; // players: 0x1xxxxxxx
	}
}

inline constexpr const char* entityClassName(EntityClass klass)
{
	switch (klass) {
		case EntityClass::Resource:   return "resources";
		case EntityClass::Projectile: return "projectiles";
		case EntityClass::Object:     return "objects";
		case EntityClass::Loot:       return "loot";
		case EntityClass::Npc:        return "npcs";
		case EntityClass::Agent:      return "agents";
		default:                      return "none";
	}
}

// The ONE place the wire's `type` field is mapped back to an entity class.
// broadcastSurgicalUpdate rebuilds a 32-bit id from (type, id16) to key
// knownCreatures with, so a protocol type missing from here produces a bare
// id16 -- which lands in the WRONG half of KnownEntitySet (isMobileEntityId is
// true for any value below RESOURCE_ID_PREFIX) and makes the removal reach
// only players who can currently see the position. Resources (8-11) were
// exactly that bug: destroyed resources were never retracted from a client
// that held them but had walked out of view.
//
// Client ENTITIES order (client.js COUNTER_ENTITIE): 0 player, 1 loot,
// 2 bullet, 3-6 build top/down/ground/ground2, 7 particles, 8-11 resources,
// 12 explosion, 13 AI. 7 and 12 are client-local and never arrive from here.
//
// Type 0 (player) stays None deliberately: a player's id16 is 0 and its real
// 32-bit id is not derivable from the update, so there is nothing to rebuild.
// Players need none -- the mobile half of the visibility diff is rebuilt every
// tick and retracts them on its own.
inline constexpr EntityClass entityClassFromProtocolType(uint8_t type)
{
	if (type == 1) return EntityClass::Loot;
	if (type == 2) return EntityClass::Projectile;
	if (type >= 3 && type <= 6) return EntityClass::Object;
	if (type >= 8 && type <= 11) return EntityClass::Resource;
	if (type == 14) return EntityClass::Npc;
	if (type == 13) return EntityClass::Agent;
	return EntityClass::None;
}

// A "fire and forget" visual: the client animates it and drops it by itself,
// there is no server-side entity, and NO REMOVAL IS EVER SENT.
//
// That last part is why this predicate has to exist. broadcastSurgicalUpdate
// records every non-removal in the recipient's knownCreatures so it can be
// retracted later; for something that is never retracted, that entry is
// immortal. It stayed harmless only by accident -- explosions used to ship
// with id 0, so all of them collapsed onto one sentinel entry. Giving them
// distinct ids (see CLIENT_ENTITY_ID_TRANSIENT_COUNT) would have turned that
// accident into a slow leak of exactly the shape that made one bot accumulate
// 53,156 undead bullets. Transient visuals are broadcast and forgotten.
inline constexpr bool isTransientVisualType(uint8_t type)
{
	return type == 12; // __ENTITIE_EXPLOSION__
}

// Ids at the very top of the space that EntityIdPool never issues, held for
// transient visuals that need to be distinguishable from one another but have
// no entity behind them to own an id.
//
// Explosions are the only user. They are addressed (pid 0, id) like any world
// entity, so two blasts in quick succession that share an id land on one client
// cache slot and the second is treated as an update of the first -- it plays no
// animation at all. They used to rotate the `uid` byte 1..254 to avoid that;
// that byte is now the high 8 bits of the id, so they rotate through this band
// instead. Same trick, same wraparound-is-fine reasoning: 256 explosions apart
// is far longer than one animation.
static constexpr uint32_t CLIENT_ENTITY_ID_TRANSIENT_COUNT = 256;

// --- Id space budgeting ---------------------------------------------------
//
// Every id16 comes from one shared pool; per-class quotas are the only thing
// that partitions it, and they are deliberately asymmetric:
//
//   RESERVE -- a floor no other class may borrow into. Only for a class whose
//              exhaustion is a FUNCTIONAL break rather than a content one.
//              That is projectiles alone: running dry drops shots silently,
//              with nothing on screen to explain it. Resources stall respawn,
//              loot loses drops, objects stop building -- all visible and
//              recoverable, so none of them reserve anything.
//   CAP     -- a ceiling. 0 = uncapped. A safety valve for the two elastic
//              classes (objects, loot), not something that normally fires.
//
// Reserves are never derived straight from XML. A derived reserve is a promise
// made out of untrusted input: raise unitsMax in resources.xml and the server
// would dutifully guarantee resources most of the space and starve building.
// The projectile floor IS derived (from maxPlayers and weapon data) but is
// clamped to RESERVE_MAX_FRACTION of the space, so bad content data costs a
// warning instead of a broken world.
static constexpr uint32_t ENTITY_ID_RESERVE_MAX_FRACTION = 10; // <= 1/10th of the space

// Worst-case concurrent projectiles per shooter, used when
// entityIdReserveProjectiles is 0 (auto). Derived at startup from equipables
// data where possible; this is the fallback if no weapon data is loaded.
static constexpr uint32_t PROJECTILE_CONCURRENT_PER_SHOOTER_FALLBACK = 9;

// Maximum objects a fully built-out map can hold: isTileClear permits at most
// one isFloor object (floor OR road -- ObjectManager sets isFloor for both)
// plus one non-floor object per tile, and a resource cannot share a tile with
// either. So the entire static world is bounded by the tile count, NOT by the
// sum of the per-class content limits, and no amount of XML editing can
// overcommit the id space by geometry alone.
//
// This is also the wall for larger maps: 2*N*N ids for an N x N map, so a
// fully buildable map above 181x181 cannot be addressed by a 16-bit id at all.
// Reported at startup so the limit is visible before a map is shipped rather
// than discovered when building silently stops.
inline constexpr uint32_t maxStaticObjectsForMap(uint32_t tilesWide, uint32_t tilesHigh)
{
	return tilesWide * tilesHigh * 2;
}

// --- Protocol limits ---
// A player's entire wire identity is one byte. Creature::buildUpdate sends
// pid = GUID & 0xFF with id = 0, and the client indexes its entity cache as
// (pid * unitsPerPlayer + id), so two players whose GUIDs differ by a multiple
// of 256 collide into a single client-side entity: a removal for one deletes
// the other's sprite, and the survivor's next update resurrects it. That is
// the "entities do not disappear when they leave the viewport" failure, and it
// begins the moment concurrent players exceed 255.
//
// The handshake is 8-bit throughout too (own id and player count are both
// bytes), so this is the protocol's design, not an oversight in one function.
// 255 concurrent players is a hard ceiling until client.js changes; id 0 is
// reserved as "no player" by the client (`if (pid !== 0 && type === 0)`).
static constexpr uint32_t PROTOCOL_MAX_PLAYER_ID = 255;

// --- Gameplay ranges (pixels) ---
static constexpr int32_t LOOT_PICKUP_RANGE  = 200; // max pickup distance for ground loot
static constexpr int32_t INTERACTION_RANGE  = 150; // max range for container/door/station interaction

// --- Chat ---
static constexpr int32_t MAX_CHAT_LENGTH = 200;

// --- Clans ---
//
// How many clan slots the TEAM_NAMES roster describes. This is a WIRE constant,
// not a gameplay one: client.js allocates a fixed 18-entry team table and
// indexes it by clan id, so the roster has to describe exactly that many slots
// whatever `clansMaxClans` happens to be in the current game mode. A mode with
// a lower limit simply leaves the tail empty.
static constexpr uint8_t CLAN_SLOT_COUNT = 18;

// --- Inbound string caps, in BYTES ---------------------------------------
//
// The wire carries UTF-8 and a codepoint costs up to four bytes, so a cap
// written in CHARACTERS is not a byte cap: applying MAX_CHAT_LENGTH directly to
// a byte length would refuse a perfectly ordinary 200-character line in any
// non-latin script. These are the ceilings the DECODER enforces -- deliberately
// loose, because their only job is to stop an unbounded allocation from a
// modified client. The real limits are applied afterwards, on characters, by
// the code that owns the rule (Game::playerSay truncates through truncateUtf8;
// Game::playerCreateClan rejects a name over five characters).
static constexpr uint16_t MAX_CHAT_MESSAGE_BYTES = static_cast<uint16_t>(MAX_CHAT_LENGTH) * 4;
static constexpr uint16_t MAX_CLAN_NAME_BYTES = 5 * 4;

// Login string caps. The real client sends a 20-char token, a short nickname,
// and a 16-char-max password; anything longer comes from a modified client.
// Uncapped, these strings are stored server-side (tokens permanently, in the
// kit-reward maps) and the nickname is rebroadcast to every player at login.
static constexpr size_t MAX_LOGIN_TOKEN_LENGTH = 32;
static constexpr size_t MAX_NICKNAME_LENGTH = 64; // up to 16 Unicode characters encoded as UTF-8
static constexpr size_t MAX_ACCOUNT_TICKET_LENGTH = 512; // web host login ticket, see network/account_ticket.h
static constexpr size_t MAX_LOGIN_PASSWORD_LENGTH = 32;

// --- Movement / Physics ---
static constexpr float MOVEMENT_TICKS_PER_SEC  = 20.0f; // speed-to-pixel divisor per tick
// Target period of the movement tick. Must stay consistent with
// MOVEMENT_TICKS_PER_SEC (1000 / 20 = 50): movement applies a fixed distance
// per tick, so if the loop cannot hold this cadence, players visibly slow down.
static constexpr uint32_t MOVEMENT_TICK_MS     = 50;

// client.js disconnects itself after 15s without a frame (connectionAttemptsLimit).
// Any frame resets that watchdog, so a keepalive only goes to a client that has
// had nothing at all for this long. Wall-clock, not ticks: the tick rate sags
// under load, which is when a spurious disconnect would hurt most.
static constexpr int64_t KEEPALIVE_IDLE_MS = 5000;
static constexpr float RECOIL_DECAY_FACTOR     = 0.5f;  // recoil halved each frame
static constexpr float RECOIL_ZERO_THRESHOLD   = 0.1f;  // below this, recoil snaps to 0
// Ceiling on accumulated knockback recoil so simultaneous hits (e.g. several
// ghouls landing at once) cannot stack into a launch. A single strong hit is
// under this; the sum of many is clamped to it.
static constexpr float MAX_KNOCKBACK_RECOIL    = 50.0f;
// ...and the window over which MAX_KNOCKBACK_RECOIL is a BUDGET rather than an
// instantaneous ceiling. Clamping the buffer alone was not enough: it is
// consumed and refilled every tick, so a pack landing a hit on most ticks kept
// it saturated and bulldozed its victim across the map at several times running
// speed. The budget is refreshed once per window and shared by everyone who
// hits inside it -- ten attackers together move a target about as far as one
// does. Sized just under a ghoul's attack cooldown (700ms) so a lone attacker
// is never attenuated.
static constexpr int64_t KNOCKBACK_WINDOW_MS   = 600;

// Per-step cap for pushing a player out of a PRE-EXISTING overlap (an object
// that landed on them, e.g. a door swinging shut — as opposed to the player
// walking into an obstacle, which is resolved fully as normal collision).
// Keeps the escape push gentle; the hard guarantee against being squeezed
// into/through other geometry is the end-of-tick validation that reverts any
// newly created penetration.
static constexpr float MAX_PUSHOUT_PER_TICK    = 20.0f;

// --- Full-speed slide ---
// A body that is stopped part way through its step spends what is left of that
// step along the direction it DID manage to move, so sliding along a surface
// costs no speed.
//
// Without this, movement input is normalised to a unit vector BEFORE anything
// knows what is in the way (updateMovement), so holding two keys against a wall
// that blocks one of them moves at sqrt(2)/2 = 71% of the speed the free key
// alone would give: walking up the top edge of the map, "right" is faster than
// "up+right". The retry restores the missing 29% along the free axis, which is
// exactly the answer the single key produces.
//
// It cannot become a speed BOOST: the retry budget is what the first pass failed
// to spend, so one tick still moves at most one tick's distance, and it is
// resolved through the same collision sweep, so it cannot enter geometry either.
//
// The two thresholds keep it off the paths where it would be noise: a body that
// got nowhere at all (walked straight into a wall) has no slide direction to
// speak of, and a step that lost a rounding error's worth of distance does not
// need a second sweep.
static constexpr float SLIDE_MIN_PROGRESS  = 0.05f; // units actually moved
static constexpr float SLIDE_MIN_LEFTOVER  = 0.05f; // units of the step left unspent

// --- Damage amounts ---
//
// Every health pool in the game fits in a uint16: Object and Resource carry
// healthMax as one, and a player's or an agent's bar is 0-255. So an amount of
// MAX_DAMAGE_AMOUNT already destroys anything that can exist, and a bigger
// number in XML can be clamped to it without changing what that number MEANS.
//
// Clamped, specifically, rather than cast. `<buildingDamage amount="100000"/>`
// used to reach a `static_cast<uint16_t>` that wrapped it to 34464, and the
// int16_t health delta that carried it wrapped that again to +31072 -- so the
// largest damage number in the file was the one that HEALED the wall it hit.
// A weapon quoting an absurd number is asking for "destroy it", which is what
// the clamp gives; every value the shipped content uses is far below the
// ceiling and passes through untouched.
//
// Health deltas are int32_t for the same reason: -65535 does not fit in the
// int16_t they were passed as. Nothing sums damage, so int32 has room to spare.
static constexpr int32_t MAX_DAMAGE_AMOUNT = 65535;

// XML damage amount -> stored amount. Negative is not a heal here: every caller
// parses a magnitude out of an attribute that has no meaningful negative value,
// and as_llong() returns 0 for a malformed one anyway.
inline uint16_t clampDamageAmount(long long amount)
{
	if (amount <= 0) return 0;
	if (amount >= MAX_DAMAGE_AMOUNT) return static_cast<uint16_t>(MAX_DAMAGE_AMOUNT);
	return static_cast<uint16_t>(amount);
}

// Damage magnitude (post-multipliers, so possibly fractional and possibly far
// over the ceiling) -> the NEGATIVE health delta that expresses it. Saturating:
// the float->int conversion is undefined out of range, which is the other half
// of how the wrap above happened.
inline int32_t damageDelta(float magnitude)
{
	if (!(magnitude > 0.0f)) return 0; // also catches NaN
	if (magnitude >= static_cast<float>(MAX_DAMAGE_AMOUNT)) return -MAX_DAMAGE_AMOUNT;
	return -static_cast<int32_t>(magnitude);
}

// --- Projectile impact visual ---
// The client dead-reckons a bullet from its spawn packet and DRAWS it at a
// position it smooths toward that one by PROJECTILE_CLIENT_LERP per frame, so
// the sprite always trails the simulation. A removal sent the instant the
// server resolves a hit therefore deletes the sprite short of the target: the
// bullet is parked on the impact point and removed this long afterwards, once
// the smoothing has closed the gap to PROJECTILE_IMPACT_TOLERANCE_PX.
static constexpr float PROJECTILE_CLIENT_LERP         = 0.2f;  // client.js ENTITIES[bullet].lerp
static constexpr float PROJECTILE_CLIENT_FRAME_MS     = 16.7f; // 60fps render loop
static constexpr float PROJECTILE_IMPACT_TOLERANCE_PX = 8.0f;
static constexpr uint32_t PROJECTILE_IMPACT_LINGER_MIN_MS = 50;
static constexpr uint32_t PROJECTILE_IMPACT_LINGER_MAX_MS = 200;

// client.js Entitie.remove() keeps a fading copy of a removed entity alive for
// 200ms when the removal's `extra` field is exactly 1 -- for bullets that is
// projectile id 1, the 762_round shared by the ak47 and the sniper. That copy
// keeps dead-reckoning at full speed, so it must be parked before the removal
// goes out; it then does its own catch-up while fading and needs no wait.
static constexpr uint16_t PROJECTILE_CLIENT_FADEOUT_EXTRA = 1;

// Point-blank visual suppression: only an obstacle whose hit lands inside the
// shooter's own body leaves nowhere to draw the bullet. Anything further out
// gets its spawn point pulled back onto the obstacle instead of suppressed.
static constexpr float PROJECTILE_POINT_BLANK_SUPPRESS_DIST = 32.0f;

// --- Stations ---
static constexpr int32_t STATION_QUEUE_SIZE = 4;

// The client chest UI dynamically handles variable slot capacities (>4 slots),
// and sendFullChest sends the container's full storage capacity.
static constexpr uint8_t MAX_CHEST_SLOTS = 64;

// --- Loot animation ---
static constexpr int64_t LOOT_GLIDE_WINDOW_MS = 500; // glide animation window after pickup

// --- Resource spawning ---
static constexpr uint32_t DEFAULT_RESPAWN_DELAY_MS = 60000; // default resource respawn (60s)
static constexpr int32_t  SPAWN_ATTEMPTS            = 50;   // max tries in findRandomSpawnPosition
// Interned form of AreaEffect::type. The environment scan runs once per player
// per tick and has to classify every emitter in range; it used to do that with
// three std::string comparisons per effect. The string stays -- it is what the
// XML says and what diagnostics print -- but the hot path reads this.
enum class AreaEffectKind : uint8_t {
	Other = 0,
	Radiation,
	Warm,
	Food,
};

inline AreaEffectKind areaEffectKindFromType(const std::string& type)
{
	if (type == "radiation") return AreaEffectKind::Radiation;
	if (type == "warm") return AreaEffectKind::Warm;
	if (type == "food") return AreaEffectKind::Food;
	return AreaEffectKind::Other;
}

// --- Chance rolls ------------------------------------------------------------
//
// Every "does this happen?" roll the content files can ask for -- a drop table's
// <item chance=>, a round's <onHit chance=>, a weapon's <crit chance=> -- goes
// through this one function, so they cannot drift. There were two copies and
// they shared a bug.
//
// STRICTLY LESS THAN, which is the whole reason to write it once: rand() % 1000
// yields 0..999, so `<= chance` made chance="0" fire once in a thousand and every
// other value overshoot by a tenth of a percent. `<` makes chance="0.3" exactly
// 300 draws in 1000 and chance="0" genuinely impossible.
//
// Deliberately NOT short-circuited on chance >= 1: the roll is consumed either
// way, so a table's use of rand() does not change with its values. That is what
// keeps the world-generation fingerprint independent of content tuning.
//
// rand() rather than the world stream, for the same reason: every one of these
// happens during PLAY, never during generation, so it must not consume from the
// stream a seed's layout depends on.
inline bool rollChance(float chance)
{
	return (static_cast<float>(rand() % 1000) / 1000.0f) < chance;
}

// --- Drop tables -------------------------------------------------------------
//
// <drops> appears in objects.xml, furnitures.xml, agents.xml and resources.xml,
// and until 2026-08-08 it was TWO shapes: <item key= amount=> in the first three
// and <loot key= chance= countMax=> in resources.xml, parsed by three separate
// loaders into three separate structs. One concept, so one shape and one parser:
//
//     <item key="wood"/>                       exactly 1, always
//     <item key="wood" amount="3"/>            exactly 3, always
//     <item key="stone" amount="1" amountMax="3"/>   1..3
//     <item key="iron" chance="0.7"/>          1, seven times in ten
//
// amountMax pairs with amount the way outputMin/outputMax and produceMin/
// produceMax do elsewhere; omitting it means the amount is fixed. Keys resolve
// once here rather than at every drop, which also retired a reverse
// lootId -> iid lookup object.cpp was doing on every destruction.
struct ItemDrop {
	std::string itemKey;
	uint16_t iid = 0;       // resolved at load; 0 = the key did not resolve
	uint16_t lootId = 0;    // the client's ground-sprite id for it
	uint8_t amount = 1;     // fixed quantity, or the low end of a roll
	uint8_t amountMax = 0;  // 0 = fixed at `amount`
	float chance = 1.0f;

	// Quantity for one drop event. Uses rand() rather than the world stream on
	// purpose: a drop happens during PLAY, not during generation, so it must not
	// consume from the stream a seed's layout depends on.
	uint8_t rollAmount() const
	{
		if (amountMax <= amount) return amount;
		return static_cast<uint8_t>(amount + rand() % (amountMax - amount + 1));
	}

	// Qualified: the free function above and this member share a name, so an
	// unqualified call would find this one and fail on the argument.
	bool rollChance() const { return ::rollChance(chance); }
};

struct AreaEffect {
	uint16_t id;
	std::string type;
	// Derived from `type`, never set by hand: every construction site runs it
	// through noteAreaEffectReach, which is where this is filled in.
	AreaEffectKind kind = AreaEffectKind::Other;
	uint16_t strength;
	uint16_t radius;   // circular pixel range, used only when `area` is absent

	// Tiles around the source's own tile, as a Chebyshev radius: 0 = that one
	// tile and nothing else, 1 = 3x3, 2 = 5x5. Overrides `radius` whenever the
	// attribute is present at all.
	//
	// Signed, and -1 rather than 0 for "absent", precisely so that area="0" is
	// expressible. It used to be uint16_t defaulting to 0, which made "no area
	// attribute" and "area of zero" the same value — so the one shape you would
	// most want for a station that should only affect the tile it stands on was
	// the one shape you could not write, and writing it silently fell back to
	// `radius` (0 by default = an effect that reaches nobody).
	int32_t area = -1;
	bool needsFuel = false;
};

// Furthest, in tiles, that any area effect the server has loaded can reach from
// its emitter.
//
// Player::scanAreaEffects runs once per player per tick and has to find every
// emitter that could be affecting them. It used to ask for the player's whole
// VIEWPORT -- 2601 tiles and ~830 entities at maxViewport 2500 -- to answer a
// question whose true range is 2 tiles in the shipped content. Deriving the
// search box from the loaded data instead of a constant means content with a
// bigger field widens the search automatically; hardcoding it would fail
// silently, as a player standing inside a field that never registers.
inline uint16_t g_maxAreaEffectTileReach = 0;

// Every AreaEffect in the game data passes through here, whether it came from
// XML or was synthesised in code, which is why the interning lives here too: a
// construction site that skipped it would produce an effect that is silently
// Kind::Other and therefore does nothing.
inline void noteAreaEffectReach(AreaEffect& effect)
{
	effect.kind = areaEffectKindFromType(effect.type);

	// Mirrors isWithinAreaEffect (position.h): `area` is already a tile count
	// compared tile-to-tile, while `radius` is a pixel distance, so its tile
	// span is one more than the whole-tile part. area == 0 contributes a reach
	// of 0, which is correct — a single-tile effect needs no search margin at
	// all — and cannot lower the global maximum, which only ever grows.
	const uint16_t reach = effect.area >= 0
		? static_cast<uint16_t>(effect.area)
		: static_cast<uint16_t>(effect.radius / TILE_SIZE + 1);
	if (reach > g_maxAreaEffectTileReach) {
		g_maxAreaEffectTileReach = reach;
	}
}

static constexpr auto AUTHENTICATOR_DIGITS = 6U;
static constexpr auto AUTHENTICATOR_PERIOD = 30U;

#define BOOST_ASIO_NO_DEPRECATED
#define OPENSSL_NO_DEPRECATED

#ifndef __FUNCTION__
#define __FUNCTION__ __func__
#endif

#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif

#ifndef _USE_MATH_DEFINES
#define _USE_MATH_DEFINES
#endif

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif

#define WIN32_LEAN_AND_MEAN

#ifdef _MSC_VER
#ifdef NDEBUG
#define _SECURE_SCL 0
#define HAS_ITERATOR_DEBUGGING 0
#endif

#pragma warning(disable : 4127) // conditional expression is constant
#pragma warning(disable : 4244) // 'argument' : conversion from 'type1' to 'type2', possible loss of data
#pragma warning(disable : 4250) // 'class1' : inherits 'class2::member' via dominance
#pragma warning(disable : 4267) // 'var' : conversion from 'size_t' to 'type', possible loss of data
#pragma warning(disable : 4319) // '~': zero extending 'unsigned int' to 'lua_Number' of greater size
#pragma warning(disable : 4351) // new behavior: elements of array will be default initialized
#pragma warning(disable : 4458) // declaration hides class member
#endif

#ifndef _WIN32_WINNT
// 0x0602: Windows 7
#define _WIN32_WINNT 0x0602
#endif
#endif

#endif // FS_DEFINITIONS_H
