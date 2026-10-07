// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/account_runs.h"

#include "gameplay/game.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/progress/progress_system.h"

// The admin chat-command layer: everything reachable by typing "!something"
// into chat, plus the small string helpers those commands parse with. Lifted
// out of game.cpp (2026-08-03) because it is a self-contained subsystem that
// shares nothing with the tick but the Game object it hangs off -- the same
// reason game_agents.cpp exists.
//
// The client splits admin output on '!' and drops frames over 8192 bytes, so
// long replies stream rather than concatenate; see sendAdminReply.

#include "persistence/ban.h"
#include "content/configmanager.h"
#include "gameplay/creature.h"
#include "persistence/database.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "network/server.h"
#include "network/serverinfo.h"
#include "network/serverlisting.h"
#include "gameplay/loot.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "gameplay/agent.h"
#include "gameplay/item.h"
#include "world/collision.h"
#include "gameplay/projectile.h"
#include "gameplay/equipment.h"
#include "gameplay/kit.h"
#include "world/structure.h"
#include "gameplay/condition.h"
#include "content/contentexport.h"
#include "network/protocolgame.h"
#include "world/mapimport.h"
#include "network/outputmessage.h"
#include "network/http_client.h"

#include <array>
#include <boost/json.hpp>
#include <cctype>
#include <cmath>
#include <fstream>

void Game::adminBanIp(Player* admin, const Connection::Address& ip, uint32_t minutes, const std::string& reason)
{
	if (ip.is_unspecified()) {
		fmt::print(">> [Admin] ban: no valid IP to ban.\n");
		return;
	}

	IOBan::BanInfo info;
	info.bannedBy = admin->getName();
	info.reason = reason.empty() ? "(none)" : reason;
	info.expiresAt = (minutes == 0) ? 0 : time(nullptr) + static_cast<time_t>(minutes) * 60;
	IOBan::addIpBan(ip, info);

	if (ip == admin->getIP()) {
		fmt::print(fg(fmt::color::yellow), ">> [Admin] WARNING: you banned your own IP ({0}) — you cannot reconnect after disconnecting. Use !unban={0} to lift it.\n", ip.to_string());
	}

	// The ban only blocks new connections; kick every non-admin already
	// online from that IP. Collect first: kicking mutates nothing during
	// iteration (removal is deferred), but stay defensive.
	std::vector<Player*> toKick;
	for (const auto& it : players) {
		Player* p = it.second;
		if (p->getAuthorityRank() < admin->getAuthorityRank() && p->getIP() == ip) {
			toKick.push_back(p);
		}
	}

	const std::string detail = (minutes == 0)
		? fmt::format("Permanent. Banned by {:s}.\nReason: {:s}", info.bannedBy, info.reason)
		: fmt::format("For {:d} minutes. Banned by {:s}.\nReason: {:s}", minutes, info.bannedBy, info.reason);
	for (Player* p : toKick) {
		kickPlayer(p, DisconnectReason::IP_BANNED, detail);
	}

	fmt::print(">> [Admin] {} banned IP {} ({}), reason: {} — kicked {} player(s)\n",
		admin->getName(), ip.to_string(),
		minutes == 0 ? std::string("permanent") : fmt::format("{} min", minutes),
		info.reason, toKick.size());
}

// --- parseAdminCommand handlers (bodies unchanged, extracted for readability) ---

// "key" or "key*count": adds to the inventory, overflow drops as loot.
//
// The requested count is NOT a byte. A single stack is capped at the item's
// <stack> (255 at most), but the order is not: !i=wood*600 means six hundred
// logs -- two full stacks and one of ninety -- and truncating it to uint8_t
// silently delivered 88. Inventory::addItem already spreads one batch across
// slots, filling partial stacks before opening new ones, so the whole order is
// just a sequence of byte-sized batches.
uint32_t Game::adminGiveItem(Player* target, const std::string& itemArg)
{
	if (!target) {
		return 0;
	}

	std::string key = itemArg;
	uint32_t requested = 1;

	if (const size_t starPos = itemArg.find('*'); starPos != std::string::npos) {
		key = itemArg.substr(0, starPos);
		try {
			const long long parsed = std::stoll(itemArg.substr(starPos + 1));
			if (parsed <= 0) {
				return 0;
			}
			// Bounds the WORK, not the id pool -- the ground-loot pool is
			// protected further down by the ids actually free, which is the only
			// thing that can protect it. This just stops !i=wood*99999999999 from
			// spending a visible slice of a tick counting to itself.
			requested = static_cast<uint32_t>(std::min<long long>(parsed, ADMIN_GIVE_ITEM_MAX));
			if (parsed > ADMIN_GIVE_ITEM_MAX) {
				fmt::print(fg(fmt::color::yellow), ">> [Admin] !i count {} clamped to {}\n",
					parsed, ADMIN_GIVE_ITEM_MAX);
			}
		} catch (...) { requested = 1; }
	}

	const ItemData* idata = ItemManager::getInstance().getItemData(key);
	if (!idata) return 0;

	g_accountRuns.disqualify(target);
	uint32_t remaining = requested;

	while (remaining > 0) {
		const uint8_t batch = static_cast<uint8_t>(std::min<uint32_t>(remaining, 255));
		const uint8_t added = target->inventory.addItem(idata->id, batch);
		remaining -= added;
		if (added < batch) {
			break; // Inventory full -- the rest goes on the floor.
		}
	}

	// Overflow drops one stack per pile: a pile carries a byte count as well,
	// so a 345-item remainder is not one pile but two.
	//
	// Bounded by the ids actually available, NOT by the count cap. The cap alone
	// protects nothing: an item with stack = 1 turns the request into one loot
	// entity each, and ground loot never despawns here (lootDespawnSeconds = 0
	// is deliberate), so draining the pool stops ALL loot server-wide -- harvest
	// drops, death drops, everything -- silently, until somebody picks this heap
	// up by hand. Half the free room, so an admin convenience can never take the
	// space ordinary play is about to need.
	const uint8_t perStack = std::max<uint8_t>(1, idata->stack);
	const EntityIdPool& pool = map.getEntityIdPool();
	const uint32_t lootCap = pool.capOf(EntityClass::Loot);
	const uint32_t lootRoom = lootCap == 0
		? pool.freeCount()
		: std::min(pool.freeCount(), lootCap - std::min(lootCap, pool.liveCount(EntityClass::Loot)));
	uint32_t pilesLeft = lootRoom / 2;

	std::vector<LootDrop> drops;
	while (remaining > 0 && pilesLeft > 0) {
		const uint8_t drop = static_cast<uint8_t>(std::min<uint32_t>(remaining, perStack));
		drops.push_back({ idata->lootId, idata->id, drop, ItemState::fresh(idata->id) });
		remaining -= drop;
		--pilesLeft;
	}
	dropLootBurst(target->getPosition(), drops);

	if (remaining > 0) {
		fmt::print(fg(fmt::color::yellow),
			">> [Admin] !i: {} x '{}' undelivered -- inventory full and only {} ground loot ids "
			"were free to spend.\n", remaining, key, lootRoom / 2);
	}
	return remaining;
}

// "nameOrId[:posX:posY[:rotation[:subtype]]]": bulldozes the target tile and
// spawns the resource or object there like a natural spawn.
void Game::adminSpawnNatural(Player* player, const std::string& args)
{
	auto trimView = [](std::string_view sv) -> std::string_view {
		auto start = sv.find_first_not_of(" \t\r\n");
		if (start == std::string_view::npos) return "";
		auto end = sv.find_last_not_of(" \t\r\n");
		return sv.substr(start, end - start + 1);
	};

	auto isInteger = [](const std::string& s) -> bool {
		if (s.empty()) return false;
		size_t start = 0;
		if (s[0] == '-' || s[0] == '+') {
			if (s.size() == 1) return false;
			start = 1;
		}
		// Cast: isdigit is UB on the negative int a signed char gives for UTF-8.
		return std::all_of(s.begin() + start, s.end(),
			[](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; });
	};

	std::vector<std::string_view> argList = explodeString(args, ":");
	std::vector<std::string> parsedArgs;
	for (auto& a : argList) {
		parsedArgs.emplace_back(trimView(a));
	}

	if (parsedArgs.empty() || parsedArgs[0].empty()) {
		return;
	}

	std::string nameOrId = parsedArgs[0];
	uint16_t typeId = 0;
	uint8_t rot = 0;
	// The tile the admin is standing on, snapped to its CENTRE -- not the raw
	// body position, which is an arbitrary point inside that tile.
	//
	// Objects live on the tile grid: everything that places one (the build path,
	// the map importer, world generation) puts it at x*100+50, and the collision
	// box is sized and the sprite drawn on that assumption. Spawning at the
	// admin's exact coordinate produced an object wedged between two tiles,
	// colliding with things it did not look like it touched. The coordinate form
	// a few lines below always centred; only the "here" form did not.
	Position spawnPos = tileCenterPosition(player->getPosition().getX() / TILE_SIZE,
	                                       player->getPosition().getY() / TILE_SIZE);
	bool hasSubtype = false;

	// Format: object:posX:posY:rotation:subtype
	if (parsedArgs.size() >= 3 && !parsedArgs[1].empty() && !parsedArgs[2].empty()) {
		if (isInteger(parsedArgs[1]) && isInteger(parsedArgs[2])) {
			int32_t tx = std::stoi(parsedArgs[1]);
			int32_t ty = std::stoi(parsedArgs[2]);
			spawnPos = clampPositionToMap(tx * TILE_SIZE + (TILE_SIZE / 2), ty * TILE_SIZE + (TILE_SIZE / 2));
		}
	}

	if (parsedArgs.size() >= 4 && !parsedArgs[3].empty()) {
		if (isInteger(parsedArgs[3])) {
			rot = static_cast<uint8_t>(std::stoi(parsedArgs[3]));
		}
	}

	if (parsedArgs.size() >= 5 && !parsedArgs[4].empty()) {
		if (isInteger(parsedArgs[4])) {
			typeId = static_cast<uint16_t>(std::stoi(parsedArgs[4]));
			hasSubtype = true;
		}
	}

	// Cast: isdigit is UB on the negative int a signed char gives for UTF-8.
	bool isNumber = !nameOrId.empty() && std::all_of(nameOrId.begin(), nameOrId.end(),
		[](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; });
	const ResourceData* rd = nullptr;
	const ObjectData* od = nullptr;

	if (isNumber) {
		uint16_t numericId = static_cast<uint16_t>(std::stoi(nameOrId));
		rd = g_resources.getResourceData(numericId);
		od = g_objects.getObjectData(numericId);
	} else {
		rd = g_resources.getResourceData(nameOrId);
		od = g_objects.getObjectData(nameOrId);
	}

	clearTile(spawnPos);

	if (rd) {
		if (!hasSubtype && !rd->types.empty()) {
			typeId = static_cast<uint16_t>(rand() % rd->types.size());
		}
		Resource* res = g_resources.createResource(rd->key, typeId, spawnPos, rot);
		if (res) {
			placeThing(res, spawnPos);
		}
	} else if (od) {
		Object* obj = g_objects.createObject(od->key, spawnPos, rot);
		if (obj) {
			placeThing(obj, spawnPos);
		}
	}
}

void Game::adminSpawnAgent(Player* player, const std::string& args)
{
	// `args` arrives already trimmed from parseAdminCommand.
	if (args.empty()) {
		fmt::print(fmt::fg(fmt::color::yellow), ">> [spawn-agent] usage: spawn-agent=<key>\n");
		return;
	}

	if (!g_agents.getAgentData(args)) {
		fmt::print(fmt::fg(fmt::color::yellow), ">> [spawn-agent] unknown agent '{}'\n", args);
		return;
	}

	// Offset from the admin so the agent is not spawned on top of them (it is
	// solid). No spawn-validation here -- this is a test hook; the natural
	// spawner (later phase) uses isSpawnPositionValid.
	const Position& at = player->getPosition();
	Position spawnPos = clampPositionToMap(static_cast<int32_t>(at.x) + 120, static_cast<int32_t>(at.y));

	// Owner 0 = spawned by the world, not built by a player. That makes an
	// admin-spawned agent behave exactly like a naturally spawned one: it roams
	// hunting for targets rather than guarding the spot it appeared on.
	Agent* agent = g_agents.createAgent(args, spawnPos, 0);
	if (!agent) {
		fmt::print(fmt::fg(fmt::color::yellow), ">> [spawn-agent] could not create '{}' (agent id band exhausted?)\n", args);
		return;
	}

	if (!placeThing(agent, spawnPos)) {
		// Never reached in practice (map.placeThing always succeeds for a fresh
		// entity); guard anyway. Refcount is still 0 here, so delete directly.
		delete agent;
		fmt::print(fmt::fg(fmt::color::yellow), ">> [spawn-agent] placement failed for '{}'\n", args);
		return;
	}

	fmt::print(">> [spawn-agent] spawned '{}' (id16={}) at ({}, {})\n",
		args, agent->getId16(), spawnPos.x, spawnPos.y);
}

