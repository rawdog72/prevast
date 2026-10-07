// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "core/prevast_server.h"
#include "content/contentexport.h"

#include "persistence/ban.h"
#include "gameplay/game.h"
#include "content/configmanager.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "network/server.h"
#include "core/tools.h"
#include "network/protocolstatus.h"
#include "network/account_ticket.h"
#include "network/login_identity.h"
#include "network/protocolgame.h"
#include "network/serverinfo.h"
#include "network/serverlisting.h"
#include "persistence/databasetasks.h"
#include "gameplay/resource.h"
#include "gameplay/object.h"
#include "gameplay/agent.h"
#include "gameplay/item.h"
#include "gameplay/equipment.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/projectile.h"
#include "gameplay/kit.h"
#include "gameplay/groups.h"
#include "content/xml_utils.h"
#include "content/scenario_compile.h"
#include "content/scenario_project.h"

#include <fstream>
#include <unordered_set>
#include <luajit/lua.h>

#ifdef _WIN32
// timeBeginPeriod/timeGetDevCaps live in winmm; see TimerResolutionGuard below.
#include <timeapi.h>
#pragma comment(lib, "winmm.lib")
#endif

DatabaseTasks g_databaseTasks;
Dispatcher g_dispatcher;
Scheduler g_scheduler;

Game g_game;

std::mutex g_loaderLock;
std::condition_variable g_loaderSignal;
std::unique_lock<std::mutex> g_loaderUniqueLock(g_loaderLock);

namespace {

