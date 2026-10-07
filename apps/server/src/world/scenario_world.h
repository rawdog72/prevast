// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_WORLD_H
#define FS_SCENARIO_WORLD_H

// Running a World & Mode Editor project as the world, at startup, in the
// profile whose config.lua names it (`scenarioFile = "..."`). The project is
// parsed, validated and compiled by the same code as --validate-scenario, and a
// project that cannot run in full is refused before any port opens: there is no
// partially loaded scenario for a player to join.
//
// Population is explicit: an authored map holds what was placed and nothing
// else, unless the project opts into generated structures, resources or
// roaming creatures (world.population).

#include "content/scenario_project.h"

#include <cstdint>
#include <optional>
#include <string>

namespace scenario {

struct ActiveScenario
{
	Project project;
	std::string file;
	std::string gameplayHash;
};

// Reads config.lua's scenarioFile. Returns true with `out` empty when none is
// configured; false with `error` set when one is configured but cannot run
// here (invalid, missing content, or a feature this build does not implement).
// Needs content definitions loaded.
bool loadConfigured(std::optional<ActiveScenario>& out, std::string& error);

struct PopulateReport
{
	uint32_t objects = 0;
	uint32_t resources = 0;
	uint32_t expected = 0;
};

// Places every authored placement, inside world generation (so generated
// resources, when opted in, never take an authored tile). All or nothing: on
// any failure returns false with `error` naming the first placement that could
// not be realized, and the caller must not open the world.
bool populate(const ActiveScenario& scenario, PopulateReport& report, std::string& error);

} // namespace scenario

#endif // FS_SCENARIO_WORLD_H
