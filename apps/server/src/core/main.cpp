// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "core/prevast_server.h"

#include "network/account_ticket.h"
#include "network/login_identity.h"
#include "network/disconnect_reason.h"
#include "gameplay/progress/game_event.h"
#include "gameplay/quests/quest_selftest.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/scripts/lua_script.h"
#include "gameplay/scripts/script_system.h"
#include "content/scenario_project.h"
#include "gameplay/scenarios/scenario_population.h"
#include "gameplay/scenarios/scenario_regions.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/aim_view.h"
#include "gameplay/loot_placement.h"

#include <filesystem>

namespace {

void printUsage(const char* exeName)
{
	std::cout << "Usage: " << exeName << " [option]\n\n"
		"  (no option)   run the server\n"
		"  --validate    load config.lua and every content file, report any problem\n"
		"                and exit 1 if there was one. Binds no port and builds no\n"
		"                world, so it can run while a server is already up.\n"
		"  --export-content <dir>  export content JSON and exit\n"
		"  --validate-scenario <file>  validate a World Editor project (.prevast.json)\n"
		"                against this server's content and print its gameplay hash\n"
		"  --selftest <dir>  verify the account-ticket fixtures in <dir>, the\n"
		"                login-identity helpers, the event bus, quests and the\n"
		"                scenario corpus (<dir>/../scenarios) and weapon mods\n"
		"                (<dir>/../weapon-mods), then exit\n"
		"  --help        this text\n";
}

} // namespace

int main(int argc, char* argv[])
{
	for (int i = 1; i < argc; ++i) {
		const std::string_view arg = argv[i];
		if (arg == "--validate" || arg == "--check") {
			return validateContent();
		}
		if (arg == "--export-content") {
			if (i + 2 != argc || std::string_view(argv[i + 1]).empty() || std::string_view(argv[i + 1]).substr(0, 2) == "--") {
				std::cout << "--export-content needs one output directory\n";
				return 2;
			}
			return exportContent(argv[i + 1]);
		}
		if (arg == "--validate-scenario") {
			if (i + 2 != argc) {
				std::cout << "--validate-scenario needs one project file\n";
				return 2;
			}
			return validateScenario(argv[i + 1]);
		}
		if (arg == "--selftest") {
			if (i + 2 != argc) {
				std::cout << "--selftest needs the fixture directory\n";
				return 2;
			}
			const int tickets = AccountTicket::runSelfTest(argv[i + 1]);
			const int identity = runLoginIdentitySelfTest();
			const int disconnect = runDisconnectReasonSelfTest();
			const int events = runEventBusSelfTest();
			const int quests = runQuestSelfTest();
			const int progress = runProgressSelfTest();
			const int lua = runLuaScriptSelfTest();
			const int intents = runScriptIntentSelfTest();
			// The scenario corpus sits beside the account fixtures (tests/fixtures).
			const int scenarios = scenario::runScenarioSelfTest(
				(std::filesystem::path(argv[i + 1]).parent_path() / "scenarios").string());
			const int regions = scenario::runRegionSelfTest();
			const int population = scenario::runPopulationSelfTest();
			// The weapon-mod resolver cases sit beside the account fixtures too.
			const int weaponMods = weapon_mods::runSelfTest(
				(std::filesystem::path(argv[i + 1]).parent_path() / "weapon-mods").string());
			// The view-box cases sit beside the resolver cases.
			const int aimView = aim_view::runSelfTest(
				(std::filesystem::path(argv[i + 1]).parent_path() / "weapon-mods").string());
			const int lootPlacement = loot_placement::runSelfTest();
			return tickets != 0 || identity != 0 || disconnect != 0 || events != 0 || quests != 0 || progress != 0 || lua != 0 || intents != 0 || scenarios != 0 || regions != 0 || population != 0 || weaponMods != 0 || aimView != 0 || lootPlacement != 0 ? 1 : 0;
		}
		if (arg == "--help" || arg == "-h") {
			printUsage(argv[0]);
			return 0;
		}
		std::cout << "Unknown option '" << arg << "'\n\n";
		printUsage(argv[0]);
		return 2;
	}

	startServer();
	return 0;
}
