// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/account_runs.h"

#include "gameplay/game.h"
#include "gameplay/progress/game_event.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/scripts/script_system.h"
#include "gameplay/scenarios/scenario_population.h"
#include "gameplay/scenarios/scenario_runtime.h"

#include "persistence/ban.h"
#include "content/configmanager.h"
#include "gameplay/creature.h"
#include "world/mapsize.h"
#include "network/serverinfo.h"
#include "persistence/database.h"
#include "core/scheduler.h"
#include "network/server.h"
#include "gameplay/loot.h"
#include "gameplay/loot_placement.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "gameplay/agent.h"
#include "gameplay/item.h"
#include "world/collision.h"
#include "gameplay/projectile.h"
#include "gameplay/equipment.h"
#include "gameplay/kit.h"
#include "core/perf.h"
// No header pulls this in, so game.cpp would otherwise only see the forward
// declaration of OutputMessage.
#include "network/outputmessage.h"
#include <array>
#include <cmath>
#include <fstream>
#include <cctype>

#include "world/structure.h"
#include "gameplay/condition.h"
#include "world/mapimport.h"
#include "world/worldgen.h"
#include "content/xml_utils.h"

namespace {
	constexpr uint64_t LOOT_TAKEN_REMOVAL_DELAY_MS = 250;
	constexpr uint64_t CLIENT_CONTAINER_CLOSE_ACK_GRACE_MS = 1000;
	// An entity in a player's viewport, with its id read once so the visibility
	// diff's sort and merge never touch the virtual getID().
	struct VisibleEntity {
		uint32_t id;
		Thing* thing;
	};

	constexpr int32_t CONTAINER_CYCLE_DIRECT_RANGE = 115;
	constexpr int32_t CONTAINER_CYCLE_CLUSTER_RANGE = 115;
	constexpr std::array<uint8_t, 4> SUBTYPE_NEIGHBOR_BITS = { 8, 4, 2, 1 };

	std::array<Position, 5> getSubtypeUpdateTargets(const Position& pos)
	{
		return {
			pos,
			Position(pos.x, pos.y - TILE_SIZE),
			Position(pos.x, pos.y + TILE_SIZE),
			Position(pos.x - TILE_SIZE, pos.y),
			Position(pos.x + TILE_SIZE, pos.y)
		};
	}

	std::array<Position, 4> getDirectNeighborPositions(const Position& pos)
	{
		return {
			Position(pos.x, pos.y - TILE_SIZE),
			Position(pos.x, pos.y + TILE_SIZE),
			Position(pos.x - TILE_SIZE, pos.y),
			Position(pos.x + TILE_SIZE, pos.y)
		};
	}

	Tile* getTileAtPosition(Map& map, const Position& pos)
	{
		return map.getTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	}

	// Loop periods, used by both Game::start and each loop's self-reschedule.
	constexpr uint32_t STATIONS_PERIOD_MS       = 100;
	constexpr uint32_t RESPAWN_PERIOD_MS        = 1000;
	// Only the floor on how often the agent spawner wakes; the real cadence is
	// the mode's own respawnDelayMs (see Game::updateAgentSpawns).
	constexpr uint32_t AGENT_SPAWN_PERIOD_MS    = 1000;
	constexpr uint32_t TEAM_POSITIONS_PERIOD_MS = 1000;
	constexpr uint32_t LEADERBOARD_PERIOD_MS    = 3000;
	constexpr uint32_t BAD_KARMA_PERIOD_MS      = 2000;
	// Idle kicks are measured in minutes; sweeping oftener buys nothing.
	constexpr uint32_t IDLE_CHECK_PERIOD_MS     = 30000;
	// Map import work is sliced across ticks rather than done in one pass; this
	// is how often a slice runs. Short, because the slices are small and a
	// pasted map should appear while the admin is still looking at it.
	constexpr uint32_t MAP_JOB_PERIOD_MS        = 50;

	// Schedules relative to when the run STARTED, so the period stays fixed
	// instead of becoming periodMs + work. Overrun yields 1ms, not 0.
	//
	// Used by the loops whose cadence is not player-visible. The movement tick
	// uses nextGridDelay below instead -- see the comment there for why the
	// difference matters enough to justify two mechanisms.
	uint32_t nextPeriodDelay(uint64_t startedAt, uint32_t periodMs)
	{
		const uint64_t workMs = static_cast<uint64_t>(OTSYS_TIME()) - startedAt;
		if (workMs >= periodMs) {
			return 1;
		}
		return static_cast<uint32_t>(periodMs - workMs);
	}

	// Schedules against an absolute grid: `deadline` advances by exactly
	// periodMs regardless of when this tick actually ran.
	//
	// nextPeriodDelay cannot hold a cadence, because it measures from the
	// tick's own start and so silently absorbs everything that happens between
	// the timer expiring and the tick actually running -- the asio post to the
	// scheduler thread, the timer, the hand-off to the dispatcher, and the
	// condvar wake. Measured: ~2.8ms per period at 255 players and still ~1.6ms
	// on a server with no players at all, plus ~0.6ms because workMs is
	// integer milliseconds and therefore always rounds the wait up. That is a
	// permanent loss every period, not a phase cost -- the profiled tick was
	// 21ms of a 50ms budget while the achieved period was 53.4ms.
	//
	// It matters because movement applies a FIXED distance per tick
	// (MOVEMENT_TICKS_PER_SEC), so the shortfall came straight off every
	// player's walking speed: 18.7 ticks/s at 255 players is everyone moving
	// 6.4% slow, and even an empty server ran at 19.4.
	//
	// Anchoring on the deadline makes a late tick shorten the next wait, so the
	// long-run rate is the configured one. Catch-up ticks are deliberately NOT
	// run: they would make players briefly speed UP, which is a worse artifact
	// than running slightly slow, so a deadline that is already in the past is
	// advanced to the next future slot instead of firing immediately.
	uint32_t nextGridDelay(int64_t& deadline, uint32_t periodMs)
	{
		const int64_t now = OTSYS_TIME();
		deadline += periodMs;
		if (deadline <= now) {
			const int64_t behind = now - deadline;
			deadline += (behind / periodMs + 1) * periodMs;
		}
		return static_cast<uint32_t>(deadline - now);
	}

	bool hasMatchingSubtypeNeighbor(Map& map, const Position& neighborPos, const Object& obj, bool isRoad, bool isFloor)
	{
		Tile* tile = getTileAtPosition(map, neighborPos);
		if (!tile) {
			return false;
		}

		for (Thing* thing : tile->getThings()) {
			Object* other = thing->getObject();
			if (!other || other->getPosition() != neighborPos) {
				continue;
			}

			if (isRoad && other->getKey() == "road") {
				return true;
			}

			if (isFloor && other->getKey() == obj.getKey()) {
				return true;
			}
		}

		return false;
	}

	bool checkProjectileTargetHit(Thing* target, const Position& oldPos, const Position& newPos, float& hitX, float& hitY)
	{
		if (target->getNpc()) return false;
		const float oldX = static_cast<float>(oldPos.x);
		const float oldY = static_cast<float>(oldPos.y);
		const float newX = static_cast<float>(newPos.x);
		const float newY = static_cast<float>(newPos.y);

		if (Object* obj = target->getObject()) {
			const ObjectData* od = obj->getData();
			if (!od || !obj->blocksProjectiles()) {
				return false;
			}

			CollisionRect rect;
			if (obj->getCollisionRect(rect)) {
				return Collision::checkSegmentRect(oldX, oldY, newX, newY, rect, hitX, hitY);
			}

			if (od->radius > 0) {
				CollisionCircle circle = { static_cast<float>(obj->getPosition().x), static_cast<float>(obj->getPosition().y), static_cast<float>(od->radius) };
				return Collision::checkSegmentCircle(oldX, oldY, newX, newY, circle, hitX, hitY);
			}

			return false;
		}

		// getResource(), not dynamic_cast: this runs once per collision candidate
	// per projectile per tick, and under MSVC dynamic_cast walks the RTTI graph
	// with string comparisons. The virtual downcast was added to Thing for
	// exactly this reason and every other hot path already uses it; this site
	// was missed.
	if (Resource* res = target->getResource()) {
			CollisionCircle circle = { static_cast<float>(res->getPosition().x), static_cast<float>(res->getPosition().y), res->getCollisionRadius() };
			return Collision::checkSegmentCircle(oldX, oldY, newX, newY, circle, hitX, hitY);
		}

		if (Creature* creature = target->getCreature()) {
			CollisionCircle circle = { static_cast<float>(creature->getPosition().x), static_cast<float>(creature->getPosition().y), creature->getCollisionRadius() };
			return Collision::checkSegmentCircle(oldX, oldY, newX, newY, circle, hitX, hitY);
		}

		return false;
	}

	// How long a bullet has to stay parked on its impact point before the client
	// has walked its drawn sprite onto it. The sprite trails the dead-reckoned
	// position by one lerp lag at this speed and closes (1 - lerp) of what is
	// left every frame. Projectiles the client fades out on removal do that
	// catch-up during the fade, so they only need the floor.
	uint32_t impactLingerMs(const Projectile& projectile)
	{
		if (projectile.getExtra() == PROJECTILE_CLIENT_FADEOUT_EXTRA) {
			return PROJECTILE_IMPACT_LINGER_MIN_MS;
		}

		const float pxPerMs = projectile.getSpeed() / 1000.0f;
		const float lagPx = (pxPerMs * PROJECTILE_CLIENT_FRAME_MS * (1.0f - PROJECTILE_CLIENT_LERP)) / PROJECTILE_CLIENT_LERP;
		if (lagPx <= PROJECTILE_IMPACT_TOLERANCE_PX) {
			return PROJECTILE_IMPACT_LINGER_MIN_MS;
		}

		const float frames = std::log(PROJECTILE_IMPACT_TOLERANCE_PX / lagPx) / std::log(1.0f - PROJECTILE_CLIENT_LERP);
		return std::clamp(static_cast<uint32_t>(frames * PROJECTILE_CLIENT_FRAME_MS),
			PROJECTILE_IMPACT_LINGER_MIN_MS, PROJECTILE_IMPACT_LINGER_MAX_MS);
	}

	bool isWithinContainerCycleRange(const Position& a, const Position& b, int32_t range)
	{
		const int32_t dx = a.getOffsetX(b);
		const int32_t dy = a.getOffsetY(b);
		return static_cast<int64_t>(dx) * dx + static_cast<int64_t>(dy) * dy <=
			static_cast<int64_t>(range) * range;
	}
}

Game::Game() = default;
Game::~Game() = default;

// The content Game owns, plus the mode state derived from it. Everything here
// runs before a world exists, which is what lets --validate call it: it reads
// files and reports, and touches nothing that needs a map or a socket.
void Game::loadContentDefinitions()
{
	// First, because almost everything below is sized or bounded by it: the
	// entity id budget report, structure placement, resource density, and the
	// spawn point validated against the bounds just installed.
	MapSize::loadFromConfig();
	if (!g_npcs.load(contentFile("npcs.xml"))) throw std::runtime_error("NPC content validation failed");
	if (!g_progress.load(contentFile("stats.xml"), contentFile("achievements.xml")))
		throw std::runtime_error("stats/achievements content validation failed");
	if (!g_quests.load(QuestSystem::directory())) throw std::runtime_error("quest content validation failed");
	fmt::print(">> Map: {}x{} tiles ({}x{} units)\n", MapSize::tilesX(), MapSize::tilesY(),
		MapSize::widthUnits(), MapSize::heightUnits());

	spawnCenterX = getNumber(ConfigManager::SPAWN_X);
	spawnCenterY = getNumber(ConfigManager::SPAWN_Y);
	if (const std::string note = recentreSpawnIfOutside(); !note.empty()) {
		reportStartupWarning(note);
	}

	if (!loadModes(contentFile("modes.xml"))) {
		fmt::print(">> [Error] Could not load {}\n", contentFile("modes.xml"));
	}

	g_structures.loadTemplates(contentFile("structures.xml"));
	ConditionManager::getInstance().loadFromXml(contentFile("conditions.xml"));
	// Cross-file check, and it belongs here rather than beside the other data
	// loaders: agents.xml is read in the startup block BEFORE this function,
	// conditions.xml only here, so this is the first moment both tables
	// exist. A <repel> naming a family agents.xml does not define costs
	// nothing, breaks nothing, and silently protects the player from nobody --
	// which is exactly the failure that has to be loud.
	ConditionManager::getInstance().validateRepelTargets(contentFile("conditions.xml"));

	const std::string& modeKey = getString(ConfigManager::GAME_MODE);
	auto it = modes.find(modeKey);
	if (it != modes.end() && it->second.isAbstract) {
		reportStartupWarning(fmt::format(
			"game mode '{}' is abstract=\"true\", a base template rather than a playable mode", modeKey));
		it = modes.end();
	}
	if (it != modes.end()) {
		activeMode = &it->second;
		fmt::print(">> Active Game Mode: {} (clientModeId {})\n", activeMode->key, activeMode->clientModeId);
	} else {
		// The fallback must skip templates too, or an unmatched mode name lands
		// on one and the server runs a mode nobody wrote to be played.
		for (auto& [key, candidate] : modes) {
			if (candidate.isAbstract) continue;
			activeMode = &candidate;
			reportStartupWarning(fmt::format("game mode '{}' not found; using '{}'", modeKey, activeMode->key));
			break;
		}
	}
	if (activeMode) {
		craftSpeed = activeMode->craftSpeed;
		// The mode owns the LENGTH of the cycle; the clock owns where in it we
		// are. Read once here rather than per tick, for the same reason the
		// respawn cadences below are: an admin retuning one at runtime must not
		// be silently overruled by a value re-read from the mode.
		worldClock.configure(activeMode->dayNightCycle);

		// Resolve the per-tick gauge configuration once. A gauge the mode does
		// not define keeps its default-constructed values, which is exactly what
		// the old per-player lookup fell back to on a miss.
		const auto gauge = [this](const char* key) -> GaugeMode {
			auto found = activeMode->gauges.find(key);
			return found != activeMode->gauges.end() ? found->second : GaugeMode();
		};
		activeGauges.stamina = gauge("stamina");
		activeGauges.food = gauge("food");
		activeGauges.warmth = gauge("warmth");
		activeGauges.radiation = gauge("radiation");
		activeGauges.life = gauge("life");
	}

	restoreRespawnDefaults();

	if (activeMode && activeMode->benchmark) {
		fmt::print("\n");
		fmt::print("!! ============================================================ !!\n");
		fmt::print("!!  BENCHMARK MODE ACTIVE: '{}'\n", activeMode->key);
		fmt::print("!!  All gauge decay is disabled -- players cannot starve, freeze\n");
		fmt::print("!!  or die of exposure. This mode exists to hold a stress test\n");
		fmt::print("!!  population steady and is NOT playable content.\n");
		fmt::print("!!  If this is a production server, set gameMode in config.lua\n");
		fmt::print("!!  back to a real mode (e.g. \"survival\") and restart.\n");
		fmt::print("!! ============================================================ !!\n");
		fmt::print("\n");
	}

	if (isGhoulMode()) {
		fmt::print(">> Ghoul mode: the world locks {}s after the first player joins"
			" (x{} if {}+ are online at expiry); {} bodies available\n",
			activeMode->ghoul.lockDelayMs / 1000, activeMode->ghoul.extendMultiplier,
			activeMode->ghoul.extendPlayerCount, activeMode->ghoul.ghouls.size());

		// The whole mode is players killing players. Under no-pvp,
		// Game::canHarmPlayer suppresses every point of player-on-player damage
		// -- so no ghoul could ever kill anyone, the last player would never
		// die, and the round would run forever.
		if (!isPvpEnabled()) {
			reportStartupWarning(
				"ghoul mode is running with worldType = \"no-pvp\", so ghouls cannot hurt anyone "
				"and the round can never end. Set worldType = \"pvp\" in config.lua.");
		}
	}

	// Map definitions have to be loaded before generation runs: it stamps them
	// between the structures and the resources, and drains the queue there
	// rather than leaving it to the job timer -- slicing protects a LIVE tick,
	// and there is not one yet.
	g_maps.loadAssets();
}

void Game::start(ServiceManager* manager)
{
	serviceManager = manager;

	loadContentDefinitions();

	// A configured scenario must load in full or the server does not open: it
	// is parsed, compiled and feature-checked before any world exists.
	{
		std::string error;
		if (!scenario::loadConfigured(activeScenario, error)) {
			startupFailure = error;
			return;
		}
	}

	// Startup and !seed=<n> build the world through the same function, and both
	// hand it the recorded seed. That is what makes `seed = <n>` in
	// config.lua and `!seed=<n>` in chat produce the same map -- they used to be
	// two copies of this sequence sharing the process RNG, so the runtime one
	// started from wherever play had left that RNG and could never match a boot.
	WorldRebuildReport bootReport;
	generateWorld(getWorldSeed(), /*preservePlayerBuilds=*/false, bootReport);
	if (!startupFailure.empty()) return;
	g_npcs.start();
	if (activeScenario) {
		std::string error;
		if (!scenario::startPopulation(error)) {
			fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, ">> [scenario] {}\n", error);
			startupFailure = fmt::format("scenario \"{}\" could not be populated: {}", activeScenario->file, error);
			return;
		}
	}
	g_events.subscribe(&g_quests);
	g_events.subscribe(&g_progress);
	g_events.subscribe(&g_scripts);
	g_progress.start();
	fmt::print(">> World fingerprint: {:08x} (seed {})\n", bootReport.fingerprint, getWorldSeed());

	g_maps.warnOnStructureOverlap();

	// The uid8-exhaustion warning that used to live here is gone with the pools
	// it reported on. It fired on every boot and could not be acted on: uid was
	// a byte, 255 per type against thousands of entities. Uniqueness is now
	// carried by the 24-bit id itself, which reportMapIdBudget accounts for.

	// maxPlayers above the protocol ceiling is a silent data-corruption bug, not
	// a capacity setting: the surplus players cannot be addressed on the wire.
	// Say so at startup rather than let it surface as "entities stop
	// disappearing" once the server gets busy.
	const uint32_t configuredMaxPlayers = static_cast<uint32_t>(getNumber(ConfigManager::MAX_PLAYERS));
	if (configuredMaxPlayers == 0 || configuredMaxPlayers > PROTOCOL_MAX_PLAYER_ID) {
		fmt::print(fg(fmt::color::yellow),
			">> WARNING: maxPlayers = {} but the client protocol addresses players with a single\n"
			"   byte, so only {} can be online at once. Logins past that are rejected with\n"
			"   \"server is full\". Raising this further has no effect -- it would require a\n"
			"   client-side change to widen the player id.\n",
			configuredMaxPlayers == 0 ? std::string("unlimited") : std::to_string(configuredMaxPlayers),
			PROTOCOL_MAX_PLAYER_ID);
	}

	if (getBoolean(ConfigManager::PERF_STATS)) {
		g_perf.setEnabled(true);
		g_netperf.setEnabled(true);
		g_perf.setCsvPath("perf_log.csv");
		fmt::print(">> Tick profiler enabled (perfStats): reporting every 5s, CSV -> perf_log.csv\n");
		// Every collision scan pads its box by this, so it is a multiplier on
		// the cost of every shot fired and every step taken. It comes from the
		// widest collidable body loaded, which makes it a property of the XML.
		fmt::print(">> Collision scan margin: {} tiles (widest collidable body reaches {} units)\n",
			Map::collisionScanTileMargin(), Map::maxCollisionExtent());
	}

	// Anchor the movement grid here, so the very first period is measured from
	// the same origin as every later one.
	nextMovementTickAt = OTSYS_TIME() + MOVEMENT_TICK_MS;
	g_scheduler.addEvent(createSchedulerTask(MOVEMENT_TICK_MS, [this]() { this->updateMovement(); }));
	g_scheduler.addEvent(createSchedulerTask(STATIONS_PERIOD_MS, [this]() { this->updateStations(); }));
	g_scheduler.addEvent(createSchedulerTask(RESPAWN_PERIOD_MS, [this]() { this->updateRespawn(); }));
	g_scheduler.addEvent(createSchedulerTask(AGENT_SPAWN_PERIOD_MS, [this]() { this->updateAgentSpawns(); }));
	g_scheduler.addEvent(createSchedulerTask(TEAM_POSITIONS_PERIOD_MS, [this]() { this->updateTeamPositions(); }));
	g_scheduler.addEvent(createSchedulerTask(LEADERBOARD_PERIOD_MS, [this]() { this->updateLeaderboard(); }));
	g_scheduler.addEvent(createSchedulerTask(BAD_KARMA_PERIOD_MS, [this]() { this->updateBadKarmaPositions(); }));
	g_scheduler.addEvent(createSchedulerTask(IDLE_CHECK_PERIOD_MS, [this]() { this->updateIdleKick(); }));
	g_scheduler.addEvent(createSchedulerTask(MAP_JOB_PERIOD_MS, [this]() { this->updateMapJobs(); }));

	// Registered unconditionally; the tick itself does nothing outside ghoul
	// mode. Keeping it unconditional means the loop exists whatever mode is
	// loaded, so nothing has to be started or stopped when one is selected.
	startGhoulRoundLoop();
}

// Drains the map importer's job queue a slice at a time and expires an idle
// paste session. Separate from updateRespawn because it has to run often (a
// paste should appear promptly) while doing very little each time.
void Game::updateMapJobs()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	g_maps.update();

	// The minimap marker set states itself whole, so it is pushed only when it
	// has actually moved -- a building placed, removed, moved, or a whole world
	// rebuilt. Asked here rather than at each mutation site so a future one
	// cannot forget; see StructureManager::consumeMarkersDirty.
	if (g_structures.consumeMarkersDirty()) {
		for (const auto& [id, player] : players) {
			if (player && player->client) {
				player->client->sendCitiesLocation();
			}
		}
	}

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, MAP_JOB_PERIOD_MS),
		[this]() { this->updateMapJobs(); }));
}

void Game::clearTile(const Position& targetPos)
{
	int32_t cx = targetPos.x / TILE_SIZE;
	int32_t cy = targetPos.y / TILE_SIZE;

	Tile* tile = map.getTile(static_cast<uint16_t>(cx), static_cast<uint16_t>(cy));
	if (!tile) return;

	std::vector<Thing*> toRemove;
	for (Thing* thing : tile->getThings()) {
		if (thing->getPosition() == targetPos) {
			// getResource(), not dynamic_cast: world generation calls clearTile
			// once per template tile, so a rebuild runs this thousands of times
			// and RTTI is the bulk of what it costs.
			if (thing->getObject() || thing->getResource()) {
				toRemove.push_back(thing);
			}
		}
	}

	for (Thing* t : toRemove) {
		removeWorldThing(t);
	}
}

// Bulldozes one static world entity: broadcast its removal, keep the spawn and
// trigger bookkeeping straight, drop it from the map, delete it later.
//
// Factored out of clearTile because clearTile answers a POSITIONAL question
// ("empty this tile") and the map importer's !clean answers an entity one
// ("remove all of these"), which would otherwise have to re-derive a position
// per entity and rescan its tile. Both must stay on exactly one removal path:
// the two bookkeeping steps below are silent when missed -- a stale
// activeTriggerObjects entry dereferences freed memory on the next trigger
// sweep, and a skipped onResourceDestroyed leaks a resource's spawn slot so it
// never respawns.
void Game::removeWorldThing(Thing* t, bool broadcastRemoval, std::vector<Thing*>* deferTo)
{
	if (!t || t->getNpc()) {
		return;
	}

	const Position pos = t->getPosition();

	// broadcastRemoval=false is for a wholesale world replacement only, where
	// every client is about to be told to drop its entity table outright (see
	// Player::resetClientEntityCache). Retracting entities one at a time first
	// is not merely wasted -- a removal sweeps EVERY player, so it is also the
	// bulk of what a rebuild costs -- it is meaningless, because the ids being
	// retracted are handed straight back out to the world being built.
	//
	// The bookkeeping below is NOT optional either way: a stale
	// activeTriggerObjects entry dereferences freed memory, and a skipped
	// onResourceDestroyed leaks a resource's spawn slot.
	if (broadcastRemoval) {
		EntityUpdate removal;
		t->buildRemoval(removal);
		broadcastSurgicalUpdate(removal, pos);
	}

	if (Object* obj = t->getObject()) {
		// A bulldozed trap may still be registered for trigger sweeps; the
		// sweep dereferences raw pointers, so unregister before deletion. The
		// logic registry holds raw pointers for the same reason.
		activeTriggerObjects.erase(obj);
		noteLogicObjectGone(obj);
	} else if (Resource* res = t->getResource()) {
		// Keep spawn accounting accurate (and let the resource respawn
		// elsewhere), like every other resource removal path does.
		if (const ResourceData* rd = g_resources.getResourceData(res->getResourceId())) {
			g_resources.onResourceDestroyed(rd->key);
		}
	}

	map.removeThing(t);

	// Deferred delete like every other removal path: same-tick server code
	// may still hold the pointer (e.g. an iteration snapshot).
	//
	// A caller sweeping in BULK hands in `deferTo` and schedules one event for
	// the whole batch instead. Per entity this is an asio post, a steady_timer
	// construction and a hash insert -- nothing for a felled tree, ruinous for
	// the ~10k a world rebuild removes: the cleanup burst costs more than the
	// rebuild it follows, and a few rebuilds in a row leave the scheduler thread
	// working through a backlog it never catches up on.
	if (deferTo) {
		deferTo->push_back(t);
		return;
	}

	g_scheduler.addEvent(createSchedulerTask(10, [t]() {
		g_dispatcher.addTask([t]() { delete t; });
	}));
}

void Game::deferBulkDelete(std::vector<Thing*>&& doomed)
{
	if (doomed.empty()) {
		return;
	}

	// One event for the lot. Scheduler tasks are delivered on the dispatcher, so
	// this frees on the same thread the per-entity path ends up on, after the
	// same 10ms grace and for the same reason.
	auto batch = std::make_shared<std::vector<Thing*>>(std::move(doomed));
	g_scheduler.addEvent(createSchedulerTask(10, [batch]() {
		for (Thing* t : *batch) {
			delete t;
		}
	}));
}

void Game::restoreRespawnDefaults()
{
	// Respawn cadences are mutable state rather than being read from the mode on
	// every tick: an admin can retune or switch off any of them at runtime, and
	// a value read live from the mode could not be overridden.
	//
	// Called again by every world rebuild. !clean-hard switches these off to
	// hold a world empty, and asking for a new world is the opposite request --
	// a freshly generated map whose trees never regrow and whose cities never
	// return is not a world anyone asked for. Building one restores the rules.
	if (!activeMode) {
		return;
	}

	structuresRespawnDelayMs = activeMode->structuresRespawnDelayMs;
	g_resources.setRespawnDelayMs(activeMode->resourcesRespawnDelaySet
		? activeMode->resourcesRespawnDelayMs
		: static_cast<uint32_t>(static_cast<float>(DEFAULT_RESPAWN_DELAY_MS) *
			activeMode->respawnDelayMultiplier));
}

bool Game::tileHoldsPlayerContent(const Position& pos) const
{
	const Tile* tile = map.findTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (!tile) {
		return false;
	}

	for (const Thing* thing : tile->getThings()) {
		if (thing->getCreature() || thing->getLoot()) {
			return true;
		}
		if (const Object* obj = thing->getObject()) {
			if (obj->getOwnerPid() != 0) {
				return true;
			}
		}
	}
	return false;
}

bool Game::tileHoldsCreature(const Position& pos) const
{
	const Tile* tile = map.findTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (!tile) {
		return false;
	}

	for (const Thing* thing : tile->getThings()) {
		if (thing->getCreature()) {
			return true;
		}
	}
	return false;
}

bool Game::tileHoldsTransientContent(const Position& pos) const
{
	const Tile* tile = map.findTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (!tile) {
		return false;
	}

	for (const Thing* thing : tile->getThings()) {
		if (thing->getCreature() || thing->getLoot()) {
			return true;
		}
	}
	return false;
}

void Game::generateWorld(uint32_t seed, bool preservePlayerBuilds, WorldRebuildReport& report)
{
	// Content rolls (what a spawned chest holds) consult this and key
	// themselves off position instead of call order while it is set.
	const worldgen::Scope generating(seed);

	// One allowance for the whole pass, spent in priority order. Without it the
	// absolute counts in modes.xml and resources.xml -- authored against a
	// 150x150 map -- pack a smaller one solid, which terminates but leaves a
	// world with nowhere to walk, spawn or build. See MapSize::ContentBudget.
	MapSize::ContentBudget budget = MapSize::makeContentBudget();

	// Structures claim their ground first, then hand-drawn maps win the tiles
	// they want, then resources fill the gaps. The order is load-bearing: a map
	// someone drew by hand outranks a randomly placed city, and a resource may
	// only have what is left.
	// A scenario is explicit population: generated content only where the
	// project opted in, its own placements where the map library would stamp.
	const scenario::World* authored = activeScenario ? &activeScenario->project.world : nullptr;

	StructureManager::PopulateReport structureReport{};
	if (!authored || authored->generateStructures)
		structureReport = g_structures.populateMap(activeMode, seed, budget, preservePlayerBuilds);
	report.structuresPlaced = structureReport.placed;
	report.structuresWanted = structureReport.wanted;

	if (authored) {
		scenario::PopulateReport placed;
		std::string error;
		if (!scenario::populate(*activeScenario, placed, error)) {
			fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, ">> [scenario] {}\n", error);
			startupFailure = fmt::format("scenario \"{}\" could not be built: {}", activeScenario->file, error);
		} else {
			fmt::print(">> Scenario placed: {} objects, {} resources\n", placed.objects, placed.resources);
		}
	} else {
		g_maps.stampStartupMaps(activeMode ? activeMode->key : std::string(), preservePlayerBuilds);
		g_maps.drainJobs();
	}

	updateRoadSubtypes();

	ResourceManager::PopulateReport resourceReport{};
	if (!authored || authored->generateResources)
		resourceReport = g_resources.populateMap(seed, budget);
	report.resourcesSpawned = resourceReport.spawned;
	report.resourcesWanted = resourceReport.wanted;
	report.outOfIds = structureReport.outOfIds || resourceReport.outOfIds;

	worldFingerprint = worldgen::layout.value();
	report.fingerprint = worldFingerprint;
}

Game::WorldRebuildReport Game::regenerateWorld(uint32_t seed, bool preservePlayerBuilds)
{
	WorldRebuildReport report;
	const int64_t startedAt = OTSYS_TIME();

	// Anything a player has open is about to be deleted underneath them, and a
	// station or chest window left pointing at a dead id is a UI the player
	// cannot use and cannot close.
	std::vector<uint32_t> openPlayerIds;
	openPlayerIds.reserve(players.size());
	for (const auto& [id, player] : players) {
		if (player && player->getOpenedInteractionId() != 0) {
			openPlayerIds.push_back(id);
		}
	}
	for (const uint32_t id : openPlayerIds) {
		playerCloseContainer(id);
	}

	// Anything the map importer still has queued -- a paste, a respawn, a
	// !clean -- would otherwise run AFTER this and stamp the old world's objects
	// into the new one. Run the queue out first so the wipe below is final.
	g_maps.drainJobs();

	// 1. Take down the old world. Ids rather than pointers is habit from the
	// sliced clean path; here the sweep is one pass, but the snapshot still has
	// to exist before removal starts because removeWorldThing mutates `things`.
	std::vector<uint32_t> victims;
	victims.reserve(map.getThings().size());
	for (Thing* thing : map.getThings()) {
		if (thing->getCreature()) {
			continue; // players and agents live through a reseed
		}
		if (thing->getLoot()) {
			continue; // dropped loot is somebody's property, not world content
		}
		if (const Object* obj = thing->getObject()) {
			// A base is the one thing on the map that took real time to build,
			// so it survives unless the admin explicitly asked otherwise.
			if (preservePlayerBuilds && obj->getOwnerPid() != 0) {
				continue;
			}
		} else if (!thing->getResource()) {
			continue; // projectiles and anything else transient
		}
		victims.push_back(thing->getID());
	}

	// Removals are NOT broadcast: step 4 replaces every client's entity table
	// outright, which is both correct where a per-entity diff is not (ids are
	// recycled into the new world) and far cheaper -- a removal broadcast
	// sweeps every player, so this is thousands of scans not done.
	std::vector<Thing*> doomed;
	doomed.reserve(victims.size());
	for (const uint32_t id : victims) {
		if (Thing* thing = map.getThingByID(id)) {
			removeWorldThing(thing, /*broadcastRemoval=*/false, &doomed);
			++report.removed;
		}
	}
	// One delete event for the whole sweep. Ten thousand individual ones is a
	// heavier burst than the rebuild itself, and it lands on the scheduler
	// thread rather than this one, so repeated rebuilds compound it.
	deferBulkDelete(std::move(doomed));

	// Every entity any placement recorded has just been removed, so every record
	// now describes a world that no longer exists. Generation opens fresh ones.
	g_placements.reset();

	// A rebuild is a request for a world, so it comes with a world's rules --
	// including the two !clean-hard switched off to hold the old one empty.
	const bool respawnWasOff = (structuresRespawnDelayMs == 0 || !g_resources.isRespawnEnabled());
	restoreRespawnDefaults();
	report.respawnRestored = respawnWasOff &&
		(structuresRespawnDelayMs != 0 || g_resources.isRespawnEnabled());

	// Every resource just removed queued itself for respawn. Left alone those
	// would fire minutes from now and pile a second world on top of this one.
	g_resources.resetForRegeneration();

	// 2. Record the seed, and pin the process RNG with it as well.
	//
	// Generation itself no longer reads the process RNG -- it derives its own
	// streams from `seed` (worldgen.h), which is what makes this rebuild match
	// a fresh boot on the same seed instead of merely matching another rebuild.
	// The reseed stays because the seed is a promise about the whole session:
	// loot rolls and agent behaviour draw from that generator, and an admin who
	// pins `seed` expects a repeatable server, not just a repeatable map.
	seedRandomGenerator(seed);

	// 3. Rebuild, through exactly the path startup takes.
	generateWorld(seed, preservePlayerBuilds, report);

	// 4. Publish it, as a replacement rather than a diff.
	//
	// Nothing above told any client anything: the wipe skipped its removal
	// broadcasts and generation places through internalPlaceThing, which is
	// silent. That is deliberate, because a per-entity diff cannot describe this
	// safely -- the id pool recycles the moment an id is released, so the pass
	// above handed the new world the very ids the old one just gave back. A
	// removal and an add would name the same client slot while meaning different
	// entities, and the client's cache is a flat index that cannot tell them
	// apart: the old sprite stays and the new one draws over it. That is what
	// made rapid !seed leave the two worlds merged, and no amount of waiting
	// between rebuilds fixes a diff that is ambiguous by construction.
	//
	// So the client is told to forget everything instead. resetClientEntityCache
	// drops the queued records, clears the known set and arms the login flag;
	// the next visibility tick refills it from an empty baseline and flushes it
	// with that flag, which client.js answers with Entitie.removeAll(). One full
	// send, nothing to get wrong, and no dependence on what any client happened
	// to have received before the rebuild started.
	for (const auto& [id, player] : players) {
		if (!player) {
			continue;
		}
		player->resetClientEntityCache();

		// Area effects are edge-triggered off flags the character already holds,
		// so deleting the object that was irradiating (or warming) someone fires
		// no edge and leaves their bar running the wrong way for the rest of the
		// session. Same failure a reconnect has, and the same cure.
		player->requestFullGaugeResync();

		// The cities moved, so every minimap in the world is now wrong too.
		if (player->client) {
			player->client->sendCitiesLocation();
		}
	}

	// Sent above as part of one atomic resync rather than up to a housekeeping
	// tick later; clearing the flag stops updateMapJobs sending it again.
	g_structures.consumeMarkersDirty();

	report.elapsedMs = OTSYS_TIME() - startedAt;
	fmt::print(">> [seed] world regenerated from seed {} in {}ms: {} removed, structures {}/{}, "
		"resources {}/{}, player builds {}, fingerprint {:08x}{}\n",
		seed, report.elapsedMs, report.removed,
		report.structuresPlaced, report.structuresWanted,
		report.resourcesSpawned, report.resourcesWanted,
		preservePlayerBuilds ? "kept" : "bulldozed",
		report.fingerprint,
		report.outOfIds ? " [OUT OF ENTITY IDS]" : "");
	return report;
}

void Game::updateRespawn()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	g_resources.updateRespawn();

	if (structuresRespawnDelayMs > 0) {
		const int64_t now = OTSYS_TIME();
		if (lastStructureRespawnAt == 0) {
			lastStructureRespawnAt = now;
		} else if (now - lastStructureRespawnAt >= static_cast<int64_t>(structuresRespawnDelayMs)) {
			lastStructureRespawnAt = now;
			g_structures.respawnStructures();
		}
	}

	// Imported maps re-stamp on the same beat as cities, and for the same
	// reason: one cadence for "the world puts itself back" is easier to reason
	// about than three.
	g_maps.updateRespawn();

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, RESPAWN_PERIOD_MS),
		[this]() { this->updateRespawn(); }));
}