	void startupErrorMessage(const std::string& errorStr)
	{
		fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, "> ERROR: {:s}\n", errorStr);
		g_loaderSignal.notify_all();
	}

	// --- Cross-file reference check ------------------------------------------
	//
	// A key that stops resolving is the failure mode a content edit actually
	// produces, and most of them are silent: an unknown <tool key> just means
	// the resource can never be harvested, an unknown <ammo key> means the gun
	// never loads. The loaders check a few of these inline (ingredients,
	// prerequisites, base objects, spawnCreature); this covers the rest.
	//
	// It reads the files again rather than asking the managers, for two reasons.
	// The managers have already collapsed some of this -- ProjectileManager maps
	// an unknown key to id 0, which is a real projectile -- and re-reading keeps
	// the check honest about what is written in the file, which is what the
	// person editing it sees.

	using KeySet = std::unordered_set<std::string>;

	// Every `elem@attr` value in one file, e.g. collectKeys(doc, "item", "key").
	KeySet collectKeys(const pugi::xml_node& root, const char* elem, const char* attr)
	{
		KeySet out;
		for (const pugi::xpath_node& xn : root.select_nodes(fmt::format("//{}", elem).c_str())) {
			const char* v = xn.node().attribute(attr).value();
			if (v && *v) out.emplace(v);
		}
		return out;
	}

	struct RefRule {
		const char* elem;      // element carrying the reference
		const char* attr;      // attribute holding the key
		const KeySet* target;  // registry it must resolve against
		const char* targetName;
		const char* exempt;    // one legal non-key value, or nullptr
		// The attribute is a comma-separated LIST of keys, not one key. Without
		// this the whole string is looked up as a single name, which never
		// matches and would warn about every list -- so a plural attribute was
		// simply left unchecked, and <cureCondition keys="a,b"> could name an
		// effect that had been renamed out from under it in silence.
		bool list = false;
	};

	void checkFileRefs(const std::string& fileName, const std::vector<RefRule>& rules)
	{
		pugi::xml_document doc;
		if (!doc.load_file(fileName.c_str())) return; // load failure already reported
		const std::string rootName = doc.document_element().name();
		content_files::load(doc, fileName, rootName.c_str());

		for (const RefRule& rule : rules) {
			for (const pugi::xpath_node& xn : doc.select_nodes(fmt::format("//{}", rule.elem).c_str())) {
				const pugi::xml_node n = xn.node();
				const std::string value = n.attribute(rule.attr).value();
				if (value.empty()) continue;

				for (std::string_view part : rule.list ? explodeString(value, ",")
				                                       : std::vector<std::string_view>{value}) {
					const size_t first = part.find_first_not_of(" \t");
					if (first == std::string_view::npos) continue;
					const std::string key{part.substr(first, part.find_last_not_of(" \t") - first + 1)};

					if (rule.exempt && key == rule.exempt) continue;
					if (rule.target->count(key)) continue;

					reportDataWarning(fileName, fmt::format("{}: <{} {}=\"{}\"> does not name any {}",
						xml_utils::locate(fileName, n), rule.elem, rule.attr, key, rule.targetName));
				}
			}
		}
	}

	void validateDataReferences()
	{
		auto rootOf = [](pugi::xml_document& doc, const std::string& file) {
			if (!doc.load_file(file.c_str())) return pugi::xml_node();
			const std::string name = doc.document_element().name();
			return content_files::load(doc, file, name.c_str());
		};

		pugi::xml_document itemsDoc, objectsDoc, furnDoc, agentsDoc, projDoc, effDoc, structDoc, equipDoc;
		const KeySet items      = collectKeys(rootOf(itemsDoc,   contentFile("items.xml")),         "item",      "key");
		KeySet objects          = collectKeys(rootOf(objectsDoc, contentFile("objects.xml")),       "object",    "key");
		for (const std::string& k : collectKeys(rootOf(furnDoc,  contentFile("furnitures.xml")),    "object",    "key")) objects.insert(k);
		const KeySet agents     = collectKeys(rootOf(agentsDoc,  contentFile("agents.xml")),        "agent",     "key");
		const KeySet projectiles= collectKeys(rootOf(projDoc,    contentFile("projectiles.xml")),   "projectile","key");
		const KeySet effects    = collectKeys(rootOf(effDoc,     contentFile("conditions.xml")),    "condition", "key");

		// A cure may name a condition KEY or a TAG -- <cureCondition keys="poison">
		// is the whole point of tags, since enumerating keys rots as content grows
		// and has already rotted once (lapadoine_effect -> lapadone_effect went
		// uncured for a day). So the cure rule checks against both, and a name
		// that is neither is still caught.
		KeySet cureNames = effects;
		for (const std::string& tagList : collectKeys(rootOf(effDoc, contentFile("conditions.xml")),
		                                             "condition", "tags")) {
			for (std::string_view part : explodeString(tagList, ",")) {
				const size_t first = part.find_first_not_of(" \t");
				if (first == std::string_view::npos) continue;
				cureNames.insert(std::string{
					part.substr(first, part.find_last_not_of(" \t") - first + 1)});
			}
		}
		const KeySet structures = collectKeys(rootOf(structDoc,  contentFile("structures.xml")),    "template",  "key");
		const KeySet equipables = collectKeys(rootOf(equipDoc,   contentFile("equipables.xml")),    "equipable", "key");

		// NOT items.xml's <object key=>: nothing reads it. The item/object link
		// runs the other way -- an object adopts the id of the item whose key
		// matches its own, or the one named by <object itemKey=> -- which is why
		// that is the attribute checked here. (The 63 <object key=> entries in
		// items.xml are inert; removing them is cleanup, not a fix.)
		for (const std::string& objectFile : {contentFile("objects.xml"), contentFile("furnitures.xml")}) {
			checkFileRefs(objectFile, {
				{"object", "itemKey", &items, "item in items.xml", nullptr},
			});
		}
		// Not <decay transformTo=>: ItemManager resolves that key itself and
		// warns, same as it does for ingredients and prerequisites. This checker
		// covers the references no loader looks at.
		checkFileRefs(contentFile("resources.xml"), {
			// "hand" is the bare-hands sentinel, not an item.
			{"tool", "key", &items, "item in items.xml", "hand"},
			{"loot", "key", &items, "item in items.xml", nullptr},
		});
		checkFileRefs(contentFile("equipables.xml"), {
			{"projectile",   "key", &projectiles, "projectile in projectiles.xml", nullptr},
			{"ammo",         "key", &items,       "item in items.xml", nullptr},
			{"consume",      "key", &items,       "item in items.xml", nullptr},
			{"condition",     "key",  &effects, "condition in conditions.xml", nullptr},
			// A weapon's <damage><onHit condition=> and its crit's condition.
			{"onHit", "condition", &effects, "condition in conditions.xml", nullptr},
			{"crit",  "condition", &effects, "condition in conditions.xml", nullptr},
			// "all" is the cure-everything sentinel, not a key; a name may also be
			// a TAG rather than a key, so cureNames carries both.
			{"cureCondition", "keys", &cureNames, "condition or tag in conditions.xml", "all", true},
		});
		// What a round and a bite inflict. Neither loader can resolve these
		// itself -- conditions.xml loads after both files -- so this is the only
		// place they are checked at all.
		checkFileRefs(contentFile("projectiles.xml"), {
			{"onHit", "condition", &effects, "condition in conditions.xml", nullptr},
			{"crit",  "condition", &effects, "condition in conditions.xml", nullptr},
		});
		// <explosion><onHit condition=> lives in objects.xml and furnitures.xml
		// too, and the `onHit` rule below already covers whichever file it is in
		// -- the checker matches by element name anywhere in the document.
		for (const std::string& blastFile : {contentFile("objects.xml"), contentFile("furnitures.xml")}) {
			checkFileRefs(blastFile, {
				{"onHit", "condition", &effects, "condition in conditions.xml", nullptr},
			});
		}
		checkFileRefs(contentFile("agents.xml"), {
			{"ability", "condition", &effects, "condition in conditions.xml", nullptr},
			{"crit",    "condition", &effects, "condition in conditions.xml", nullptr},
			// <explosion><onHit condition=>: what an exploding agent leaves behind.
			{"onHit",   "condition", &effects, "condition in conditions.xml", nullptr},
			// <resistances><condition key=>: what the agent shrugs off. Resisting
			// a condition that does not exist protects it from nothing.
			{"condition", "key", &effects, "condition in conditions.xml", nullptr},
		});
		checkFileRefs(contentFile("kits.xml"), {
			{"item", "key", &items, "item in items.xml", nullptr},
		});
		checkFileRefs(contentFile("modes.xml"), {
			{"agent",     "key", &agents,     "agent in agents.xml", nullptr},
			{"structure", "key", &structures, "template in structures.xml", nullptr},
		});
		checkFileRefs(contentFile("furnitures.xml"), {
			{"item", "key", &items, "item in items.xml", nullptr},
		});

		// equipables.xml is the only file naming an equipable by key; items.xml
		// binds to one through <equipable key=>, which is what makes a weapon
		// usable at all.
		checkFileRefs(contentFile("items.xml"), {
			{"equipable", "key", &equipables, "equipable in equipables.xml", "place_object"},
		});
	}

	// --- Content manifest ----------------------------------------------------
	//
	// content.xml declares the content set and the order it loads in; this
	// compares that declaration against what actually happened, which
	// xml_utils::loadedFiles() recorded as each file was opened.
	//
	// Three things can be wrong, and all three are silent without this: a file
	// that loads but nobody declared (so nothing documents why it is there), a
	// file declared but never loaded (a manager call that was removed, or a
	// manifest entry written before the code), and a file that loads BEFORE
	// something it depends on. The last is the one that bites -- resources.xml
	// loaded ahead of items.xml for a long time and only surfaced when its keys
	// started resolving at load.
	void verifyContentManifest()
	{
		pugi::xml_document doc;
		const pugi::xml_node root = xml_utils::openDataFile(doc, contentFile("content.xml"), "content");
		if (!root) return; // openDataFile already said why

		const std::vector<xml_utils::LoadedFile>& loaded = xml_utils::loadedFiles();
		auto positionOf = [&loaded](const std::string& name) -> int {
			for (size_t i = 0; i < loaded.size(); ++i) {
				if (loaded[i].name == name) return static_cast<int>(i);
			}
			return -1;
		};

		std::unordered_set<std::string> declared;
		for (pugi::xml_node f = root.child("file"); f; f = f.next_sibling("file")) {
			const std::string name = f.attribute("name").as_string();
			if (name.empty()) {
				reportDataWarning("content.xml", "a <file> has no name=");
				continue;
			}
			declared.insert(name);

			const int here = positionOf(name);
			if (here < 0) {
				reportDataWarning("content.xml", fmt::format(
					"declares '{}', which never loaded; either the manager call is missing or "
					"this entry is stale", name));
				continue;
			}

			// The declared root element, checked against the one the file
			// actually had. Keeps the manifest honest as a description of the
			// content set rather than a list of names.
			const std::string declaredRoot = f.attribute("root").as_string();
			if (!declaredRoot.empty() && declaredRoot != loaded[here].root) {
				reportDataWarning("content.xml", fmt::format(
					"'{}' is declared with root=\"{}\" but its root element is <{}>",
					name, declaredRoot, loaded[here].root));
			}

			const std::string after = f.attribute("after").as_string();
			if (after.empty()) continue;

			const int dep = positionOf(after);
			if (dep < 0) {
				reportDataWarning("content.xml", fmt::format(
					"'{}' declares after=\"{}\", which never loaded", name, after));
			} else if (dep > here) {
				reportDataWarning("content.xml", fmt::format(
					"'{}' loads before '{}' but declares after=\"{}\"; anything it resolves from "
					"that file will not be there yet", name, after, after));
			}
		}

		for (const xml_utils::LoadedFile& f : loaded) {
			// content.xml loads itself through openDataFile, so it is in the list.
			if (f.name == "content.xml" || declared.count(f.name)) continue;
			reportDataWarning("content.xml", fmt::format(
				"'{}' loaded but is not declared here; add it so the set stays documented", f.name));
		}

		reportDataFile("content.xml", fmt::format("{} content files declared, {} loaded",
			declared.size(), loaded.size() > 0 ? loaded.size() - 1 : 0));
	}

	// Scope views are checked against the loaded viewport (config.lua
	// maxViewportX/Y), which content alone does not know: a config change can
	// make a weak view fall short or a strong one too big. The off-screen note
	// is advice for the author and is not counted as a warning. See
	// aim_view::weakReachProblem, strongAreaProblem and strongScreenNote.
	void checkWeaponViews()
	{
		const int32_t viewX = getNumber(ConfigManager::MAX_VIEWPORT_X);
		const int32_t viewY = getNumber(ConfigManager::MAX_VIEWPORT_Y);
		const auto check = [&](const ViewData& view, const std::string& owner, std::string_view file) {
			if (const auto problem = aim_view::weakReachProblem(view, owner, viewX, viewY)) {
				reportDataWarning(file, *problem);
			}
			if (const auto problem = aim_view::strongAreaProblem(view, owner, viewX, viewY)) {
				reportDataWarning(file, *problem);
			}
			if (const auto note = aim_view::strongScreenNote(view, owner)) {
				reportDataFile(file, *note);
			}
		};
		for (const auto& [key, weapon] : EquipmentManager::getInstance().getEquipables()) {
			check(weapon.view, fmt::format("'{}'", key), contentFile("equipables.xml"));
		}
		for (const auto& [key, mod] : ModManager::getInstance().all()) {
			check(mod.view, fmt::format("mod '{}'", key), contentFile("mods.xml"));
		}
	}

	// Every content file loaded outside Game, in the order the managers need.
	// Split out of mainLoader so --validate runs the identical sequence: a
	// second copy of this list would drift, and drift is exactly what the
	// checker is meant to catch.
	//
	// One block, one aligned line per file. Loaders report a count and are
	// otherwise silent; anything wrong goes through reportDataWarning so it
	// actually stands out. See tools.h.
	bool loadContentFiles()
	{
		std::cout << ">> Loading game data" << std::endl;

		// items.xml FIRST, and that is the rule the rest of this order follows:
		// everything that names an item resolves the key at load, so items must
		// already be there. resources.xml used to load ahead of it and got away
		// with it only because its drop table kept the key as a string and looked
		// it up on every swing; sharing one drop shape with objects and agents
		// made the dependency real.
		if (!ItemManager::getInstance().loadFromXml(contentFile("items.xml"))) {
			startupErrorMessage("Failed to load items.xml");
			return false;
		}

		if (!g_resources.loadFromXml(contentFile("resources.xml"))) {
			startupErrorMessage("Failed to load resources.xml");
			return false;
		}

		// After items (every mod is an item) and before equipables (a weapon's
		// <mods> slots resolve mod keys as they load).
		if (!ModManager::getInstance().loadFromXml(contentFile("mods.xml"))) {
			startupErrorMessage("Failed to load mods.xml");
			return false;
		}

		if (!EquipmentManager::getInstance().loadFromXml(contentFile("equipables.xml"), contentFile("wearables.xml"))) {
			startupErrorMessage("Failed to load equipment data.");
			return false;
		}

		// After equipables: kit items may specify a starting ammo count,
		// which is validated against the weapon's magazineSize at parse.
		if (!KitManager::getInstance().loadFromXml(contentFile("kits.xml"))) {
			startupErrorMessage("Failed to load kits.xml");
			return false;
		}

		// Load items into ObjectManager (handles world objects, physical drops, harvesting data).
		// This uses the same items.xml file but parses drop rates and physical properties instead.
		if (!g_objects.loadItemsFromXml(contentFile("items.xml"))) {
			startupErrorMessage("Failed to load items.xml for ObjectManager");
			return false;
		}

		if (!g_objects.loadFromXml(contentFile("objects.xml"))) {
			startupErrorMessage("Failed to load objects.xml");
			return false;
		}

		if (!g_objects.loadFromXml(contentFile("furnitures.xml"))) {
			reportDataWarning(contentFile("furnitures.xml"), "could not be loaded; furniture will be missing from the world");
		}

		// After the last loadFromXml: furnitures.xml is what makes item ids
		// ambiguous (every furniture inherits id 71), so an index built
		// before it would resolve those records to nothing.
		g_objects.buildMapItemIndex();

		// Objects carry the station areas, and items were parsed before them.
		ItemManager::getInstance().resolveStationAreas(contentFile("items.xml"));

		if (!ProjectileManager::getInstance().loadFromXml(contentFile("projectiles.xml"))) {
			startupErrorMessage("Failed to load projectiles.xml");
			return false;
		}

		if (!g_agents.loadFromXml(contentFile("agents.xml"))) {
			startupErrorMessage("Failed to load agents.xml");
			return false;
		}

		// Objects load before agents, so their <stage spawnCreature="..."> keys
		// can only be checked here.
		g_objects.validateStageCreatures();

		// Staff groups, then the rank each !command needs, which is checked
		// against the group ranks as it loads.
		if (!g_groups.loadFromXml(contentFile("groups.xml"))) {
			startupErrorMessage("Failed to load groups.xml");
			return false;
		}
		if (!g_commandPermissions.loadFromXml(contentFile("commands.xml"), g_groups)) {
			startupErrorMessage("Failed to load commands.xml");
			return false;
		}

		// Every data file is loaded by now, which is what makes the
		// cross-file keys resolvable.
		validateDataReferences();
		checkWeaponViews();
		return true;
	}

	// Worst-case projectiles in flight for ONE shooter, read from the loaded
	// weapon and projectile data: a weapon puts `pellets` in the air every
	// shotDelayMs and each lives lifetimeMs, so the peak is
	// pellets * ceil(lifetime / cadence).
	//
	// Derived rather than hardcoded so adding a faster gun widens the reserve by
	// itself. The caller clamps the result -- this reads editable content, and
	// content must never be able to make a promise the rest of the world then
	// cannot keep.
	uint32_t worstCaseProjectilesPerShooter()
	{
		uint32_t worst = 0;
		auto& projectiles = ProjectileManager::getInstance();

		for (const auto& [key, equip] : EquipmentManager::getInstance().getEquipables()) {
			if (equip.projectileKey.empty()) {
				continue;
			}
			const ProjectileData* pdata =
				projectiles.getProjectileData(projectiles.getProjectileId(equip.projectileKey));
			if (!pdata || pdata->lifetimeMs == 0) {
				continue;
			}

			// A fitted mod can shorten the delay, so size for the fastest combination.
			const uint32_t cadence = std::max<uint32_t>(weapon_mods::fastestShotDelayMs(equip), 1);
			const uint32_t pellets = std::max<uint32_t>(equip.pellets, 1);
			const uint32_t concurrent = pellets * ((pdata->lifetimeMs + cadence - 1) / cadence);
			worst = std::max(worst, concurrent);
		}

		return worst != 0 ? worst : PROJECTILE_CONCURRENT_PER_SHOOTER_FALLBACK;
	}

	// Sizes the one shared id16 pool and prints the resulting budget.
	//
	// The report exists because the id space is the one resource an admin can
	// overcommit from a text file and not find out until building silently
	// stops mid-session. Everything that could push it over -- content limits,
	// the map's buildable area, the player cap -- is printed against the space
	// it has to fit in, at boot, once.
	void configureEntityIdPool()
	{
		// The auto size below is derived from the tile count, and at boot this
		// runs before Game::start. loadFromConfig is once-per-process, so this
		// either installs the size or confirms it is already installed.
		MapSize::loadFromConfig();

		const uint32_t configured =
			static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::CLIENT_MAX_ENTITY_ID)));

		uint32_t space;
		if (configured == 0) {
			// Auto. Sized from the MAP, because that is what sets demand: a
			// fully built world costs 2 ids per tile (maxStaticObjectsForMap),
			// and the transient band plus loot/projectile churn sit on top. Four
			// per tile covers both with room to spare.
			//
			// Deliberately not CLIENT_ENTITY_ID_SPACE_MAX. `space` is also the
			// length of the pool's occupancy table in BYTES, so defaulting to
			// the 24-bit ceiling would allocate 16 MB on a server that needs
			// 128 KB. Rounded up to a power of two only for tidiness in the
			// report; nothing depends on it.
			const uint64_t demand = static_cast<uint64_t>(MapSize::tileCount()) * 4
				+ CLIENT_ENTITY_ID_TRANSIENT_COUNT;
			space = CLIENT_ENTITY_ID_SPACE_DEFAULT;
			while (space < demand && space < CLIENT_ENTITY_ID_SPACE_MAX) {
				space <<= 1;
			}
		} else if (configured > CLIENT_ENTITY_ID_SPACE_MAX) {
			space = CLIENT_ENTITY_ID_SPACE_MAX;
			reportStartupWarning(fmt::format(
				"clientMaxEntityId = {} is above the 24-bit wire ceiling ({}); using {}.",
				configured, CLIENT_ENTITY_ID_SPACE_MAX, space));
		} else {
			space = configured;
		}

		const uint32_t usable = space - 1; // id16 0 is the "none" sentinel
		const uint32_t reserveCeiling = usable / ENTITY_ID_RESERVE_MAX_FRACTION;

		// Projectiles are the only class with a floor: every other exhaustion
		// explains itself on screen, this one just silently does not fire.
		const uint32_t requested =
			static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::ENTITY_ID_RESERVE_PROJECTILES)));
		const bool autoSized = (requested == 0);
		const uint32_t perShooter = worstCaseProjectilesPerShooter();
		const uint32_t shooters = std::min<uint32_t>(
			static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::MAX_PLAYERS))),
			PROTOCOL_MAX_PLAYER_ID);

		uint32_t projectileReserve = autoSized ? shooters * perShooter : requested;
		const bool clamped = projectileReserve > reserveCeiling;
		if (clamped) {
			projectileReserve = reserveCeiling;
		}

		uint32_t reserve[ENTITY_CLASS_COUNT]{};
		uint32_t cap[ENTITY_CLASS_COUNT]{};
		reserve[static_cast<size_t>(EntityClass::Projectile)] = projectileReserve;
		cap[static_cast<size_t>(EntityClass::Object)] =
			static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::ENTITY_ID_CAP_OBJECTS)));
		cap[static_cast<size_t>(EntityClass::Loot)] =
			static_cast<uint32_t>(std::max(0, getNumber(ConfigManager::ENTITY_ID_CAP_LOOT)));

		EntityIdPool& pool = g_game.map.getEntityIdPool();
		pool.configure(space, reserve, cap);

		fmt::print(">> Entity id pool: {} ids shared by every class ({} usable, id 0 reserved)\n",
			space, usable);
		fmt::print(">>   projectile reserve {:>6}  ({}, {} players x {} in flight{})\n",
			projectileReserve, autoSized ? "auto" : "config.lua",
			shooters, perShooter, clamped ? ", CLAMPED" : "");
		for (const EntityClass klass : {EntityClass::Object, EntityClass::Loot}) {
			const uint32_t limit = pool.capOf(klass);
			fmt::print(">>   {:<11} cap {:>6}\n", entityClassName(klass),
				limit == 0 ? std::string("none") : std::to_string(limit));
		}
		fmt::print(">>   shared          {:>6}  (first come, first served)\n", pool.sharedTotal());

		// --- Demand, against the space above ---------------------------------
		//
		// Lives on Game because the map can now be resized at runtime, and the
		// admin doing it needs exactly this report against the NEW size -- not
		// only the one printed at boot.
		g_game.reportMapIdBudget();
	}

	void mainLoader(ServiceManager* services)
	{
		// dispatcher thread
		g_game.setGameState(GAME_STATE_STARTUP);

		srand(static_cast<unsigned int>(OTSYS_TIME()));

		printServerVersion();

		// check if config.lua or config.lua.dist exist
		const std::string& configFile = getString(ConfigManager::CONFIG_FILE);
		std::ifstream c_test("./" + configFile);
		if (!c_test.is_open()) {
			std::ifstream config_lua_dist("./config.lua.dist");
			if (config_lua_dist.is_open()) {
				std::cout << ">> copying config.lua.dist to " << configFile << std::endl;
				std::ofstream config_lua(configFile);
				config_lua << config_lua_dist.rdbuf();
				config_lua.close();
				config_lua_dist.close();
			}
		}
		else {
			c_test.close();
		}

		// read global config
		std::cout << ">> Loading config" << std::endl;
		if (!ConfigManager::load()) {
			startupErrorMessage("Unable to load " + configFile + "!");
			return;
		}

		// Owns the live name/type/location/visibility/player cap from here on.
		ServerInfo::init();

		// Re-seed now that config is readable (the srand above runs before the
		// config exists, so it can only ever be time-based).
		//
		// A non-zero `seed` pins world generation, and that is what makes an
		// A/B benchmark mean anything: resource spawn counts come from rand() (resource.cpp
		// picks totalMin + rand() % range, then jitters each cluster), so every
		// restart builds a different world. Measured across three runs the
		// entity count at zero players was 5805, 8722 and 9038 -- a 55% spread.
		// Visibility cost scales with entities in view, so two builds compared
		// across a restart differ by more from that spread than from any code
		// change, and the comparison silently measures the wrong thing.
		//
		// seed = 0 (or "random") still gets a seed, just an unpredictable one
		// drawn from the clock rather than a pinned one. Play is identical either
		// way, but the number is now RECORDED, which is what lets !seed report the
		// world an admin is standing in and !seed=<n> rebuild it later.
		{
			const bool pinned = isWorldSeedPinned();
			const uint32_t seed = rollWorldSeed();
			seedRandomGenerator(seed);
			std::cout << (pinned ? ">> Deterministic world: seed = "
			                     : ">> World seed (from the clock): ")
			          << seed << std::endl;
		}

		// ConfigManager only parses the string; nothing converted it to the enum
		// the server reads, so every world was pvp regardless of the setting.
		// A typo warns -- silently shipping a no-pvp server as pvp is the one
		// failure that matters here.
		{
			const std::string& wt = getString(ConfigManager::WORLD_TYPE);
			if (wt == "no-pvp") {
				g_game.setWorldType(WORLD_TYPE_NO_PVP);
			} else {
				if (wt != "pvp") {
					reportStartupWarning(fmt::format(
						"unknown worldType \"{}\"; valid values are \"pvp\" and \"no-pvp\". "
						"Falling back to pvp.", wt));
				}
				g_game.setWorldType(WORLD_TYPE_PVP);
			}
			fmt::print(">> World type: {}\n",
				g_game.isPvpEnabled() ? "pvp (players can damage each other)"
				                      : "no-pvp (players cannot damage each other; raiding still allowed)");
		}

		if (getBoolean(ConfigManager::USE_DATABASE)) {
			std::cout << ">> Establishing database connection..." << std::flush;

			if (!Database::getInstance().connect()) {
				startupErrorMessage("Failed to connect to database. Set useDatabase = false in config.lua to run without one.");
				return;
			}

			std::cout << " MySQL " << Database::getClientVersion() << std::endl;

			// The async DB worker needs the loaded config credentials, so it
			// must start here — not in startServer(), where it used to connect
			// before config.lua was read and always failed (the "Access denied
			// (using password: NO)" line every boot).
			g_databaseTasks.start();

			IOBan::ensureIpBanTable();

			// useDatabase = true is the full account system, which is useless
			// without the key to check tickets with -- refuse rather than run
			// guest-only while claiming accounts.
			if (!AccountTicket::setPublicKey(getString(ConfigManager::ACCOUNT_PUBLIC_KEY))) {
				startupErrorMessage("useDatabase = true needs accountPublicKey (GET /api/account/public-key on the web host, or npm run setup).");
				return;
			}
			if (getString(ConfigManager::LISTING_ID).empty()) {
				startupErrorMessage("useDatabase = true needs listingId: account tickets are issued for one server id.");
				return;
			}
			std::cout << ">> Account logins enabled for server id '"
			          << ticketServerId(ServerInfo::getListingId(), ServerInfo::getPublicHost(), ServerInfo::getPublicPort())
			          << "'" << std::endl;
		} else {
			std::cout << ">> Database disabled (useDatabase = false): guests only; bans are in-memory and reset on restart." << std::endl;
		}

		try {
			std::cout << ">> Initializing gamestate" << std::endl;
			g_game.setGameState(GAME_STATE_INIT);

			if (!loadContentFiles()) {
				return;
			}

			contentexport::ContentManager::getInstance().init(
				getString(ConfigManager::CONTENT_PATH),
				getString(ConfigManager::CONFIG_FILE));


			if (!getBoolean(ConfigManager::CONNECT_THROTTLE)) {
				fmt::print("\n");
				fmt::print("!! ============================================================ !!\n");
				fmt::print("!!  CONNECT THROTTLE DISABLED (connectThrottle = false)\n");
				fmt::print("!!  Every IP may open connections at any rate. This exists so a\n");
				fmt::print("!!  local stress fleet can ramp instantly and is NOT safe facing\n");
				fmt::print("!!  the internet.\n");
				fmt::print("!!  If this is a production server, set connectThrottle = true in\n");
				fmt::print("!!  config.lua and restart.\n");
				fmt::print("!! ============================================================ !!\n");
				fmt::print("\n");
			}

			// Game client protocols
			services->add<ProtocolGame>(static_cast<uint16_t>(getNumber(ConfigManager::GAME_PORT)));

			// OT protocols
			services->add<ProtocolStatus>(static_cast<uint16_t>(getNumber(ConfigManager::STATUS_PORT)));

#ifdef HTTP
			// HTTP server
			tfs::http::start(getBoolean(ConfigManager::BIND_ONLY_GLOBAL_ADDRESS), getString(ConfigManager::IP),
				getNumber(ConfigManager::HTTP_PORT), getNumber(ConfigManager::HTTP_WORKERS));
#endif

#ifndef _WIN32
			if (getuid() == 0 || geteuid() == 0) {
				std::cout << "> Warning: " << STATUS_SERVER_NAME
					<< " has been executed as root user, please consider running it as a normal user." << std::endl;
			}
#endif

			// Must run before anything spawns -- g_game.start() generates the
			// world below -- and after the content it sizes itself against is
			// loaded. This is the only point that satisfies both.
			configureEntityIdPool();

			g_game.start(services);
			// A configured scenario that cannot run in full never opens: no
			// port is serving yet, so no player can join a partial world.
			if (!g_game.getStartupFailure().empty()) {
				services->abandon();
				startupErrorMessage(g_game.getStartupFailure());
				return;
			}

			// After start(), which is where the rest of the content loads.
			verifyContentManifest();

			// Last: g_game.start() loads structures, status effects and modes,
			// so this is the first point where every data file has been seen.
			if (const uint32_t warnings = startupWarningCount(); warnings != 0) {
				fmt::print(fg(fmt::color::yellow), ">> Startup finished with {} warning(s) (listed above).\n", warnings);
			} else {
				std::cout << ">> Startup finished, no warnings." << std::endl;
			}

			g_game.setGameState(GAME_STATE_NORMAL);

			// After NORMAL: the first beat reports the state players will find.
			ServerListing::start();

			g_loaderSignal.notify_all();
		} catch (const std::exception& e) {
			fmt::print(fg(fmt::color::red) | fmt::emphasis::bold, ">> [STARTUP CRASH EXCEPTION]: {}\n", e.what());
			return;
		} catch (...) {
			fmt::print(fg(fmt::color::red) | fmt::emphasis::bold, ">> [STARTUP UNKNOWN CRASH EXCEPTION]\n");
			return;
		}
	}

	// --- Content validation ---------------------------------------------------
	//
	// The same load sequence as a boot, stopping before anything that needs a
	// port, a database or a world. It exists because checking a content edit
	// used to mean starting the real server and reading the log: that binds
	// 7172/7171/8080 and generates a 150x150 world to answer a question about a
	// text file, so it could not run on a machine already hosting a server, nor
	// anywhere without one.
	//
	// It deliberately reuses loadContentFiles() and Game::loadContentDefinitions()
	// rather than listing the files again -- a second list would drift from the
	// boot one, and a checker that validates a different set of files than the
	// server loads is worse than no checker.
	int runContentValidation()
	{
		fmt::print(">> Validating content (no world, no network)\n");

		const std::string& configFile = getString(ConfigManager::CONFIG_FILE);
		if (!ConfigManager::load()) {
			fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold,
				">> ERROR: unable to load {}\n", configFile);
			return 1;
		}
		fmt::print(">> Content path: {}\n", getString(ConfigManager::CONTENT_PATH));

		if (!loadContentFiles()) {
			return 1;
		}

		// NPC, progress and quest loaders say what is wrong and then throw; an
		// uncaught throw aborted the process with that explanation still in
		// the output buffer, so a broken quest looked like a crash.
		try {
			g_game.loadContentDefinitions();
		} catch (const std::exception& e) {
			fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, ">> ERROR: {}\n", e.what());
			std::fflush(stdout);
			return 1;
		}

		// Everything is loaded by now, so the manifest can be checked against it.
		verifyContentManifest();

		// After loadContentDefinitions, not before it as at boot: the boot call
		// site is pinned earlier by "must run before anything spawns", and there
		// is nothing to spawn here. Running it once MapSize has read config.lua
		// is what makes the map dimensions in the report the real ones.
		configureEntityIdPool();

		const uint32_t warnings = startupWarningCount();
		if (warnings != 0) {
			fmt::print(fg(fmt::color::yellow),
				">> Content check finished with {} warning(s) (listed above).\n", warnings);
			return 1;
		}
		fmt::print(fg(fmt::color::green), ">> Content check passed, no warnings.\n");
		return 0;
	}

	[[noreturn]] void badAllocationHandler()
	{
		// Use functions that only use stack allocation
		puts("Allocation failed, server out of memory.\nDecrease the size of your map or compile in 64 bits mode.\n");
		getchar();
		exit(-1);
	}

} // namespace


