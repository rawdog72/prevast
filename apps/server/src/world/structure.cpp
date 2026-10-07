// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "world/structure.h"
#include "gameplay/game.h"
#include "gameplay/object.h"
#include "gameplay/loot.h"
#include "content/configmanager.h"
#include "world/mapsize.h"
#include "core/tools.h"
#include "world/worldgen.h"
#include "world/mapimport.h"
#include "world/placement.h"
#include "content/xml_utils.h"
#include <pugixml.hpp>
#include <fmt/format.h>
#include <fmt/color.h>
#include <fstream>
#include <map>

StructureManager g_structures;
extern Game g_game;

namespace {

// file= on a template, resolved inside contentPath rather than against the
// executable. The tile data is content, so it belongs with the rest of it: one
// directory to point contentPath at, one thing to copy between build trees.
// (maps.xml's own file= is still exe-relative; unifying the two is worth doing.)
std::string readTemplateFile(const std::string& path, const std::string& key, const std::string& filename)
{
	const std::string resolved = contentFile(path);
	std::ifstream in(resolved, std::ios::binary);
	if (!in) {
		reportDataWarning(filename, fmt::format(
			"template '{}' points at file=\"{}\" ({}), which could not be read; it will have no tiles",
			key, path, resolved));
		return {};
	}
	return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

// Editor records -> the row/tile form the placement code already walks.
//
// Coordinates are template-LOCAL, so the code is parsed at origin 0,0. Records
// at one tile are merged: a floor object fills `floor`, anything else fills
// `object`, which is the same pairing the hand-written rows express.
void buildRowsFromCode(StructureTemplate& tmpl, const std::string& code, const std::string& filename)
{
	MapParseReport report;
	const std::vector<MapEntry> entries = MapImportManager::parseCode(code, 0, 0, report);

	if (report.malformed || report.unknownItem || report.outOfBounds || report.badSubtype) {
		reportDataWarning(filename, fmt::format(
			"template '{}': {} malformed, {} unknown item, {} out of bounds, {} bad subtype record(s) dropped",
			tmpl.key, report.malformed, report.unknownItem, report.outOfBounds, report.badSubtype));
	}
	if (entries.empty()) {
		reportDataWarning(filename, fmt::format("template '{}' has no usable tiles", tmpl.key));
		return;
	}

	// y -> x -> tile, so rows and tiles come out in a stable order whatever
	// order the editor emitted them in.
	std::map<uint16_t, std::map<uint16_t, StructureTile>> grid;
	for (const MapEntry& entry : entries) {
		StructureTile& tile = grid[entry.tileY][entry.tileX];
		tile.x = entry.tileX;

		if (entry.od->isFloor) {
			if (!tile.floor.empty()) {
				reportDataWarning(filename, fmt::format(
					"template '{}': two floors on tile {},{}; keeping '{}'",
					tmpl.key, entry.tileX, entry.tileY, tile.floor));
				continue;
			}
			tile.floor = entry.od->key;
			// Only a TEXTURE subtype belongs here, and only on the floor -- the
			// one the placement code applies. A subtype that merely picked WHICH
			// object this is has already been applied by createObject, which is
			// exactly the distinction parseCode draws with appliesSubtype.
			if (entry.appliesSubtype) {
				tile.subtype = entry.subtype;
			}
		} else {
			if (!tile.object.empty()) {
				reportDataWarning(filename, fmt::format(
					"template '{}': two objects on tile {},{}; keeping '{}'",
					tmpl.key, entry.tileX, entry.tileY, tile.object));
				continue;
			}
			tile.object = entry.od->key;
			tile.rotation = entry.rotation;
		}
	}

	uint16_t maxX = 0, maxY = 0;
	for (auto& [y, tiles] : grid) {
		StructureRow row;
		row.y = y;
		for (auto& [x, tile] : tiles) {
			row.tiles.push_back(tile);
			maxX = std::max(maxX, x);
		}
		tmpl.rows.push_back(std::move(row));
		maxY = std::max(maxY, y);
	}

	// width/height bound where the structure may be placed, so a drawing that
	// overflows them would be clipped by the placement checks with no clue why.
	if (tmpl.width == 0 || tmpl.height == 0) {
		tmpl.width = static_cast<uint16_t>(maxX + 1);
		tmpl.height = static_cast<uint16_t>(maxY + 1);
	} else if (maxX >= tmpl.width || maxY >= tmpl.height) {
		reportDataWarning(filename, fmt::format(
			"template '{}' draws out to {}x{} but declares {}x{}; widen it or the structure will not fit",
			tmpl.key, maxX + 1, maxY + 1, tmpl.width, tmpl.height));
	}
}

} // namespace

bool StructureManager::loadTemplates(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "structures");
	if (!root) return false;