// Cycles hidden ghost -> visible ghost -> normal.
void Game::adminToggleGhost(Player* player)
{
	if (!player->isGhostMode()) {
		player->setGhostMode(true);
		player->setGhostVisible(false);
		EntityUpdate removal;
		player->buildRemoval(removal);
		for (auto& it : players) {
			if (it.second != player) {
				it.second->pushUpdate(removal);
				it.second->knownCreatures.erase(player->getID());
			}
		}
	} else if (!player->isGhostVisible()) {
		player->setGhostVisible(true);
		EntityUpdate update;
		player->buildUpdate(update);
		for (auto& it : players) {
			if (it.second != player) {
				it.second->pushUpdate(update);
				it.second->knownCreatures.insert(player->getID());
			}
		}
	} else {
		player->setGhostMode(false);
		player->setGhostVisible(false);
		EntityUpdate update;
		player->buildUpdate(update);
		for (auto& it : players) {
			if (it.second != player) {
				it.second->pushUpdate(update);
				it.second->knownCreatures.insert(player->getID());
			}
		}
		if (player->getProtocolGame()) {
			player->getProtocolGame()->sendGauges();
		}
	}
}

// "[targetId] [levels]": both optional — no args levels the admin by 1.
void Game::adminAddLevel(Player* player, const std::string& args)
{
	std::vector<std::string> argsList;
	std::string currentArg;
	std::stringstream ss(args);
	while (ss >> currentArg) {
		argsList.push_back(currentArg);
	}

	Player* targetPlayer = nullptr;
	uint32_t levelsToAdd = 1;

	if (argsList.empty()) {
		targetPlayer = player;
		levelsToAdd = 1;
	} else if (argsList.size() == 1) {
		try {
			uint32_t idVal = std::stoul(argsList[0]);
			Player* found = getPlayerByGUID(idVal);
			if (!found) found = getPlayerByID(idVal);

			if (found) {
				targetPlayer = found;
				levelsToAdd = 1;
			} else {
				targetPlayer = player;
				levelsToAdd = idVal;
			}
		} catch (...) {
			targetPlayer = player;
			levelsToAdd = 1;
		}
	} else {
		try {
			uint32_t targetId = std::stoul(argsList[0]);
			targetPlayer = getPlayerByGUID(targetId);
			if (!targetPlayer) targetPlayer = getPlayerByID(targetId);

			levelsToAdd = std::stoul(argsList[1]);
		} catch (...) {}
	}

	if (targetPlayer) {
        g_accountRuns.disqualify(targetPlayer);
		// Cap like addXP/grantStartingLevel do: an uncapped admin grant
		// would push level past PLAYER_MAX_LEVEL (and wrap the level byte
		// the client receives).
		const uint32_t headroom = PLAYER_MAX_LEVEL - std::min(targetPlayer->level, PLAYER_MAX_LEVEL);
		targetPlayer->level += std::min(levelsToAdd, headroom);
		targetPlayer->experience = targetPlayer->getRequiredXP(targetPlayer->level);
		if (auto targetClient = targetPlayer->getProtocolGame()) {
			targetClient->sendPlayerXpSkill();
		}
	}
}

void Game::adminPrintBanList()
{
	if (getBoolean(ConfigManager::USE_DATABASE)) {
		// The database is the source of truth when enabled (memory only
		// caches bans seen since this server start).
		DBResult_ptr result = Database::getInstance().storeQuery(
			"SELECT INET6_NTOA(`ip`) AS `ip`, `reason`, `expires_at`, `banned_by` FROM `ip_bans`");
		if (!result) {
			fmt::print(">> [Admin] Ban list is empty.\n");
			return;
		}
		fmt::print(">> [Admin] Ban list (database):\n");
		do {
			time_t expiresAt = result->getNumber<time_t>("expires_at");
			fmt::print("   {} — {} — by {} — {}\n", result->getString("ip"),
				expiresAt == 0 ? std::string("permanent") : fmt::format("until {}", formatDateShort(expiresAt)),
				result->getString("banned_by"), result->getString("reason"));
		} while (result->next());
	} else {
		const auto bans = IOBan::getMemoryBans();
		if (bans.empty()) {
			fmt::print(">> [Admin] Ban list is empty.\n");
			return;
		}
		fmt::print(">> [Admin] Ban list (in-memory, resets on restart):\n");
		for (const auto& [ip, info] : bans) {
			fmt::print("   {} — {} — by {} — {}\n", ip.to_string(),
				info.expiresAt == 0 ? std::string("permanent") : fmt::format("until {}", formatDateShort(info.expiresAt)),
				info.bannedBy, info.reason);
		}
	}
}

static void trimInPlace(std::string& s)
{
	s.erase(s.begin(), std::find_if(s.begin(), s.end(), [](unsigned char ch) {
		return !std::isspace(ch);
	}));
	s.erase(std::find_if(s.rbegin(), s.rend(), [](unsigned char ch) {
		return !std::isspace(ch);
	}).base(), s.end());
}

namespace {
	struct SplitResult {
		std::string left;
		std::string right;
		bool found = false;
	};
}

// Splits on the FIRST separator only, so the right half may contain more of
// them (ban reasons, IPv6 addresses).
static SplitResult splitOnce(const std::string& s, char sep)
{
	const size_t pos = s.find(sep);
	if (pos == std::string::npos) {
		return {};
	}
	return {s.substr(0, pos), s.substr(pos + 1), true};
}

void Game::parseAdminCommand(Player* player, const std::string& cmdLine)
{
	std::string line = cmdLine;
	trimInPlace(line);
	if (line.empty()) return;

	size_t eqPos = line.find('=');
	std::string cmd;
	std::string args;
	if (eqPos == std::string::npos) {
		cmd = line;
	} else {
		cmd = line.substr(0, eqPos);
		args = line.substr(eqPos + 1);
		trimInPlace(args);
	}

	// data/XML/commands.xml; a command not listed there needs the highest rank.
	if (player->getGroupRank() < g_commandPermissions.requiredRank(cmd)) {
		adminReply(player, fmt::format("You may not use !{}.", cmd));
		return;
	}

	if (cmd == "item" || cmd == "i") {
		if (const uint32_t undelivered = adminGiveItem(player, args); undelivered != 0) {
			adminReply(player, fmt::format(
				"{} not delivered: your inventory is full and the ground loot id pool is "
				"nearly spent. Pick up or clear loot before asking for more.", undelivered));
		}
	} else if (cmd == "item-all") {
		for (auto& it : players) {
			adminGiveItem(it.second, args);
		}
	} else if (cmd == "item-player") {
		adminGiveItemToPlayer(args);
	} else if (cmd == "teleport" || cmd == "t") {
		adminTeleport(player, args);
	} else if (cmd == "teleport-to") {
		adminTeleportToPlayer(player, args);
	} else if (cmd == "teleport-player-to") {
		adminTeleportPlayerTo(args);
	} else if (cmd == "teleport-all") {
		adminTeleportAll(player, args);
	} else if (cmd == "spawn-natural" || cmd == "o") {
		adminSpawnNatural(player, args);
	} else if (cmd == "spawn-agent") {
		adminSpawnAgent(player, args);
	} else if (cmd == "agent-debug") {
		adminToggleAgentDebug();
	} else if (cmd == "effects") {
		adminConditions(player, args);
	} else if (cmd == "effects-player") {
		adminConditionsPlayer(player, args);
	} else if (cmd == "effects-cure") {
		adminConditionsCure(player, args);
	} else if (cmd == "effects-agent") {
		adminConditionsAgent(player, args);
	} else if (cmd == "ghoul") {
		adminGhoulRound(player, args);
	} else if (cmd == "a") {
		adminAdvance(player, args);
	} else if (cmd == "ghost") {
		adminToggleGhost(player);
	} else if (cmd == "addlevel") {
		adminAddLevel(player, args);
	} else if (cmd == "invincible") {
		player->setInvincible(!player->isInvincible());
	} else if (cmd == "kick") {
		adminKick(player, args);
	} else if (cmd == "kick-all") {
		adminKickAll(player);
	} else if (cmd == "close") {
		adminSetServerOpen(player, false);
	} else if (cmd == "open") {
		adminSetServerOpen(player, true);
	} else if (cmd == "server-name") {
		adminSetServerName(player, args);
	} else if (cmd == "server-type") {
		adminSetServerType(player, args);
	} else if (cmd == "server-location") {
		adminSetServerLocation(player, args);
	} else if (cmd == "server-visible") {
		adminSetServerVisible(player, args, nullptr);
	} else if (cmd == "hide" || cmd == "show") {
		bool visible = (cmd == "show");
		adminSetServerVisible(player, args, &visible);
	} else if (cmd == "max-players") {
		adminSetMaxPlayers(player, args);
	} else if (cmd == "server-info") {
		adminPrintServerInfo(player);
	} else if (cmd == "ban") {
		adminBanPlayer(player, args);
	} else if (cmd == "ban-ip") {
		adminBanAddress(player, args);
	} else if (cmd == "unban") {
		adminUnban(player, args);
	} else if (cmd == "banlist") {
		adminPrintBanList();
	} else if (cmd == "karma") {
		adminSetKarma(args);
	} else if (cmd == "set-daynight") {
		adminSetDayNight(args);
	} else if (cmd == "craft-speed") {
		adminSetCraftSpeed(args);
	} else if (cmd.rfind("gauge-", 0) == 0) {
		// The gauge name and field ride in the command itself, not the args:
		// the documented form is !gauge-<name>-<field>=<value>.
		adminSetGauge(player, cmd.substr(6), args);
	} else if (cmd == "broadcast" || cmd == "say-all") {
		// !broadcast=<text>: a server-wide announcement, into everyone's Server
		// tab as the admin's line (not into any speech channel).
		if (args.empty()) {
			adminReply(player, "[Admin] Usage: !broadcast=<text>");
		} else {
			broadcastServerLog(ServerLogKind::BROADCAST, static_cast<uint8_t>(player->getGUID()), 0, truncateUtf8(args, MAX_CHAT_LENGTH));
		}
	} else if (cmd == "reload-npcs") {
		adminReloadXml(player, "npcs");
	} else if (cmd == "reload-quests") {
		adminReloadXml(player, "quests");
	} else if (cmd == "quest") {
		adminQuest(player, args);
	} else if (cmd == "achievement") {
		adminAchievement(player, args);
	} else if (cmd == "reload" || cmd == "reload-xml") {
		adminReloadXml(player, args);
	} else if (cmd == "map") {
		// "!map=60:60" is a resize, "!map=<name>" opens a paste session. The two
		// cannot be confused: a map id is a file/name and can never be two
		// numbers with a colon between them, which is what MapSize::parse
		// insists on. !map-size is the documented spelling; this is the shorthand.
		int32_t tilesX = 0, tilesY = 0;
		std::string parseError;
		if (MapSize::parse(args, tilesX, tilesY, parseError)) {
			adminMapSize(player, args);
		} else {
			adminMapPaste(player, args);
		}
	} else if (cmd == "map-size") {
		adminMapSize(player, args);
	} else if (cmd == "b") {
		// A map-editor record. Only meaningful inside an open paste session --
		// see adminMapPaste for why a paste arrives as a stream of these.
		adminMapRecord(player, args);
	} else if (cmd == "map-place") {
		adminMapPlace(player, args);
	} else if (cmd == "map-preview") {
		adminMapPreview(player, args);
	} else if (cmd == "map-undo") {
		adminMapUndo(player);
	} else if (cmd == "map-end") {
		adminMapEnd(player);
	} else if (cmd == "map-at" || cmd == "map-here") {
		adminMapOrigin(player, cmd == "map-here" ? std::string() : args);
	} else if (cmd == "map-list") {
		adminMapList(player);
	} else if (cmd == "map-save") {
		adminMapSave(player, args);
	} else if (cmd == "map-clear") {
		adminMapClear(player, args);
	} else if (cmd == "map-forget") {
		adminMapForget(player, args);
	} else if (cmd == "map-keep" || cmd == "map-drop") {
		adminMapKeep(player, args, cmd == "map-keep");
	} else if (cmd == "map-reload") {
		adminMapReload(player);
	} else if (cmd == "map-respawn") {
		adminMapRespawn(player, args);
	} else if (cmd == "clean") {
		adminCleanWorld(player, args);
	} else if (cmd == "clean-hard" || cmd == "blank") {
		adminCleanWorld(player, args, /*hard=*/true);
	} else if (cmd == "respawn-resources") {
		adminSetResourceRespawn(player, args);
	} else if (cmd == "respawn-structures") {
		adminSetStructureRespawn(player, args);
	} else if (cmd == "structure-place" || cmd == "structure") {
		adminStructurePlace(player, args);
	} else if (cmd == "structure-list-placed" || cmd == "structure-placed") {
		adminStructureListPlaced(player);
	} else if (cmd == "structure-remove") {
		adminStructureRemove(player, args);
	} else if (cmd == "structure-move") {
		adminStructureMove(player, args);
	} else if (cmd == "structure-respawn") {
		adminStructureRespawnOne(player, args);
	} else if (cmd == "structure-list") {
		adminStructureList(player);
	} else if (cmd == "seed") {
		adminSeed(player, args);
	} else if (cmd == "setgroup") {
		adminSetGroup(player, args);
	}
}

