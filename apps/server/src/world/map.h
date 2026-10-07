// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_MAP_H
#define FS_MAP_H

#include "core/definitions.h"
#include "world/tile.h"
#include "core/position.h"
#include <vector>
#include <unordered_map>
#include <algorithm>

class Thing;
class Object;
class Player;

// One shared pool of client id16 values for every entity class.
//
// The client keys its ENTIRE entity cache -- every type, one flat array -- on
// the id16 (see the block comment in definitions.h), so the only hard rule is
// that no two SIMULTANEOUSLY LIVE entities sent with pid 0 may share one.
//
// That used to be guaranteed by giving each class a disjoint band of the
// space. Bands are a static answer to a dynamic question and they over-deliver:
// three of the five classes have ceilings they can never approach (resources
// are capped by resources.xml, agents by the mode's maxTotal, projectiles by
// flight time), so a large slice of the space sat permanently unreachable
// while player building -- the one genuinely elastic class -- hit a wall at
// its band edge. An occupancy table gives the same guarantee at full
// utilisation: whoever needs an id gets one, and destroyed resources hand
// their ids straight to whatever is built in their place.
//
// Quotas are asymmetric on purpose; see the ENTITY_ID_RESERVE_* notes in
// definitions.h for why only projectiles get a floor.
class EntityIdPool
{
public:
	// `reserve`/`cap` are indexed by EntityClass. Sizes the occupancy table, so
	// it must run before anything is spawned. Safe to call again (a reload
	// keeps live entities: only the quotas and the table size change).
	void configure(uint32_t space, const uint32_t (&reserve)[ENTITY_CLASS_COUNT],
	               const uint32_t (&cap)[ENTITY_CLASS_COUNT]);

	// Next free id16 for `klass`, already OR-ed with the class prefix, or 0
	// when the pool or the class quota is exhausted.
	//
	// The cursor rotates and is never rewound. That is deliberate and is the
	// one place a free-list would be worse despite being O(1): a LIFO free-list
	// hands back the id that was JUST released, which is precisely the id most
	// likely to still sit in some client's cache if a removal was missed.
	// Rotating maximises the delay before reuse.
	uint32_t acquire(EntityClass klass);

	// Occupancy is committed at PLACEMENT and released at removal -- the same
	// two points that maintain Map::thingMap, so the two cannot drift.
	//
	// Deliberately NOT committed inside acquire(): an id that is named but
	// never placed (a factory that bails out after naming) then costs nothing,
	// which is the self-healing property the per-class cursors had. The cost is
	// that a class quota can overshoot by the number of in-flight uncommitted
	// acquires -- which is 1 everywhere, since every factory acquires,
	// constructs and places inside one call chain.
	void commit(uint32_t fullId);
	void release(uint32_t fullId);

	EntityClass ownerOf(ClientEntityId id16) const
	{
		return id16 < owner.size() ? static_cast<EntityClass>(owner[id16]) : EntityClass::None;
	}

	uint32_t fullIdFor(ClientEntityId id16) const
	{
		const EntityClass klass = ownerOf(id16);
		return klass == EntityClass::None ? 0u : (entityClassPrefix(klass) | id16);
	}

	bool canAcquire(EntityClass klass) const;

	uint32_t capacity() const { return space; }

	// Ids 1..issuableCount()-1 are what acquire() draws from; everything from
	// there to capacity() is the transient-visual band.
	uint32_t issuableCount() const { return issuable; }

	// The id for transient visual `slot`, which acquire() is guaranteed never
	// to return. `slot` is taken modulo the band size, so a caller can just
	// keep incrementing a counter.
	//
	// Returns 0 when the space was configured too small to carve a band out of
	// (see configure). 0 is the "none" sentinel and is never issued either, so
	// it is still collision-free -- it just stops rotating, which costs the
	// animation on back-to-back explosions and nothing else. That is exactly
	// what these did before they had a band, so the degenerate case degrades to
	// the old behaviour instead of returning an out-of-range id.
	uint32_t transientId(uint32_t slot) const
	{
		if (space <= issuable) {
			return 0;
		}
		return issuable + (slot % (space - issuable));
	}