	for (pugi::xml_node templateNode = root.child("template"); templateNode; templateNode = templateNode.next_sibling("template")) {
		StructureTemplate tmpl;
		tmpl.key = templateNode.attribute("key").as_string();
		tmpl.width = static_cast<uint16_t>(templateNode.attribute("width").as_uint());
		tmpl.height = static_cast<uint16_t>(templateNode.attribute("height").as_uint());

		// Effects every spawned object of this template carries: an explicit
		// <areaEffects> block (same syntax as objects/resources), plus
		// radiation="true" as shorthand for the standard radiation field
		// (strength/area matching barel1's uranium radiation)
		pugi::xml_node effectsNode = templateNode.child("areaEffects");
		if (effectsNode) {
			xml_utils::appendAreaEffects(effectsNode, tmpl.instanceEffects);
		}
		if (templateNode.attribute("radiation").as_bool(false)) {
			AreaEffect radiation;
			radiation.id = 2;
			radiation.type = "radiation";
			radiation.strength = 1;
			radiation.radius = 0;
			radiation.area = 2;
			// Synthesised, not parsed, so it has to register its own reach.
			noteAreaEffectReach(radiation);
			tmpl.instanceEffects.push_back(radiation);
		}

		// A template may be DRAWN instead of written: <code> holds the string the
		// client's map editor copies out, or file= points at one. Same format
		// maps.xml takes, parsed by the same function, so a building can be laid
		// out in the editor rather than as tile rows by hand.
		//
		// <row> stays the primary form on purpose. The editor format addresses
		// objects by numeric item id, and the rows name them by KEY -- which is
		// what makes the shipped buildings readable and diffable. This is an
		// alternative for authoring, not a replacement.
		const pugi::xml_node codeNode = templateNode.child("code");
		const std::string codeFile = templateNode.attribute("file").as_string();
		if (codeNode || !codeFile.empty()) {
			std::string code = codeNode ? codeNode.text().as_string() : readTemplateFile(codeFile, tmpl.key, filename);
			if (codeNode && !codeFile.empty()) {
				reportDataWarning(filename, fmt::format(
					"template '{}' has both <code> and file=; using <code>", tmpl.key));
			}
			if (templateNode.child("row")) {
				reportDataWarning(filename, fmt::format(
					"template '{}' mixes <row> tiles with a drawn <code>/file=; the rows are ignored",
					tmpl.key));
			}
			buildRowsFromCode(tmpl, code, filename);
			templates[tmpl.key] = tmpl;
			continue;
		}

		for (pugi::xml_node rowNode = templateNode.child("row"); rowNode; rowNode = rowNode.next_sibling("row")) {
			StructureRow row;
			row.y = static_cast<uint16_t>(rowNode.attribute("y").as_uint());

			for (pugi::xml_node tileNode = rowNode.child("tile"); tileNode; tileNode = tileNode.next_sibling("tile")) {
				StructureTile tile;
				tile.x = static_cast<uint16_t>(tileNode.attribute("x").as_uint());
				tile.floor = tileNode.attribute("floor").as_string();
				tile.object = tileNode.attribute("object").as_string();
				tile.rotation = static_cast<uint8_t>(tileNode.attribute("rotation").as_uint(0));
				
				if (tileNode.attribute("subtype")) {
					tile.subtype = tileNode.attribute("subtype").as_int();
				}
				
				row.tiles.push_back(tile);
			}
			tmpl.rows.push_back(row);
		}
		templates[tmpl.key] = tmpl;
	}

	// Per template, not just the count: a drawn <code> produces the same rows a
	// hand-written template does, and these numbers are how you check that a
	// conversion between the two forms changed nothing.
	size_t totalFloors = 0, totalObjects = 0;
	for (const auto& [key, tmpl] : templates) {
		for (const StructureRow& row : tmpl.rows) {
			for (const StructureTile& tile : row.tiles) {
				if (!tile.floor.empty()) ++totalFloors;
				if (!tile.object.empty()) ++totalObjects;
			}
		}
	}
	reportDataFile(filename, fmt::format("{} structure templates ({} floors, {} objects)",
		templates.size(), totalFloors, totalObjects));

	// One line per template, in declaration order. A template written as tile
	// rows and the same template drawn as a <code> must produce identical
	// numbers, and effects= is here because those live on the template rather
	// than on its tiles -- moving the tiles out must not drop them.
	for (const auto& [key, tmpl] : templates) {
		reportDataFile(filename, "  " + describeTemplate(key));
	}
	return true;
}

std::string StructureManager::describeTemplate(const std::string& key) const
{
	const StructureTemplate* tmpl = getTemplate(key);
	if (!tmpl) return {};

	size_t floors = 0, objects = 0, rotated = 0, subtyped = 0;
	for (const StructureRow& row : tmpl->rows) {
		for (const StructureTile& tile : row.tiles) {
			if (!tile.floor.empty()) ++floors;
			if (!tile.object.empty()) ++objects;
			if (tile.rotation != 0) ++rotated;
			if (tile.subtype != -1) ++subtyped;
		}
	}
	return fmt::format("{:<9} {:>2}x{:<2} rows={:<3} floors={:<4} objects={:<4} rot={:<3} sub={:<3} effects={}",
		tmpl->key, tmpl->width, tmpl->height, tmpl->rows.size(), floors, objects,
		rotated, subtyped, tmpl->instanceEffects.size());
}

const StructureTemplate* StructureManager::getTemplate(const std::string& key) const
{
	auto it = templates.find(key);
	if (it != templates.end()) {
		return &it->second;
	}
	return nullptr;
}

void StructureManager::rebuildMinimapMarkers()
{
	cityLocations.clear();
	houseLocations.clear();
	markersDirty = true;

	for (const TrackedStructure& tracked : spawnedStructures) {
		const StructureTemplate* tmpl = getTemplate(tracked.templateId);
		if (!tmpl) {
			continue;
		}
		const Position centre(
			static_cast<uint16_t>(tracked.pos.x + (tmpl->width * TILE_SIZE) / 2),
			static_cast<uint16_t>(tracked.pos.y + (tmpl->height * TILE_SIZE) / 2));

		const MapInstance* instance = g_placements.find(tracked.instanceId);
		if (instance && instance->isCity) {
			cityLocations.push_back(centre);
		} else {
			houseLocations.push_back(centre);
		}
	}
}