#ifdef _WIN32
namespace {

/**
 * Raises the Windows scheduler tick to 1 ms for the process lifetime.
 *
 * Windows' default timer granularity is 15.625 ms, and boost::asio's
 * steady_timer rounds UP to it. The 50 ms game tick therefore actually fired
 * every ~62.5 ms (4 x 15.625), i.e. 16 Hz instead of the intended 20 Hz --
 * measured at 15.5-16.2 ticks/s even on a completely idle server. Because
 * movement applies a FIXED distance per tick (MOVEMENT_TICKS_PER_SEC), that
 * shortfall made every player walk at ~80% of their configured speed at ALL
 * times, load or no load. With a 1 ms period the 50 ms timer lands on 50 ms.
 */
class TimerResolutionGuard
{
public:
	TimerResolutionGuard()
	{
		TIMECAPS caps{};
		if (timeGetDevCaps(&caps, sizeof(caps)) == MMSYSERR_NOERROR) {
			period = std::max<UINT>(caps.wPeriodMin, 1);
			active = (timeBeginPeriod(period) == TIMERR_NOERROR);
		}
	}

	~TimerResolutionGuard()
	{
		if (active) {
			timeEndPeriod(period);
		}
	}

	bool isActive() const { return active; }
	UINT getPeriod() const { return period; }

private:
	UINT period = 1;
	bool active = false;
};

} // namespace
#endif

