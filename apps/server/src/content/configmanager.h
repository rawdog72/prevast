// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_CONFIGMANAGER_H
#define FS_CONFIGMANAGER_H

namespace ConfigManager {

	enum boolean_config_t
	{
		ALLOW_CLONES,
		ALLOW_RECONNECT,
		BIND_ONLY_GLOBAL_ADDRESS,
		PUSH_PLAYER_OUT_OF_OBJECTS,
		USE_DATABASE,
		PERF_STATS,
		SHOW_ENVIRONMENT_DAMAGE_TO_OTHERS,
		SCALE_WORLD_CONTENT,
		// Seeds ServerInfo/ServerListing at boot; ask those for the live value.
		SERVER_VISIBLE,
		PUBLIC_TLS,
		// Pack a tick's messages for one client into a single WebSocket frame.
		// Off = one frame per message, the pre-1401 wire. See ServerOpcode::BATCH.
		BATCH_OUTPUT_FRAMES,
		// Per-IP connect rate limiting in server.cpp::acceptConnection.
		// Off = every connection is accepted at any rate, which a stress fleet
		// needs and the open internet should never get.
		CONNECT_THROTTLE,
		TRUST_ACCOUNT_GROUPS,
		// Account stats and achievements are written to the web host
		// (ProgressSystem). Off for benchmark and test profiles.
		RECORD_ACCOUNT_PROGRESS,

		LAST_BOOLEAN_CONFIG /* this must be the last one */
	};

	enum string_config_t
	{
		MAP_NAME,
		SERVER_NAME,
		OWNER_NAME,
		OWNER_EMAIL,
		URL,
		LOCATION,
		IP,
		WORLD_TYPE,
		MYSQL_HOST,
		MYSQL_USER,
		MYSQL_PASS,
		MYSQL_DB,
		MYSQL_SOCK,
		MAP_AUTHOR,
		CONFIG_FILE,
		ADMIN_PASSWORD,
		GAME_MODE,
		// Directory the XML content files are read from. See contentFile().
		CONTENT_PATH,
		STORAGE_PATH,
		SERVER_TYPE,
		PUBLIC_HOST,
		LISTING_URL,
		LISTING_TOKEN,
		LISTING_ID,
		ACCOUNT_PUBLIC_KEY,
		ACCOUNT_SERVICE_URL,
		ACCOUNT_ADMIN_TOKEN,
		ACCOUNT_PROGRESS_TOKEN,
		// A World & Mode Editor project run as the world (scenario_world.h).
		// Empty = the ordinary generated world.
		SCENARIO_FILE,

		LAST_STRING_CONFIG /* this must be the last one */
	};

	enum integer_config_t
	{
		SQL_PORT,
		MAX_PLAYERS,
		RATE_EXPERIENCE,
		RATE_LOOT,
		RATE_SPAWN,
		KILLS_TO_RED,
		KILLS_TO_BLACK,
		MAX_MESSAGEBUFFER,
		ACTIONS_DELAY_INTERVAL,
		EX_ACTIONS_DELAY_INTERVAL,
		KICK_AFTER_MINUTES,
		STATUSQUERY_TIMEOUT,
		MAX_PLAYERS_PER_IP,
		GAME_PORT,
		STATUS_PORT,
		HTTP_PORT,
		HTTP_WORKERS,
		MAX_PACKETS_PER_SECOND,
		MAX_CONNECTIONS,
		MAX_CONNECTIONS_PER_IP,
		STAMINA_REGEN_MINUTE,
		MAX_VIEWPORT_X,
		MAX_VIEWPORT_Y,
		EVENT_BROADCAST_RADIUS,
		HIT_FLASH_THROTTLE_MS,
		EVENT_FRAMES_PER_TICK,
		ENTITY_UPDATES_PER_TICK,
		PROJECTILE_VIEW_RADIUS,
		// Map size in TILES. Read once at boot to seed MapSize, which owns the
		// live value from then on -- !map-size can move it, and a config entry
		// that stops matching the file it came from is a trap. Always ask
		// MapSize::tilesX()/widthUnits(), never these.
		MAP_TILES_X,
		MAP_TILES_Y,
		// The retired world-unit keys, kept only so an unmigrated config.lua
		// still boots (with a warning). 0 = absent. See MapSize::loadFromConfig.
		MAP_LEGACY_WIDTH,
		MAP_LEGACY_HEIGHT,
		WORLD_FILL_PERCENT,
		AGENT_POPULATION_CAP,
		STRUCTURE_GROWTH_PERCENT,
		CLAN_ACTION_DELAY,
		INTERACTION_SLOW_AMOUNT,
		LOOT_DESPAWN_SECONDS,
		SELF_DEFENSE_MINUTES,
		WORLD_SEED,
		SPAWN_X,
		SPAWN_Y,
		SPAWN_SPREAD,
		NETWORK_THREADS,
		CLIENT_MAX_ENTITY_ID,
		ENTITY_ID_RESERVE_PROJECTILES,
		ENTITY_ID_CAP_OBJECTS,
		ENTITY_ID_CAP_LOOT,
		STARTING_LEVEL,
		PVP_KILL_XP_PERCENT,
		PVP_KILL_XP_MAX_PERCENT,
		PUBLIC_PORT,
		LISTING_INTERVAL_SECONDS,
		// Part of every scenario NPC's stock key: raise it to start a scenario's
		// shops from fresh stock without touching the project (scenario_population.h).
		SCENARIO_STATE_GENERATION,

		LAST_INTEGER_CONFIG /* this must be the last one */
	};

	bool load();

	const std::string& getString(string_config_t what);
	int32_t getNumber(integer_config_t what);
	bool getBoolean(boolean_config_t what);


}; // namespace ConfigManager

#endif // FS_CONFIGMANAGER_H