// Chat is the only channel an admin sees in-game; the console gets the detail.
void Game::adminReply(Player* player, const std::string& message) const
{
	if (!player) {
		return;
	}
	if (auto client = player->getProtocolGame()) {
		client->sendAdminReply(message);
	}
}

// "12345", or "off"/"never"/"none" for 0. Anything else fails rather than
// defaulting, so a typo cannot silently switch a respawn off.
// Plain unsigned decimal. Named adminParseUint32 rather than parseUint32
// because the project builds with unity files on and a bare name here would
// collide with any other .cpp that wanted the same one.
static bool adminParseUint32(const std::string& text, uint32_t& out)
{
	if (text.empty() || text.size() > 9 ||
	    !std::all_of(text.begin(), text.end(),
	                 [](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; })) {
		return false;
	}
	out = static_cast<uint32_t>(std::stoul(text));
	return true;
}

static bool parseDelayMs(const std::string& text, uint32_t& out)
{
	if (text == "off" || text == "never" || text == "none") {
		out = 0;
		return true;
	}
	if (text.empty() || text.size() > 9 ||
	    !std::all_of(text.begin(), text.end(),
	                 [](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; })) {
		return false;
	}
	out = static_cast<uint32_t>(std::stoul(text));
	return true;
}

// !map[=<name>|=<code>] — opens a paste session.
//
// A map cannot arrive as one command. client.js:10925 splits an admin chat line
// on '!' and sends each fragment as a separate frame, and playerSay splits on
// '!' again, so "!map=!b=..!b=.." becomes "map=", "b=..", "b=..". The session
// collects the b= records that follow and commits on an idle timeout (or on
// !map-end). A code that DOES arrive whole still works: playerSay hands it to
// us one record at a time through the same path.
void Game::adminMapPaste(Player* player, const std::string& args)
{
	std::string name = args;
	std::string inlineCode;

	// A record can only start "b=" or "!b=", and a map name never can, so the
	// two forms are unambiguous.
	if (name.rfind("!b=", 0) == 0) {
		name.erase(0, 1);
	}
	if (name.rfind("b=", 0) == 0) {
		inlineCode = name;
		name.clear();
	}

	g_maps.beginSession(player->getGUID(), name);
	if (!inlineCode.empty()) {
		g_maps.feedSession(inlineCode);
	}

	int32_t originX = 0, originY = 0;
	g_maps.getPasteOrigin(originX, originY);
	adminReply(player, fmt::format("Map paste open (origin {},{}). Ends automatically, or !map-end.",
		originX, originY));
}

// One b= record. Reports an orphan rather than dropping it silently: losing
// part of a map without being told is worse than a noisy line, and the only way
// it happens is a session that timed out mid-burst.
void Game::adminMapRecord(Player* player, const std::string& args)
{
	if (g_maps.feedSession("b=" + args)) {
		return;
	}

	const int64_t now = OTSYS_TIME();
	if (now - orphanRecordWarnedAt > CLEAN_CONFIRM_WINDOW_MS) {
		orphanRecordWarnedAt = now;
		adminReply(player, "Map record ignored: no paste is open. Send !map= first.");
	}
}

// !map-place=<id>              where it was drawn
// !map-place=<id>@<x>:<y>      with its corner at that tile
// !map-place=<id>@here         with its corner where the admin stands
//
// '@' rather than ':' separates the destination because a map id may contain
// neither, and the two halves read as "this map, over there".
void Game::adminMapPlace(Player* player, const std::string& args)
{
	static const std::string usage =
		"Usage: !map-place=<id>, or =<id>@<tileX>:<tileY>, or =<id>@here. "
		"!map-list shows what is loaded.";

	if (args.empty()) {
		adminReply(player, usage);
		return;
	}

	const size_t at = args.find('@');
	if (at == std::string::npos) {
		if (!g_maps.queueStamp(args, player->getGUID())) {
			adminReply(player, usage);
			return;
		}
		adminReply(player, fmt::format("Placing map '{}'...", args));
		return;
	}

	const std::string id = args.substr(0, at);
	const std::string where = args.substr(at + 1);

	int32_t tileX = player->getPosition().getX() / TILE_SIZE;
	int32_t tileY = player->getPosition().getY() / TILE_SIZE;
	if (where != "here") {
		const auto parts = explodeString(where, ":");
		uint32_t x = 0, y = 0;
		if (parts.size() != 2 || !adminParseUint32(std::string(parts[0]), x) ||
		    !adminParseUint32(std::string(parts[1]), y)) {
			adminReply(player, usage);
			return;
		}
		tileX = static_cast<int32_t>(x);
		tileY = static_cast<int32_t>(y);
	}

	std::string error;
	if (!g_maps.queueStampAt(id, tileX, tileY, player->getGUID(), error)) {
		adminReply(player, error);
		return;
	}
	adminReply(player, fmt::format("Placing map '{}' with its corner at {},{}...",
		id, tileX, tileY));
}

// The dry run. There is no undo for what a stamp bulldozes, so this is the way
// to find out that a map lands on somebody's base BEFORE it does.
void Game::adminMapPreview(Player* player, const std::string& args)
{
	std::string id = args;
	int32_t tileX = 0, tileY = 0;
	bool located = false;

	if (const size_t at = args.find('@'); at != std::string::npos) {
		const std::string where = args.substr(at + 1);
		id = args.substr(0, at);
		if (where == "here") {
			tileX = player->getPosition().getX() / TILE_SIZE;
			tileY = player->getPosition().getY() / TILE_SIZE;
			located = true;
		} else {
			const auto parts = explodeString(where, ":");
			uint32_t x = 0, y = 0;
			if (parts.size() == 2 && adminParseUint32(std::string(parts[0]), x) &&
			    adminParseUint32(std::string(parts[1]), y)) {
				tileX = static_cast<int32_t>(x);
				tileY = static_cast<int32_t>(y);
				located = true;
			}
		}
	}

	if (id.empty()) {
		id = g_maps.getLastStampedId();
	}

	const MapImportManager::PreviewReport report = located
		? g_maps.preview(id, &tileX, &tileY)
		: g_maps.preview(id);

	if (!report.valid) {
		adminReply(player, report.error.empty()
			? "Usage: !map-preview=<id>[@<tileX>:<tileY>|@here]" : report.error);
		return;
	}

	adminReply(player, fmt::format(
		"'{}': {} objects, {}x{} tiles at {},{}. Needs {} entity ids of {} free.",
		id, report.objects, report.rect.x2 - report.rect.x1, report.rect.y2 - report.rect.y1,
		report.rect.x1, report.rect.y1, report.idCost, report.idsFree));

	std::string obstacles;
	const auto part = [&obstacles](const char* label, uint32_t count) {
		if (count == 0) {
			return;
		}
		if (!obstacles.empty()) {
			obstacles += ", ";
		}
		obstacles += fmt::format("{} {}", count, label);
	};
	part("player-built tile(s)", report.playerBuilds);
	part("tile(s) inside a city/house", report.structureTiles);
	part("resource(s)", report.resources);
	part("record(s) off the map", report.offMap);

	if (report.idCost > report.idsFree) {
		adminReply(player, "WOULD BE REFUSED: not enough entity ids. Clear something first.");
	} else if (obstacles.empty()) {
		adminReply(player, "Nothing in the way. !map-place to do it.");
	} else {
		adminReply(player, fmt::format("WOULD DESTROY: {}. !map-place to do it anyway.",
			obstacles));
	}
}

// Undo applies to a STAMP only, and says so. A !clean cannot be undone: the
// objects it removed are gone along with whatever was in their containers.
void Game::adminMapUndo(Player* player)
{
	const std::string id = g_maps.undoLastStamp(player->getGUID());
	if (id.empty()) {
		adminReply(player, "Nothing to undo: no map is standing. (A !clean cannot be undone.)");
		return;
	}
	adminReply(player, fmt::format(
		"Undoing the last stamp of '{}'. What it bulldozed does not come back.", id));
}

// !structure-place=<key>                 at the admin's own tile
// !structure-place=<key>:<tileX>:<tileY> at a named tile
// ...:city                               file it under the minimap's city icons
//
// The map editor's !map-place puts down a drawing; this puts down a TEMPLATE,
// so what lands is tracked and respawns on the mode's cycle. Every check world
// generation makes is made here too -- see StructureManager::placeStructureAt.
void Game::adminStructurePlace(Player* player, const std::string& args)
{
	static const std::string usage =
		"Usage: !structure-place=<key> (here), or =<key>:<tileX>:<tileY>, "
		"optionally :city. !structure-list shows the keys.";

	if (args.empty()) {
		adminReply(player, usage);
		return;
	}

	std::vector<std::string_view> parts = explodeString(args, ":");
	const std::string key(parts[0]);

	// "city" may be the last field with or without coordinates in front of it.
	bool isCity = false;
	if (!parts.empty() && (parts.back() == "city" || parts.back() == "house")) {
		isCity = (parts.back() == "city");
		parts.pop_back();
	}

	int32_t tileX = player->getPosition().getX() / TILE_SIZE;
	int32_t tileY = player->getPosition().getY() / TILE_SIZE;
	if (parts.size() == 3) {
		try {
			tileX = std::stoi(std::string(parts[1]));
			tileY = std::stoi(std::string(parts[2]));
		} catch (...) {
			adminReply(player, usage);
			return;
		}
	} else if (parts.size() != 1) {
		adminReply(player, usage);
		return;
	}

	std::string error;
	StructureManager::PlacementReport report;
	if (!g_structures.placeStructureAt(key, tileX, tileY, isCity, report, error)) {
		adminReply(player, error);
		return;
	}

	const StructureTemplate* tmpl = g_structures.getTemplate(key);
	adminReply(player, fmt::format(
		"Placed '{}' ({}x{}) at tile {},{} as a {}: {} floors, {} objects, "
		"{} containers holding {} items{}. Respawns with the other structures.",
		key, tmpl->width, tmpl->height, tileX, tileY, isCity ? "city" : "house",
		report.floors, report.objects, report.containers, report.lootItems,
		report.skipped ? fmt::format(", {} tiles skipped (occupied)", report.skipped) : ""));
	fmt::print(">> [structures] admin placed '{}' at tile {},{}: {} floors, {} objects, "
		"{} containers, {} loot items, {} skipped\n",
		key, tileX, tileY, report.floors, report.objects, report.containers,
		report.lootItems, report.skipped);
}

// !effects            what is running on you now
// !effects=all        every condition conditions.xml defines
// !effects=<key>      apply one to yourself, to see it without hunting the item
//
// The reason this exists at all: status effects were the one subsystem with no
// way to look at them. Their whole observable surface is a skin somebody else
// draws and a number that quietly changes, so a wrong one was indistinguishable
// from no effect. It is also what makes <effect name=> load-bearing -- the
// client has no notion of a named effect, so this and the load warnings are the
// only places a person ever reads it.
void Game::adminConditions(Player* player, const std::string& args)
{
	const ConditionManager& manager = ConditionManager::getInstance();

	if (args == "all") {
		// One line: the client splits an admin message on '!' and long output is
		// what the 8192-byte frame limit bites. See adminReply.
		std::string list;
		for (const ConditionData* data : manager.allEffects()) {
			if (!list.empty()) list += "; ";
			list += fmt::format("{} \"{}\" {} stage(s)", data->key, data->name, data->stages.size());
		}
		adminReply(player, list.empty() ? "No status effects are loaded." : list);
		return;
	}

	if (!args.empty()) {
		const ConditionData* data = manager.getEffectData(args);
		if (!data) {
			// No '!' in the text: the client splits an admin line on it, so
			// naming the command back would arrive as two chat lines.
			adminReply(player, fmt::format(
				"No status effect '{}'. Add =all for the list.", args));
			return;
		}
		player->addCondition(args);
		adminReply(player, fmt::format("Applied \"{}\" to yourself.", data->name));
		return;
	}

	adminReply(player, describeConditions(player, "you"));
}

