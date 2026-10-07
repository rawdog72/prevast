// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_RESOURCE_H
#define FS_RESOURCE_H

#include "world/thing.h"
#include "core/position.h"
#include "core/definitions.h"
#include "world/mapsize.h"
#include <pugixml.hpp>
#include <unordered_map>
#include <vector>
#include <string>

// Structure to match XML Type definitions
struct ResourceType {
	uint16_t id;
	uint16_t life;
	uint16_t radius;
	std::string layer;
	uint8_t protocolType;
	uint8_t collision;
	uint16_t unitsMin;
	uint16_t unitsMax;
};

// Drops use the shared ItemDrop shape (definitions.h) that objects, furnitures and
// agents also use -- this file used to have its own <loot key chance countMax>
// spelling and its own struct for the same idea.

// Structure to match XML Resource definitions
struct ResourceData {
	uint16_t id;
	std::string key;
	float experience;
	std::vector<ItemDrop> drops;
	std::unordered_map<std::string, float> toolMultipliers;
	std::vector<ResourceType> types;

	std::vector<AreaEffect> areaEffects;
};

class Resource final : public Thing
{
public:
	Resource(uint16_t id, uint16_t typeId);
	~Resource() override = default;

	// Thing overrides
	void buildUpdate(EntityUpdate& out) const override;
	void buildRemoval(EntityUpdate& out) const override;

	Resource* getResource() override { return this; }
	const Resource* getResource() const override { return this; }

	Tile* getTile() override;
	const Tile* getTile() const override;

	const Position& getPosition() const { return position; }
	void setPosition(const Position& pos) { position = pos; }

	uint8_t getRotation() const { return rotation; }
	void setRotation(uint8_t rot) { rotation = rot; }

	uint8_t getImpactAngle() const { return impactAngle; }
	void setImpactAngle(uint8_t angle) { impactAngle = angle; }

	uint16_t getResourceId() const { return resourceId; }
	uint16_t getTypeId() const { return typeId; }

	// The protocol type this resource ships as (8/9/10/11 by layer), which is
	// also the uid8 pool it must draw from -- the client buckets entities by
	// type, so a uid only has to be unique within one.
	uint8_t getProtocolType() const;

	uint16_t getHealth() const { return health; }
	void setHealth(uint16_t hp) { health = hp; }
	// int32_t delta, same reason as Object::changeHealth (see definitions.h).
	//
	// RETURNS the delta actually applied, signed like the request and 0 when
	// nothing landed. Trimmed to what the node had left. Same contract as
	// Player/Agent/Object changeHealth.
	int32_t changeHealth(int32_t healthDelta, uint8_t angle = 0, class Player* attacker = nullptr);

	bool hasCollision() const override;
	float getCollisionRadius() const override;

	bool isRemoved() const { return removed; }
	void setRemoved(bool val) { removed = val; }

private:
	void harvestDrops(Player* attacker, const ResourceData* rd, float multiplier);
	void handleResourceDeath(const ResourceData* rd);

	uint16_t resourceId = 0; // The XML ID (0=wood, 1=leaf_tree, 2=stone)
	uint16_t typeId = 0; // The XML sub-type ID
	uint16_t health = 0;
	Position position;
	uint8_t rotation = 0;
	uint8_t impactAngle = 0;
	bool removed = false;
};

struct RespawnItem {
	std::string key;
	uint64_t respawnTime;
};

class ResourceManager
{
public:
	ResourceManager() = default;
	~ResourceManager() = default;

	bool loadFromXml(const std::string& filename);
	
	const ResourceData* getResourceData(uint16_t id) const;
	const ResourceData* getResourceData(const std::string& key) const;

	Resource* createResource(const std::string& key, uint16_t typeId, const Position& pos, uint8_t rotation = 0);
	