void startServer()
{
	// Setup bad allocation handler
	std::set_new_handler(badAllocationHandler);

#ifdef _WIN32
	// Must outlive the service loop: destroying it restores the coarse system
	// timer, so it is scoped to the whole server run.
	TimerResolutionGuard timerResolution;
	if (timerResolution.isActive()) {
		fmt::print(">> System timer resolution set to {}ms (game tick can now hit 20Hz)\n",
		           timerResolution.getPeriod());
	} else {
		fmt::print(">> [Warning] Could not raise system timer resolution; "
		           "the 50ms game tick may run at ~16Hz and players will move slower.\n");
	}
#endif

	ServiceManager serviceManager;

	g_dispatcher.start();
	g_scheduler.start();
	// g_databaseTasks starts in mainLoader, after config.lua is loaded and
	// only when useDatabase is enabled; shutdown/join below are safe no-ops
	// when it never started.

	g_dispatcher.addTask([services = &serviceManager]() { mainLoader(services); });

	g_loaderSignal.wait(g_loaderUniqueLock);

	if (serviceManager.is_running()) {
		std::cout << ">> " << getString(ConfigManager::SERVER_NAME) << " Server Online!" << std::endl << std::endl;
		serviceManager.run();
	}
	else {
		std::cout << ">> No services running. The server is NOT online." << std::endl;
	}

	// Before the scheduler stops: this cancels its own repeating event.
	ServerListing::stop();

	g_scheduler.shutdown();
	g_dispatcher.shutdown();
	g_databaseTasks.shutdown();

	g_scheduler.join();
	g_dispatcher.join();
	g_databaseTasks.join();
}