// !effects-player=<id>             the read-out for somebody else
// !effects-player=<id>,<key|cure>  apply one to them, or clear them
//
// A separate command rather than a smarter !effects=, because that argument
// already means "a condition key" -- guessing which one an admin meant would be
// wrong exactly when it mattered. Mirrors the !item / !item-player pair, and the
// comma form mirrors !item-player=<id>,<item>.
void Game::adminConditionsPlayer(Player* player, const std::string& args)
{
	// Split on the first comma: everything after it is the condition, so a key
	// can never be mistaken for part of the id.
	const size_t comma = args.find(',');
	const std::string idPart = args.substr(0, comma);
	const std::string keyPart = (comma == std::string::npos)
		? std::string()
		: args.substr(comma + 1);

	uint32_t id = 0;
	if (!adminParseUint32(idPart, id)) {
		adminReply(player, "Name a player by the id the player list shows: "
			"effects-player=<id> to read, effects-player=<id>,<key> to apply.");
		return;
	}

	Player* target = resolveAdminTarget(id);
	if (!target) {
		adminReply(player, fmt::format("No player with id {} is online.", id));
		return;
	}

	if (!keyPart.empty()) {
		if (keyPart == "cure") {
			g_accountRuns.disqualify(target);
			target->cureConditions({"all"});
			adminReply(player, fmt::format("Cleared every condition on {}.", target->getName()));
			return;
		}
		if (!ConditionManager::getInstance().getEffectData(keyPart)) {
			adminReply(player, fmt::format(
				"No condition '{}'. Add effects=all for the list, or ,cure to clear.", keyPart));
			return;
		}
		// Credited to the ADMIN, so a poison applied this way behaves exactly as
		// one delivered by a weapon: it can kill, and the kill is theirs.
		g_accountRuns.disqualify(target);
		target->addCondition(keyPart, player->getGUID());
	}

	adminReply(player, describeConditions(target, target->getName()));
}

// !effects-cure=<key|all>: take a condition off yourself. The apply half already
// exists as !effects=<key>, and cure is the half that was missing -- there was no
// way to end an effect short of dying or eating the one item that happens to cure
// it, which makes any condition with a long duration untestable.
//
// A separate command rather than a flag on !effects=, for the same reason
// !effects-player is separate: that argument already means "a condition key", and
// overloading it would guess wrong exactly when it mattered.
void Game::adminConditionsCure(Player* player, const std::string& args)
{
	if (args.empty()) {
		adminReply(player, "Name a condition to cure, or all: effects-cure=<key|all>.");
		return;
	}

	// "all" is Player::cureConditions' own sentinel, so it needs no special case
	// here -- but a mistyped name does, or the reply would claim a cure that
	// removed nothing.
	//
	// A cure name may be a condition KEY or a TAG, exactly as <cureCondition
	// keys=> accepts either. Checking only keys rejected every tag outright,
	// which made the whole tag mechanism untestable from the console.
	const ConditionManager& manager = ConditionManager::getInstance();
	if (args != "all" && !manager.getEffectData(args) && !manager.hasTag(args)) {
		adminReply(player, fmt::format(
			"No condition or tag '{}'. Add =all for the list, or effects-cure=all to clear "
			"everything.", args));
		return;
	}

	const size_t before = player->getConditions().size();
	player->cureConditions({args});
	const size_t after = player->getConditions().size();
	adminReply(player, fmt::format("Cured {} of {}; {} still active.",
		before - after, args, after));
}

// !effects-agent          what the nearest agent is running
// !effects-agent=<key>    apply one to it
//
// The only window onto conditions on an AGENT, which are otherwise completely
// unobservable: an agent has no client to tell and no drug skin to draw, so a
// poison eating one is invisible until it dies of it.
//
// Nearest rather than by id, because an agent's runtime id is not something an
// admin can see -- walk up to the thing you want to test on.
void Game::adminConditionsAgent(Player* player, const std::string& args)
{
	// A tile box, not getSpectators: this is a local question and the viewport
	// rule says never phrase one as a viewport query. Four tiles is generous for
	// "the one I am standing next to".
	static constexpr int32_t SEARCH_TILES = 4;
	const Position at = player->getPosition();
	const int32_t tx = at.x / TILE_SIZE;
	const int32_t ty = at.y / TILE_SIZE;

	std::vector<Thing*> nearby;
	map.getThingsInTileBox(tx - SEARCH_TILES, ty - SEARCH_TILES,
	                       tx + SEARCH_TILES, ty + SEARCH_TILES, nearby);

	Agent* nearest = nullptr;
	uint64_t bestDistSq = std::numeric_limits<uint64_t>::max();
	for (Thing* thing : nearby) {
		Agent* agent = thing->getAgent();
		if (!agent || agent->isDying()) continue;
		const Position apos = agent->getPosition();
		const int64_t dx = static_cast<int64_t>(apos.x) - at.x;
		const int64_t dy = static_cast<int64_t>(apos.y) - at.y;
		const uint64_t distSq = static_cast<uint64_t>(dx * dx + dy * dy);
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			nearest = agent;
		}
	}

	if (!nearest) {
		adminReply(player, "No agent within a few tiles. Stand next to one, or spawn-agent first.");
		return;
	}

	if (!args.empty()) {
		if (!ConditionManager::getInstance().getEffectData(args)) {
			adminReply(player, fmt::format(
				"No condition '{}'. Add effects=all for the list.", args));
			return;
		}
		// Credited to the admin, so a poison that kills the agent awards them the
		// XP -- which is also the only way to see the inflictor plumbing work on
		// something other than a player.
		if (!nearest->addCondition(args, player->getGUID())) {
			adminReply(player, fmt::format(
				"{} refused '{}' -- it is immune, or already has it under an ignore stacking rule.",
				nearest->getName(), args));
			return;
		}
	}

	const ConditionSet& set = nearest->getConditionSet();
	if (set.empty()) {
		adminReply(player, fmt::format("No conditions are active on {} (hp {}).",
			nearest->getName(), nearest->getHealth()));
		return;
	}

	std::string list;
	for (const ActiveCondition& a : set.active()) {
		if (!list.empty()) list += "; ";
		list += fmt::format("{} stage {} {:.1f}s left", a.data->name, a.stage().key,
			a.remainingDurationMs / 1000.0f);
		// Only when it is not the plain condition. Printing "x1.0" on every line
		// would be noise, and this read-out shares one 8192-byte frame.
		if (a.strength != 1.0f) {
			list += fmt::format(" x{:.2g}", a.strength);
		}
	}
	adminReply(player, fmt::format("{} (hp {}): {}", nearest->getName(),
		nearest->getHealth(), list));
}

// Shared by both spellings, so the two can never describe the same set
// differently.
std::string Game::describeConditions(const Player* subject, const std::string& who) const
{
	const std::vector<ActiveCondition>& active = subject->getConditions();
	if (active.empty()) {
		return fmt::format("No status effects are active on {}.", who);
	}

	std::string list;
	for (const ActiveCondition& a : active) {
		if (!list.empty()) list += "; ";
		list += fmt::format("{} stage {} {:.1f}s left", a.data->name, a.stage().key,
			a.remainingDurationMs / 1000.0f);
		// Only when it is not the plain condition. Printing "x1.0" on every line
		// would be noise, and this read-out shares one 8192-byte frame.
		if (a.strength != 1.0f) {
			list += fmt::format(" x{:.2g}", a.strength);
		}
		// Only when there is one. Naming the environment on every line would be
		// noise, and this read-out shares an 8192-byte frame with everything else.
		if (a.inflictorGuid != 0) {
			list += fmt::format(" by {}", a.inflictorGuid);
		}
	}
	return list;
}

void Game::adminStructureList(Player* player)
{
	const std::vector<std::string> keys = g_structures.templateKeys();
	if (keys.empty()) {
		adminReply(player, "No structure templates are loaded.");
		return;
	}

	// One line, because the client splits an admin message on '!' and long
	// output is what the 8192-byte frame limit bites; see adminReply.
	std::string list;
	for (const std::string& key : keys) {
		const StructureTemplate* tmpl = g_structures.getTemplate(key);
		if (!list.empty()) list += ", ";
		list += fmt::format("{} {}x{}", key, tmpl->width, tmpl->height);
	}
	adminReply(player, fmt::format("{} templates: {}", keys.size(), list));
}

// Three spellings, because all three are things an admin actually types:
//
//   (empty) / here   the building you are standing in
//   <n>              the id !structure-list-placed prints
//   <templateKey>    "house0" -- the obvious thing to type after typing
//                    !structure-place=house0, and it used to be rejected
//
// A key is only ambiguous when several of that template are standing, and then
// the refusal lists their ids so the next command is one keystroke away.
uint32_t Game::resolveStructureInstance(Player* player, const std::string& text,
                                        std::string& error) const
{
	if (text.empty() || text == "here") {
		const auto* tracked = g_structures.structureAt(
			player->getPosition().getX() / TILE_SIZE, player->getPosition().getY() / TILE_SIZE);
		if (!tracked) {
			error = "You are not standing in a tracked structure. Name one instead: "
			        "<id> or <template>, from !structure-list-placed.";
			return 0;
		}
		return tracked->instanceId;
	}

	if (uint32_t id = 0; adminParseUint32(text, id)) {
		if (!g_structures.findTracked(id)) {
			error = fmt::format("No structure #{} is standing. !structure-list-placed shows them.",
				id);
			return 0;
		}
		return id;
	}

	std::vector<uint32_t> matches;
	for (const auto& tracked : g_structures.getSpawnedStructures()) {
		if (tracked.templateId == text) {
			matches.push_back(tracked.instanceId);
		}
	}

	if (matches.empty()) {
		error = g_structures.getTemplate(text)
			? fmt::format("No '{}' is standing. !structure-list-placed shows what is.", text)
			: fmt::format("No structure '{}': not an id, not a template key, not here.", text);
		return 0;
	}
	if (matches.size() > 1) {
		// Nearest first, so the one the admin means -- almost always the one they
		// just placed and are standing next to -- is the first id in the message
		// rather than something to hunt for in !structure-list-placed.
		const int32_t px = player->getPosition().getX() / TILE_SIZE;
		const int32_t py = player->getPosition().getY() / TILE_SIZE;
		const auto distanceTo = [&](uint32_t id) {
			const auto* tracked = g_structures.findTracked(id);
			if (!tracked) {
				return std::numeric_limits<int32_t>::max();
			}
			const int32_t cx = (tracked->rect.x1 + tracked->rect.x2) / 2;
			const int32_t cy = (tracked->rect.y1 + tracked->rect.y2) / 2;
			return std::max(std::abs(px - cx), std::abs(py - cy));
		};
		std::sort(matches.begin(), matches.end(),
			[&](uint32_t a, uint32_t b) { return distanceTo(a) < distanceTo(b); });

		std::string ids;
		for (const uint32_t id : matches) {
			ids += (ids.empty() ? "" : ", ") + fmt::format("#{} ({} tiles)", id, distanceTo(id));
		}
		error = fmt::format(
			"{} '{}' are standing, nearest first: {}. Name one, or stand in it and say 'here'.",
			matches.size(), text, ids);
		return 0;
	}
	return matches.front();
}

// What is STANDING, as opposed to !structure-list's catalogue of templates.
void Game::adminStructureListPlaced(Player* player)
{
	const auto& placed = g_structures.getSpawnedStructures();
	if (placed.empty()) {
		adminReply(player, "No structures are standing.");
		return;
	}

	adminReply(player, fmt::format("{} structure(s) standing:", placed.size()));
	for (const auto& tracked : placed) {
		const MapInstance* instance = g_placements.find(tracked.instanceId);
		const uint32_t alive = g_placements.liveCount(tracked.instanceId);
		const uint32_t total = instance ? static_cast<uint32_t>(instance->entityIds.size()) : 0;

		adminReply(player, fmt::format("  #{} {} at {},{} {}x{} {} - {}/{} standing{}",
			tracked.instanceId, tracked.templateId, tracked.rect.x1, tracked.rect.y1,
			tracked.rect.x2 - tracked.rect.x1, tracked.rect.y2 - tracked.rect.y1,
			(instance && instance->isCity) ? "city" : "house",
			alive, total, tracked.respawns ? "" : ", respawn OFF"));
	}
}

void Game::adminStructureRemove(Player* player, const std::string& args)
{
	std::string resolveError;
	const uint32_t instanceId = resolveStructureInstance(player, args, resolveError);
	if (instanceId == 0) {
		adminReply(player, resolveError);
		return;
	}

	const auto* tracked = g_structures.findTracked(instanceId);
	const std::string key = tracked ? tracked->templateId : std::string("?");

	std::string error;
	if (!g_structures.removeStructure(instanceId, player->getGUID(), error)) {
		adminReply(player, error);
		return;
	}
	adminReply(player, fmt::format(
		"Removing structure #{} ('{}'). Its ground and minimap marker are free now; "
		"the objects come off over the next few seconds.", instanceId, key));
	fmt::print(">> [structures] {} removed #{} '{}'\n", player->getName(), instanceId, key);
}

// !structure-move=<n>:<tileX>:<tileY>, or =<tileX>:<tileY> for the one you are in.
void Game::adminStructureMove(Player* player, const std::string& args)
{
	static const std::string usage =
		"Usage: !structure-move=<n>:<tileX>:<tileY>, or =<tileX>:<tileY> for the one "
		"you are standing in.";

	const std::vector<std::string_view> parts = explodeString(args, ":");
	if (parts.size() != 2 && parts.size() != 3) {
		adminReply(player, usage);
		return;
	}

	const bool named = (parts.size() == 3);
	std::string resolveError;
	const uint32_t instanceId = resolveStructureInstance(
		player, named ? std::string(parts[0]) : std::string(), resolveError);
	if (instanceId == 0) {
		adminReply(player, resolveError + (named ? "" : " " + usage));
		return;
	}

	uint32_t tileX = 0, tileY = 0;
	if (!adminParseUint32(std::string(parts[named ? 1 : 0]), tileX) ||
	    !adminParseUint32(std::string(parts[named ? 2 : 1]), tileY)) {
		adminReply(player, usage);
		return;
	}

	std::string error;
	if (!g_structures.moveStructure(instanceId, static_cast<int32_t>(tileX),
	                                static_cast<int32_t>(tileY), player->getGUID(), error)) {
		// Nothing was taken down: moveStructure restores the tracking on refusal.
		adminReply(player, fmt::format("{} Nothing was moved.", error));
		return;
	}
	adminReply(player, fmt::format("Structure #{} moved to {},{}.", instanceId, tileX, tileY));
}