bool Game::loadModes(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "modes");
	if (!root) return false;

	for (pugi::xml_node modeNode = root.child("mode"); modeNode; modeNode = modeNode.next_sibling("mode")) {
		// base= starts this mode as a copy of one declared EARLIER in the file,
		// so <clans> and <karma> -- byte-identical across all three shipped
		// modes -- can be written once. Every attribute below then defaults to
		// the value already in `mode`, which is the struct default when there is
		// no base and the inherited value when there is; that is what makes this
		// a no-op for a mode that declares no base.
		GameMode mode;
		mode.key = modeNode.attribute("key").as_string();

		if (pugi::xml_attribute baseAttr = modeNode.attribute("base")) {
			auto baseIt = modes.find(baseAttr.as_string());
			if (baseIt == modes.end()) {
				reportDataWarning(filename, fmt::format(
					"mode '{}' has base=\"{}\", which is not a mode declared above it; "
					"nothing was inherited", mode.key, baseAttr.as_string()));
			} else {
				const std::string ownKey = mode.key;
				mode = baseIt->second;
				mode.key = ownKey;
				// Never inherited: "this is a template" describes the
				// declaration, not the thing. Same rule as objects.xml.
				mode.isAbstract = false;
			}
		}
		mode.isAbstract = modeNode.attribute("abstract").as_bool(false);

		mode.clientModeId = static_cast<uint8_t>(modeNode.attribute("clientModeId").as_uint(mode.clientModeId));
		mode.dayNightCycle = modeNode.attribute("dayNightCycle").as_uint(mode.dayNightCycle);
		mode.craftSpeed = modeNode.attribute("craftSpeed").as_float(mode.craftSpeed);
		if (pugi::xml_node craftNode = modeNode.child("crafting")) {
			mode.craftSpeed = craftNode.attribute("speed").as_float(mode.craftSpeed);
		}
		mode.benchmark = modeNode.attribute("benchmark").as_bool(mode.benchmark);

		// A block that is PRESENT replaces the inherited one wholesale, rather
		// than merging into it. One rule for every block, and the only one that
		// can express "this mode has no gauges at all"; a merge would also make
		// the push_back lists below silently double under base=.
		pugi::xml_node gaugesNode = modeNode.child("gauges");
		if (gaugesNode) {
			mode.gauges.clear();
			for (pugi::xml_node gNode = gaugesNode.child("gauge"); gNode; gNode = gNode.next_sibling("gauge")) {
				GaugeMode gm;
				std::string gKey = gNode.attribute("key").as_string();
				gm.max = static_cast<uint16_t>(gNode.attribute("max").as_uint(255));
				gm.speedInc = static_cast<uint16_t>(gNode.attribute("speedInc").as_uint(0));
				gm.speedDec = static_cast<uint16_t>(gNode.attribute("speedDec").as_uint(0));

				gm.lifeDecBelowPct = static_cast<uint8_t>(gNode.attribute("lifeDecBelowPct").as_uint(0));
				gm.lifeDecAbovePct = static_cast<uint8_t>(gNode.attribute("lifeDecAbovePct").as_uint(255));
				gm.lifeRegenAbovePct = static_cast<uint8_t>(gNode.attribute("lifeRegenAbovePct").as_uint(255));
				gm.lifeRegenBelowPct = static_cast<uint8_t>(gNode.attribute("lifeRegenBelowPct").as_uint(0));

				mode.gauges[gKey] = gm;
			}
		}

		pugi::xml_node spawnsNode = modeNode.child("spawns");
		if (spawnsNode) {
			mode.structureSpawns.clear();
			mode.agentSpawns.clear();
			for (pugi::xml_node sNode = spawnsNode.child("spawn"); sNode; sNode = sNode.next_sibling("spawn")) {
				std::string spawnType = sNode.attribute("type").as_string();
				if (spawnType == "resources") {
					mode.respawnDelayMultiplier = sNode.attribute("respawnDelayMultiplier").as_float(mode.respawnDelayMultiplier);
					// An explicit delay wins over the multiplier, and is the only
					// way to say 0 = never (a multiplier of 0 would read as "as
					// fast as possible", which is the opposite).
					if (auto delayAttr = sNode.attribute("respawnDelayMs")) {
						mode.resourcesRespawnDelayMs = delayAttr.as_uint(0);
						mode.resourcesRespawnDelaySet = true;
					}
					mode.rateExperience = sNode.attribute("rateExperience").as_float(mode.rateExperience);
					// One spelling. rateItems/rateItemDrop/rateDrop/rateLoot were
					// also accepted here; none of them appears in any mode.
					mode.rateItem = sNode.attribute("rateItem").as_float(mode.rateItem);
				} else if (spawnType == "structures") {
					mode.structuresRespawnDelayMs = sNode.attribute("respawnDelayMs").as_uint(mode.structuresRespawnDelayMs);
					for (pugi::xml_node structNode = sNode.child("structure"); structNode; structNode = structNode.next_sibling("structure")) {
						StructureSpawn ss;
						ss.key = structNode.attribute("key").as_string();
						ss.amount = structNode.attribute("amount").as_uint(0);
						ss.isCity = structNode.attribute("isCity").as_bool(false);
						mode.structureSpawns.push_back(ss);
					}
				} else if (spawnType == "agents") {
					mode.agentsRespawnDelayMs = sNode.attribute("respawnDelayMs").as_uint(mode.agentsRespawnDelayMs);
					mode.agentsMaxTotal = sNode.attribute("maxTotal").as_uint(mode.agentsMaxTotal);
					for (pugi::xml_node agentNode = sNode.child("agent"); agentNode; agentNode = agentNode.next_sibling("agent")) {
						AgentSpawn as;
						as.key = agentNode.attribute("key").as_string();
						as.maxAlive = agentNode.attribute("maxAlive").as_uint(0);
						as.weight = agentNode.attribute("weight").as_uint(0);
						as.time = agentNode.attribute("time").as_string("any");
						mode.agentSpawns.push_back(as);
					}
				}
			}
		}

		pugi::xml_node clansNode = modeNode.child("clans");
		if (clansNode) {
			mode.clansEnabled = clansNode.attribute("enabled").as_bool(mode.clansEnabled);
			mode.clansCanCreate = clansNode.attribute("canCreate").as_bool(mode.clansCanCreate);
			mode.clansMaxMembers = clansNode.attribute("maxMembers").as_uint(mode.clansMaxMembers);
			mode.clansMaxClans = clansNode.attribute("maxClans").as_uint(mode.clansMaxClans);
		}

		// The node's presence is the switch; see GhoulRules.
		if (pugi::xml_node ghoulNode = modeNode.child("ghoulRules")) {
			GhoulRules& gr = mode.ghoul;
			gr.enabled = true;
			gr.lockDelayMs = ghoulNode.attribute("lockDelayMs").as_uint(gr.lockDelayMs);
			gr.extendPlayerCount = ghoulNode.attribute("extendPlayerCount").as_uint(gr.extendPlayerCount);
			gr.extendMultiplier = ghoulNode.attribute("extendMultiplier").as_float(gr.extendMultiplier);
			gr.revealIntervalMs = ghoulNode.attribute("revealIntervalMs").as_uint(gr.revealIntervalMs);
			gr.shiftSpeedBonus = static_cast<uint16_t>(
				ghoulNode.attribute("shiftSpeedBonus").as_uint(gr.shiftSpeedBonus));
			gr.daylightDamage = ghoulNode.attribute("daylightDamage").as_bool(gr.daylightDamage);

			for (pugi::xml_node g = ghoulNode.child("ghoul"); g; g = g.next_sibling("ghoul")) {
				GhoulChoice choice;
				choice.key = g.attribute("key").as_string();
				choice.weight = g.attribute("weight").as_uint(0);
				if (choice.key.empty() || choice.weight == 0) {
					// A zero weight can never be drawn, so it is a typo rather
					// than a way to disable an entry -- deleting the line is.
					reportStartupWarning(fmt::format(
						"mode '{}': <ghoul key=\"{}\" weight=\"{}\"/> can never be picked; ignored",
						mode.key, choice.key, choice.weight));
					continue;
				}
				gr.ghouls.push_back(std::move(choice));
			}

			// A mode that turns everyone into a ghoul and has no ghoul to turn
			// them into locks the round and then strands every later login.
			if (gr.ghouls.empty()) {
				reportStartupWarning(fmt::format(
					"mode '{}' has <ghoulRules> but no usable <ghoul> entries; nobody can spawn as one",
					mode.key));
			}

			// client.js keys every ghoul code path off mode id 2 (World.__GHOUL__).
			if (mode.clientModeId != 2) {
				reportStartupWarning(fmt::format(
					"mode '{}' has <ghoulRules> but clientModeId=\"{}\"; client.js only runs ghoul mode "
					"on clientModeId=\"2\", so clients will draw plain survival while the server "
					"enforces ghoul rules", mode.key, mode.clientModeId));
			}
		}

		pugi::xml_node karmaNode = modeNode.child("karma");
		if (karmaNode) {
			mode.karmaLevels.clear();
			for (pugi::xml_node lvlNode = karmaNode.child("level"); lvlNode; lvlNode = lvlNode.next_sibling("level")) {
				uint8_t lvlId = static_cast<uint8_t>(lvlNode.attribute("id").as_uint());
				KarmaLevelMode kl;
				kl.xpMultiplier = lvlNode.attribute("xpMultiplier").as_float(1.00f);
				kl.maxKills = lvlNode.attribute("maxKills").as_uint(0);
				mode.karmaLevels[lvlId] = kl;
			}
		}

		if (mode.karmaLevels.empty()) {
			mode.karmaLevels[0] = { 1.25f, 0 };      // Angel
			mode.karmaLevels[1] = { 1.00f, 3 };      // Normal
			mode.karmaLevels[2] = { 0.95f, 5 };      // Orange
			mode.karmaLevels[3] = { 0.90f, 7 };      // Red
			mode.karmaLevels[4] = { 0.85f, 10 };     // Savage
			mode.karmaLevels[5] = { 0.80f, 999999 }; // Devil
		}

		if (!mode.agentSpawns.empty()) {
			fmt::print(">> Mode '{}': {} agent spawn types (maxTotal={}, respawn={}ms)\n",
				mode.key, mode.agentSpawns.size(), mode.agentsMaxTotal, mode.agentsRespawnDelayMs);
		}

		// One line per mode, and it exists to make base= auditable: what a mode
		// INHERITS is invisible in the file, so the log has to show what it
		// ended up with. Reused as the before/after check when a block moves
		// into a base -- the numbers must not move.
		reportDataFile(filename, fmt::format(
			"mode '{}'{} clientModeId={} gauges={} karma={} structures={} agents={} "
			"clans={}/{}/{} craft={:.2f} rates={:.2f}/{:.2f} day={}",
			mode.key, mode.isAbstract ? " (abstract)" : "",
			mode.clientModeId, mode.gauges.size(), mode.karmaLevels.size(),
			mode.structureSpawns.size(), mode.agentSpawns.size(),
			mode.clansEnabled ? 1 : 0, mode.clansMaxMembers, mode.clansMaxClans,
			mode.craftSpeed, mode.rateExperience, mode.rateItem, mode.dayNightCycle));

		modes[mode.key] = mode;
	}
	return true;
}

void Game::updateRoadSubtypes()
{
	for (Thing* t : map.getThings()) {
		if (Object* obj = t->getObject()) {
			if (obj->getKey() == "road") {
				updateSubtypes(obj->getPosition());
			}
		}
	}
}

void Game::updateSubtypes(const Position& pos)
{
	const std::array<Position, 5> targets = getSubtypeUpdateTargets(pos);

	for (const Position& targetPos : targets) {
		Tile* tile = getTileAtPosition(map, targetPos);
		if (!tile) continue;

		for (Thing* t : tile->getThings()) {
			Object* obj = t->getObject();
			if (!obj || obj->getPosition() != targetPos) continue;
			if (obj->hasFixedSubtype()) continue;

			const ObjectData* od = obj->getData();
			if (!od) continue;

			bool isRoad = (obj->getKey() == "road");
			bool isFloor = od->isFloor;

			if (isRoad || isFloor) {
				uint8_t mask = 0;
				// Neighbors: T=8, B=4, L=2, R=1
				const std::array<Position, 4> neighbors = getDirectNeighborPositions(targetPos);
				for (size_t i = 0; i < neighbors.size(); ++i) {
					if (hasMatchingSubtypeNeighbor(map, neighbors[i], *obj, isRoad, isFloor)) {
						mask |= SUBTYPE_NEIGHBOR_BITS[i];
					}
				}

				uint8_t currentSubtype = obj->getSubtype();
				uint8_t baseMaterial = currentSubtype / 16;
				uint8_t newSubtype = (baseMaterial * 16) + mask;

				if (currentSubtype != newSubtype) {
					obj->setSubtype(newSubtype);
					EntityUpdate update;
					obj->buildUpdate(update);
					broadcastSurgicalUpdate(update, obj->getPosition());
				}
			}
		}
	}
}

// Runs unconditionally, mode or no mode: the clock is a property of the world
// and the mode only supplies its length, so a misconfigured server has the
// wrong length rather than a frozen sky. The old version returned early without
// an active mode, which also made `isNight()` permanently false.
void Game::updateWorldTime(uint32_t elapsedMs)
{
	worldClock.advance(elapsedMs);
	if (worldClock.needsBroadcast()) {
		broadcastWorldTime();
	}
}

void Game::broadcastWorldTime()
{
	// Before the loop, not after: this is what "the clients have been told"
	// means, and it is also what pushes the next periodic resync out by a full
	// interval rather than leaving a short one behind an admin jump.
	worldClock.markBroadcast();
	for (const auto& it : players) {
		if (it.second->client) {
			it.second->client->sendWorldTime();
		}
	}
}

GameState_t Game::getGameState() const { return gameState; }

void Game::setWorldType(WorldType_t type) { worldType = type; }

bool Game::canHarmPlayer(const Player* attacker, const Player* victim) const
{
	if (!attacker || !victim) return true; // environment damage is never PvP
	if (attacker == victim) return true;   // your own blast is your own fault

	// Ghouls are one side and do not eat each other. Suppressing the damage
	// HERE rather than refusing the swing is the point: everything else about
	// the hit still lands, so a ghoul can shove another ghoul out of a doorway
	// or off a cornered player, and a pack piling onto one target can be broken
	// up by its own members. That is the only leverage ghouls have over each
	// other, and taking the health loss away is all that is needed to give it to
	// them -- exactly how no-pvp already works for players below.
	if (attacker->isGhoul() && victim->isGhoul()) return false;

	if (isPvpAllowedBetween(attacker->getPosition(), victim->getPosition())) return true;
	// Carved out the same way the invincibility checks carve them out.
	return attacker->hasGroupFlag(GroupFlag::BypassInvincible);
}

bool Game::isPvpAllowedBetween(const Position& attacker, const Position& victim) const
{
	// A scenario region can switch PvP on or off where it lies; both ends of the
	// fight must allow it, so a shot from a safe zone is as harmless as a shot
	// into one. Unset on both sides: the world's own rule.
	const auto& runtime = scenario::g_scenarioRuntime;
	const std::optional<bool> from = runtime.permission(scenario::PermissionKind::Pvp, attacker);
	const std::optional<bool> to = runtime.permission(scenario::PermissionKind::Pvp, victim);
	return from.value_or(isPvpEnabled()) && to.value_or(isPvpEnabled());
}

void Game::setGameState(GameState_t newState)
{
	if (gameState == GAME_STATE_SHUTDOWN) {
		return;
	}

	if (gameState == newState) {
		return;
	}

	gameState = newState;
	switch (newState) {
	case GAME_STATE_INIT: {
		break;
	}

	case GAME_STATE_SHUTDOWN: {
		// What is not stored yet goes to storage/progress-outbox.json, and the
		// next start sends it.
		g_progress.stop();
		// Best effort: tell connected players why the socket is about to go,
		// so their client shows "shutting down" instead of reconnecting. If a
		// frame does not make it out before the process stops, the client sees
		// a plain drop and its reconnect fails cleanly.
		for (const auto& [id, p] : players) {
			if (auto client = p->getProtocolGame()) {
				client->sendDisconnectReason(DisconnectReason::SHUTTING_DOWN);
			}
		}
		g_scheduler.stop();
		g_dispatcher.stop();
#ifdef HTTP
		tfs::http::stop();
#endif
		// The main thread is inside serviceManager.run() (startServer) and
		// only leaves it when the network stops. Nothing stopped it, so Ctrl+C
		// printed "shutting down" and the process never exited. stop() closes
		// the listeners and ends the I/O loop after a 3 s grace for the
		// DISCONNECT_REASON frames above.
		if (serviceManager) serviceManager->stop();
		break;
	}

	case GAME_STATE_CLOSED: {
		break;
	}

	default:
		break;
	}
}

Thing* Game::getThingByID(uint32_t id)
{
	return map.getThingByID(id);
}

Player* Game::getPlayerByID(uint32_t id)
{
	if (id == 0) {
		return nullptr;
	}

	auto it = players.find(id);
	if (it == players.end()) {
		return nullptr;
	}
	return it->second;
}

Player* Game::getPlayerByGUID(uint32_t guid)
{
	auto it = mappedPlayerGuids.find(guid);
	return (it != mappedPlayerGuids.end()) ? it->second : nullptr;
}

// "Same side as `ownerGuid`" -- the owner themselves, or anyone in their clan.
// Clans are what this game calls teams. Shared by Object::isTeammateOrOwner and
// the agent targeting rules so ownership means one thing everywhere: a bot that
// spares someone a door would not is a bug waiting to be reported twice.
bool Game::isOwnerOrClanmate(uint32_t ownerGuid, const Player* p) const
{
	if (ownerGuid == 0 || !p) {
		return false;
	}
	if (p->getGUID() == ownerGuid) {
		return true;
	}
	if (p->clanId < 0) {
		return false;
	}
	auto it = clans.find(static_cast<uint8_t>(p->clanId));
	return it != clans.end() && it->second.members.find(ownerGuid) != it->second.members.end();
}

Player* Game::getPlayerByToken(const std::string& token)
{
	for (const auto& it : players) {
		// A just-died player lingers in `players` until its deferred
		// release() runs (Connection::close defers via the dispatcher). A
		// fast enough relogin under the same token could otherwise land here
		// and "reconnect" to the corpse instead of starting a fresh
		// character — skipping grantStartingKit entirely.
		if (it.second->getToken() == token && it.second->getHealth() > 0) {
			return it.second;
		}
	}
	return nullptr;
}

Player* Game::getPlayerByAccountId(uint32_t accountId)
{
	if (accountId == 0) return nullptr;
	for (const auto& it : players) {
		// Same corpse rule as getPlayerByToken.
		if (it.second->getAccountId() == accountId && it.second->getHealth() > 0) {
			return it.second;
		}
	}
	return nullptr;
}

uint32_t Game::getFreeSlotId(uint32_t maxSlot)
{
	// Never hand out a GUID the protocol cannot represent. Only the low byte of
	// the GUID reaches the client, so a 256th concurrent player would alias
	// onto an existing one and corrupt both players' entity views (see
	// PROTOCOL_MAX_PLAYER_ID). Returning 0 here makes createNewPlayer reject
	// the login with "server is full", which is the honest outcome: refusing
	// one player is far better than silently breaking the session for two.
	// ServerInfo has already clamped the live cap into that range; the caller's
	// bound is clamped here too.
	const uint32_t limit = std::min(maxSlot, PROTOCOL_MAX_PLAYER_ID);

	for (uint32_t i = 1; i <= limit; ++i) {
		if (mappedPlayerGuids.find(i) == mappedPlayerGuids.end()) {
			return i;
		}
	}
	return 0;
}

bool Game::internalPlaceThing(Thing* thing, const Position& pos)
{
	// Id-index lookup rather than a linear scan over every entity on the map.
	bool alreadyPlaced = (map.getThingByID(thing->getID()) == thing);

	if (!map.placeThing(pos, thing)) {
		return false;
	}

	if (!alreadyPlaced) {
		if (Creature* c = thing->getCreature()) {
			c->incrementReferenceCounter();
			c->setID();
		}
	}

	// The one place every object enters the world -- world generation, the map
	// importer and player builds all land here.
	if (Object* obj = thing->getObject()) {
		if (const ObjectData* od = obj->getData(); od && od->isLogicObject) {
			noteLogicObjectPlaced(obj);
		}
	}
	return true;
}

bool Game::placeThing(Thing* thing, const Position& pos)
{
	if (!internalPlaceThing(thing, pos)) {
		return false;
	}

	EntityUpdate update;
	thing->buildUpdate(update);
	broadcastSurgicalUpdate(update, pos);

	if (Object* obj = thing->getObject()) {
		updateSubtypes(pos);
	}

	return true;
}

void Game::addPlayer(Player* player)
{
	const std::string& lowercase_name = boost::algorithm::to_lower_copy(player->getName());
	mappedPlayerNames[lowercase_name] = player;
	mappedPlayerGuids[player->getGUID()] = player;
	players[player->getID()] = player;
}

void Game::removePlayer(Player* player)
{
	if (player) g_npcs.forget(player->getID());
	if (player) g_quests.forget(player->getID());
	if (player) g_progress.detach(player->getID());
	cancelTrade(player->getID(), "Trade cancelled: player left.");
	auto it = players.find(player->getID());
	if (it == players.end()) {
		return;
	}

	// map.removeThing() below drops the WORLD's reference to the player, and by
	// the time a removal runs that is usually the last one left: both a kick and
	// a death close the connection first, and Connection::close queues the
	// session's release() ahead of the removal task -- so ProtocolGame::release
	// has already given its reference up. Without one of our own the player is
	// deleted inside removeThing and the getName()/getGUID() reads below run on
	// freed memory. That is harmless while the block still happens to hold the
	// old bytes, which is why it survives a single kick, and an access violation
	// once a mass kick recycles the heap between the free and the read.
	// Agent::die states the same rule for the same reason.
	player->incrementReferenceCounter();

	// A death was logged (with its killer) where it happened; this is the
	// plain departure -- disconnect, idle kick, session gone.
	if (player->getHealth() > 0) {
		broadcastServerLog(ServerLogKind::LEAVE, static_cast<uint8_t>(player->getGUID()), 0, "", player);
	}

	playerCloseContainer(player->getID());
	removePlayerFromClan(player);
	blocksOnDeparture(player);

	// Set BEFORE buildRemoval: it is what buildRemoval turns into the client's
	// keepInCache flag, so a death animation is asked for by this flag alone and
	// never by writing `extra` afterwards. See EntityUpdate::makeRemoval.
	EntityUpdate removal;
	removal.isDestruction = (player->getHealth() == 0);
	player->buildRemoval(removal);
	broadcastSurgicalUpdate(removal, player->getPosition());

	map.removeThing(player);

	// Duplicate nicknames are possible; only erase mappings that actually
	// point at this player so a same-named later login keeps its lookup.
	const std::string& lowercase_name = boost::algorithm::to_lower_copy(player->getName());
	auto nameIt = mappedPlayerNames.find(lowercase_name);
	if (nameIt != mappedPlayerNames.end() && nameIt->second == player) {
		mappedPlayerNames.erase(nameIt);
	}
	auto guidIt = mappedPlayerGuids.find(player->getGUID());
	if (guidIt != mappedPlayerGuids.end() && guidIt->second == player) {
		mappedPlayerGuids.erase(guidIt);
	}
	remoteObjects.erase(player->getGUID());
	players.erase(it);

	// Balances the reference taken above. If the session was already gone this
	// is what actually deletes the player -- after every read of it is done.
	player->decrementReferenceCounter();
}

// The character stays in the world after this — only the session is gone. Drop
// the input state that is latched by the client and would otherwise never be
// released: a player who disconnects mid-stride would walk forever, and one who
// disconnects holding the mouse would keep swinging.
void Game::onPlayerSessionLost(Player* player)
{
	if (player) g_npcs.close(player->getID(), "Connection closed.");
	if (player) g_progress.sessionLost(player);
	cancelTrade(player->getID(), "Trade cancelled: player disconnected.");
	player->setMoveMask(0);
	player->setShift(false);
	player->setAimHeld(false);
	player->handleMouseUp();
	player->cancelAction();
	player->cancelReload();

	// Release any station/chest the player had open so it is not locked to a
	// character nobody is driving.
	playerCloseContainer(player->getID());

	fmt::print("DEBUG: Player {} lost connection, left in world as AFK.\n", player->getName());
}

void Game::scheduleRemovePlayer(Player* player)
{
	const uint32_t playerId = player->getID();
	g_dispatcher.addTask([playerId]() {
		if (Player* p = g_game.getPlayerByID(playerId)) {
			g_game.removePlayer(p);
		}
	});
}

void Game::kickPlayer(Player* target, DisconnectReason reason, const std::string& detail)
{
	if (auto client = target->getProtocolGame()) {
		client->disconnectClient(reason, detail);
	}

	// A closed connection now leaves the character in the world, so a kick has
	// to remove it explicitly. Deferred — callers kick while iterating players.
	scheduleRemovePlayer(target);
}


void Game::destroyObjectsOwnedBy(uint32_t ownerGuid)
{
	std::vector<Object*> objectsToDestroy;
	for (Thing* t : map.getThings()) {
		if (Object* obj = t->getObject()) {
			if (obj->getOwnerPid() == ownerGuid && !obj->isDestroyed) {
				objectsToDestroy.push_back(obj);
			}
		}
	}

	for (Object* obj : objectsToDestroy) {
		// int32: health is a uint16, and -static_cast<int16_t>(40000) is a heal.
		obj->changeHealth(-static_cast<int32_t>(obj->getHealth()), 0, nullptr);
	}
}

void Game::playerSayChannel(uint32_t playerId, ChatChannel channel, uint8_t target, const std::string& message)
{
	Player* player = getPlayerByID(playerId);
	if (!player) {
		return;
	}

	player->resetIdleTime();

	if (message.empty()) {
		return;
	}

	// A greeting near an NPC opens the conversation ("bye" ends it) and is
	// still said aloud, so the players standing around hear it too.
	if (channel == ChatChannel::LOCAL) g_npcs.localSay(player, message);
	if (message[0] == '!') {
		if (player->getGroupRank() == 0) {
			return;
		}

		// Split by '!' for chained commands
		std::vector<std::string> commands;
		std::string current;
		for (size_t i = 1; i < message.size(); ++i) {
			if (message[i] == '!') {
				if (!current.empty()) commands.push_back(current);
				current.clear();
			} else {
				current += message[i];
			}
		}
		if (!current.empty()) commands.push_back(current);

		for (const std::string& cmd : commands) {
			// Digit checks inside don't guard against overflow: a too-long
			// number makes std::stoi/stoul throw. A typo must not crash the server.
			try {
				parseAdminCommand(player, cmd);
			} catch (const std::exception& e) {
				fmt::print(">> [Admin Command Error] '{}': {}\n", cmd, e.what());
			}
		}
		return;
	}

	// UTF-8-safe truncation: a plain substr could split a multi-byte character
	// (the client chat input allows far more than MAX_CHAT_LENGTH bytes),
	// corrupting the frame for every receiver.
	const std::string chatMsg = truncateUtf8(message, MAX_CHAT_LENGTH);
	const uint8_t senderPid = static_cast<uint8_t>(player->getGUID());
	const uint8_t flags = player->hasGroupFlag(GroupFlag::StaffChat) ? CHAT_FLAG_ADMIN : 0;

	// Staff reach everyone: a block never stands between a player and moderation.
	const bool blockable = !player->hasGroupFlag(GroupFlag::StaffChat);
	auto deliver = [&](Player* to, uint8_t peer) {
		if (blockable && to != player && to->hasBlocked(senderPid)) return;
		if (auto client = to->getProtocolGame()) {
			client->sendChatChannel(channel, senderPid, peer, flags, chatMsg);
		}
	};
	auto systemLineBack = [&](uint8_t peer, const std::string& text) {
		if (auto client = player->getProtocolGame()) {
			client->sendChatChannel(channel, CHAT_SYSTEM_PID, peer, 0, text);
		}
	};

	switch (channel) {
	case ChatChannel::LOCAL: {
		// Everyone who can see the speaker, the speaker included (the bubble
		// over our own head is drawn from this echo, not from the keystroke).
		// The flat player scan, so a listener whose aimed view reaches past the
		// viewport box is a candidate too; canSee decides. A listener exactly on
		// the box edge and ghost-mode players now hear it, as they already get
		// surgical and cosmetic events.
		std::vector<Player*> listeners;
		map.getPotentialSpectatorPlayers(player->getPosition(), listeners);
		for (Player* to : listeners) {
			if (to == player || to->canSee(player->getPosition())) {
				deliver(to, 0);
			}
		}
		break;
	}

	case ChatChannel::GLOBAL:
		for (const auto& [id, to] : players) {
			deliver(to, 0);
		}
		break;

	case ChatChannel::CLAN: {
		const Clan* clan = getClanById(player->clanId);
		if (!clan) {
			systemLineBack(0, "You are not in a clan.");
			break;
		}
		for (uint32_t memberGuid : clan->members) {
			if (Player* to = getPlayerByGUID(memberGuid)) {
				deliver(to, 0);
			}
		}
		break;
	}

	case ChatChannel::ADMIN:
		// Dropped silently for a non-admin: CHAT_ACCESS never offered them the
		// tab, so only a tampered client gets here.
		if (!player->hasGroupFlag(GroupFlag::StaffChat)) break;
		for (const auto& [id, to] : players) {
			if (to->hasGroupFlag(GroupFlag::StaffChat)) deliver(to, 0);
		}
		break;

	case ChatChannel::PRIVATE: {
		if (target == senderPid) break;
		Player* to = getPlayerByGUID(target);
		if (!to) {
			// Into the sender's tab for that peer, so the failure sits where
			// the message would have.
			systemLineBack(target, "That player is not online.");
			break;
		}
		if (blockable && to->hasBlocked(senderPid)) {
			systemLineBack(target, "That player is not accepting your messages.");
			break;
		}
		// Staff reach everyone here too (`blockable` is false for them).
		if (blockable && (to->privateMessages == PrivateMessagePolicy::NOBODY ||
		                  (to->privateMessages == PrivateMessagePolicy::CLAN && !sharesClanWith(to, senderPid)))) {
			systemLineBack(target, to->privateMessages == PrivateMessagePolicy::CLAN
			                           ? "That player only accepts private messages from their clan."
			                           : "That player is not accepting private messages.");
			break;
		}
		deliver(to, senderPid);
		deliver(player, target);
		break;
	}

	default:
		break;
	}
}

void Game::broadcastServerLog(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text, const Player* skip)
{
	NetworkMessage msg;
	ProtocolGame::buildServerLogMessage(kind, a, b, text, msg);
	for (const auto& [id, p] : players) {
		if (p == skip) continue;
		if (p->client) {
			p->client->writeToOutputBuffer(msg);
		}
	}
}

void Game::playerBlock(uint32_t playerId, uint8_t targetGuid, bool blocked)
{
	Player* player = getPlayerByID(playerId);
	if (!player || targetGuid == player->getGUID()) return;
	auto& list = player->blockedPlayers;
	if (!blocked) {
		const auto before = list.size();
		std::erase_if(list, [&](const Player::BlockedPlayer& b) { return b.guid == targetGuid; });
		if (list.size() == before) return;
		sendBlockedPlayers(player);
		if (Player* target = getPlayerByGUID(targetGuid)) {
			sendStatus(player, "You unblocked " + target->getName() + ".");
		}
		return;
	}
	Player* target = getPlayerByGUID(targetGuid);
	if (!target || player->hasBlocked(targetGuid)) return;
	if (target->hasGroupFlag(GroupFlag::StaffChat)) {
		sendStatus(player, "Staff cannot be blocked.", StatusKind::FAILURE);
		return;
	}
	// Every guid is below the player cap, so a list is bounded by it too; the
	// cap is only reached by blocking everyone online, one at a time.
	list.push_back({static_cast<uint8_t>(targetGuid), target->getAccountId()});
	sendBlockedPlayers(player);
	sendStatus(player, "You blocked " + target->getName() + ". Their messages no longer reach you.");
}

void Game::blocksOnArrival(Player* arriving)
{
	const uint32_t accountId = arriving->getAccountId();
	if (accountId == 0) return;
	for (const auto& [id, p] : players) {
		if (p == arriving) continue;
		bool changed = false;
		for (Player::BlockedPlayer& b : p->blockedPlayers) {
			if (b.accountId == accountId && b.guid == Player::BLOCKED_OFFLINE) {
				b.guid = static_cast<uint8_t>(arriving->getGUID());
				changed = true;
			}
		}
		if (changed) sendBlockedPlayers(p);
	}
}

void Game::blocksOnDeparture(Player* leaving)
{
	const uint32_t guid = leaving->getGUID();
	for (const auto& [id, p] : players) {
		if (p == leaving) continue;
		auto& list = p->blockedPlayers;
		const auto before = list.size();
		bool changed = false;
		// A guest is gone for good (the next login may get the slot); an
		// account waits to be recognised under its next guid.
		std::erase_if(list, [&](const Player::BlockedPlayer& b) { return b.guid == guid && b.accountId == 0; });
		for (Player::BlockedPlayer& b : list) {
			if (b.guid == guid) {
				b.guid = Player::BLOCKED_OFFLINE;
				changed = true;
			}
		}
		if (changed || list.size() != before) sendBlockedPlayers(p);
	}
}

void Game::sendBlockedPlayers(Player* player)
{
	if (!player->client) return;
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::BLOCKED_PLAYERS));
	uint8_t count = 0;
	for (const Player::BlockedPlayer& b : player->blockedPlayers) {
		if (b.guid != Player::BLOCKED_OFFLINE) ++count;
	}
	msg.addByte(count);
	for (const Player::BlockedPlayer& b : player->blockedPlayers) {
		if (b.guid != Player::BLOCKED_OFFLINE) msg.addByte(b.guid);
	}
	player->client->writeToOutputBuffer(msg);
}

























// Never rebuilds inline -- see the PendingRegen comment in game.h for why
// stacked commands must not run three freezes back to back.
void Game::queueRegeneration(uint32_t seed, bool preservePlayerBuilds, uint32_t adminGuid)
{
	Player* admin = getPlayerByGUID(adminGuid);

	if (regenQueue.size() >= REGEN_QUEUE_MAX) {
		adminReply(admin, fmt::format(
			"{} rebuilds are already queued; this one was dropped.", regenQueue.size()));
		return;
	}

	regenQueue.push_back({ seed, preservePlayerBuilds, adminGuid });

	if (regenRunning) {
		adminReply(admin, fmt::format(
			"Queued seed {} -- it starts once the world being built is on every client "
			"({} waiting).", seed, regenQueue.size()));
		return;
	}

	// Said BEFORE the work, not after. It freezes the tick for as long as it
	// takes, and an admin who gets no reply assumes the command was eaten.
	adminReply(admin, fmt::format("Rebuilding the world from seed {} ({} player builds). Hold on...",
		seed, preservePlayerBuilds ? "keeping" : "bulldozing"));

	runNextRegeneration();
}

std::string Game::recentreSpawnIfOutside()
{
	// One tile of clearance from every edge, which is the same margin
	// isSpawnPositionValid demands: a creature centred closer than that has its
	// 3x3 neighbourhood hanging off the map and every movement attempt from
	// there is rejected.
	const int32_t minOk = TILE_SIZE;
	const int32_t maxOkX = MapSize::widthUnits() - TILE_SIZE;
	const int32_t maxOkY = MapSize::heightUnits() - TILE_SIZE;

	if (spawnCenterX >= minOk && spawnCenterX < maxOkX &&
	    spawnCenterY >= minOk && spawnCenterY < maxOkY) {
		return {};
	}

	const int32_t oldX = spawnCenterX;
	const int32_t oldY = spawnCenterY;

	// The tile CENTRE of the middle tile, not the arithmetic middle of the map.
	// Objects sit on tile centres, so a point half a tile off one is exactly
	// equidistant from four of them -- the hardest spot on the map for a
	// clearance test to accept, and the reason findSpawnPosition's own fallback
	// snaps to centres.
	spawnCenterX = (MapSize::tilesX() / 2) * TILE_SIZE + (TILE_SIZE / 2);
	spawnCenterY = (MapSize::tilesY() / 2) * TILE_SIZE + (TILE_SIZE / 2);

	return fmt::format("Spawn point ({},{}) was outside a {}x{} tile map; moved to the "
		"middle at ({},{}). Update spawnX / spawnY in config.lua to make it stick.",
		oldX, oldY, MapSize::tilesX(), MapSize::tilesY(), spawnCenterX, spawnCenterY);
}

std::string Game::reportMapIdBudget() const
{
	const EntityIdPool& pool = map.getEntityIdPool();
	const uint32_t usable = pool.capacity() > 0 ? pool.capacity() - 1 : 0;

	// These are the numbers an admin can move from a text file. None of them
	// becomes a reserve; they are printed so the consequence of an edit is
	// visible at boot -- or at the moment of a resize -- instead of at 2am.
	const uint32_t tilesWide = static_cast<uint32_t>(MapSize::tilesX());
	const uint32_t tilesHigh = static_cast<uint32_t>(MapSize::tilesY());
	const uint32_t buildCeiling = maxStaticObjectsForMap(tilesWide, tilesHigh);
	const uint32_t resourceCeiling = g_resources.totalUnitsMax();

	fmt::print(">>   demand: map {}x{} tiles -> {} objects if fully built; resources.xml "
		"allows {} alive\n", tilesWide, tilesHigh, buildCeiling, resourceCeiling);

	// A resource cannot share a tile with a floor or a colliding object, so the
	// two ceilings are alternatives rather than addends -- the static world as a
	// whole is bounded by the tile count. Compare the larger.
	const uint32_t staticCeiling = std::max(buildCeiling, resourceCeiling);
	if (staticCeiling <= usable) {
		return {};
	}

	// Reaching this now means the id space was CONFIGURED too small, not that
	// the protocol ran out: clientMaxEntityId = 0 sizes the pool from the tile
	// count, and the 24-bit wire ceiling covers a fully built map far larger
	// than uint16 positions can address. So the advice is the config knob.
	fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold,
		">>   [WARNING] a fully built-out map needs {} ids but only {} exist. Building "
		"will stop before the map is full. Set clientMaxEntityId = 0 in config.lua to "
		"size the pool from the map automatically (the wire ceiling is {} ids).\n",
		staticCeiling, usable, CLIENT_ENTITY_ID_SPACE_MAX);

	return fmt::format("WARNING: a fully built {}x{} map needs {} entity ids and only {} "
		"exist, so building will stop before the map is full. clientMaxEntityId = 0 "
		"sizes the pool from the map.", tilesWide, tilesHigh, staticCeiling, usable);
}

// Never rebuilds inline either -- a resize is a regeneration and rides the same
// queue for the same reason. See queueRegeneration.
void Game::queueResize(int32_t tilesX, int32_t tilesY, bool preservePlayerBuilds, uint32_t adminGuid)
{
	Player* admin = getPlayerByGUID(adminGuid);

	if (regenQueue.size() >= REGEN_QUEUE_MAX) {
		adminReply(admin, fmt::format(
			"{} rebuilds are already queued; this resize was dropped.", regenQueue.size()));
		return;
	}

	// The seed is kept. A resize changes the world because the bounds it is
	// drawn in changed, not because it rolled a different one -- so the same
	// seed at the same size still reproduces the same map, and an admin who
	// resizes and resizes back gets their world returned to them.
	regenQueue.push_back({ getWorldSeed(), preservePlayerBuilds, adminGuid, tilesX, tilesY });

	if (regenRunning) {
		adminReply(admin, fmt::format(
			"Queued resize to {}x{} tiles -- it starts once the world being built is on "
			"every client ({} waiting).", tilesX, tilesY, regenQueue.size()));
		return;
	}

	adminReply(admin, fmt::format(
		"Resizing the map to {}x{} tiles ({}x{} units) and rebuilding the world in it "
		"({} player builds). Hold on...",
		tilesX, tilesY, tilesX * TILE_SIZE, tilesY * TILE_SIZE,
		preservePlayerBuilds ? "keeping" : "bulldozing"));

	runNextRegeneration();
}

