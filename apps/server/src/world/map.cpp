// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "world/map.h"
#include "gameplay/creature.h"
#include "gameplay/player.h"
#include "gameplay/object.h"
#include "gameplay/loot.h"
#include "gameplay/resource.h"
#include "gameplay/projectile.h"
#include "content/configmanager.h"
#include "core/const.h"
#include "world/placement.h"

Map::Map()
{
	// Tiles are created lazily; this just reserves the (null) slot array.
	tileGrid.assign(static_cast<size_t>(GRID_DIM) * GRID_DIM, nullptr);
}

bool Map::placeThing(const Position& pos, Thing* thing)
{
	// "Already on the map?" via the id index instead of a linear scan of every
	// entity. thingMap is kept in lockstep with `things` below, and comparing
	// the stored pointer keeps this exact even if an id were ever reused.
	auto known = thingMap.find(thing->getID());
	if (known != thingMap.end() && known->second == thing) {
		Position oldPos = thing->getPosition();
		int32_t oldTileX = oldPos.x / TILE_SIZE, oldTileY = oldPos.y / TILE_SIZE;
		int32_t newTileX = pos.x / TILE_SIZE, newTileY = pos.y / TILE_SIZE;

		Tile* oldTile = getTile(oldTileX, oldTileY);
		if (oldTile) {
			oldTile->removeThing(thing);
			if (Creature* creature = thing->getCreature()) {
				for (Thing* t : oldTile->getThings()) {
					if (Object* obj = t->getObject()) {
						obj->onCreatureLeave(creature);
					}
				}
			}
		}

		thing->setPosition(pos);
		if (Creature* creature = thing->getCreature()) {
			creature->resetDirty();
		}

		Tile* newTile = getTile(newTileX, newTileY);
		if (newTile) {
			newTile->addThing(thing);
			if (Creature* creature = thing->getCreature()) {
				for (Thing* t : newTile->getThings()) {
					if (Object* obj = t->getObject()) {
						obj->onCreatureEnter(creature);
					}
				}
			}
		}
		return true;
	}

	thing->setPosition(pos);

	if (Creature* creature = thing->getCreature()) {
		creature->resetDirty(); // Sync lastPosition so it doesn't glide from 0,0
	}
	thing->setThingsIndex(things.size());
	things.push_back(thing);
	thingMap[thing->getID()] = thing;

	// The id16 becomes occupied here, not when it was named, so a factory that
	// names an entity and then fails to place it leaks nothing.
	entityIds.commit(thing->getID());

	// Mobile index membership follows map membership, not tile membership, so
	// the tile-crossing paths in updateMovement and updateProjectiles need no
	// changes -- refreshMobilePositions picks their new positions up.
	if (thing->isMobile()) {
		thing->setMobilesIndex(mobiles.size());
		mobiles.push_back({thing, thing->getID(),
		                   static_cast<uint16_t>(pos.x), static_cast<uint16_t>(pos.y)});
	}

	// Same pattern for loot, so the per-tick expiry sweep visits only loot
	// instead of every thing on the map. At 250 bots throwing items that was
	// 8,800 things scanned per tick to find a handful of expired ones -- 6.2ms
	// of a tick that also had no projectiles in it at all.
	if (thing->getLoot()) {
		thing->setLootIndex(loots.size());
		loots.push_back(thing->getLoot());
	}

	// Player index, same rule: membership follows MAP membership, so a player
	// walking between tiles never touches this list. Reached only on the
	// first-placement path above, so a teleport (which returns early) cannot
	// double-insert.
	if (Creature* creature = thing->getCreature()) {
		if (Player* p = creature->getPlayer()) {
			playerIndex.push_back(p);
		}
	}

	// Concealed objects, same rule: the per-player reveal pass reads this list.
	if (Object* obj = thing->getObject()) {
		if (obj->isConcealed()) {
			concealed.push_back(obj);
		}
	}

	Tile* tile = getTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (tile) {
		tile->addThing(thing);
	}

	return true;
}

