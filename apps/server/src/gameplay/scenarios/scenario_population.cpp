// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/scenarios/scenario_population.h"

#include "content/configmanager.h"
#include "core/tools.h"
#include "gameplay/game.h"
#include "gameplay/agent.h"
#include "gameplay/item.h"
#include "gameplay/npc.h"
#include "gameplay/object.h"
#include "gameplay/player.h"
#include "gameplay/scenarios/scenario_rng.h"
#include "gameplay/scenarios/scenario_runtime.h"
#include "world/mapsize.h"

#include <fmt/color.h>
#include <fmt/format.h>
#include <unordered_map>

extern Game g_game;

namespace scenario {
namespace {

// Rings of tiles tried around a blocked spawn point before the next point.
constexpr int32_t SPAWN_RINGS = 2;
// Points sampled inside a spawner's region per creature before giving up for
// this cycle: bounded work per tick, whatever the region looks like.
constexpr int32_t SPAWNER_TRIES = 12;

struct ContainerState
{
	uint32_t thingId = 0;
	const ContainerContents* contents = nullptr;
	const LootTable* table = nullptr;
	Stream stream;
	uint64_t nextRefillAt = 0;
};

struct SpawnerState
{
	std::string regionId;
	size_t region = 0;
	const Spawner* spawner = nullptr;
	const AgentData* data = nullptr;
	Stream stream;
	std::vector<uint32_t> alive;
	uint32_t spawned = 0;
	uint64_t nextAt = 0;
	uint32_t failedCycles = 0;
	uint64_t lastWarning = 0;
};

struct PopulationState
{
	const ActiveScenario* scenario = nullptr;
	std::unordered_map<std::string, const LootTable*> tables;
	std::vector<ContainerState> containers;
	std::vector<SpawnerState> spawners;
	uint64_t lastTick = 0;
} population;

bool putItem(Object* obj, uint8_t slot, const std::string& key, uint8_t count)
{
	const ItemData* data = ItemManager::getInstance().getItemData(key);
	if (!data) return false; // compile-checked; content reloaded underneath
	count = std::min<uint8_t>(count, std::max<uint8_t>(1, data->stack));
	obj->setStorageItem(slot, std::make_unique<Item>(data->id, count, ItemState::fresh(data->id)));
	return true;
}

// Fixed entry k into slot k when empty, then the table into the empty slots
// after the fixed ones. The table is rolled even when nothing fits, so how
// full a chest was never shifts its later rolls.
bool fillSlots(ContainerState& c, Object* obj)
{
	const size_t slots = obj->getStorageSize();
	const std::vector<ItemStack>& fixed = c.contents->fixed;
	bool added = false;
	for (size_t k = 0; k < fixed.size() && k < slots; ++k)
		if (!obj->getStorageItem(static_cast<uint8_t>(k)))
			added |= putItem(obj, static_cast<uint8_t>(k), fixed[k].item, fixed[k].count);
	if (c.table) {
		const std::vector<LootDrop> drops = rollLoot(*c.table, c.stream);
		size_t next = 0;
		for (size_t k = fixed.size(); k < slots && next < drops.size(); ++k) {
			if (obj->getStorageItem(static_cast<uint8_t>(k))) continue;
			added |= putItem(obj, static_cast<uint8_t>(k), drops[next].item, drops[next].count);
			++next;
		}
	}
	return added;
}

// One cycle of a spawner: prune the dead, then spawn up to a batch.
void runSpawner(SpawnerState& s, uint64_t now)
{
	s.alive.erase(std::remove_if(s.alive.begin(), s.alive.end(), [](uint32_t id) {
		Thing* t = g_game.map.getThingByID(id);
		return !t || !t->getAgent();
	}), s.alive.end());
	if (now < s.nextAt) return;
	s.nextAt = now + static_cast<uint64_t>(s.spawner->everySeconds) * 1000;

	const uint32_t room = s.spawner->maxAlive > s.alive.size() ? s.spawner->maxAlive - static_cast<uint32_t>(s.alive.size()) : 0;
	const uint32_t left = s.spawner->total ? s.spawner->total - std::min(s.spawner->total, s.spawned) : UINT32_MAX;
	const uint32_t wanted = std::min<uint32_t>({ s.spawner->batch, room, left });
	if (wanted == 0) return;

	const RegionIndex& regions = g_scenarioRuntime.regions();
	int32_t minX, minY, maxX, maxY;
	regions.bounds(s.region, minX, minY, maxX, maxY);
	minX = std::max(minX, TILE_SIZE); minY = std::max(minY, TILE_SIZE);
	maxX = std::min(maxX, MapSize::widthUnits() - TILE_SIZE); maxY = std::min(maxY, MapSize::heightUnits() - TILE_SIZE);
	uint32_t made = 0;
	for (uint32_t i = 0; i < wanted && maxX >= minX && maxY >= minY; ++i) {
		for (int32_t attempt = 0; attempt < SPAWNER_TRIES; ++attempt) {
			const int32_t x = minX + static_cast<int32_t>(s.stream.below(static_cast<uint32_t>(maxX - minX + 1)));
			const int32_t y = minY + static_cast<int32_t>(s.stream.below(static_cast<uint32_t>(maxY - minY + 1)));
			const Position at(static_cast<uint16_t>(x), static_cast<uint16_t>(y));
			if (!regions.contains(s.region, x, y) || g_scenarioRuntime.permission(PermissionKind::Spawn, at) == false) continue;
			if (!g_game.isSpawnPositionValid(at, nullptr, Game::SpawnRule::Strict) || !g_game.agentBodyFitsAt(s.data, at)) continue;
			Agent* agent = g_agents.createAgent(s.spawner->agent, at, 0);
			if (!agent) return; // id band exhausted: nothing else succeeds this cycle
			if (!g_game.placeThing(agent, at)) {
				delete agent; // refcount still 0
				continue;
			}
			s.alive.push_back(agent->getID());
			++s.spawned;
			++made;
			break;
		}
	}
	if (made < wanted) {
		++s.failedCycles;
		if (now - s.lastWarning >= 60000) {
			s.lastWarning = now;
			fmt::print(fg(fmt::color::yellow), ">> [scenario] spawner \"{}\": no room for {} of {} {} ({} short cycle(s))\n",
				s.regionId, wanted - made, wanted, s.spawner->agent, s.failedCycles);
		}
	} else {
		s.failedCycles = 0;
	}
}

std::optional<Position> safeNear(const Entity& spawn, const Creature* creature)
{
	const auto ok = [creature](const Position& p) {
		// Authored ground: only colliding geometry blocks, so a spawn point on a
		// floor inside a house works (the Strict rule refuses floors).
		return g_game.isSpawnPositionValid(p, creature, Game::SpawnRule::Resurrection) &&
		       g_scenarioRuntime.permission(PermissionKind::Spawn, p) != false;
	};
	const Position point(static_cast<uint16_t>(spawn.x), static_cast<uint16_t>(spawn.y));
	if (ok(point)) return point;
	const int32_t tileX = spawn.x / TILE_SIZE;
	const int32_t tileY = spawn.y / TILE_SIZE;
	for (int32_t ring = 1; ring <= SPAWN_RINGS; ++ring)
		for (int32_t dy = -ring; dy <= ring; ++dy)
			for (int32_t dx = -ring; dx <= ring; ++dx) {
				if (std::max(std::abs(dx), std::abs(dy)) != ring || !Game::isTileInsideMap(tileX + dx, tileY + dy)) continue;
				const Position candidate = g_game.tileCenterPosition(tileX + dx, tileY + dy);
				if (ok(candidate)) return candidate;
			}
	return std::nullopt;
}

} // namespace

std::string stockKey(const std::string& projectId, uint32_t generation, const std::string& entityId)
{
	return fmt::format("s{:016x}", fnv1a64(fmt::format("{}/{}/{}", projectId, generation, entityId)));
}

void placeNpcs(const ActiveScenario& scenario)
{
	const auto generation = static_cast<uint32_t>(std::max<int64_t>(0, ConfigManager::getNumber(ConfigManager::SCENARIO_STATE_GENERATION)));
	std::vector<NpcSpawn> spawns;
	for (const Entity& e : scenario.project.entities) {
		if (e.kind != EntityKind::Npc) continue;
		NpcSpawn spawn;
		spawn.key = stockKey(scenario.project.id, generation, e.id);
		spawn.npc = e.ref;
		spawn.home = Position(static_cast<uint16_t>(e.x), static_cast<uint16_t>(e.y));
		if (e.wander) spawn.walkRadius = static_cast<uint32_t>(*e.wander) * TILE_SIZE;
		spawn.rotation = e.angle.value_or(0);
		spawns.push_back(std::move(spawn));
	}
	g_npcs.useScenarioSpawns(std::move(spawns));
}

std::optional<SpawnChoice> chooseSpawn(const Creature* creature)
{
	const std::vector<const Entity*>& points = g_scenarioRuntime.spawnPoints();
	if (points.empty()) return std::nullopt;

	// Weighted order without replacement: each draw picks among the points not
	// yet tried, in proportion to their weights.
	std::vector<const Entity*> remaining = points;
	while (!remaining.empty()) {
		int32_t total = 0;
		for (const Entity* e : remaining) total += e->weight.value_or(1);
		int32_t roll = uniform_random(0, total - 1);
		size_t pick = remaining.size() - 1;
		for (size_t i = 0; i < remaining.size(); ++i) {
			roll -= remaining[i]->weight.value_or(1);
			if (roll < 0) {
				pick = i;
				break;
			}
		}
		if (const auto at = safeNear(*remaining[pick], creature)) return SpawnChoice{ *at, remaining[pick] };
		remaining.erase(remaining.begin() + static_cast<std::ptrdiff_t>(pick));
	}

	// Nowhere safe. Stand on the heaviest point (the first, on ties) rather than
	// anywhere the author did not choose; normal collision sorts out the overlap.
	const Entity* heaviest = points.front();
	for (const Entity* e : points)
		if (e->weight.value_or(1) > heaviest->weight.value_or(1)) heaviest = e;
	fmt::print(fg(fmt::color::yellow), ">> [scenario] spawn.none-safe: no authored spawn point is clear; using \"{}\"\n", heaviest->id);
	return SpawnChoice{ Position(static_cast<uint16_t>(heaviest->x), static_cast<uint16_t>(heaviest->y)), heaviest };
}

void grantLoadout(Player* player, const std::vector<ItemStack>& loadout)
{
	for (const ItemStack& stack : loadout) {
		// Compile-checked before the world opened; a missing key here means
		// content was reloaded underneath the scenario, and is skipped.
		if (const ItemData* data = ItemManager::getInstance().getItemData(stack.item))
			player->addInventoryItem(data->id, stack.count, ItemState::fresh(data->id));
	}
}

std::vector<LootDrop> rollLoot(const LootTable& table, Stream& stream)
{
	std::vector<LootDrop> out;
	if (table.weighted) {
		uint32_t total = table.empty;
		for (const LootEntry& e : table.entries) total += e.weight;
		for (uint32_t r = 0; r < table.rolls && total > 0; ++r) {
			uint32_t pick = stream.below(total);
			if (pick < table.empty) continue;
			pick -= table.empty;
			for (const LootEntry& e : table.entries) {
				if (pick < e.weight) {
					out.push_back({ e.item, static_cast<uint8_t>(stream.between(e.min, e.max)) });
					break;
				}
				pick -= e.weight;
			}
		}
	} else {
		for (const LootEntry& e : table.entries)
			if (stream.below(10000) < e.weight) out.push_back({ e.item, static_cast<uint8_t>(stream.between(e.min, e.max)) });
	}
	return out;
}

void resetPopulation(const ActiveScenario& scenario)
{
	// A reseed rebuilds the objects but creatures live through it
	// (Game::regenerateWorld), so the same scenario keeps its spawners and the
	// creatures they track, and only its containers start over.
	population.containers.clear();
	if (population.scenario == &scenario) return;
	population = PopulationState{};
	population.scenario = &scenario;
	for (const LootTable& t : scenario.project.lootTables) population.tables.emplace(t.id, &t);
}

void fillContainer(const Entity& placement, Object* container)
{
	if (!placement.container || !population.scenario) return;
	ContainerState c;
	c.thingId = container->getID();
	c.contents = &*placement.container;
	if (!c.contents->loot.empty()) {
		const auto it = population.tables.find(c.contents->loot);
		c.table = it == population.tables.end() ? nullptr : it->second;
	}
	c.stream = Stream(population.scenario->project.world.seed, placement.id, "loot");
	// Authored contents replace the type's default roll outright.
	for (uint8_t k = 0; k < container->getStorageSize(); ++k) container->setStorageItem(k, nullptr);
	fillSlots(c, container);
	if (c.contents->refillSeconds) {
		c.nextRefillAt = static_cast<uint64_t>(OTSYS_TIME()) + static_cast<uint64_t>(c.contents->refillSeconds) * 1000;
		population.containers.push_back(std::move(c));
	}
}

bool startPopulation(std::string& error)
{
	if (!population.scenario) return true;
	const Project& project = population.scenario->project;
	for (const Entity& e : project.entities) {
		if (e.kind != EntityKind::Agent) continue;
		const AgentData* data = g_agents.getAgentData(e.ref);
		const Position at(static_cast<uint16_t>(e.x), static_cast<uint16_t>(e.y));
		if (!data || !g_game.isSpawnPositionValid(at, nullptr, Game::SpawnRule::Resurrection) || !g_game.agentBodyFitsAt(data, at)) {
			error = fmt::format("placement \"{}\": creature \"{}\" cannot stand at ({}, {})", e.id, e.ref, e.x, e.y);
			return false;
		}
		Agent* agent = g_agents.createAgent(e.ref, at, 0);
		if (!agent) {
			error = fmt::format("placement \"{}\": the entity id pool is exhausted", e.id);
			return false;
		}
		agent->setRotation(e.angle.value_or(0));
		if (!g_game.placeThing(agent, at)) {
			delete agent;
			error = fmt::format("placement \"{}\": creature \"{}\" could not be placed", e.id, e.ref);
			return false;
		}
		g_scenarioRuntime.notePlaced(e.id, agent->getID());
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	const RegionIndex& regions = g_scenarioRuntime.regions();
	for (const Region& r : project.regions) {
		if (!r.spawner) continue;
		const auto index = regions.indexOf(r.id);
		const AgentData* data = g_agents.getAgentData(r.spawner->agent);
		if (!index || !data) continue; // compile-checked
		SpawnerState s;
		s.regionId = r.id;
		s.region = *index;
		s.spawner = &*r.spawner;
		s.data = data;
		s.stream = Stream(project.world.seed, r.id, "spawner");
		s.nextAt = now + static_cast<uint64_t>(r.spawner->startDelay) * 1000;
		population.spawners.push_back(std::move(s));
	}
	const auto count = [&project](EntityKind kind) {
		return std::count_if(project.entities.begin(), project.entities.end(), [kind](const Entity& e) { return e.kind == kind; });
	};
	fmt::print(">> Scenario population: {} NPC(s), {} creature(s), {} spawner(s), {} spawn point(s), {} refilling container(s)\n",
		count(EntityKind::Npc), count(EntityKind::Agent), population.spawners.size(), count(EntityKind::Spawn), population.containers.size());
	return true;
}

void tickPopulation()
{
	if (!population.scenario) return;
	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	if (now - population.lastTick < 1000) return;
	population.lastTick = now;

	for (ContainerState& c : population.containers) {
		if (now < c.nextRefillAt) continue;
		c.nextRefillAt = now + static_cast<uint64_t>(c.contents->refillSeconds) * 1000;
		Thing* thing = g_game.map.getThingByID(c.thingId);
		Object* obj = thing ? thing->getObject() : nullptr;
		if (!obj || !fillSlots(c, obj)) continue;
		// Someone with the chest open has a stale window (same as refillStorage).
		if (const uint32_t pid = obj->getActiveUserPid(); pid != 0)
			if (Player* p = g_game.getPlayerByGUID(pid)) p->sendFullChest(obj);
	}
	for (SpawnerState& s : population.spawners) runSpawner(s, now);
}

int runPopulationSelfTest()
{
	int failures = 0;
	auto check = [&](bool ok, const std::string& what) {
		if (!ok) {
			++failures;
			fmt::print(fg(fmt::color::crimson), ">> [population selftest] FAIL {}\n", what);
		}
	};
	const std::string a = stockKey("prj-1", 0, "e7");
	check(a == stockKey("prj-1", 0, "e7"), "stock key is stable");
	check(a != stockKey("prj-1", 0, "e8"), "a duplicated NPC (new ID) gets its own stock");
	check(a != stockKey("prj-2", 0, "e7"), "another project never shares stock");
	check(a != stockKey("prj-1", 1, "e7"), "a new state generation starts fresh");
	check(a.size() == 17 && a.find_first_not_of("s0123456789abcdef") == std::string::npos, "stock key is a valid persisted key");

	Stream x(7, "e1", "loot");
	Stream y(7, "e1", "loot");
	Stream z(7, "e2", "loot");
	Stream w(8, "e1", "loot");
	const uint64_t first = x.next();
	check(first == y.next(), "same seed and source repeat");
	check(first != z.next() && first != w.next(), "other sources and seeds differ");
	bool inRange = true;
	for (int i = 0; i < 1000; ++i) {
		const uint32_t v = x.between(3, 5);
		inRange = inRange && v >= 3 && v <= 5;
	}
	check(inRange, "between stays inclusive");

	LootTable weighted;
	weighted.weighted = true;
	weighted.rolls = 3;
	weighted.empty = 50;
	weighted.entries = { { "bandage", 1, 3, 30 }, { "syringe", 1, 1, 20 } };
	Stream r1(99, "chest", "loot"), r2(99, "chest", "loot");
	bool same = true, bounded = true;
	for (int i = 0; i < 200; ++i) {
		const auto a1 = rollLoot(weighted, r1);
		const auto a2 = rollLoot(weighted, r2);
		same = same && a1.size() == a2.size();
		for (size_t k = 0; same && k < a1.size(); ++k) same = a1[k].item == a2[k].item && a1[k].count == a2[k].count;
		bounded = bounded && a1.size() <= 3;
		for (const auto& d : a1) bounded = bounded && (d.item == "bandage" ? d.count >= 1 && d.count <= 3 : d.count == 1);
	}
	check(same, "the same stream rolls the same loot");
	check(bounded, "rolls and counts stay in range");

	LootTable independent;
	independent.weighted = false;
	independent.entries = { { "wood", 5, 5, 10000 }, { "string", 1, 1, 0 + 1 } };
	Stream r3(1, "crate", "loot");
	uint32_t strings = 0;
	bool alwaysWood = true;
	for (int i = 0; i < 2000; ++i) {
		const auto drops = rollLoot(independent, r3);
		alwaysWood = alwaysWood && !drops.empty() && drops.front().item == "wood" && drops.front().count == 5;
		for (const auto& d : drops) strings += d.item == "string";
	}
	check(alwaysWood, "a 10000 basis-point entry always drops");
	check(strings < 10, "a 1 basis-point entry almost never drops");

	if (failures == 0) fmt::print(fg(fmt::color::green), ">> [population selftest] stock keys and random streams behave.\n");
	return failures;
}

} // namespace scenario