// !structure-respawn=<n>:<on|off>. The CADENCE stays global (!respawn-structures);
// this is the per-building switch, which is what an admin wants when one city
// keeps growing back through their map.
void Game::adminStructureRespawnOne(Player* player, const std::string& args)
{
	static const std::string usage =
		"Usage: !structure-respawn=<n>:<on|off> (one building), or "
		"!respawn-structures=<ms|off> (the cycle for all of them).";

	const auto [idPart, statePart, ok] = splitOnce(args, ':');
	if (!ok) {
		adminReply(player, usage);
		return;
	}

	std::string resolveError;
	const uint32_t instanceId = resolveStructureInstance(player, idPart, resolveError);
	if (instanceId == 0) {
		adminReply(player, resolveError);
		return;
	}

	const bool respawns = (statePart == "on" || statePart == "true" || statePart == "yes");
	if (!respawns && statePart != "off" && statePart != "false" && statePart != "no") {
		adminReply(player, usage);
		return;
	}

	g_structures.setStructureRespawn(instanceId, respawns);
	adminReply(player, fmt::format("Structure #{} will {}rebuild itself.",
		instanceId, respawns ? "" : "NOT "));
}

void Game::adminMapEnd(Player* player)
{
	if (!g_maps.hasSession()) {
		adminReply(player, "No map paste is open.");
		return;
	}
	g_maps.commitSession();
}

// Empty args = the tile the admin is standing on.
void Game::adminMapOrigin(Player* player, const std::string& args)
{
	int32_t tileX = 0, tileY = 0;

	if (args.empty()) {
		tileX = player->getPosition().getX() / TILE_SIZE;
		tileY = player->getPosition().getY() / TILE_SIZE;
	} else {
		const auto parts = explodeString(args, ":");
		if (parts.size() != 2) {
			adminReply(player, "Usage: !map-at=<tileX>:<tileY>  (or !map-here)");
			return;
		}
		try {
			tileX = std::stoi(std::string(parts[0]));
			tileY = std::stoi(std::string(parts[1]));
		} catch (...) {
			adminReply(player, "Usage: !map-at=<tileX>:<tileY>  (or !map-here)");
			return;
		}
	}

	g_maps.setPasteOrigin(tileX, tileY);
	adminReply(player, fmt::format("Paste origin set to {},{}.", tileX, tileY));
}

void Game::adminMapList(Player* player)
{
	const auto& maps = g_maps.getMaps();
	if (maps.empty()) {
		adminReply(player, "No maps loaded.");
		return;
	}

	adminReply(player, fmt::format("{} map(s) loaded:", maps.size()));
	for (const auto& [id, def] : maps) {
		// Standing count from the placement record, not from the entry list: a
		// map whose walls players have knocked down is still loaded, and the
		// difference between the two numbers is the useful part.
		uint32_t standing = 0;
		for (const uint32_t instanceId : g_placements.instancesOf(PlacementSource::Map, id)) {
			standing += g_placements.liveCount(instanceId);
		}

		const std::string line = fmt::format("  {} - {} objects, {} standing, {}, {}",
			id, def.entries.size(), standing,
			def.respawnMs == 0 ? std::string("no respawn")
			                   : fmt::format("respawn {}ms", def.respawnMs),
			def.autoPlace ? "in the world (rebuilt by !seed)" : "library only");
		adminReply(player, line);
		fmt::print(">> [maps] {} (origin {},{}, file '{}', mode '{}', {})\n", line,
			def.originX, def.originY, def.sourceFile, def.modeKey,
			def.stamped ? "stamped" : "not yet placed");
	}
}

void Game::adminMapSave(Player* player, const std::string& args)
{
	const std::string id = args.empty() ? g_maps.getLastStampedId() : args;
	if (id.empty()) {
		adminReply(player, "Usage: !map-save=<id>");
		return;
	}

	std::string path;
	if (!g_maps.saveMap(id, path)) {
		adminReply(player, fmt::format("Could not save map '{}'.", id));
		return;
	}
	adminReply(player, fmt::format("Map '{}' saved to {}.", id, path));
	fmt::print(">> [maps] '{}' saved to {} (add it to XML/maps.xml to load it at startup)\n", id, path);
}

// Removes what a map has standing; the map itself stays in the library so
// !map-place can put it back. !map-forget is the one that drops it.
void Game::adminMapClear(Player* player, const std::string& args)
{
	const std::string id = args.empty() ? g_maps.getLastStampedId() : args;
	if (id.empty() || !g_maps.clearMap(id, player->getGUID())) {
		adminReply(player, fmt::format("No map '{}'.", id));
		return;
	}
	adminReply(player, fmt::format(
		"Removing map '{}'... (still loaded; !map-place={} puts it back, !map-forget={} drops it)",
		id, id, id));
}

void Game::adminMapForget(Player* player, const std::string& args)
{
	const std::string id = args.empty() ? g_maps.getLastStampedId() : args;
	if (id.empty() || !g_maps.forgetMap(id, player->getGUID())) {
		adminReply(player, fmt::format("No map '{}'.", id));
		return;
	}
	adminReply(player, fmt::format(
		"Map '{}' cleared and dropped from the library. A map from a file returns on "
		"!map-reload; a paste is gone.", id));
}

// A paste is placed once and is not part of the world. This is what promotes it,
// so a !seed rebuild stamps it back in with the cities.
void Game::adminMapKeep(Player* player, const std::string& args, bool keep)
{
	const std::string id = args.empty() ? g_maps.getLastStampedId() : args;
	if (id.empty() || !g_maps.setAutoPlace(id, keep)) {
		adminReply(player, fmt::format(
			"No map '{}'. Usage: !map-keep=<id> / !map-drop=<id>", id));
		return;
	}

	adminReply(player, keep
		? fmt::format("Map '{}' is now part of the world: a !seed rebuild will replay it. "
		              "!map-save={} to keep it across a restart.", id, id)
		: fmt::format("Map '{}' is library-only again: it stays where it is, but a rebuild "
		              "will not replay it.", id));
}

void Game::adminMapReload(Player* player)
{
	// A reload rebuilds the library from the files, so anything pasted this
	// session is forgotten unless it was saved. The objects it placed stay
	// standing -- they are just no longer tracked, so they will not respawn and
	// !map-clear cannot find them. Said plainly rather than left to be
	// discovered.
	const std::string dir = contentFile("maps");
	g_maps.loadAssets();
	adminReply(player, fmt::format(
		"Reloaded {} ({} maps). !map-place=<id> to place one. Anything pasted this session "
		"and not !map-save'd is no longer tracked; its objects remain.",
		dir, g_maps.getMaps().size()));
}

// !map-respawn=<ms>            every map, and the default for new pastes
// !map-respawn=<id>:<ms>       one map
void Game::adminMapRespawn(Player* player, const std::string& args)
{
	std::string id;
	std::string delayText = args;

	if (const size_t colon = args.rfind(':'); colon != std::string::npos) {
		id = args.substr(0, colon);
		delayText = args.substr(colon + 1);
	}

	uint32_t ms = 0;
	if (!parseDelayMs(delayText, ms)) {
		adminReply(player, "Usage: !map-respawn=<ms|off> or !map-respawn=<id>:<ms|off>");
		return;
	}

	if (!g_maps.setRespawnMs(id, ms)) {
		adminReply(player, fmt::format("No map '{}'.", id));
		return;
	}

	const std::string scope = id.empty() ? std::string("All maps") : fmt::format("Map '{}'", id);
	adminReply(player, ms == 0 ? fmt::format("{}: respawn off.", scope)
	                           : fmt::format("{}: respawn every {}ms.", scope, ms));
}

// Wipes every static entity: objects (world and player built), resources and
// ground loot. Creatures are never touched.
//
// Two-step on purpose. This is the most destructive command on the server and
// there is no undo anywhere in the codebase, so a mistyped !clean must not be
// able to flatten a live world on its own.
// !clean       sweeps the world and lets it grow back.
// !clean-hard  sweeps it and retires every placement, so it stays empty.
//
// The two are separate commands rather than one command with a flag because
// !clean's meaning is old and admins rely on it. The harder behaviour is added
// beside it, not folded into it.
void Game::adminCleanWorld(Player* player, const std::string& args, bool hard)
{
	const char* const name = hard ? "!clean-hard" : "!clean";
	const int64_t now = OTSYS_TIME();
	const bool confirmedInline = (args == "confirm" || args == "yes");
	// Armed per variant: a pending !clean must not be completable by typing
	// !clean-hard, which does strictly more.
	const uint32_t armKey = player->getGUID() | (hard ? 0x80000000u : 0u);
	const bool armed = (cleanArmedBy == armKey && now - cleanArmedAt <= CLEAN_CONFIRM_WINDOW_MS);

	if (!confirmedInline && !armed) {
		cleanArmedBy = armKey;
		cleanArmedAt = now;
		adminReply(player, hard
			? fmt::format("!clean-hard removes EVERY object, resource and loot item AND stops "
			              "maps, cities and resources coming back. Repeat !clean-hard within {}s "
			              "to confirm.", CLEAN_CONFIRM_WINDOW_MS / 1000)
			: fmt::format("!clean removes EVERY object, resource and loot item on the map. "
			              "Repeat !clean within {}s to confirm.", CLEAN_CONFIRM_WINDOW_MS / 1000));
		return;
	}

	cleanArmedBy = 0;
	cleanArmedAt = 0;
	g_maps.queueClean(player->getGUID(), /*retireInstances=*/hard);

	std::string note;
	if (hard) {
		// The four commands XML/maps.xml documents by hand, in one. Turning the
		// timers off as well as retiring the records matters: retiring stops what
		// is TRACKED coming back, and these two would otherwise still grow a new
		// world around the empty one.
		g_resources.setRespawnDelayMs(0);
		setStructuresRespawnDelayMs(0);
		note = "Cleaning hard... Placements retired; resource and structure respawn are OFF. "
		       "Nothing comes back until you place it. Reverse with !respawn-resources=<ms> "
		       "and !respawn-structures=<ms>.";
	} else {
		// Said plainly rather than done silently: the world regrows unless these
		// are off, and an admin who cleans in order to paste a map wants to know
		// that before the trees come back through it.
		note = "Cleaning...";
		if (g_resources.isRespawnEnabled()) {
			note += " NOTE: resources will regrow (!respawn-resources=off).";
		}
		if (getStructuresRespawnDelayMs() != 0) {
			note += " Cities will return (!respawn-structures=off).";
		}
		note += " !clean-hard does both and keeps the world empty.";
	}

	adminReply(player, note);
	fmt::print(">> [Admin] {} issued {}\n", player->getName(), name);
}

// !seed                 which world am I standing in
// !seed=<n>             rebuild it from <n>, keeping everything players built
// !seed=<n>:wipe        rebuild it from <n>, bulldozing player builds as well
// !seed=random          rebuild from a fresh, unpredictable seed
//
// Unlike !clean this is not gated behind a confirmation, because the default is
// not destructive to anything a player made: bases, their contents and dropped
// loot all survive, and the tiles they occupy are simply left out of whatever
// the new seed wanted to put there.
void Game::adminSeed(Player* player, const std::string& args)
{
	if (args.empty()) {
		// The fingerprint is the point of this reply, not decoration: it is how
		// an admin checks that a seed reproduces a world without walking it.
		// Same seed, same number -- if two rebuilds ever disagree, something has
		// leaked the live world back into generation.
		adminReply(player, fmt::format(
			"World seed: {} (fingerprint {:08x}). !seed=<n> rebuilds the map from another "
			"one -- player builds are kept; add :wipe to flatten those too.",
			getWorldSeed(), getWorldFingerprint()));
		return;
	}

	std::string seedText = args;
	bool preservePlayerBuilds = true;

	if (const size_t colon = args.rfind(':'); colon != std::string::npos) {
		seedText = args.substr(0, colon);
		const std::string flag = args.substr(colon + 1);
		if (flag == "wipe" || flag == "all") {
			preservePlayerBuilds = false;
		} else if (flag != "keep") {
			adminReply(player, "Usage: !seed=<number|random>[:keep|:wipe]");
			return;
		}
	}

	constexpr uint64_t SEED_MAX = std::numeric_limits<uint32_t>::max();

	uint32_t seed = 0;
	if (seedText == "random" || seedText == "new") {
		// The generator is mixed in, not just the clock: stacked commands are
		// parsed in the same dispatcher batch and would otherwise land on the
		// same millisecond, so "!seed=random" three times would build the same
		// world three times over. uniform_random advances on every call.
		seed = static_cast<uint32_t>(OTSYS_TIME()) ^
			static_cast<uint32_t>(uniform_random(1, std::numeric_limits<int32_t>::max()));
		if (seed == 0) {
			seed = 1;
		}
	} else {
		// Digits only, checked up front rather than left to stoull: stoull stops
		// at the first non-digit, so "12abc" would quietly become seed 12.
		//
		// 0 is rejected rather than remapped: it is the "pick one from the clock"
		// sentinel in config.lua, so reporting a world as seed 0 would send an
		// admin off to write a config that does not reproduce it.
		const bool digitsOnly = !seedText.empty() && seedText.size() <= 10 &&
			std::all_of(seedText.begin(), seedText.end(),
				[](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; });

		const uint64_t parsed = digitsOnly ? std::stoull(seedText) : 0;
		if (!digitsOnly || parsed == 0 || parsed > SEED_MAX) {
			adminReply(player, fmt::format("'{}' is not a seed. Use 1..{}, or 'random'.",
				seedText, SEED_MAX));
			return;
		}
		seed = static_cast<uint32_t>(parsed);
	}

	fmt::print(">> [Admin] {} issued !seed={}{}\n", player->getName(), seed,
		preservePlayerBuilds ? "" : ":wipe");

	queueRegeneration(seed, preservePlayerBuilds, player->getGUID());
}

