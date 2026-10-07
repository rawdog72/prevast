// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_LOOT_H
#define FS_LOOT_H

#include "world/thing.h"
#include "core/position.h"
#include "gameplay/item.h"
#include <cmath>
#include <cstdint>
#include <cstdlib>

class Loot final : public Thing
{
public:
	Loot(uint16_t lootId, uint16_t itemIid, uint8_t count, const ItemState& state, const Position& spawnPos);
	~Loot() override = default;

	// non-copyable
	Loot(const Loot&) = delete;
	Loot& operator=(const Loot&) = delete;

	// Thing overrides
	void buildUpdate(EntityUpdate& out) const override;
	void buildRemoval(EntityUpdate& out) const override;

	Loot* getLoot() override { return this; }
	const Loot* getLoot() const override { return this; }

	Tile* getTile() override;
	const Tile* getTile() const override;

	const Position& getPosition() const override { return position; }
	void setPosition(const Position& pos) override { position = pos; }

	uint16_t getLootId() const { return lootId; }
	uint16_t getItemIID() const { return itemIid; }
	uint8_t getCount() const { return count; }
	void setCount(uint8_t newCount) { count = newCount; }
	uint8_t getAmmo() const { return state.ammo; }
	// Ammo and fitted mods, handed to whoever picks it up.
	const ItemState& getState() const { return state; }

	void setAttackerPid(uint8_t pid) { attackerPid = pid; }
	bool isTaken() const { return isTakenVal; }
	void setTaken(bool taken);
	int64_t getTakenTime() const { return takenTime; }

	bool isGhost() const { return isGhostVal; }
	void setGhost(bool ghost) { isGhostVal = ghost; }

	int64_t getSpawnTime() const { return spawnTime; }
	void setSpawnTime(int64_t time) { spawnTime = time; }

	bool isDirty() const override {
		return position != lastPosition || isTakenVal != lastTaken;
	}

	void resetDirty() override {
		lastPosition = position;
		lastTaken = isTakenVal;
	}

private:
	uint16_t lootId = 0; // Visual Index (LOOTID)
	uint16_t itemIid = 0; // Inventory Item IID
	uint8_t count = 1;
	ItemState state = ItemState::withAmmo(0);
	uint8_t attackerPid = 0;
	bool isTakenVal = false;
	bool lastTaken = false;
	bool isGhostVal = false;
	Position position;
	Position lastPosition;
	Position spawnPosition;
	int64_t spawnTime = 0;
	int64_t takenTime = 0;
};

class LootManager
{
public:
	LootManager() = default;

	static LootManager& getInstance() {
		static LootManager instance;
		return instance;
	}

	// non-copyable
	LootManager(const LootManager&) = delete;
	LootManager& operator=(const LootManager&) = delete;

	// Returns nullptr when the loot id band is exhausted (every id in it is on
	// the map). All callers already null-check; losing one dropped item beats
	// reusing an id, which corrupts client entities. Ground loot only returns
	// its id when it despawns, so lootDespawnSeconds = 0 makes this reachable.
	Loot* createLoot(uint16_t lootId, uint16_t itemIid, uint8_t count, const ItemState& state, const Position& spawnPos, const Position& landingPos);

private:
	bool warnedExhausted = false;
};

#endif // FS_LOOT_H