// Everything the new bounds have left outside the map.
//
// Split by what the thing IS, because the right answer differs:
//
//   - Creatures are MOVED, never deleted. A player must not lose their
//     character to an admin command, and deleting a creature here would also
//     mean reasoning about the lifetime rule (map.removeThing releases the last
//     reference and deletes it) in the middle of a sweep over the map.
//     findSpawnPosition rather than a raw clamp: clamping wedges them against
//     the boundary, possibly inside an object, which is the one spot every
//     movement attempt is rejected from.
//   - Everything else is DELETED. There is no honest place to move a building
//     to, and loot moved to an arbitrary tile is worse than loot that is gone.
//
// Removals are not broadcast: the caller replaces every client's entity table
// outright straight afterwards, which is both correct where a per-entity diff
// is not and far cheaper. Same argument as regenerateWorld.
uint32_t Game::evictOutOfBounds()
{
	const int32_t maxX = MapSize::widthUnits();
	const int32_t maxY = MapSize::heightUnits();

	const auto outside = [maxX, maxY](const Position& p) {
		return static_cast<int32_t>(p.x) >= maxX || static_cast<int32_t>(p.y) >= maxY;
	};

	// Creatures first: they may be standing on ground a doomed object occupies,
	// and moving them before the sweep keeps the two decisions independent.
	//
	// Collected by id rather than acted on inline -- placeThing mutates the tile
	// buckets this is walking.
	std::vector<uint32_t> strandedCreatures;
	for (Thing* thing : map.getThings()) {
		if (thing->getCreature() && outside(thing->getPosition())) {
			strandedCreatures.push_back(thing->getID());
		}
	}
	for (const uint32_t id : strandedCreatures) {
		Thing* thing = map.getThingByID(id);
		if (!thing) continue;
		if (Creature* creature = thing->getCreature()) {
			placeThing(creature, findSpawnPosition(creature));
		}
	}

	std::vector<uint32_t> victims;
	for (Thing* thing : map.getThings()) {
		if (thing->getCreature()) continue;
		if (outside(thing->getPosition())) {
			victims.push_back(thing->getID());
		}
	}

	uint32_t removed = 0;
	std::vector<Thing*> doomed;
	doomed.reserve(victims.size());
	for (const uint32_t id : victims) {
		if (Thing* thing = map.getThingByID(id)) {
			removeWorldThing(thing, /*broadcastRemoval=*/false, &doomed);
			++removed;
		}
	}
	// One delete event for the whole sweep rather than one per entity: at ten
	// thousand entities that burst costs more than the work itself, and it lands
	// on the scheduler thread where no tick profiling can see it.
	deferBulkDelete(std::move(doomed));

	return removed;
}

void Game::runNextRegeneration()
{
	if (regenQueue.empty()) {
		regenRunning = false;
		return;
	}

	regenRunning = true;
	const PendingRegen job = regenQueue.front();
	regenQueue.pop_front();

	const bool isResize = (job.resizeTilesX > 0 && job.resizeTilesY > 0);
	uint32_t evicted = 0;
	std::string sizeNote;

	if (isResize) {
		std::string error;
		if (!MapSize::apply(job.resizeTilesX, job.resizeTilesY, error)) {
			// Validated at parse time too; this is the guard for a resize that
			// sat in the queue while something else moved the limits.
			adminReply(getPlayerByGUID(job.adminGuid), error);
			g_scheduler.addEvent(createSchedulerTask(REGEN_SETTLE_MS,
				[this]() { this->runNextRegeneration(); }));
			return;
		}

		// Before anything is moved: a spawn point left outside the new bounds
		// would clamp every arriving player into the corner tile, which is the
		// worst spot on the map to stand and the hardest for a clearance test to
		// accept. Recentre instead, and say so -- silently moving where players
		// appear is not something to leave an admin to discover.
		sizeNote = recentreSpawnIfOutside();

		evicted = evictOutOfBounds();
	}

	const WorldRebuildReport report = regenerateWorld(job.seed, job.preservePlayerBuilds);

	if (isResize) {
		// The size has to reach the client BEFORE the entity records that index
		// into structures sized by it: client.js allocates a tile-indexed
		// `matrix` and wall/floor autotiling writes straight into
		// matrix[i][j]. regenerateWorld has already armed the login flag, so the
		// next visibility tick is what flushes the new world -- sending here is
		// comfortably ahead of it.
		for (const auto& [id, player] : players) {
			if (player && player->client) {
				player->client->sendMapSize();
			}
		}
	}

	std::string reply = isResize
		? fmt::format("Map is now {}x{} tiles ({}x{} units). World rebuilt from seed {} "
			"(fingerprint {:08x}, {}ms). Put mapTilesX = {} / mapTilesY = {} in config.lua "
			"to boot on this size.",
			MapSize::tilesX(), MapSize::tilesY(), MapSize::widthUnits(), MapSize::heightUnits(),
			job.seed, report.fingerprint, report.elapsedMs, MapSize::tilesX(), MapSize::tilesY())
		: fmt::format("World seed is now {} (fingerprint {:08x}, rebuilt in {}ms). Put seed = {} "
			"in config.lua to start on this map.",
			job.seed, report.fingerprint, report.elapsedMs, job.seed);

	if (report.respawnRestored) {
		reply += " Resource and structure respawn were off and have been restored to the "
		         "mode defaults; !respawn-resources=off / !respawn-structures=off to hold "
		         "this world still.";
	}

	if (!sizeNote.empty()) {
		reply += " " + sizeNote;
	}
	if (evicted != 0) {
		reply += fmt::format(" {} thing(s) outside the new bounds were removed.", evicted);
	}

	// Said out loud rather than left on the console. Preserved player builds and
	// imported maps compete for the same entity id space the new world needs, so
	// a short world is a normal outcome of !seed=<n>:keep on a built-up server --
	// and one an admin has no other way to notice until they walk into the gap.
	if (report.cameUpShort()) {
		reply += fmt::format(" WARNING: came up short -- structures {}/{}, resources {}/{}.",
			report.structuresPlaced, report.structuresWanted,
			report.resourcesSpawned, report.resourcesWanted);
		reply += report.outOfIds
			? " The entity id pool ran out; :wipe frees what player builds are holding."
			: " The map had no room left for the rest.";
	}

	// Re-resolved by GUID: the admin may have logged out during the rebuild,
	// and adminReply ignores a null player.
	adminReply(getPlayerByGUID(job.adminGuid), reply);

	// Scheduled unconditionally, even with an empty queue: the gap has to apply
	// to a command that arrives DURING it too, and this wake-up is what clears
	// regenRunning once nothing is left. Scheduler tasks land on the dispatcher,
	// so there is no thread hop to arrange.
	g_scheduler.addEvent(createSchedulerTask(REGEN_SETTLE_MS,
		[this]() { this->runNextRegeneration(); }));
}






















void Game::playerReceivePingBack(uint32_t playerId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) {
		return;
	}

	player->sendPingBack();
}

void Game::playerTurn(uint32_t playerId, uint8_t dir)
{
	Player* player = getPlayerByID(playerId);
	if (!player) {
		return;
	}

	// The idle timer resets either way: they are at the keyboard trying to turn,
	// which is what it measures. Only the turn itself is refused.
	player->resetIdleTime();
	if (player->cannot(CONTROL_NO_TURN)) {
		return;
	}
	internalCreatureTurn(player, dir);
}

bool Game::internalCreatureTurn(Creature* creature, uint8_t dir)
{
	if (creature->getRotation() == dir) {
		return false;
	}

	int32_t currentRot = static_cast<int32_t>(creature->getRotation());
	int32_t newRot = static_cast<int32_t>(dir);
	int32_t diff = std::abs(newRot - currentRot);
	if (diff > 128) diff = 256 - diff;

	if (diff < 3) {
		return false;
	}

	creature->setRotation(dir);
	return true;
}

void Game::playerMove(uint32_t playerId, uint8_t moveMask)
{
	Player* player = getPlayerByID(playerId);
	if (!player) {
		return;
	}

	player->resetIdleTime();
	player->setMoveMask(moveMask);
}

void Game::playerTakeLoot(uint32_t playerId, ClientEntityId lootId)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	// Resolved through the id pool rather than by OR-ing the loot prefix and
	// hoping. Every class draws from one id16 space now, so an id16 the client
	// sends is only loot if the pool says a Loot currently holds it -- and the
	// pool answers that in one array read.
	const uint32_t fullUid = map.fullIdForId16(lootId);
	Thing* thing = fullUid ? map.getThingByID(fullUid) : nullptr;

	if (!thing) {
		fmt::print("[Debug] Player {} tried to take lootId {:X}, but no live entity holds that id.\n",
			player->getName(), lootId);
		return;
	}

	Loot* loot = thing->getLoot();
	if (!loot) return;

	if (loot->isTaken()) {
		fmt::print("[Debug] Player {} tried to take loot {:X}, but it is already marked as taken.\n", player->getName(), fullUid);
		return;
	}

	if (player->getPosition().getDistanceX(loot->getPosition()) > LOOT_PICKUP_RANGE ||
		player->getPosition().getDistanceY(loot->getPosition()) > LOOT_PICKUP_RANGE) {
		fmt::print("[Debug] Player {} too far from loot {:X} (Dist: {}, {})\n", 
			player->getName(), fullUid, 
			player->getPosition().getDistanceX(loot->getPosition()),
			player->getPosition().getDistanceY(loot->getPosition()));
		return;
	}

	uint8_t added = player->inventory.addItem(loot->getItemIID(), loot->getCount(), loot->getState());
	if (added > 0) {
		if (const ItemData* taken = ItemManager::getInstance().getItemData(loot->getItemIID()))
			g_events.emit({EventType::Pickup, player, taken->key, added});
		if (added >= loot->getCount()) {
			loot->setTaken(true);
			loot->setGhost(true);
			loot->setAttackerPid(static_cast<uint8_t>(player->getGUID()));

			EntityUpdate flyUpdate;
			loot->buildUpdate(flyUpdate);
			broadcastSurgicalUpdate(flyUpdate, loot->getPosition());
		} else {
			loot->setCount(loot->getCount() - added);
			EntityUpdate update;
			loot->buildUpdate(update);
			broadcastSurgicalUpdate(update, loot->getPosition());
		}
	} else {
		player->sendFullInventory();
		fmt::print("[Debug] Player {} could not take loot {:X}: Inventory Full.\n", player->getName(), fullUid);
	}
}

Object* Game::findOldestRespawner(uint32_t ownerGuid)
{
	Object* oldest = nullptr;
	for (Thing* t : map.getThings()) {
		Object* obj = t->getObject();
		if (!obj || obj->isDestroyed || obj->getOwnerPid() != ownerGuid) continue;

		const ObjectData* od = obj->getData();
		if (!od || !od->respawner.enabled) continue;

		// Placement time, not UID: object UIDs wrap around after 0x5000FFFF
		if (!oldest || obj->placedTime < oldest->placedTime) {
			oldest = obj;
		}
	}
	return oldest;
}

// --- Growth stages ---

void Game::spawnStageLoot(const Position& origin, const StageLootSpawn& lootSpawn)
{
	const ItemData* idata = ItemManager::getInstance().getItemData(lootSpawn.iid);
	if (!idata || idata->lootId == 0) return;

	uint16_t total = lootSpawn.min;
	if (lootSpawn.max > lootSpawn.min) {
		total += static_cast<uint16_t>(rand() % (lootSpawn.max - lootSpawn.min + 1));
	}

	const uint8_t perStack = std::max<uint8_t>(1, std::min<uint8_t>(lootSpawn.perStack, idata->stack));
	std::vector<LootDrop> drops;
	while (total > 0) {
		const uint8_t count = static_cast<uint8_t>(std::min<uint16_t>(perStack, total));
		drops.push_back({ idata->lootId, lootSpawn.iid, count, ItemState::fresh(lootSpawn.iid) });
		total -= count;
	}
	dropLootBurst(origin, drops);
}

bool Game::tryHarvestObject(Object* obj)
{
	const ObjectData* od = obj->getData();
	if (!od || od->stages.empty()) return false;

	const ObjectStage* stage = od->getStage(obj->getSubtype());
	if (!stage || !stage->harvestable || stage->produce.iid == 0) return false;

	spawnStageLoot(obj->getPosition(), stage->produce);

	if (stage->postHarvestStage >= 0) {
		enterObjectStage(obj, od, static_cast<uint8_t>(stage->postHarvestStage));
	}
	return true;
}

void Game::enterObjectStage(Object* obj, const ObjectData* od, uint8_t stageId)
{
	const ObjectStage* stage = od->getStage(stageId);
	if (!stage) return;

	obj->stageElapsedMs = 0;
	obj->setSubtype(stageId);

	if (stage->spawnLoot.iid != 0) {
		spawnStageLoot(obj->getPosition(), stage->spawnLoot);
	}

	// A creature stage normally hatches at the END of its durationMs, driven by
	// updateObjectStages -- "twenty seconds in this stage, then it hatches". Only
	// a stage with no duration at all hatches on entry, matching the way
	// spawnResource/spawnObject below behave.
	if (!stage->spawnCreature.empty() && stage->durationMs == 0) {
		hatchStageCreatures(obj, *stage);
		return;
	}

	// Replacement actions consume the staged object silently (no destruction drops)
	if (!stage->spawnResource.empty() || !stage->spawnObject.empty()) {
		const Position pos = obj->getPosition();
		const std::string resourceKey = stage->spawnResource;
		const std::string objectKey = stage->spawnObject;
		obj->removeSilently();

		if (!resourceKey.empty()) {
			const ResourceData* rd = g_resources.getResourceData(resourceKey);
			if (rd && !rd->types.empty()) {
				// Random type and rotation, like naturally spawned resources
				uint16_t typeId = static_cast<uint16_t>(rand() % rd->types.size());
				Resource* res = g_resources.createResource(resourceKey, typeId, pos, static_cast<uint8_t>(rand() % 256));
				if (res) placeThing(res, pos);
			} else {
				fmt::print(">> [Stages Error] Unknown spawnResource key '{}'\n", resourceKey);
			}
		} else {
			Object* spawned = g_objects.createObject(objectKey, pos, 0);
			if (spawned) {
				placeThing(spawned, pos);
			} else {
				fmt::print(">> [Stages Error] Unknown spawnObject key '{}'\n", objectKey);
			}
		}
		return;
	}

	EntityUpdate update;
	obj->buildUpdate(update);
	broadcastSurgicalUpdate(update, obj->getPosition());
}

void Game::updateObjectStages(uint32_t elapsedMs)
{
	// Collect transitions first: entering a stage can replace or remove
	// objects, which mutates the thing list being iterated.
	std::vector<Object*> toAdvance;
	for (Thing* t : map.getThings()) {
		Object* obj = t->getObject();
		if (!obj || obj->isDestroyed) continue;

		const ObjectData* od = obj->getData();
		if (!od || od->stages.empty()) continue;

		const ObjectStage* stage = od->getStage(obj->getSubtype());
		if (!stage || stage->durationMs == 0) continue;
		// A final stage sits inert unless it hatches into a creature, which is a
		// transition like any other -- it just has no next stage to name, because
		// the object stops existing.
		if (stage->next < 0 && stage->spawnCreature.empty()) continue;

		obj->stageElapsedMs += elapsedMs;
		if (obj->stageElapsedMs >= stage->durationMs) {
			toAdvance.push_back(obj);
		}
	}

	for (Object* obj : toAdvance) {
		const ObjectData* od = obj->getData();
		const ObjectStage* stage = od ? od->getStage(obj->getSubtype()) : nullptr;
		if (!stage) continue;
		// Hatching wins over `next`: it consumes the object, so there is nothing
		// left to advance.
		if (!stage->spawnCreature.empty()) {
			hatchStageCreatures(obj, *stage);
		} else if (stage->next >= 0) {
			enterObjectStage(obj, od, static_cast<uint8_t>(stage->next));
		}
	}
}

Position Game::findResurrectionPosition(const Position& center, const Creature* creature)
{
	if (isSpawnPositionValid(center, creature, SpawnRule::Resurrection)) {
		return center;
	}

	const int32_t mapWidth = MapSize::widthUnits();
	const int32_t mapHeight = MapSize::heightUnits();

	for (int32_t dy = -1; dy <= 1; ++dy) {
		for (int32_t dx = -1; dx <= 1; ++dx) {
			if (dx == 0 && dy == 0) continue;

			const int32_t candX = static_cast<int32_t>(center.x) + dx * TILE_SIZE;
			const int32_t candY = static_cast<int32_t>(center.y) + dy * TILE_SIZE;
			if (candX < 0 || candY < 0 || candX >= mapWidth || candY >= mapHeight) continue;

			Position candidate(static_cast<uint16_t>(candX), static_cast<uint16_t>(candY));
			if (isSpawnPositionValid(candidate, creature, SpawnRule::Resurrection)) {
				return candidate;
			}
		}
	}

	return center; // worst case: on top of whatever is standing there
}

void Game::teleportPlayer(Player* player, const Position& newPos)
{
	const Position oldPos = player->getPosition();
	player->setPosition(newPos);

	const int32_t oldTileX = oldPos.x / TILE_SIZE, oldTileY = oldPos.y / TILE_SIZE;
	const int32_t newTileX = newPos.x / TILE_SIZE, newTileY = newPos.y / TILE_SIZE;
	if (oldTileX == newTileX && oldTileY == newTileY) {
		return;
	}

	if (Tile* oldTile = map.getTile(oldTileX, oldTileY)) {
		oldTile->removeThing(player);
		for (Thing* t : oldTile->getThings()) {
			if (Object* obj = t->getObject()) {
				obj->onCreatureLeave(player);
			}
		}
	}

	if (Tile* newTile = map.getTile(newTileX, newTileY)) {
		newTile->addThing(player);
		for (Thing* t : newTile->getThings()) {
			if (Object* obj = t->getObject()) {
				obj->onCreatureEnter(player);
			}
		}
	}
}

bool Game::tryResurrectPlayer(Player* player)
{
	Object* respawner = findOldestRespawner(player->getGUID());
	if (!respawner) {
		return false;
	}

	const ObjectData* od = respawner->getData();
	if (!od) {
		return false;
	}
	const RespawnerData respawnData = od->respawner;

	// 1. Stop ongoing interactions; a running hand-craft refunds its
	//    ingredients as loot at the death position.
	playerCancelCraft(player->getID());
	if (player->getOpenedInteractionId() != 0) {
		playerCloseContainer(player->getID());
	}
	player->cancelAction();
	player->cancelReload();
	player->cancelEquipping();

	// 2. Drop the whole inventory where the player was "killed" and empty the hands
	player->inventory.dropAllOnDeath();
	player->completeEquip(0, 0, Player::EquipmentType::WEAPON);
	player->completeEquip(0, 0, Player::EquipmentType::WEARABLE);

	// 3. Consume the respawner silently (no destruction drops), then move in
	const Position respawnCenter = respawner->getPosition();
	respawner->removeSilently();

	const Position spawnPos = findResurrectionPosition(respawnCenter, player);
	teleportPlayer(player, spawnPos);

	// 4. Apply configured gauges and granted items
	player->applyResurrection(respawnData);
	for (const RespawnerItem& grant : respawnData.items) {
		player->inventory.addItem(grant.iid, grant.count);
	}

	// 5. Visible feedback at the destination. The player is the subject: a
	// resurrection moves them, so do not depend on the tile index having caught
	// up with the new position.
	broadcastPlayerHeal(static_cast<uint8_t>(player->getGUID()), spawnPos, player);
	return true;
}

void Game::pruneGuestRewards()
{
	const uint64_t now = OTSYS_TIME();
	const uint64_t expiry = static_cast<uint64_t>(KitManager::getInstance().getDeathRewardExpiryMinutes()) * 60000;
	if (expiry) std::erase_if(pendingKitRewardByToken, [now, expiry](const auto& entry) { return now - entry.second.deathTimeMs >= expiry; });
}

void Game::recordDeathForKit(const std::string& token, uint32_t level)
{
	// Tokens are opaque client-generated identifiers, not lowercased like
	// nicknames: they're not meant to be human-typed/compared case-insensitively.
	pruneGuestRewards();
	if (!pendingKitRewardByToken.contains(token) && pendingKitRewardByToken.size() >= MAX_PENDING_GUEST_REWARDS) {
		auto oldest = std::min_element(pendingKitRewardByToken.begin(), pendingKitRewardByToken.end(), [](const auto& a, const auto& b) { return a.second.deathTimeMs < b.second.deathTimeMs; });
		pendingKitRewardByToken.erase(oldest);
	}
	pendingKitRewardByToken[token] = PendingKitReward{ level, static_cast<uint64_t>(OTSYS_TIME()) };
	if (tokensWithPriorDeath.size() < MAX_GUEST_DEATH_HISTORY) tokensWithPriorDeath.insert(token); // permanent: this token graduates out of the fresh-session kit forever
}

uint32_t Game::consumePendingKitDeathLevel(const std::string& token)
{
	auto it = pendingKitRewardByToken.find(token);
	if (it == pendingKitRewardByToken.end()) {
		return 0;
	}

	const PendingKitReward reward = it->second;
	pendingKitRewardByToken.erase(it); // one-time: consumed (or discarded) by the very next fresh login under this token

	const uint32_t expiryMinutes = KitManager::getInstance().getDeathRewardExpiryMinutes();
	if (expiryMinutes > 0) {
		const uint64_t expiryMs = static_cast<uint64_t>(expiryMinutes) * 60ULL * 1000ULL;
		const uint64_t elapsedMs = static_cast<uint64_t>(OTSYS_TIME()) - reward.deathTimeMs;
		if (elapsedMs > expiryMs) {
			return 0; // reward window elapsed; falls back to the base kit
		}
	}

	return reward.level;
}

void Game::grantStartingKit(Player* player)
{
	const std::string& token = player->getToken();
	// Bounded guest-only history. At capacity, do not restore fresh-kit
	// eligibility by forgetting old markers. Accounts can use durable history.
	const bool everDied = tokensWithPriorDeath.contains(token) || tokensWithPriorDeath.size() >= MAX_GUEST_DEATH_HISTORY;
	const uint32_t deathLevel = consumePendingKitDeathLevel(token);

	// A token that has never died before always gets the fresh-session kit
	// (if one is defined), regardless of the level lookup below — this is
	// separate from "died before but the reward already expired", which
	// still falls through to the level-based kit (starting at level 0).
	const KitData* kit = everDied ? nullptr : KitManager::getInstance().getFreshKit();
	const bool usedFreshKit = (kit != nullptr);
	uint32_t startLevel = usedFreshKit ? kit->startLevel : 0;
	if (!kit) {
		// The kit's `level` IS the death level: the table maps death level ->
		// reward directly, so the halving that used to happen here (which made
		// the whole table resolve at twice the level it reads) is gone.
		const KitAward award = KitManager::getInstance().getAwardForDeathLevel(deathLevel);
		kit = award.kit;
		startLevel = award.startLevel;
	}

	fmt::print(">> [Kit] grantStartingKit for '{}': everDied={} deathLevel={} -> {}\n",
		player->getName(), everDied, usedFreshKit ? -1 : static_cast<int32_t>(deathLevel),
		kit ? fmt::format("kit level={} startLevel={} items={}", kit->level, startLevel, kit->items.size()) : std::string("NO KIT FOUND"));
	if (!kit) {
		return;
	}

	startLevel = std::min(startLevel, PLAYER_MAX_LEVEL);
	if (startLevel > player->getLevel()) {
		player->grantStartingLevel(startLevel);
	}
	for (const KitItem& item : kit->items) {
		// A kit creates its items; its ammo= only says how full they start.
		ItemState state = ItemState::fresh(item.iid);
		if (item.ammo >= 0) state.ammo = static_cast<uint8_t>(item.ammo);
		player->addInventoryItem(item.iid, item.count, state);
	}
}

// How many tiles beyond its base tile an object's footprint reaches per axis.
// Objects wider or taller than one tile (smelter, tesla, research_bench: 260
// or 280 on one axis) are centered on their tile and spill into the neighbors.
void getFootprintTileReach(const ObjectData* od, uint8_t rotation, int32_t& reachX, int32_t& reachY)
{
	int32_t w = od->width;
	int32_t h = od->height;
	if ((rotation & 0x01) != 0) {
		std::swap(w, h);
	}
	reachX = w > TILE_SIZE ? (w - TILE_SIZE + 2 * TILE_SIZE - 1) / (2 * TILE_SIZE) : 0;
	reachY = h > TILE_SIZE ? (h - TILE_SIZE + 2 * TILE_SIZE - 1) / (2 * TILE_SIZE) : 0;
}

// The tile an open door's panel occupies: big doors (blocksProjectiles) swing
// diagonally to the corner, low doors swing orthogonally to the front tile.
static Position getDoorSwingPosition(const Object* door, const ObjectData* od)
{
	static constexpr int32_t bigJ[4] = {-1, -1, 1, 1};
	static constexpr int32_t bigI[4] = {1, -1, -1, 1};
	static constexpr int32_t lowJ[4] = {0, -1, 0, 1};
	static constexpr int32_t lowI[4] = {1, 0, -1, 0};

	const uint8_t rot = door->getRotation() & 0x03;
	const int32_t* jMove = od->blocksProjectiles ? bigJ : lowJ;
	const int32_t* iMove = od->blocksProjectiles ? bigI : lowI;
	return Position(door->getPosition().x + jMove[rot] * TILE_SIZE, door->getPosition().y + iMove[rot] * TILE_SIZE);
}

bool Game::isTileClear(const Position& targetPos, bool isPlacingFloor, uint32_t ignoreOwnerPid, uint32_t ignorePlayerId, Object* ignoreObj, bool isDoorSwing, bool isResourceSpawn, bool ignoreTransient)
{
	int32_t cx = targetPos.x / TILE_SIZE;
	int32_t cy = targetPos.y / TILE_SIZE;

	for (int32_t dx = -1; dx <= 1; ++dx) {
		for (int32_t dy = -1; dy <= 1; ++dy) {
			if (cx + dx < 0 || cy + dy < 0) continue;

			Tile* tile = map.getTile(static_cast<uint16_t>(cx + dx), static_cast<uint16_t>(cy + dy));
			if (!tile) continue;

			for (Thing* thing : tile->getThings()) {
				if (ignoreObj && thing == ignoreObj) continue;

				if (Object* existingObj = thing->getCreature() ? nullptr : thing->getObject()) {
					const ObjectData* existingData = existingObj->getData();
					if (!existingData) continue;

					// If an existing open door's panel swings into targetPos, that tile is occupied
					if (existingData->interaction == InteractionKind::Door && existingObj->isDoorOpen) {
						if (getDoorSwingPosition(existingObj, existingData) == targetPos) {
							if (isDoorSwing || !isPlacingFloor) {
								return false;
							}
						}
					}

					if (isResourceSpawn && (existingData->isFloor || existingObj->hasCollision())) {
						float objectDx = std::abs(static_cast<float>(existingObj->getPosition().x - targetPos.x));
						float objectDy = std::abs(static_cast<float>(existingObj->getPosition().y - targetPos.y));
						float dist = std::max(objectDx, objectDy);
						float radius = existingObj->getCollisionRadius();
						if (radius > 0) {
							if (dist < radius + 10.0f) return false;
						} else {
							if (dist < TILE_SIZE - 5.0f) return false;
						}
					}

					// Static objects block every tile their footprint covers:
					// multi-tile objects (smelter, tesla, ...) also occupy the
					// neighboring tiles, not just the one under their center
					int32_t reachX = 0, reachY = 0;
					getFootprintTileReach(existingData, existingObj->getRotation(), reachX, reachY);
					if (existingObj->getPosition().getDistanceX(targetPos) <= reachX * TILE_SIZE &&
						existingObj->getPosition().getDistanceY(targetPos) <= reachY * TILE_SIZE) {
						if (isDoorSwing) {
							if (existingData->isFloor) continue; // Floors don't block doors
							
							if (existingData->interaction == InteractionKind::Door) {
								if (!existingObj->isDoorStateOpen()) return false;
								continue;
							}

							return false; // Any other non-floor object (planted trees, bombs, traps, walls, etc.) blocks the door
						}


						bool isOwner = false;
						if (ignoreOwnerPid != 0) {
							if (existingObj->getOwnerPid() == ignoreOwnerPid) {
								isOwner = true;
							} else if (existingObj->getOwnerPid() != 0) {
								isOwner = sharesClanWith(getPlayerByGUID(ignoreOwnerPid), existingObj->getOwnerPid());
							}
						}

						if (isPlacingFloor) {
							// Placing a floor:
							// 1. Cannot place a floor on top of another floor
							if (existingData->isFloor) {
								return false;
							}
							// 2. Cannot place a floor on top of a plant
							if (existingData->category == ObjectCategory::Plant) {
								return false;
							}
							// 3. Cannot place a floor under a non-floor object owned by someone else
							if (!isOwner && existingObj->getOwnerPid() != 0) {
								return false;
							}
						} else {
							// Placing a non-floor object:
							// 1. Cannot place a non-floor object on top of another non-floor object
							if (!existingData->isFloor) {
								return false;
							}
							// 2. Cannot place a non-floor object on top of a road floor
							if (existingData->category == ObjectCategory::Road) {
								return false;
							}
							// 3. Cannot place a non-floor object on a floor owned by someone else
							if (!isOwner && existingObj->getOwnerPid() != 0) {
								return false;
							}
						}
					}
					continue;
				}

				// Everything that is not the static world: creatures and loot.
				// World generation drops them from the question entirely so
				// that where it puts things depends on the seed and nothing
				// else; it asks about them separately, once the layout is
				// fixed. Resources are not transient and still block here.
				if (ignoreTransient && (thing->getCreature() || thing->getLoot())) {
					continue;
				}

				// Non-objects (loot, players, creatures) block if too close (radius 60 to safely cover the tile and overlaps)
				if (thing->getPosition().getDistanceX(targetPos) < 60 &&
					thing->getPosition().getDistanceY(targetPos) < 60) {

					if (ignorePlayerId != 0) {
						Creature* c = thing->getCreature();
						if (Player* p = c ? c->getPlayer() : nullptr) {
							if (p->getGUID() == ignorePlayerId) {
								continue; // Allow this specific player to overlap
							}
						}
					}

					return false;
				}
			}
		}
	}

	return true;
}

namespace {
	// Creature collision radius (Creature::getCollisionRadius) plus a margin, so
	// a fresh creature is not born flush against whatever is next to it.
	constexpr int32_t SPAWN_PLAYER_RADIUS = 32;
	constexpr int32_t SPAWN_MARGIN = 8;
	constexpr int32_t SPAWN_CLEARANCE = SPAWN_PLAYER_RADIUS + SPAWN_MARGIN;

	// Two creatures may not spawn within this of each other: the sum of both
	// collision radii, which is what "not overlapping" actually requires.
	constexpr int32_t SPAWN_CREATURE_CLEARANCE = 2 * SPAWN_PLAYER_RADIUS + SPAWN_MARGIN;

	// Random darts first (cheap, and keeps the spread uniform), then a widening
	// ring walk so a full or awkward map still yields a legal spot instead of
	// stacking everyone on the configured centre.
	constexpr int32_t SPAWN_RANDOM_ATTEMPTS = 60;
	constexpr int32_t SPAWN_FALLBACK_RINGS = 24;

	// Half the object's footprint on each axis -- i.e. how far its body actually
	// reaches from its centre.
	//
	// NOT getFootprintTileReach: that counts only the tiles BEYOND the base
	// tile, so it is 0 for everything 100 wide or under and one tile short on
	// larger objects. Used as a block distance it omitted the object's own body
	// entirely, which is why a player could spawn inside a workbench: the block
	// came out at 40 units when a 100-wide object needs 50 + the creature's 32.
	void getObjectHalfExtent(const ObjectData* od, uint8_t rotation, int32_t& halfX, int32_t& halfY)
	{
		// Circular objects carry a radius instead of a footprint rectangle
		// (Object::getCollisionRect bails when radius > 0).
		if (od->radius > 0) {
			halfX = halfY = static_cast<int32_t>(od->radius);
			return;
		}

		int32_t w = od->width;
		int32_t h = od->height;
		if ((rotation & 0x01) != 0) { // same swap rule as getFootprintTileReach
			std::swap(w, h);
		}
		halfX = w / 2;
		halfY = h / 2;
	}
} // namespace

// May a creature materialise here? See the SpawnRule comment in game.h for how
// the two strictness levels differ.
//
// Much cheaper than isTileClear, whose owner/clan checks, door-swing handling
// and placement-vs-floor rules are about *building* placement and have no
// meaning for a creature spawn.
bool Game::isSpawnPositionValid(const Position& pos, const Creature* self, SpawnRule rule) const
{
	const int32_t mapWidth = MapSize::widthUnits();
	const int32_t mapHeight = MapSize::heightUnits();

	// Keep a tile clear of the map edge, otherwise the player spawns wedged
	// against the boundary and every movement attempt is rejected.
	if (pos.x < TILE_SIZE || pos.y < TILE_SIZE ||
		static_cast<int32_t>(pos.x) >= mapWidth - TILE_SIZE ||
		static_cast<int32_t>(pos.y) >= mapHeight - TILE_SIZE) {
		return false;
	}

	const bool strict = (rule == SpawnRule::Strict);
	const int32_t cx = pos.x / TILE_SIZE;
	const int32_t cy = pos.y / TILE_SIZE;

	// The 3x3 neighbourhood, not just the tile under pos: an entity centred one
	// tile away can still overlap this position through its collision radius or
	// a multi-tile footprint.
	for (int32_t dx = -1; dx <= 1; ++dx) {
		for (int32_t dy = -1; dy <= 1; ++dy) {
			const int32_t tx = cx + dx;
			const int32_t ty = cy + dy;
			if (tx < 0 || ty < 0) {
				continue;
			}

			// Map::placeThing files a Thing under exactly one tile -- the one
			// holding its centre -- so "something is on my own tile" and
			// "something centred next door reaches into my tile" are two
			// different questions, answered separately below.
			const bool ownTile = (dx == 0 && dy == 0);

			// findTile, not getTile: getTile allocates a permanent empty Tile
			// for any coordinate it is asked about, so probing candidates with
			// it would leak a Tile per rejected spot and inflate the entity
			// count that every visibility scan then pays for.
			const Tile* tile = map.findTile(tx, ty);
			if (!tile) {
				continue;
			}

			for (const Thing* thing : tile->getThings()) {
				if (thing == self) {
					continue;
				}

				const int32_t distX = thing->getPosition().getDistanceX(pos);
				const int32_t distY = thing->getPosition().getDistanceY(pos);

				if (const Object* obj = thing->getObject()) {
					const ObjectData* od = obj->getData();
					if (!od) {
						continue;
					}

					// A resurrection puts the player back inside their own
					// base, so walkable geometry -- floors, roads, an open
					// automatic door -- must not block it. A strict spawn
					// refuses them: they are all player-built, so appearing on
					// one means materialising in somebody's base.
					if (!strict && !obj->hasCollision()) {
						continue;
					}

					// An object IS its tile, not a point with a radius: its
					// centre can be up to ~70 units from a position that is
					// still standing on it. Rejecting the whole tile on
					// presence -- rather than by distance -- is the only thing
					// that actually keeps a creature off it.
					if (ownTile) {
						return false;
					}

					// Centred on a neighbouring tile: only its body can reach
					// in, so this one is a real distance test.
					int32_t halfX = 0, halfY = 0;
					getObjectHalfExtent(od, obj->getRotation(), halfX, halfY);
					if (distX <= halfX + SPAWN_CLEARANCE && distY <= halfY + SPAWN_CLEARANCE) {
						return false;
					}
					continue;
				}

				if (thing->getLoot()) {
					// Walkable, but spawning on someone's dropped stack is both
					// ugly and a free pickup. Never a reason to refuse a
					// resurrection, though -- and with lootDespawnSeconds = 0 a
					// base accumulates enough of it to matter.
					if (!strict) {
						continue;
					}
					if (distX <= SPAWN_CLEARANCE && distY <= SPAWN_CLEARANCE) {
						return false;
					}
					continue;
				}

				if (const Resource* res = thing->getResource()) {
					// Non-colliding resources (ground scatter) are fine to
					// stand on; trees and rocks are not.
					if (!res->hasCollision()) {
						continue;
					}
					const int32_t radius = static_cast<int32_t>(res->getCollisionRadius());
					const int32_t block = (radius > 0 ? radius : TILE_SIZE / 2) + SPAWN_CLEARANCE;
					if (distX <= block && distY <= block) {
						return false;
					}
					continue;
				}

				if (const Creature* creature = thing->getCreature()) {
					// Players in ghoul form report no collision and can be
					// spawned through. Agents DO collide (Agent::hasCollision
					// follows agents.xml), so the night spawner is held off
					// anything already standing here -- which is what stops a
					// pack materialising inside itself.
					if (!creature->hasCollision()) {
						continue;
					}
					if (distX <= SPAWN_CREATURE_CLEARANCE && distY <= SPAWN_CREATURE_CLEARANCE) {
						return false;
					}
					continue;
				}
			}
		}
	}

	return true;
}

// Pick a legal spawn position honouring spawnX / spawnY / spawnSpread.
//
// Always returns a Position, because the caller has no useful way to recover
// from "nowhere to stand" -- refusing the login over it would be worse than
// spawning slightly too close to something.
Position Game::findSpawnPosition(const Creature* creature)
{
	const int32_t spread = getNumber(ConfigManager::SPAWN_SPREAD);
	const Position center = clampPositionToMap(getSpawnCenterX(), getSpawnCenterY());

	// spawnSpread = 0 is the historical single-point spawn. Validate it anyway,
	// so that repeated logins onto an occupied point fan out instead of
	// stacking players on top of each other.
	if (spread > 0) {
		for (int32_t attempt = 0; attempt < SPAWN_RANDOM_ATTEMPTS; ++attempt) {
			const int32_t x = static_cast<int32_t>(center.x) + (rand() % (2 * spread + 1)) - spread;
			const int32_t y = static_cast<int32_t>(center.y) + (rand() % (2 * spread + 1)) - spread;

			const Position candidate = clampPositionToMap(x, y);
			if (isSpawnPositionValid(candidate, creature)) {
				return candidate;
			}
		}
	} else if (isSpawnPositionValid(center, creature)) {
		return center;
	}

	// Random darts exhausted (or a single-point spawn that is occupied): walk
	// outward a tile at a time and take the first legal spot.
	//
	// Candidates are snapped to tile CENTRES rather than stepped by TILE_SIZE
	// from the configured point. Objects always sit on tile centres, so a
	// candidate offset by a whole tile from a point like the default (4000,
	// 4000) lands on a tile CORNER -- exactly 50 units from the centres of all
	// four tiles touching it, which is the worst possible spot to stand and the
	// hardest one for a clearance test to accept. A tile centre is the furthest
	// a creature can be from every neighbouring object at once.
	const int32_t centerTileX = center.x / TILE_SIZE;
	const int32_t centerTileY = center.y / TILE_SIZE;
	for (int32_t ring = 1; ring <= SPAWN_FALLBACK_RINGS; ++ring) {
		for (int32_t dy = -ring; dy <= ring; ++dy) {
			for (int32_t dx = -ring; dx <= ring; ++dx) {
				// Perimeter of this ring only; the interior was covered by the
				// smaller rings already.
				if (std::max(std::abs(dx), std::abs(dy)) != ring) {
					continue;
				}

				const Position candidate = tileCenterPosition(centerTileX + dx, centerTileY + dy);
				if (isSpawnPositionValid(candidate, creature)) {
					return candidate;
				}
			}
		}
	}

	// Nothing legal within reach. Place them on the configured point and let
	// the normal collision resolution sort it out.
	fmt::print("[SPAWN] WARNING: no legal spot within {} rings, stacking on centre\n",
		SPAWN_FALLBACK_RINGS);
	return center;
}