void StructureManager::pruneRetiredStructures()
{
	const size_t before = spawnedStructures.size();

	spawnedStructures.erase(
		std::remove_if(spawnedStructures.begin(), spawnedStructures.end(),
			[](const TrackedStructure& tracked) {
				return g_placements.find(tracked.instanceId) == nullptr;
			}),
		spawnedStructures.end());

	if (spawnedStructures.size() != before) {
		// The ground it held is free again -- placedRects used to grow forever,
		// so repeated placement slowly made the map unbuildable -- and its
		// minimap marker has to go with it.
		rebuildMinimapMarkers();
	}
}

const StructureManager::TrackedStructure* StructureManager::findTracked(uint32_t instanceId) const
{
	if (instanceId == 0) {
		return nullptr;
	}
	for (const TrackedStructure& tracked : spawnedStructures) {
		if (tracked.instanceId == instanceId) {
			return &tracked;
		}
	}
	return nullptr;
}

const StructureManager::TrackedStructure* StructureManager::structureAt(int32_t tileX,
                                                                       int32_t tileY) const
{
	for (const TrackedStructure& tracked : spawnedStructures) {
		const StructureRect& r = tracked.rect;
		if (tileX >= r.x1 && tileX < r.x2 && tileY >= r.y1 && tileY < r.y2) {
			return &tracked;
		}
	}
	return nullptr;
}

bool StructureManager::removeStructure(uint32_t instanceId, uint32_t adminGuid,
                                       std::string& error)
{
	const TrackedStructure* tracked = findTracked(instanceId);
	if (!tracked) {
		error = fmt::format("No structure #{} is standing. !structure-list-placed shows them.",
			instanceId);
		return false;
	}
	const std::string key = tracked->templateId;

	// Retire first, so the ground and the minimap marker are free the moment
	// this returns. The entities come off over the next few slices, which is a
	// separate concern from whether the world still believes a building is here.
	std::vector<uint32_t> victims;
	g_placements.retire(instanceId, victims);
	pruneRetiredStructures();

	g_maps.queueRemoval(std::move(victims), adminGuid, fmt::format("structure {}", key));
	return true;
}

bool StructureManager::moveStructure(uint32_t instanceId, int32_t tileX, int32_t tileY,
                                     uint32_t adminGuid, std::string& error)
{
	const TrackedStructure* tracked = findTracked(instanceId);
	if (!tracked) {
		error = fmt::format("No structure #{} is standing.", instanceId);
		return false;
	}

	const std::string key = tracked->templateId;
	const MapInstance* instance = g_placements.find(instanceId);
	const bool wasCity = instance && instance->isCity;
	const StructureRect from = tracked->rect;

	// Retire before testing the destination, or a short move would be refused
	// for overlapping the building it is moving. Restored on failure below.
	std::vector<uint32_t> victims;
	g_placements.retire(instanceId, victims);
	pruneRetiredStructures();

	PlacementReport report;
	if (!placeStructureAt(key, tileX, tileY, wasCity, report, error)) {
		// Nothing was destroyed -- the entities are all still standing -- so put
		// the tracking back exactly as it was and report the refusal.
		const uint32_t restored = g_placements.open(PlacementSource::Structure, key,
			PlacementRect{ from.x1, from.y1, from.x2, from.y2 }, adminGuid, wasCity);
		g_placements.record(restored, victims);
		// Tile CENTRE, matching what placeStructureAt and populateMap record --
		// the respawn walks the template from this point.
		spawnedStructures.push_back({ key, g_game.tileCenterPosition(from.x1, from.y1),
			from, restored });
		rebuildMinimapMarkers();
		return false;
	}

	g_maps.queueRemoval(std::move(victims), adminGuid, fmt::format("structure {}", key));
	return true;
}

bool StructureManager::setStructureRespawn(uint32_t instanceId, bool respawns)
{
	for (TrackedStructure& tracked : spawnedStructures) {
		if (tracked.instanceId == instanceId) {
			tracked.respawns = respawns;
			return true;
		}
	}
	return false;
}

bool StructureManager::intersects(const StructureRect& r) const
{
	for (const TrackedStructure& tracked : spawnedStructures) {
		const StructureRect& rect = tracked.rect;
		if (r.x1 < rect.x2 && r.x2 > rect.x1 && r.y1 < rect.y2 && r.y2 > rect.y1) {
			return true;
		}
	}
	return false;
}

namespace {

// How far the nearest already-placed structure is, centre to centre, in grid
// units. Chebyshev rather than Euclidean: the rects are axis-aligned and so is
// the map, and it is the distance a player actually walks.
int32_t nearestRectDistance(const std::vector<StructureManager::TrackedStructure>& placed,
                            const StructureRect& r)
{
	if (placed.empty()) {
		return std::numeric_limits<int32_t>::max();
	}

	const int32_t cx = (r.x1 + r.x2) / 2;
	const int32_t cy = (r.y1 + r.y2) / 2;

	int32_t best = std::numeric_limits<int32_t>::max();
	for (const StructureManager::TrackedStructure& tracked : placed) {
		const StructureRect& other = tracked.rect;
		const int32_t ox = (other.x1 + other.x2) / 2;
		const int32_t oy = (other.y1 + other.y2) / 2;
		best = std::min(best, std::max(std::abs(cx - ox), std::abs(cy - oy)));
	}
	return best;
}

} // namespace