	uint32_t freeCount() const { return freeIds; }
	uint32_t liveCount(EntityClass klass) const { return live[static_cast<size_t>(klass)]; }
	uint32_t reserveOf(EntityClass klass) const { return reserve[static_cast<size_t>(klass)]; }
	uint32_t capOf(EntityClass klass) const { return cap[static_cast<size_t>(klass)]; }
	uint32_t sharedTotal() const { return shared; }
	uint32_t sharedFree() const { return shared - sharedUsed; }

private:
	// index = id16, value = the owning EntityClass (0 = free). One byte rather
	// than one bit because it is also what lets an inbound id16 be resolved to
	// its real 32-bit id without guessing the class.
	std::vector<uint8_t> owner;

	uint32_t space = 0;
	uint32_t issuable = 0; // space minus the transient-visual band at the top
	uint32_t cursor = 1;   // id16 0 is reserved as a "none" sentinel
	uint32_t freeIds = 0;
	uint32_t live[ENTITY_CLASS_COUNT]{};
	uint32_t reserve[ENTITY_CLASS_COUNT]{};
	uint32_t cap[ENTITY_CLASS_COUNT]{};
	uint32_t shared = 0;     // ids above the sum of reserves
	uint32_t sharedUsed = 0; // how many of those are currently lent out
};

class Map
{
public:
	Map();
	~Map() = default;

	bool placeThing(const Position& pos, Thing* thing);
	void removeThing(Thing* thing);
	// SOLID things near `pos`. Reads Tile::getSolidThings, so every floor, road,
	// loot pile and walkable decoration is INVISIBLE to it, and the strict
	// `< maxViewport` filter drops the outer ring of the tile sweep as well.
	//
	// A gameplay neighbourhood query (who hears this chat, what blocks this door
	// panel, which containers are in reach) -- NOT an answer to "what should
	// this client be told about". Both login paths used to phrase the entity
	// snapshot as this call and shipped clients with no floors; only the
	// visibility tick answers that one. See ProtocolGame::reconnect.
	void getSpectators(const Position& pos, std::vector<Thing*>& spectators);

	// Players that could possibly see `pos`, for broadcasting an event AT a
	// position to everyone who can observe it. This is the inverse query to
	// getSpectators (which answers "what can this player see") and it needs to
	// be a separate entry point for two reasons:
	//
	//  - The result is deliberately a SUPERSET. getSpectators filters with
	//    `< maxViewport` while Player::canSee tests the player's view box
	//    inclusively (`<=`, the box an aimed scope may stretch or shift);
	//    reusing the former's filter would silently drop a player sitting
	//    exactly on the viewport boundary. So this only does the cheap scan
	//    of the flat player index and leaves the exact predicate to the
	//    caller, which must still call canSee on each candidate.
	//  - It yields players only, skipping the resources/objects/loot that
	//    dominate the tile contents.
	//
	// Each player's own view box (Player::getView) plus a tile of margin, so
	// every player the old all-players scan would have accepted is still a
	// candidate here, and one whose aimed scope reaches further is too.
	// `radius` (world units, 0 = each player's whole view box) shrinks the
	// gather for callers that will discard anything beyond it anyway. See the
	// definition.
	void getPotentialSpectatorPlayers(const Position& pos, std::vector<Player*>& out, int32_t radius = 0);

	// Everything on the tiles covered by an inclusive tile-coordinate box,
	// appended to `out` (which is NOT cleared -- callers reuse one scratch
	// buffer). Out-of-grid coordinates are clipped, not rejected.
	//
	// This is the general form of the sweep getSpectators does; it exists so a
	// caller with a small, local question does not have to phrase it as a
	// viewport query. Game::updateProjectiles used to call getSpectators for
	// every projectile on every tick, i.e. it swept the whole configured
	// viewport (2601 tiles at maxViewport 2500) to find collision candidates
	// for a segment shorter than one tile.
	void getSolidThingsInTileBox(int32_t minTileX, int32_t minTileY,
                             int32_t maxTileX, int32_t maxTileY,
                             std::vector<Thing*>& out) const;

	void getThingsInTileBox(int32_t minTileX, int32_t minTileY,
	                        int32_t maxTileX, int32_t maxTileY,
	                        std::vector<Thing*>& out) const;

	// The static half of the per-player visibility sweep: everything that
	// cannot move. Only re-swept when a player's viewport box shifts to a
	// different tile range, so the tile walk is amortised across ~9 ticks for a
	// walking player and skipped entirely for a standing one. Appends.
	void getStaticsInTileBox(int32_t minTileX, int32_t minTileY,
	                         int32_t maxTileX, int32_t maxTileY,
	                         std::vector<Thing*>& out) const;