// True when the given door cannot move its panel to panelPos: the tile holds
// loot, a creature, or a blocking object, or another open door's panel.
bool Game::isDoorPanelPositionBlocked(Object* door, const Position& panelPos, uint32_t ignorePlayerId)
{
	if (!isTileClear(panelPos, false, 0, ignorePlayerId, door, true)) {
		return true;
	}

	// Cross-check against other currently open doors occupying this space
	std::vector<Thing*> specs;
	map.getSpectators(panelPos, specs);
	for (Thing* t : specs) {
		Object* otherObj = t->getObject();
		if (!otherObj || otherObj == door || !otherObj->isDoorOpen) continue;

		const ObjectData* otherOd = otherObj->getData();
		if (!otherOd || otherOd->interaction != InteractionKind::Door) continue;

		if (getDoorSwingPosition(otherObj, otherOd) == panelPos) {
			return true;
		}
	}

	return false;
}

void Game::playerPlaceObject(uint32_t playerId, uint8_t rotation, uint16_t i, uint16_t j)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	// Suppression: a condition can stop you building without stopping you
	// fighting or running. Checked first, so nothing is consumed or reserved on
	// the way to refusing.
	if (player->cannot(CONTROL_NO_BUILD)) return;

	uint16_t blueprintIid = player->getEquippedWeaponIID();
	if (blueprintIid == 0) return;

	const ItemData* idata = ItemManager::getInstance().getItemData(blueprintIid);
	if (!idata || idata->equipKey != "place_object") return;

	// `i` is the tile ROW, `j` the COLUMN, and both come straight off the wire.
	// Checked here, before the Position below narrows them: j = 700 gives 70050,
	// which wraps to 4514 inside a uint16 -- so a bounds test made after the cast
	// is testing a different tile than the one that was asked for.
	//
	// Without this a player standing near the edge could build outside the map
	// entirely. isTileClear cannot catch it: it asks whether anything is in the
	// way, and nothing ever is out there.
	if (!isTileInsideMap(j, i)) return;

	Position targetPos(j * TILE_SIZE + (TILE_SIZE / 2), i * TILE_SIZE + (TILE_SIZE / 2));

	if (player->getPosition().getDistanceX(targetPos) > INTERACTION_RANGE || 
		player->getPosition().getDistanceY(targetPos) > INTERACTION_RANGE) {
		return;
	}

	const ObjectData* placingData = g_objects.getObjectData(idata->key);
	if (!placingData) return;

	// Rate limit BEFORE any of the placement work, and before the blueprint is
	// spent. Silent: the client has no build cooldown to show, so a refused
	// click just does nothing -- which is the correct outcome for a rate limit,
	// and costs the player nothing because the item is consumed further down.
	if (!player->canPlaceObjectNow()) return;

	bool placingIsFloor = placingData->isFloor;
	bool placingIsPlant = (placingData->category == ObjectCategory::Plant);
	
	if (placingIsPlant) {
		// Existing logic hardcoded plant fails if any object is there (we handled this above but let's just use isTileClear)
		if (!isTileClear(targetPos, false, 0)) return; // 0 so it always fails on floors too
		if (scenario::g_scenarioRuntime.permission(scenario::PermissionKind::Build, targetPos) == false) return;
	} else {
		// Multi-tile objects must have every tile of their footprint clear,
		// not just the tile under their center
		int32_t reachX = 0, reachY = 0;
		getFootprintTileReach(placingData, rotation, reachX, reachY);
		for (int32_t tx = -reachX; tx <= reachX; ++tx) {
			for (int32_t ty = -reachY; ty <= reachY; ++ty) {
				int32_t px = static_cast<int32_t>(targetPos.x) + tx * TILE_SIZE;
				int32_t py = static_cast<int32_t>(targetPos.y) + ty * TILE_SIZE;
				// Both ends. This used to test the near edge only, so a
				// multi-tile object placed on the last legal tile could still
				// hang its far half off the map.
				if (!isPositionInsideMap(px, py)) {
					return; // footprint would hang off the map
				}
				if (!isTileClear(Position(static_cast<uint16_t>(px), static_cast<uint16_t>(py)), placingIsFloor, player->getGUID())) {
					return;
				}
				// A scenario region may forbid building on any tile of the footprint.
				if (scenario::g_scenarioRuntime.permission(scenario::PermissionKind::Build,
				        Position(static_cast<uint16_t>(px), static_cast<uint16_t>(py))) == false) {
					return;
				}
			}
		}
	}

	// Consume from the equipped stack first so placing the last blueprint of
	// the held stack correctly auto-unequips it; fall back to any stack of the
	// same item.
	int8_t slot = player->inventory.findItemByUidSlot(player->getEquippedWeaponUID(), blueprintIid);
	if (slot == -1) {
		for (uint8_t s = 0; s < player->inventory.getSlotCount(); ++s) {
			Item* it = player->inventory.getItem(s);
			if (it && it->getIID() == blueprintIid) {
				slot = static_cast<int8_t>(s);
				break;
			}
		}
	}

	if (slot != -1 && player->inventory.removeItem(slot, 1)) {
		Object* obj = g_objects.createObject(idata->key, targetPos, rotation);
		if (obj) {
			obj->setOwnerPid(player->getGUID());
			placeThing(obj, targetPos);
			g_events.emit({EventType::Build, player, idata->key, 1, ObjectOwner::Self});
			// Started only once something was actually built, so a click that
			// failed a placement check does not cost the player the cooldown.
			player->notePlacedObject(placingData->placeDelayMs);
		}
	}
}

// Object addressed by its 16-bit entity id. Sets targetUid to the object's real
// id, or 0 when nothing live holds that id16.
//
// This used to OR in the object prefix and, when that missed, fall back to a
// full getSpectators viewport sweep to cover ids whose allocation had wrapped.
// The id pool records the owning class per id16, so the real id is one array
// read and the sweep is gone -- that fallback was the most expensive query in
// an interaction path that fires on every click.
Object* Game::resolveInteractionObject(const Player* player, ClientEntityId entityId, uint32_t& targetUid)
{
	(void)player;
	targetUid = map.fullIdForId16(entityId);
	if (targetUid == 0) {
		return nullptr;
	}

	Thing* thing = map.getThingByID(targetUid);
	if (!thing) {
		targetUid = 0;
		return nullptr;
	}
	return thing->getObject();
}

// Another player has this open AND is still in range -- as opposed to a stale
// active-user pid left by someone who walked away or disconnected.
bool Game::isObjectHeldByAnotherPlayer(const Player* player, const Object* obj)
{
	const uint32_t activePid = obj->getActiveUserPid();
	if (activePid == 0 || activePid == player->getGUID()) {
		return false;
	}

	Player* other = getPlayerByGUID(activePid);
	return other && other->getOpenedInteractionId() == obj->getID() &&
		other->getPosition().getDistanceX(obj->getPosition()) <= INTERACTION_RANGE &&
		other->getPosition().getDistanceY(obj->getPosition()) <= INTERACTION_RANGE;
}

// Clicking a container while one is already open steps to the next in the
// cluster, so a wall of chests can be walked through. Returns nullptr to stay on
// whatever the client addressed. Ordered by distance, id as tiebreak, so the
// cycle is stable between clicks.
Object* Game::findNextCycleContainer(const Player* player, uint32_t currentInteractionId)
{
	std::vector<Thing*> specs;
	map.getSpectators(player->getPosition(), specs);
	Thing* currentInteractionThing = map.getThingByID(currentInteractionId);
	Object* currentInteraction = currentInteractionThing ? currentInteractionThing->getObject() : nullptr;

	std::vector<Object*> nearbyContainers;
	for (Thing* t : specs) {
		Object* candidate = t->getObject();
		if (!candidate) continue;

		const ObjectData* candidateData = candidate->getData();
		if (!candidateData || candidateData->storageSlots == 0) continue;

		const bool directlyReachable = isWithinContainerCycleRange(
			player->getPosition(), candidate->getPosition(), CONTAINER_CYCLE_DIRECT_RANGE);
		const bool clusteredWithCurrent = currentInteraction && isWithinContainerCycleRange(
			currentInteraction->getPosition(), candidate->getPosition(), CONTAINER_CYCLE_CLUSTER_RANGE);
		if (!directlyReachable && !clusteredWithCurrent) {
			continue;
		}

		if (isObjectHeldByAnotherPlayer(player, candidate)) {
			continue;
		}

		nearbyContainers.push_back(candidate);
	}

	std::sort(nearbyContainers.begin(), nearbyContainers.end(), [player](const Object* a, const Object* b) {
		const int32_t ax = player->getPosition().getOffsetX(a->getPosition());
		const int32_t ay = player->getPosition().getOffsetY(a->getPosition());
		const int32_t bx = player->getPosition().getOffsetX(b->getPosition());
		const int32_t by = player->getPosition().getOffsetY(b->getPosition());
		const int64_t aDist = static_cast<int64_t>(ax) * ax + static_cast<int64_t>(ay) * ay;
		const int64_t bDist = static_cast<int64_t>(bx) * bx + static_cast<int64_t>(by) * by;
		if (aDist != bDist) return aDist < bDist;
		return a->getID() < b->getID();
	});

	auto currentIt = std::find_if(nearbyContainers.begin(), nearbyContainers.end(),
		[currentInteractionId](const Object* candidate) {
			return candidate->getID() == currentInteractionId;
		});

	if (nearbyContainers.size() <= 1 || currentIt == nearbyContainers.end()) {
		return nullptr;
	}

	const size_t currentIndex = static_cast<size_t>(std::distance(nearbyContainers.begin(), currentIt));
	return nearbyContainers[(currentIndex + 1) % nearbyContainers.size()];
}

void Game::applySwitchInteraction(Object* obj, const ObjectData* od, uint64_t now)
{
	if (od->key == "gate_timer") {
		// Cycle within the configured rate list (the parser guarantees it is
		// non-empty); a fixed % 4 read out of bounds for shorter lists.
		obj->logicState.timerRateIndex = static_cast<uint8_t>((obj->logicState.timerRateIndex + 1) % od->timerRatesMs.size());
		obj->logicState.nextTimerFire = now + od->timerRatesMs[obj->logicState.timerRateIndex];
	} else if (od->key == "lamp") {
		obj->logicState.lampColorIndex = (obj->logicState.lampColorIndex + 1) % od->lampColorCount;
	} else if (od->key == "switch") {
		obj->logicState.switchOn = !obj->logicState.switchOn;
	}

	EntityUpdate update;
	obj->buildUpdate(update);
	broadcastSurgicalUpdate(update, obj->getPosition());
	updateLogicCircuits();
}

void Game::applyDoorInteraction(Player* player, Object* obj, const ObjectData* od)
{
	// Ownership check (clan mates share the owner's doors).
	if (obj->getOwnerPid() != 0 && obj->getOwnerPid() != player->getGUID() &&
		!sharesClanWith(player, obj->getOwnerPid())) {
		return; // Can't interact with someone else's door
	}

	// The panel tile must be clear either way; the interacting player is exempt
	// so a door works from the doorway itself.
	const Position panelPos = obj->isDoorOpen ? obj->getPosition() : getDoorSwingPosition(obj, od);
	if (isDoorPanelPositionBlocked(obj, panelPos, player->getGUID())) {
		obj->setOpenFailed();
	} else {
		obj->toggleDoor();
	}

	EntityUpdate update;
	obj->buildUpdate(update);
	broadcastSurgicalUpdate(update, obj->getPosition());
}

void Game::playerOpenInteraction(uint32_t playerId, ClientEntityId entityId, uint8_t)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	const uint32_t previousInteractionId = player->getOpenedInteractionId();

	uint32_t targetUid = 0;
	Object* obj = resolveInteractionObject(player, entityId, targetUid);
	if (!obj) return;

	const ObjectData* od = obj->getData();
	if (!od) return;

	if (player->getPosition().getDistanceX(obj->getPosition()) > INTERACTION_RANGE ||
		player->getPosition().getDistanceY(obj->getPosition()) > INTERACTION_RANGE) {
		return;
	}

	const uint64_t now = OTSYS_TIME();

	if (previousInteractionId != 0 && od->storageSlots > 0) {
		if (Object* next = findNextCycleContainer(player, previousInteractionId)) {
			obj = next;
			targetUid = obj->getID();
			od = obj->getData();
			if (!od) return;
		}
	}

	// Same object and nothing to cycle to.
	if (previousInteractionId == targetUid) return;

	if (od->interactionDelayMs > 0 && now - player->lastInteractionTime < od->interactionDelayMs) {
		return; // Interaction spam protection
	}
	player->lastInteractionTime = now;

	if (od->interaction == InteractionKind::Switch) {
		applySwitchInteraction(obj, od, now);
		return;
	}

	if (od->interaction == InteractionKind::Door) {
		applyDoorInteraction(player, obj, od);
		return;
	}

	if (isObjectHeldByAnotherPlayer(player, obj)) {
		return;
	}

	const bool switchedInteraction = previousInteractionId != 0;
	if (switchedInteraction) {
		playerCloseContainer(playerId);
	}

	obj->setActiveUserPid(player->getGUID());
	player->setOpenedInteractionId(targetUid);
	if (switchedInteraction && (od->storageSlots > 0 || od->stationId > 0)) {
		player->expectClientContainerClose(now + CLIENT_CONTAINER_CLOSE_ACK_GRACE_MS);
	}

	if (od->storageSlots > 0) {
		player->sendFullChest(obj, true);
	} else if (od->stationId > 0) {
		player->sendOpenStation(od->stationId, 0);
	}

	EntityUpdate update;
	obj->buildUpdate(update);
	broadcastSurgicalUpdate(update, obj->getPosition());
}

void Game::playerCloseContainer(uint32_t playerId, bool fromClient)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	if (fromClient && player->consumeExpectedClientContainerClose(OTSYS_TIME())) {
		return;
	}

	if (!fromClient) {
		player->clearExpectedClientContainerClose();
	}

	uint32_t interactionId = player->getOpenedInteractionId();
	if (interactionId != 0) {
		Thing* interactionThing = map.getThingByID(interactionId);
		Object* obj = interactionThing ? interactionThing->getObject() : nullptr;
		if (obj && obj->getActiveUserPid() == player->getGUID()) {
			obj->setActiveUserPid(0);
			EntityUpdate update;
			obj->buildUpdate(update);
			broadcastSurgicalUpdate(update, obj->getPosition());
		}
		player->setOpenedInteractionId(0);
	}
}

// The object the player has open and may act on: it must exist, be in range,
// and be actively used by this player. Going out of range closes it — this is
// also the per-tick range check run from Game::updateMovement. The range check
// runs before the active-user check so a stale UI (another player took the
// object over while this one was out of range) still gets closed.
Object* Game::getActiveInteractionObject(Player* player)
{
	uint32_t interactionId = player->getOpenedInteractionId();
	if (interactionId == 0) return nullptr;

	Thing* interactionThing = map.getThingByID(interactionId);
	Object* obj = interactionThing ? interactionThing->getObject() : nullptr;
	if (!obj) return nullptr;

	if (player->getPosition().getDistanceX(obj->getPosition()) > INTERACTION_RANGE ||
		player->getPosition().getDistanceY(obj->getPosition()) > INTERACTION_RANGE) {
		playerCloseContainer(player->getID());
		player->sendLostStation();
		return nullptr;
	}

	if (obj->getActiveUserPid() != player->getGUID()) return nullptr;

	return obj;
}

// Add a crafted yield to the player's inventory and drop whatever does not
// fit as loot; non-stackable items drop one loot entity each.
void Game::giveOrDropCraftYield(Player* player, const ItemData* idata, uint16_t iid, uint16_t totalYield)
{
	uint8_t added = player->inventory.addItem(iid, static_cast<uint8_t>(std::min<uint16_t>(255, totalYield)));
	if (added >= totalYield) return;

	uint16_t remaining = totalYield - added;
	uint8_t dropCount = 1;
	uint16_t iterations = remaining;
	if (idata->stack > 1) {
		dropCount = static_cast<uint8_t>(std::min<uint16_t>(255, remaining));
		iterations = 1;
	}

	std::vector<LootDrop> drops;
	for (uint16_t i = 0; i < iterations; i++) {
		drops.push_back({ idata->lootId, iid, dropCount, ItemState::fresh(iid) });
	}
	dropLootBurst(player->getPosition(), drops);
}

void Game::playerStoreItem(uint32_t playerId, uint16_t iid, uint8_t count, uint32_t uid, uint8_t, uint8_t containerSlot)
{
	if (count == 0) return;
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	Object* obj = getActiveInteractionObject(player);
	if (!obj) return;

	int8_t playerSlot = player->inventory.findItemByUidSlot(uid, iid);
	if (playerSlot == -1) return;

	Item* pItem = player->inventory.getItem(playerSlot);
	if (!pItem || pItem->getCount() < count) return;

	const ObjectData* od = obj->getData();
	if (od) {
		const ItemData* idata = ItemManager::getInstance().getItemData(iid);
		if (idata && idata->decayTimeMs > 0 && !od->refrigeration) {
			// Perishable item into non-refrigerated container is blocked
			return;
		}
	}

	// The slot it was dropped on when that one is free, else the first free one.
	bool added = false;
	if (containerSlot < obj->getStorageSize() && !obj->getStorageItem(containerSlot)) {
		obj->setStorageItem(containerSlot, std::make_unique<Item>(iid, count, ItemState::of(*pItem)));
		added = true;
	}
	for (uint8_t i = 0; !added && i < obj->getStorageSize(); i++) {
		if (!obj->getStorageItem(i)) {
			obj->setStorageItem(i, std::make_unique<Item>(iid, count, ItemState::of(*pItem)));
			added = true;
		}
	}

	if (added) {
		player->inventory.removeItem(playerSlot, count);
		player->sendFullChest(obj);
	}
}

// Rearranging the open container: drag one slot onto another and the two
// swap (an empty target is just a move). Same reach as taking and storing.
void Game::playerMoveContainerItem(uint32_t playerId, uint8_t from, uint8_t to)
{
	Player* player = getPlayerByID(playerId);
	if (!player || from == to) return;

	Object* obj = getActiveInteractionObject(player);
	if (!obj || from >= obj->getStorageSize() || to >= obj->getStorageSize() || !obj->getStorageItem(from)) return;

	obj->swapStorageItems(from, to);
	player->sendFullChest(obj);
}

void Game::playerWeaponMod(uint32_t playerId, uint8_t weaponUid, uint8_t slot, bool fit, uint8_t modUid)
{
	Player* player = getPlayerByID(playerId);
	if (!player || slot >= MOD_SLOT_COUNT) return;
	const std::string refusal = player->startModChange(weaponUid, static_cast<ModSlot>(slot), fit, modUid);
	if (!refusal.empty()) sendStatus(player, refusal, StatusKind::FAILURE);
}

void Game::playerTakeItem(uint32_t playerId, uint8_t slotIndex)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	Object* obj = getActiveInteractionObject(player);
	if (!obj || slotIndex >= obj->getStorageSize()) return;

	Item* cItem = obj->getStorageItem(slotIndex);
	if (!cItem) return;

	uint8_t added = player->inventory.addItem(cItem->getIID(), cItem->getCount(), ItemState::of(*cItem));
	if (added >= cItem->getCount()) {
		obj->setStorageItem(slotIndex, nullptr);
		player->sendFullChest(obj);
	} else if (added > 0) {
		cItem->setCount(cItem->getCount() - added);
		player->sendFullChest(obj);
	} else {
		// Not taken at all (inventory full). Drop the remaining item on the floor!
		const ItemData* idata = ItemManager::getInstance().getItemData(cItem->getIID());
		if (idata && idata->lootId != 0) {
			dropLootScattered(idata->lootId, cItem->getIID(), cItem->getCount(), ItemState::of(*cItem), player->getPosition());
		}
		
		// Remove from container
		obj->setStorageItem(slotIndex, nullptr);
		player->sendFullChest(obj);
	}
}

void Game::playerAddFuel(uint32_t playerId, uint8_t amount)
{
	if (amount == 0 || amount > 254) return;
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	Object* obj = getActiveInteractionObject(player);
	if (!obj) return;

	const ObjectData* od = obj->getData();
	if (!od || od->fuelItemKey.empty() || od->fuelBurnMs == 0) return;

	const ItemData* fuelData = ItemManager::getInstance().getItemData(od->fuelItemKey);
	if (!fuelData) return;

	uint32_t currentFuelUnits = (obj->getFuelMs() + od->fuelBurnMs - 1) / od->fuelBurnMs;
	if (currentFuelUnits >= 254) return; // Station is already completely full

	uint16_t addAmount = amount;
	
	// Cap addAmount to the available capacity so we don't over-consume
	uint16_t availableCapacity = 254 - currentFuelUnits;
	if (addAmount > availableCapacity) {
		addAmount = availableCapacity;
	}

	uint16_t totalRemoved = 0;

	// The requested amount may exceed the current inventory after another action.
	// Burn only fuel actually removed, across stacks, up to the free capacity.
	for (uint8_t s = 0; s < player->inventory.getSlotCount() && totalRemoved < addAmount; ++s) {
		Item* it = player->inventory.getItem(s);
		if (it && it->getIID() == fuelData->id) {
			uint8_t countInSlot = it->getCount();
			uint16_t toRemove = std::min<uint16_t>(static_cast<uint16_t>(countInSlot), static_cast<uint16_t>(addAmount - totalRemoved));
			
			if (player->inventory.removeItem(s, static_cast<uint8_t>(toRemove))) {
				totalRemoved += toRemove;
			}
		}
	}

	if (totalRemoved > 0) {
		obj->setFuelMs(obj->getFuelMs() + (od->fuelBurnMs * totalRemoved));
		player->sendNewFuelValue(obj->getFuelByte(), obj->getFuelMs());
		
		// Update object state on clients (for visual light/fire changes)
		EntityUpdate update;
		obj->buildUpdate(update);
		broadcastSurgicalUpdate(update, obj->getPosition());
	}
}

void Game::playerTakeFromStation(uint32_t playerId, uint8_t slotIndex)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	Object* obj = getActiveInteractionObject(player);
	if (!obj || slotIndex >= STATION_QUEUE_SIZE) return;

	auto& q = obj->getQueue();
	const auto& item = q[slotIndex];
	if (item.iid == 0) return;

	const ObjectData* od = obj->getData();
	if (!od) return;

	if (item.progressMs >= item.totalTimeMs) {
		const ItemData* idata = ItemManager::getInstance().getItemData(item.iid);
		if (!idata) return;

		uint16_t totalYield = static_cast<uint16_t>(item.yield * player->getCraftMultiplier(item.iid));
		giveOrDropCraftYield(player, idata, item.iid, totalYield);
		obj->removeFromQueue(slotIndex);
		player->sendOpenStation(od->stationId, 1);
	} else {
		std::vector<LootDrop> drops;
		for (const auto& ing : item.ingredients) {
			const ItemData* data = ItemManager::getInstance().getItemData(ing.first);
			if (data) {
				drops.push_back({ data->lootId, ing.first, ing.second, ItemState::fresh(ing.first) });
			}
		}
		dropLootBurst(player->getPosition(), drops);
		obj->removeFromQueue(slotIndex);
		player->sendOpenStation(od->stationId, 1);
	}
}

// Units one extraction job produces: a uniform roll in [outputMin, outputMax]
// inclusive, never zero.
static uint16_t rollExtractorYield(const ExtractorData& ex)
{
	uint16_t yield = ex.outputMin;
	if (ex.outputMax > ex.outputMin) {
		yield = static_cast<uint16_t>(uniform_random(ex.outputMin, ex.outputMax));
	}
	return yield > 0 ? yield : 1;
}

void Game::playerStartCraft(uint32_t playerId, uint16_t iid, bool isStation)
{
	Player* player = getPlayerByID(playerId);
	if (!player) return;

	const ItemData* idata = ItemManager::getInstance().getItemData(iid);
	if (!idata || !idata->isCraftable) return;

	Object* stationObj = nullptr;
	uint8_t areaId = 0;

	if (isStation) {
		stationObj = getActiveInteractionObject(player);
		if (!stationObj) return;
		const ObjectData* od = stationObj->getData();
		if (od) areaId = od->stationId;
	}

	if (player->getLevel() < idata->crafting.requiredLevel) return;
	if (!idata->crafting.prerequisite.empty() && !player->hasSkill(idata->crafting.prerequisiteIid)) return;
	if (idata->requiresUnlock && !player->hasSkill(iid)) return;

	const CraftingStation* station = nullptr;
	for (const auto& st : idata->crafting.stations) {
		if (st.id == areaId) {
			if (areaId == 0 || stationObj) {
				station = &st;
				break;
			}
		}
	}

	if (!station) return;

	const uint32_t craftTime = static_cast<uint32_t>(station->timeMs * getCraftSpeed());

	// An extraction has no recipe, so its output cannot come from the recipe's
	// fixed yield; it is rolled here, once per job.
	const uint16_t yield = station->isExtraction ? rollExtractorYield(idata->extractor)
	                                             : static_cast<uint16_t>(idata->crafting.yield);

	std::vector<std::pair<uint16_t, uint8_t>> usedIngredients;
	for (const auto& ing : idata->crafting.recipe) {
		int32_t count = 0;
		for (uint8_t s = 0; s < player->inventory.getSlotCount(); ++s) {
			if (Item* it = player->inventory.getItem(s)) {
				if (it->getIID() == ing.iid) count += it->getCount();
			}
		}
		if (count < ing.amount) return;
		usedIngredients.emplace_back(ing.iid, ing.amount);
	}

	auto consumeIngredients = [&]() {
		for (const auto& ing : idata->crafting.recipe) {
			uint8_t remaining = ing.amount;
			for (uint8_t s = 0; s < player->inventory.getSlotCount() && remaining > 0; ++s) {
				if (Item* it = player->inventory.getItem(s)) {
					if (it->getIID() == ing.iid) {
						uint8_t take = std::min(remaining, it->getCount());
						player->inventory.removeItem(s, take);
						remaining -= take;
					}
				}
			}
		}
	};

	if (areaId == 0) {
		player->cancelEquipping();
		playerCancelCraft(playerId);
		player->crafting.iid = iid;
		player->crafting.ingredients = usedIngredients;
		consumeIngredients();
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::CRAFT_STARTED));
		msg.addByte(static_cast<uint8_t>(iid & 0xFF));
		player->sendNetworkMessage(msg);
		player->crafting.eventId = g_scheduler.addEvent(createSchedulerTask(craftTime, [this, playerId, iid]() { this->completeCraft(playerId, iid); }));
	} else if (stationObj) {
		const ObjectData* od = stationObj->getData();
		if (od && !od->fuelItemKey.empty() && stationObj->getFuelMs() < 100) return;
		auto& q = stationObj->getQueue();
		for (uint8_t i = 0; i < STATION_QUEUE_SIZE; i++) {
			if (q[i].iid == 0) {
				consumeIngredients();
				stationObj->addToQueue(iid, yield, craftTime, std::move(usedIngredients));
				q[i].creator = player->getID();
				q[i].creatorLife = player->getLifeGeneration();
				player->sendOpenStation(od->stationId, 1);
				break;
			}
		}
	}
}

void Game::playerCancelCraft(uint32_t playerId)
{
	Player* player = getPlayerByID(playerId);
	if (!player || player->crafting.iid == 0) return;
	if (player->crafting.eventId != 0) {
		g_scheduler.stopEvent(player->crafting.eventId);
		player->crafting.eventId = 0;
	}
	std::vector<LootDrop> drops;
	for (const auto& ing : player->crafting.ingredients) {
		const ItemData* data = ItemManager::getInstance().getItemData(ing.first);
		if (data) {
			drops.push_back({ data->lootId, ing.first, ing.second, ItemState::fresh(ing.first) });
		}
	}
	dropLootBurst(player->getPosition(), drops);
	player->crafting.iid = 0;
	player->crafting.ingredients.clear();
	player->sendInterruptInteraction();
}

void Game::completeCraft(uint32_t playerId, uint16_t iid)
{
	Player* player = getPlayerByID(playerId);
	if (!player || player->crafting.iid != iid) return;
	player->crafting.iid = 0;
	player->crafting.eventId = 0;
	player->crafting.ingredients.clear();
	const ItemData* idata = ItemManager::getInstance().getItemData(iid);
	if (!idata) return;

	uint16_t totalYield = static_cast<uint16_t>(idata->crafting.yield) * player->getCraftMultiplier(iid);
	giveOrDropCraftYield(player, idata, iid, totalYield);
	g_events.emit({EventType::Craft, player, idata->key, totalYield});
	player->addXP(idata->score * 2);
}

void Game::broadcastSurgicalUpdate(const EntityUpdate& update, const Position& pos)
{
	// The wire carries only the low 16 bits, so the 32-bit id knownCreatures is
	// keyed on has to be rebuilt from the update's TYPE. entityClassFromProtocolType
	// is the single mapping; resources (types 8-11) were missing from the old
	// inline chain here, which left a destroyed resource un-retracted from any
	// client that held it but could not currently see it. Under one shared id
	// pool that stale entry is a ghost waiting for its id16 to be reissued to an
	// object, so the gap had to close with the pool.
	//
	// Players (type 0) map to None on purpose: their id16 is 0 and the real id is
	// not derivable here. They need no help -- the mobile half of the visibility
	// diff is rebuilt every tick and retracts them by itself.
	const uint32_t fullId = update.id | entityClassPrefix(entityClassFromProtocolType(update.type));


	bool isRemoval = (update.state == 0);

	if (isRemoval) {
		// Removals still sweep every player, and have to. A player who has
		// walked out of range still holds this entity in their client cache,
		// and the visibility diff in the main tick cannot clean it up for them:
		// that path resolves the id through map.getThingByID, which returns
		// null once the thing is actually gone, so it erases the id locally
		// without ever telling the client. This broadcast is the only thing
		// that retracts a destroyed entity from a distant client. Removals are
		// rare compared to state updates, so the full scan stays affordable.
		// The erase is BATCHED for static entities and dropped from this loop.
		// Per id it is an O(n) memmove through the player's sorted static half,
		// and this loop runs it once per player per removal: ~100 loot removals
		// a tick x 250 players x a ~400-element move. Recorded once here and
		// applied to every player in a single merge pass by the visibility loop
		// (see Game::pendingStaticRemovals).
		//
		// The mobile half keeps the immediate erase. It is rebuilt from scratch
		// every tick anyway, so batching would buy nothing -- but dropping the
		// erase outright would let the diff find the id still present and emit
		// a SECOND removal for entities not yet off the map.
		const bool isStatic = !isMobileEntityId(fullId);
		for (const auto& it : players) {
			Player* p = it.second;
			if ((isStatic ? p->canSeeScenery(pos) : p->canSee(pos)) || p->knownCreatures.contains(fullId)) {
				p->pushUpdate(update);
				if (!isStatic) {
					p->knownCreatures.erase(fullId);
				}
			}
		}
		if (isStatic) {
			pendingStaticRemovals.insert(fullId);
		}
		return;
	}

	// An id removed and RE-CREATED inside one tick must survive the batch, or
	// the entity that now holds it is erased from every client's known set
	// while it is alive -- and since the static half is only re-derived when a
	// player's viewport box shifts, it would stay missing indefinitely.
	if (!pendingStaticRemovals.empty()) {
		pendingStaticRemovals.erase(fullId);
	}

	// State updates only ever reach players who can see the position, so the
	// candidate set is bounded by the viewport rather than by the player count.
	// This is the same O(all players) -> O(viewport tiles) change already made
	// for getSpectators, and it matters for the same reason: the hot callers
	// here are per-tick (projectile movement, loot in flight, object state), so
	// the old scan cost players x events x 20Hz.
	//
	// canSee is still applied per candidate, so the set of players that receive
	// the update is identical to what the full scan produced. A player not yet
	// placed on a tile is the one gap, and it is self-healing: they simply do
	// not have the id in knownCreatures, so the next visibility diff treats the
	// entity as new and sends a full update.
	surgicalSpectators.clear();
	map.getPotentialSpectatorPlayers(pos, surgicalSpectators);

	// A transient visual is sent and forgotten -- no removal will ever follow
	// it, so an entry in knownCreatures would never come back out. See
	// isTransientVisualType.
	const bool track = !isTransientVisualType(update.type);

	// A concealed object's creation and state changes go only to the players
	// who may know it exists (perceivesConcealed); everyone else is left to
	// updateConcealedVisibility, which sends the current record the moment
	// they qualify. Resolved through the map only for object records, since
	// that is the one class that can be concealed.
	const Object* concealed = nullptr;
	if (entityClassFromProtocolType(update.type) == EntityClass::Object) {
		if (const Thing* t = map.getThingByID(fullId)) {
			if (const Object* o = t->getObject()) {
				if (o->isConcealed()) concealed = o;
			}
		}
	}

	// Scenery is sent from the view box (canSeeScenery), creatures and
	// projectiles from what the player sees (canSee). The two differ only for
	// a strong scope, whose shape is narrower than the box its scenery comes from.
	const bool isStatic = !isMobileEntityId(fullId);
	for (Player* p : surgicalSpectators) {
		if (!(isStatic ? p->canSeeScenery(pos) : p->canSee(pos))) continue;
		if (concealed && !perceivesConcealed(p, concealed)) continue;
		p->pushUpdate(update);
		if (track) {
			p->knownCreatures.insert(fullId);
		}
	}
}

bool Game::perceivesConcealed(const Player* p, const Object* obj) const
{
	const int32_t range = obj->concealRange();
	if (range <= 0) return true;
	if (isSameOwnerSide(p->getGUID(), obj->getOwnerPid())) return true;
	const Position& a = p->getPosition();
	const Position& b = obj->getPosition();
	const int64_t dx = static_cast<int64_t>(a.x) - b.x;
	const int64_t dy = static_cast<int64_t>(a.y) - b.y;
	return dx * dx + dy * dy <= static_cast<int64_t>(range) * range;
}

void Game::updateConcealedVisibility(Player* p, const Map::TileBox& box, uint32_t visibilityTick)
{
	for (Object* obj : map.getConcealed()) {
		// A destroyed one is retracted by its own removal broadcast.
		if (obj->isDestroyed) continue;
		const uint32_t id = obj->getID();
		const Position& pos = obj->getPosition();
		const int32_t tx = pos.x / TILE_SIZE;
		const int32_t ty = pos.y / TILE_SIZE;
		const bool inBox = tx >= box.minX && tx <= box.maxX && ty >= box.minY && ty <= box.maxY;
		const bool want = inBox && perceivesConcealed(p, obj);
		const bool has = p->knownCreatures.contains(id);
		if (want == has) continue;
		if (want) {
			p->pushUpdate(obj->getCachedUpdate(visibilityTick));
			p->knownCreatures.insert(id);
		} else {
			EntityUpdate removal;
			obj->buildRemoval(removal);
			p->pushUpdate(removal);
			p->knownCreatures.erase(id);
		}
	}
}

// These four opcodes are the frames that multiply with crowd size, and they
// were the most expensive thing on the server in a dense area. Each of them
// used to (a) walk EVERY player to find the recipients and (b) build a separate
// NetworkMessage plus a separate 24 KB OutputMessage for each one -- so a crowd
// of N players watching each other cost N frames per event and N^2 per tick's
// worth of events. Measured at ~200 players standing together: 5,000 of the
// 6,400 frames per second leaving the server were these, not entity updates.
//
// Both halves are fixed here. The candidate set comes from the tile index
// instead of the player map (same rule as broadcastSurgicalUpdate -- canSee is
// still applied per candidate, so the recipients are identical), and the message
// goes into each recipient's output batch rather than out as its own frame.
//
// Batching replaced an earlier fix that serialised one OutputMessage and shared
// the shared_ptr across every recipient. That saved the serialisation but not
// the frame, which is the part that actually costs; copying three bytes into a
// batch is cheaper than the shared_ptr copy it replaces.
void Game::broadcastToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject)
{
	// The radius bounds where an event is relevant and the per-victim throttle
	// bounds how often one happens, but neither bounds the FAN-OUT: one flash
	// in a dense crowd is still one frame per spectator. This does.
	fanOutToWatchers(msg, pos, subject, getNumber(ConfigManager::EVENT_FRAMES_PER_TICK));
}

// The same fan-out for a message that states what something IS rather than what
// just happened to it, and therefore must not be dropped.
//
// The frame budget above is right for a hit flash: miss one and the worst case
// is a missing red tint on a frame nobody was looking at. It is wrong for a drug
// skin, which has to stay correct for ten minutes -- a dropped frame there
// leaves an observer drawing the wrong player indefinitely, and a statement made
// of several opcodes (clear, then re-assert) could even be cut in half and leave
// them drawing a player who is definitely not what the server thinks.
//
// Safe to leave unbudgeted because these are rare by construction: only a player
// under an active effect states anything at all, and only every
// STATUS_VISUAL_RESTATE_MS. The pathological case -- every player drugged, all
// in one viewport -- is players x spectators / 10s, an order of magnitude under
// the flash storm the budget was introduced for, and the realistic case is zero.
void Game::broadcastStateToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject)
{
	fanOutToWatchers(msg, pos, subject, 0);
}