void Map::removeThing(Thing* thing)
{
	// Ignore things that were never placed (or are already gone): dropping a
	// reference that was never taken deletes the thing while its owner still
	// holds it. A failed login is the real case — the player exists but
	// placement failed.
	auto known = thingMap.find(thing->getID());
	if (known == thingMap.end() || known->second != thing) {
		return;
	}

	// O(1) swap-with-last + pop. The index is kept current by placeThing and
	// here; verified against the stored pointer so a stale index cannot corrupt
	// the vector. Nothing iterates `things` in order, so the reshuffle is safe.
	const size_t idx = thing->getThingsIndex();
	if (idx < things.size() && things[idx] == thing) {
		Thing* last = things.back();
		things[idx] = last;
		last->setThingsIndex(idx);
		things.pop_back();
	} else {
		auto it = std::find(things.begin(), things.end(), thing);
		if (it != things.end()) {
			things.erase(it);
		}
	}
	thingMap.erase(thing->getID());
	entityIds.release(thing->getID());
	// Beside the release on purpose. The id is about to become reissuable, so a
	// placement still holding it would name whatever inherits it next.
	//
	// Objects only: nothing else can belong to a stamp, and this runs on every
	// projectile expiry.
	if (entityClassFromId(thing->getID()) == EntityClass::Object) {
		g_placements.forget(thing->getID());
	}

	const size_t mobileIdx = thing->getMobilesIndex();
	if (mobileIdx != Thing::NOT_INDEXED && mobileIdx < mobiles.size() &&
	    mobiles[mobileIdx].thing == thing) {
		mobiles[mobileIdx] = mobiles.back();
		mobiles[mobileIdx].thing->setMobilesIndex(mobileIdx);
		mobiles.pop_back();
	}
	thing->setMobilesIndex(Thing::NOT_INDEXED);

	const size_t lootIdx = thing->getLootIndex();
	if (lootIdx != Thing::NOT_INDEXED && lootIdx < loots.size() &&
	    loots[lootIdx] == thing->getLoot()) {
		loots[lootIdx] = loots.back();
		loots[lootIdx]->setLootIndex(lootIdx);
		loots.pop_back();
	}
	thing->setLootIndex(Thing::NOT_INDEXED);

	if (Creature* creature = thing->getCreature()) {
		if (Player* p = creature->getPlayer()) {
			auto pit = std::find(playerIndex.begin(), playerIndex.end(), p);
			if (pit != playerIndex.end()) {
				*pit = playerIndex.back();
				playerIndex.pop_back();
			}
		}
	}

	if (Object* obj = thing->getObject()) {
		if (obj->isConcealed()) {
			auto cit = std::find(concealed.begin(), concealed.end(), obj);
			if (cit != concealed.end()) {
				*cit = concealed.back();
				concealed.pop_back();
			}
		}
	}

	Tile* tile = thing->getTile();
	if (tile) {
		tile->removeThing(thing);
	}

	if (Creature* c = thing->getCreature()) {
		c->decrementReferenceCounter();
	}
}

void EntityIdPool::configure(uint32_t newSpace, const uint32_t (&newReserve)[ENTITY_CLASS_COUNT],
                             const uint32_t (&newCap)[ENTITY_CLASS_COUNT])
{
	if (newSpace == 0 || newSpace > CLIENT_ENTITY_ID_SPACE_MAX) {
		newSpace = CLIENT_ENTITY_ID_SPACE_DEFAULT;
	}
	space = newSpace;

	// The top of the space is held for transient visuals (explosions), which
	// need distinguishable ids but have no entity to own one. acquire() must
	// never hand these out or a blast would erase a live entity's sprite.
	issuable = (space > CLIENT_ENTITY_ID_TRANSIENT_COUNT + 1)
		? space - CLIENT_ENTITY_ID_TRANSIENT_COUNT : space;

	// id16 0 is reserved as a "none" sentinel, which several server paths rely
	// on, so the assignable range is 1 .. issuable-1.
	owner.assign(space, static_cast<uint8_t>(EntityClass::None));
	const uint32_t usable = issuable - 1;

	uint32_t reserveTotal = 0;
	for (size_t i = 0; i < ENTITY_CLASS_COUNT; ++i) {
		reserve[i] = newReserve[i];
		cap[i] = newCap[i];
		reserveTotal += reserve[i];
	}

	// Caller-side clamping should make this unreachable; keep the pool itself
	// total anyway rather than let reserves exceed the space they carve up.
	if (reserveTotal > usable) {
		for (uint32_t& r : reserve) {
			r = static_cast<uint32_t>((static_cast<uint64_t>(r) * usable) / reserveTotal);
		}
		reserveTotal = 0;
		for (uint32_t r : reserve) reserveTotal += r;
	}

	shared = usable - reserveTotal;
	sharedUsed = 0;
	freeIds = usable;
	cursor = 1;
	for (uint32_t& n : live) n = 0;
}

