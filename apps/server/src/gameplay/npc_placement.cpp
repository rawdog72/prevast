// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Where NPCs stand: choosing a spot for each spawn, re-choosing it for the ones
// that travel, and picking free spots to wander to.
//
// Nothing here has a placement rule of its own. "May something materialise
// here" is Game::isSpawnPositionValid -- the predicate logins, resurrections
// and the night spawner already share -- and "does this body fit" is
// Game::bodyBlockedAt, the movement layer's overlap test. An NPC is put only
// where a player or an agent would also be allowed to appear.

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/game.h"
#include "gameplay/agent.h"
#include "gameplay/scenarios/scenario_runtime.h"
#include "core/tools.h"

extern Game g_game;

namespace {
// Names carry an NPC_ prefix: the server builds with unity files, and these
// share a translation unit with the other gameplay sources.

// The body plus some air, the way agents are placed with
// AGENT_PATH_RADIUS_MARGIN: an NPC set flush against a wall reads as stuck in it.
constexpr float NPC_PLACE_RADIUS = Npc::BODY_RADIUS + 6.0f;

// Random darts per pass for a Random spawn, and for an Area spawn's area.
constexpr int32_t NPC_RANDOM_TRIES = 160;
constexpr int32_t NPC_AREA_TRIES = 48;

// Fixed and Area spawns fall back to the nearest free tile this many rings
// out from the authored point before giving up.
constexpr int32_t NPC_NEAREST_RINGS = 8;

// Random NPCs keep this far apart on the first pass so a handful spread over
// the map instead of landing in one clearing.
constexpr int64_t NPC_RANDOM_SPACING = 24 * TILE_SIZE;

// No appearing or vanishing within sight of a player: the same distance the
// night spawner keeps agents from appearing at.
constexpr int64_t NPC_PLAYER_CLEARANCE = AGENT_SPAWN_MIN_PLAYER_DIST;

// Edge inset for random spots, as for agents.
constexpr int32_t NPC_EDGE_INSET = TILE_SIZE * 2;

// A travelling NPC whose move was refused (someone watching, someone talking
// to it, nowhere free) tries again this much later.
constexpr uint64_t NPC_RELOCATE_RETRY_MS = 30000;

int64_t npcDistanceSq(const Position& a, const Position& b)
{
	const int64_t dx = static_cast<int64_t>(a.x) - b.x;
	const int64_t dy = static_cast<int64_t>(a.y) - b.y;
	return dx * dx + dy * dy;
}

bool npcNearPlayer(const Position& at)
{
	for (const auto& [id, player] : g_game.getPlayers()) {
		if (player && player->getProtocolGame() &&
		    npcDistanceSq(player->getPosition(), at) < NPC_PLAYER_CLEARANCE * NPC_PLAYER_CLEARANCE) {
			return true;
		}
	}
	return false;
}

// The whole rule for one spot. Fixed and Area spots are authored, usually in a
// town, so they place under the Resurrection rule: roads, floors and dropped
// loot are fine to stand on, only colliding geometry, creatures and other NPCs
// block. A Random spot is the strict login rule -- empty ground, never inside
// somebody's base -- and also honours a scenario's no-spawn regions.
bool npcSpotFits(const Position& at, const Npc* self, NpcPlacement placement)
{
	const bool random = placement == NpcPlacement::Random;
	if (!g_game.isSpawnPositionValid(at, self, random ? Game::SpawnRule::Strict : Game::SpawnRule::Resurrection)) {
		return false;
	}
	if (g_game.bodyBlockedAt(at, NPC_PLACE_RADIUS, self, /*creaturesBlock=*/false)) {
		return false;
	}
	if (placement != NpcPlacement::Fixed &&
	    scenario::g_scenarioRuntime.permission(scenario::PermissionKind::Spawn, at) == false) {
		return false;
	}
	return true;
}

// Nearest free tile centre to `anchor`, ring by ring, as Game::findSpawnPosition
// falls back for logins. Tile centres, not anchor + n*TILE_SIZE: an anchor
// off-centre steps onto tile corners, the spot hardest to clear.
bool npcNearestFit(const Position& anchor, const Npc* self, NpcPlacement placement, Position& out)
{
	const int32_t ax = anchor.x / TILE_SIZE;
	const int32_t ay = anchor.y / TILE_SIZE;
	for (int32_t ring = 1; ring <= NPC_NEAREST_RINGS; ++ring) {
		for (int32_t dy = -ring; dy <= ring; ++dy) {
			for (int32_t dx = -ring; dx <= ring; ++dx) {
				if (std::max(std::abs(dx), std::abs(dy)) != ring) continue;
				if (!Game::isTileInsideMap(ax + dx, ay + dy)) continue;
				const Position candidate = g_game.tileCenterPosition(ax + dx, ay + dy);
				if (npcSpotFits(candidate, self, placement)) {
					out = candidate;
					return true;
				}
			}
		}
	}
	return false;
}
} // namespace