	// One flat, cache-resident record per entity that can move, holding the
	// position inline so the per-player visibility scan never dereferences the
	// Thing for entities it is going to reject.
	//
	// Why a flat list instead of the tile grid: the mobile half has to be
	// rebuilt every tick, and a tile sweep costs (2*viewport/TILE_SIZE + 1)^2
	// probes per player REGARDLESS of how little is out there -- 2601 probes at
	// maxViewport 2500, to find the ~50 entities actually in view. The whole
	// mobile population is at most 255 players plus the projectile band, and at
	// 16 bytes each it fits in L1: scanning all of it beats probing the grid
	// while the mobile count stays under roughly 20k (measured probe ~17ns
	// against ~2ns per entry). Past that the tile sweep would win again.
	struct MobileEntry {
		Thing* thing;
		uint32_t id;
		uint16_t x, y;
	};
	const std::vector<MobileEntry>& getMobiles() const { return mobiles; }

	// Every live Loot on the map, maintained by placeThing/removeThing the same
	// way `mobiles` is. Exists so the per-tick expiry sweep is O(loot) instead
	// of O(everything).
	const std::vector<Loot*>& getLoots() const { return loots; }

	// Every live PLAYER on the map, same maintenance pattern again. Exists so
	// getPotentialSpectatorPlayers can answer "who might see this position"
	// from a flat 250-entry list instead of probing the tile grid; see there.
	//
	// Removal is a linear find rather than the stored-index trick `mobiles` and
	// `loots` use. It runs on logout only -- a handful of times a minute
	// against 250 entries -- and a fourth index field on every Thing would cost
	// 8 bytes on all ~9,000 of them to save nothing measurable.
	const std::vector<Player*>& getPlayerIndex() const { return playerIndex; }

	// Every live CONCEALED object (ObjectData::concealTiles > 0), same
	// maintenance pattern. The visibility pass decides these per player by
	// distance and side every tick, so it needs them as a flat list rather
	// than a tile sweep; there are tens of them, not thousands, and a linear
	// find on removal is fine for the same reason `playerIndex` gets one.
	const std::vector<Object*>& getConcealed() const { return concealed; }

	// Re-reads every mobile entity's position. Called once per tick, before the
	// per-player visibility loop, so all 255 players scan the same fresh
	// snapshot instead of chasing pointers into scattered Thing objects.
	void refreshMobilePositions();

	// Tiles beyond a swept span that still have to be searched for anything a
	// segment or point test could hit.
	//
	// A target is hit when its collision shape crosses the tested geometry, and
	// that shape reaches at most `extent` units from the target's own position.
	// Positions bucket into TILE_SIZE tiles, so for |targetPos - testPoint| <=
	// extent the tile indices differ by at most extent / TILE_SIZE + 1.
	//
	// Read from the loaded content rather than hardcoded: too small a margin is
	// silent -- shots and swings would pass through the widest objects with
	// nothing to indicate it.
	static int32_t collisionScanTileMargin();

	// How far the widest collidable body loaded reaches from its own position,
	// in world units. The same content fact collisionScanTileMargin rounds into
	// tiles, for callers that build their box in world units instead.
	static int32_t maxCollisionExtent();

	// Tile range covering pos +/- the configured viewport, inclusive. Shared by
	// every viewport sweep so they cannot drift apart.
	struct TileBox {
		int32_t minX = 0, minY = 0, maxX = 0, maxY = 0;
		bool operator==(const TileBox& o) const {
			return minX == o.minX && minY == o.minY && maxX == o.maxX && maxY == o.maxY;
		}
		bool operator!=(const TileBox& o) const { return !(*this == o); }
	};

	// The one place this arithmetic lives; three call sites had hand-rolled
	// copies of it. Takes the viewport explicitly rather than reading the config
	// itself, because the hot caller (Game::updateMovement) hoists those two
	// lookups out of its per-player loop on purpose -- a helper that read the
	// config internally would quietly put them back, once per player per tick.
	// Header-inline so it costs nothing beyond the arithmetic.
	static TileBox viewportTileBox(const Position& pos, int32_t viewX, int32_t viewY)
	{
		return offsetTileBox(pos, -viewX, -viewY, viewX, viewY);
	}