bool EntityIdPool::canAcquire(EntityClass klass) const
{
	const size_t i = static_cast<size_t>(klass);
	if (klass == EntityClass::None || i >= ENTITY_CLASS_COUNT || freeIds == 0) {
		return false;
	}
	if (cap[i] != 0 && live[i] >= cap[i]) {
		return false;
	}
	// Still inside its own floor, or there is room left in the shared pool.
	return live[i] < reserve[i] || sharedUsed < shared;
}

uint32_t EntityIdPool::acquire(EntityClass klass)
{
	if (!canAcquire(klass)) {
		return 0;
	}

	// freeIds > 0 is guaranteed by canAcquire, so this terminates; the bound is
	// belt-and-braces against the table and the counter ever disagreeing.
	for (uint32_t tried = 0; tried < issuable; ++tried) {
		const uint32_t id16 = cursor;
		cursor = (id16 + 1 >= issuable) ? 1u : id16 + 1;

		if (owner[id16] == static_cast<uint8_t>(EntityClass::None)) {
			return entityClassPrefix(klass) | id16;
		}
	}

	return 0;
}

void EntityIdPool::commit(uint32_t fullId)
{
	const EntityClass klass = entityClassFromId(fullId);
	if (klass == EntityClass::None) {
		return; // players: their ids never come from this pool
	}

	const uint32_t id16 = fullId & CLIENT_ENTITY_ID_MASK;
	if (id16 == 0 || id16 >= owner.size() ||
	    owner[id16] != static_cast<uint8_t>(EntityClass::None)) {
		return; // already committed (a re-place), or out of range
	}

	owner[id16] = static_cast<uint8_t>(klass);
	--freeIds;

	const size_t i = static_cast<size_t>(klass);
	if (live[i] >= reserve[i]) {
		++sharedUsed; // this one is borrowed, not covered by the class floor
	}
	++live[i];
}

void EntityIdPool::release(uint32_t fullId)
{
	const EntityClass klass = entityClassFromId(fullId);
	if (klass == EntityClass::None) {
		return;
	}

	const uint32_t id16 = fullId & CLIENT_ENTITY_ID_MASK;
	if (id16 == 0 || id16 >= owner.size() ||
	    owner[id16] != static_cast<uint8_t>(klass)) {
		return; // never committed, or held by someone else
	}

	owner[id16] = static_cast<uint8_t>(EntityClass::None);
	++freeIds;

	const size_t i = static_cast<size_t>(klass);
	if (live[i] > 0) {
		--live[i];
		if (live[i] >= reserve[i] && sharedUsed > 0) {
			--sharedUsed;
		}
	}
}

void Map::getSpectators(const Position& pos, std::vector<Thing*>& spectators)
{
	// Viewport is read once per call rather than per candidate: these are
	// config lookups and this runs once per player per tick.
	const int32_t maxViewportX = ConfigManager::getNumber(ConfigManager::MAX_VIEWPORT_X);
	const int32_t maxViewportY = ConfigManager::getNumber(ConfigManager::MAX_VIEWPORT_Y);

	// Only tiles that can possibly contain a visible thing are visited, instead
	// of testing every entity on the map. The old scan was O(all things) per
	// player per tick -- ~7.5k entities x N players x 20 Hz -- which is what
	// made the tick collapse once bots were spawned. Tile membership is already
	// maintained by placeThing/removeThing and the movement path, so the bucket
	// index is free.
	//
	// A thing is kept only if it passes the exact same per-axis viewport test as
	// before, so the visible set is unchanged; the tile sweep is purely a way to
	// avoid looking at entities that cannot possibly qualify.
	const TileBox box = viewportTileBox(pos, maxViewportX, maxViewportY);

	for (int32_t tx = box.minX; tx <= box.maxX; ++tx) {
		for (int32_t ty = box.minY; ty <= box.maxY; ++ty) {
			const Tile* tile = findTile(tx, ty);
			if (!tile) {
				continue;
			}

			for (Thing* thing : tile->getSolidThings()) {
				const Position& tp = thing->getPosition();
				if (std::abs(tp.x - pos.x) < maxViewportX &&
					std::abs(tp.y - pos.y) < maxViewportY) {
					spectators.push_back(thing);
				}
			}
		}
	}
}