void Game::fanOutToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject, int32_t frameBudget)
{
	// Cosmetic events are bounded by what a client can actually DRAW, not by
	// what it is told about. See ConfigManager::EVENT_BROADCAST_RADIUS: these
	// are the only messages costing one frame per spectator per event, and in a
	// crowd they were 97% of everything the server wrote.
	const int32_t radius = getNumber(ConfigManager::EVENT_BROADCAST_RADIUS);

	// The gather is bounded by the same radius, not the viewport: sweeping
	// 1,225 tiles to find recipients we are about to reject by distance was the
	// dominant cost of a crowded firefight.
	watcherSpectators.clear();
	map.getPotentialSpectatorPlayers(pos, watcherSpectators, radius);

	// The subject first, and unconditionally: they are the one recipient the
	// tile sweep can legitimately miss (see the header comment).
	if (subject && subject->client) {
		subject->client->queueMessage(msg);
	}

	for (Player* p : watcherSpectators) {
		if (p == subject || !p->client || !p->canSee(pos)) {
			continue;
		}
		if (radius > 0) {
			// From the player, or moved or swept with an aimed scope's view.
			const Position& ppos = p->getPosition();
			if (!aim_view::cosmeticReach(p->getView(), static_cast<int32_t>(pos.x) - static_cast<int32_t>(ppos.x),
					static_cast<int32_t>(pos.y) - static_cast<int32_t>(ppos.y), radius)) {
				continue;
			}
		}
		if (frameBudget > 0) {
			if (p->eventFramesThisTick >= frameBudget) {
				continue;
			}
			++p->eventFramesThisTick;
		}
		p->client->queueMessage(msg);
	}
}

void Game::broadcastNotification(uint8_t playerPid, uint8_t type, uint8_t level, const Position& pos)
{
	// Byte-for-byte what ProtocolGame::sendNotification builds.
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::OVERHEAD_ALERT));
	msg.addByte(playerPid);
	msg.addByte(static_cast<uint8_t>((type << 2) | (level & 3)));
	broadcastToWatchers(msg, pos);
}

void Game::broadcastPlayerEat(uint8_t playerPid, const Position& pos)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_ATE));
	msg.addByte(playerPid);
	broadcastToWatchers(msg, pos);
}

void Game::broadcastPlayerHeal(uint8_t playerPid, const Position& pos, Player* subject)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_HEALED));
	msg.addByte(playerPid);
	broadcastToWatchers(msg, pos, subject);
}

void Game::broadcastDamageIndicator(const Position& pos, int16_t amount, uint8_t pct, Player* subject)
{
	if (amount == 0) {
		return;
	}
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::DAMAGE_INDICATOR));
	msg.add<uint16_t>(static_cast<uint16_t>(pos.x));
	msg.add<uint16_t>(static_cast<uint16_t>(pos.y));
	msg.add<int16_t>(amount);
	msg.addByte(pct);
	broadcastToWatchers(msg, pos, subject);
}

void Game::broadcastPlayerHit(uint8_t playerPid, uint8_t angle, const Position& pos, Player* subject)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_HIT));
	msg.addByte(playerPid);
	msg.addByte(angle);

	// The flash a spectator sees lasts 300ms (client.js onPlayerHit sets
	// player.hurt = 300), so a second broadcast inside that window restarts a
	// timer that is already running and changes nothing on screen. Under
	// automatic fire a victim is hit ~8x/s, so ~96% of this fan-out was
	// invisible -- and it is the fan-out, not the message, that costs: one
	// WebSocket frame per spectator, every time.
	//
	// The victim is exempt: their own client also takes the screen shake from
	// this packet, and it is a single frame either way.
	const int32_t throttleMs = getNumber(ConfigManager::HIT_FLASH_THROTTLE_MS);
	if (throttleMs > 0 && subject) {
		const uint64_t now = OTSYS_TIME();
		if (now - subject->lastHitFlashBroadcast < static_cast<uint64_t>(throttleMs)) {
			if (subject->client) {
				subject->client->queueMessage(msg);
			}
			return;
		}
		subject->lastHitFlashBroadcast = now;
	}

	broadcastToWatchers(msg, pos, subject);
}

void Game::removeExpiredTakenLoot(uint64_t now)
{
	// 0 disables ground-loot despawning (testing phase default)
	const uint64_t despawnMs = static_cast<uint64_t>(std::max(0, getNumber(ConfigManager::LOOT_DESPAWN_SECONDS))) * 1000;

	// The loot index, not the whole thing list: this runs every tick to find a
	// handful of expirations, and walking all ~8,800 map entities to do it cost
	// 6.2ms per tick under item churn.
	static std::vector<Loot*> expiredLoot;
	expiredLoot.clear();

	for (Loot* loot : map.getLoots()) {
		if (loot->isTaken()) {
			if (now - static_cast<uint64_t>(loot->getTakenTime()) >= LOOT_TAKEN_REMOVAL_DELAY_MS) {
				expiredLoot.push_back(loot);
			}
		} else if (despawnMs > 0 && now - static_cast<uint64_t>(loot->getSpawnTime()) >= despawnMs) {
			// Untouched ground loot (including player drops) despawns after the
			// configured lifetime.
			expiredLoot.push_back(loot);
		}
	}

	for (Loot* loot : expiredLoot) {
		EntityUpdate removal;
		loot->buildRemoval(removal);
		broadcastSurgicalUpdate(removal, loot->getPosition());

		map.removeThing(loot);
		delete loot;
	}
}

// Circle-vs-obstacle overlap test shared by the movement collision resolver.
// External linkage on purpose: the agent planners in game_agents.cpp test
// bodies with this same predicate, so planner and resolver can never disagree
// about what overlaps.
bool playerOverlapsObstacle(Thing* obstacle, float px, float py, float playerRadius, float& overlap, float& nx, float& ny)
{
	CollisionCircle playerCircle = { px, py, playerRadius };

	CollisionRect rect;
	if (obstacle->getCollisionRect(rect)) {
		return Collision::checkCircleRect(playerCircle, rect, overlap, nx, ny);
	}

	CollisionCircle targetCircle;
	targetCircle.x = static_cast<float>(obstacle->getPosition().x);
	targetCircle.y = static_cast<float>(obstacle->getPosition().y);
	targetCircle.radius = obstacle->getCollisionRadius();
	return Collision::checkCircleCircle(playerCircle, targetCircle, overlap, nx, ny);
}

// Longest displacement a collision pass may resolve in ONE go; anything further
// is swept in pieces this size.
//
// The resolver only ever looks at where a body ENDS UP. A step long enough to
// carry the body's centre past the middle of a thin wall is pushed out of the
// FAR side (Collision::checkCircleRect escapes through the nearest face), which
// is exactly how a knockback threw a player straight through the object they
// were standing next to: a 45-unit impulse plus a tick of running is more than
// the ~50 units it takes to cross a 35-thick wall from contact.
//
// The centre can only reach that middle if the step exceeds the body's own
// radius plus half the obstacle's thickness, so a cap just under the radius
// ALONE is safe against an obstacle of any thickness. Derived from the body
// rather than fixed, because a constant would silently stop being safe the day
// something smaller than it is added.
//
// Costs nothing in the ordinary case: a sprinting player covers 17.5 units in a
// tick and a running ghoul 25, both inside one step. Only a body that has just
// been hit pays for more than one pass.
static inline float collisionSubstep(float bodyRadius)
{
	return std::max(4.0f, bodyRadius * 0.9f);
}

// Hold a body of `radius` fully inside the map.
//
// THE MAP EDGE IS A WALL AND HAS TO BE ENFORCED LIKE ONE -- after every step of
// a resolver, never once before it runs. As a single clamp on the destination it
// was worth nothing the moment anything moved the body afterwards, and moving
// the body afterwards is the resolver's entire job: a pack pressed against
// someone standing on the edge pushes them OUT of the map, and out there is no
// obstacle to push them back in.
//
// What makes that a catastrophe rather than a cosmetic glitch is the wire type.
// `Position::x/y` are uint16 while the map is 15000 wide, so a coordinate of -8
// does not read as "just outside" -- it reads as 65528, and the body is
// teleported clean across the world. Clamping per step instead makes the edge
// behave like every other surface: you slide along it.
static inline void clampToMapBounds(float& x, float& y, float radius)
{
	const float maxX = static_cast<float>(MapSize::widthUnits()) - radius;
	const float maxY = static_cast<float>(MapSize::heightUnits()) - radius;
	// max(): a body wider than the map would hand clamp() an inverted range.
	x = std::clamp(x, radius, std::max(radius, maxX));
	y = std::clamp(y, radius, std::max(radius, maxY));
}

// Every collidable obstacle a body of `radius` centred at (px, py) could touch
// while moving up to `travel` units this tick, excluding the body itself.
//
// The box is built in WORLD units and then converted, rather than being "the
// tile I am standing in, plus two". A thing is filed under the tile holding its
// CENTRE while its body reaches as far as the widest one loaded, so what decides
// the box is how far a centre can be and still matter -- travel + my radius +
// that extent -- and a fixed tile count answers that only for the distances it
// was written for. Getting it wrong fails SILENTLY: the obstacle is not in the
// list, so the body glides through it with nothing to indicate why.
//
// That is what makes this worth deriving. A knockback moves a body three or
// four times further than a step does, and a tile count sized for stepping was
// leaving the largest objects out of the list for exactly the ticks that most
// needed them. Working in world units also keeps the ordinary case at the 5x5
// it always was, instead of paying a whole extra ring of tiles all the time to
// cover a case that arises when somebody gets hit.
static void collectNearbyObstacles(Map& map, const Thing* self, float px, float py,
                                   float travel, float radius, std::vector<Thing*>& out)
{
	out.clear();

	// Floored at the two tiles this has always used, so an ordinary step gathers
	// EXACTLY the box it gathered before (a +/-200 world box spans the same five
	// tiles as "my tile +/-2", whatever the position inside the tile) and pays
	// nothing for the widening. Only a knocked-back body reaches further.
	const float reach = std::max(static_cast<float>(2 * TILE_SIZE),
	                             travel + radius + static_cast<float>(Map::maxCollisionExtent()));
	const int32_t minTx = static_cast<int32_t>(std::floor((px - reach) / TILE_SIZE));
	const int32_t maxTx = static_cast<int32_t>(std::floor((px + reach) / TILE_SIZE));
	const int32_t minTy = static_cast<int32_t>(std::floor((py - reach) / TILE_SIZE));
	const int32_t maxTy = static_cast<int32_t>(std::floor((py + reach) / TILE_SIZE));

	for (int32_t tx = minTx; tx <= maxTx; ++tx) {
		for (int32_t ty = minTy; ty <= maxTy; ++ty) {
			// findTile, not getTile: this is a read-only probe run per moving
			// body per tick. getTile creates the tile on miss, so it was
			// allocating (and permanently retaining) an empty Tile for every
			// patch of empty ground any player walked past.
			Tile* tile = map.findTile(tx, ty);
			if (!tile) continue;

			for (Thing* obstacle : tile->getThings()) {
				// collidesWith, not hasCollision: an agent may be solid to
				// everything but its own stack group, which is a property of the
				// pair and not of the obstacle alone.
				if (obstacle == self || !obstacle->collidesWith(self)) continue;
				out.push_back(obstacle);
			}
		}
	}
}

// Linear merge of a sorted visible set against the sorted set the client
// already has, emitting exactly the records that changed and writing the next
// known set into `nextKnown`.
//
//   visible-only -> new entity, send a full update
//   known-only   -> no longer visible, send a removal
//   in both      -> send only when dirty ("has moved" is exactly the dirty
//                   flag; nothing clears it until the end of the tick)
//
// Shared by the mobile and static halves of the diff so the two cannot drift.
// The hot path performs no insert, erase or hash lookup: it builds the next set
// in order and the caller swaps it in.
// There is deliberately no "an id died and was reissued inside this tick"
// guard here. Every mobile removal goes through broadcastSurgicalUpdate, which
// pushes the removal AND erases the id from the known set itself, and
// Map::removeThing does not release the id back to the pool until after that
// broadcast -- so the reissued entity's creation can only ever be queued after
// the old one's removal, in the same pendingUpdates vector, in that order. The
// client therefore frees the cache slot before it reallocates it.
//
// A `pendingMobileRemovals` hand-off used to exist for this. Its only writer
// was Game::removeProjectile, which could not use it correctly (projectiles are
// never in `visible`, so the id was gone from `known` long before the bullet
// died) and now retracts through its own recorded recipient mask instead. The
// mechanism was left with no writer at all and has been removed rather than
// kept as an unreachable branch implying protection that is not needed.
static void diffVisibleSet(Player* p, const std::vector<VisibleEntity>& visible,
                           const std::vector<uint32_t>& known,
                           std::vector<uint32_t>& nextKnown,
                           Map& map, uint32_t visibilityTick, uint32_t updateBudget)
{
	nextKnown.clear();
	nextKnown.reserve(visible.size());

	// How many ticks apart an already-known entity's refreshes are spaced. 1
	// means "every tick", i.e. exactly the old behaviour, which is what a
	// player who can see fewer entities than the budget always gets.
	//
	// Entering, leaving and the observer's own record are exempt below: those
	// are correctness, not smoothness. A dropped entry means the client never
	// learns the entity exists; a dropped removal leaves a permanent ghost in
	// the client's entity table.
	uint32_t divisor = 1;
	if (updateBudget > 0 && visible.size() > updateBudget) {
		divisor = static_cast<uint32_t>((visible.size() + updateBudget - 1) / updateBudget);
	}

	size_t vi = 0;
	size_t ki = 0;

	while (vi < visible.size() || ki < known.size()) {
		const uint32_t visibleId = vi < visible.size() ? visible[vi].id : UINT32_MAX;
		const uint32_t knownId = ki < known.size() ? known[ki] : UINT32_MAX;

		if (visibleId == knownId) {
			Thing* spectator = visible[vi].thing;
			// Cached by the dirty scan earlier this tick, not re-derived per
			// observer -- see Thing::cacheDirty.
			if (spectator->wasDirtyThisTick()) {
				// Spread by entity id and rotated by the tick counter, so every
				// entity is refreshed exactly once per `divisor` ticks and the
				// per-tick cost is flat instead of arriving in bursts.
				const bool due = divisor == 1
				              || spectator == static_cast<Thing*>(p)
				              || ((visibleId + visibilityTick) % divisor) == 0;
				if (due) {
					p->pushUpdate(spectator->getCachedUpdate(visibilityTick));
				}
			}
			nextKnown.push_back(visibleId);
			++vi; ++ki;
		} else if (visibleId < knownId) {
			p->pushUpdate(visible[vi].thing->getCachedUpdate(visibilityTick));
			nextKnown.push_back(visibleId);
			++vi;
		} else {
			// No longer visible. If it is still on the map it walked out of
			// range, so retract it; if it is gone from the map entirely then
			// broadcastSurgicalUpdate already sent that removal and erased the
			// id, and this branch simply drops it locally.
			Thing* removedThing = map.getThingByID(knownId);
			if (removedThing) {
				EntityUpdate removal;
				removedThing->buildRemoval(removal);
				p->pushUpdate(removal);
			}
			++ki;
		}
	}
}

// Decomposes a \ b -- the part of inclusive tile-rectangle `a` not covered by
// `b` -- into up to four disjoint sub-rectangles, written to out[]. Returns the
// count. This is how a viewport box shift becomes just the entering / leaving
// tile strips: a rectangle minus its overlap with another is a frame of at most
// four strips.
static int rectDifference(const Map::TileBox& a, const Map::TileBox& b, Map::TileBox out[4])
{
	if (a.minX > a.maxX || a.minY > a.maxY) {
		return 0; // a is empty (e.g. the inverted sentinel box on a fresh player)
	}

	const int32_t ix0 = std::max(a.minX, b.minX);
	const int32_t iy0 = std::max(a.minY, b.minY);
	const int32_t ix1 = std::min(a.maxX, b.maxX);
	const int32_t iy1 = std::min(a.maxY, b.maxY);

	if (ix0 > ix1 || iy0 > iy1) {
		out[0] = a; // no overlap: all of a is the difference (e.g. a teleport)
		return 1;
	}

	int n = 0;
	if (a.minY < iy0) out[n++] = { a.minX, a.minY,  a.maxX, iy0 - 1 }; // strip above overlap
	if (iy1 < a.maxY) out[n++] = { a.minX, iy1 + 1, a.maxX, a.maxY  }; // strip below overlap
	if (a.minX < ix0) out[n++] = { a.minX, iy0, ix0 - 1, iy1 };        // strip left of overlap
	if (ix1 < a.maxX) out[n++] = { ix1 + 1, iy0, a.maxX, iy1 };        // strip right of overlap
	return n;
}

// Incremental static-visibility update for one player whose viewport box shifted
// from oldBox to newBox. Only the tile strips that ENTERED or LEFT the box are
// visited; the overlap is left untouched. That turns the per-shift cost from the
// box AREA (the old full rebuild gathered, sorted and merged every ~800 statics
// in view) into the box PERIMETER -- at viewport 2500 a one-tile step visits
// ~100 tiles instead of ~2600 and merges ~30 changes instead of re-sorting 800.
//
// Why the overlap can be skipped, from the visibility invariants:
//   * every thing lives in exactly one tile's list, so the entered/left strips
//     partition the statics with no double counting;
//   * a static's only per-tick state change is loot being taken, and that is
//     delivered by broadcastSurgicalUpdate, not by this diff;
//   * broadcastSurgicalUpdate inserts a static id only when canSeeScenery(pos) is true,
//     and canSeeScenery implies the tile is inside the outward-rounded tile box -- so
//     the overlap's known set is always consistent with tile membership and
//     cannot hold a stray id these strips would fail to retract.
//
// Removals guard on actual membership (a static placed in the outer tile ring
// while canSeeScenery was false is on the map and inside the tile box but was never
// sent, so it must not be retracted); adds do not, because a strip tile was not
// in the old box and so could not have been broadcast-inserted yet.
static void updateStaticViewport(Player* p,
                                 const Map::TileBox& oldBox, const Map::TileBox& newBox,
                                 Map& map, uint32_t visibilityTick,
                                 std::vector<Thing*>& gathered,
                                 std::vector<VisibleEntity>& entered,
                                 std::vector<uint32_t>& leftIds,
                                 std::vector<uint32_t>& merged,
                                 uint64_t& visitedCount)
{
	Map::TileBox rects[4];

	// ENTERED strips: newBox \ oldBox. Kept as {id, thing} because the add for
	// each is decided in the merge below, against the known set.
	entered.clear();
	gathered.clear();
	int n = rectDifference(newBox, oldBox, rects);
	for (int i = 0; i < n; ++i) {
		map.getStaticsInTileBox(rects[i].minX, rects[i].minY, rects[i].maxX, rects[i].maxY, gathered);
	}
	visitedCount += gathered.size();
	for (Thing* t : gathered) {
		// A concealed object is decided per player by side and distance
		// (updateConcealedVisibility), never by the box it sits in. Leaving
		// the box still retracts it below, since that only touches known ids.
		if (const Object* o = t->getObject()) {
			if (o->isConcealed()) continue;
		}
		entered.push_back({ t->getID(), t });
	}
	std::sort(entered.begin(), entered.end(),
		[](const VisibleEntity& a, const VisibleEntity& b) { return a.id < b.id; });

	// LEFT strips: oldBox \ newBox.
	leftIds.clear();
	gathered.clear();
	n = rectDifference(oldBox, newBox, rects);
	for (int i = 0; i < n; ++i) {
		map.getStaticsInTileBox(rects[i].minX, rects[i].minY, rects[i].maxX, rects[i].maxY, gathered);
	}
	visitedCount += gathered.size();
	for (Thing* t : gathered) {
		leftIds.push_back(t->getID());
	}
	std::sort(leftIds.begin(), leftIds.end());

	// Nothing crossed either edge: the known set is unchanged, so skip the merge
	// entirely rather than copy it. Common when a step lands in empty tiles.
	if (entered.empty() && leftIds.empty()) {
		return;
	}

	// Rebuild staticIds = (old \ left) u entered in one linear pass. An ADD is
	// emitted only for an entered id NOT already known -- on the first tick after
	// login the whole box is "entered" while everything in it is already known
	// (getSpectators sent it), so an unguarded add would re-send the lot. A
	// REMOVAL is emitted only for a leaving id that WAS known (a static placed in
	// the outer tile ring while canSeeScenery was false is on the map and inside the
	// tile box but was never sent, so it must not be retracted).
	const std::vector<uint32_t>& known = p->knownCreatures.statics();
	merged.clear();
	merged.reserve(known.size() + entered.size());
	size_t li = 0, ei = 0;
	for (uint32_t id : known) {
		while (li < leftIds.size() && leftIds[li] < id) {
			++li; // a left id not in the known set: never sent, so no removal
		}
		if (li < leftIds.size() && leftIds[li] == id) {
			Thing* rt = map.getThingByID(id);
			if (rt) { EntityUpdate removal; rt->buildRemoval(removal); p->pushUpdate(removal); }
			++li;
			continue; // drop from the rebuilt set
		}
		while (ei < entered.size() && entered[ei].id < id) {
			p->pushUpdate(entered[ei].thing->getCachedUpdate(visibilityTick));
			merged.push_back(entered[ei].id);
			++ei;
		}
		if (ei < entered.size() && entered[ei].id == id) {
			++ei; // already known: no re-add, the single copy is kept below
		}
		merged.push_back(id);
	}
	while (ei < entered.size()) {
		p->pushUpdate(entered[ei].thing->getCachedUpdate(visibilityTick));
		merged.push_back(entered[ei].id);
		++ei;
	}
	p->knownCreatures.adoptSortedStatic(merged);
}

// The agent AI (targeting, brains, pathfinding, roaming, updateAgents) lives in
// game_agents.cpp. stepAgent stays HERE because it is the movement layer, not
// the brain: it shares collectNearbyObstacles / collisionSubstep /
// clampToMapBounds / playerOverlapsObstacle with updateMovement, and those two
// must never drift apart in how they resolve a body against the world.
void Game::stepAgent(Agent* agent, const Position& goal, uint16_t speed)
{
	const AgentData* data = agent->getData();
	const Position oldPos = agent->getPosition();
	const float oldX = static_cast<float>(oldPos.x);
	const float oldY = static_cast<float>(oldPos.y);
	float curX = oldX;
	float curY = oldY;
	const float radius = agent->getCollisionRadius();

	// The same tile slow players get via getSpeed (triggered wood_spike, road
	// boost). Applied to the voluntary step only; knockback recoil is never
	// slowed, matching players.
	if (speed > 0) {
		speed = static_cast<uint16_t>(std::max<int32_t>(10,
			static_cast<int32_t>(speed) + agent->getTileSpeedDelta()));
	}

	// Neighbourhood once: collectNearbyObstacles keeps every colliding thing, so
	// nearby agents (separation) and world geometry (collide-and-slide) are both
	// present here.
	//
	// It has to be gathered before the velocity it must cover is assembled --
	// separation reads this very list -- so the distance passed is an UPPER
	// BOUND on the four parts, each of which is capped in advance: the goal
	// step by `speed`, the separation push by AGENT_SEPARATION_MAX, the dodge
	// by its own configured speed, and the recoil by the knockback budget (it
	// is simply read here, before decay).
	//
	// A sidestep in progress, as a lateral velocity added to whatever the agent
	// was already doing. Assembled here rather than in the brain because it must
	// apply to every branch of every brain -- chasing, standing at contact,
	// walking home, roaming -- and because it is exactly a velocity: nothing
	// about a dodge changes what the agent is trying to DO.
	const uint64_t nowMs = static_cast<uint64_t>(OTSYS_TIME());
	float dodgeX = 0.0f, dodgeY = 0.0f;
	if (data && agent->isDodging(nowMs)) {
		const uint16_t dodgeSpeed = data->dodge.speed > 0 ? data->dodge.speed : agent->getMoveSpeed();
		const float perTick = static_cast<float>(dodgeSpeed) / MOVEMENT_TICKS_PER_SEC;
		dodgeX = agent->getDodgeDirX() * perTick;
		dodgeY = agent->getDodgeDirY() * perTick;
	}

	const float recX = agent->getRecoilX();
	const float recY = agent->getRecoilY();
	const float travelBound = static_cast<float>(speed) / MOVEMENT_TICKS_PER_SEC +
	                          AGENT_SEPARATION_MAX + std::sqrt(dodgeX * dodgeX + dodgeY * dodgeY) +
	                          std::sqrt(recX * recX + recY * recY);
	collectNearbyObstacles(map, agent, curX, curY, travelBound, radius, agentObstacleScratch);

	// --- assemble velocity: a GOAL part (kept even if extras are dropped) plus
	// extras (separation + knockback recoil) ---
	float goalX = 0.0f, goalY = 0.0f;
	if (speed > 0) {
		float dx = static_cast<float>(goal.x) - curX;
		float dy = static_cast<float>(goal.y) - curY;
		float dist = std::sqrt(dx * dx + dy * dy);
		if (dist > 1.0f) {
			float perTick = static_cast<float>(speed) / MOVEMENT_TICKS_PER_SEC;
			if (perTick > dist) perTick = dist; // don't overshoot the goal
			goalX = (dx / dist) * perTick;
			goalY = (dy / dist) * perTick;
		}
	}

	// Separation: soft, capped push away from other agents so a pack spreads
	// around the target instead of stacking; fades to zero at the configured
	// spacing.
	//
	// OPT-IN per agent type (agents.xml <body separation="...">). Turning it off
	// is what lets a hundred bots share one spot: this loop is O(agents in the
	// 5x5 neighbourhood) per agent, i.e. quadratic in the size of a pile, and it
	// is the only thing that would push them apart.
	//
	// Skipped entirely for an agent on its post (Agent::isOnPost): that position
	// was chosen by a player, and a force that argues with it can only lose or
	// win wrongly. It used to lose -- see the jitter described there.
	float sepX = 0.0f, sepY = 0.0f;
	if (data && data->separation && !agent->isOnPost()) {
		// Wider personal space while closing than while fighting: a pack arrives
		// on a broad front, then crowds in once it is on the target. Spread
		// during the approach costs nothing (there is room out there); insisting
		// on it at contact would just hold agents out of reach.
		const float minDist = data->spacing() * (agent->isHolding() ? 1.0f : AGENT_SEPARATION_APPROACH_SCALE);

		// Unit vector toward whatever the pack is closing on, if anything. Each
		// neighbour's push is turned to be perpendicular to THIS line, so the
		// spread slides agents around the target rather than away from it.
		float anchorX = 0.0f, anchorY = 0.0f;
		bool anchored = false;
		if (agent->hasSpreadAnchor()) {
			const float ax = static_cast<float>(agent->getSpreadAnchor().x) - curX;
			const float ay = static_cast<float>(agent->getSpreadAnchor().y) - curY;
			const float alen = std::sqrt(ax * ax + ay * ay);
			if (alen > 0.001f) {
				anchorX = ax / alen;
				anchorY = ay / alen;
				anchored = true;
			}
		}

		for (Thing* other : agentObstacleScratch) {
			Agent* b = other->getAgent();
			// One predicate for the whole question: both types must want
			// spacing, and they must not share a stack group -- agents of one
			// stack group occupy the same spot on purpose, so nothing may push
			// them apart.
			if (!agent->separatesFrom(b)) continue;
			float dx = curX - static_cast<float>(b->getPosition().x);
			float dy = curY - static_cast<float>(b->getPosition().y);
			float d = std::sqrt(dx * dx + dy * dy);
			if (d >= minDist) continue;
			if (d < 0.001f) {
				const float ang = static_cast<float>(agent->getID() % 360) * (MATH_TWO_PI / 360.0f);
				dx = std::cos(ang); dy = std::sin(ang); d = 1.0f;
			}
			const float push = (minDist - d) * AGENT_SEPARATION_GAIN;
			float dirX = dx / d;
			float dirY = dy / d;

			// TURN the push perpendicular to this agent's line to the target,
			// keeping its full strength. Two things come out of that.
			//
			// The part of a push that points along the target line is the whole
			// reason separation used to be capped at a nudge: it points away from
			// the target as often as toward it, so a crowd shoved each other
			// backwards out of melee range and then spent the next step undoing
			// the spread. Perpendicular force cannot cost forward progress.
			//
			// And it must be TURNED, not projected away. Two agents queued one
			// behind the other on the same line to the target push each other
			// almost exactly along it, so projection would discard nearly all of
			// it and leave the queue standing -- which is precisely the "train"
			// this is here to break. Turning it sends the pair sideways instead,
			// on opposite sides, chosen by id comparison so the two agents always
			// agree on who goes which way.
			if (anchored) {
				const float along = dirX * anchorX + dirY * anchorY;
				float tanX = dirX - along * anchorX;
				float tanY = dirY - along * anchorY;
				const float tanMag = std::sqrt(tanX * tanX + tanY * tanY);
				if (tanMag < 0.5f) {
					// Within ~30 degrees of the target line: a queue, not a
					// side-by-side pair. Step out rather than shuffle in place.
					const float side = (agent->getID() < b->getID()) ? 1.0f : -1.0f;
					dirX = -anchorY * side;
					dirY = anchorX * side;
				} else {
					dirX = tanX / tanMag;
					dirY = tanY / tanMag;
				}
			}

			sepX += dirX * push;
			sepY += dirY * push;
		}

		// Capped, but well above the old omnidirectional 4/tick: a push that
		// cannot cost forward progress is safe to make strong enough to see.
		const float sepMag = std::sqrt(sepX * sepX + sepY * sepY);
		if (sepMag > AGENT_SEPARATION_MAX) {
			sepX = sepX / sepMag * AGENT_SEPARATION_MAX;
			sepY = sepY / sepMag * AGENT_SEPARATION_MAX;
		}
	}

	// Knockback recoil (same decay model as player recoil). recX/recY were read
	// above, before the neighbourhood was gathered around them.
	{
		float rX = recX * RECOIL_DECAY_FACTOR;
		float rY = recY * RECOIL_DECAY_FACTOR;
		if (std::abs(rX) < RECOIL_ZERO_THRESHOLD) rX = 0.0f;
		if (std::abs(rY) < RECOIL_ZERO_THRESHOLD) rY = 0.0f;
		agent->setRecoil(rX, rY);
	}

	const float velX = goalX + sepX + dodgeX + recX;
	const float velY = goalY + sepY + dodgeY + recY;

	// --- resolve against the world, geometry and bodies alike ---
	//
	// MOVE FIRST, THEN PUSH OUT of whatever the step landed inside. This is the
	// same model Game::updateMovement uses for players, against these same round
	// resources, and it is the reason players glide around a rock while agents
	// used to stop in front of one.
	//
	// The tempting alternative -- propose a step, accept it only if the
	// destination is clear, otherwise try a slide or a single axis -- cannot work
	// on curved geometry. An agent standing in the open has zero overlap, so
	// "clear" means EXACTLY zero, and against a circle a full-length step
	// frequently has no candidate that lands perfectly clear: the full move digs
	// in, the tangent computed at the penetrating destination is not the tangent
	// at the current point so it digs in too, and a single axis is worse again.
	// Every candidate is refused and the agent freezes for that tick -- then the
	// goal has barely changed, so it freezes again. That is the random stopping.
	//
	// Push-out cannot run away with the agent either: it displaces along the
	// surface normal by exactly the penetration depth, which lands the body on
	// the surface and no further. For a head-on approach it cancels the step
	// (correct); for a graze it cancels only the radial part and the whole
	// tangential component survives, which is the glide we want.
	float overlap = 0.0f, nx = 0.0f, ny = 0.0f;

	// GEOMETRY the agent was GENUINELY EMBEDDED in when the tick began is
	// excluded from both the push-out and the safety check below, so an agent
	// that spawned in geometry or had a door close on it can walk out under its
	// own power instead of being pinned or flung.
	//
	// Creatures are deliberately not eligible. Grandfathering exists because a
	// wall cannot yield, so being inside one has to be forgiven or the agent is
	// stuck in it forever; a body CAN yield, and two overlapping bodies unstack
	// by themselves under the per-candidate allowance below.
	//
	// The `overlap > radius` threshold is load-bearing, not a tolerance. A
	// push-out lands the body EXACTLY on the surface it hit, which still counts
	// as an overlap by a rounding error's width on the next tick. Grandfathering
	// on any overlap at all therefore whitelists every obstacle the agent ever
	// brushes -- and a whitelisted obstacle is completely unenforced, so the
	// agent strolls straight through it. Requiring a real embed means only a
	// genuine "something landed on top of me" qualifies. The player resolver in
	// updateMovement uses the same threshold for the same reason.
	agentPreExistingScratch.clear();
	for (Thing* obstacle : agentObstacleScratch) {
		if (obstacle->getCreature()) continue;
		if (playerOverlapsObstacle(obstacle, oldX, oldY, radius, overlap, nx, ny) && overlap > radius) {
			agentPreExistingScratch.push_back(obstacle);
		}
	}
	const auto wasAlreadyInside = [this](Thing* obstacle) {
		return std::find(agentPreExistingScratch.begin(), agentPreExistingScratch.end(), obstacle) !=
		       agentPreExistingScratch.end();
	};

	// Runs one candidate velocity through move -> push-out -> validity, and
	// reports whether the agent would end the tick newly embedded in anything.
	// The push-out is iterated so that being shoved off one obstacle into
	// another still resolves (a gap between two rocks needs both normals).
	//
	// SWEPT in pieces, for the same reason the player resolver is: a step that
	// lands past the middle of a thin wall is pushed out of the far face, and a
	// knocked-back agent covers enough ground in one tick to do exactly that.
	// A running ghoul's own step is one piece, so this costs nothing until
	// something hits it. See collisionSubstep.
	const auto resolveStep = [&](float vx, float vy, float& outX, float& outY) -> bool {
		const float len = std::sqrt(vx * vx + vy * vy);
		const int32_t pieces =
			std::max(1, static_cast<int32_t>(std::ceil(len / collisionSubstep(radius))));
		const float pieceX = vx / pieces;
		const float pieceY = vy / pieces;

		// This candidate's allowance for pushing off BODIES; see
		// AGENT_BODY_PUSHOUT_MAX. Per candidate rather than per tick because
		// every candidate restarts from (oldX, oldY) and only the accepted one
		// is kept -- a shared budget would leave the later candidates unable to
		// resolve an overlap they were then accepted with.
		float bodyPushLeft = AGENT_BODY_PUSHOUT_MAX;

		float restX = oldX;
		float restY = oldY;
		for (int32_t piece = 0; piece < pieces; ++piece) {
			float x = restX + pieceX;
			float y = restY + pieceY;
			for (int iter = 0; iter < 3; ++iter) {
				for (Thing* obstacle : agentObstacleScratch) {
					if (wasAlreadyInside(obstacle)) continue;
					if (!playerOverlapsObstacle(obstacle, x, y, radius, overlap, nx, ny)) continue;
					if (obstacle->getCreature()) {
						// A body: resolve it, but only as far as this tick's
						// allowance goes.
						const float step = std::min(overlap, bodyPushLeft);
						if (step <= 0.0f) continue;
						bodyPushLeft -= step;
						x += nx * step;
						y += ny * step;
					} else {
						x += nx * overlap;
						y += ny * overlap;
					}
				}
			}

			// The map edge, after the push-out and before the validity test, so
			// it is a surface the agent slides along rather than something the
			// tail-end clamp yanks it back from once it is already outside.
			clampToMapBounds(x, y, radius);

			// Bodies are NOT part of this test, and that is what keeps a crowd
			// from deadlocking. The test refuses a whole step because ending it
			// inside geometry means tunnelling; refusing one because a body is
			// still overlapped means an agent with neighbours pressing from two
			// sides -- where the push-outs cancel and no candidate can ever
			// resolve -- would freeze, and so would every neighbour, permanently,
			// since nothing in a frozen pile ever moves to change the situation.
			// Bodies therefore push (above) but never veto: a crush stays soft
			// and separation spreads it out, while geometry stays absolute.
			bool wedged = false;
			for (Thing* obstacle : agentObstacleScratch) {
				if (obstacle->getCreature() || wasAlreadyInside(obstacle)) continue;
				if (playerOverlapsObstacle(obstacle, x, y, radius, overlap, nx, ny) && overlap > 0.01f) {
					wedged = true;
					break;
				}
			}
			if (wedged) {
				// Blocked before it moved at all: this candidate direction is no
				// good, so report failure and let the caller try the axes and
				// then the turn-away. Blocked PART WAY along is different -- the
				// agent got somewhere, and the rest of the motion is simply
				// absorbed by whatever stopped it.
				if (piece == 0) return false;
				break;
			}

			restX = x;
			restY = y;
		}

		outX = restX;
		outY = restY;
		return true;
	};

	// Full move first. If that would wedge the agent -- a gap narrower than its
	// body, where the two sides push it into each other and no amount of
	// iterating finds a free spot -- fall back to each axis on its own before
	// giving up. Sliding along the MOUTH of a gap it cannot fit through is what
	// lets it get to the way around; freezing there is what left it standing in
	// front of one indefinitely, because a frozen agent's goal never changes so
	// it just tries the identical step again next tick.
	bool stepped = resolveStep(velX, velY, curX, curY) ||
	               resolveStep(velX, 0.0f, curX, curY) ||
	               resolveStep(0.0f, velY, curX, curY);

	if (!stepped) {
		// WEDGED: the step and both of its axes all leave the body inside
		// something. This is the false gap -- two obstacles whose surfaces are
		// closer together than the agent is wide, which from the outside looks
		// like a gap the agent thought it could fit through. Each side pushes it
		// into the other, so no candidate above can ever resolve, and a frozen
		// agent's goal does not change: it re-proposes the identical step every
		// tick and stands in the mouth of the gap indefinitely.
		//
		// Turning the step away from the direction of travel finds the way back
		// out along one of the two surfaces. Every candidate still goes through
		// resolveStep, so none of this can put the body inside geometry; the
		// worst case is that they all fail and the agent freezes exactly as it
		// did before.
		//
		// The turn order is fixed PER AGENT (by id) instead of being re-chosen
		// each tick. An agent that tried left one tick and right the next would
		// shuffle on the spot instead of leaving; and two agents wedged in the
		// same gap pick opposite sides, so they unpack instead of fighting.
		const float mag = std::sqrt(velX * velX + velY * velY);
		if (mag > 0.01f) {
			const float baseAngle = std::atan2(velY, velX);
			const float side = (agent->getID() & 1) ? 1.0f : -1.0f;
			// 45, 90, 135 degrees: slide along the obstacle, then straight out of
			// the gap, then back the way it came.
			static constexpr float ESCAPE_TURNS[] = {0.785f, 1.571f, 2.356f};
			for (float turn : ESCAPE_TURNS) {
				const float preferred = baseAngle + turn * side;
				if (resolveStep(std::cos(preferred) * mag, std::sin(preferred) * mag, curX, curY)) {
					stepped = true;
					break;
				}
				const float other = baseAngle - turn * side;
				if (resolveStep(std::cos(other) * mag, std::sin(other) * mag, curX, curY)) {
					stepped = true;
					break;
				}
			}
		}
	}

	if (!stepped) {
		curX = oldX;
		curY = oldY;
	}

	// Belt and braces: the sweep already holds the body inside the map after
	// every piece, and this is the single narrowing conversion to the uint16 the
	// wire carries -- where a negative does not read as "outside" but as ~65000,
	// i.e. the far side of the world. clampPositionToMap does it in int32 space,
	// before the narrowing.
	clampToMapBounds(curX, curY, radius);
	const Position newPos = clampPositionToMap(static_cast<int32_t>(std::lround(curX)),
	                                           static_cast<int32_t>(std::lround(curY)));

	// Wire speed = the distance the agent ACTUALLY covers this tick, measured
	// from the ROUNDED position, because that is what start/end carry and the
	// client interpolates rx from start to end at exactly this rate. Measuring
	// the unrounded float instead disagreed with the position sent by up to
	// ~0.7px every tick.
	//
	// Rounded UP to a multiple of 10: the wire has one byte for speed/10, and
	// truncating (the old behaviour) under-reports by up to 9px/s on every
	// single tick. The client then falls progressively further behind until it
	// is >66px off and client.js updateEntitiePlayer hard-snaps it backward --
	// a periodic lurch that looks exactly like a stutter. Over-reporting only
	// makes it arrive a fraction early, where moveEntitie clamps it to the
	// target and waits for the next update.
	const float movedDX = static_cast<float>(newPos.x) - static_cast<float>(oldPos.x);
	const float movedDY = static_cast<float>(newPos.y) - static_cast<float>(oldPos.y);
	const float moved = std::sqrt(movedDX * movedDX + movedDY * movedDY);
	const uint32_t wireSpeed =
		static_cast<uint32_t>(std::ceil((moved * MOVEMENT_TICKS_PER_SEC) / 10.0f)) * 10u;
	agent->setSpeed(static_cast<uint16_t>(std::min<uint32_t>(wireSpeed, 2550u)));

	if (newPos == oldPos) return;

	agent->setPosition(newPos);

	int32_t oldTileX = oldPos.x / TILE_SIZE, oldTileY = oldPos.y / TILE_SIZE;
	int32_t newTileX = newPos.x / TILE_SIZE, newTileY = newPos.y / TILE_SIZE;
	if (oldTileX != newTileX || oldTileY != newTileY) {
		// Same step-trigger hooks the player paths run. Neither callback may
		// destroy anything inline: detonation and agent trap damage are both
		// deferred by id, so the tile lists below stay valid while they run.
		if (Tile* oldTile = map.getTile(oldTileX, oldTileY)) {
			oldTile->removeThing(agent);
			for (Thing* t : oldTile->getThings()) {
				if (Object* obj = t->getObject()) {
					obj->onCreatureLeave(agent);
				}
			}
		}
		if (Tile* newTile = map.getTile(newTileX, newTileY)) {
			newTile->addThing(agent);
			for (Thing* t : newTile->getThings()) {
				if (Object* obj = t->getObject()) {
					obj->onCreatureEnter(agent);
				}
			}
		}
	}
}

