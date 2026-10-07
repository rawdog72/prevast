// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_RUNTIME_H
#define FS_SCENARIO_RUNTIME_H

// What a running scenario keeps between ticks: which runtime thing each
// authored placement became, its regions, and (scenario_population.h) the
// populations it owns. Game systems ask it narrow questions -- may this player
// build here, what do the regions do to a gauge here -- and get "no opinion"
// whenever no scenario is running, so ordinary worlds behave exactly as before.

#include "gameplay/scenarios/scenario_regions.h"
#include "world/scenario_world.h"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

struct Position;

namespace scenario {

class Runtime
{
public:
	bool active() const { return scenario != nullptr; }
	const ActiveScenario* current() const { return scenario; }

	// World (re)building: begin before the first placement, notePlaced for each
	// one realized, finish once all are in.
	void begin(const ActiveScenario& active);
	void notePlaced(const std::string& entityId, uint32_t thingId);
	void finish();
	void reset();

	// The runtime thing a placement became; 0 when none (or not yet).
	uint32_t thingOf(const std::string& entityId) const;
	// Still in the world: a placement that was never a thing (a spawn point)
	// counts as present.
	bool present(const std::string& entityId) const;

	const RegionIndex& regions() const { return regionIndex; }
	// The project's player spawn points, in document order.
	const std::vector<const Entity*>& spawnPoints() const { return spawns; }

	// std::nullopt = no region has an opinion here; use the world's rule.
	std::optional<bool> permission(PermissionKind kind, const Position& at) const;
	StatRates gaugeRates(const Position& at) const;

private:
	const ActiveScenario* scenario = nullptr;
	std::unordered_map<std::string, uint32_t> placed;
	RegionIndex regionIndex;
	std::vector<const Entity*> spawns;
};

extern Runtime g_scenarioRuntime;

} // namespace scenario

#endif // FS_SCENARIO_RUNTIME_H