StructureManager::PopulateReport StructureManager::populateMap(const GameMode* activeMode,
                                                               uint32_t worldSeed,
                                                               MapSize::ContentBudget& budget,
                                                               bool preserveOccupied)
{
	PopulateReport report;
	if (!activeMode) return report;

	// This phase's own stream. Nothing any other phase does -- how many chests
	// it rolled, how many tiles it had to skip -- can move a city now.
	WorldRng rng = worldStream(worldSeed, "structures");

	cityLocations.clear();
	houseLocations.clear();
	spawnedStructures.clear();
	markersDirty = true;

	const int32_t mapWidthGrid = MapSize::tilesX();
	const int32_t mapHeightGrid = MapSize::tilesY();

	// Spawn cities first because they are the largest and need the most space
	std::vector<StructureSpawn> sortedSpawns = activeMode->structureSpawns;
	std::sort(sortedSpawns.begin(), sortedSpawns.end(), [](const StructureSpawn& a, const StructureSpawn& b) {
		return a.isCity > b.isCity;
	});

	// Charge the budget in the order above -- cities first, then houses -- and
	// take everything that still fits inside the structure share.
	//
	// Skip and CARRY ON rather than stopping at the first refusal. Stopping
	// sounds tidier and is badly wrong in practice: the list is sorted
	// largest-first, so the first thing to overrun the allowance is the city,
	// and a 60x60 map would come up with no houses either -- worse than the
	// geometric check it replaces, which only ever rejected the one template
	// that did not fit. Order is fixed and so is the allowance, so taking what
	// fits is just as deterministic as refusing everything after the first miss.
	//
	// Charged against the FOOTPRINT (width * height), not the number of objects
	// in the template: a city reserves its whole rectangle of ground, and that
	// rectangle is what is unavailable to resources afterwards.
	const int64_t structureAllowance = std::min(
		budget.remaining(), budget.shareFor(MapSize::STRUCTURE_BUDGET_SHARE_PERCENT));
	int64_t structureSpent = 0;

	// DENSITY FIRST, then affordability.
	//
	// modes.xml asks for one of each template at every map size, so a 655x655
	// map used to get the same twelve buildings as a 150x150 one -- one city and
	// eleven houses spread over nineteen times the ground. Resources already
	// scaled (ResourceManager::populateMap), which made a big world feel like
	// wilderness with a single town somewhere in it.
	//
	// Scaled through MapSize::contentScaleFor, the SAME rational resources use,
	// so structures and resources grow by exactly the same factor and the mix
	// is preserved. Expressed in TILES because that is what the budget counts
	// and what a structure actually consumes: a template's footprint is the
	// rectangle of ground it takes away from everything else.
	//
	// num == den is guaranteed at the reference size, so a 150x150 map still
	// generates precisely the authored world -- which is what keeps every
	// existing seed fingerprint valid.
	int64_t authoredFootprint = 0;
	for (const auto& spawn : sortedSpawns) {
		if (const StructureTemplate* tmpl = getTemplate(spawn.key)) {
			authoredFootprint += static_cast<int64_t>(tmpl->width) * tmpl->height * spawn.amount;
		}
	}
	// Damped by structureGrowthPercent, unlike resources, which follow the area
	// exactly. Buildings are LANDMARKS: at full scaling a 655x655 map generated
	// 209 houses, which reads as one continuous town rather than a wilderness
	// with towns in it, and the point of a big map is being able to walk for a
	// while. The damping is applied to the DISTANCE from the reference size, so
	// a 150x150 world is unaffected by this setting at any value.
	const int growthPercent = getNumber(ConfigManager::STRUCTURE_GROWTH_PERCENT);
	const MapSize::ContentScale scale = MapSize::contentScaleFor(
		static_cast<uint32_t>(authoredFootprint), structureAllowance, growthPercent);

	if (!scale.isIdentity()) {
		fmt::print(">> Structure counts scaled to {}% for this map size ({}x{} tiles against "
			"the {}x{} the content is authored for, structureGrowthPercent {})\n",
			(scale.num * 100) / scale.den, mapWidthGrid, mapHeightGrid,
			MapSize::REFERENCE_TILES_X, MapSize::REFERENCE_TILES_Y, growthPercent);
	}

	std::vector<StructureSpawn> affordable;
	affordable.reserve(sortedSpawns.size());
	for (auto& spawn : sortedSpawns) {
		const StructureTemplate* tmpl = getTemplate(spawn.key);
		if (!tmpl) continue;

		// Scale the COUNT, not the footprint: a template is placed whole or not
		// at all, so the only thing that can grow is how many of it there are.
		spawn.amount = scale.apply(spawn.amount);

		const int64_t footprint =
			static_cast<int64_t>(tmpl->width) * tmpl->height * spawn.amount;

		if (structureSpent + footprint > structureAllowance) {
			report.droppedToBudget += spawn.amount;
			continue;
		}
		structureSpent += footprint;
		affordable.push_back(spawn);
	}
	budget.spend(structureSpent);

	if (report.droppedToBudget != 0) {
		fmt::print(fg(fmt::color::orange),
			">> {} structure(s) dropped: a {}x{} map allows structures {} tiles and they "
			"wanted more\n", report.droppedToBudget, mapWidthGrid, mapHeightGrid,
			structureAllowance);
	}

	sortedSpawns = std::move(affordable);

	// What this mode's world generation is about to cost, checked against the
	// space it has to come out of. Printed whether or not it fits: the whole
	// point of the id budget report is that an admin sees the number before the
	// world is built, not after building silently stops.
	// Only the affordable ones are costed -- the dropped ones will not be
	// attempted, so counting their ids would misreport the demand. `wanted`
	// still includes them (added with droppedToBudget above's counterpart
	// below), because placed/wanted is the shortfall figure and hiding a
	// dropped city in it is exactly the kind of quiet success this report
	// exists to prevent.
	uint32_t plannedIdCost = 0;
	for (const auto& spawn : sortedSpawns) {
		if (const StructureTemplate* tmpl = getTemplate(spawn.key)) {
			plannedIdCost += templateIdCost(tmpl) * spawn.amount;
			report.wanted += spawn.amount;
		}
	}
	report.wanted += report.droppedToBudget;
	const uint32_t idsAvailable = g_game.map.getEntityIdPool().freeCount();
	fmt::print(">> World generation wants {} entity ids of {} free\n", plannedIdCost, idsAvailable);
	if (plannedIdCost > idsAvailable) {
		fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold,
			">> [WARNING] world generation needs more ids than exist. Structures will be spawned "
			"until the space runs out and the rest skipped WHOLE (never in part). Reduce the "
			"mode's structure counts in modes.xml, or shrink the templates.\n");
	}

	bool outOfIdSpace = false;
	for (const auto& spawn : sortedSpawns) {
		if (outOfIdSpace) break;

		const StructureTemplate* tmpl = getTemplate(spawn.key);
		if (!tmpl) continue;

		static constexpr int STRUCTURE_PLACE_ATTEMPTS = 500;
		static constexpr int STRUCTURE_EDGE_MARGIN = 10;
		static constexpr int STRUCTURE_PADDING = 4;

		// Best-candidate sampling: keep looking past the first legal spot and
		// take the one furthest from everything already standing. Pure "first
		// that fits" clumps -- cities landed four tiles apart with the rest of
		// the map empty, because a legal spot next to a city is exactly as
		// likely as one in open ground. Sixteen is where the spread stops
		// improving visibly; the cost is 32 extra draws per structure.
		static constexpr int STRUCTURE_CANDIDATES = 16;

		// Avoid edges, ensure it fits within map bounds; no random position can
		// ever succeed on a too-small map, so skip this template entirely.
		int32_t maxX = mapWidthGrid - tmpl->width - STRUCTURE_EDGE_MARGIN;
		int32_t maxY = mapHeightGrid - tmpl->height - STRUCTURE_EDGE_MARGIN;
		if (maxX <= STRUCTURE_EDGE_MARGIN || maxY <= STRUCTURE_EDGE_MARGIN) {
			reportStartupWarning(fmt::format("map is too small for structure template {} (maxX: {}, maxY: {})", tmpl->key, maxX, maxY));
			continue;
		}

		for (uint32_t i = 0; i < spawn.amount && !outOfIdSpace; ++i) {
			StructureRect best{};
			int32_t bestClearance = -1;
			int32_t candidates = 0;

			for (int attempts = 0; attempts < STRUCTURE_PLACE_ATTEMPTS &&
			                       candidates < STRUCTURE_CANDIDATES; ++attempts) {
				const int32_t gx = rng.range(STRUCTURE_EDGE_MARGIN, maxX - 1);
				const int32_t gy = rng.range(STRUCTURE_EDGE_MARGIN, maxY - 1);

				StructureRect r;
				r.x1 = gx;
				r.y1 = gy;
				r.x2 = gx + tmpl->width;
				r.y2 = gy + tmpl->height;

				// Expand bounds slightly for padding
				StructureRect r_pad = { r.x1 - STRUCTURE_PADDING, r.y1 - STRUCTURE_PADDING, r.x2 + STRUCTURE_PADDING, r.y2 + STRUCTURE_PADDING };

				if (intersects(r_pad)) {
					continue;
				}

				++candidates;
				const int32_t clearance = nearestRectDistance(spawnedStructures, r);
				if (clearance > bestClearance) {
					bestClearance = clearance;
					best = r;
				}
			}

			if (bestClearance < 0) {
				++report.noSpace;
				reportStartupWarning(fmt::format("could not find space for structure '{}'", spawn.key));
				continue;
			}

			const Position pos(best.x1 * 100 + 50, best.y1 * 100 + 50);
			std::vector<uint32_t> placedIds;
			if (!spawnStructure(tmpl, pos, preserveOccupied, &placedIds)) {
				// Out of id space, not out of room: no later attempt at any
				// template can succeed either, so stop rather than grind
				// through 500 attempts per remaining structure.
				outOfIdSpace = true;
				break;
			}

			// Noted here, where the DECISION is made, rather than from what got
			// built: a template that lost a few tiles to a base still went up in
			// the same place, and the seed's promise is about the place.
			worldgen::noteLayout(WorldFingerprint::kindOf(tmpl->key), pos.x, pos.y,
				spawn.isCity ? 1u : 0u);

			const uint32_t instanceId = g_placements.open(PlacementSource::Structure, tmpl->key,
				PlacementRect{ best.x1, best.y1, best.x2, best.y2 }, /*placedBy=*/0, spawn.isCity);
			g_placements.record(instanceId, placedIds);
			spawnedStructures.push_back({ tmpl->key, pos, best, instanceId });

			// Center the minimap icon over the structure
			const Position centerPos(pos.x + (tmpl->width * 100) / 2, pos.y + (tmpl->height * 100) / 2);

			if (spawn.isCity) {
				addCityLocation(centerPos);
			} else {
				addHouseLocation(centerPos);
			}
			++report.placed;
		}
	}
	report.outOfIds = outOfIdSpace;
	fmt::print(">> Spawned {} cities and {} houses\n", cityLocations.size(), houseLocations.size());
	return report;
}