// An object's <lifetime> running out.
//
// A seed sitting in a stage that hatches BECOMES its creature rather than being
// destroyed, and that is not a fallback -- it is how the two are meant to line
// up. A seed's <lifetime> is normally exactly what its stages add up to
// (10+10+10 against a lifetime of 30), so both fire on the same second, and the
// timers cannot be relied on to agree about which second that is: the lifetime
// is a scheduler task fired at an exact delay from placement, while the stage
// clock accumulates per tick and drifts a tick later at every transition. The
// lifetime therefore ALWAYS won the race, and the seed died having produced
// nothing. Routing both outcomes through the hatch makes the result independent
// of which timer lands first.
void Game::noteRemoteObjectPlaced(uint32_t ownerPid, uint32_t objId)
{
	std::vector<uint32_t>& owned = remoteObjects[ownerPid];
	if (std::find(owned.begin(), owned.end(), objId) == owned.end()) {
		owned.push_back(objId);
	}
}

void Game::noteRemoteObjectGone(uint32_t ownerPid, uint32_t objId)
{
	auto it = remoteObjects.find(ownerPid);
	if (it == remoteObjects.end()) return;

	std::vector<uint32_t>& owned = it->second;
	owned.erase(std::remove(owned.begin(), owned.end(), objId), owned.end());
	if (owned.empty()) {
		remoteObjects.erase(it);
	}
}

uint32_t Game::fireRemoteTrigger(Player* player, const std::string& channel)
{
	if (!player || channel.empty()) return 0;

	auto it = remoteObjects.find(player->getGUID());
	if (it == remoteObjects.end()) return 0;

	// Snapshot first. Detonating destroys objects, and destruction runs
	// finishDestruction -> noteRemoteObjectGone, which mutates the very vector
	// being walked. A chain reaction (one charge's blast setting off the next)
	// can remove entries this loop has not reached yet, so the ids are copied
	// out and every one re-resolved below.
	const std::vector<uint32_t> owned = it->second;

	std::vector<uint32_t> stale;
	uint32_t fired = 0;

	for (uint32_t objId : owned) {
		Thing* thing = getThingByID(objId);
		Object* obj = thing ? thing->getObject() : nullptr;
		if (!obj || obj->isDestroyed || obj->getOwnerPid() != player->getGUID()) {
			stale.push_back(objId);
			continue;
		}

		const ObjectData* od = obj->getData();
		if (!od || od->remoteChannel != channel) continue;

		if (od->remoteAction == "detonate") {
			// Same entry point the landmine uses: destroy self and let
			// <onDestroy>'s explosion be the blast, credited to the owner.
			obj->detonate();
			++fired;
		}
	}

	for (uint32_t objId : stale) {
		noteRemoteObjectGone(player->getGUID(), objId);
	}

	return fired;
}

void Game::expireObject(Object* obj)
{
	if (!obj || obj->isDestroyed) return;

	if (const ObjectData* od = obj->getData()) {
		const ObjectStage* stage = od->getStage(obj->getSubtype());
		if (stage && !stage->spawnCreature.empty()) {
			hatchStageCreatures(obj, *stage);
			return;
		}
	}

	obj->changeHealth(-obj->getHealth(), 0, nullptr);
}

void Game::updateAgentSpawns()
{
	const uint64_t startedAt = OTSYS_TIME();

	// Cadence comes from the mode, but this loop wakes on a fixed short period:
	// reading the clock often is what lets the very first batch land promptly at
	// dusk rather than up to one long respawnDelayMs into the night.
	const uint32_t periodMs = (activeMode && activeMode->agentsRespawnDelayMs > 0)
		? activeMode->agentsRespawnDelayMs
		: AGENT_SPAWN_DEFAULT_PERIOD_MS;

	const auto reschedule = [this, startedAt]() {
		g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, AGENT_SPAWN_PERIOD_MS),
			[this]() { this->updateAgentSpawns(); }));
	};

	static uint64_t nextSpawnAt = 0;
	if (startedAt < nextSpawnAt) {
		reschedule();
		return;
	}
	nextSpawnAt = startedAt + periodMs;

	// A scenario holds only the creatures its author opted into.
	const bool scenarioForbids = activeScenario && !activeScenario->project.world.generateAgents;
	if (!activeMode || activeMode->agentSpawns.empty() || scenarioForbids) {
		reschedule();
		return;
	}

	// Which types may spawn at this hour. Gated per type on `time` rather than
	// globally: ghouls are a night phenomenon -- the world makes them after dark
	// and the sun takes them back (<daylight> in agents.xml), so the population
	// is a sawtooth rather than a steady state, which is what gives the map a day
	// to recover in. But the schema is per type on purpose, so a mode can still
	// field something around the clock without this loop being rewritten.
	//
	// Built before anything is counted, so the daytime path -- the common one --
	// costs a walk of the mode's short spawn table and nothing else.
	const bool night = isNight();
	std::vector<const AgentSpawn*> eligible;
	for (const AgentSpawn& spawn : activeMode->agentSpawns) {
		if (spawn.time == (night ? "day" : "night")) continue;
		if (!g_agents.getAgentData(spawn.key)) continue; // unknown key: warned at load
		eligible.push_back(&spawn);
	}
	if (eligible.empty()) {
		reschedule();
		return;
	}

	// Alive counts, WORLD-SPAWNED ONLY. Player-built bots share the Agent class
	// but must not consume the world's budget, or a base full of lapabots would
	// quietly stop the night from spawning anything at all.
	std::unordered_map<std::string, uint32_t> aliveByKey;
	uint32_t aliveTotal = 0;
	for (const Map::MobileEntry& entry : map.getMobiles()) {
		const Agent* agent = entry.thing->getAgent();
		if (!agent || agent->isDying() || agent->getOwnerGuid() != 0) continue;
		const AgentData* ad = agent->getData();
		if (!ad) continue;
		++aliveByKey[ad->key];
		++aliveTotal;
	}

	// Population ceiling for the mode: the ACHIEVABLE one, which is the lower of
	// maxTotal and what the per-type caps actually add up to. It has to be the
	// real number, because the ramp below divides by it -- sizing batches against
	// a maxTotal the per-type caps will never let the map reach would spawn the
	// whole population in the first few ticks and then stop, i.e. exactly the
	// wall of ghouls the ramp exists to avoid. A maxAlive of 0 means that type is
	// uncapped, so the sum stops meaning anything and maxTotal alone governs.
	// Both caps are authored against the REFERENCE map and scaled by area, the
	// same way resources and structures are -- otherwise a 655x655 world holds
	// the same 200 ghouls as a 150x150 one across nineteen times the ground,
	// and a player could cross it without meeting anything. Density, not the
	// tile budget: agents take no permanent ground, so there is nothing to
	// charge them against. See MapSize::densityScale.
	//
	// 0 still means "uncapped" -- tested on the RAW value before scaling, and
	// ContentScale::apply(0) is 0 anyway.
	const MapSize::ContentScale agentDensity = MapSize::densityScale();

	uint32_t perTypeSum = 0;
	bool anyUncapped = false;
	for (const AgentSpawn& spawn : activeMode->agentSpawns) {
		if (spawn.maxAlive == 0) {
			anyUncapped = true;
			break;
		}
		perTypeSum += agentDensity.apply(spawn.maxAlive);
	}
	uint32_t ceiling = agentDensity.apply(activeMode->agentsMaxTotal);
	if (ceiling == 0) {
		// No mode-wide cap: the per-type caps are the only limit there is. If
		// they are absent too then nothing bounds the population, and spawning
		// without a bound is the one outcome worse than spawning nothing.
		ceiling = anyUncapped ? 0 : perTypeSum;
	} else if (!anyUncapped) {
		ceiling = std::min(ceiling, perTypeSum);
	}

	// A HARD ceiling on the scaled population, applied LAST so it binds
	// whichever way the ceiling above was arrived at -- including the
	// "uncapped, per-type sum only" branch.
	//
	// Agent AI does not scale the way placed content does. Measured on this box
	// at 655x655 with the area factor applied and NO CLIENTS CONNECTED: ~3,796
	// agents put `move` (where updateAgents is billed) at 36-41 ms of a 50 ms
	// budget, dropping the server to 13.5-14.2 ticks/s with overruns. A tree
	// costs nothing per tick; a ghoul costs roughly 10 us of pathfinding and
	// collision, every tick, forever.
	//
	// So density scaling is right in principle and has to be bounded in
	// practice. 0 = no cap, for anyone who has measured their own hardware.
	// Never binds at the reference size, where the mode asks for 200.
	if (const uint32_t agentCap = static_cast<uint32_t>(
			std::max(0, getNumber(ConfigManager::AGENT_POPULATION_CAP)));
	    agentCap != 0 && (ceiling == 0 || ceiling > agentCap)) {
		ceiling = agentCap;
	}

	if (ceiling == 0 || aliveTotal >= ceiling) {
		reschedule();
		return;
	}

	// Drop the types already at their own cap, and total the weights of what is
	// left. Done after counting because it needs those counts.
	// Against the SCALED per-type cap, like the mode-wide ceiling above. Using
	// the raw XML number here would pin every type at its reference count on a
	// big map and let only the total grow -- which the per-type sum then caps
	// straight back down, so nothing would scale at all.
	uint32_t weightTotal = 0;
	for (size_t i = eligible.size(); i-- > 0;) {
		const AgentSpawn* spawn = eligible[i];
		if (spawn->maxAlive > 0 &&
		    aliveByKey[spawn->key] >= agentDensity.apply(spawn->maxAlive)) {
			eligible.erase(eligible.begin() + i);
			continue;
		}
		weightTotal += std::max<uint32_t>(1, spawn->weight);
	}
	if (eligible.empty()) {
		reschedule();
		return;
	}

	// How many this tick. Sized so a full population fills in
	// AGENT_SPAWN_FILL_FRACTION of the night -- see the constant: releasing them
	// all at dusk is a wall of ghouls in one frame, and trickling them across the
	// whole night means the last arrivals burn at dawn without ever having done
	// anything.
	const uint32_t nightMs = std::max<uint32_t>(1, activeMode->dayNightCycle / 2);
	const uint32_t rampMs =
		std::max<uint32_t>(periodMs, static_cast<uint32_t>(nightMs * AGENT_SPAWN_FILL_FRACTION));
	const uint32_t ticksInRamp = std::max<uint32_t>(1, rampMs / periodMs);
	uint32_t batch = std::max<uint32_t>(1, (ceiling + ticksInRamp - 1) / ticksInRamp);
	batch = std::min(batch, ceiling - aliveTotal);

	for (uint32_t i = 0; i < batch; ++i) {
		// Weighted pick among whatever still has room.
		int32_t roll = uniform_random(0, static_cast<int32_t>(weightTotal) - 1);
		const AgentSpawn* chosen = eligible.back();
		for (const AgentSpawn* candidate : eligible) {
			roll -= static_cast<int32_t>(std::max<uint32_t>(1, candidate->weight));
			if (roll < 0) {
				chosen = candidate;
				break;
			}
		}

		const AgentData* data = g_agents.getAgentData(chosen->key);
		if (!data) continue;

		Position spawnPos;
		if (!findAgentSpawnPosition(data, spawnPos)) {
			// Nowhere legal right now (a crowded or heavily built map). The next
			// tick is a second away and the target has not moved, so this costs
			// only a slightly slower ramp.
			continue;
		}

		// ownerGuid 0: spawned by the world, so it roams and hunts rather than
		// guarding a post, and it counts against the budget measured above.
		Agent* agent = g_agents.createAgent(chosen->key, spawnPos, 0);
		if (!agent) {
			break; // id band exhausted; nothing else will succeed this tick either
		}
		if (!placeThing(agent, spawnPos)) {
			delete agent; // refcount still 0
			continue;
		}

		++aliveByKey[chosen->key];
		++aliveTotal;

		// Re-check the caps this batch has just moved. Scaled, as above.
		if (chosen->maxAlive > 0 &&
		    aliveByKey[chosen->key] >= agentDensity.apply(chosen->maxAlive)) {
			eligible.erase(std::remove(eligible.begin(), eligible.end(), chosen), eligible.end());
			weightTotal = 0;
			for (const AgentSpawn* remaining : eligible) {
				weightTotal += std::max<uint32_t>(1, remaining->weight);
			}
			if (eligible.empty()) break;
		}
		if (aliveTotal >= ceiling) break;
	}

	reschedule();
}

void Game::updateMovement()
{
	g_perf.beginTick();

	static uint64_t lastMovementUpdate = OTSYS_TIME();
	uint64_t now = OTSYS_TIME();
	uint32_t elapsedMs = static_cast<uint32_t>(now - lastMovementUpdate);
	lastMovementUpdate = now;


	g_npcs.update(elapsedMs);
	scenario::tickPopulation();
	g_quests.update(elapsedMs);
	g_progress.update(elapsedMs);
	g_scripts.update(elapsedMs);
	updateWorldTime(elapsedMs);
	updateProjectiles(elapsedMs);
	g_perf.markPhase(TickProfiler::PHASE_PROJECTILES);

	removeExpiredTakenLoot(now);
	g_perf.markPhase(TickProfiler::PHASE_LOOTSWEEP);

	std::vector<Thing*> movedThings;

	// Collision scratch, reused by every player: these were allocated and freed
	// per moving player per tick. collectNearbyObstacles clears `nearby` itself;
	// `preExisting` is cleared at its use site.
	std::vector<Thing*> nearby;
	std::vector<Thing*> preExisting;

	for (const auto& it : players) {
		Player* player = it.second;

		// Fresh cosmetic-event allowance for this tick (see broadcastToWatchers).
		player->eventFramesThisTick = 0;

		player->updateGauges(elapsedMs);
		getActiveInteractionObject(player); // per-tick range check: closes the opened station/container when out of range
		uint8_t mask = player->getMoveMask();
		float finalDx = 0.0f;
		float finalDy = 0.0f;

		// A stun takes away the player's OWN movement and nothing else. Gated
		// here, on the intent, rather than on getSpeed(): that value is also the
		// wire speed the client dead-reckons with, so zeroing it froze the sprite
		// while knockback kept sliding the body underneath it.
		//
		// The mask itself is left alone, so a key held through a stun resumes on
		// its own when the stun ends instead of needing to be re-pressed. Recoil
		// is read below this block and is deliberately untouched by it: being
		// shoved is done TO you, and a stunned player must still be knockable out
		// of a doorway.
		if (mask != 0 && !player->cannot(CONTROL_NO_MOVE)) {
			int32_t dx = 0, dy = 0;
			if (mask & 1) dx -= 1;
			if (mask & 2) dx += 1;
			if (mask & 4) dy += 1;
			if (mask & 8) dy -= 1;
			if (dx != 0 || dy != 0) {
				float length = std::sqrt(static_cast<float>(dx * dx + dy * dy));
				float speedPerTick = player->getSpeed() / MOVEMENT_TICKS_PER_SEC;
				finalDx = (static_cast<float>(dx) / length) * speedPerTick;
				finalDy = (static_cast<float>(dy) / length) * speedPerTick;
			}
		}

		// Whether the player's own step got them anywhere: the stamina drain
		// reads it next tick, so pushing into a wall with Shift burns nothing.
		bool walked = false;
		if (finalDx != 0.0f || finalDy != 0.0f || player->recoilX != 0.0f || player->recoilY != 0.0f) {
			Position oldPos = player->getPosition();
			Position newPos = oldPos;

			// Where this tick WANTS to end up. Resolved toward in pieces below,
			// so it is a destination rather than a position.
			float currentX = static_cast<float>(oldPos.x) + finalDx + player->recoilX;
			float currentY = static_cast<float>(oldPos.y) + finalDy + player->recoilY;

			// How far this tick MEANT to travel, captured here because both of
			// the things that shorten it come later: the map-edge clamp below and
			// the collision sweep after that. It is the budget the full-speed
			// slide spends what is left of (see SLIDE_MIN_PROGRESS), so it has to
			// be the intent and not the outcome -- measuring the outcome after
			// the clamp is what would leave the MAP EDGE, the most obvious case
			// of all, reporting nothing left to spend.
			const float desiredDx = finalDx + player->recoilX;
			const float desiredDy = finalDy + player->recoilY;
			const float desiredLen = std::sqrt(desiredDx * desiredDx + desiredDy * desiredDy);

			// Decay recoil (smooth reduction)
			player->recoilX *= RECOIL_DECAY_FACTOR;
			player->recoilY *= RECOIL_DECAY_FACTOR;
			if (std::abs(player->recoilX) < RECOIL_ZERO_THRESHOLD) player->recoilX = 0;
			if (std::abs(player->recoilY) < RECOIL_ZERO_THRESHOLD) player->recoilY = 0;

			// --- Collision Detection & Resolution ---
			float playerRadius = player->getCollisionRadius();

			// Keep the player's full body inside the map bounds. This call only
			// keeps the DESTINATION sane -- what actually holds the player in is
			// the same clamp re-applied after every piece of the sweep below.
			clampToMapBounds(currentX, currentY, playerRadius);

			// --- Player-vs-object collision (post-move resolution) ---
			// Obstacles the player was ALREADY overlapping at the start of the
			// tick are "pre-existing" overlaps: an object landed on the player
			// (a door swinging shut on them, spawn overlap) rather than the
			// player walking into it this tick. Only those are governed by the
			// pushPlayerOutOfObjects config: fresh contacts are plain movement
			// collision and always apply, so walls keep blocking normally even
			// when the push-out is disabled.
			// Ghost mode only. This used to read `getGhoul() == 0 &&`, which
			// skipped the WHOLE resolution below -- walls, buildings, resources,
			// other bodies -- so a ghoul had no geometry at all and walked
			// through the map. That is the movement half of the same assumption
			// Creature::hasCollision carried (see the note there): while `ghoul`
			// was a field nothing ever set, "ghoul" and "noclip" were
			// indistinguishable, and both spellings survived. A ghoul is a body
			// like any other and collides like one.
			if (!player->isGhostMode()) {
				const bool pushOutEnabled = getBoolean(ConfigManager::PUSH_PLAYER_OUT_OF_OBJECTS);
				const float oldX = static_cast<float>(oldPos.x);
				const float oldY = static_cast<float>(oldPos.y);

				float overlap = 0.0f, nx = 0.0f, ny = 0.0f;

				// How far this tick actually carries the player: a step, or a
				// step plus a knockback, which is several times larger. Its LENGTH
				// is no longer needed here -- sweepMotion measures whatever vector
				// it is handed, and the slide budget is desiredLen above.
				const float sweepX = currentX - oldX;
				const float sweepY = currentY - oldY;

				// Gathered ONCE per tick and reused by every pass below.
				// This used to run five times per moving player per tick (the
				// pre-existing scan, three resolution iterations and the
				// anti-tunnel check), each sweeping 25 tiles. Re-gathering is
				// pointless: the box already covers everywhere this tick's
				// motion can reach, and a push-out step is capped smaller still,
				// so the window computed at the tick-start position contains
				// every obstacle the player can possibly touch this tick.
				//
				// Sized on desiredLen rather than sweepLen: the two differ only
				// when the edge clamp shortened the step, and the slide retry
				// hands that difference back as motion along the edge -- which
				// this neighbourhood has to already cover, since it is not
				// gathered again.
				preExisting.clear();
				collectNearbyObstacles(map, player, oldX, oldY, desiredLen, playerRadius, nearby);
				for (Thing* obstacle : nearby) {
					// Require a GENUINE embed (the player's collision center is
					// substantially inside the obstacle) before grandfathering it
					// into the optional push-out path. A small fixed threshold is
					// not enough: normal diagonal movement along a round object's
					// curved edge produces shallow, slowly-changing grazes (unlike
					// flat-sided rects, where near misses and solid hits are far
					// more common than a stable shallow graze) that would
					// otherwise get misclassified as "pre-existing" on the very
					// next tick — and once grandfathered, with push-out disabled,
					// that obstacle is completely unenforced for as long as the
					// player keeps overlapping it, letting them walk straight
					// through. Scaling the threshold to the player's own radius
					// means only a real embed (e.g. a door landing on the player)
					// qualifies.
					if (playerOverlapsObstacle(obstacle, oldX, oldY, playerRadius, overlap, nx, ny) && overlap > playerRadius) {
						preExisting.push_back(obstacle);
					}
				}

				const auto isPreExisting = [&preExisting](Thing* obstacle) {
					return std::find(preExisting.begin(), preExisting.end(), obstacle) != preExisting.end();
				};

				// The push-out cap is a per-TICK budget, so it is spent across the
				// pieces rather than granted to each one -- and across the slide
				// retry below, which is the same tick's motion continuing.
				float pushOutLeft = MAX_PUSHOUT_PER_TICK;

				// One swept resolution of one motion vector. A lambda because a
				// blocked step runs it TWICE (see the slide retry below); the body
				// is exactly the pass this has always done.
				const auto sweepMotion = [&](float startX, float startY, float moveX, float moveY,
				                             float& outX, float& outY) {
					// SWEPT toward the destination rather than resolved at it. Testing
					// only the endpoint is what let a knockback throw a player through
					// the wall they were standing beside: land past its middle and the
					// push-out obligingly ejects them out of the far face. See
					// collisionSubstep for why the piece size comes from the body.
					//
					// Walking and sprinting are one piece, so this is the same single
					// pass it always was; only a player who has just been hit does more.
					const float moveLen = std::sqrt(moveX * moveX + moveY * moveY);
					const int32_t pieces = std::max(1,
						static_cast<int32_t>(std::ceil(moveLen / collisionSubstep(playerRadius))));

					// Each piece steps on from where the LAST one was resolved to, not
					// from a point on the original line: a piece that slid along a wall
					// would otherwise be yanked straight back onto it by the next one.
					const float pieceX = moveX / pieces;
					const float pieceY = moveY / pieces;

					outX = startX;
					outY = startY;
					for (int32_t piece = 0; piece < pieces; ++piece) {
						const float pieceStartX = outX;
						const float pieceStartY = outY;
						float x = outX + pieceX;
						float y = outY + pieceY;

						// Multi-iteration collision resolution to prevent squeezing
						for (int iter = 0; iter < 3; ++iter) {
							for (Thing* obstacle : nearby) {
								if (!playerOverlapsObstacle(obstacle, x, y, playerRadius, overlap, nx, ny)) {
									continue;
								}

								if (isPreExisting(obstacle)) {
									// Push-out of an object that landed on the player:
									// optional, and capped per tick so a deep overlap can
									// never carry the player far in one motion. With the
									// push disabled the player simply walks out freely.
									if (!pushOutEnabled) continue;
									const float step = std::min(overlap, pushOutLeft);
									if (step <= 0.0f) continue;
									pushOutLeft -= step;
									x += nx * step;
									y += ny * step;
								} else {
									// Plain movement collision: fully cancel this piece's
									// penetration (it is at most one piece deep).
									x += nx * overlap;
									y += ny * overlap;
								}
							}
						}

						// The map edge, AFTER the push-out rather than before it. This
						// is the one that matters: a pack crowding someone standing on
						// the edge pushes them out of the world, and a uint16 coordinate
						// turns "just outside" into the far side of the map.
						clampToMapBounds(x, y, playerRadius);

						// Hard anti-tunnel guarantee: never end a piece newly penetrating
						// an obstacle. If the resolution above squeezed the player into
						// (or across) something they were not already inside — e.g. a
						// closing door pushing them against a thin wall while they hold a
						// movement key — fall back to where this piece began, which is
						// valid for every non-pre-existing obstacle by construction, and
						// stop: the rest of the motion is absorbed by whatever it hit.
						bool wedged = false;
						for (Thing* obstacle : nearby) {
							if (isPreExisting(obstacle)) continue;
							if (playerOverlapsObstacle(obstacle, x, y, playerRadius, overlap, nx, ny) && overlap > 0.01f) {
								wedged = true;
								break;
							}
						}
						if (wedged) {
							outX = pieceStartX;
							outY = pieceStartY;
							break;
						}

						outX = x;
						outY = y;
					}
				};

				sweepMotion(oldX, oldY, sweepX, sweepY, currentX, currentY);

				// FULL-SPEED SLIDE. Whatever of this tick's step the sweep above
				// failed to spend is spent again along the direction the player
				// actually ended up moving, so a body stopped by geometry on one
				// axis keeps its full speed on the other.
				//
				// This is the bug where walking the top edge of the map is FASTER
				// on "right" alone than on "up+right". The input vector is
				// normalised before anything knows what is in the way, so two keys
				// give sqrt(2)/2 of the speed to each axis; the edge then eats the
				// "up" half and the player crawls along it at 71%. The retry uses
				// the RESOLVED direction, so it follows the surface whatever shape
				// it is -- an axis-aligned wall, the map edge, or the curved side
				// of a rock.
				//
				// Bounded by construction: the retry spends only what the first
				// pass did not, so a tick still covers at most one tick's distance,
				// and it goes through the same sweep, so it cannot end inside
				// geometry. See SLIDE_MIN_PROGRESS for the two guards.
				const float gainedX = currentX - oldX;
				const float gainedY = currentY - oldY;
				const float gainedLen = std::sqrt(gainedX * gainedX + gainedY * gainedY);
				const float unspent = desiredLen - gainedLen;
				if (mask != 0 && gainedLen > SLIDE_MIN_PROGRESS && unspent > SLIDE_MIN_LEFTOVER) {
					sweepMotion(currentX, currentY,
					            (gainedX / gainedLen) * unspent,
					            (gainedY / gainedLen) * unspent,
					            currentX, currentY);
				}
			}

			// Through clampPositionToMap, not a raw cast. The float is already
			// inside the map by construction above, but this is the one narrowing
			// conversion between all of that work and the wire, and getting it
			// wrong does not produce a slightly wrong position -- a uint16 turns
			// any negative into ~65000 and drops the player on the far side of
			// the world. The clamp happens in int32 space, before the narrowing,
			// so nothing can reach the cast out of range.
			newPos = clampPositionToMap(static_cast<int32_t>(std::lround(currentX)),
			                            static_cast<int32_t>(std::lround(currentY)));
			player->setPosition(newPos);
			walked = (finalDx != 0.0f || finalDy != 0.0f) && newPos != oldPos;

			int32_t oldTileX = oldPos.x / TILE_SIZE, oldTileY = oldPos.y / TILE_SIZE;
			int32_t newTileX = newPos.x / TILE_SIZE, newTileY = newPos.y / TILE_SIZE;
			if (oldTileX != newTileX || oldTileY != newTileY) {
				Tile* oldTile = map.getTile(oldTileX, oldTileY);
				if (oldTile) {
					oldTile->removeThing(player);
					for (Thing* t : oldTile->getThings()) {
						if (Object* obj = t->getObject()) {
							obj->onCreatureLeave(player);
						}
					}
				}

				Tile* newTile = map.getTile(newTileX, newTileY);
				if (newTile) {
					newTile->addThing(player);
					for (Thing* t : newTile->getThings()) {
						if (Object* obj = t->getObject()) {
							obj->onCreatureEnter(player);
						}
					}
				}
			}
		}

		player->setWalkedLastTick(walked);
		player->updateVisualPosition(elapsedMs);
		player->updateActions();
	}

	// Agent AI runs here, after players have moved and before the dirty scan, so
	// any agent that moved this tick is picked up and sent by the visibility diff.
	updateAgents();

	g_perf.markPhase(TickProfiler::PHASE_MOVEMENT);

	// The result is cached on each thing as well as collected, so the
	// visibility loop below can read a bool instead of re-asking. See
	// Thing::cacheDirty.
	//
	// Only the entities that CAN be dirty are visited. Thing::isDirty() is a
	// hardcoded false for everything except Creature (players and agents, all
	// mobile) and Loot, and Map maintains an index of each -- so walking
	// map.getThings() meant a virtual call per STATIC entity per tick to be
	// told "false" by a function that cannot return anything else.
	//
	// It did not matter at 150x150 (6,970 things, 0.15 ms). It is the first
	// cost in the server that scales with WORLD SIZE rather than player count,
	// and at 655x655 with content scaled to match it measured 3.02 ms of a
	// 3.11 ms tick across 132,575 things -- with NO CLIENTS CONNECTED.
	//
	// Static things are never written by cacheDirty now, which is correct
	// rather than merely tolerable: dirtyCached is false from construction and
	// isMobile()/the Loot type are fixed for an object's lifetime, so nothing
	// can leave a stale true behind.
	for (const Map::MobileEntry& entry : map.getMobiles()) {
		const bool dirty = entry.thing->isDirty();
		entry.thing->cacheDirty(dirty);
		if (dirty) movedThings.push_back(entry.thing);
	}
	for (Loot* loot : map.getLoots()) {
		const bool dirty = loot->isDirty();
		loot->cacheDirty(dirty);
		if (dirty) movedThings.push_back(loot);
	}
	g_perf.markPhase(TickProfiler::PHASE_DIRTY_SCAN);

	// Scratch buffers hoisted out of the per-player loop. The visibility diff
	// used to build a fresh std::vector, a std::set and a second std::vector
	// for EVERY player EVERY tick; at 500 players that is on the order of a
	// million container-node allocations per second, which on its own was a
	// large share of the tick. clear() keeps the capacity, so after the first
	// few ticks these stop allocating entirely.
	std::vector<Thing*> newSpectators;
	std::vector<VisibleEntity> visible;
	std::vector<uint32_t> nextKnown;
	// Extra scratch for the incremental static-viewport update (entered strip
	// {id, thing} pairs and left strip ids; the rebuilt known set reuses
	// nextKnown). Same reuse pattern: clear() keeps capacity, so they stop
	// allocating after the first few ticks.
	std::vector<VisibleEntity> enteredStatics;
	std::vector<uint32_t> leftIds;

	++visibilityTick;
	if (visibilityTick == 0) {
		visibilityTick = 1; // 0 means "never built" on a Thing
	}

	TickProfiler::TickSample sample;
	sample.players = players.size();
	sample.things = map.getThings().size();
	sample.projectiles = projectiles.size();

	// Hoisted: getSpectators read these two config values on every call, i.e.
	// once per player per tick.
	const int32_t viewX = getNumber(ConfigManager::MAX_VIEWPORT_X);
	const int32_t viewY = getNumber(ConfigManager::MAX_VIEWPORT_Y);
	const uint32_t entityUpdateBudget =
		static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::ENTITY_UPDATES_PER_TICK)));
	// 0 means "no separate projectile range", expressed as a bound nothing can
	// reach so the per-entity test stays a plain compare.
	int32_t projViewRadius = getNumber(ConfigManager::PROJECTILE_VIEW_RADIUS);
	if (projViewRadius <= 0) projViewRadius = std::max(viewX, viewY);

	// One pass over the movers, so every player below scans the same fresh,
	// cache-resident snapshot.
	map.refreshMobilePositions();

	// This tick's static removals, sorted ONCE for all clients. Every player
	// below merges the same list out of their static known set in one pass.
	staticRemovalScratch.clear();
	if (!pendingStaticRemovals.empty()) {
		staticRemovalScratch.assign(pendingStaticRemovals.begin(), pendingStaticRemovals.end());
		std::sort(staticRemovalScratch.begin(), staticRemovalScratch.end());
	}

	// Sub-phase attribution for `spec`; see TickProfiler::addSpectatorTiming.
	// One clock read per player per boundary rather than per entity: at 250
	// clients that is ~2,000 reads a tick, against the 62,500 the inner scan
	// would cost if it were timed per entry.
	uint64_t specScanNs = 0, specDiffNs = 0, specEraseNs = 0, specStaticNs = 0;
	uint64_t specShifts = 0;
	const auto specSince = [](std::chrono::steady_clock::time_point t0) {
		return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
			std::chrono::steady_clock::now() - t0).count());
	};

	updateTrades();
	const uint64_t aimNowMs = static_cast<uint64_t>(OTSYS_TIME());
	for (const auto& it : players) {
		Player* p = it.second;
		// Every player, connected or not, settles aim state here once per tick.
		p->updateAim(viewX, viewY, aimNowMs);
		if (!p->client) continue;
		++sample.clients;
		auto specMark = std::chrono::steady_clock::now();

		const Position& ppos = p->getPosition();
		// The player's view this tick (Player::updateAim): the viewport box, or
		// that box stretched or shifted toward an aimed scope.
		// Copied by value so the four bounds stay in registers through the scan.
		const ViewBox viewBox = p->getView().box;
		const Map::TileBox box = Map::offsetTileBox(ppos, viewBox.minDX, viewBox.minDY, viewBox.maxDX, viewBox.maxDY);

		// --- mobile half: creatures and projectiles, every tick -------------
		//
		// A flat scan of every mobile entity, not a tile sweep: the position is
		// inline in the index, so a rejected entity costs four integer compares
		// against L1-resident data and never touches the Thing. See
		// Map::MobileEntry for why that beats probing 2601 tiles per player.
		//
		// The exact per-axis viewport test is kept for this half, so which
		// players and projectiles a client can see is byte-identical to before
		// the static/mobile split. Only scenery moved to tile granularity, and
		// only because scenery cannot move: who sees whom first is a gameplay
		// property and must not shift by a tile.
		//
		// Hidden ghosts are dropped rather than special-cased: absent from the
		// visible set, the merge sees them as no-longer-visible and emits
		// exactly the removal the old explicit branch did.
		const std::vector<Map::MobileEntry>& allMobiles = map.getMobiles();
		sample.visited += allMobiles.size();

		visible.clear();
		// The filters every mobile passes after the view test.
		//
		// Projectiles get their own, tighter range: their cost is one
		// appearance plus one removal per observer over a ~450ms life, so
		// they are the class the per-tick update budget cannot help. See
		// ConfigManager::PROJECTILE_VIEW_RADIUS.
		//
		// The class comes from the id already in the MobileEntry, not from
		// a downcast on the Thing: this is the innermost loop of the
		// visibility sweep and the whole point of the entry being 16 bytes
		// is that a rejected entity never touches the Thing at all.
		const auto keep = [&](const Map::MobileEntry& entry, int32_t sdx, int32_t sdy) {
			if ((std::abs(sdx) >= projViewRadius || std::abs(sdy) >= projViewRadius) &&
			    entry.id >= PROJECTILE_ID_MIN) {
				return false;
			}
			if (entry.thing->isVisualSuppressed()) {
				return false;
			}
			Creature* creature = entry.thing->getCreature();
			Player* specPlayer = creature ? creature->getPlayer() : nullptr;
			return !(specPlayer && specPlayer != p && specPlayer->isGhostMode() && !specPlayer->isGhostVisible());
		};
		const StrongView& strong = p->getView().strong;
		if (strong.shape == ViewShape::None) {
			for (const Map::MobileEntry& entry : allMobiles) {
				const int32_t sdx = static_cast<int32_t>(entry.x) - static_cast<int32_t>(ppos.x);
				const int32_t sdy = static_cast<int32_t>(entry.y) - static_cast<int32_t>(ppos.y);
				// Strict, as the old |d| < viewport test: unchanged for anyone not aiming.
				// The observer's own record is always sent, whatever a scope does to the box.
				if (!viewBox.containsStrict(sdx, sdy) && entry.thing != p) {
					continue;
				}
				if (keep(entry, sdx, sdy)) visible.push_back({entry.id, entry.thing});
			}
		} else {
			// A strong scope: the bounds, then the rear circle, then the shape --
			// the outer shape for what the client already has and the inner one
			// for the rest, so an entity on the edge does not flicker while the
			// aim wavers. `allMobiles` and the known half are both in id order,
			// so the known check is a cursor that only moves forward.
			aim_view::KnownCursor known{p->knownCreatures.mobile()};
			const ViewBox bounds = strong.bounds;
			for (const Map::MobileEntry& entry : allMobiles) {
				const int32_t sdx = static_cast<int32_t>(entry.x) - static_cast<int32_t>(ppos.x);
				const int32_t sdy = static_cast<int32_t>(entry.y) - static_cast<int32_t>(ppos.y);
				// The observer's own record is always sent.
				if (entry.thing != p && !(bounds.containsInclusive(sdx, sdy) &&
				                          aim_view::strongContains(strong, sdx, sdy, known.has(entry.id)))) {
					continue;
				}
				if (keep(entry, sdx, sdy)) visible.push_back({entry.id, entry.thing});
			}
		}

		specScanNs += specSince(specMark);
		specMark = std::chrono::steady_clock::now();

		// No sort here: Map::refreshMobilePositions leaves `mobiles` ordered by
		// id once per tick, and this loop appends in scan order, so `visible` is
		// already sorted -- which is all diffVisibleSet's merge requires.
		diffVisibleSet(p, visible, p->knownCreatures.mobile(), nextKnown, map, visibilityTick,
		               entityUpdateBudget);
		p->knownCreatures.adoptSortedMobile(nextKnown);

		specDiffNs += specSince(specMark);
		specMark = std::chrono::steady_clock::now();

		// This tick's static destructions, merged out in one pass. Outside the
		// box check below on purpose: a player whose viewport did not shift
		// still has to drop what was destroyed, and not shifting is the common
		// case. See Game::pendingStaticRemovals.
		if (!staticRemovalScratch.empty()) {
			p->knownCreatures.eraseSortedStatic(staticRemovalScratch);
		}

		specEraseNs += specSince(specMark);
		specMark = std::chrono::steady_clock::now();

		// --- static half: only when the viewport box actually moved ---------
		//
		// A static entity cannot move, so its membership in this player's view
		// changes only when the box does. Creation, destruction and state
		// changes reach the client through broadcastSurgicalUpdate, which also
		// maintains knownCreatures, so nothing is lost by not re-deriving them
		// here. On a tick where the box is unchanged this whole half is skipped
		// -- and at maxViewport 2500 it is ~800 of the ~830 entities in view.
		//
		// When it DOES shift, only the entering/leaving tile strips are visited,
		// not the whole box -- see updateStaticViewport. The box's own edges are
		// the previous tile box, which is exactly what p->staticBox* holds.
		const Map::TileBox oldBox{ p->staticBoxMinX, p->staticBoxMinY,
		                           p->staticBoxMaxX, p->staticBoxMaxY };
		if (!(box == oldBox)) {
			updateStaticViewport(p, oldBox, box, map, visibilityTick,
			                     newSpectators, enteredStatics, leftIds, nextKnown, sample.visited);

			p->staticBoxMinX = box.minX;
			p->staticBoxMinY = box.minY;
			p->staticBoxMaxX = box.maxX;
			p->staticBoxMaxY = box.maxY;
			++specShifts;
		}

		// --- concealed objects: by side and distance, every tick ------------
		//
		// Landmines and wiring are sent only to their owner's side and to
		// whoever is within their reveal range, so their membership in a view
		// changes as the PLAYER moves, like a mobile's -- but there are tens of
		// them, so a flat pass over the registry is the whole cost.
		updateConcealedVisibility(p, box, visibilityTick);
		specStaticNs += specSince(specMark);
	}
	g_perf.addSpectatorTiming(specScanNs, specDiffNs, specEraseNs, specStaticNs);
	g_perf.addStaticShifts(specShifts);
	g_perf.markPhase(TickProfiler::PHASE_SPECTATORS);

	// Split out of the visibility loop above so the profiler can attribute
	// socket time separately; per-player ping/flush is independent, so the
	// ordering change is not observable.
	for (const auto& it : players) {
		Player* p = it.second;
		if (!p->client) continue;
		sample.records += p->pendingUpdates.size();
		p->client->flushUpdates();
		p->sendKeepAlive(); // after the flush: real traffic makes it a no-op

		// Everything this tick produced for this client -- entity records, hit
		// flashes, inventory changes -- leaves as ONE WebSocket frame. Last,
		// because anything queued after this point would start the next batch.
		p->client->flushOutputBatch();
	}
	g_perf.markPhase(TickProfiler::PHASE_FLUSH);

	for (Thing* thing : movedThings) thing->resetDirty();

	pendingStaticRemovals.clear();

	g_perf.endTick(sample);

	// Movement applies a fixed distance per tick, so any drift here is a direct
	// cut to every player's walking speed -- hence the absolute grid rather
	// than "now + what is left of the period".
	g_scheduler.addEvent(createSchedulerTask(nextGridDelay(nextMovementTickAt, MOVEMENT_TICK_MS),
		[this]() { this->updateMovement(); }));
}