int validateContent()
{
	return runContentValidation();
}

int validateScenario(const std::string& file)
{
	std::ifstream in(file, std::ios::binary);
	if (!in) {
		fmt::print(fg(fmt::color::crimson), ">> ERROR: cannot read {}\n", file);
		return 2;
	}
	std::ostringstream text;
	text << in.rdbuf();

	scenario::ParseResult result = scenario::parseProject(text.str());
	if (result.project) {
		// Content resolution needs the same content a boot would load. Its own
		// warnings are --validate's business; here only a failure to load counts.
		if (!ConfigManager::load() || !loadContentFiles()) return 1;
		try {
			g_game.loadContentDefinitions();
		} catch (const std::exception& e) {
			fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, ">> ERROR: {}\n", e.what());
			return 1;
		}
		for (scenario::Diagnostic& d : scenario::compileCheck(*result.project)) result.diagnostics.push_back(std::move(d));
	}

	size_t errors = 0;
	for (const scenario::Diagnostic& d : result.diagnostics) {
		errors += d.severity == scenario::Severity::Error;
		const auto colour = d.severity == scenario::Severity::Error ? fmt::color::crimson
			: d.severity == scenario::Severity::Warning ? fmt::color::yellow : fmt::color::light_gray;
		fmt::print(fg(colour), "{} {} {}{}{}\n", scenario::severityName(d.severity), d.code, d.path.empty() ? "" : d.path + ": ",
			d.message, d.target.empty() ? "" : fmt::format(" [{}]", d.target));
	}
	if (errors) {
		fmt::print(fg(fmt::color::crimson), ">> {}: {} error(s); this project cannot run.\n", file, errors);
		return 1;
	}
	const scenario::Project& p = *result.project;
	fmt::print(fg(fmt::color::green), ">> {}: \"{}\" {}x{} tiles, {} placements, {} groups, {} regions, {} templates\n",
		file, p.title, p.world.tilesX, p.world.tilesY, p.entities.size(), p.groups.size(), p.regions.size(), p.templates.size());
	fmt::print(">> gameplay hash {}\n", result.gameplayHash);
	return 0;
}