static void attachTemplateEffects(Object* obj, const StructureTemplate* tmpl)
{
	for (const AreaEffect& effect : tmpl->instanceEffects) {
		obj->addInstanceAreaEffect(effect);
	}
}

// Is this tile occupied by something a structure respawn must not overwrite?
// Creatures and loot always block. So does any non-floor object, except one
// whose key is `exemptKey` -- that is the very thing being respawned, so an
// existing copy of it is not an obstruction.
//
// The object and floor respawn paths below had a byte-identical copy of this
// each, differing only in which key they exempted, which is exactly the shape
// that lets two copies drift apart.
static bool isRespawnBlocked(const Tile* tileObj, const std::string& exemptKey)
{
	if (!tileObj) {
		return false;
	}

	for (Thing* thing : tileObj->getThings()) {
		if (thing->getCreature() || thing->getLoot()) {
			return true;
		}
		if (const Object* obj = thing->getObject()) {
			if (obj->getKey() != exemptKey) {
				const ObjectData* od = obj->getData();
				if (od && !od->isFloor) {
					return true;
				}
			}
		}
	}

	return false;
}

uint32_t StructureManager::templateIdCost(const StructureTemplate* tmpl)
{
	if (!tmpl) {
		return 0;
	}

	uint32_t cost = 0;
	for (const auto& row : tmpl->rows) {
		for (const auto& tile : row.tiles) {
			if (!tile.floor.empty()) ++cost;
			if (!tile.object.empty()) ++cost;
		}
	}
	return cost;
}