bool NpcSystem::findHome(const NpcSpawn& spawn, const Npc* self, Position& out) const
{
	if (spawn.placement == NpcPlacement::Fixed) {
		if (npcSpotFits(spawn.anchor, self, spawn.placement)) {
			out = spawn.anchor;
			return true;
		}
		return npcNearestFit(spawn.anchor, self, spawn.placement, out);
	}

	// Moving an NPC that is already standing should actually move it.
	const auto movesAway = [&](const Position& at) {
		if (!self) return true;
		const int64_t minimum = spawn.placement == NpcPlacement::Random ? NPC_RANDOM_SPACING : 2 * TILE_SIZE;
		return npcDistanceSq(at, self->position) >= minimum * minimum;
	};

	if (spawn.placement == NpcPlacement::Area) {
		for (int32_t attempt = 0; attempt < NPC_AREA_TRIES; ++attempt) {
			// Uniform over the disc: sqrt on the radius, or the darts bunch
			// at the centre.
			const double angle = uniform_random(0, 62831) / 10000.0;
			const double radius = std::sqrt(uniform_random(0, 10000) / 10000.0) * spawn.spread;
			const Position candidate = g_game.clampPositionToMap(
				static_cast<int32_t>(std::lround(spawn.anchor.x + std::cos(angle) * radius)),
				static_cast<int32_t>(std::lround(spawn.anchor.y + std::sin(angle) * radius)));
			if (movesAway(candidate) && npcSpotFits(candidate, self, spawn.placement)) {
				out = candidate;
				return true;
			}
		}
		// A crowded area: the nearest free tile to its centre, as a Fixed
		// spawn would get -- but only if that is still inside the area.
		Position nearest;
		if (npcNearestFit(spawn.anchor, self, spawn.placement, nearest) &&
		    npcDistanceSq(nearest, spawn.anchor) <= int64_t(spawn.spread) * spawn.spread && movesAway(nearest)) {
			out = nearest;
			return true;
		}
		return false;
	}

	// Random. Three passes, each giving up one nicety: spread out from the
	// other NPCs, then out of players' sight, then just a legal spot.
	const int32_t maxX = std::max(NPC_EDGE_INSET, MapSize::widthUnits() - NPC_EDGE_INSET);
	const int32_t maxY = std::max(NPC_EDGE_INSET, MapSize::heightUnits() - NPC_EDGE_INSET);
	for (int32_t pass = 0; pass < 3; ++pass) {
		for (int32_t attempt = 0; attempt < NPC_RANDOM_TRIES; ++attempt) {
			const Position candidate = g_game.clampPositionToMap(
				uniform_random(NPC_EDGE_INSET, maxX), uniform_random(NPC_EDGE_INSET, maxY));
			if (!movesAway(candidate)) continue;
			if (pass < 2 && npcNearPlayer(candidate)) continue;
			if (pass < 1) {
				bool crowded = false;
				for (const auto& [key, other] : npcs) {
					if (other.get() != self &&
					    npcDistanceSq(other->position, candidate) < NPC_RANDOM_SPACING * NPC_RANDOM_SPACING) {
						crowded = true;
						break;
					}
				}
				if (crowded) continue;
			}
			if (npcSpotFits(candidate, self, spawn.placement)) {
				out = candidate;
				return true;
			}
		}
	}
	return false;
}

void NpcSystem::spawnMissing(bool announce)
{
	for (auto& spawn : spawns) {
		if (npcs.count(spawn.key)) continue;
		const auto& definition = definitions.at(spawn.npc);

		Position home;
		if (!findHome(spawn, nullptr, home)) {
			if (spawn.placement == NpcPlacement::Random) {
				// Nowhere legal yet (a full map, players everywhere). Better
				// absent for a few seconds than standing inside a wall; update()
				// asks again.
				if (announce) fmt::print(">> NPC spawn '{}' ({}): no free spot on the map yet, retrying\n", spawn.key, spawn.npc);
				continue;
			}
			// Authored spawns always appear -- quests are pinned to them -- so
			// this is a content problem to report, not a reason to drop one.
			home = spawn.anchor;
			fmt::print(">> NPC spawn '{}' ({}) at tile {},{} is blocked and nothing within {} tiles is free; "
			           "placing it anyway\n", spawn.key, spawn.npc, spawn.anchor.x / TILE_SIZE, spawn.anchor.y / TILE_SIZE,
			           NPC_NEAREST_RINGS);
		} else if (spawn.placement == NpcPlacement::Fixed && home != spawn.anchor) {
			fmt::print(">> NPC spawn '{}' ({}) at tile {},{} is blocked; standing at tile {},{} instead\n",
			           spawn.key, spawn.npc, spawn.anchor.x / TILE_SIZE, spawn.anchor.y / TILE_SIZE,
			           home.x / TILE_SIZE, home.y / TILE_SIZE);
		}

		const auto id = g_game.map.acquireEntityId(EntityClass::Npc);
		if (!id) continue;
		spawn.home = home;
		spawn.placed = true;

		auto npc = std::make_unique<Npc>();
		npc->spawn = spawn;
		npc->definition = &definition;
		npc->position = npc->previous = npc->goal = home;
		npc->rotation = spawn.rotation;
		const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
		if (spawn.relocateMs) npc->nextRelocate = now + spawn.relocateMs;
		npc->setID(id);
		g_game.map.placeThing(home, npc.get());
		restock(spawn.key, definition);
		npcs.emplace(spawn.key, std::move(npc));
	}
}