	// The tiles covering a box of offsets around `pos` -- a player's view
	// (PlayerView::box), which an aimed scope stretches or shifts.
	static TileBox offsetTileBox(const Position& pos, int32_t minDX, int32_t minDY, int32_t maxDX, int32_t maxDY)
	{
		return TileBox{
			(static_cast<int32_t>(pos.x) + minDX) / TILE_SIZE,
			(static_cast<int32_t>(pos.y) + minDY) / TILE_SIZE,
			(static_cast<int32_t>(pos.x) + maxDX) / TILE_SIZE,
			(static_cast<int32_t>(pos.y) + maxDY) / TILE_SIZE,
		};
	}

	const std::vector<Thing*>& getThings() const { return things; }

	Thing* getThingByID(uint32_t id) {
		auto it = thingMap.find(id);
		return (it != thingMap.end()) ? it->second : nullptr;
	}

	// Next free 32-bit entity id for `klass`, drawn from the shared id16 pool.
	// Returns 0 when the pool or the class quota is exhausted -- callers must
	// treat that as "cannot spawn" and MUST NOT fall back to a fixed id, which
	// is what silently aliased client entities before any of this existed.
	uint32_t acquireEntityId(EntityClass klass) { return entityIds.acquire(klass); }
	void commitEntityId(uint32_t id) { entityIds.commit(id); }
	void releaseEntityId(uint32_t id) { entityIds.release(id); }

	// The live 32-bit id holding this id16, or 0 if it is free. Lets an inbound
	// client-supplied id16 be resolved without guessing which class it belongs
	// to -- under a shared pool the guess would usually be wrong.
	uint32_t fullIdForId16(ClientEntityId id16) const { return entityIds.fullIdFor(id16); }

	// An id for a transient visual (see EntityIdPool::transientId). Never
	// collides with a live entity, and carries no class prefix -- the client
	// addresses it as a pid-0 world entity like any other.
	uint32_t transientEntityId(uint32_t slot) const { return entityIds.transientId(slot); }

	EntityIdPool& getEntityIdPool() { return entityIds; }
	const EntityIdPool& getEntityIdPool() const { return entityIds; }

	Tile* getTile(uint16_t x, uint16_t y);

	// Lookup that does NOT create the tile when it is missing. getTile() has
	// to keep its create-on-demand behaviour (placement paths rely on it), but
	// read-only scans over a neighbourhood must use this one: the map is
	// 150x150 tiles and the hot paths probe 25-225 tiles per player per tick,
	// so create-on-demand would allocate an empty Tile for every patch of
	// ground anyone walks past and grow `tiles` without bound.
	Tile* findTile(int32_t x, int32_t y) const;


private:
	// The per-type uid8 pools that used to live here are gone. They existed to
	// give the client a stale-slot guard, but 255 uids per type against
	// thousands of entities meant most shipped with uid 0 -- the boot log
	// warned about it every startup. EntityIdPool now issues globally unique
	// 24-bit ids, so an id identifies an entity on its own and the byte the uid
	// occupied carries the id's high bits instead (see definitions.h).

	std::vector<Thing*> things;
	std::unordered_map<uint32_t, Thing*> thingMap;
	std::vector<MobileEntry> mobiles;
	std::vector<Loot*> loots;
	std::vector<Player*> playerIndex;
	std::vector<Object*> concealed;
	EntityIdPool entityIds;

	// Tiles live in a flat grid indexed by tile coordinate rather than a hash
	// map. The visibility and collision scans probe 25-225 tiles per player per
	// tick, so this is the single most frequent lookup in the server; an array
	// index replaces a hash + modulo + bucket walk, and the row-major layout
	// makes the neighbourhood sweeps cache-friendly.
	//
	// Sized to the whole uint16 position space so every representable Position
	// has a slot -- no dependence on the configured map size, and no bounds
	// surprises. 656 x 656 pointers is ~3.4 MB.
	static constexpr int32_t GRID_DIM = (0xFFFF / TILE_SIZE) + 1;
	std::vector<Tile*> tileGrid;

	size_t gridIndex(int32_t x, int32_t y) const
	{
		return static_cast<size_t>(y) * GRID_DIM + static_cast<size_t>(x);
	}
};

#endif // FS_MAP_H