// What the account service said went wrong: the transport failure, else the
// web host's JSON {"error": "..."} with the status, else just the status.
static std::string setGroupServiceError(const HttpClient::Response& response)
{
	if (!response.error.empty()) return response.error;
	try {
		const boost::json::value parsed = boost::json::parse(response.body);
		if (const boost::json::object* object = parsed.if_object()) {
			const boost::json::value* text = object->if_contains("error");
			if (text && text->is_string() && !text->as_string().empty()) {
				return fmt::format("{} (HTTP {})", std::string_view(text->as_string()).substr(0, 200), response.status);
			}
		}
	} catch (const std::exception&) {
	}
	return fmt::format("HTTP {}", response.status);
}

// !setgroup=<target>:<group>. <target> all digits = the online player with that
// in-game id (an account holder); otherwise an account name, online or not.
// <group> = a groups.xml name or id. The account lives on the web host, so this
// is two HTTP calls: read the current group, then compare-and-set it. Ranks are
// checked here because groups.xml is this server's.
void Game::adminSetGroup(Player* admin, const std::string& args)
{
	// "http://host:3100/" and "http://host:3100" alike; paths are appended.
	std::string base = getString(ConfigManager::ACCOUNT_SERVICE_URL);
	while (!base.empty() && base.back() == '/') base.pop_back();
	const std::string& token = getString(ConfigManager::ACCOUNT_ADMIN_TOKEN);
	if (!getBoolean(ConfigManager::USE_DATABASE) || base.empty() || token.empty()) {
		adminReply(admin, "!setgroup is off here: it needs useDatabase = true, accountServiceUrl and accountAdminToken.");
		return;
	}

	auto [targetPart, groupPart, ok] = splitOnce(args, ':');
	trimInPlace(targetPart);
	trimInPlace(groupPart);
	if (!ok || targetPart.empty() || groupPart.empty()) {
		adminReply(admin, "Usage: !setgroup=<player id or account name>:<group name or id>");
		return;
	}
	const Group* group = g_groups.find(groupPart);
	if (!group) {
		adminReply(admin, fmt::format("No group '{}' in groups.xml.", groupPart));
		return;
	}
	if (group->rank >= admin->getAuthorityRank()) {
		adminReply(admin, "You can only grant groups below your own rank.");
		return;
	}

	std::string ref = targetPart;
	if (std::all_of(targetPart.begin(), targetPart.end(), [](unsigned char c) { return std::isdigit(c); })) {
		Player* target = resolveAdminTarget(std::stoul(targetPart));
		if (!target) {
			adminReply(admin, fmt::format("No player with id {}.", targetPart));
			return;
		}
		if (!target->isVerified()) {
			adminReply(admin, fmt::format("{} is a guest; only accounts have groups.", target->getName()));
			return;
		}
		ref = fmt::format("#{}", target->getAccountId());
	}

	const uint32_t adminId = admin->getID();
	// Captured by value, not read back off the Player* later: the admin may
	// disconnect before either HTTP round trip completes, and the audit line
	// on success must still name who issued the command.
	const std::string adminName = admin->getName();
	const uint16_t authority = admin->getAuthorityRank();
	const uint8_t toGroupId = group->id;
	const std::string toGroupName = group->name;
	const HttpClient::Headers headers{ { "X-Account-Admin-Token", token } };

	HttpClient::requestAsync("GET", base + "/api/servers/accounts/" + HttpClient::percentEncode(ref), headers, "",
	    [this, adminId, adminName, authority, toGroupId, toGroupName, headers, base, ref](HttpClient::Response found) {
		    Player* issuer = getPlayerByID(adminId);
		    if (!issuer) return;
		    if (found.status == 404) {
			    adminReply(issuer, fmt::format("No account '{}'.", ref));
			    return;
		    }
		    if (found.status != 200) {
			    adminReply(issuer, fmt::format("Account service: {}", setGroupServiceError(found)));
			    return;
		    }
		    uint32_t accountId = 0;
		    std::string name;
		    int64_t rawGroupId = -1;
		    try {
			    const boost::json::object account = boost::json::parse(found.body).as_object();
			    accountId = static_cast<uint32_t>(account.at("id").to_number<int64_t>());
			    name = boost::json::value_to<std::string>(account.at("name"));
			    // Read as an integer, not cast straight to uint8_t: a groupId this
			    // server's groups.xml does not define (or one outside 0..255) must
			    // be refused, not silently fold onto g_groups' rank-0 default and
			    // fail the rank check open.
			    rawGroupId = account.at("groupId").to_number<int64_t>();
		    } catch (const std::exception&) {
			    adminReply(issuer, "Account service sent an unreadable answer.");
			    return;
		    }
		    const Group* current = (rawGroupId >= 0 && rawGroupId <= 255)
		        ? g_groups.get(static_cast<uint8_t>(rawGroupId))
		        : nullptr;
		    if (!current) {
			    adminReply(issuer, fmt::format(
			        "{} is in group {}, which this server's groups.xml does not define; refusing.",
			        name, rawGroupId));
			    return;
		    }
		    const uint8_t currentGroupId = static_cast<uint8_t>(rawGroupId);
		    if (current->rank >= authority) {
			    adminReply(issuer, fmt::format("{} is {}, not below your rank.", name, current->name));
			    return;
		    }

		    boost::json::object change;
		    change["ref"] = fmt::format("#{}", accountId);
		    change["fromGroupId"] = currentGroupId;
		    change["toGroupId"] = toGroupId;
		    const std::string fromGroupName = current->name;
		    HttpClient::requestAsync("POST", base + "/api/servers/accounts/group", headers,
		        boost::json::serialize(change),
		        [this, adminId, adminName, accountId, name, fromGroupName, toGroupName](HttpClient::Response changed) {
			        Player* issuer = getPlayerByID(adminId);
			        if (changed.status == 200) {
				        if (issuer) {
					        adminReply(issuer, fmt::format("{} is now {}. It applies on their next login.", name, toGroupName));
				        }
				        if (Player* target = getPlayerByAccountId(accountId); target && target->client) {
					        target->client->sendServerLog(ServerLogKind::SYSTEM, 0, 0,
					            fmt::format("Your group is now {}. It applies the next time you join.", toGroupName));
				        }
				        fmt::print(">> [Admin] {} set {} (account {}) from group {} to {}\n",
				            adminName, name, accountId, fromGroupName, toGroupName);
			        } else if (issuer) {
				        // status == 0 means the POST never got a definite answer (a
				        // timeout or a lower transport failure) -- the request may
				        // well have reached the account service and applied before
				        // the response was lost, so this must not claim it failed.
				        // changed.error names which step it was (e.g. "read: ..."),
				        // which is worth keeping for diagnosis even though the
				        // headline has to stay "unknown", not "failed".
				        adminReply(issuer, changed.status == 0
				            ? fmt::format("Account service did not answer in time; the group may or "
				                          "may not have changed{} — check with !setgroup again later.",
				                  changed.error.empty() ? std::string() : fmt::format(" ({})", changed.error))
				            : changed.status == 409
				                ? std::string("The group changed meanwhile; try again.")
				                : fmt::format("Account service: {}", setGroupServiceError(changed)));
			        }
		        });
	    });
}

// !map-size            report the current size and what fits in it
// !map-size=<x>:<y>    resize to that many TILES and rebuild the world in it
//                      (append :wipe to bulldoze player builds as well)
//
// Tiles, not world units, and the same x:y shape every other positional admin
// command uses. The reply always states both so nobody has to remember which
// this one takes.
void Game::adminMapSize(Player* player, const std::string& args)
{
	if (args.empty()) {
		std::string reply = fmt::format(
			"Map is {}x{} tiles ({}x{} units), {} of which world generation may fill. "
			"!map-size=<x>:<y> resizes and rebuilds -- player builds are kept; add :wipe "
			"to flatten those too.",
			MapSize::tilesX(), MapSize::tilesY(), MapSize::widthUnits(), MapSize::heightUnits(),
			MapSize::makeContentBudget().totalTiles);

		// Printed to console in full; the chat line only carries the warning half
		// if there is one.
		if (const std::string warning = reportMapIdBudget(); !warning.empty()) {
			reply += " " + warning;
		}
		adminReply(player, reply);
		return;
	}

	std::string sizeText = args;
	bool preservePlayerBuilds = true;

	// The flag is split off the END, and only when what follows the last colon
	// is not a number: "60:60" has two colons' worth of meaning already, so
	// rfind(':') alone would read the height as the flag.
	if (const size_t colon = args.rfind(':'); colon != std::string::npos) {
		const std::string tail = args.substr(colon + 1);
		if (tail == "wipe" || tail == "all") {
			preservePlayerBuilds = false;
			sizeText = args.substr(0, colon);
		} else if (tail == "keep") {
			sizeText = args.substr(0, colon);
		}
	}

	int32_t tilesX = 0;
	int32_t tilesY = 0;
	std::string error;
	if (!MapSize::parse(sizeText, tilesX, tilesY, error)) {
		adminReply(player, fmt::format("{} Usage: !map-size=<tilesX>:<tilesY>[:keep|:wipe]", error));
		return;
	}

	// Checked here as well as inside the job, so a bad size is refused the
	// moment it is typed rather than after the queue wait. validate() rather
	// than apply(): the size must not move until the job that evicts and
	// rebuilds around it actually runs.
	if (!MapSize::validate(tilesX, tilesY, error)) {
		adminReply(player, error);
		return;
	}

	fmt::print(">> [Admin] {} issued !map-size={}:{}{}\n", player->getName(), tilesX, tilesY,
		preservePlayerBuilds ? "" : ":wipe");

	queueResize(tilesX, tilesY, preservePlayerBuilds, player->getGUID());
}

void Game::adminSetResourceRespawn(Player* player, const std::string& args)
{
	uint32_t ms = 0;
	if (!parseDelayMs(args, ms)) {
		adminReply(player, "Usage: !respawn-resources=<ms|off>");
		return;
	}

	g_resources.setRespawnDelayMs(ms);
	adminReply(player, ms == 0
		? std::string("Resource respawn off (and the periodic relocation with it).")
		: fmt::format("Resources respawn after {}ms.", ms));
}

void Game::adminSetStructureRespawn(Player* player, const std::string& args)
{
	uint32_t ms = 0;
	if (!parseDelayMs(args, ms)) {
		adminReply(player, "Usage: !respawn-structures=<ms|off>");
		return;
	}

	setStructuresRespawnDelayMs(ms);
	adminReply(player, ms == 0 ? std::string("City/house respawn off.")
	                           : fmt::format("Cities/houses respawn every {}ms.", ms));
}

Player* Game::resolveAdminTarget(uint32_t id)
{
	Player* target = getPlayerByGUID(id);
	return target ? target : getPlayerByID(id);
}

Position Game::tileCenterPosition(int32_t tileX, int32_t tileY) const
{
	return clampPositionToMap(tileX * TILE_SIZE + (TILE_SIZE / 2), tileY * TILE_SIZE + (TILE_SIZE / 2));
}

void Game::adminGiveItemToPlayer(const std::string& args)
{
	auto [idPart, itemPart, ok] = splitOnce(args, ',');
	if (!ok) return;

	if (Player* target = getPlayerByGUID(std::stoul(idPart))) {
		adminGiveItem(target, itemPart);
	}
}

void Game::adminPlacePlayerOnTile(Player* target, int32_t tileX, int32_t tileY)
{
    g_accountRuns.disqualify(target);
	const Position centre = tileCenterPosition(tileX, tileY);
	placeThing(target, clampBodyPositionToMap(centre.x, centre.y, target->getCollisionRadius()));
}