void printServerVersion()
{
#if defined(GIT_RETRIEVED_STATE) && GIT_RETRIEVED_STATE
	std::cout << STATUS_SERVER_NAME << " - Version " << GIT_DESCRIBE << std::endl;
	std::cout << "Git SHA1 " << GIT_SHORT_SHA1 << " dated " << GIT_COMMIT_DATE_ISO8601 << std::endl;
#if GIT_IS_DIRTY
	std::cout << "*** DIRTY - NOT OFFICIAL RELEASE ***" << std::endl;
#endif
#else
	std::cout << STATUS_SERVER_NAME << " - Version " << STATUS_SERVER_VERSION << std::endl;
#endif
	std::cout << std::endl;

	std::cout << "Compiled with " << BOOST_COMPILER << std::endl;
	std::cout << "Compiled on " << __DATE__ << ' ' << __TIME__ << " for platform ";
#if defined(__amd64__) || defined(_M_X64)
	std::cout << "x64" << std::endl;
#elif defined(__i386__) || defined(_M_IX86) || defined(_X86_)
	std::cout << "x86" << std::endl;
#elif defined(__arm__)
	std::cout << "ARM" << std::endl;
#else
	std::cout << "unknown" << std::endl;
#endif
#if defined(LUAJIT_VERSION)
	std::cout << "Linked with " << LUAJIT_VERSION << " for Lua support" << std::endl;
#else
	std::cout << "Linked with " << LUA_RELEASE << " for Lua support" << std::endl;
#endif
	std::cout << std::endl;

	std::cout << "A server developed by " << STATUS_SERVER_DEVELOPERS << std::endl;
	std::cout << std::endl;
}

int exportContent(const std::string& outDir)
{
	try {
		if (!ConfigManager::load()) return 1;
		const std::string xmlDir = contentFile("");
		return contentexport::exportAll(xmlDir, outDir) ? 0 : 1;
	} catch (const std::exception& error) {
		fmt::print(">> [Error] {}\n", error.what());
		return 1;
	}
}
