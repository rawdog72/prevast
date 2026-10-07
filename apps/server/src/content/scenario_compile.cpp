// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "content/scenario_compile.h"

#include "core/definitions.h"
#include "gameplay/agent.h"
#include "gameplay/item.h"
#include "gameplay/npc.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "gameplay/scenarios/scenario_regions.h"

#include <fmt/format.h>
#include <unordered_map>
#include <unordered_set>

namespace scenario {
namespace {

void error(std::vector<Diagnostic>& out, std::string code, std::string path, std::string message, std::string target)
{
	out.push_back({ Severity::Error, std::move(code), std::move(path), std::move(message), std::move(target) });
}

// An item stack must name a real item and fit in one inventory stack.
void checkStack(const ItemStack& stack, const std::string& path, const std::string& target, std::vector<Diagnostic>& out)
{
	const ItemData* data = ItemManager::getInstance().getItemData(stack.item);
	if (!data) {
		error(out, "content.missing", path + ".item", fmt::format("\"{}\" is not an item on this server.", stack.item), target);
		return;
	}
	const uint32_t most = std::max<uint32_t>(1, data->stack);
	if (stack.count > most)
		error(out, "item.count", path + ".count", fmt::format("\"{}\" stacks to {}; {} do not fit one slot.", stack.item, most, stack.count), target);
}

bool isFloorSlot(const ObjectData& od)
{
	return od.category == ObjectCategory::Floor || od.category == ObjectCategory::Road;
}

void checkEntities(const std::vector<Entity>& entities, const std::string& prefix, std::vector<Diagnostic>& out)
{
	// tile key -> occupant id, per slot, so two solid pieces never share a tile.
	std::unordered_map<int64_t, std::string> floors;
	std::unordered_map<int64_t, std::string> solids;
	for (size_t i = 0; i < entities.size(); ++i) {
		const Entity& e = entities[i];
		const std::string path = fmt::format("{}entities[{}]", prefix, i);
		const int64_t tile = static_cast<int64_t>(e.y / TILE_SIZE) * 1024 + e.x / TILE_SIZE;
		switch (e.kind) {
		case EntityKind::Object: {
			const ObjectData* od = g_objects.getObjectData(e.ref);
			if (!od || od->isAbstract) {
				error(out, "content.missing", path + ".ref", fmt::format("\"{}\" is not an object on this server.", e.ref), e.id);
				break;
			}
			const Overrides& o = e.overrides;
			if ((o.healthMax || o.health || o.destructible) && od->healthMax == 0)
				error(out, "override.unsupported", path + ".overrides", fmt::format("\"{}\" has no health to override.", e.ref), e.id);
			if (e.container) {
				if (od->storageSlots == 0)
					error(out, "override.unsupported", path + ".container", fmt::format("\"{}\" holds no items.", e.ref), e.id);
				else if (e.container->fixed.size() > od->storageSlots)
					error(out, "container.slots", path + ".container.fixed",
						fmt::format("{} fixed items; \"{}\" has {} slots.", e.container->fixed.size(), e.ref, od->storageSlots), e.id);
				for (size_t k = 0; k < e.container->fixed.size(); ++k)
					checkStack(e.container->fixed[k], fmt::format("{}.container.fixed[{}]", path, k), e.id, out);
			}
			if (o.doorOpen && od->interaction != InteractionKind::Door)
				error(out, "override.unsupported", path + ".overrides.doorOpen", fmt::format("\"{}\" is not a door.", e.ref), e.id);
			const uint32_t max = o.healthMax.value_or(od->healthMax);
			if (o.health && *o.health > max)
				error(out, "override.range", path + ".overrides.health", fmt::format("Initial health {} exceeds the maximum {}.", *o.health, max), e.id);
			auto& slot = isFloorSlot(*od) ? floors : solids;
			auto [it, inserted] = slot.emplace(tile, e.id);
			if (!inserted)
				error(out, "placement.overlap", path, fmt::format("\"{}\" shares its tile with \"{}\".", e.id, it->second), e.id);
			break;
		}
		case EntityKind::Resource: {
			const ResourceData* rd = g_resources.getResourceData(e.ref);
			const uint8_t type = e.variant.value_or(0);
			const bool typeOk = rd && std::any_of(rd->types.begin(), rd->types.end(), [&](const ResourceType& t) { return t.id == type; });
			if (!typeOk) {
				error(out, "content.missing", path + ".ref", fmt::format("Resource \"{}\" type {} is not on this server.", e.ref, type), e.id);
				break;
			}
			auto [it, inserted] = solids.emplace(tile, e.id);
			if (!inserted)
				error(out, "placement.overlap", path, fmt::format("\"{}\" shares its tile with \"{}\".", e.id, it->second), e.id);
			break;
		}
		case EntityKind::Agent:
			if (!g_agents.getAgentData(e.ref))
				error(out, "content.missing", path + ".ref", fmt::format("Creature \"{}\" is not on this server.", e.ref), e.id);
			break;
		case EntityKind::Npc:
			if (!g_npcs.hasNpc(e.ref))
				error(out, "content.missing", path + ".ref", fmt::format("NPC \"{}\" is not on this server.", e.ref), e.id);
			break;
		case EntityKind::Spawn:
			if (e.ref != "player")
				error(out, "content.missing", path + ".ref", "Spawn points are \"player\" spawns.", e.id);
			if (e.loadout)
				for (size_t k = 0; k < e.loadout->size(); ++k)
					checkStack((*e.loadout)[k], fmt::format("{}.loadout[{}]", path, k), e.id, out);
			break;
		}
	}
}

void info(std::vector<Diagnostic>& out, std::string code, std::string path, std::string message, std::string target)
{
	out.push_back({ Severity::Info, std::move(code), std::move(path), std::move(message), std::move(target) });
}

void warning(std::vector<Diagnostic>& out, std::string code, std::string path, std::string message, std::string target)
{
	out.push_back({ Severity::Warning, std::move(code), std::move(path), std::move(message), std::move(target) });
}

// Static population checks: what the authored pieces and regions say about
// where people and creatures can stand. Static only -- a clear tile is not a
// proof that a level is playable (validation.ts in the editor says the same).
void checkPopulation(const Project& project, std::vector<Diagnostic>& out)
{
	const auto tileKey = [](int32_t tx, int32_t ty) { return static_cast<int64_t>(ty) * 1024 + tx; };
	std::unordered_set<int64_t> solid;
	for (const Entity& e : project.entities) {
		if (e.kind == EntityKind::Resource) {
			solid.insert(tileKey(e.x / TILE_SIZE, e.y / TILE_SIZE));
		} else if (e.kind == EntityKind::Object) {
			const ObjectData* od = g_objects.getObjectData(e.ref);
			if (od && !isFloorSlot(*od)) solid.insert(tileKey(e.x / TILE_SIZE, e.y / TILE_SIZE));
		}
	}
	RegionIndex regions;
	regions.build(project, nullptr);
	const int32_t tilesX = project.world.tilesX, tilesY = project.world.tilesY;

	size_t spawns = 0;
	for (size_t i = 0; i < project.entities.size(); ++i) {
		const Entity& e = project.entities[i];
		const std::string path = fmt::format("entities[{}]", i);
		const int32_t tx = e.x / TILE_SIZE, ty = e.y / TILE_SIZE;
		const bool blocked = solid.count(tileKey(tx, ty)) != 0;
		const std::string who = e.name.empty() ? e.id : e.name;
		switch (e.kind) {
		case EntityKind::Spawn:
			++spawns;
			if (blocked)
				warning(out, "spawn.blocked", path, fmt::format("Spawn \"{}\" stands on a solid piece.", who), e.id);
			if (regions.permissionAt(PermissionKind::Spawn, e.x, e.y) == false)
				error(out, "spawn.denied", path, fmt::format("Spawn \"{}\" is inside a region that denies spawning.", who), e.id);
			if (tx < 1 || ty < 1 || tx >= tilesX - 1 || ty >= tilesY - 1)
				warning(out, "spawn.edge", path, "Spawns on the outermost tiles are rejected by the server spawn check.", e.id);
			break;
		case EntityKind::Npc:
			if (blocked) warning(out, "npc.blocked", path, fmt::format("NPC \"{}\" stands on a solid piece.", who), e.id);
			break;
		case EntityKind::Agent:
			if (blocked)
				error(out, "agent.blocked", path, fmt::format("Creature \"{}\" stands on a solid piece; the server will not open.", who), e.id);
			break;
		default: break;
		}
	}
	if (spawns == 0)
		info(out, "spawn.none", "entities", "No player spawn placed: players use the server's default spawn search.", {});

	// A spawner needs at least one tile it could use. Bounded: stop at the
	// first free tile, and never look at more than a whole map's worth.
	for (size_t i = 0; i < project.regions.size(); ++i) {
		const Region& r = project.regions[i];
		const auto index = regions.indexOf(r.id);
		if (!r.spawner || !index) continue;
		int32_t minX, minY, maxX, maxY;
		regions.bounds(*index, minX, minY, maxX, maxY);
		bool room = false;
		for (int32_t ty = std::max(1, minY / TILE_SIZE); !room && ty <= std::min(tilesY - 2, maxY / TILE_SIZE); ++ty)
			for (int32_t tx = std::max(1, minX / TILE_SIZE); !room && tx <= std::min(tilesX - 2, maxX / TILE_SIZE); ++tx) {
				const int32_t cx = tx * TILE_SIZE + TILE_SIZE / 2, cy = ty * TILE_SIZE + TILE_SIZE / 2;
				room = regions.contains(*index, cx, cy) && !solid.count(tileKey(tx, ty)) &&
				       regions.permissionAt(PermissionKind::Spawn, cx, cy) != false;
			}
		if (!room)
			warning(out, "spawner.no-room", fmt::format("regions[{}].spawner", i),
				fmt::format("Spawner \"{}\" has no free tile inside its region.", r.name.empty() ? r.id : r.name), r.id);
	}

	// Equal priority, overlapping, opposite answers: deny wins, which may not be
	// what the author meant.
	std::vector<size_t> ruled;
	for (size_t i = 0; i < project.regions.size(); ++i) {
		const Region& r = project.regions[i];
		if (r.build != Permission::Inherit || r.pvp != Permission::Inherit || r.spawn != Permission::Inherit) ruled.push_back(i);
	}
	for (size_t a = 0; a < ruled.size(); ++a)
		for (size_t b = a + 1; b < ruled.size(); ++b) {
			const Region& ra = project.regions[ruled[a]];
			const Region& rb = project.regions[ruled[b]];
			if (ra.priority != rb.priority) continue;
			const auto clash = [](Permission x, Permission y) { return x != Permission::Inherit && y != Permission::Inherit && x != y; };
			if (!clash(ra.build, rb.build) && !clash(ra.pvp, rb.pvp) && !clash(ra.spawn, rb.spawn)) continue;
			const auto ia = regions.indexOf(ra.id), ib = regions.indexOf(rb.id);
			if (!ia || !ib) continue;
			int32_t a0, a1, a2, a3, b0, b1, b2, b3;
			regions.bounds(*ia, a0, a1, a2, a3);
			regions.bounds(*ib, b0, b1, b2, b3);
			if (a2 < b0 || b2 < a0 || a3 < b1 || b3 < a1) continue;
			info(out, "region.conflict", fmt::format("regions[{}].permissions", ruled[b]),
				fmt::format("\"{}\" and \"{}\" overlap at the same priority with opposite permissions; where both apply, deny wins.",
					ra.name.empty() ? ra.id : ra.name, rb.name.empty() ? rb.id : rb.name), rb.id);
		}
}

} // namespace

const std::vector<std::string>& supportedFeatures()
{
	// Grows as the runtime implements each part of the plan; the editor shows
	// a project's unsupported features instead of pretending they run.
	static const std::vector<std::string> features = {
		"world.v1", "overrides.health", "overrides.destructible", "overrides.door",
		"regions.effects", "regions.permissions", "regions.polygon",
		"population.npcs", "population.spawns", "population.agents", "population.loot", "population.spawners",
	};
	return features;
}

std::vector<Diagnostic> compileCheck(const Project& project)
{
	std::vector<Diagnostic> out;
	checkEntities(project.entities, "", out);
	checkPopulation(project, out);
	for (size_t i = 0; i < project.templates.size(); ++i) {
		std::vector<Diagnostic> local;
		checkEntities(project.templates[i].entities, fmt::format("templates[{}].", i), local);
		// A template is only a definition; its problems matter once it is placed.
		for (Diagnostic& d : local) {
			if (d.code == "content.missing") d.severity = Severity::Warning;
			out.push_back(std::move(d));
		}
	}
	for (size_t i = 0; i < project.lootTables.size(); ++i) {
		const LootTable& t = project.lootTables[i];
		for (size_t k = 0; k < t.entries.size(); ++k)
			checkStack({ t.entries[k].item, t.entries[k].max }, fmt::format("lootTables[{}].entries[{}]", i, k), t.id, out);
	}
	for (size_t i = 0; i < project.regions.size(); ++i) {
		const Region& r = project.regions[i];
		if (r.spawner && !g_agents.getAgentData(r.spawner->agent))
			error(out, "content.missing", fmt::format("regions[{}].spawner.agent", i),
				fmt::format("Creature \"{}\" is not on this server.", r.spawner->agent), r.id);
	}
	const auto& supported = supportedFeatures();
	for (const std::string& feature : project.requiredFeatures)
		if (std::find(supported.begin(), supported.end(), feature) == supported.end())
			out.push_back({ Severity::Warning, "feature.unsupported", "requiredFeatures",
				fmt::format("This server cannot run \"{}\" yet; the project can be validated but not launched.", feature), {} });
	return out;
}

} // namespace scenario