void Game::adminTeleport(Player* player, const std::string& args)
{
	auto [xPart, yPart, ok] = splitOnce(args, ':');
	if (!ok) return;

	adminPlacePlayerOnTile(player, std::stoi(xPart), std::stoi(yPart));
}

void Game::adminTeleportToPlayer(Player* player, const std::string& args)
{
	if (Player* target = getPlayerByGUID(std::stoul(args))) {
		placeThing(player, target->getPosition());
	}
}

void Game::adminTeleportPlayerTo(const std::string& args)
{
	auto [idPart, posPart, ok] = splitOnce(args, ':');
	if (!ok) return;

	auto [xPart, yPart, posOk] = splitOnce(posPart, ':');
	if (!posOk) return;

	if (Player* target = getPlayerByGUID(std::stoul(idPart))) {
		adminPlacePlayerOnTile(target, std::stoi(xPart), std::stoi(yPart));
	}
}

void Game::adminTeleportAll(Player* player, const std::string& args)
{
	auto [xPart, yPart, ok] = splitOnce(args, ':');
	if (!ok) return;

	const int32_t tileX = std::stoi(xPart);
	const int32_t tileY = std::stoi(yPart);
	for (auto& it : players) {
		if (it.second != player) {
			adminPlacePlayerOnTile(it.second, tileX, tileY);
		}
	}
}

// !a=N — jump N tiles along whichever axis the player is most nearly facing.
void Game::adminAdvance(Player* player, const std::string& args)
{
	const int32_t tilesCount = std::stoi(args);
	const Position pos = player->getPosition();
	const float baseAngle = (player->getRotation() * MATH_TWO_PI) / 255.0f;
	const float cosA = std::cos(baseAngle);
	const float sinA = std::sin(baseAngle);

	int32_t dx = 0;
	int32_t dy = 0;
	if (std::abs(cosA) > std::abs(sinA)) {
		dx = (cosA > 0) ? 1 : -1;
	} else {
		dy = (sinA > 0) ? 1 : -1;
	}

	// Body-aware, not the raw coordinate clamp: !a= into the edge of the map used
	// to leave the player standing half outside it, further out than walking into
	// the same wall can ever get you. See Game::clampBodyPositionToMap.
	placeThing(player, clampBodyPositionToMap(
		static_cast<int32_t>(pos.x) + dx * tilesCount * TILE_SIZE,
		static_cast<int32_t>(pos.y) + dy * tilesCount * TILE_SIZE,
		player->getCollisionRadius()));
}

void Game::adminKick(Player* admin, const std::string& args)
{
	Player* target = resolveAdminTarget(std::stoul(args));
	if (!target) {
		fmt::print(">> [Admin] kick: no player with id '{}'\n", args);
		return;
	}

	if (target->getAuthorityRank() >= admin->getAuthorityRank()) {
		adminReply(admin, fmt::format("You cannot kick {}: same or higher rank.", target->getName()));
		return;
	}

	fmt::print(">> [Admin] {} kicked {} (guid {})\n", admin->getName(), target->getName(), target->getGUID());
	kickPlayer(target, DisconnectReason::KICKED);
}

void Game::adminKickAll(Player* admin)
{
	// Collected first: kickPlayer mutates the players map.
	std::vector<Player*> targets;
	for (const auto& it : players) {
		if (it.second->getAuthorityRank() < admin->getAuthorityRank()) {
			targets.push_back(it.second);
		}
	}

	fmt::print(">> [Admin] {} kicked all non-admin players ({})\n", admin->getName(), targets.size());
	for (Player* t : targets) {
		kickPlayer(t, DisconnectReason::KICKED);
	}
}

// !close / !open. Only the login gate reads this (ProtocolGame::onRecvFirstMessage);
// players already in the world are left alone, so closing is not a mass kick.
// Pair it with !kick-all to actually empty the server.
void Game::adminSetServerOpen(Player* admin, bool open)
{
	const GameState_t wanted = open ? GAME_STATE_NORMAL : GAME_STATE_CLOSED;
	if (gameState == GAME_STATE_SHUTDOWN) {
		fmt::print(">> [Admin] server is shutting down; state cannot be changed.\n");
		return;
	}
	if (gameState == wanted) {
		fmt::print(">> [Admin] server is already {}.\n", open ? "open" : "closed");
		return;
	}

	setGameState(wanted);
	fmt::print(">> [Admin] {} {} the server to new logins{}.\n",
		admin->getName(), open ? "opened" : "closed",
		open ? "" : " (admins can still connect; players already online stay)");
}

// --- Server listing -------------------------------------------------------
//
// These move ServerInfo, never config.lua: a restart is a reset. Each one
// beats the listing immediately so the change shows up in the client's server
// list without waiting out the interval.

void Game::adminSetServerName(Player* admin, const std::string& args)
{
	std::string error;
	if (!ServerInfo::setName(args, error)) {
		adminReply(admin, error);
		fmt::print(">> [Admin] !server-name rejected: {}\n", error);
		return;
	}
	ServerListing::notifyChanged();
	adminReply(admin, fmt::format("Server name is now \"{}\".", ServerInfo::getName()));
	fmt::print(">> [Admin] {} renamed the server to \"{}\".\n", admin->getName(), ServerInfo::getName());
}

void Game::adminSetServerType(Player* admin, const std::string& args)
{
	std::string error;
	if (!ServerInfo::setType(args, error)) {
		adminReply(admin, error);
		return;
	}
	ServerListing::notifyChanged();
	adminReply(admin, fmt::format("Server type is now \"{}\".", ServerInfo::getTypeKey()));
	fmt::print(">> [Admin] {} set the server type to \"{}\".\n", admin->getName(), ServerInfo::getTypeKey());
}

void Game::adminSetServerLocation(Player* admin, const std::string& args)
{
	std::string error;
	if (!ServerInfo::setLocation(args, error)) {
		adminReply(admin, error);
		return;
	}
	ServerListing::notifyChanged();
	const std::string& location = ServerInfo::getLocation();
	adminReply(admin, location.empty() ? "Location cleared." : fmt::format("Location is now \"{}\".", location));
	fmt::print(">> [Admin] {} set the server location to \"{}\".\n", admin->getName(), location);
}

// !server-visible=0|1, or the !hide / !show shorthands.
void Game::adminSetServerVisible(Player* admin, const std::string& args, bool* forced)
{
	bool visible;
	if (forced) {
		visible = *forced;
	} else if (args == "1" || args == "on" || args == "true" || args == "yes") {
		visible = true;
	} else if (args == "0" || args == "off" || args == "false" || args == "no") {
		visible = false;
	} else {
		adminReply(admin, "Usage: !server-visible=0|1 (or !hide / !show)");
		return;
	}

	ServerInfo::setVisible(visible);
	ServerListing::notifyChanged();
	adminReply(admin, visible ? "Server is listed again."
		: "Server is hidden from the list. Players with the direct address can still connect.");
	fmt::print(">> [Admin] {} {} the server.\n", admin->getName(), visible ? "listed" : "hid");
}

// !max-players=<n>. Lowering it below the current population kicks the
// difference; players already in the world are otherwise never re-checked.
void Game::adminSetMaxPlayers(Player* admin, const std::string& args)
{
	int32_t value = 0;
	try {
		value = std::stoi(args);
	} catch (const std::exception&) {
		adminReply(admin, fmt::format("Usage: !max-players=<1-{}>", PROTOCOL_MAX_PLAYER_ID));
		return;
	}

	std::string error;
	if (!ServerInfo::setMaxPlayers(value, error)) {
		adminReply(admin, error);
		return;
	}

	const uint32_t kicked = enforcePlayerCap();
	ServerListing::notifyChanged();

	adminReply(admin, kicked == 0
		? fmt::format("Player cap is now {}.", value)
		: fmt::format("Player cap is now {}; kicked {} player(s).", value, kicked));
	fmt::print(">> [Admin] {} set maxPlayers to {} ({} kicked).\n", admin->getName(), value, kicked);
}

void Game::adminPrintServerInfo(Player* admin)
{
	adminReply(admin, fmt::format("{} [{}] {} — {}/{} players — map {}x{} — {}",
		ServerInfo::getName(), ServerInfo::getTypeKey(),
		ServerInfo::getLocation().empty() ? std::string("no location") : ServerInfo::getLocation(),
		getPlayersOnline(), ServerInfo::getMaxPlayers(),
		MapSize::tilesX(), MapSize::tilesY(),
		ServerInfo::isVisible() ? "listed" : "hidden"));
}

// Kicks newest-first down to the current cap, skipping admins. Returns how
// many were kicked.
uint32_t Game::enforcePlayerCap()
{
	const size_t cap = static_cast<size_t>(ServerInfo::getMaxPlayers());
	if (players.size() <= cap) {
		return 0;
	}

	std::vector<Player*> targets;
	targets.reserve(players.size());
	for (const auto& it : players) {
		if (!it.second->hasGroupFlag(GroupFlag::AlwaysLogin)) {
			targets.push_back(it.second);
		}
	}
	std::sort(targets.begin(), targets.end(), [](const Player* a, const Player* b) {
		return a->getSessionStart() > b->getSessionStart();
	});

	// kickPlayer defers the removal, so players.size() does not move here --
	// count down locally instead of re-reading it.
	size_t online = players.size();
	uint32_t kicked = 0;
	for (Player* target : targets) {
		if (online <= cap) {
			break;
		}
		kickPlayer(target, DisconnectReason::PLAYER_LIMIT_LOWERED);
		--online;
		++kicked;
	}
	return kicked;
}

// !ban=playerId:minutes[:reason] — 0 minutes = permanent; the reason may
// itself contain colons.
void Game::adminBanPlayer(Player* admin, const std::string& args)
{
	auto [idPart, rest, ok] = splitOnce(args, ':');
	if (!ok) {
		fmt::print(">> [Admin] Usage: !ban=playerId:minutes[:reason] (0 minutes = permanent)\n");
		return;
	}

	auto [minutesPart, reason, hasReason] = splitOnce(rest, ':');
	const uint32_t minutes = std::stoul(hasReason ? minutesPart : rest);
	trimInPlace(reason);

	Player* target = resolveAdminTarget(std::stoul(idPart));
	if (!target) {
		fmt::print(">> [Admin] ban: no player with id '{}'\n", idPart);
		return;
	}
	if (target->getAuthorityRank() >= admin->getAuthorityRank()) {
		adminReply(admin, fmt::format("You cannot ban {}: same or higher rank.", target->getName()));
		return;
	}

	adminBanIp(admin, target->getIP(), minutes, reason);
}

// !ban-ip=address[:minutes[:reason]] — for offline targets. IPv6 addresses
// contain colons, so the whole argument is tried as an address first.
void Game::adminBanAddress(Player* admin, const std::string& args)
{
	boost::system::error_code ec;
	auto addr = boost::asio::ip::make_address(args, ec);
	uint32_t minutes = 0;
	std::string reason;

	if (ec) {
		auto [addrPart, rest, ok] = splitOnce(args, ':');
		if (ok) {
			addr = boost::asio::ip::make_address(addrPart, ec);
			auto [minutesPart, reasonPart, hasReason] = splitOnce(rest, ':');
			minutes = std::stoul(hasReason ? minutesPart : rest);
			if (hasReason) {
				reason = reasonPart;
				trimInPlace(reason);
			}
		}
	}

	if (ec) {
		fmt::print(">> [Admin] Usage: !ban-ip=address[:minutes[:reason]] — '{}' is not a valid IP\n", args);
		return;
	}
	adminBanIp(admin, addr, minutes, reason);
}

void Game::adminUnban(Player* admin, const std::string& args)
{
	boost::system::error_code ec;
	auto addr = boost::asio::ip::make_address(args, ec);
	if (ec) {
		fmt::print(">> [Admin] Usage: !unban=address — '{}' is not a valid IP\n", args);
		return;
	}

	if (IOBan::removeIpBan(addr)) {
		fmt::print(">> [Admin] {} unbanned IP {}\n", admin->getName(), args);
	} else {
		fmt::print(">> [Admin] No ban found for IP {}\n", args);
	}
}

void Game::adminSetKarma(const std::string& args)
{
	auto [idPart, karmaPart, ok] = splitOnce(args, ':');
	if (!ok) return;

	Player* target = resolveAdminTarget(std::stoul(idPart));
	if (!target) return;

	const uint8_t karmaVal = static_cast<uint8_t>(std::stoi(karmaPart));

	// Kills are set one past the previous level's cap so the karma sticks
	// instead of being recalculated back down.
	uint32_t targetKills = 0;
	if (const GameMode* mode = getActiveMode(); mode && karmaVal > 0) {
		auto prevIt = mode->karmaLevels.find(karmaVal - 1);
		if (prevIt != mode->karmaLevels.end()) {
			targetKills = prevIt->second.maxKills + 1;
		}
	}
	g_accountRuns.disqualify(target);
	target->forceKarma(karmaVal, targetKills);
}