bool NpcSystem::canRelocate(const Npc& npc, uint64_t) const
{
	// Never mid-conversation, and never in front of anyone.
	for (const auto& [id, session] : sessions) {
		if (session.spawn == npc.spawn.key) return false;
	}
	return !npcNearPlayer(npc.position);
}

bool NpcSystem::relocate(Npc& npc, uint64_t now)
{
	if (npc.spawn.placement == NpcPlacement::Fixed) return false;
	Position next;
	if (!findHome(npc.spawn, &npc, next)) return false;

	// Gone from where it was for everyone watching that spot, then a fresh
	// entity where it lands: previous == position, so no client glides it
	// across the map.
	EntityUpdate removal;
	npc.buildRemoval(removal);
	g_game.broadcastSurgicalUpdate(removal, npc.position);
	g_game.map.placeThing(next, &npc);
	npc.previous = npc.goal = next;
	npc.dirty = true;
	npc.spawn.home = next;
	npc.nextWalk = now + 4000;
	if (npc.spawn.relocateMs) npc.nextRelocate = now + npc.spawn.relocateMs;
	for (auto& spawn : spawns) {
		if (spawn.key == npc.spawn.key) spawn.home = next;
	}
	fmt::print(">> NPC '{}' ({}) moved to tile {},{}\n", npc.spawn.key, npc.spawn.npc, next.x / TILE_SIZE, next.y / TILE_SIZE);
	return true;
}

void NpcSystem::updateRelocation(uint64_t now)
{
	for (auto& [key, owned] : npcs) {
		Npc& npc = *owned;
		if (!npc.spawn.relocateMs || now < npc.nextRelocate) continue;
		if (!canRelocate(npc, now) || !relocate(npc, now)) {
			npc.nextRelocate = now + NPC_RELOCATE_RETRY_MS;
		}
	}
}

uint32_t NpcSystem::relocateNow(const std::string& key)
{
	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	uint32_t moved = 0;
	for (auto& [spawnKey, owned] : npcs) {
		Npc& npc = *owned;
		if (key.empty() ? !npc.spawn.relocateMs : spawnKey != key) continue;
		// An admin asking is standing nearby by definition, so only the
		// conversation guard holds here.
		bool talking = false;
		for (const auto& [id, session] : sessions) {
			if (session.spawn == spawnKey) talking = true;
		}
		if (!talking && relocate(npc, now)) ++moved;
	}
	return moved;
}

std::vector<std::string> NpcSystem::describeSpawns() const
{
	static constexpr const char* NAMES[] = {"fixed", "area", "random"};
	std::vector<std::string> lines;
	for (const auto& spawn : spawns) {
		const auto live = npcs.find(spawn.key);
		std::string where = live == npcs.end()
			? std::string("not on the map")
			: fmt::format("tile {},{}", live->second->position.x / TILE_SIZE, live->second->position.y / TILE_SIZE);
		std::string line = fmt::format("{} ({}, {}): {}", spawn.key, spawn.npc,
			NAMES[static_cast<size_t>(spawn.placement)], where);
		if (spawn.relocateMs && live != npcs.end()) {
			const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
			const uint64_t due = live->second->nextRelocate;
			line += fmt::format(", moves in {} s", due > now ? (due - now) / 1000 : 0);
		}
		lines.push_back(std::move(line));
	}
	return lines;
}

Position NpcSystem::pickWalkGoal(const Npc& npc, uint32_t walkRadius) const
{
	// A free spot inside the walk radius, or home. A goal inside a rock used
	// to be walked at until the step was refused, and the NPC then stood
	// pressed against it until its next decision.
	for (int32_t attempt = 0; attempt < 6; ++attempt) {
		const double angle = uniform_random(0, 62831) / 10000.0;
		const double radius = uniform_random(0, static_cast<int32_t>(walkRadius));
		const Position candidate = g_game.clampPositionToMap(
			static_cast<int32_t>(std::lround(npc.spawn.home.x + std::cos(angle) * radius)),
			static_cast<int32_t>(std::lround(npc.spawn.home.y + std::sin(angle) * radius)));
		if (!g_game.bodyBlockedAt(candidate, Npc::BODY_RADIUS, &npc, npc.definition->solid)) {
			return candidate;
		}
	}
	return npc.spawn.home;
}