void Map::getThingsInTileBox(int32_t minTileX, int32_t minTileY,
                             int32_t maxTileX, int32_t maxTileY,
                             std::vector<Thing*>& out) const
{
	// Clip once instead of bounds-checking every probe: the grid covers the
	// whole uint16 position space, so this only trims boxes that ran off an
	// edge, and the inner loop then walks a contiguous row span.
	minTileX = std::max(minTileX, 0);
	minTileY = std::max(minTileY, 0);
	maxTileX = std::min(maxTileX, GRID_DIM - 1);
	maxTileY = std::min(maxTileY, GRID_DIM - 1);

	for (int32_t ty = minTileY; ty <= maxTileY; ++ty) {
		const size_t rowBase = static_cast<size_t>(ty) * GRID_DIM;
		for (int32_t tx = minTileX; tx <= maxTileX; ++tx) {
			const Tile* tile = tileGrid[rowBase + static_cast<size_t>(tx)];
			if (!tile) {
				continue;
			}
			const std::vector<Thing*>& things = tile->getThings();
			out.insert(out.end(), things.begin(), things.end());
		}
	}
}

int32_t Map::maxCollisionExtent()
{
	static const int32_t extent = [] {
		return static_cast<int32_t>(std::max(g_objects.getMaxCollisionExtent(),
		                                     g_resources.getMaxCollisionExtent()));
	}();
	return extent;
}

int32_t Map::collisionScanTileMargin()
{
	static const int32_t margin = maxCollisionExtent() / TILE_SIZE + 1;
	return margin;
}

void Map::refreshMobilePositions()
{
	for (MobileEntry& entry : mobiles) {
		const Position& pos = entry.thing->getPosition();
		entry.x = pos.x;
		entry.y = pos.y;
	}

	// Sorted by id ONCE per tick, so that every player's visible set comes out
	// of the scan already ordered and the diff can merge it directly.
	//
	// The per-player std::sort this replaces ran once per client per tick over
	// ~250 entries -- 250 sorts of the same population, to produce 250 nearly
	// identical orderings. The merge in diffVisibleSet is the only thing that
	// needs the order, and the order is a property of the population, not of
	// the observer.
	//
	// `mobiles` is maintained by swap-and-pop, so it is unsorted by nature and
	// this genuinely re-sorts rather than confirming. It is cheap anyway: the
	// array is already almost in order every tick after the first, since only
	// spawns and deaths disturb it.
	std::sort(mobiles.begin(), mobiles.end(),
		[](const MobileEntry& a, const MobileEntry& b) { return a.id < b.id; });

	// MUST follow the sort: removeThing finds an entry through the index stored
	// on the Thing, and reordering invalidates every one of them. It does check
	// `mobiles[idx].thing == thing` before touching anything, so a stale index
	// would not corrupt the vector -- it would silently skip the removal and
	// leave a dangling Thing* in the scan, which is worse.
	for (size_t i = 0; i < mobiles.size(); ++i) {
		mobiles[i].thing->setMobilesIndex(i);
	}
}

// The clamp-and-walk scaffolding below is a deliberate copy of
// getThingsInTileBox rather than a shared helper. Both are per-tick hot paths --
// this one is the viewport-scaling half of `spec` -- and the only difference is
// the inner action, so factoring them together means either a runtime branch in
// the innermost loop or moving the loop into a header template. Neither is worth
// buying ten lines of dedup on this code without an A,B,B,A measurement first.
// If you do measure it and the template is free, merge them; until then, any
// edit to one of these two functions must be made to the other.
void Map::getStaticsInTileBox(int32_t minTileX, int32_t minTileY,
                              int32_t maxTileX, int32_t maxTileY,
                              std::vector<Thing*>& out) const
{
	minTileX = std::max(minTileX, 0);
	minTileY = std::max(minTileY, 0);
	maxTileX = std::min(maxTileX, GRID_DIM - 1);
	maxTileY = std::min(maxTileY, GRID_DIM - 1);

	for (int32_t ty = minTileY; ty <= maxTileY; ++ty) {
		const size_t rowBase = static_cast<size_t>(ty) * GRID_DIM;
		for (int32_t tx = minTileX; tx <= maxTileX; ++tx) {
			const Tile* tile = tileGrid[rowBase + static_cast<size_t>(tx)];
			if (!tile) {
				continue;
			}
			// Filtered out of the full list rather than kept as a third vector:
			// this runs only when a player's viewport box shifts, so the extra
			// predicate is far cheaper than a second membership list to keep in
			// sync on every placement and removal.
			for (Thing* thing : tile->getThings()) {
				if (!thing->isMobile()) {
					out.push_back(thing);
				}
			}
		}
	}
}