// !quest=<start|stage|reset|complete>:<guid>:<quest>[:<stage or ending>]
void Game::adminQuest(Player* admin, const std::string& args)
{
	const std::vector<std::string_view> parts = explodeString(args, ":");
	if (parts.size() < 3 || parts.size() > 4) {
		adminReply(admin, "[Admin] Usage: !quest=start|stage|reset|complete:<guid>:<quest>[:<stage or ending>]");
		return;
	}
	uint32_t guid = 0;
	const auto [end, ec] = std::from_chars(parts[1].data(), parts[1].data() + parts[1].size(), guid);
	Player* target = ec == std::errc() && end == parts[1].data() + parts[1].size() ? resolveAdminTarget(guid) : nullptr;
	if (!target) {
		adminReply(admin, "[Admin] No player with guid " + std::string(parts[1]) + ".");
		return;
	}
	adminReply(admin, "[Admin] " + g_quests.admin(target, std::string(parts[0]), std::string(parts[2]),
		parts.size() == 4 ? std::string(parts[3]) : std::string()));
}

// !achievement=<grant|revoke>:<guid>:<key>
void Game::adminAchievement(Player* admin, const std::string& args)
{
	const std::vector<std::string_view> parts = explodeString(args, ":");
	if (parts.size() != 3) {
		adminReply(admin, "[Admin] Usage: !achievement=grant|revoke:<guid>:<key>");
		return;
	}
	uint32_t guid = 0;
	const auto [end, ec] = std::from_chars(parts[1].data(), parts[1].data() + parts[1].size(), guid);
	Player* target = ec == std::errc() && end == parts[1].data() + parts[1].size() ? resolveAdminTarget(guid) : nullptr;
	if (!target) {
		adminReply(admin, "[Admin] No player with guid " + std::string(parts[1]) + ".");
		return;
	}
	const std::string reply = g_progress.admin(target, std::string(parts[0]), std::string(parts[2]));
	adminReply(admin, "[Admin] " + reply);
	fmt::print(">> [Admin] {} !achievement={}: {}\n", admin->getName(), args, reply);
}

// Jumps the clock to sunrise or sunset. No argument toggles.
void Game::adminSetDayNight(const std::string& args)
{
	bool toNight = false;
	if (args == "day") {
		toNight = false;
	} else if (args == "night") {
		toNight = true;
	} else if (args.empty()) {
		toNight = !isNight();
	} else {
		return;
	}

	worldClock.setHalf(toNight);
	// Explicit so the jump lands this instant rather than on the next tick. The
	// clock would state itself either way -- setHalf records that the clients
	// are owed one -- which is deliberate: a jump nobody is told about is the
	// bug WorldClock exists to make unrepresentable.
	broadcastWorldTime();
}

void Game::adminSetCraftSpeed(const std::string& args)
{
	if (args.empty()) return;

	try {
		float factor = std::stof(args);
		if (factor > 0.0f && factor <= 100.0f) {
			craftSpeed = factor;
			if (activeMode) {
				const_cast<GameMode*>(activeMode)->craftSpeed = factor;
			}
			fmt::print(">> [Admin] Craft speed multiplier set to {}\n", factor);
		} else {
			fmt::print(">> [Admin Error] craft-speed factor must be between 0 and 100 (exclusive of 0)\n");
		}
	} catch (const std::exception& e) {
		fmt::print(">> [Admin Command Error] 'craft-speed': {}\n", e.what());
	}
}

// !gauge-<name>-<field>=<value>
//
//   name   food | cold | stamina | rad | life
//          ("cold" and "rad" are what the documentation calls them; modes.xml
//          calls the same two gauges "warmth" and "radiation", and both spellings
//          are accepted here so neither reference contradicts the server)
//   field  increase | decrease | size
//
// increase/decrease are rates in the same /10000 domain as modes.xml and the
// MODDED_GAUGES_VALUES packet, 0..10000. size is the gauge's ceiling, 1..255.
//
// Runtime only: this edits the resolved activeGauges rather than modes.xml, so
// !reload-xml puts the mode's own numbers back. Nothing is broadcast from here —
// Player::syncGaugeRates recomputes from activeGauges every tick and re-sends the
// rate packet to each client the moment the numbers move, which is also what
// keeps a per-player resistance folded in on top of whatever is set here.
void Game::adminSetGauge(Player* player, const std::string& spec, const std::string& args)
{
	const auto usage = [this, player]() {
		adminReply(player, "Usage: gauge-<food|cold|stamina|rad|life>-<increase|decrease|size>=<value>");
	};

	const size_t dash = spec.rfind('-');
	if (dash == std::string::npos || dash == 0 || args.empty()) {
		usage();
		return;
	}

	std::string name = spec.substr(0, dash);
	std::string field = spec.substr(dash + 1);
	for (std::string* text : {&name, &field}) {
		for (char& c : *text) {
			c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
		}
	}

	GaugeMode* target = nullptr;
	if (name == "food") target = &activeGauges.food;
	else if (name == "cold" || name == "warmth") target = &activeGauges.warmth;
	else if (name == "stamina") target = &activeGauges.stamina;
	else if (name == "rad" || name == "radiation") target = &activeGauges.radiation;
	else if (name == "life") target = &activeGauges.life;

	if (!target) {
		usage();
		return;
	}

	int32_t value = 0;
	try {
		value = std::stoi(args);
	} catch (const std::exception&) {
		usage();
		return;
	}

	if (field == "size") {
		if (value < 1 || value > 255) {
			adminReply(player, "Size must be between 1 and 255.");
			return;
		}
		target->max = static_cast<uint16_t>(value);
		// A ceiling that just dropped can leave live gauges above it.
		for (auto& it : players) {
			it.second->clampGaugesToMax();
		}
	} else if (field == "increase") {
		if (value < 0 || value > 10000) {
			adminReply(player, "Rate must be between 0 and 10000.");
			return;
		}
		target->speedInc = static_cast<uint16_t>(value);
	} else if (field == "decrease") {
		if (value < 0 || value > 10000) {
			adminReply(player, "Rate must be between 0 and 10000.");
			return;
		}
		target->speedDec = static_cast<uint16_t>(value);
	} else {
		usage();
		return;
	}

	adminReply(player, fmt::format("{} {} set to {}.", name, field, value));
	fmt::print(">> [Admin] Gauge '{}' {} set to {}\n", name, field, value);
}

// groups.xml and commands.xml as one unit: both are loaded into temporaries
// and swapped in only when both are valid, so a broken commands.xml cannot
// leave new groups live beside the old command ranks (or the reverse).
static bool reloadGroupsAndCommands()
{
	Groups groups;
	CommandPermissions permissions;
	if (!groups.loadFromXml(contentFile("groups.xml")) ||
	    !permissions.loadFromXml(contentFile("commands.xml"), groups)) {
		return false;
	}
	g_groups = std::move(groups);
	g_commandPermissions = std::move(permissions);
	return true;
}

void Game::adminReloadXml(Player* admin, const std::string& args)
{
	std::string target = args;
	trimInPlace(target);

	// Convert to lowercase for case-insensitive matching
	for (char& c : target) {
		c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
	}

	// Remove path prefixes if provided (e.g. "xml/" or "x64/debug/xml/")
	size_t slashPos = target.find_last_of("/\\");
	if (slashPos != std::string::npos) {
		target = target.substr(slashPos + 1);
	}

	// Strip ".xml" suffix if present
	if (target.size() >= 4 && target.substr(target.size() - 4) == ".xml") {
		target = target.substr(0, target.size() - 4);
	}

	bool success = false;
	std::string targetFile;
	std::vector<contentexport::ContentPatch> patches;

	if (target == "all") {
		bool eqOk = EquipmentManager::getInstance().loadEquipables(contentFile("equipables.xml"));
		bool wearOk = EquipmentManager::getInstance().loadWearables(contentFile("wearables.xml"));

		std::unordered_map<uint32_t, std::vector<std::string>> before;
		before.reserve(players.size());
		for (const auto& [id, p] : players) {
			before.emplace(id, p->conditionKeys());
		}
		std::string condFile = contentFile("conditions.xml");
		bool condOk = ConditionManager::getInstance().reloadFromXml(condFile);
		if (condOk) {
			for (auto& [id, p] : players) {
				p->rebindConditions(before[id]);
			}
			ConditionManager::getInstance().validateRepelTargets(condFile);
		}

		const bool groupsOk = reloadGroupsAndCommands();
		if (groupsOk) {
			for (const auto& [id, p] : players) {
				if (p && p->client) {
					p->client->sendGroups();
					p->client->sendChatAccess();
				}
			}
		}

		patches = contentexport::ContentManager::getInstance().reloadAll();
		success = eqOk && wearOk && condOk && g_npcs.load(contentFile("npcs.xml"))
			&& g_progress.load(contentFile("stats.xml"), contentFile("achievements.xml"))
			&& g_quests.load(QuestSystem::directory()) && groupsOk;
		targetFile = "all tables";
	} else if (target == "groups" || target == "commands") {
		targetFile = "groups.xml + commands.xml";
		success = reloadGroupsAndCommands();
		if (success) {
			// Badges and the admin chat tab follow the group, so restate both.
			for (const auto& [id, p] : players) {
				if (!p || !p->client) continue;
				p->client->sendGroups();
				p->client->sendChatAccess();
				for (const auto& [otherId, other] : players) {
					if (other) p->client->sendPlayerInfo(*other);
				}
			}
		}
	} else if (target == "npcs") {
        targetFile = contentFile("npcs.xml");
        success = g_npcs.load(targetFile);
        if (success) patches = contentexport::ContentManager::getInstance().reloadTable("npcs");
	} else if (target == "quests") {
		targetFile = QuestSystem::directory();
		success = g_quests.load(targetFile);
	} else if (target == "stats" || target == "achievements" || target == "progress") {
		targetFile = "stats.xml + achievements.xml + quests";
		// Quests name achievements and stats, so they are checked again too.
		success = g_progress.load(contentFile("stats.xml"), contentFile("achievements.xml")) && g_quests.load(QuestSystem::directory());
		if (success) patches = contentexport::ContentManager::getInstance().reloadTable("stats");
		if (success) {
			auto more = contentexport::ContentManager::getInstance().reloadTable("achievements");
			patches.insert(patches.end(), more.begin(), more.end());
		}
    } else if (target == "equipables") {
		targetFile = contentFile("equipables.xml");
		success = EquipmentManager::getInstance().loadEquipables(targetFile);
		if (success) {
			patches = contentexport::ContentManager::getInstance().reloadTable("equipables");
		}
	} else if (target == "wearables") {
		targetFile = contentFile("wearables.xml");
		success = EquipmentManager::getInstance().loadWearables(targetFile);
		if (success) {
			patches = contentexport::ContentManager::getInstance().reloadTable("wearables");
		}
	} else if (target == "conditions") {
		targetFile = contentFile("conditions.xml");

		std::unordered_map<uint32_t, std::vector<std::string>> before;
		before.reserve(players.size());
		for (const auto& [id, p] : players) {
			before.emplace(id, p->conditionKeys());
		}

		success = ConditionManager::getInstance().reloadFromXml(targetFile);
		if (success) {
			for (auto& [id, p] : players) {
				p->rebindConditions(before[id]);
			}
			ConditionManager::getInstance().validateRepelTargets(targetFile);
			patches = contentexport::ContentManager::getInstance().reloadTable("conditions");
		}
	} else {
		// Check if it's one of the other content tables or config
		bool isKnownTable = (target == "config");
		if (!isKnownTable) {
			for (const auto& spec : contentexport::tables()) {
				if (spec.name == target) {
					isKnownTable = true;
					targetFile = contentFile(spec.file);
					break;
				}
			}
		} else {
			targetFile = "config";
		}

		if (isKnownTable) {
			patches = contentexport::ContentManager::getInstance().reloadTable(target);
			success = true;
		} else {
			std::string errMsg = fmt::format("[Admin Error] Unknown or unsupported reload target '{}'.", args);
			fmt::print(">> {}\n", errMsg);
			if (admin && admin->client) {
				admin->client->sendAdminReply(errMsg);
			}
			return;
		}
	}

	if (!patches.empty()) {
		for (const auto& patch : patches) {
			for (const auto& [id, p] : players) {
				if (p && p->client) {
					p->client->sendContentPatch(patch);
				}
			}
		}
		fmt::print(">> [ContentManager] Broadcasted {} patch(es) to {} connected player(s)\n", patches.size(), players.size());
	}

	if (success) {
		std::string successMsg = fmt::format("[Admin] Successfully hot-reloaded {} ({} patches broadcast).", targetFile, patches.size());
		fmt::print(">> {}\n", successMsg);
		if (admin && admin->client) {
			admin->client->sendAdminReply(successMsg);
		}
	} else {
		std::string errMsg = fmt::format("[Admin Error] Failed to hot-reload {}: XML parsing or loading error (see console).", targetFile);
		fmt::print(">> {}\n", errMsg);
		if (admin && admin->client) {
			admin->client->sendAdminReply(errMsg);
		}
	}
}
