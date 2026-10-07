// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "content/configmanager.h"

#include "gameplay/game.h"
#include "core/pugicast.h"

#if __has_include("luajit/lua.hpp")
#include <luajit/lua.hpp>
#else
#include <lua.hpp>
#endif
#include "core/tools.h"

#if LUA_VERSION_NUM >= 502
#undef lua_strlen
#define lua_strlen lua_rawlen
#endif

//extern Game g_game;

namespace {

	std::array<std::string, ConfigManager::LAST_STRING_CONFIG> string = {};
	std::array<std::atomic<int32_t>, ConfigManager::LAST_INTEGER_CONFIG> integer = {};
	std::array<std::atomic<bool>, ConfigManager::LAST_BOOLEAN_CONFIG> boolean = {};


	bool loaded = false;

	std::string getEnv(const char* envVar, std::string defaultValue)
	{
		if (auto value = std::getenv(envVar)) {
			if (strlen(value)) {
				return { value };
			}
		}
		return defaultValue;
	}

	uint16_t getEnv(const char* envVar, uint16_t defaultValue)
	{
		if (auto value = std::getenv(envVar)) {
			if (strlen(value)) {
				return pugi::cast<uint16_t>(value);
			}
		}
		return defaultValue;
	}

	std::string getGlobalString(lua_State* L, const char* identifier, const char* defaultValue)
	{
		lua_getglobal(L, identifier);
		if (!lua_isstring(L, -1)) {
			lua_pop(L, 1);
			return defaultValue;
		}

		size_t len = lua_strlen(L, -1);
		std::string ret(lua_tostring(L, -1), len);
		lua_pop(L, 1);
		return ret;
	}

	int32_t getGlobalNumber(lua_State* L, const char* identifier, const int32_t defaultValue = 0)
	{
		lua_getglobal(L, identifier);
		if (!lua_isnumber(L, -1)) {
			lua_pop(L, 1);
			return defaultValue;
		}

		int32_t val = lua_tonumber(L, -1);
		lua_pop(L, 1);
		return val;
	}

	bool getGlobalBoolean(lua_State* L, const char* identifier, const bool defaultValue)
	{
		lua_getglobal(L, identifier);
		if (!lua_isboolean(L, -1)) {
			if (!lua_isstring(L, -1)) {
				lua_pop(L, 1);
				return defaultValue;
			}

			size_t len = lua_strlen(L, -1);
			std::string ret(lua_tostring(L, -1), len);
			lua_pop(L, 1);
			return booleanString(ret);
		}

		int val = lua_toboolean(L, -1);
		lua_pop(L, 1);
		return val != 0;
	}

} // namespace