void Game::addProjectile(std::unique_ptr<Projectile> proj)
{
	projectiles.push_back(std::move(proj));
}

void Game::executeExplosion(const Position& pos, uint16_t radius, uint16_t area, uint32_t playerDamage, uint32_t buildingDamage, float knockback, uint32_t attackerId,
                            const ConditionApplication* onHit)
{
	// 1. Broadcast the explosion entity visually. The id ROTATES: an explosion
	// is addressed (pid 0, id) like any world entity, so two blasts sharing an
	// id land on one client cache slot and the second reads as an update of the
	// first -- it plays no animation. This used to rotate the `uid` byte for the
	// same reason; that byte is now the id's high 8 bits, so the rotation moved
	// into the id itself, through the band the pool never issues.
	static uint32_t explosionSlot = 0;
	explosionSlot = (explosionSlot + 1) % CLIENT_ENTITY_ID_TRANSIENT_COUNT;

	EntityUpdate explodeUpdate;
	explodeUpdate.pid = 0;
	explodeUpdate.type = 12; // __ENTITIE_EXPLOSION__
	explodeUpdate.id = map.transientEntityId(explosionSlot);
	explodeUpdate.state = 1;
	explodeUpdate.startX = static_cast<uint16_t>(pos.x);
	explodeUpdate.startY = static_cast<uint16_t>(pos.y);
	explodeUpdate.endX = static_cast<uint16_t>(pos.x);
	explodeUpdate.endY = static_cast<uint16_t>(pos.y);
	broadcastSurgicalUpdate(explodeUpdate, pos);

	// 2. Apply splash damage and screen shake to nearby players
	//
	// The tiles the blast can actually reach, NOT the exploder's viewport. That
	// call was two bugs in one line. getSpectators answers "what can a player
	// SEE", so it swept 2601 tiles at maxViewport 2500 to resolve a 40-200 unit
	// question -- and it reads Tile::getSolidThings, which only holds things with
	// hasCollision(). Every floor, road and sleeping bag in objects.xml is
	// <transform collision="false">, so a blast passed straight through them:
	// they were never immune, they were never offered as targets at all.
	// getThingsInTileBox reads the full per-tile lists, so a non-colliding object
	// is a splash target like any other.
	//
	// The range test below is unchanged and still decides what is hit; the box
	// only has to be a SUPERSET of what can pass it. A thing sits in the bucket
	// for its own position, which is exactly what that test reads, so a box
	// derived from the blast's own reach is exact -- the +1 is slack for the
	// integer tile division.
	const int32_t blastTileMargin = (area > 0)
		? static_cast<int32_t>(area) + 1
		: static_cast<int32_t>(radius) / TILE_SIZE + 1;
	const int32_t blastTileX = static_cast<int32_t>(pos.x) / TILE_SIZE;
	const int32_t blastTileY = static_cast<int32_t>(pos.y) / TILE_SIZE;

	std::vector<Thing*> nearThings;
	map.getThingsInTileBox(blastTileX - blastTileMargin, blastTileY - blastTileMargin,
	                       blastTileX + blastTileMargin, blastTileY + blastTileMargin,
	                       nearThings);

	for (Thing* thing : nearThings) {
		int32_t dist = pos.getDistance(thing->getPosition());
		bool inRange = (area > 0)
			? isWithinTileArea(pos, thing->getPosition(), area)
			: dist <= radius;
		if (inRange) {
			// Vtable slots, not dynamic_cast -- this loop runs over every
			// spectator of every blast, and MSVC's dynamic_cast is an RTTI
			// string-compare walk. Same reason as Thing::getObject's comment.
			Creature* creature = thing->getCreature();
			if (Player* p = creature ? creature->getPlayer() : nullptr) {
				// A ghost-mode admin is not in the blast at all -- no shake, no
				// knockback, not just no damage. They were absent from the old
				// solid-things gather for the same reason they are absent from
				// every other physical interaction (Player::hasCollision), and
				// widening the gather must not quietly hand them one.
				if (p->isGhostMode()) {
					continue;
				}
				p->sendShakeExplosionState(20);
				Player* pAttacker = getPlayerByID(attackerId);
				int32_t finalDmg = -static_cast<int32_t>(playerDamage);
				if (p->isGhostMode()) {
					finalDmg = 0;
				} else if (p->isInvincible() && (!pAttacker || !pAttacker->hasGroupFlag(GroupFlag::BypassInvincible))) {
					finalDmg = 0;
				}
				int32_t dealt = 0;
				if (finalDmg < 0) {
					dealt = p->changeHealth(finalDmg, true, false, false, "explosion", pAttacker);
				}

				// What the BLAST inflicts. Gated on the damage actually having
				// landed, exactly as every weapon path is: a blast a ghost, an
				// admin or explosion-proof armour absorbed to nothing must not
				// deliver a stun either, or immunity would stop the damage and
				// let the disable through.
				//
				// A zero-damage blast that is PURELY a condition (a flashbang)
				// is written with playerDamage="1", which is the honest way to
				// say "this does hit you".
				if (onHit && !onHit->empty() && dealt < 0 && onHit->roll(-dealt)) {
					p->addCondition(onHit->key, pAttacker ? pAttacker->getGUID() : 0,
					                onHit->durationMs, onHit->strength);
				}

				if (knockback > 0) {
					float dx = static_cast<float>(p->getPosition().x - pos.x);
					float dy = static_cast<float>(p->getPosition().y - pos.y);
					float len = std::sqrt(dx * dx + dy * dy);
					if (len > 0.0f) {
						p->applyKnockback((dx / len) * static_cast<float>(knockback) * 1.5f, (dy / len) * static_cast<float>(knockback) * 1.5f);
					}
				}
			} else if (Agent* agent = thing->getAgent()) {
				// A blast hurts what is standing in it, and an agent is a body,
				// not a building -- so it takes playerDamage, on the same terms
				// a player does. Radiation and the other environment effects are
				// a separate path and stay players-only, deliberately.
				const float dx = static_cast<float>(agent->getPosition().x) - pos.x;
				const float dy = static_cast<float>(agent->getPosition().y) - pos.y;
				const float len = std::sqrt(dx * dx + dy * dy);

				// Knockback INLINE: it only adds an impulse, so it cannot free
				// anything, and it has to happen while we still hold the agent.
				if (knockback > 0 && len > 0.0f) {
					agent->applyKnockback((dx / len) * static_cast<float>(knockback) * 1.5f,
					                      (dy / len) * static_cast<float>(knockback) * 1.5f);
				}

				// The blast's condition, inline for the same reason: applying one
				// cannot free the agent, and the damage below is deferred so
				// waiting for it would mean holding a pointer across a scheduler
				// hop. Rolled against the blast's nominal damage rather than a
				// landed amount, because the landing has not happened yet -- a
				// stun grenade should stun what it catches whether or not the
				// agent survives the shrapnel.
				if (onHit && !onHit->empty() && playerDamage > 0 &&
				    onHit->roll(static_cast<int32_t>(playerDamage))) {
					agent->addCondition(onHit->key, attackerId != 0 && getPlayerByID(attackerId)
						? getPlayerByID(attackerId)->getGUID() : 0,
						onHit->durationMs, onHit->strength);
				}

				// Damage DEFERRED and by id, for a harder reason than the
				// buildings below. `Agent::die` runs the onDeath explosion of an
				// explosive ghoul, which lands right back in this function --
				// so damaging inline would re-enter it recursively, mid-loop,
				// and free agents that `nearThings` still points at. Going
				// through the scheduler turns a chain reaction into a sequence
				// of separate blasts, each resolving its target by id at the
				// moment it fires.
				float angle = std::atan2(dy, dx);
				if (angle < 0) angle += MATH_TWO_PI;
				scheduleExplosionDamage(agent->getID(), playerDamage, attackerId,
				                        std::max<uint32_t>(10, dist * 2),
				                        static_cast<uint8_t>((angle * 31.0f) / MATH_TWO_PI));
			} else if (thing->getObject() || thing->getResource()) {
				// Damage buildings/resources deferred and by ID (distance-scaled)
				// so the target may be destroyed/freed before the task runs.
				scheduleExplosionDamage(thing->getID(), buildingDamage, attackerId, std::max<uint32_t>(10, dist * 2));
			}
		}
	}
}

// Deferred explosion damage resolved by ID: applies to whichever of Object,
// Resource or Agent the target turns out to be at execution time. Shared by
// every splash-damage branch so they cannot drift.
//
// Resolving by ID rather than by pointer is the whole point: by the time this
// runs the target may have been destroyed and freed by an earlier blast in the
// same chain, and getThingByID simply does not find it.
void Game::scheduleExplosionDamage(uint32_t targetId, uint32_t damage, uint32_t attackerId, uint32_t delayMs, uint8_t impactAngle)
{
	g_scheduler.addEvent(createSchedulerTask(delayMs, [targetId, damage, attackerId, impactAngle]() {
		g_dispatcher.addTask([targetId, damage, attackerId, impactAngle]() {
			Player* pAttacker = nullptr;
			if (attackerId != 0) {
				if (Thing* aThing = g_game.getThingByID(attackerId)) {
					Creature* aCreature = aThing->getCreature();
					pAttacker = aCreature ? aCreature->getPlayer() : nullptr;
				}
			}
			Thing* t = g_game.getThingByID(targetId);
			if (!t) return;
			const int32_t delta = -static_cast<int32_t>(damage);
			if (Object* o = t->getObject()) {
				o->changeHealth(delta, impactAngle, pAttacker);
			} else if (Agent* a = t->getAgent()) {
				// Same call the melee and projectile paths use, so an explosion
				// kill credits XP, provokes the type and drops loot exactly as
				// any other kill does. A lethal hit here deletes the agent --
				// nothing may touch it afterwards.
				a->changeHealth(delta, impactAngle, pAttacker, false, AgentDamageKind::Explosion);
			} else if (Resource* r = t->getResource()) {
				r->changeHealth(delta, impactAngle, pAttacker);
			}
		});
	}));
}

int32_t Game::rollOutgoingDamage(const Player* attacker, int32_t damage,
                                 const HitEffects& effects, bool& outCrit) const
{
	outCrit = false;
	if (damage == 0) return damage;

	// A condition can make its wearer hit harder or softer regardless of what
	// they are holding, and can lend crit chance to a weapon that has none.
	float dealtMultiplier = 1.0f;
	float critChance = effects.crit.chance;
	if (attacker) {
		const ConditionTotals& totals = attacker->conditionTotals();
		dealtMultiplier = totals.damageDealtMultiplier;
		critChance += totals.critChanceAdd;
	}

	if (critChance > 0.0f && rollChance(critChance)) {
		outCrit = true;
		dealtMultiplier *= effects.crit.multiplier;
	}

	if (dealtMultiplier == 1.0f) return damage;

	// Rounded away from zero so a reduction can never turn a real hit into no
	// hit at all -- a weakened attacker still hurts, just less.
	const float scaled = static_cast<float>(damage) * dealtMultiplier;
	const int32_t rolled = static_cast<int32_t>(std::lround(scaled));
	if (rolled == 0) return damage < 0 ? -1 : 1;
	return rolled;
}

void Game::applyHitEffects(Player* attacker, Creature* victim, int32_t damageDealt,
                           const HitEffects& effects, bool didCrit)
{
	// Nothing landed: no condition, no leech. A shot absorbed to nothing by
	// armour, ghost mode or a PvP veto must not deliver an effect either, which
	// is the rule Agent::changeHealth already applies to provocation.
	if (damageDealt >= 0) return;
	const int32_t landed = -damageDealt;

	const uint32_t inflictor = attacker ? attacker->getGUID() : 0;
	if (victim && !effects.onHit.empty() && effects.onHit.roll(landed)) {
		// Named as the attacker's, so a poison kill is their kill. The victim's
		// own resistance is applied inside addCondition, and this source's own
		// durationMs (0 = the condition's own) overrides the first stage.
		victim->addCondition(effects.onHit.key, inflictor, effects.onHit.durationMs,
		                     effects.onHit.strength);
	}

	// The crit's own condition -- "and now they are bleeding". Rolled here
	// rather than at the crit itself so it lands only if the crit's damage did.
	if (didCrit && victim && !effects.crit.onCrit.empty() && effects.crit.onCrit.roll(landed)) {
		victim->addCondition(effects.crit.onCrit.key, inflictor,
		                     effects.crit.onCrit.durationMs, effects.crit.onCrit.strength);
	}

	// Leech is the attacker's reward, so with no attacker there is nobody to pay
	// -- an agent biting a player leeches only if agents.xml says so, and this
	// is where a world hazard correctly returns nothing.
	if (!attacker) return;

	// The weapon's leech plus whatever the attacker is running as a buff, so a
	// vampirism condition works with any weapon and stacks with a vampiric one.
	const ConditionTotals& totals = attacker->conditionTotals();
	const float lifeFraction = effects.leech.life + totals.leechLife;
	const float staminaFraction = effects.leech.stamina + totals.leechStamina;
	if (lifeFraction <= 0.0f && staminaFraction <= 0.0f) return;

	// Never off resources or buildings: chopping a tree would otherwise be
	// unlimited health. Creatures only, which is what makes leech a COMBAT stat.
	// (The caller only passes creatures, but stating it here is what keeps a
	// future caller honest.)
	if (!victim) return;

	const uint16_t cap = effects.leech.maxPerHit != 0
		? effects.leech.maxPerHit
		: LEECH_DEFAULT_MAX_PER_HIT;

	const auto share = [&](float fraction) -> uint8_t {
		if (fraction <= 0.0f) return 0;
		const int32_t raw = static_cast<int32_t>(static_cast<float>(landed) * fraction);
		return static_cast<uint8_t>(std::clamp<int32_t>(raw, 0, std::min<int32_t>(cap, 255)));
	};

	const uint8_t lifeBack = share(lifeFraction);
	const uint8_t staminaBack = share(staminaFraction);

	if (lifeBack > 0) {
		// force=false: an admin or a ghost is not healed by this either, and
		// changeHealth's own ceiling stops it overfilling the bar. The green
		// heal aura it fires is the whole client-side tell that leech happened.
		attacker->changeHealth(lifeBack);
	}
	if (staminaBack > 0) {
		attacker->restoreStamina(staminaBack);
	}
}

void Game::applyProjectilePlayerHit(Projectile& projectile, Player& targetPlayer, Player* attacker, const EquipableData* edata, int32_t damage, float angleRad)
{
	const std::string damageType = edata ? edata->damageType : "";
	if (targetPlayer.isGhostMode()) {
		damage = 0;
	} else if (targetPlayer.isInvincible() && (!attacker || !attacker->hasGroupFlag(GroupFlag::BypassInvincible))) {
		damage = 0;
	}

	// The ROUND's own effects, from projectiles.xml. Resolved by KEY through the
	// weapon's projectileKey rather than from the live Projectile, which does
	// not carry its own data pointer.
	const ProjectileData* pdata = (edata && !edata->projectileKey.empty())
		? ProjectileManager::getInstance().getProjectileData(edata->projectileKey)
		: nullptr;

	// The round's crit, then the weapon's: a tipped dart and a scoped rifle can
	// each carry one, and each is rolled and honoured on its own.
	bool roundCrit = false;
	bool weaponCrit = false;
	if (damage < 0 && pdata) {
		damage = rollOutgoingDamage(attacker, damage, pdata->hitEffects, roundCrit);
	}
	if (damage < 0 && edata) {
		damage = rollOutgoingDamage(attacker, damage, edata->hitEffects, weaponCrit);
	}

	int32_t dealt = 0;
	if (damage < 0) {
		dealt = targetPlayer.changeHealth(damage, true, false, false, damageType, attacker);
	}

	// After the damage, so a lethal hit does not bother poisoning a corpse, and
	// off what ACTUALLY landed so armour reduces the leech and the stun chance
	// as well as the damage.
	if (pdata) applyHitEffects(attacker, &targetPlayer, dealt, pdata->hitEffects, roundCrit);
	if (edata) applyHitEffects(attacker, &targetPlayer, dealt, edata->hitEffects, weaponCrit);

	const uint8_t angleByte = static_cast<uint8_t>((angleRad * 255.0f) / MATH_TWO_PI);
	broadcastPlayerHit(static_cast<uint8_t>(targetPlayer.getGUID()), angleByte, targetPlayer.getPosition(), &targetPlayer);

	if (projectile.getKnockback() > 0) {
		const float speed = std::sqrt(projectile.getVelocityX() * projectile.getVelocityX() + projectile.getVelocityY() * projectile.getVelocityY());
		if (speed > 0) {
			const float dirX = projectile.getVelocityX() / speed;
			const float dirY = projectile.getVelocityY() / speed;
			targetPlayer.applyKnockback(dirX * static_cast<float>(projectile.getKnockback()) * 1.5f, dirY * static_cast<float>(projectile.getKnockback()) * 1.5f);
		}
	}
}

bool Game::tryApplyProjectileRepair(Object& targetObj, Player* attacker, const EquipableData& edata, uint8_t impactAngle)
{
	if (!edata.repair.enabled || edata.repair.delivery != "projectile") {
		return false;
	}

	const ObjectData* od = g_objects.getObjectData(targetObj.getKey());
	if (!od || targetObj.getHealth() >= targetObj.getMaxHealth()) {
		return false;
	}

	bool canRepair = true;
	if (!edata.repair.consumeKey.empty() && edata.repair.consumeAmountPerTarget > 0 && attacker) {
		canRepair = false;
		const ItemData* consumeData = ItemManager::getInstance().getItemData(edata.repair.consumeKey);
		if (consumeData) {
			for (uint8_t i = 0; i < attacker->inventory.getSlotCount(); ++i) {
				Item* item = attacker->inventory.getItem(i);
				if (item && item->getIID() == consumeData->id && item->getCount() >= edata.repair.consumeAmountPerTarget) {
					attacker->inventory.removeItem(i, edata.repair.consumeAmountPerTarget);
					canRepair = true;
					break;
				}
			}
		}
	}

	if (!canRepair) {
		return false;
	}

	targetObj.changeHealth(edata.repair.amount, impactAngle, attacker);
	return true;
}

int32_t Game::getProjectileObjectDamage(const Object& targetObj, const EquipableData* edata, Player* attacker, int32_t defaultDamage) const
{
	if (!edata) {
		return defaultDamage;
	}

	float damage = static_cast<float>(edata->buildingDamage);
	const uint32_t attackerGuid = attacker ? attacker->getGUID() : 0;

	for (const auto& mod : edata->damageModifiers) {
		if (mod.target == "building") {
			if (mod.ownership == "own" && targetObj.getOwnerPid() == attackerGuid) {
				damage *= mod.multiplier;
			} else if (mod.ownership == "enemy" && targetObj.getOwnerPid() != attackerGuid) {
				damage *= mod.multiplier;
			}
		}
	}

	// Saturating: <buildingDamage> is already clamped to MAX_DAMAGE_AMOUNT, but
	// a <damageModifiers> multiplier can lift it back over the ceiling.
	return damageDelta(damage);
}

void Game::applyProjectileHit(Projectile& projectile, Thing* hitTarget, const Position& oldPos, float hitX, float hitY)
{
	int32_t damage = -static_cast<int32_t>(projectile.getDamage());

	float angleRad = std::atan2(hitY - oldPos.y, hitX - oldPos.x);
	if (angleRad < 0) angleRad += MATH_TWO_PI;
	const uint8_t impactAngle31 = static_cast<uint8_t>((angleRad * 31.0f) / MATH_TWO_PI);

	Player* attacker = projectile.getShooter() ? projectile.getShooter()->getPlayer() : nullptr;

	const EquipableData* edata = nullptr;
	if (!projectile.getWeaponKey().empty()) {
		edata = EquipmentManager::getInstance().getEquipable(projectile.getWeaponKey());
	}

	// Range falloff, applied here rather than per target type so a shotgun fades
	// against a wall exactly as it does against a player. Measured from where
	// the shot left to where it landed -- not the weapon's nominal range, which
	// is only how far it can reach.
	float falloffMul = 1.0f;
	if (edata && edata->falloff.enabled) {
		const Position& from = projectile.getStartPos();
		const float dx = hitX - static_cast<float>(from.x);
		const float dy = hitY - static_cast<float>(from.y);
		falloffMul = edata->falloff.multiplierAt(std::sqrt(dx * dx + dy * dy));
		// damage is negative here; scaling the magnitude keeps the sign.
		damage = damageDelta(static_cast<float>(-damage) * falloffMul);
	}

	if (Player* targetPlayer = hitTarget->getCreature() ? hitTarget->getCreature()->getPlayer() : nullptr) {
		applyProjectilePlayerHit(projectile, *targetPlayer, attacker, edata, damage, angleRad);
	} else if (Object* targetObj = hitTarget->getObject()) {
		if (!edata || !tryApplyProjectileRepair(*targetObj, attacker, *edata, impactAngle31)) {
			// Building damage comes from <buildingDamage>, not from the
			// projectile, so the falloff has to be applied to it separately.
			const int32_t base = getProjectileObjectDamage(*targetObj, edata, attacker, damage);
			targetObj->changeHealth(damageDelta(static_cast<float>(-base) * falloffMul),
				impactAngle31, attacker);
		}
	} else if (Resource* targetRes = hitTarget->getResource()) {
		targetRes->changeHealth(damage, impactAngle31, attacker);
	} else if (Agent* targetAgent = hitTarget->getAgent()) {
		// Knockback before the hit: a lethal changeHealth deletes the agent.
		// The projectile's own value, not the base weapon's: a fitted mod can
		// change knockback, and the player branch above reads it from here too.
		if (edata && projectile.getKnockback() > 0) {
			targetAgent->applyKnockback(std::cos(angleRad) * projectile.getKnockback() * 1.5f,
			                            std::sin(angleRad) * projectile.getKnockback() * 1.5f);
		}
		// The firing weapon's damageType picks the resistance (piercing for
		// bullets, energy for the tesla family).
		targetAgent->changeHealth(damage, impactAngle31, attacker, false,
		                          edata ? agentDamageKindFromString(edata->damageType)
		                                : AgentDamageKind::None);
	}
}

// EVERY record about one projectile -- creation, the stop/park state change,
// and the removal -- must reach exactly the same set of clients. A client that
// receives any record for a bullet has that bullet in its per-frame draw list
// (client.js Entitie.get allocates a slot for an unknown id), and only a
// removal ever takes it out again, so a client in the gap between two
// different recipient rules keeps it forever.
//
// That set is the one recorded at spawn; see Projectile::markSentTo. This
// deliberately does NOT go through broadcastSurgicalUpdate, which resolves
// recipients by canSee against the full viewport -- with projectile creation
// bounded by projectileViewRange (900 against a 1700 viewport) that reached
// clients which never got the create and would never get the retract. Measured:
// 16,338 bullets leaked per client in 105s even with the recipient mask in
// place, because these two state broadcasts still used the wide rule.
void Game::sendProjectileToRecipients(const Projectile& projectile, const EntityUpdate& update)
{
	for (Player* p : map.getPlayerIndex()) {
		if (projectile.wasSentTo(static_cast<uint8_t>(p->getGUID()))) {
			p->pushUpdate(update);
		}
	}
}

void Game::stopProjectileAtHit(Projectile& projectile, const Position& hitPos)
{
	projectile.stopAt(hitPos);

	if (!projectile.getSkipVisual()) {
		EntityUpdate update;
		projectile.buildUpdate(update);
		sendProjectileToRecipients(projectile, update);
	}
}

// How far a PROJECTILE is visible. Distinct from maxViewport on purpose: a
// bullet further away than the client can draw cannot be seen however wide the
// viewport is.
//
// The client's drawn extent is at most 1280 x 880 WORLD units, whatever the
// window: client.js sets `scaleby = max(h / ((size*11)/16), w / size)` with
// size = 1280, so whichever term binds, the un-scaled view is <= 1280 wide and
// <= 880 tall. Half-extents are therefore 640 and 440. This is a BOX test, so
// the default 900 covers both with margin at every aspect ratio.
//
// (Note 880, not 720. The comment on EVENT_BROADCAST_RADIUS in configmanager.cpp
// derives its 734 from a 720-tall view and a CIRCLE test; the true half-diagonal
// is sqrt(640^2 + 440^2) = 777, so that default of 750 is slightly too small and
// can drop a hit flash in a screen corner. config.lua already runs 1000.)
//
// This is the ONE reader of PROJECTILE_VIEW_RADIUS. The config existed since
// 2026-08-05 but was applied in the visibility loop's mobile scan, gated on
// `entry.id >= PROJECTILE_ID_MIN` -- and projectiles are never in `mobiles`,
// so that branch never executed and the setting did nothing at all.
//
// Both the create path (Player::spawnProjectiles) and the retract path
// (Game::removeProjectile) MUST use this same range. A bullet created for a
// player and never retracted for them is a permanent entry in that client's
// per-frame draw list, which is the bug the retract path was written to fix.
int32_t Game::projectileViewRange() const
{
	const int32_t configured = getNumber(ConfigManager::PROJECTILE_VIEW_RADIUS);
	if (configured > 0) {
		return configured;
	}
	// 0 = no separate projectile range; fall back to the viewport.
	return std::max(getNumber(ConfigManager::MAX_VIEWPORT_X),
	                getNumber(ConfigManager::MAX_VIEWPORT_Y));
}

// Broadcast the destruction removal and take the projectile off the map.
// Callers own the erase from the projectiles container.
void Game::removeProjectile(Projectile* projectile, const Position& removalPos)
{
	EntityUpdate removal;
	removal.isDestruction = true;
	projectile->buildRemoval(removal);

	// A projectile is never placed on the map (see Player::spawnProjectiles), so
	// it never appears in the visibility diff's `visible` set and CANNOT be
	// retracted by anything working through KnownEntitySet. It also touches the
	// known set nowhere any more, so the O(n) erase this used to cost is gone.
	//
	// Retract from EXACTLY the set that was told, recorded at spawn. NOT a
	// re-evaluated visibility predicate: three separate attempts at that each
	// leaked, because the positions such a predicate reads are mutated in
	// flight (stopAt collapses them onto the impact point) and because players
	// move between the shot and the landing. See Projectile::markSentTo for the
	// full sequence and the numbers.
	//
	// Everything that leaves here goes through sendProjectileToRecipients --
	// creation, the stop/park state change and this removal -- because a client
	// that gets any one of them without the removal keeps the bullet in its
	// per-frame draw list forever.
	//
	// isVisualSuppressed needs no check here: a suppressed bullet was never
	// broadcast, so its mask is empty and this sends nothing.
	sendProjectileToRecipients(*projectile, removal);

	map.releaseEntityId(projectile->getID());
	if (Tile* tile = projectile->getTile()) {
		tile->removeThing(projectile);
		projectile->setTile(nullptr);
	}
}

// What the projectile leaves behind where it died: a blast, or the arrow/spear
// itself as ground loot.
void Game::applyProjectilePayload(Projectile* projectile, const ProjectileData* pdata, const Position& pos)
{
	if (pdata && pdata->explosion.enabled) {
		const uint32_t attackerId = projectile->getShooter() ? projectile->getShooter()->getID() : 0;
		executeExplosion(pos, pdata->explosion.radius, pdata->explosion.area, pdata->explosion.playerDamage, pdata->explosion.buildingDamage, pdata->explosion.knockback, attackerId, &pdata->explosion.onHit);
	} else {
		dropProjectileItem(projectile, pos);
	}
}

void Game::destroyProjectileAfterHit(Projectile* projectile, const ProjectileData* pdata, const Position& hitPos)
{
	applyProjectilePayload(projectile, pdata, hitPos);
	removeProjectile(projectile, hitPos);
}

// Resolve a hit for a projectile that has no lifetime of its own: the payload
// lands now, but the bullet is parked on the impact point and only removed a
// few ticks later. Removing it here instead deletes a sprite the client is
// still drawing short of the target, which is what made bullets vanish before
// they landed -- and what made the two 762_round weapons overshoot, since the
// client keeps flying its fading copy toward the ORIGINAL endpoint.
//
// Returns false when the projectile is already gone from the map.
bool Game::parkProjectileOnImpact(Projectile* projectile, const ProjectileData* pdata, const Position& hitPos)
{
	applyProjectilePayload(projectile, pdata, hitPos);

	// Never drawn in the first place (point-blank suppression): nothing to park.
	if (projectile->getSkipVisual()) {
		removeProjectile(projectile, hitPos);
		return false;
	}

	stopProjectileAtHit(*projectile, hitPos);
	projectile->beginImpactLinger(impactLingerMs(*projectile));
	return true;
}

void Game::updateProjectiles(uint32_t elapsedMs)
{
	if (projectiles.empty()) return;

	// Reused across every projectile: this was a fresh std::vector per
	// projectile per tick, so a busy firefight allocated and freed one heap
	// buffer per bullet 20 times a second.
	std::vector<Thing*>& candidates = projectileCandidates;
	const int32_t scanMargin = Map::collisionScanTileMargin();

	// Attribution for the phase: how many bullets were stepped, and how much
	// world each step had to search. See TickProfiler::addProjectileWork.
	uint64_t workSteps = 0, workCandidates = 0, workTiles = 0;
	uint64_t moveNs = 0, gatherNs = 0, testNs = 0, hitNs = 0;
	const auto clockNow = []() { return std::chrono::steady_clock::now(); };
	const auto since = [](std::chrono::steady_clock::time_point t0) {
		return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
			std::chrono::steady_clock::now() - t0).count());
	};

	for (size_t i = 0; i < projectiles.size(); ) {
		const auto stepStart = clockNow();
		Projectile* p = projectiles[i].get();
		Position oldPos = p->getPosition();
		bool wasStopped = p->isStopped();

		if (!p->update(elapsedMs)) {
			moveNs += since(stepStart);
			const auto expiryStart = clockNow();
			if (p->isImpactResolved()) {
				// End of the impact park: the payload landed on the tick it hit.
				removeProjectile(p, p->getPosition());
			} else {
				// Expired (reached max range, or lifetime expired): same
				// explosion-or-drop behavior as a hit, at the resting position.
				const ProjectileData* pdata = ProjectileManager::getInstance().getProjectileData(p->getExtra());
				destroyProjectileAfterHit(p, pdata, p->getPosition());
			}
			p->resetShooter();
			std::swap(projectiles[i], projectiles.back());
			projectiles.pop_back();
			hitNs += since(expiryStart);
			continue;
		}

		if (!wasStopped && p->isStopped()) {
			EntityUpdate update;
			p->buildUpdate(update);
			sendProjectileToRecipients(*p, update);
		}

		if (p->isStopped()) {
			++i;
			moveNs += since(stepStart);
			continue; // Skip collision and movement if stopped
		}

		const float mapWidth = static_cast<float>(MapSize::widthUnits());
		const float mapHeight = static_cast<float>(MapSize::heightUnits());

		if (p->getFloatX() < 0.0f || p->getFloatY() < 0.0f || p->getFloatX() > mapWidth || p->getFloatY() > mapHeight) {
			// Out of bounds: remove silently (no explosion, no item drop)
			removeProjectile(p, oldPos);
			p->resetShooter();
			std::swap(projectiles[i], projectiles.back());
			projectiles.pop_back();
			continue;
		}

		Position newPos = p->getPosition();

		// Collision candidates along the segment (oldPos, newPos).
		//
		// This used to be map.getSpectators(newPos, ...), i.e. the projectile's
		// whole configured VIEWPORT -- 2601 tiles and ~900 entities at
		// maxViewport 2500 -- to test a segment a projectile crosses in one
		// 50ms tick (~70 units, under one tile). Measured before the change: 15
		// concurrent projectiles cost 3.5ms of a 50ms tick, more than the whole
		// visibility phase for the same 8 players. It also made the cost of
		// firing a gun scale with the viewport setting, which is exactly the
		// dimension this server wants to grow.
		const int32_t segMinTileX = std::min(oldPos.x, newPos.x) / TILE_SIZE - scanMargin;
		const int32_t segMaxTileX = std::max(oldPos.x, newPos.x) / TILE_SIZE + scanMargin;
		const int32_t segMinTileY = std::min(oldPos.y, newPos.y) / TILE_SIZE - scanMargin;
		const int32_t segMaxTileY = std::max(oldPos.y, newPos.y) / TILE_SIZE + scanMargin;

		moveNs += since(stepStart);

		const auto gatherStart = clockNow();
		candidates.clear();
		map.getSolidThingsInTileBox(segMinTileX, segMinTileY, segMaxTileX, segMaxTileY, candidates);
		gatherNs += since(gatherStart);

		const auto testStart = clockNow();
		++workSteps;
		workCandidates += candidates.size();
		workTiles += static_cast<uint64_t>(segMaxTileX - segMinTileX + 1) *
		             static_cast<uint64_t>(segMaxTileY - segMinTileY + 1);

		Thing* hitTarget = nullptr;
		float minHitDistSq = 1e18f;
		float hitX = 0, hitY = 0;

		for (Thing* target : candidates) {
			if (target == p->getShooter()) continue;


			float tx = 0, ty = 0;
			if (checkProjectileTargetHit(target, oldPos, newPos, tx, ty)) {
				float distSq = (tx - oldPos.x) * (tx - oldPos.x) + (ty - oldPos.y) * (ty - oldPos.y);
				if (distSq < minHitDistSq) {
					minHitDistSq = distSq;
					hitTarget = target;
					hitX = tx;
					hitY = ty;
				}
			}
		}

		testNs += since(testStart);

		if (hitTarget) {
			const auto hitStart = clockNow();
			applyProjectileHit(*p, hitTarget, oldPos, hitX, hitY);

			const ProjectileData* pdata = ProjectileManager::getInstance().getProjectileData(p->getExtra());
			const Position hitPos(static_cast<uint16_t>(hitX), static_cast<uint16_t>(hitY));
			if (pdata && pdata->lifetimeMs > 0) {
				// Has its own fuse (grenade): parking it IS the gameplay.
				stopProjectileAtHit(*p, hitPos);
				++i;
			} else if (parkProjectileOnImpact(p, pdata, hitPos)) {
				++i;
			} else {
				p->resetShooter();
				std::swap(projectiles[i], projectiles.back());
				projectiles.pop_back();
			}
			hitNs += since(hitStart);
		} else {
			++i;
		}
	}

	g_perf.addProjectileWork(workSteps, workCandidates, workTiles);
	g_perf.addProjectileTiming(moveNs, gatherNs, testNs, hitNs);
}

