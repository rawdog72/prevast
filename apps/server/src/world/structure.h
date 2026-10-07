// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_STRUCTURE_H
#define FS_STRUCTURE_H

#include "world/mapsize.h"
#include "core/position.h"
#include <string>
#include <vector>
#include <unordered_map>

struct StructureTile {
	uint16_t x;
	std::string floor;
	std::string object;
	uint8_t rotation;
	int16_t subtype = -1; // -1 means default
};

struct StructureRow {
	uint16_t y = 0;
	std::vector<StructureTile> tiles;
};

struct StructureTemplate {
	// The template's name, and the only way anything refers to it -- modes.xml
	// already spells the reference side <structure key="...">.
	std::string key;
	uint16_t width = 0;
	uint16_t height = 0;
	std::vector<StructureRow> rows;
	// Attached to every object (floors included) this template spawns; the
	// object carries the effect, so destroying it removes the emission
	std::vector<AreaEffect> instanceEffects;
};

struct StructureRect {
	int32_t x1, y1, x2, y2;
};

class StructureManager {
public:
	StructureManager() = default;
	~StructureManager() = default;

	struct TrackedStructure {
		std::string templateId;
		Position pos;
		// The rect this occupies, which used to live in a second vector kept
		// index-parallel with this one. One array cannot fall out of step with
		// itself, and pruning a removed structure now frees its ground.
		StructureRect rect;
		// Its entities, in the placement ledger. 0 for a structure placed before
		// the ledger existed; a retired instance is how !clean-hard stops a city
		// respawning.
		uint32_t instanceId = 0;
		// Per-building opt-out of the respawn cycle. The cadence itself stays
		// global (one timer, one beat); this is the "stop rebuilding THIS one"
		// switch, which is the thing an admin actually wants when a city keeps
		// growing back through their map.
		bool respawns = true;
	};

	bool loadTemplates(const std::string& filename);

	// One line describing what a template parsed to. Exists so a template
	// converted from <row> tiles to a drawn <code> can be proved equivalent.
	std::string describeTemplate(const std::string& key) const;

	// How many entity ids one instance of this template consumes: one per
	// non-empty floor and one per non-empty object. Used to check a structure
	// against the id pool BEFORE any of it is placed.
	static uint32_t templateIdCost(const StructureTemplate* tmpl);

	// Returns false without placing anything when the template does not fit in
	// the remaining id space. A structure is all-or-nothing on purpose: a
	// half-spawned building is a corrupt world that looks like a real one, and
	// nothing downstream can tell the difference.
	//
	// `preserveOccupied` is the !seed regeneration mode: a tile already holding a
	// creature, loot or something a player built is left exactly as it is and the
	// rest of the template still goes up around it. That is per TILE, not per
	// structure -- one base built in the middle of where a city is about to
	// appear costs that city a few walls, not the whole city.
	//
	// A tile with a CREATURE on it is skipped either way. Entombing a player in
	// a wall is not an outcome any flag should select, and skipping costs
	// nothing now that it cannot shift the rest of the world (see the note on
	// worldgen::contentRoll).
	// `placedIds` collects the entity ids that actually landed, for the caller to
	// hand to the placement ledger. Tiles are skipped for occupancy, so this is
	// what is standing rather than what the template describes.
	bool spawnStructure(const StructureTemplate* tmpl, const Position& pos,
	                    bool preserveOccupied = false,
	                    std::vector<uint32_t>* placedIds = nullptr);

	// What a population pass actually managed. `noSpace` is a map that is too
	// crowded to fit a template; `outOfIds` is the entity id pool running dry,
	// which stops generation dead and leaves the rest of `wanted` unattempted.
	// Reported so a live rebuild can say so rather than claim success.
	struct PopulateReport
	{
		uint32_t placed = 0;
		uint32_t wanted = 0;
		uint32_t noSpace = 0;
		uint32_t droppedToBudget = 0;
		bool outOfIds = false;
	};

	// `worldSeed` names the world being built; placement draws from a stream
	// derived from it (worldgen.h) rather than from the process RNG, so a
	// rebuild issued mid-session lands the same cities as a fresh boot on the
	// same seed.
	//
	// Structures charge their footprint against `budget` FIRST, before resources
	// see it. They are the landmarks and the hand-authored content, so on a map
	// too small to hold everything it is the trees that give way, not the city.
	// `droppedToBudget` counts templates skipped for want of allowance -- as
	// distinct from `noSpace`, which is a template that does not geometrically
	// fit at all.
	PopulateReport populateMap(const struct GameMode* activeMode, uint32_t worldSeed,
	                           MapSize::ContentBudget& budget,
	                           bool preserveOccupied = false);
	void respawnStructures();