bool StructureManager::spawnStructure(const StructureTemplate* tmpl, const Position& pos,
                                      bool preserveOccupied, std::vector<uint32_t>* placedIds)
{
	if (!tmpl) {
		fmt::print(fg(fmt::color::red), ">> [Error] Tried to spawn null structure template\n");
		return false;
	}

	// Admission control, not a per-object null check. World generation is a
	// BULK consumer -- it asks for thousands of ids in one go -- so letting it
	// run until createObject starts returning nullptr produces a map that is
	// silently missing its tail end, with one warning line to explain it. A
	// player building one wall at a time can be told "no" per wall; a template
	// cannot. Check the whole cost up front and place none of it on a miss.
	const uint32_t cost = templateIdCost(tmpl);
	const EntityIdPool& pool = g_game.map.getEntityIdPool();
	const uint32_t objectCap = pool.capOf(EntityClass::Object);
	const uint32_t objectRoom = objectCap == 0
		? pool.freeCount()
		: std::min(pool.freeCount(), objectCap - std::min(objectCap, pool.liveCount(EntityClass::Object)));

	if (cost > objectRoom) {
		fmt::print(fg(fmt::color::crimson),
			">> [Error] Structure '{}' needs {} entity ids but only {} are available; skipped "
			"entirely rather than spawned in part. The map is larger than the id space can "
			"describe -- see the entity id pool report above.\n", tmpl->key, cost, objectRoom);
		return false;
	}

	// Silent during world generation, broadcast when the world is already live.
	//
	// internalPlaceThing tells nobody and does not autotile. That is right while
	// generating -- there is no client to tell at boot, and a !seed rebuild
	// replaces every client's entity table wholesale afterwards -- and wrong for
	// !structure-place, where the building went up in front of people who are
	// standing there. It appeared for them only when something else forced an
	// update on the tile, which is what made a placed house look like it had not
	// been placed until you shot it.
	//
	// Derived from the generation scope rather than passed in, so a future
	// caller cannot forget to say which it is.
	const bool live = !worldgen::isActive();

	for (const auto& row : tmpl->rows) {
		for (const auto& tile : row.tiles) {
			Position tilePos(pos.x + tile.x * 100, pos.y + row.y * 100);

			// Claimed before the skip below, not after: the template wanted this
			// tile, so nothing generated later may take it just because a bot
			// happened to be standing here when the walls went up.
			worldgen::claimTile(tilePos.x / TILE_SIZE, tilePos.y / TILE_SIZE);

			// Whatever is standing here outranks the template. Skipping rather
			// than waiting: this is a one-shot generation pass, so the tile is
			// simply not part of the building.
			//
			// A creature is skipped whichever way the flag went -- a rebuild
			// should not be able to seal a player inside a wall -- and a skip
			// now costs exactly this tile: the storage rolls below are keyed by
			// position, so missing one no longer shifts anything else.
			if (g_game.tileHoldsCreature(tilePos) ||
			    (preserveOccupied && g_game.tileHoldsPlayerContent(tilePos))) {
				continue;
			}

			g_game.clearTile(tilePos);

			if (!tile.floor.empty()) {
				Object* floorObj = g_objects.createObject(tile.floor, tilePos, 0);
				if (floorObj) {
					if (tile.subtype != -1) {
						floorObj->setSubtype(static_cast<uint16_t>(tile.subtype), true);
					}
					attachTemplateEffects(floorObj, tmpl);
					if (live) {
						g_game.placeThing(floorObj, tilePos);
					} else {
						g_game.internalPlaceThing(floorObj, tilePos);
					}
					if (placedIds) {
						placedIds->push_back(floorObj->getID());
					}
				}
			}

			if (!tile.object.empty()) {
				Object* obj = g_objects.createObject(tile.object, tilePos, tile.rotation);
				if (obj) {
					attachTemplateEffects(obj, tmpl);
					if (live) {
						g_game.placeThing(obj, tilePos);
					} else {
						g_game.internalPlaceThing(obj, tilePos);
					}
					if (placedIds) {
						placedIds->push_back(obj->getID());
					}
				}
			}
		}
	}

	return true;
}