bool Game::findClosestObstacleHit(const Creature* shooter, const Position& startPos, const Position& endPos, Position& hitPos)
{
	const int32_t scanMargin = Map::collisionScanTileMargin();
	const int32_t segMinTileX = std::min(startPos.x, endPos.x) / TILE_SIZE - scanMargin;
	const int32_t segMaxTileX = std::max(startPos.x, endPos.x) / TILE_SIZE + scanMargin;
	const int32_t segMinTileY = std::min(startPos.y, endPos.y) / TILE_SIZE - scanMargin;
	const int32_t segMaxTileY = std::max(startPos.y, endPos.y) / TILE_SIZE + scanMargin;

	static std::vector<Thing*> candidates;
	candidates.clear();
	map.getSolidThingsInTileBox(segMinTileX, segMinTileY, segMaxTileX, segMaxTileY, candidates);

	Thing* hitTarget = nullptr;
	float minHitDistSq = 1e18f;
	float hitX = 0.0f, hitY = 0.0f;

	for (Thing* target : candidates) {
		if (target == shooter) continue;
		if (!target->hasCollision() && !target->getAgent()) continue;

		float tx = 0.0f, ty = 0.0f;
		if (checkProjectileTargetHit(target, startPos, endPos, tx, ty)) {
			float distSq = (tx - static_cast<float>(startPos.x)) * (tx - static_cast<float>(startPos.x)) +
			               (ty - static_cast<float>(startPos.y)) * (ty - static_cast<float>(startPos.y));
			if (distSq < minHitDistSq) {
				minHitDistSq = distSq;
				hitTarget = target;
				hitX = tx;
				hitY = ty;
			}
		}
	}

	if (hitTarget) {
		hitPos.x = static_cast<uint16_t>(std::round(hitX));
		hitPos.y = static_cast<uint16_t>(std::round(hitY));
		return true;
	}
	return false;
}

// First occupied, unfinished queue slot, or -1.
static int32_t findActiveQueueSlot(const Object* obj)
{
	const auto& q = obj->getQueue();
	for (int32_t i = 0; i < STATION_QUEUE_SIZE; ++i) {
		if (q[i].iid != 0 && q[i].progressMs < q[i].totalTimeMs) {
			return i;
		}
	}
	return -1;
}

// Fuel stations work while fuelled; the rest while the queue is unfinished.
// Sampled before and after the tick's progress to detect a state change.
static bool isStationWorking(const Object* obj, const ObjectData* od)
{
	if (!od->fuelItemKey.empty()) {
		return obj->getFuelMs() > 0;
	}
	return findActiveQueueSlot(obj) != -1;
}

void Game::updateStationObject(Object* obj, const ObjectData* od, uint32_t elapsedMs)
{
	const bool wasWorking = isStationWorking(obj, od);
	const uint8_t oldFuelByte = obj->getFuelByte();

	if (!od->fuelItemKey.empty()) {
		obj->setFuelMs(obj->getFuelMs() >= elapsedMs ? obj->getFuelMs() - elapsedMs : 0);
	}

	const uint8_t newFuelByte = obj->getFuelByte();
	const bool fuelByteChanged = (oldFuelByte != newFuelByte);

	bool itemFinished = false;
	const int32_t activeIdx = findActiveQueueSlot(obj);
	if (activeIdx != -1) {
		// A station that has run dry stalls instead of progressing.
		const bool canProcess = od->fuelItemKey.empty() || obj->getFuelMs() > 0;
		if (canProcess) {
			auto& slot = obj->getQueue()[activeIdx];
			slot.progressMs += elapsedMs;
			if (slot.progressMs >= slot.totalTimeMs) {
				slot.progressMs = slot.totalTimeMs;
				if (auto* creator = getPlayerByID(slot.creator); creator && creator->getLifeGeneration() == slot.creatorLife) {
					if (const ItemData* made = ItemManager::getInstance().getItemData(slot.iid))
						g_events.emit({EventType::Craft, creator, made->key, slot.yield});
				}
				itemFinished = true;
			}
		}
	}

	if (uint32_t activeUser = obj->getActiveUserPid(); activeUser != 0) {
		Player* user = getPlayerByGUID(activeUser);
		// A disconnected player stays in the world (AFK) and is still found by
		// GUID here, so the client check is required.
		if (user && user->client && user->getOpenedInteractionId() == obj->getID()) {
			if (itemFinished) {
				user->client->sendOpenStation(od->stationId, 1);
			} else if (fuelByteChanged) {
				user->client->sendNewFuelValue(newFuelByte, obj->getFuelMs());
			}
		}
	}

	if (wasWorking != isStationWorking(obj, od)) {
		EntityUpdate update;
		obj->buildUpdate(update);
		broadcastSurgicalUpdate(update, obj->getPosition());
	}
}

void Game::updateStations()
{
	static uint64_t lastStationUpdateTime = OTSYS_TIME();
	uint64_t now = OTSYS_TIME();
	uint32_t elapsedMs = static_cast<uint32_t>(now - lastStationUpdateTime);
	lastStationUpdateTime = now;

	if (elapsedMs == 0) elapsedMs = 1; // Prevent zero-progress if called too fast

	updateObjectStages(elapsedMs);

	// Cached type data, not a string-keyed lookup: this walks every thing on the
	// map at 10 Hz, so the hash was paid ~6,500 times a second on a populated
	// world for objects that mostly turn out not to be stations at all.
	for (Thing* thing : map.getThings()) {
		Object* obj = thing->getObject();
		if (!obj) continue;
		const ObjectData* od = obj->getData();
		if (!od || od->protocolType == 0) continue;

		updateStationObject(obj, od, elapsedMs);
	}

	// Process active triggers (e.g. traps). updateTriggers can destroy objects
	// (self-destruct explosions), which unregisters them from
	// activeTriggerObjects, so iterate a snapshot; destroyed objects are freed
	// deferred, keeping snapshot pointers valid for this tick.
	std::vector<Object*> triggerObjects(activeTriggerObjects.begin(), activeTriggerObjects.end());
	for (Object* obj : triggerObjects) {
		if (!obj->isDestroyed) {
			obj->updateTriggers(now);
		}
	}
	
	updateLogicCircuits();

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(now, STATIONS_PERIOD_MS),
		[this]() { this->updateStations(); }));
}

Position Game::clampPositionToMap(int32_t x, int32_t y) const
{
	const int32_t maxX = MapSize::widthUnits() - 1;
	const int32_t maxY = MapSize::heightUnits() - 1;
	return Position(
		static_cast<uint16_t>(std::clamp(x, 0, maxX)),
		static_cast<uint16_t>(std::clamp(y, 0, maxY)));
}

// The body-aware clamp. Runs clampToMapBounds -- the SAME function the movement
// resolver applies after every step -- so a teleported body ends up exactly
// where a walked one would, and then narrows through clampPositionToMap so the
// uint16 conversion is still done once, in one place.
Position Game::clampBodyPositionToMap(int32_t x, int32_t y, float radius) const
{
	float fx = static_cast<float>(x);
	float fy = static_cast<float>(y);
	clampToMapBounds(fx, fy, radius);
	return clampPositionToMap(static_cast<int32_t>(std::lround(fx)),
	                          static_cast<int32_t>(std::lround(fy)));
}

Loot* Game::spawnLoot(uint16_t lootId, uint16_t iid, uint8_t count, const ItemState& state, const Position& from, const Position& to)
{
	Loot* loot = LootManager::getInstance().createLoot(lootId, iid, count, state, from, to);
	if (loot) {
		placeThing(loot, to);
	}
	return loot;
}

// The piles on the ground that a drop round `origin` on rings from `radius`
// could land on. Loot has no collision, so it is not among a tile's solid
// things: it has to be picked out of the full list. A pile being picked up is
// already flying away and does not count.
static std::vector<Position> groundLootNear(const Map& map, const Position& origin, float radius)
{
	const float reach = loot_placement::reach(radius);
	const int32_t reachTiles = static_cast<int32_t>(std::ceil(reach / TILE_SIZE));
	const int32_t tx = origin.getX() / TILE_SIZE;
	const int32_t ty = origin.getY() / TILE_SIZE;
	std::vector<Thing*> things;
	map.getThingsInTileBox(tx - reachTiles, ty - reachTiles, tx + reachTiles, ty + reachTiles, things);

	// The tile box overshoots the circle; trimming to it keeps the per-slot
	// clearance check short on a crowded floor.
	const int32_t reachSq = static_cast<int32_t>(reach * reach);
	std::vector<Position> piles;
	for (const Thing* t : things) {
		const Loot* loot = t->getLoot();
		if (!loot || loot->isTaken()) continue;
		const int32_t dx = loot->getPosition().getX() - origin.getX();
		const int32_t dy = loot->getPosition().getY() - origin.getY();
		if (dx * dx + dy * dy <= reachSq) piles.push_back(loot->getPosition());
	}
	return piles;
}

static loot_placement::Area lootPlacementMapArea()
{
	return { MapSize::widthUnits() - 1, MapSize::heightUnits() - 1 };
}

Position Game::findThrowLootPosition(const Position& origin, float angle, float radius)
{
	return loot_placement::directed(origin, angle, radius, groundLootNear(map, origin, radius), lootPlacementMapArea());
}

std::vector<Position> Game::findBurstLootPositions(const Position& origin, size_t count, float radius)
{
	// A random start, so the first pile is not always due east of the body.
	const float startAngle = static_cast<float>(rand() % 360) * (MATH_PI / 180.0f);
	return loot_placement::burst(origin, count, radius, startAngle, groundLootNear(map, origin, radius), lootPlacementMapArea());
}

void Game::dropLootBurst(const Position& origin, std::span<const LootDrop> drops, float radius)
{
	// A roll of nothing spawns nothing, so it must not hold a slot open either.
	std::vector<const LootDrop*> piles;
	for (const LootDrop& d : drops) {
		if (d.count > 0) piles.push_back(&d);
	}
	if (piles.empty()) return;
	const std::vector<Position> spots = findBurstLootPositions(origin, piles.size(), radius);
	for (size_t i = 0; i < piles.size(); ++i) {
		spawnLoot(piles[i]->lootId, piles[i]->iid, piles[i]->count, piles[i]->state, origin, spots[i]);
	}
}

void Game::dropLootScattered(uint16_t lootId, uint16_t iid, uint8_t count, const ItemState& state, const Position& origin)
{
	const LootDrop drop{ lootId, iid, count, state };
	dropLootBurst(origin, std::span<const LootDrop>(&drop, 1));
}

void Game::dropProjectileItem(Projectile* p, const Position& pos)
{
	uint16_t dropIid = p->getDropItemIid();
	if (dropIid != 0) {
		const ItemData* idata = ItemManager::getInstance().getItemData(dropIid);
		if (idata && idata->lootId != 0) {
			spawnLoot(idata->lootId, dropIid, 1, ItemState::fresh(dropIid), pos, pos);
		}
	}
}

namespace {
	uint8_t getOppositeSide(uint8_t side) {
		return (side + 2) % 4;
	}

	void getAdjacentTile(uint16_t x, uint16_t y, uint8_t side, uint16_t& outX, uint16_t& outY) {
		outX = x;
		outY = y;
		if (side == 0) { // TOP
			outY = y - 1;
		} else if (side == 1) { // RIGHT
			outX = x + 1;
		} else if (side == 2) { // BOTTOM
			outY = y + 1;
		} else if (side == 3) { // LEFT
			outX = x - 1;
		}
	}

	Object* getLogicObjectAt(Map& map, uint16_t tileX, uint16_t tileY) {
		Tile* tile = map.getTile(tileX, tileY);
		if (!tile) return nullptr;

		for (Thing* thing : tile->getThings()) {
			if (Object* obj = thing->getObject()) {
				if (obj->isDestroyed) {
					continue;
				}
				const ObjectData* od = obj->getData();
				if (od && od->isLogicObject) {
					return obj;
				}
			}
		}
		return nullptr;
	}

	// Returns true if adjObj's side `oppSide` is powered (bridge-aware).
	bool isLogicSidePowered(const Object* adjObj, const ObjectData* adjOd, uint8_t oppSide) {
		if (adjOd->logicType == LogicType::Bridge) {
			return (oppSide == 0 || oppSide == 2) ? adjObj->logicState.poweredTB
			                                       : adjObj->logicState.poweredLR;
		}
		return adjObj->logicState.powered;
	}

	// Checks whether the adjacent object at `side` of `obj` is connected and not
	// already powered from that entry, then enqueues it in the BFS queue.
	struct PropagationNode {
		Object* obj;
		uint8_t entrySide; // 0=TOP, 1=RIGHT, 2=BOTTOM, 3=LEFT, 255=Source seed
	};

	// One circuit participant with its type data already resolved. The solver
	// walks the set six times per pass, so it resolves and filters once.
	struct LogicEntry {
		Object* obj;
		const ObjectData* od;
	};
	void tryEnqueueLogicNeighbor(
	    std::vector<PropagationNode>& queue,
	    Map& map,
	    Object* obj,
	    uint8_t side)
	{
		uint16_t adjX, adjY;
		getAdjacentTile(obj->getPosition().x / TILE_SIZE, obj->getPosition().y / TILE_SIZE, side, adjX, adjY);
		Object* adjObj = getLogicObjectAt(map, adjX, adjY);
		if (!adjObj) return;

		uint8_t oppSide = getOppositeSide(side);
		uint8_t adjRot  = adjObj->getRotation() & 0x03;
		const ObjectData* adjOd = adjObj->getData();
		if (!adjOd) return;

		// Gates are entered through input pins; other objects through connection mask.
		bool hasConnection = isLogicGate(adjOd->logicType)
		    ? (adjOd->inputMask[adjRot] & (1 << oppSide)) != 0
		    : (adjOd->connectionMask[adjRot] & (1 << oppSide)) != 0;
		if (!hasConnection) return;

		// Skip if this side is already powered (prevents infinite BFS growth on loops).
		if (isLogicSidePowered(adjObj, adjOd, oppSide)) return;

		// Mark powered now so subsequent BFS iterations don't re-enqueue.
		if (!isLogicGate(adjOd->logicType)) {
			if (adjOd->logicType == LogicType::Bridge) {
				if (oppSide == 0 || oppSide == 2) adjObj->logicState.poweredTB = true;
				else                               adjObj->logicState.poweredLR = true;
			}
			adjObj->logicState.powered = true;
		}
		queue.push_back(PropagationNode{adjObj, oppSide});
	}
}

void Game::updateLogicCircuits()
{
	// Nothing built, nothing to solve. This is the common case and it is now the
	// cheap one: no world sweep runs before it.
	if (activeLogicObjects.empty()) {
		return;
	}

	uint64_t now = OTSYS_TIME();

	// 1. Resolve the registry into a dense working set.
	//
	// Nothing below destroys an object, so the registry cannot be mutated
	// underneath this -- unlike the trigger sweep, which has to snapshot.
	std::vector<LogicEntry> logicObjects;
	logicObjects.reserve(activeLogicObjects.size());
	for (Object* obj : activeLogicObjects) {
		if (obj->isDestroyed) {
			continue;
		}
		if (const ObjectData* od = obj->getData()) {
			logicObjects.push_back({obj, od});
		}
	}

	if (logicObjects.empty()) {
		return;
	}

	// 2. Handle timer updates and ticking
	for (const LogicEntry& entry : logicObjects) {
		Object* obj = entry.obj;
		const ObjectData* od = entry.od;

		if (od->logicType == LogicType::Timer) {
			// Check if timer fired
			if (obj->logicState.timerRateIndex < od->timerRatesMs.size()) {
				uint32_t rate = od->timerRatesMs[obj->logicState.timerRateIndex];
				if (now >= obj->logicState.nextTimerFire) {
					if (od->pulseIsOneShot) {
						obj->logicState.timerPulseState = true;
						obj->logicState.nextPulseEnd = now + od->pulseDurationMs;
					} else {
						// Clock mode: toggle state
						obj->logicState.timerPulseState = !obj->logicState.timerPulseState;
					}
					// Schedule next trigger
					obj->logicState.nextTimerFire = now + rate;
				}
			}
			// Handle pulse duration end for pulse type
			if (od->pulseIsOneShot && now >= obj->logicState.nextPulseEnd) {
				obj->logicState.timerPulseState = false;
			}
		}
	}

	// 2.5. Handle platform detection delays and state changes
	for (const LogicEntry& entry : logicObjects) {
		Object* obj = entry.obj;
		const ObjectData* od = entry.od;

		if (od->logicType == LogicType::PlatformSource) {
			bool instantDetect = false;
			if (Tile* tile = obj->getTile()) {
				for (Thing* t : tile->getThings()) {
					if (t->getCreature() || t->getLoot()) {
						instantDetect = true;
						break;
					}
				}
			}

			if (instantDetect != obj->logicState.platformTargetState) {
				obj->logicState.platformTargetState = instantDetect;
				uint32_t delay = instantDetect ? od->platformDelayInMs : od->platformDelayOutMs;
				obj->logicState.platformStateChangeTime = now + delay;
			}

			if (now >= obj->logicState.platformStateChangeTime) {
				obj->logicState.platformActiveState = obj->logicState.platformTargetState;
			}
		}
	}

	// 3. Keep track of gate states. In each iteration we run propagation.
	// Gates have outputs that acts as sources. If their state changes, we re-propagate.
	// We run up to 32 passes.
	bool gateStateChanged = true;
	int32_t passes = 0;

	// Hoisted out of the pass loop: cleared and refilled per pass, so the
	// capacity is paid once instead of on every re-propagation.
	std::vector<PropagationNode> queue;

	while (gateStateChanged && passes < 32) {
		gateStateChanged = false;
		passes++;

		// a. Reset powered states for passive entities
		for (const LogicEntry& entry : logicObjects) {
			const LogicType type = entry.od->logicType;
			if (type == LogicType::Cable || type == LogicType::Lamp ||
			    type == LogicType::Sink || type == LogicType::Bridge) {
				entry.obj->logicState.powered = false;
				entry.obj->logicState.poweredTB = false;
				entry.obj->logicState.poweredLR = false;
			}
		}

		// b. Seed BFS queue with active sources
		queue.clear();
		for (const LogicEntry& entry : logicObjects) {
			Object* obj = entry.obj;

			bool isSource = false;
			switch (entry.od->logicType) {
			case LogicType::Switch:
				obj->logicState.powered = obj->logicState.switchOn;
				isSource = obj->logicState.switchOn;
				break;
			case LogicType::Timer:
				obj->logicState.powered = obj->logicState.timerPulseState;
				isSource = obj->logicState.timerPulseState;
				break;
			case LogicType::PlatformSource:
				obj->logicState.powered = obj->logicState.platformActiveState;
				isSource = obj->logicState.platformActiveState;
				break;
			case LogicType::GateAnd:
			case LogicType::GateOr:
			case LogicType::GateNot:
			case LogicType::GateXor:
				// Gate acts as a source if its current evaluated logic output is HIGH
				isSource = obj->logicState.powered;
				break;
			default:
				break;
			}

			if (isSource) {
				// Seed this source in the queue
				queue.push_back(PropagationNode{obj, 255});
			}
		}

		// c. Propagate signals via BFS
		size_t head = 0;
		while (head < queue.size()) {
			PropagationNode node = queue[head++];
			Object* obj = node.obj;
			uint8_t entrySide = node.entrySide;

			const ObjectData* od = obj->getData();
			if (!od) continue;

			// If this is a logic gate or an active source device (switch, timer, platform),
			// it should only propagate output signals if it was seeded directly as a source (entrySide == 255)
			bool isGate = isLogicGate(od->logicType);
			if ((isGate || isLogicSourceDevice(od->logicType)) && entrySide != 255) {
				continue;
			}

			uint8_t rot = obj->getRotation() & 0x03;
			uint8_t connections = od->connectionMask[rot];
			uint8_t inputs = od->inputMask[rot];

			if (od->logicType == LogicType::Bridge) { // cable4: two independent signal lanes
				// Top-Bottom lane (sides 0 & 2)
				if (entrySide == 0 || entrySide == 2 || entrySide == 255) {
					obj->logicState.poweredTB = true;
					obj->logicState.powered = true;
					for (uint8_t s : {static_cast<uint8_t>(0), static_cast<uint8_t>(2)}) {
						if (s != entrySide && (connections & (1 << s)) != 0) {
							tryEnqueueLogicNeighbor(queue, map, obj, s);
						}
					}
				}
				// Left-Right lane (sides 1 & 3)
				if (entrySide == 1 || entrySide == 3 || entrySide == 255) {
					obj->logicState.poweredLR = true;
					obj->logicState.powered = true;
					for (uint8_t s : {static_cast<uint8_t>(1), static_cast<uint8_t>(3)}) {
						if (s != entrySide && (connections & (1 << s)) != 0) {
							tryEnqueueLogicNeighbor(queue, map, obj, s);
						}
					}
				}
			} else {
				// Non-bridge: propagate to all connected output sides
				for (uint8_t s = 0; s < 4; ++s) {
					if ((connections & (1 << s)) == 0) continue;
					// Gates only propagate through output pins (input mask bit == 0)
					if (isGate && (inputs & (1 << s)) != 0) continue;
					if (s != entrySide) {
						tryEnqueueLogicNeighbor(queue, map, obj, s);
					}
				}
			}
		}

		// d. Evaluate gate logic based on the input pins' powered states
		for (const LogicEntry& entry : logicObjects) {
			Object* obj = entry.obj;
			const ObjectData* od = entry.od;
			if (!isLogicGate(od->logicType)) continue;

			uint8_t rot = obj->getRotation() & 0x03;
			uint8_t inputs = od->inputMask[rot];

			int32_t totalConnectedInputs = 0;
			int32_t highInputs = 0;

			for (uint8_t s = 0; s < 4; ++s) {
				if ((inputs & (1 << s)) == 0) continue;
				uint16_t adjX, adjY;
				getAdjacentTile(obj->getPosition().x / TILE_SIZE, obj->getPosition().y / TILE_SIZE, s, adjX, adjY);
				Object* adjObj = getLogicObjectAt(map, adjX, adjY);
				if (!adjObj) continue;

				uint8_t oppSide = getOppositeSide(s);
				uint8_t adjRot = adjObj->getRotation() & 0x03;
				const ObjectData* adjOd = adjObj->getData();
				if (!adjOd) continue;

				// Gate neighbors expose output pins; non-gate neighbors expose connection mask.
				bool hasConnection = isLogicGate(adjOd->logicType)
				    ? ((adjOd->connectionMask[adjRot] & ~adjOd->inputMask[adjRot]) & (1 << oppSide)) != 0
				    : (adjOd->connectionMask[adjRot] & (1 << oppSide)) != 0;
				if (!hasConnection) continue;

				totalConnectedInputs++;
				if (isLogicSidePowered(adjObj, adjOd, oppSide)) {
					highInputs++;
				}
			}

			bool newPowered = false;
			switch (od->logicType) {
			case LogicType::GateAnd:
				newPowered = (totalConnectedInputs > 0 && highInputs == totalConnectedInputs);
				break;
			case LogicType::GateOr:
				newPowered = (highInputs > 0);
				break;
			case LogicType::GateNot:
				// NOR behavior: true if no inputs are high
				newPowered = (highInputs == 0);
				break;
			case LogicType::GateXor:
				newPowered = (highInputs % 2 == 1);
				break;
			default:
				break;
			}

			if (newPowered != obj->logicState.powered) {
				obj->logicState.powered = newPowered;
				gateStateChanged = true;
			}
		}
	}

	// 4. Post-propagation: apply states (lamps, doors) and broadcast updates if visually changed
	for (const LogicEntry& entry : logicObjects) {
		Object* obj = entry.obj;
		const ObjectData* od = entry.od;

		if (od->logicType == LogicType::Lamp) {
			if (obj->logicState.powered != obj->logicState.prevPowered) {
				obj->logicState.prevPowered = obj->logicState.powered;
				EntityUpdate update;
				obj->buildUpdate(update);
				broadcastSurgicalUpdate(update, obj->getPosition());
			}
		} else if (od->logicType == LogicType::Sink && obj->getKey() == "automatic_door") {
			// Automatic door opens if it is powered
			bool shouldOpen = obj->logicState.powered;
			if (shouldOpen != obj->isDoorOpen) {
				obj->isDoorOpen = shouldOpen;
				EntityUpdate update;
				obj->buildUpdate(update);
				broadcastSurgicalUpdate(update, obj->getPosition());
			}
		}
	}
}















void Game::updateLeaderboard()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	broadcastLeaderboard();

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, LEADERBOARD_PERIOD_MS),
		[this]() { this->updateLeaderboard(); }));
}

std::array<Game::LeaderboardSlot, Game::LEADERBOARD_SLOTS> Game::collectLeaderboard() const
{
	std::vector<const Player*> activePlayers;
	activePlayers.reserve(players.size());
	for (const auto& [id, player] : players) {
		if (player) {
			activePlayers.push_back(player);
		}
	}

	// Only the top ten ever reach the wire, so the tail does not need ordering.
	const size_t shown = std::min(activePlayers.size(), LEADERBOARD_SLOTS);
	std::partial_sort(activePlayers.begin(),
		activePlayers.begin() + static_cast<std::ptrdiff_t>(shown), activePlayers.end(),
		[](const Player* a, const Player* b) { return a->getScore() > b->getScore(); });

	std::array<LeaderboardSlot, LEADERBOARD_SLOTS> slots{};
	for (size_t i = 0; i < shown; ++i) {
		slots[i].guid = static_cast<uint8_t>(activePlayers[i]->getGUID());
		slots[i].karma = activePlayers[i]->getKarmaClientIcon();
		slots[i].score = ProtocolGame::deflateNumber(activePlayers[i]->getScore());
	}
	return slots;
}

void Game::buildLeaderboardMessage(const std::array<LeaderboardSlot, LEADERBOARD_SLOTS>& slots,
                                   NetworkMessage& out)
{
	out.addByte(static_cast<uint8_t>(ServerOpcode::LEADERBOARD));
	out.addByte(0); // padding/count

	for (const LeaderboardSlot& slot : slots) {
		out.addByte(slot.guid);
		out.addByte(slot.karma);
		out.add<uint16_t>(slot.score);
	}
}

void Game::broadcastLeaderboard()
{
	const auto slots = collectLeaderboard();

	// The board goes out every 3s and on every karma change, but the numbers
	// only move when somebody scores. Identical standings mean the clients are
	// already drawing exactly this, so the send is pure cost -- one frame per
	// online player, twenty times a minute, carrying nothing.
	if (leaderboardSent && slots == lastLeaderboard) {
		return;
	}
	lastLeaderboard = slots;
	leaderboardSent = true;

	NetworkMessage msg;
	buildLeaderboardMessage(slots, msg);

	broadcastPacket(msg);
}

void Game::sendLeaderboardTo(ProtocolGame* client)
{
	if (!client) {
		return;
	}

	// Current standings, and deliberately NOT written into lastLeaderboard: that
	// cache means "what every other client is already drawing". Overwriting it
	// here would make the next periodic broadcast compare equal and suppress
	// itself, leaving everyone except the newcomer on a stale board.
	NetworkMessage msg;
	buildLeaderboardMessage(collectLeaderboard(), msg);
	client->writeToOutputBuffer(msg);
}

void Game::broadcastPacket(const NetworkMessage& msg)
{
	// Into each client's batch rather than out as a frame each. This is a
	// server-wide send (leaderboard, day/night), so it rides along with whatever
	// that client was already going to be told this tick.
	//
	// It must go through the batch even though a shared OutputMessage would
	// serialise just as cheaply: a direct send would overtake everything already
	// queued for that client, and ordering is the one thing batching cannot give
	// back.
	for (const auto& [id, p] : players) {
		if (p->client) {
			p->client->queueMessage(msg);
		}
	}
}

// A fraction of the KILLER's own level, scaled by the victim/killer level ratio.
// Deliberately not a cut of the victim: the curve is geometric (900*1.105^L), so
// a percentage of a level-100 victim is ~800 levels of a level-10 killer's
// progress. See AI_REFACTORING_NOTES.md.
uint32_t Game::pvpKillExperience(const Player& killer, const Player& victim) const
{
	const int32_t pct = getNumber(ConfigManager::PVP_KILL_XP_PERCENT);
	if (pct <= 0) return 0; // 0 = disabled

	const uint32_t killerLevel = killer.getLevel();
	// getRequiredXP is monotonic and saturates, so this cannot underflow; at the
	// uint32 ceiling it becomes 0 and the kill simply pays nothing.
	const uint32_t levelCost = killer.getRequiredXP(killerLevel + 1) - killer.getRequiredXP(killerLevel);
	if (levelCost == 0) return 0;

	// Ratio in percent so the whole computation stays integral.
	const int32_t maxPct = std::max(0, getNumber(ConfigManager::PVP_KILL_XP_MAX_PERCENT));
	const uint64_t ratioPct = std::min<uint64_t>(
		(static_cast<uint64_t>(victim.getLevel()) * 100) / std::max<uint32_t>(1, killerLevel),
		static_cast<uint64_t>(maxPct));

	// uint64: levelCost alone reaches ~4.29e9 near the cap.
	const uint64_t reward = (static_cast<uint64_t>(levelCost) * static_cast<uint64_t>(pct) * ratioPct) / 10000ULL;
	return static_cast<uint32_t>(std::min<uint64_t>(reward, std::numeric_limits<uint32_t>::max()));
}

void Game::handlePlayerKill(Player* killer, Player* victim)
{
	if (!killer || !victim) return;
	// Counted before any of the early returns below: those decide XP and karma,
	// not whether a life was taken.
	killer->addKill();
    g_events.emit({EventType::PlayerKill, killer, ""});
    const bool rankedKill = g_accountRuns.playerKill(killer, victim);

	fmt::print("DEBUG: handlePlayerKill called - Killer: {} (karmaLevel={}, karmaKills={}), Victim: {} (karmaLevel={}, karmaKills={})\n",
		killer->getName(), static_cast<int>(killer->getKarmaLevel()), killer->getKarmaKills(),
		victim->getName(), static_cast<int>(victim->getKarmaLevel()), victim->getKarmaKills());

	// Killing a GHOUL pays what that creature is worth (agents.xml <vitals
	// experience>), not the PvP formula. The two answer different questions:
	// the PvP reward is a fraction of the killer's own level curve, because a
	// player's value is relative to whoever killed them, while a ghoul is a
	// monster with a price on it -- and the price is the same whether the body
	// was walking itself around at night or being driven by somebody. Killing
	// an armoured ghoul should be worth 5000 to anyone.
	//
	// And it moves no karma, either way round: karma tracks what players do to
	// PLAYERS. In a mode where everyone is hostile by design, taxing someone for
	// the kills the mode exists to produce is backwards, and the position reveal
	// a bad karma level triggers would quietly hand the endgame away.
	if (victim->isGhoul()) {
		const AgentData* body = victim->getGhoulData();
		if (body && body->experience > 0) {
			killer->addXP(body->experience, rankedKill);
		}
		return;
	}
	if (killer->isGhoul()) {
		// A ghoul killing a player earns the ordinary PvP reward -- it is still
		// one player taking another's life -- but a body the round handed out
		// cannot accumulate a reputation.
		if (const uint32_t xp = pvpKillExperience(*killer, *victim); xp > 0) {
			killer->addXP(xp, rankedKill);
		}
		return;
	}

	// Above the self-defense return below: that decides whether the kill moves
	// KARMA, not whether it happened. addXP applies the rate and karma rates.
	if (const uint32_t xp = pvpKillExperience(*killer, *victim); xp > 0) {
		killer->addXP(xp, rankedKill);
	}

	// Self-defense check: if the victim attacked the killer recently, the kill does not affect karma.
	if (killer->hasAttackedRecently(victim->getGUID())) {
		fmt::print("DEBUG: Player {} killed {} in self-defense. Karma not affected.\n", killer->getName(), victim->getName());
		return;
	}

	uint8_t killerKarma = killer->getKarmaLevel();
	uint8_t victimKarma = victim->getKarmaLevel();

	if (killerKarma == victimKarma) {
		// Kill same karma: lose karma (go towards bad/devil, i.e., increment karma kills counter)
		killer->setKarmaKills(killer->getKarmaKills() + 1);
	} else if (victimKarma > killerKarma) {
		// Kill worse karma (victim is worse): win karma (go towards good, i.e., decrement karma kills counter)
		if (killer->getKarmaKills() > 0) {
			killer->setKarmaKills(killer->getKarmaKills() - 1);
		}
	} else {
		// Kill better karma (victim is better): lose karma (go towards bad/devil, i.e., increment karma kills counter)
		killer->setKarmaKills(killer->getKarmaKills() + 1);
	}

	fmt::print("DEBUG: Player {} killed {}. New Killer Karma Level: {}, Karma Kills: {}\n",
		killer->getName(), victim->getName(), static_cast<int>(killer->getKarmaLevel()), killer->getKarmaKills());
}

void Game::updateBadKarmaPositions()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	const float mapWidth = static_cast<float>(MapSize::widthUnits());
	const float mapHeight = static_cast<float>(MapSize::heightUnits());

	Player* worstPlayer = nullptr;
	for (const auto& [id, player] : players) {
		if (player && player->getKarmaLevel() >= 4) { // Savage (4) or Devil (5)
			if (!worstPlayer || player->getKarmaLevel() > worstPlayer->getKarmaLevel() ||
				(player->getKarmaLevel() == worstPlayer->getKarmaLevel() && player->getScore() > worstPlayer->getScore())) {
				worstPlayer = player;
			}
		}
	}

	if (worstPlayer) {
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::WORST_KARMA_PLAYER));
		msg.addByte(static_cast<uint8_t>(worstPlayer->getGUID()));
		
		Position pos = worstPlayer->getPosition();
		uint8_t bx = static_cast<uint8_t>(std::clamp(pos.x * 255.0f / mapWidth, 0.0f, 255.0f));
		uint8_t by = static_cast<uint8_t>(std::clamp(pos.y * 255.0f / mapHeight, 0.0f, 255.0f));
		msg.addByte(bx);
		msg.addByte(by);
		msg.addByte(worstPlayer->getKarmaClientIcon());

		// Broadcast to all other players
		for (const auto& [id, player] : players) {
			if (player && player != worstPlayer && player->client) {
				player->client->writeToOutputBuffer(msg);
			}
		}
	}

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, BAD_KARMA_PERIOD_MS),
		[this]() { this->updateBadKarmaPositions(); }));
}

// kickIdlePlayerAfterMinutes. Covers BOTH kinds of idle: a connected player who
// has sent no input, and a client-less AFK character left behind by a dropped
// connection -- the second is the one that leaks GUID slots against the hard
// 255-player ceiling, because a character now survives its session.
//
// Kicking goes through kickPlayer, so the character leaves the world WITHOUT
// dropping its inventory: only death drops loot (Player::changeHealth), and a
// kick is not a death.
void Game::updateIdleKick()
{
	pruneGuestRewards();
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	const int32_t minutes = getNumber(ConfigManager::KICK_AFTER_MINUTES);
	if (minutes > 0) {
		const uint64_t limitMs = static_cast<uint64_t>(minutes) * 60ULL * 1000ULL;

		// Collected first: kickPlayer mutates the players map.
		std::vector<Player*> targets;
		for (const auto& it : players) {
			Player* p = it.second;
			// Admins are exempt: an admin parked in ghost mode watching the
			// server is doing their job, not idling.
			if (!p || p->hasGroupFlag(GroupFlag::NoIdleKick)) continue;
			if (p->getIdleMs(startedAt) >= limitMs) {
				targets.push_back(p);
			}
		}

		for (Player* p : targets) {
			fmt::print(">> Kicked {} (guid {}) after {} minutes idle{}.\n",
				p->getName(), p->getGUID(), minutes,
				p->getProtocolGame() ? "" : " (no connection)");
			kickPlayer(p, DisconnectReason::IDLE);
		}
	}

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, IDLE_CHECK_PERIOD_MS),
		[this]() { this->updateIdleKick(); }));
}

void Game::updateTeamPositions()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	if (activeMode && activeMode->clansEnabled) {
		const float mapWidth = static_cast<float>(MapSize::widthUnits());
		const float mapHeight = static_cast<float>(MapSize::heightUnits());
		uint64_t now = OTSYS_TIME();

		for (auto& [cid, clan] : clans) {
			if (clan.members.size() < 2) {
				continue;
			}

			bool needSync = (now - clan.lastSyncTime >= 5000);

			if (!needSync) {
				for (uint32_t mGuid : clan.members) {
					Player* m = getPlayerByGUID(mGuid);
					if (m) {
						Position currentPos = m->getPosition();
						if (currentPos.getDistance(m->lastSentTeamPosition) > 240) {
							needSync = true;
							break;
						}
					}
				}
			}

			if (needSync) {
				clan.lastSyncTime = now;

				NetworkMessage msg;
				msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_POSITIONS));
				for (uint32_t mGuid : clan.members) {
					Player* m = getPlayerByGUID(mGuid);
					if (m) {
						Position pos = m->getPosition();
						uint8_t bx = static_cast<uint8_t>(std::clamp(pos.x * 255.0f / mapWidth, 0.0f, 255.0f));
						uint8_t by = static_cast<uint8_t>(std::clamp(pos.y * 255.0f / mapHeight, 0.0f, 255.0f));
						msg.addByte(bx);
						msg.addByte(by);
						msg.addByte(static_cast<uint8_t>(m->getGUID()));

						m->lastSentTeamPosition = pos;
						m->lastSentTeamPositionTime = now;
					}
				}

				for (uint32_t mGuid : clan.members) {
					Player* m = getPlayerByGUID(mGuid);
					if (m && m->client) {
						m->client->writeToOutputBuffer(msg);
					}
				}
			}
		}
	}

	g_scheduler.addEvent(createSchedulerTask(nextPeriodDelay(startedAt, TEAM_POSITIONS_PERIOD_MS),
		[this]() { this->updateTeamPositions(); }));
}
