// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/scenarios/scenario_runtime.h"

#include "gameplay/game.h"

extern Game g_game;

namespace scenario {

Runtime g_scenarioRuntime;

void Runtime::begin(const ActiveScenario& active)
{
	reset();
	scenario = &active;
}

void Runtime::notePlaced(const std::string& entityId, uint32_t thingId)
{
	placed[entityId] = thingId;
}

void Runtime::finish()
{
	if (!scenario) return;
	regionIndex.build(scenario->project, [this](const std::string& entityId) { return present(entityId); });
	spawns.clear();
	for (const Entity& e : scenario->project.entities)
		if (e.kind == EntityKind::Spawn) spawns.push_back(&e);
}

void Runtime::reset()
{
	scenario = nullptr;
	placed.clear();
	regionIndex.clear();
	spawns.clear();
}

uint32_t Runtime::thingOf(const std::string& entityId) const
{
	const auto it = placed.find(entityId);
	return it == placed.end() ? 0 : it->second;
}

bool Runtime::present(const std::string& entityId) const
{
	const auto it = placed.find(entityId);
	if (it == placed.end()) return true;
	return g_game.map.getThingByID(it->second) != nullptr;
}

std::optional<bool> Runtime::permission(PermissionKind kind, const Position& at) const
{
	if (!scenario || regionIndex.empty()) return std::nullopt;
	return regionIndex.permissionAt(kind, at.x, at.y);
}

StatRates Runtime::gaugeRates(const Position& at) const
{
	if (!scenario || regionIndex.empty()) return {};
	return regionIndex.ratesAt(at.x, at.y);
}

} // namespace scenario
