// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_POPULATION_H
#define FS_SCENARIO_POPULATION_H

// Who and what a running scenario puts in the world besides its placed
// objects: its NPCs, where players appear and what they carry, container
// contents and creature populations.
//
//   NPCs     replace npcs.xml's spawns. Each keeps shop stock under a key made
//            from the project, the state generation (config
//            scenarioStateGeneration) and its own placement ID: moving an NPC
//            keeps its stock, duplicating one (a new ID) starts fresh.
//   Players  appear at a spawn point chosen by weight; a blocked point tries
//            the tiles around it, then the next point. If none is safe the
//            player stands on the heaviest point and the server logs
//            spawn.none-safe -- never anywhere the author did not choose. A
//            spawn point with a loadout grants it instead of the starting kit.
//   Chests   with authored contents: fixed entry k owns slot k; the loot table
//            fills the empty slots after those. A refill puts back fixed items
//            whose slot is empty and rolls the table into the empty slots
//            that remain, so whatever a player put in stays.
//   Creatures placed in the project appear once when the world opens (all or
//            nothing). A region spawner keeps up to maxAlive of its creature
//            inside the region, spawning batch every everySeconds until total.
//
// Every roll draws from a stream keyed by the world seed and the source's own
// ID (scenario_rng.h), so a chest rolls the same whatever else was edited.

#include "content/scenario_project.h"
#include "core/position.h"
#include "gameplay/scenarios/scenario_rng.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

class Creature;
class Object;
class Player;

namespace scenario {

struct ActiveScenario;

// "s" + 16 hex digits: a valid, stable NPC stock key.
std::string stockKey(const std::string& projectId, uint32_t generation, const std::string& entityId);

// Hands the scenario's NPC placements to the NPC system. Before g_npcs.start().
void placeNpcs(const ActiveScenario& scenario);

struct SpawnChoice
{
	Position at;
	const Entity* spawn = nullptr;
};

// std::nullopt when no scenario runs or it authors no spawn points: the
// world's own spawn rules apply.
std::optional<SpawnChoice> chooseSpawn(const Creature* creature);

void grantLoadout(Player* player, const std::vector<ItemStack>& loadout);

struct LootDrop
{
	std::string item;
	uint8_t count = 1;
};

// One draw of a table: `rolls` weighted picks (empty weight = nothing), or one
// chance per entry for an independent table.
std::vector<LootDrop> rollLoot(const LootTable& table, Stream& stream);

// World building: forget the previous world's containers (and, for a
// different scenario, its spawners; creatures live through a reseed).
void resetPopulation(const ActiveScenario& scenario);
// A placed container with authored contents: replaces the type's default
// contents and arms its refill.
void fillContainer(const Entity& placement, Object* container);
// Once the world is built and NPCs stand: authored creatures and spawners.
// False (with `error`) when a creature cannot stand where it was placed.
bool startPopulation(std::string& error);
// Every tick; does its work at most once a second.
void tickPopulation();

int runPopulationSelfTest();

} // namespace scenario

#endif // FS_SCENARIO_POPULATION_H