std::vector<std::string> StructureManager::templateKeys() const
{
	std::vector<std::string> keys;
	keys.reserve(templates.size());
	for (const auto& [key, tmpl] : templates) {
		keys.push_back(key);
	}
	std::sort(keys.begin(), keys.end());
	return keys;
}

bool StructureManager::placeStructureAt(const std::string& key, int32_t tileX, int32_t tileY,
                                        bool isCity, PlacementReport& report, std::string& error)
{
	const StructureTemplate* tmpl = getTemplate(key);
	if (!tmpl) {
		error = fmt::format("No structure template '{}'.", key);
		return false;
	}
	if (tmpl->rows.empty()) {
		error = fmt::format("Template '{}' has no tiles.", key);
		return false;
	}

	// Bounds first, and against the FOOTPRINT rather than the corner: a template
	// whose origin is on the map but whose far wall is not would be silently
	// clipped, leaving a half building nobody asked for.
	if (tileX < 0 || tileY < 0) {
		error = "Tile coordinates cannot be negative.";
		return false;
	}
	const int32_t endX = tileX + tmpl->width;
	const int32_t endY = tileY + tmpl->height;
	if (endX > MapSize::tilesX() || endY > MapSize::tilesY()) {
		error = fmt::format(
			"'{}' is {}x{} tiles, so at {},{} it would reach {},{} on a {}x{} map. Move it to at most {},{}.",
			key, tmpl->width, tmpl->height, tileX, tileY, endX, endY,
			MapSize::tilesX(), MapSize::tilesY(),
			MapSize::tilesX() - tmpl->width, MapSize::tilesY() - tmpl->height);
		return false;
	}

	// Against everything generation placed, using generation's own test, so an
	// admin cannot drop a house through a city wall.
	const StructureRect rect{ tileX, tileY, endX, endY };
	if (intersects(rect)) {
		error = fmt::format("'{}' would overlap a structure already standing there.", key);
		return false;
	}

	// The template's origin is the CENTRE of its first tile, not the corner.
	// spawnStructure walks the template with `pos + tile.x * 100`, so whatever
	// this is becomes the position of every object in the building -- and world
	// generation has always passed `x * 100 + 50` (see populateMap).
	//
	// Passing the corner put every admin-placed object half a tile up and left
	// of where it belonged, straddling the tile boundary: the building looked
	// almost right and collided against nothing you could see. It also poisoned
	// TrackedStructure::pos, so the respawn rebuilt it at the same wrong offset.
	const Position pos = g_game.tileCenterPosition(tileX, tileY);

	// preserveOccupied: an admin placing a building into a live world should not
	// bulldoze what players built, and spawnStructure skips creatures either way.
	std::vector<uint32_t> placedIds;
	if (!spawnStructure(tmpl, pos, /*preserveOccupied=*/true, &placedIds)) {
		error = fmt::format(
			"'{}' needs {} entity ids and the pool does not have them; nothing was placed.",
			key, templateIdCost(tmpl));
		return false;
	}

	// Tracked like a generated one: this is what makes it respawn on the mode's
	// cycle instead of being a one-off decoration.
	const uint32_t instanceId = g_placements.open(PlacementSource::Structure, tmpl->key,
		PlacementRect{ rect.x1, rect.y1, rect.x2, rect.y2 }, /*placedBy=*/0, isCity);
	g_placements.record(instanceId, placedIds);
	spawnedStructures.push_back({ tmpl->key, pos, rect, instanceId });

	const Position centre(static_cast<uint16_t>(pos.x + (tmpl->width * TILE_SIZE) / 2),
	                      static_cast<uint16_t>(pos.y + (tmpl->height * TILE_SIZE) / 2));
	if (isCity) {
		addCityLocation(centre);
	} else {
		addHouseLocation(centre);
	}

	// Counted from the world, not from the template: tiles holding a creature or
	// a player's build are skipped, so only a walk of what is actually standing
	// there can say what went up.
	for (const StructureRow& row : tmpl->rows) {
		for (const StructureTile& tile : row.tiles) {
			const int32_t tx = tileX + tile.x;
			const int32_t ty = tileY + row.y;
			const Tile* mapTile = g_game.map.getTile(static_cast<uint16_t>(tx), static_cast<uint16_t>(ty));
			if (!mapTile) continue;

			bool sawFloor = false, sawObject = false;
			for (Thing* thing : mapTile->getThings()) {
				Object* obj = thing->getObject();
				if (!obj) continue;
				const ObjectData* od = obj->getData();
				if (!od) continue;

				if (od->isFloor && od->key == tile.floor) {
					sawFloor = true;
				} else if (od->key == tile.object) {
					sawObject = true;
					if (od->storageSlots > 0) {
						++report.containers;
						for (uint8_t slot = 0; slot < od->storageSlots; ++slot) {
							if (obj->getStorageItem(slot)) ++report.lootItems;
						}
					}
				}
			}
			if (sawFloor) ++report.floors;
			if (sawObject) ++report.objects;
			if ((!tile.floor.empty() && !sawFloor) || (!tile.object.empty() && !sawObject)) {
				++report.skipped;
			}
		}
	}
	return true;
}