void Map::getPotentialSpectatorPlayers(const Position& pos, std::vector<Player*>& out, int32_t radius)
{
	// `radius` bounds the gather for callers that already know they will
	// discard anything further away -- the cosmetic event broadcasts, which
	// stop at EVENT_BROADCAST_RADIUS. Sweeping the whole viewport for them cost
	// (2*1700/100+1)^2 = 1,225 tile probes per event, and a crowded firefight
	// generates hundreds of events per tick: it measured as the bulk of the
	// projectile phase, dwarfing the collision tests it was billed alongside.
	//
	// 0 (the default) keeps each player's whole view box, which is what every
	// other caller needs.

	// Scans the flat player index, NOT the tile grid.
	//
	// The grid sweep this replaces cost (2*viewport/TILE_SIZE + 1)^2 probes --
	// 1,225 at viewport 1700 -- to find recipients among at most 255 players,
	// and it ran once per surgical update, once per cosmetic event and once per
	// SHOT. In a 250-bot firefight that was ~306,000 tile probes per tick at
	// ~17ns each. The same reasoning that put the visibility sweep on a flat
	// mobile list applies here and more strongly, because the population this
	// one searches is players alone.
	//
	// Superset preserved. The old sweep gathered whole TILES, so a player up to
	// TILE_SIZE-1 units beyond the viewport edge was still a candidate; the
	// reach below keeps that margin rather than tightening to the viewport.
	// Narrowing the candidate set here would silently drop boundary recipients,
	// and this function's contract is explicitly "potential" -- the caller
	// applies Player::canSee, which is the real test.
	//
	// BEHAVIOUR CHANGE, deliberate: the old sweep read Tile::getSolidThings(),
	// which a Player only joins when hasCollision() is true -- i.e. never for an
	// admin in ghost mode. Those players were silently missing from every
	// surgical update and every cosmetic broadcast, and only re-synced when their
	// viewport box happened to shift. Whether a player can SEE something is not a
	// property of whether they are solid, so the index carries every live player.
	//
	// Each player's own view decides (aim_view::mayWatch): the viewport box for
	// anyone not aiming, as before, and as far as an aimed scope reaches for
	// anyone who is. TILE_SIZE is the margin the old tile sweep had.
	const int32_t px = static_cast<int32_t>(pos.x);
	const int32_t py = static_cast<int32_t>(pos.y);

	for (Player* player : playerIndex) {
		const Position& ppos = player->getPosition();
		if (!aim_view::mayWatch(player->getView(), px - static_cast<int32_t>(ppos.x),
				py - static_cast<int32_t>(ppos.y), radius, TILE_SIZE)) {
			continue;
		}
		out.push_back(player);
	}
}

Tile* Map::findTile(int32_t x, int32_t y) const
{
	if (x < 0 || y < 0 || x >= GRID_DIM || y >= GRID_DIM) {
		return nullptr;
	}
	return tileGrid[gridIndex(x, y)];
}

Tile* Map::getTile(uint16_t x, uint16_t y)
{
	// Every caller passes a tile coordinate (position / TILE_SIZE) and
	// null-checks the result, so an out-of-grid coordinate -- which no valid
	// Position can produce -- yields nullptr rather than a junk tile.
	if (x >= GRID_DIM || y >= GRID_DIM) {
		return nullptr;
	}

	Tile*& slot = tileGrid[gridIndex(x, y)];
	if (!slot) {
		slot = new Tile(x, y);
	}
	return slot;
}


void Map::getSolidThingsInTileBox(int32_t minTileX, int32_t minTileY,
                             int32_t maxTileX, int32_t maxTileY,
                             std::vector<Thing*>& out) const
{
	minTileX = std::max(minTileX, 0);
	minTileY = std::max(minTileY, 0);
	maxTileX = std::min(maxTileX, GRID_DIM - 1);
	maxTileY = std::min(maxTileY, GRID_DIM - 1);

	for (int32_t ty = minTileY; ty <= maxTileY; ++ty) {
		const size_t rowBase = static_cast<size_t>(ty) * GRID_DIM;
		for (int32_t tx = minTileX; tx <= maxTileX; ++tx) {
			const Tile* tile = tileGrid[rowBase + static_cast<size_t>(tx)];
			if (!tile) {
				continue;
			}
			const std::vector<Thing*>& things = tile->getSolidThings();
			out.insert(out.end(), things.begin(), things.end());
		}
	}
}
