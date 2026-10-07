// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PLACEMENT_H
#define FS_PLACEMENT_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

// Who owns the entities a stamp puts on the map.
//
// Both systems that stamp groups of objects -- imported editor maps and
// structure templates -- used to answer "which of these are mine?" by walking
// the tiles afterwards and matching object keys. That is a guess, and it is
// wrong wherever two stamps overlap: clearing a map deleted the city standing
// on the same tile, because a wood_floor placed by either looks identical.
//
// So placement is RECORDED instead. Every entity a stamp lands is written down
// against that stamp, and clear/undo/respawn read the record rather than the
// world.
enum class PlacementSource : uint8_t
{
	Map,
	Structure,
};

// Tile rectangle, x1/y1 inclusive and x2/y2 exclusive -- the convention
// StructureRect already uses.
struct PlacementRect
{
	int32_t x1 = 0;
	int32_t y1 = 0;
	int32_t x2 = 0;
	int32_t y2 = 0;

	bool contains(int32_t tileX, int32_t tileY) const
	{
		return tileX >= x1 && tileX < x2 && tileY >= y1 && tileY < y2;
	}
};

// One live stamp.
struct MapInstance
{
	uint32_t id = 0;
	PlacementSource source = PlacementSource::Map;
	std::string assetKey;
	PlacementRect rect;
	uint64_t placedAt = 0;
	uint32_t placedBy = 0; // admin GUID; 0 = world generation
	bool isCity = false;   // structures only, drives the minimap marker

	// Entity ids in placement order. This is a CANDIDATE list, not a live set:
	// see PlacementLedger::owner for why an id in here may no longer be ours.
	std::vector<uint32_t> entityIds;
};

// The record of what is standing and who put it there.
//
// The ledger never touches the world. It hands back ids and the caller removes
// them, because removal is sliced across ticks everywhere it happens and an id
// can die between the slice that planned it and the slice that runs.
class PlacementLedger
{
public:
	PlacementLedger() = default;

	// non-copyable
	PlacementLedger(const PlacementLedger&) = delete;
	PlacementLedger& operator=(const PlacementLedger&) = delete;

	// Opens an instance and returns its handle. Entities are appended with
	// record() as they land, which for a sliced map stamp spans many ticks.
	uint32_t open(PlacementSource source, const std::string& assetKey,
	              const PlacementRect& rect, uint32_t placedBy, bool isCity = false);

	// One entity, just placed. A zero or unknown `instanceId` is ignored, so a
	// caller that is not tracking (a respawn topping a container back up) needs
	// no branch of its own.
	void record(uint32_t instanceId, uint32_t entityId);
	void record(uint32_t instanceId, const std::vector<uint32_t>& entityIds);

	// An entity died. Called from Map::removeThing beside the id release, and it
	// HAS to be: ids are recycled, so an instance holding a dead id would name
	// whatever inherited it and retiring the instance would delete a stranger.
	void forget(uint32_t entityId);

	const MapInstance* find(uint32_t instanceId) const;
	// The instance that placed `entityId`, or nullptr for anything else on the
	// map (a player's build, a resource, loot).
	const MapInstance* owning(uint32_t entityId) const;
	// Instances whose rect covers this tile, newest first.
	std::vector<uint32_t> at(int32_t tileX, int32_t tileY) const;

	std::vector<const MapInstance*> list(PlacementSource source) const;
	std::vector<uint32_t> instancesOf(PlacementSource source, const std::string& assetKey) const;

	// How many of an instance's entities are still standing.
	uint32_t liveCount(uint32_t instanceId) const;

	// Drops the record and appends the ids it still owns to `outEntityIds`,
	// which is NOT cleared -- callers accumulate across several retires.
	bool retire(uint32_t instanceId, std::vector<uint32_t>& outEntityIds);
	uint32_t retireAll(PlacementSource source, std::vector<uint32_t>& outEntityIds);
	uint32_t retireAll(std::vector<uint32_t>& outEntityIds);

	// The whole world was replaced, so nothing recorded describes it any more.
	// Used by the !seed rebuild, which wipes and regenerates in one pass.
	void reset();

	size_t size() const { return instances.size(); }

private:
	MapInstance* findMutable(uint32_t instanceId);

	// Insertion-ordered so listings and retirement are deterministic. There are
	// a few dozen of these at most, so a linear find costs less than the hash
	// map that would replace it.
	std::vector<MapInstance> instances;

	// entity id -> instance id, and the authority on ownership. An id is in here
	// only while it is both alive and ours: forget() drops it on death, and a
	// later record() re-points it if the pool reissues it to another stamp. That
	// is what makes MapInstance::entityIds safe to leave un-erased -- erasing
	// from those vectors per death would be O(n) per entity and O(n^2) for a
	// city being demolished a wall at a time.
	std::unordered_map<uint32_t, uint32_t> owner;

	uint32_t nextInstanceId = 1;
};

extern PlacementLedger g_placements;

#endif // FS_PLACEMENT_H