void StructureManager::respawnStructures()
{
	// A structure whose placement has been retired is not a structure any more.
	// This is what !clean-hard leaves behind, and without the prune the timer
	// would rebuild every city over a world an admin deliberately emptied.
	pruneRetiredStructures();

	for (const auto& tracked : spawnedStructures) {
		if (!tracked.respawns) {
			continue; // !structure-respawn=<n>:off, so this one stays down
		}
		const StructureTemplate* tmpl = getTemplate(tracked.templateId);
		if (!tmpl) continue;

		for (const auto& row : tmpl->rows) {
			for (const auto& tile : row.tiles) {
				Position tilePos(tracked.pos.x + tile.x * 100, tracked.pos.y + row.y * 100);
				int32_t tx = tilePos.x / TILE_SIZE;
				int32_t ty = tilePos.y / TILE_SIZE;

				Tile* tileObj = g_game.map.getTile(static_cast<uint16_t>(tx), static_cast<uint16_t>(ty));
				
				if (!tile.object.empty()) {
					Object* existingObj = nullptr;
					if (tileObj) {
						for (Thing* thing : tileObj->getThings()) {
							if (Object* obj = thing->getObject()) {
								if (obj->getKey() == tile.object) {
									existingObj = obj;
									break;
								}
							}
						}
					}

					if (existingObj) {
						// Re-fill existing container type
						const ObjectData* od = existingObj->getData();
						if (od && od->storageSlots > 0) {
							bool itemAdded = false;
							for (const auto& content : od->initialStorage) {
								float roll = static_cast<float>(rand() % 1000) / 1000.0f;
								if (roll <= content.chance) {
									// Find the first empty slot in the container
									for (uint8_t slot = 0; slot < od->storageSlots; ++slot) {
										if (existingObj->getStorageItem(slot) == nullptr) {
											const ItemData* idata = ItemManager::getInstance().getItemData(content.iid);
											if (idata) {
												existingObj->setStorageItem(slot, std::make_unique<Item>(content.iid, content.count, ItemState::fresh(content.iid)));
												itemAdded = true;
												break;
											}
										}
									}
								}
							}
							
							if (itemAdded) {
								uint32_t activePid = existingObj->getActiveUserPid();
								if (activePid != 0) {
									Player* p = g_game.getPlayerByGUID(activePid);
									if (p) {
										p->sendFullChest(existingObj);
									}
								}
							}
						}
					} else {
						// Object was destroyed. We want to respawn it -- unless the
						// tile is blocked by loot, creatures or player-placed objects.
						if (!isRespawnBlocked(tileObj, tile.object)) {
							g_game.clearTile(tilePos);

							if (!tile.floor.empty()) {
								Object* floorObj = g_objects.createObject(tile.floor, tilePos, 0);
								if (floorObj) {
									if (tile.subtype != -1) {
										floorObj->setSubtype(static_cast<uint16_t>(tile.subtype), true);
									}
									attachTemplateEffects(floorObj, tmpl);
									g_game.placeThing(floorObj, tilePos);
									g_placements.record(tracked.instanceId, floorObj->getID());
								}
							}

							Object* newObj = g_objects.createObject(tile.object, tilePos, tile.rotation);
							if (newObj) {
								attachTemplateEffects(newObj, tmpl);
								g_game.placeThing(newObj, tilePos);
								// Into the SAME placement, so a wall a respawn put
								// back is removable by the command that removes the
								// building it belongs to.
								g_placements.record(tracked.instanceId, newObj->getID());
							}
						}
					}
				} else if (!tile.floor.empty()) {
					// No object, but there is a floor tile. Check if floor is missing.
					bool floorExists = false;
					if (tileObj) {
						for (Thing* thing : tileObj->getThings()) {
							if (Object* obj = thing->getObject()) {
								if (obj->getKey() == tile.floor) {
									floorExists = true;
									break;
								}
							}
						}
					}

					if (!floorExists) {
						if (!isRespawnBlocked(tileObj, tile.floor)) {
							g_game.clearTile(tilePos);
							Object* floorObj = g_objects.createObject(tile.floor, tilePos, 0);
							if (floorObj) {
								if (tile.subtype != -1) {
									floorObj->setSubtype(static_cast<uint16_t>(tile.subtype), true);
								}
								attachTemplateEffects(floorObj, tmpl);
								g_game.placeThing(floorObj, tilePos);
								g_placements.record(tracked.instanceId, floorObj->getID());
							}
						}
					}
				}
			}
		}
	}
}