	// What a population pass actually managed. Reported so an admin rebuilding a
	// LIVE world is told the world came up short, instead of discovering it by
	// walking around one. `outOfIds` is the one that matters: it means the
	// entity id pool ran dry, not that the map was full.
	struct PopulateReport
	{
		uint32_t spawned = 0;
		uint32_t wanted = 0;
		bool outOfIds = false;
	};

	// `worldSeed` names the world being built; every draw comes from a stream
	// derived from it (worldgen.h), one per resource type, so retuning one
	// resource cannot move the others and a rebuild mid-session lays out the
	// same map as a fresh boot on that seed.
	//
	// `budget` is whatever the structure pass left of the map's tile allowance.
	// Every type's count is scaled by ONE rational derived from it, so the mix
	// of resource types is identical at every map size -- see
	// MapSize::contentScaleFor. Run this AFTER structures.
	PopulateReport populateMap(uint32_t worldSeed, MapSize::ContentBudget& budget);
	void updateRespawn();
	void onResourceDestroyed(const std::string& key);

	// Forgets all live accounting, for a world that is being regenerated from a
	// new seed (!seed=<n>). Removing the old resources queues a respawn for every
	// one of them, and those would fire minutes later and pile thousands of extra
	// trees on top of the freshly generated map. Call AFTER the old resources are
	// gone and BEFORE populateMap.
	void resetForRegeneration()
	{
		respawnQueue.clear();
		counts.clear();
		resourceLimits.clear();
	}

	// How long a harvested resource waits before it comes back somewhere else.
	// 0 = NEVER: nothing is queued for respawn, and the periodic relocation
	// churn below stops as well.
	//
	// That second half is not optional. updateRespawn also removes a random
	// live resource every 20s to keep the world moving, relying on the respawn
	// queue to put it back. With respawn off and the churn still running, the
	// map would quietly strip itself of resources over an hour or two -- so
	// "never respawn" has to mean "never remove either".
	void setRespawnDelayMs(uint32_t ms) { respawnDelayMs = ms; }
	uint32_t getRespawnDelayMs() const { return respawnDelayMs; }
	bool isRespawnEnabled() const { return respawnDelayMs != 0; }

	uint32_t getCount(const std::string& key) const;

	// See ObjectManager::getMaxCollisionExtent -- same purpose, for resources.
	uint16_t getMaxCollisionExtent() const { return maxCollisionExtent; }

	// Sum of every type's unitsMax: the most resources the loaded content can
	// ever have alive at once, and therefore the most id space this class can
	// ever occupy. Reported at startup as a demand figure -- NOT turned into a
	// reserve, because it is editable content and a reserve is a promise.
	uint32_t totalUnitsMax() const
	{
		uint32_t total = 0;
		for (const auto& [id, data] : resources) {
			for (const ResourceType& type : data.types) {
				total += type.unitsMax;
			}
		}
		return total;
	}

private:
	uint16_t maxCollisionExtent = 0;
	// Resolved from the active mode in Game::start; see setRespawnDelayMs.
	uint32_t respawnDelayMs = DEFAULT_RESPAWN_DELAY_MS;
	std::unordered_map<uint16_t, ResourceData> resources;
	std::unordered_map<std::string, uint16_t> keyToIdMap;
	std::unordered_map<std::string, uint32_t> counts;
	std::unordered_map<std::string, uint32_t> resourceLimits;
	std::vector<RespawnItem> respawnQueue;
	bool warnedExhausted = false;

	// Runtime respawn: draws from the process RNG and refuses any tile that is
	// occupied right now, creatures and loot included. Nothing about the world
	// seed applies -- where a felled tree comes back is not part of what the
	// seed reproduces.
	Position findRandomSpawnPosition();

	// World generation: draws from `rng` and considers only the STATIC world.
	// A bot wandering across the map must not change where the trees are, and
	// under a shared retry loop it did -- every rejected tile consumed two more
	// draws and shifted everything after it. See populateMap.
	Position findGenerationSpawnPosition(class WorldRng& rng);
};

extern ResourceManager g_resources;

#endif // FS_RESOURCE_H
