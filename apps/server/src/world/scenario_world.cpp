// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "world/scenario_world.h"

#include "content/configmanager.h"
#include "content/scenario_compile.h"
#include "core/definitions.h"
#include "gameplay/game.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "gameplay/scenarios/scenario_population.h"
#include "gameplay/scenarios/scenario_runtime.h"
#include "world/mapsize.h"
#include "world/worldgen.h"

#include <filesystem>
#include <fmt/color.h>
#include <fmt/format.h>
#include <fstream>
#include <sstream>
#include <unordered_set>

extern Game g_game;

namespace scenario {

bool loadConfigured(std::optional<ActiveScenario>& out, std::string& error)
{
	out.reset();
	const std::string& file = ConfigManager::getString(ConfigManager::SCENARIO_FILE);
	if (file.empty()) return true;

	std::ifstream in(file, std::ios::binary);
	if (!in) {
		error = fmt::format("scenarioFile \"{}\" cannot be read (paths are relative to the profile directory).", file);
		return false;
	}
	std::ostringstream text;
	text << in.rdbuf();

	ParseResult result = parseProject(text.str());
	if (result.project)
		for (Diagnostic& d : compileCheck(*result.project)) result.diagnostics.push_back(std::move(d));

	// A server that cannot run a required feature refuses the project instead
	// of running some other world under its name.
	for (Diagnostic& d : result.diagnostics)
		if (d.code == "feature.unsupported") d.severity = Severity::Error;

	size_t errors = 0;
	for (const Diagnostic& d : result.diagnostics) {
		if (d.severity != Severity::Error) continue;
		++errors;
		fmt::print(fg(fmt::color::crimson), ">> [scenario] {} {}{}{}\n", d.code, d.path.empty() ? "" : d.path + ": ", d.message,
			d.target.empty() ? "" : fmt::format(" [{}]", d.target));
	}
	if (errors) {
		error = fmt::format("scenario \"{}\" has {} error(s) and cannot run (listed above).", file, errors);
		return false;
	}

	ActiveScenario active{ std::move(*result.project), file, result.gameplayHash };
	std::string sizeError;
	if (!MapSize::apply(active.project.world.tilesX, active.project.world.tilesY, sizeError)) {
		error = fmt::format("scenario \"{}\": {}", file, sizeError);
		return false;
	}
	fmt::print(">> Scenario \"{}\" ({}): {}x{} tiles, {} placements, gameplay hash {}\n", active.project.title, file,
		active.project.world.tilesX, active.project.world.tilesY, active.project.entities.size(), active.gameplayHash.substr(0, 16));
	out = std::move(active);
	return true;
}

namespace {

// Tiles a placement may clear, once per pass: a tile legitimately takes a floor
// and the piece on it, and clearing again would delete the first.
class TileClaims
{
public:
	void clearOnce(int32_t tileX, int32_t tileY)
	{
		if (claimed.insert(static_cast<int64_t>(tileY) * 1024 + tileX).second) {
			if (worldgen::isActive()) worldgen::claimTile(tileX, tileY);
			g_game.clearTile(g_game.tileCenterPosition(tileX, tileY));
		}
	}

private:
	std::unordered_set<int64_t> claimed;
};

bool placeObject(const Entity& e, TileClaims& claims, std::string& error)
{
	const ObjectData* od = g_objects.getObjectData(e.ref);
	if (!od) {
		error = fmt::format("placement \"{}\": object \"{}\" is not loaded", e.id, e.ref);
		return false;
	}
	const int32_t tileX = e.x / TILE_SIZE;
	const int32_t tileY = e.y / TILE_SIZE;
	claims.clearOnce(tileX, tileY);
	const Position pos = g_game.tileCenterPosition(tileX, tileY);
	if (!g_game.map.getEntityIdPool().canAcquire(EntityClass::Object)) {
		error = fmt::format("placement \"{}\": the entity id pool is exhausted", e.id);
		return false;
	}
	Object* obj = g_objects.createObject(od->key, pos, e.rotation.value_or(0));
	if (!obj) {
		error = fmt::format("placement \"{}\": \"{}\" could not be created", e.id, e.ref);
		return false;
	}
	if (e.variant) obj->setSubtype(*e.variant, /*fixed=*/true);
	const Overrides& o = e.overrides;
	if (o.healthMax) obj->setMaxHealthOverride(*o.healthMax);
	obj->setHealth(o.health.value_or(obj->getMaxHealth()));
	if (o.destructible && !*o.destructible) obj->setIndestructible(true);
	if (o.doorOpen && *o.doorOpen) obj->isDoorOpen = true;
	if (!g_game.placeThing(obj, pos)) {
		delete obj;
		error = fmt::format("placement \"{}\": \"{}\" could not be placed at tile {},{}", e.id, e.ref, tileX, tileY);
		return false;
	}
	g_scenarioRuntime.notePlaced(e.id, obj->getID());
	fillContainer(e, obj);
	return true;
}

bool placeResource(const Entity& e, TileClaims& claims, std::string& error)
{
	const int32_t tileX = e.x / TILE_SIZE;
	const int32_t tileY = e.y / TILE_SIZE;
	claims.clearOnce(tileX, tileY);
	const Position pos = g_game.tileCenterPosition(tileX, tileY);
	Resource* res = g_resources.createResource(e.ref, e.variant.value_or(0), pos, e.angle.value_or(0));
	if (!res) {
		error = fmt::format("placement \"{}\": resource \"{}\" could not be created (entity ids exhausted?)", e.id, e.ref);
		return false;
	}
	if (!g_game.internalPlaceThing(res, pos)) {
		delete res;
		error = fmt::format("placement \"{}\": resource \"{}\" could not be placed at tile {},{}", e.id, e.ref, tileX, tileY);
		return false;
	}
	g_scenarioRuntime.notePlaced(e.id, res->getID());
	return true;
}

} // namespace

bool populate(const ActiveScenario& scenario, PopulateReport& report, std::string& error)
{
	g_scenarioRuntime.begin(scenario);
	resetPopulation(scenario);
	TileClaims claims;
	// Floors first, so the piece standing on a floor never has its tile cleared
	// after it arrived.
	std::vector<const Entity*> order;
	for (const Entity& e : scenario.project.entities)
		if (e.kind == EntityKind::Object || e.kind == EntityKind::Resource) order.push_back(&e);
	std::stable_sort(order.begin(), order.end(), [](const Entity* a, const Entity* b) {
		auto rank = [](const Entity* e) {
			if (e->kind != EntityKind::Object) return 1;
			const ObjectData* od = g_objects.getObjectData(e->ref);
			return od && (od->category == ObjectCategory::Floor || od->category == ObjectCategory::Road) ? 0 : 1;
		};
		return rank(a) < rank(b);
	});
	report.expected = static_cast<uint32_t>(order.size());
	for (const Entity* e : order) {
		const bool ok = e->kind == EntityKind::Object ? placeObject(*e, claims, error) : placeResource(*e, claims, error);
		if (!ok) return false;
		if (e->kind == EntityKind::Object) ++report.objects;
		else ++report.resources;
	}
	if (report.objects + report.resources != report.expected) {
		error = fmt::format("placed {} of {} placements", report.objects + report.resources, report.expected);
		return false;
	}
	placeNpcs(scenario);
	g_scenarioRuntime.finish();
	return true;
}

} // namespace scenario