	// Places a template at a tile on an admin's say-so, with every check world
	// generation makes: the key exists, the footprint is inside the map, it does
	// not land on another structure, and the entity id pool can pay for it.
	//
	// On success the structure is TRACKED exactly as a generated one is, so it
	// respawns on the mode's cycle and shows on the minimap. Containers fill
	// themselves from <storage> in createObject, so a placed building arrives
	// looted like any other.
	//
	// Returns false with `error` set to something an admin can act on; nothing
	// is placed in that case, because spawnStructure is all-or-nothing.
	// What actually landed, counted from the world afterwards rather than from
	// the template. A structure skips tiles that hold creatures or player
	// builds, so "what I asked for" and "what is standing there" are different
	// numbers, and the admin should be told the second one. `lootItems` is what
	// the containers rolled, which is the visible proof that a placed building
	// is stocked the same way a generated one is.
	struct PlacementReport
	{
		uint32_t floors = 0;
		uint32_t objects = 0;
		uint32_t containers = 0;
		uint32_t lootItems = 0;
		uint32_t skipped = 0;
	};

	bool placeStructureAt(const std::string& key, int32_t tileX, int32_t tileY,
	                      bool isCity, PlacementReport& report, std::string& error);

	// Keys and sizes, for the admin listing.
	std::vector<std::string> templateKeys() const;

	const StructureTemplate* getTemplate(const std::string& key) const;

	void addCityLocation(const Position& pos) { cityLocations.push_back(pos); markersDirty = true; }
	void addHouseLocation(const Position& pos) { houseLocations.push_back(pos); markersDirty = true; }

	const std::vector<Position>& getCityLocations() const { return cityLocations; }
	const std::vector<Position>& getHouseLocations() const { return houseLocations; }

	// Have the minimap markers changed since anyone last asked? Clears the flag.
	//
	// CITIES_LOCATION states the whole marker set, and it used to be sent only at
	// login and after a world rebuild -- so a building placed or removed while
	// people were connected moved nothing on their minimaps until they
	// reconnected. Rather than remembering to push the packet at each of the
	// (now five) places the set can change, the SET says when it has changed and
	// Game::updateMapJobs pushes it. A future mutation path gets it for free.
	bool consumeMarkersDirty()
	{
		const bool was = markersDirty;
		markersDirty = false;
		return was;
	}
	const std::vector<TrackedStructure>& getSpawnedStructures() const { return spawnedStructures; }

	// Drops every tracked structure whose placement has been retired, freeing
	// its ground and its minimap marker. Called before a respawn pass, which is
	// what makes !clean-hard stick: nothing left to put back.
	void pruneRetiredStructures();

	// --- Live buildings, by instance ---------------------------------------
	//
	// Everything below addresses a building by its placement id, which is what
	// !structure-list-placed prints. Before these existed a building could be
	// placed and never removed: the tracking vector only ever grew, so a
	// misplaced city held its ground for the life of the process and there was
	// no command that could take it down.

	// The tracked building covering this tile, or nullptr.
	const TrackedStructure* structureAt(int32_t tileX, int32_t tileY) const;
	const TrackedStructure* findTracked(uint32_t instanceId) const;

	// Retires the placement and queues its entities for removal. The building
	// stops being tracked immediately -- so its ground is free and its minimap
	// marker gone before this returns -- while the entities come off the map
	// over the next few slices.
	bool removeStructure(uint32_t instanceId, uint32_t adminGuid, std::string& error);

	// Remove and re-place in one step, through every check placeStructureAt
	// makes. Refuses without removing anything if the destination is no good.
	bool moveStructure(uint32_t instanceId, int32_t tileX, int32_t tileY,
	                   uint32_t adminGuid, std::string& error);

	bool setStructureRespawn(uint32_t instanceId, bool respawns);

private:
	bool intersects(const StructureRect& r) const;
	// Rebuilt from spawnedStructures, so the markers cannot outlive the
	// buildings they point at. There is no other removal path for them.
	void rebuildMinimapMarkers();

	std::unordered_map<std::string, StructureTemplate> templates;
	std::vector<Position> cityLocations;
	std::vector<Position> houseLocations;
	std::vector<TrackedStructure> spawnedStructures;
	bool markersDirty = false;
};

extern StructureManager g_structures;

#endif // FS_STRUCTURE_H
