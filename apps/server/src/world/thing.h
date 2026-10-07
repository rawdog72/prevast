// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_THING_H
#define FS_THING_H

#include "core/definitions.h"
#include "core/enums.h"
#include "core/position.h"
#include <cstdint>

// One entity record. The wire layout it maps to is 18 bytes and is described
// in definitions.h under WIRE ENCODING -- `id` is split across two of them and
// there is no longer a `uid` field; see there before changing anything here.
struct EntityUpdate {
	uint8_t pid = 0;
	uint8_t rotation = 0;
	uint8_t type = 0;
	uint16_t state = 0;
	uint16_t extra = 0;
	ClientEntityId id = 0;
	uint16_t startX = 0;
	uint16_t startY = 0;
	uint16_t endX = 0;
	uint16_t endY = 0;

	bool isDestruction = false;

	// Turn a record built by buildUpdate() into a REMOVAL record.
	//
	// `state` 0 is the removal sentinel, and on a removal record the client
	// stops reading `extra` as look bits: client.js onUnits passes it straight
	// into Entitie.remove as `keepInCache`, and the ONLY value that means
	// anything there is 1 -- "keep a copy of this entity and play its removal
	// animation". So whatever buildUpdate() packed into `extra` must be
	// overwritten here, not inherited.
	//
	// Inheriting it is a silent, per-type bug that fires only for the one look
	// value that happens to equal 1. Two shipped instances: AI sprite 1 is the
	// FAST GHOUL, so every fast ghoul that merely walked out of a viewport
	// played its death animation on screen; clientProjectileId 1 is the 7.62
	// round, so rifle rounds faded on removal while the other eight ammo types
	// blinked out. Everything else was correct by luck.
	void makeRemoval()
	{
		state = 0;
		extra = isDestruction ? 1 : 0;
	}
};

class Creature;
class Object;
class Loot;
class Resource;
class Agent;
class Npc;

class Thing
{
public:
	constexpr Thing() = default;
	virtual ~Thing() = default;

	// non-copyable
	Thing(const Thing&) = delete;
	Thing& operator=(const Thing&) = delete;

	virtual void buildUpdate(EntityUpdate&) const {}
	virtual void buildRemoval(EntityUpdate&) const {}

	// buildUpdate depends only on this entity's own state -- no implementation
	// reads anything about the observer -- so within one tick every observer
	// gets an identical result. Clustered players multiply that: 255 observers
	// seeing 255 entities rebuilt the same 255 updates 65k times per tick.
	// `tick` must be non-zero and change every tick.
	const EntityUpdate& getCachedUpdate(uint32_t tick)
	{
		if (cachedUpdateTick != tick) {
			cachedUpdate = EntityUpdate{};
			buildUpdate(cachedUpdate);
			cachedUpdateTick = tick;
		}
		return cachedUpdate;
	}

	virtual Creature* getCreature() { return nullptr; }
	virtual const Creature* getCreature() const { return nullptr; }

	// Cheap downcasts, same pattern as getCreature() above. The tile-scan hot
	// paths (tile enter/leave notification, loot expiry, uid-pool typing) used
	// dynamic_cast on every entity they touched; under MSVC that is a string
	// comparison walk through the RTTI graph, and at ~7.5k entities x 20 Hz it
	// measured as a large fixed cost per tick. A vtable slot makes the same
	// test a single indirect call.
	virtual Object* getObject() { return nullptr; }
	virtual const Object* getObject() const { return nullptr; }

	virtual Loot* getLoot() { return nullptr; }
	virtual const Loot* getLoot() const { return nullptr; }

	virtual Resource* getResource() { return nullptr; }
	virtual const Resource* getResource() const { return nullptr; }

	virtual Agent* getAgent() { return nullptr; }
	virtual const Agent* getAgent() const { return nullptr; }

	virtual Npc* getNpc() { return nullptr; }
	virtual const Npc* getNpc() const { return nullptr; }

	virtual bool hasCollision() const { return false; }

	// Does this entity block `other` specifically? Collision is a PAIRWISE
	// question for agents -- a bot type may be walked through by its own kind and
	// solid to everything else -- and hasCollision() alone cannot express that,
	// because it never learns who is asking. Defaults to the unary answer, so
	// only Agent overrides it.
	virtual bool collidesWith(const Thing* other) const { (void)other; return hasCollision(); }

	virtual float getCollisionRadius() const { return 0.0f; }
	virtual bool getCollisionRect(struct CollisionRect&) const { return false; }

	virtual bool isDirty() const { return false; }
	virtual void resetDirty() {}

	// isDirty() answered ONCE per entity per tick.
	//
	// Dirtiness is a property of the entity, exactly like the update record
	// getCachedUpdate() caches -- no implementation reads anything about the
	// observer. The visibility diff was asking it once per OBSERVER per entity
	// (~62,500 times a tick at 250 clients), and it is not a cheap question:
	// Creature::isDirty() is virtual, compares seven fields, and calls
	// getSpeed(), which walks every Thing on the creature's tile.
	//
	// Filled by the dirty scan in Game::updateMovement, which already visits
	// every thing and already calls isDirty() on each. Nothing moves between
	// that scan and the visibility loop, and resetDirty() does not run until
	// after the flush, so the cached answer is valid for the whole tick.
	void cacheDirty(bool value) { dirtyCached = value; }
	bool wasDirtyThisTick() const { return dirtyCached; }

	// Can this entity change position after it has been placed? Tile membership
	// is split on this so the visibility sweep can ask for just the movers; see
	// isMobileEntityId in definitions.h for why that split pays.
	virtual bool isMobile() const { return false; }
	virtual bool isVisualSuppressed() const { return false; }

	virtual bool isRemoved() const { return true; }

	virtual class Tile* getTile() { return nullptr; }
	virtual const class Tile* getTile() const { return nullptr; }

	virtual const Position& getPosition() const { static Position p(0,0); return p; }
	virtual void setPosition(const Position&) {}

	virtual uint32_t getID() const { return id; }
	virtual void setID(uint32_t newId) {
		id = newId;
		id16 = static_cast<ClientEntityId>(newId & CLIENT_ENTITY_ID_MASK);
	}

	ClientEntityId getId16() const { return id16; }

	// Slot in Map::things, maintained by Map so removal is O(1) (swap-with-last
	// + pop) instead of a linear find over the whole entity list.
	size_t getThingsIndex() const { return thingsIndex; }
	void setThingsIndex(size_t index) { thingsIndex = index; }

	// Slot in Map's mobile index, or NOT_INDEXED for anything static.
	static constexpr size_t NOT_INDEXED = static_cast<size_t>(-1);
	size_t getMobilesIndex() const { return mobilesIndex; }
	void setMobilesIndex(size_t index) { mobilesIndex = index; }

	// Slot in Map's loot index, or NOT_INDEXED for anything that is not loot.
	// Separate from mobilesIndex rather than sharing one field: loot happens to
	// be static today, and a shared slot would break silently the day it is not.
	size_t getLootIndex() const { return lootIndex; }
	void setLootIndex(size_t index) { lootIndex = index; }

private:
	uint32_t id = 0;
	ClientEntityId id16 = 0;
	size_t thingsIndex = 0;
	size_t mobilesIndex = NOT_INDEXED;
	size_t lootIndex = NOT_INDEXED;

	EntityUpdate cachedUpdate;
	uint32_t cachedUpdateTick = 0; // 0 = never built; the tick counter starts at 1
	bool dirtyCached = false;      // see cacheDirty
};

#endif // FS_THING_H