bool ConfigManager::load()
{
	lua_State* L = luaL_newstate();
	if (!L) {
		throw std::runtime_error("Failed to allocate memory");
	}

	luaL_openlibs(L);

	if (string[CONFIG_FILE].empty()) {
		string[CONFIG_FILE] = "config.lua";
	}

	if (luaL_dofile(L, string[CONFIG_FILE].data())) {
		std::cout << "[Error - ConfigManager::load] " << lua_tostring(L, -1) << std::endl;
		lua_close(L);
		return false;
	}

	// parse config
	if (!loaded) { // info that must be loaded one time (unless we reset the modules involved)
		boolean[BIND_ONLY_GLOBAL_ADDRESS] = getGlobalBoolean(L, "bindOnlyGlobalAddress", false);
		if (string[IP] == "") {
			string[IP] = getGlobalString(L, "ip", "127.0.0.1");
		}

		string[MAP_NAME] = getGlobalString(L, "mapName", "forgotten");
		string[MAP_AUTHOR] = getGlobalString(L, "mapAuthor", "Unknown");
		string[ADMIN_PASSWORD] = getGlobalString(L, "adminPassword", "prevast");

		// Both default to 0 = "not in the file", which is what lets
		// MapSize::loadFromConfig tell an absent key from a deliberate one and
		// fall back to the retired mapWidth/mapHeight pair.
		integer[MAP_TILES_X] = getGlobalNumber(L, "mapTilesX", 0);
		integer[MAP_TILES_Y] = getGlobalNumber(L, "mapTilesY", 0);
		integer[MAP_LEGACY_WIDTH] = getGlobalNumber(L, "mapWidth", 0);
		integer[MAP_LEGACY_HEIGHT] = getGlobalNumber(L, "mapHeight", 0);
		integer[CLAN_ACTION_DELAY] = getGlobalNumber(L, "clanActionDelay", 500);

		// database
		boolean[USE_DATABASE] = getGlobalBoolean(L, "useDatabase", false);
		boolean[RECORD_ACCOUNT_PROGRESS] = getGlobalBoolean(L, "recordAccountProgress", false);
		string[MYSQL_HOST] = getEnv("MYSQL_HOST", getGlobalString(L, "mysqlHost", "127.0.0.1"));
		string[MYSQL_USER] = getEnv("MYSQL_USER", getGlobalString(L, "mysqlUser", "forgottenserver"));
		string[MYSQL_PASS] = getEnv("MYSQL_PASSWORD", getGlobalString(L, "mysqlPass", ""));
		string[MYSQL_DB] = getEnv("MYSQL_DATABASE", getGlobalString(L, "mysqlDatabase", "forgottenserver"));
		string[MYSQL_SOCK] = getEnv("MYSQL_SOCK", getGlobalString(L, "mysqlSock", ""));

		integer[SQL_PORT] = getEnv("MYSQL_PORT", getGlobalNumber(L, "mysqlPort", 3306));


		if (integer[GAME_PORT] == 0) {
			integer[GAME_PORT] = getGlobalNumber(L, "gameProtocolPort", 7172);
		}

		integer[STATUS_PORT] = getGlobalNumber(L, "statusProtocolPort", 7171);
		integer[HTTP_PORT] = getGlobalNumber(L, "httpPort", 8080);
		integer[HTTP_WORKERS] = getGlobalNumber(L, "httpWorkers", 1);
	}


	boolean[ALLOW_CLONES] = getGlobalBoolean(L, "allowClones", false);
	boolean[ALLOW_RECONNECT] = getGlobalBoolean(L, "allowReconnect", false);
	boolean[TRUST_ACCOUNT_GROUPS] = getGlobalBoolean(L, "trustAccountGroups", true);
	boolean[PUSH_PLAYER_OUT_OF_OBJECTS] = getGlobalBoolean(L, "pushPlayerOutOfObjects", true);
	boolean[PERF_STATS] = getGlobalBoolean(L, "perfStats", false);
	// Defaults to FALSE: fanning this out is the single most expensive thing the
	// server does when a crowd stands in a radioactive area, and it is cosmetic.
	// See the config.lua comment.
	boolean[SHOW_ENVIRONMENT_DAMAGE_TO_OTHERS] = getGlobalBoolean(L, "showEnvironmentDamageToOthers", false);

	// Whether the counts in resources.xml / modes.xml describe the REFERENCE
	// 150x150 map (true: they scale with area, so a small map is a small version
	// of the same world and a large one is not unfarmably sparse) or are
	// absolute regardless of map size (false: the pre-tile-size behaviour).
	boolean[SCALE_WORLD_CONTENT] = getGlobalBoolean(L, "scaleWorldContentToMapSize", true);
	string[SERVER_NAME] = getGlobalString(L, "serverName", "");
	string[OWNER_NAME] = getGlobalString(L, "ownerName", "");
	string[OWNER_EMAIL] = getGlobalString(L, "ownerEmail", "");
	string[URL] = getGlobalString(L, "url", "");
	string[LOCATION] = getGlobalString(L, "location", "");
	string[WORLD_TYPE] = getGlobalString(L, "worldType", "pvp");
	string[GAME_MODE] = getGlobalString(L, "gameMode", "survival");

	// Where the content files live. "XML" is the directory beside the
	// executable that every build tree has its own copy of; an absolute path
	// points them all at one copy instead. Trailing slashes are trimmed by
	// contentFile() so both spellings work.
	string[CONTENT_PATH] = getGlobalString(L, "contentPath", "data/XML");
	string[STORAGE_PATH] = getGlobalString(L, "storagePath", "storage");
	// Relative to the profile directory, like storagePath. Meant for an
	// isolated test profile: the scenario replaces the generated world.
	string[SCENARIO_FILE] = getGlobalString(L, "scenarioFile", "");
	integer[SCENARIO_STATE_GENERATION] = getGlobalNumber(L, "scenarioStateGeneration", 0);

	// Server list. These only seed ServerInfo; !server-* commands move the live
	// values and deliberately do not write back here.
	string[SERVER_TYPE] = getGlobalString(L, "serverType", "");
	boolean[SERVER_VISIBLE] = getGlobalBoolean(L, "serverVisible", true);
	string[PUBLIC_HOST] = getGlobalString(L, "publicHost", "");
	integer[PUBLIC_PORT] = getGlobalNumber(L, "publicPort", 0);
	boolean[PUBLIC_TLS] = getGlobalBoolean(L, "publicTls", false);
	string[LISTING_URL] = getGlobalString(L, "listingUrl", "");
	string[LISTING_TOKEN] = getGlobalString(L, "listingToken", "");
	string[LISTING_ID] = getGlobalString(L, "listingId", "");
	string[ACCOUNT_PUBLIC_KEY] = getGlobalString(L, "accountPublicKey", "");
	string[ACCOUNT_SERVICE_URL] = getGlobalString(L, "accountServiceUrl", "");
	string[ACCOUNT_ADMIN_TOKEN] = getEnv("PREVAST_ACCOUNT_ADMIN_TOKEN", getGlobalString(L, "accountAdminToken", ""));
	string[ACCOUNT_PROGRESS_TOKEN] = getEnv("PREVAST_ACCOUNT_PROGRESS_TOKEN", getGlobalString(L, "accountProgressToken", ""));
	integer[LISTING_INTERVAL_SECONDS] = getGlobalNumber(L, "listingIntervalSeconds", 10);

	// One WebSocket frame per client per tick instead of one per message.
	// Requires a client that understands ServerOpcode::BATCH, which the version
	// gate already guarantees -- this exists to A/B the change, not to support
	// old clients.
	boolean[BATCH_OUTPUT_FRAMES] = getGlobalBoolean(L, "batchOutputFrames", true);

	// Defaults ON so a config.lua predating this key -- x64/Debug/config.lua is
	// never overwritten -- keeps its anti-DoS protection without being edited.
	boolean[CONNECT_THROTTLE] = getGlobalBoolean(L, "connectThrottle", true);

	integer[MAX_PLAYERS] = getGlobalNumber(L, "maxPlayers");
	integer[RATE_EXPERIENCE] = getGlobalNumber(L, "rateExp", 5);
	integer[RATE_LOOT] = getGlobalNumber(L, "rateLoot", 2);
	integer[RATE_SPAWN] = getGlobalNumber(L, "rateSpawn", 1);
	integer[KILLS_TO_RED] = getGlobalNumber(L, "killsToRedSkull", 3);
	integer[KILLS_TO_BLACK] = getGlobalNumber(L, "killsToBlackSkull", 6);
	integer[ACTIONS_DELAY_INTERVAL] = getGlobalNumber(L, "timeBetweenActions", 200);
	integer[EX_ACTIONS_DELAY_INTERVAL] = getGlobalNumber(L, "timeBetweenExActions", 1000);
	integer[MAX_MESSAGEBUFFER] = getGlobalNumber(L, "maxMessageBuffer", 4);
	integer[KICK_AFTER_MINUTES] = getGlobalNumber(L, "kickIdlePlayerAfterMinutes", 15);
	integer[STATUSQUERY_TIMEOUT] = getGlobalNumber(L, "statusTimeout", 5000);
	integer[MAX_PLAYERS_PER_IP] = getGlobalNumber(L, "maxPlayersPerIp", 0);
	integer[MAX_PACKETS_PER_SECOND] = getGlobalNumber(L, "maxPacketsPerSecond", 25);
	integer[STAMINA_REGEN_MINUTE] = getGlobalNumber(L, "timeToRegenMinuteStamina", 3 * 60);
	// 0 is the client's own starting level (client.js PLAYER.level = 0). Clamped
	// to PLAYER_MAX_LEVEL where it is applied, in the Player constructor.
	integer[STARTING_LEVEL] = getGlobalNumber(L, "startingLevel", 0);

	// Integer percents deliberately: getGlobalNumber truncates through
	// lua_tonumber, so a fractional value would silently become 0 (= disabled).
	integer[PVP_KILL_XP_PERCENT] = getGlobalNumber(L, "pvpKillXpPercent", 10);
	integer[PVP_KILL_XP_MAX_PERCENT] = getGlobalNumber(L, "pvpKillXpMaxPercent", 200);

	integer[MAX_VIEWPORT_X] = getGlobalNumber(L, "maxViewportX", 1100);
	integer[MAX_VIEWPORT_Y] = getGlobalNumber(L, "maxViewportY", 1100);

	// How far a purely COSMETIC event (hit flash, heal pulse, eat, gauge
	// notification) is broadcast. Distinct from maxViewport, which is what a
	// client is told about at all: the client only DRAWS ~1280x720 world units
	// (client.js options.size 1280, scaleby = max(h/880, w/1280)), so a flash
	// on a player further away than this cannot be seen by anyone.
	//
	// It matters because these are the only messages that cost one WebSocket
	// frame per spectator per event: 250 crowded players shooting each other
	// produced 31-34k frames/s against ~750/s for the whole entity stream, and
	// backed the output queues up 3.5-5.8k messages deep. 0 = fall back to the
	// full viewport (the pre-2026-08-05 behaviour).
	// 750 is the distance to the CORNER of what the client draws: the visible
	// rectangle is ~1280x720 world units, so its half-diagonal is
	// sqrt(640^2 + 360^2) = 734. Anything beyond that is off screen by
	// construction.
	integer[EVENT_BROADCAST_RADIUS] = getGlobalNumber(L, "eventBroadcastRadius", 750);

	// Hard cap on cosmetic event frames delivered to ONE client in ONE tick.
	// The radius and the throttle both bound how many events happen; this
	// bounds the fan-out itself, which is the term that actually explodes -- a
	// single hit flash in a 250-player brawl costs up to 250 WebSocket frames,
	// so no per-event limit can make the worst case safe on its own.
	//
	// At 20 ticks/s a budget of 3 is 60 flashes a second reaching one player,
	// well past what anyone can perceive when each flash lasts 300ms. Frames
	// over budget are dropped, not queued: they are cosmetic pulses, and a
	// pulse delivered late is worse than one not delivered. 0 = unlimited.
	integer[EVENT_FRAMES_PER_TICK] = getGlobalNumber(L, "eventFramesPerTick", 3);

	// Soft cap on entity-position records sent to ONE client in ONE tick.
	//
	// A dispersed player sees a few dozen entities and never reaches this, so
	// ordinary play is bit-for-bit unchanged. A player standing in a 250-player
	// crowd sees ~620 and was being sent all of them every tick -- 366 records
	// per client per tick, ~900k records/s across the fleet, which is both the
	// server's `flush` cost and the browser's parse cost.
	//
	// Over budget, each entity is refreshed once every ceil(visible/budget)
	// ticks instead of every tick, spread evenly by entity id so the load is
	// flat rather than bursty. This is safe because client.js dead-reckons:
	// moveEntitie keeps walking an entity toward the last destination it was
	// given, so a skipped tick costs positional accuracy, not motion. What it
	// costs is measured by the generator's per-band drift metric.
	//
	// Never skipped: an entity entering view, an entity leaving it (a dropped
	// removal is a permanent client-side ghost), and the player's own record.
	// 0 = unlimited (the pre-2026-08-05 behaviour).
	integer[ENTITY_UPDATES_PER_TICK] = getGlobalNumber(L, "entityUpdatesPerTick", 200);

	// How far a PROJECTILE is visible, as opposed to maxViewport which governs
	// everything else.
	//
	// Projectiles are the one entity class whose cost is dominated by entering
	// and leaving view rather than by moving: a bullet lives ~450ms, so almost
	// its entire record cost is one appearance and one removal per observer,
	// and neither can be skipped (a dropped removal is a permanent client-side
	// ghost). With 250 players firing, that was ~1,200 bullets/s x 250
	// observers x 2 records -- essentially the entire record volume of a
	// firefight, and unreachable by the entityUpdatesPerTick budget by
	// construction.
	//
	// A bullet sprite is 4 units across and the client draws ~1280x720 world
	// units, so one further away than this cannot be seen even in principle.
	// 0 = use maxViewport (the pre-2026-08-05 behaviour).
	integer[PROJECTILE_VIEW_RADIUS] = getGlobalNumber(L, "projectileViewRadius", 900);

	// Minimum gap between hit-flash broadcasts ABOUT one victim TO other
	// players. client.js sets `player.hurt = 300` on PLAYER_HIT, so a second
	// flash inside 300ms only restarts a timer that is already running and
	// cannot be seen. The victim's own client is never throttled -- that is one
	// frame, and it carries their screen shake. 0 disables.
	integer[HIT_FLASH_THROTTLE_MS] = getGlobalNumber(L, "hitFlashThrottleMs", 300);

	// The share of the map that world generation may cover. Reloadable rather
	// than boot-only because it only ever takes effect during generation, and
	// !seed / !map-size both regenerate.
	//
	// 50 is not a tuning choice, it is the measured status quo plus headroom: at
	// the reference 150x150 the shipped content is 4,798 tiles of structures
	// plus 5,460 resources = 10,258 of 22,500, i.e. ~46%. So this default
	// changes nothing about the standard world (verify by the absence of a
	// "scaled"/"dropped" line at boot) and only ever binds on a map small enough
	// for the absolute XML counts to overrun it.
	integer[WORLD_FILL_PERCENT] = getGlobalNumber(L, "worldFillPercent", 50);
	integer[AGENT_POPULATION_CAP] = getGlobalNumber(L, "agentPopulationCap", 500);
	integer[STRUCTURE_GROWTH_PERCENT] = getGlobalNumber(L, "structureGrowthPercent", 40);

	integer[INTERACTION_SLOW_AMOUNT] = getGlobalNumber(L, "interactionSlowAmount", 70);
	integer[LOOT_DESPAWN_SECONDS] = getGlobalNumber(L, "lootDespawnSeconds", 0);
	integer[SELF_DEFENSE_MINUTES] = getGlobalNumber(L, "selfDefenseMinutes", 20);
	// 0 (or the word "random") = draw a seed from the clock, which is the normal
	// behaviour. A specific number makes world generation reproducible -- see
	// the comment in prevast_server.cpp where it is applied. Under a mode that
	// rebuilds the world between rounds it also decides whether every round gets
	// a fresh map or replays the same one.
	//
	// Accepting the string is cosmetic: `seed = "random"` says out loud what
	// `seed = 0` means, and both land on the same 0.
	{
		lua_getglobal(L, "seed");
		const bool isWord = !lua_isnumber(L, -1) && lua_isstring(L, -1);
		std::string word;
		if (isWord) {
			word = std::string(lua_tostring(L, -1), lua_strlen(L, -1));
		}
		lua_pop(L, 1);

		if (isWord) {
			std::transform(word.begin(), word.end(), word.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			if (word != "random") {
				reportStartupWarning(fmt::format(
					"seed = \"{}\" is not a number or \"random\"; using a clock seed", word));
			}
			integer[WORLD_SEED] = 0;
		} else {
			integer[WORLD_SEED] = getGlobalNumber(L, "seed", 0);
		}
	}

	// New players used to be placed at a hardcoded (4000, 4000). That is fine
	// for a handful of players but it means every concurrent player piles into
	// a single viewport, and visibility cost is O(players in view) per player
	// -- i.e. quadratic in how many share one screen, regardless of how big the
	// map is. spawnSpread = 0 keeps the old single-point behaviour exactly;
	// non-zero scatters new players uniformly in a square of that half-width
	// around (spawnX, spawnY), clamped to the map.
	integer[SPAWN_X] = getGlobalNumber(L, "spawnX", 4000);
	integer[SPAWN_Y] = getGlobalNumber(L, "spawnY", 4000);
	integer[SPAWN_SPREAD] = getGlobalNumber(L, "spawnSpread", 0);
	integer[NETWORK_THREADS] = getGlobalNumber(L, "networkThreads", 0);

	// Client entity id space. All classes now draw from ONE shared pool of
	// id16 values; these are the only two ways to partition it. See the block
	// comment in definitions.h for why an id16 collision is so damaging, and
	// config.lua for what each knob costs. clientMaxEntityId must match
	// Entitie.init()'s second argument in client.js.
	integer[CLIENT_MAX_ENTITY_ID] = getGlobalNumber(L, "clientMaxEntityId",
		static_cast<int32_t>(CLIENT_ENTITY_ID_SPACE_DEFAULT));
	integer[ENTITY_ID_RESERVE_PROJECTILES] = getGlobalNumber(L, "entityIdReserveProjectiles", 0);
	integer[ENTITY_ID_CAP_OBJECTS] = getGlobalNumber(L, "entityIdCapObjects", 0);
	integer[ENTITY_ID_CAP_LOOT] = getGlobalNumber(L, "entityIdCapLoot", 0);

	// The five entityBand* keys were replaced by the shared pool. Reading them
	// back only to say they are ignored: a stale config that still sets them
	// would otherwise look like it is tuning something.
	for (const char* obsolete : {"entityBandResources", "entityBandProjectiles",
	                             "entityBandObjects", "entityBandLoot", "entityBandAgents"}) {
		if (getGlobalNumber(L, obsolete, -1) != -1) {
			reportStartupWarning(fmt::format(
				"config.lua sets {}, which no longer exists and is ignored. Entity ids now "
				"come from one shared pool; see entityIdReserveProjectiles / entityIdCap*.",
				obsolete));
		}
	}

	integer[MAX_CONNECTIONS] = getGlobalNumber(L, "maxConnections", 1024);
	integer[MAX_CONNECTIONS_PER_IP] = getGlobalNumber(L, "maxConnectionsPerIp", 64);
	loaded = true;
	lua_close(L);

	return true;
}

const std::string& ConfigManager::getString(string_config_t what)
{
	static std::string dummyStr;
	if (what >= LAST_STRING_CONFIG) {
		std::cout << "[Warning - ConfigManager::getString] Accessing invalid index: " << what << std::endl;
		return dummyStr;
	}
	return string[what];
}

int32_t ConfigManager::getNumber(integer_config_t what)
{
	if (what >= LAST_INTEGER_CONFIG) {
		std::cout << "[Warning - ConfigManager::getNumber] Accessing invalid index: " << what << std::endl;
		return 0;
	}
	return integer[what];
}

bool ConfigManager::getBoolean(boolean_config_t what)
{
	if (what >= LAST_BOOLEAN_CONFIG) {
		std::cout << "[Warning - ConfigManager::getBoolean] Accessing invalid index: " << what << std::endl;
		return false;
	}
	return boolean[what];
}
