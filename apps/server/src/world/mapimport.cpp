// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "world/mapimport.h"

#include "content/configmanager.h"
#include "gameplay/game.h"
#include "gameplay/item.h"
#include "world/mapsize.h"
#include "gameplay/object.h"
#include "gameplay/player.h"
#include "network/protocolgame.h"
#include "world/structure.h"
#include "core/tools.h"
#include "world/worldgen.h"
#include "content/xml_utils.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <fmt/color.h>
#include <fmt/format.h>
#include <pugixml.hpp>

MapImportManager g_maps;
extern Game g_game;

namespace {

// How much of a job runs per slice. Sized so a slice stays far inside one 50ms
// game tick even on a slow box: placement is the expensive side (each object
// costs a create, a tile clear, a broadcast and a subtype refresh), removal is
// cheaper. The whole point is that a 5,000-object map or a full !clean never
// blocks the tick -- they take a few seconds of wall clock instead, which
// nobody can feel, rather than one long freeze that everybody does.
constexpr size_t STAMP_ENTRIES_PER_SLICE = 48;
constexpr size_t CLEAN_THINGS_PER_SLICE = 96;

// A paste commits this long after its last fragment. Fragments arrive as fast
// as the browser can push them, so anything above a few hundred ms is safe;
// this is well clear of that and still feels immediate.
constexpr uint64_t SESSION_IDLE_MS = 750;

// Upper bounds on one map, so a malformed or hostile stream cannot grow the
// session buffer or the entry list without limit. Both sit above a completely
// built-out 150x150 world -- 22,500 tiles carrying up to four layers each is
// ~90,000 records at ~16 bytes -- which no real export approaches, and which a
// chat paste could not reach anyway (the frame limit stops it around 800).
constexpr size_t SESSION_MAX_CODE_BYTES = 4u << 20;
constexpr size_t MAX_ENTRIES_PER_MAP = 100000;

// ROAD[] holds 0..45 (client.js:30896 builds index 0, then 45 more). The
// subtype a road record carries indexes that array directly in _Road
// (client.js:16887) with no bounds check, so an out-of-range value does not
// render wrong -- it throws inside the render loop and takes down every client
// that can see the tile.
constexpr uint16_t ROAD_VARIANT_COUNT = 46;

uint32_t tileKey(uint16_t tileX, uint16_t tileY)
{
	return (static_cast<uint32_t>(tileY) << 16) | tileX;
}

bool parseUint(std::string_view text, uint32_t& out)
{
	if (text.empty() || text.size() > 9) {
		return false;
	}
	uint32_t value = 0;
	for (const char c : text) {
		if (c < '0' || c > '9') {
			return false;
		}
		value = value * 10 + static_cast<uint32_t>(c - '0');
	}
	out = value;
	return true;
}

int32_t mapTilesX()
{
	return MapSize::tilesX();
}

int32_t mapTilesY()
{
	return MapSize::tilesY();
}

// Does this record name a subtype the client can actually draw? Only the
// variant carriers need asking: when a subtype selected the OBJECT (furniture)
// it came from the loaded XML and is valid by construction.
bool subtypeIsRenderable(const ObjectData& od, uint8_t subtype)
{
	if (od.key == "road") {
		return subtype < ROAD_VARIANT_COUNT;
	}
	// Object::setSubtype clamps to 6 bits; beyond that the value cannot even be
	// transmitted, so it would silently become a different object.
	return subtype <= 63;
}

// Everything standing on one tile that matters to a respawn decision.
struct TileOccupancy
{
	Object* sameKey = nullptr;   // the entry's own object, still alive
	bool blocked = false;        // a creature, loot, a resource, or a foreign build
};

TileOccupancy inspectTile(const Position& pos, const ObjectData& wanted)
{
	TileOccupancy result;

	const Tile* tile = g_game.map.findTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (!tile) {
		return result;
	}

	for (Thing* thing : tile->getThings()) {
		if (thing->getPosition() != pos) {
			continue;
		}

		if (thing->getCreature() || thing->getLoot() || thing->getResource()) {
			// A player, a bot, dropped loot or a regrown tree all outrank the
			// map: the respawn waits rather than deleting them.
			result.blocked = true;
			continue;
		}

		Object* obj = thing->getObject();
		if (!obj) {
			continue;
		}

		if (obj->getKey() == wanted.key) {
			result.sameKey = obj;
			continue;
		}

		// A floor underneath is the normal state of the world -- a wall stands
		// on one -- so it never blocks. Anything else on the tile is either a
		// player's build or another map's, and both are left alone.
		const ObjectData* existing = obj->getData();
		if (!existing || !existing->isFloor || wanted.isFloor) {
			result.blocked = true;
		}
	}

	return result;
}

// Puts back whatever an object's type says it should hold, into slots that are
// empty now. Same contract as the city respawn (structure.cpp): a looted chest
// refills, a chest a player filled themselves keeps what is in it.
bool refillStorage(Object* obj)
{
	const ObjectData* od = obj->getData();
	if (!od || od->storageSlots == 0 || od->initialStorage.empty()) {
		return false;
	}

	bool added = false;
	uint32_t rollIndex = 0;
	for (const StorageContent& content : od->initialStorage) {
		// Same rule as ObjectManager::createObject: during world generation the
		// roll is keyed by position so that a blocked tile costs that tile and
		// nothing else. On the respawn timer it is an ordinary live roll.
		const float roll = worldgen::isActive()
			? worldgen::contentRoll(obj->getPosition().x, obj->getPosition().y, od->key, rollIndex++)
			: static_cast<float>(rand() % 1000) / 1000.0f;
		if (roll > content.chance) {
			continue;
		}

		for (uint8_t slot = 0; slot < od->storageSlots; ++slot) {
			if (obj->getStorageItem(slot) != nullptr) {
				continue;
			}
			const ItemData* idata = ItemManager::getInstance().getItemData(content.iid);
			if (idata) {
				obj->setStorageItem(slot, std::make_unique<Item>(content.iid, content.count,
				                                                ItemState::fresh(content.iid)));
				added = true;
			}
			break;
		}
	}

	if (added) {
		// Someone with the chest open has a stale window; push them the new
		// contents rather than let them see an empty box they cannot use.
		if (const uint32_t activePid = obj->getActiveUserPid(); activePid != 0) {
			if (Player* p = g_game.getPlayerByGUID(activePid)) {
				p->sendFullChest(obj);
			}
		}
	}
	return added;
}

// True when this tile holds something a player built, which is what
// bulldozePlayerBuilds="false" refuses to destroy.
bool holdsPlayerBuild(const Position& pos)
{
	const Tile* tile = g_game.map.findTile(pos.x / TILE_SIZE, pos.y / TILE_SIZE);
	if (!tile) {
		return false;
	}

	for (Thing* thing : tile->getThings()) {
		if (thing->getPosition() != pos) {
			continue;
		}
		if (const Object* obj = thing->getObject()) {
			if (obj->getOwnerPid() != 0) {
				return true;
			}
		}
	}
	return false;
}

// How many more objects the entity id pool can take. Same computation
// StructureManager::spawnStructure makes; a map is a bulk consumer too and has
// the same reason to ask before it starts rather than while it runs.
uint32_t mapObjectIdRoom()
{
	const EntityIdPool& pool = g_game.map.getEntityIdPool();
	const uint32_t objectCap = pool.capOf(EntityClass::Object);
	if (objectCap == 0) {
		return pool.freeCount();
	}
	const uint32_t used = std::min(objectCap, pool.liveCount(EntityClass::Object));
	return std::min(pool.freeCount(), objectCap - used);
}

std::string readWholeFile(const std::string& path, bool& ok)
{
	std::ifstream in(path, std::ios::binary);
	if (!in) {
		ok = false;
		return {};
	}
	ok = true;
	return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

} // namespace

PlacementRect MapDefinition::bounds() const
{
	PlacementRect rect;
	if (entries.empty()) {
		return rect;
	}

	rect.x1 = rect.x2 = entries.front().tileX;
	rect.y1 = rect.y2 = entries.front().tileY;
	for (const MapEntry& entry : entries) {
		rect.x1 = std::min<int32_t>(rect.x1, entry.tileX);
		rect.y1 = std::min<int32_t>(rect.y1, entry.tileY);
		rect.x2 = std::max<int32_t>(rect.x2, entry.tileX);
		rect.y2 = std::max<int32_t>(rect.y2, entry.tileY);
	}
	// x2/y2 are exclusive, and the max above is the last tile the map occupies.
	++rect.x2;
	++rect.y2;
	return rect;
}

bool MapImportManager::isValidKey(const std::string& key)
{
	if (key.empty() || key.size() > 64) {
		return false;
	}
	for (const char c : key) {
		const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		                (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
		if (!ok) {
			return false;
		}
	}
	// Blocked even though '.' is allowed (map.v2 is a reasonable name): the key
	// becomes a file name in saveMap.
	return key.find("..") == std::string::npos;
}

std::string MapParseReport::summary() const
{
	std::string out = fmt::format("{} accepted", accepted);
	if (rejected() == 0) {
		return out;
	}

	out += fmt::format(", {} rejected (", rejected());
	bool first = true;
	const auto part = [&](const char* label, uint32_t count) {
		if (count == 0) {
			return;
		}
		if (!first) {
			out += ", ";
		}
		out += fmt::format("{} {}", count, label);
		first = false;
	};
	part("malformed", malformed);
	part("off-map", outOfBounds);
	part("unknown item", unknownItem);
	part("bad subtype", badSubtype);
	out += ")";
	return out;
}

std::vector<MapEntry> MapImportManager::parseCode(const std::string& code, int32_t originX,
                                                 int32_t originY, MapParseReport& report)
{
	std::vector<MapEntry> entries;

	// Whitespace is not part of the format; the client strips it before sending
	// (client.js:10928) but a file written by hand will have newlines in it.
	std::string packed;
	packed.reserve(code.size());
	for (const char c : code) {
		if (!std::isspace(static_cast<unsigned char>(c))) {
			packed += c;
		}
	}

	const int32_t tilesX = mapTilesX();
	const int32_t tilesY = mapTilesY();

	// Records are '!'-separated, which is also how a streamed paste arrives one
	// fragment at a time -- so a lone "b=..." parses through the same loop.
	for (std::string_view piece : explodeString(packed, "!")) {
		if (piece.empty()) {
			continue;
		}
		if (piece.substr(0, 2) != "b=") {
			// Anything else on the line (a stray "map=", an editor comment) is
			// not a record and is not an error either.
			continue;
		}
		piece.remove_prefix(2);

		const std::vector<std::string_view> fields = explodeString(piece, ":");
		if (fields.size() != 4 && fields.size() != 5) {
			++report.malformed;
			continue;
		}

		const bool hasSubtype = (fields.size() == 5);
		uint32_t iid = 0, subtype = 0, j = 0, i = 0, rotation = 0;
		bool ok = parseUint(fields[0], iid);
		if (hasSubtype) {
			ok = ok && parseUint(fields[1], subtype);
		}
		ok = ok && parseUint(fields[hasSubtype ? 2 : 1], j);
		ok = ok && parseUint(fields[hasSubtype ? 3 : 2], i);
		ok = ok && parseUint(fields[hasSubtype ? 4 : 3], rotation);

		// The client rejects the same three (client.js:12024), so a record that
		// fails here would not have drawn in the editor either.
		if (!ok || rotation > 3 || iid == 0 || subtype > 255) {
			++report.malformed;
			continue;
		}

		const int64_t tileX = static_cast<int64_t>(j) + originX;
		const int64_t tileY = static_cast<int64_t>(i) + originY;
		if (tileX < 0 || tileY < 0 || tileX >= tilesX || tileY >= tilesY) {
			++report.outOfBounds;
			continue;
		}

		const ObjectData* od = g_objects.resolveMapItem(static_cast<uint16_t>(iid),
		                                               static_cast<uint8_t>(subtype), hasSubtype);
		if (!od) {
			++report.unknownItem;
			continue;
		}

		MapEntry entry;
		entry.od = od;
		entry.tileX = static_cast<uint16_t>(tileX);
		entry.tileY = static_cast<uint16_t>(tileY);
		entry.rotation = static_cast<uint8_t>(rotation);

		// A subtype that picked the object is already applied by createObject
		// (the object's own type carries it). One that picks a TEXTURE has to be
		// applied here, and is the only kind that can be out of range.
		if (hasSubtype && !od->explicitSubtype) {
			if (!subtypeIsRenderable(*od, static_cast<uint8_t>(subtype))) {
				++report.badSubtype;
				continue;
			}
			entry.subtype = static_cast<uint8_t>(subtype);
			entry.appliesSubtype = true;
		}

		entries.push_back(entry);
		++report.accepted;

		if (entries.size() >= MAX_ENTRIES_PER_MAP) {
			fmt::print(fg(fmt::color::yellow),
				">> [maps] record limit ({}) reached; the rest of the code was ignored\n",
				MAX_ENTRIES_PER_MAP);
			break;
		}
	}

	return entries;
}

namespace {

// The header keys a .map file may carry, and the one place they are spelled.
// Anything else in the header is reported rather than ignored: a typo'd
// `respwan = 60000` that silently did nothing is exactly the kind of quiet
// failure the content checks exist to stop.
bool applyAssetHeader(MapDefinition& def, const std::string& key, const std::string& value,
                      const std::string& path)
{
	const auto asBool = [&value] {
		return value == "true" || value == "1" || value == "yes" || value == "on";
	};

	if (key == "key") {
		def.key = value;
	} else if (key == "auto") {
		def.autoPlace = asBool();
	} else if (key == "enabled") {
		def.enabled = asBool();
	} else if (key == "mode") {
		def.modeKey = value;
	} else if (key == "bulldoze") {
		def.bulldozePlayerBuilds = asBool();
	} else if (key == "respawn") {
		def.respawnMs = (value == "off" || value == "never" || value == "none")
			? 0u : static_cast<uint32_t>(std::strtoul(value.c_str(), nullptr, 10));
	} else if (key == "origin") {
		const size_t comma = value.find(',');
		if (comma == std::string::npos) {
			reportDataWarning(path, "origin must be written <tileX>,<tileY>");
			return false;
		}
		def.originX = std::strtol(value.substr(0, comma).c_str(), nullptr, 10);
		def.originY = std::strtol(value.substr(comma + 1).c_str(), nullptr, 10);
	} else {
		reportDataWarning(path, fmt::format("unknown header key '{}'", key));
		return false;
	}
	return true;
}

std::string trimAssetField(const std::string& text)
{
	const size_t first = text.find_first_not_of(" \t\r\n");
	if (first == std::string::npos) {
		return {};
	}
	const size_t last = text.find_last_not_of(" \t\r\n");
	return text.substr(first, last - first + 1);
}

} // namespace

bool MapImportManager::loadAssetFile(const std::string& path)
{
	bool ok = false;
	const std::string text = readWholeFile(path, ok);
	if (!ok) {
		fmt::print(fg(fmt::color::crimson), ">> [maps] could not read '{}'\n", path);
		return false;
	}

	MapDefinition def;
	// The file name is the key unless the header overrides it, so a map can be
	// renamed by renaming its file and nothing else.
	def.key = std::filesystem::path(path).stem().string();
	def.sourceFile = path;
	// A file sitting in the content directory is a declaration that this map is
	// part of the world, the same as a <map> in maps.xml was. A paste written
	// out by !map-save carries an explicit `auto = false` and stays library-only.
	def.autoPlace = true;

	// A line with a '!' in it is record data; everything above the first such
	// line is the header. That is also why prose above the records has always
	// been legal (maps/example_small.txt opens with four lines of it).
	std::istringstream lines(text);
	std::string line;
	std::string code;
	bool inRecords = false;
	while (std::getline(lines, line)) {
		if (!inRecords && line.find('!') == std::string::npos) {
			const std::string trimmed = trimAssetField(line);
			if (trimmed.empty() || trimmed[0] == '#') {
				continue;
			}
			const size_t eq = trimmed.find('=');
			if (eq == std::string::npos) {
				continue; // free prose, as example_small.txt has always had
			}
			applyAssetHeader(def, trimAssetField(trimmed.substr(0, eq)),
			                 trimAssetField(trimmed.substr(eq + 1)), path);
			continue;
		}
		inRecords = true;
		code += line;
	}

	if (!isValidKey(def.key)) {
		fmt::print(fg(fmt::color::crimson),
			">> [maps] '{}' has an unusable key '{}' (letters, digits, . _ - only); skipped\n",
			path, def.key);
		return false;
	}
	if (maps.count(def.key)) {
		fmt::print(fg(fmt::color::yellow),
			">> [maps] '{}' declares key '{}', which is already loaded; skipped\n", path, def.key);
		return false;
	}

	MapParseReport parseReport;
	def.entries = parseCode(code, def.originX, def.originY, parseReport);
	if (def.entries.empty()) {
		fmt::print(fg(fmt::color::yellow), ">> [maps] '{}' parsed to nothing ({})\n",
			def.key, parseReport.summary());
		return false;
	}

	const PlacementRect bounds = def.bounds();
	fmt::print(">> [maps] '{}': {}, {}x{} tiles at {},{}, {}{}\n", def.key, parseReport.summary(),
		bounds.x2 - bounds.x1, bounds.y2 - bounds.y1, bounds.x1, bounds.y1,
		def.respawnMs == 0 ? std::string("one-shot") : fmt::format("respawn {}ms", def.respawnMs),
		!def.enabled ? ", DISABLED"
		             : (def.autoPlace ? ", in the world" : ", library only"));

	maps.emplace(def.key, std::move(def));
	return true;
}

bool MapImportManager::loadAssets()
{
	maps.clear();

	const std::string dir = contentFile("maps");
	convertLegacyDefinitions(contentFile("maps.xml"), dir);

	std::error_code ec;
	if (!std::filesystem::is_directory(dir, ec)) {
		fmt::print(">> No {} directory; no imported maps.\n", dir);
		return true;
	}

	// Sorted, so two maps that share a tile stamp in the same order every boot.
	// World layout may depend on the seed and on nothing else, and a directory
	// iteration order is not a promise the filesystem makes.
	std::vector<std::filesystem::path> files;
	for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
		if (entry.is_regular_file(ec) && entry.path().extension() == ".map") {
			files.push_back(entry.path());
		}
	}
	std::sort(files.begin(), files.end());

	for (const std::filesystem::path& path : files) {
		loadAssetFile(path.string());
	}

	fmt::print(">> [maps] {} map(s) loaded from {}\n", maps.size(), dir);
	return true;
}

uint32_t MapImportManager::convertLegacyDefinitions(const std::string& xmlPath,
                                                   const std::string& assetDir)
{
	pugi::xml_document doc;
	if (!doc.load_file(xmlPath.c_str())) {
		return 0; // no legacy file, which is the expected state
	}
	const pugi::xml_node root = doc.child("maps");
	if (!root) {
		return 0;
	}

	std::error_code ec;
	std::filesystem::create_directories(assetDir, ec);

	const uint32_t fileDefault = root.attribute("respawnMs").as_uint(0);
	uint32_t written = 0;
	uint32_t skipped = 0;

	for (pugi::xml_node node = root.child("map"); node; node = node.next_sibling("map")) {
		MapDefinition def;
		def.key = node.attribute("key").as_string();
		if (def.key.empty() || !isValidKey(def.key)) {
			reportDataWarning(xmlPath, fmt::format(
				"<map key=\"{}\"> cannot be converted: a key must be letters, digits, . _ - only",
				def.key));
			continue;
		}

		const std::string target = fmt::format("{}/{}.map", assetDir, def.key);
		if (std::filesystem::exists(target, ec)) {
			++skipped; // already migrated; the .map file is the live one
			continue;
		}

		def.modeKey = node.attribute("mode").as_string();
		def.originX = node.attribute("originX").as_int(0);
		def.originY = node.attribute("originY").as_int(0);
		def.enabled = node.attribute("enabled").as_bool(true);
		def.autoPlace = node.attribute("auto").as_bool(true);
		def.bulldozePlayerBuilds = node.attribute("bulldozePlayerBuilds").as_bool(true);
		def.respawnMs = node.attribute("respawnMs").as_uint(fileDefault);

		// The records, from wherever this entry kept them. file= was resolved
		// against the executable rather than the content directory, which is one
		// of the things this migration exists to end.
		std::string code;
		if (const std::string sourceFile = node.attribute("file").as_string(); !sourceFile.empty()) {
			bool ok = false;
			code = readWholeFile(sourceFile, ok);
			if (!ok) {
				code = readWholeFile(contentFile(sourceFile), ok);
			}
			if (!ok) {
				fmt::print(fg(fmt::color::crimson),
					">> [maps] '{}' points at '{}', which could not be read; not converted\n",
					def.key, sourceFile);
				continue;
			}
		} else {
			code = node.child_value("code");
			if (code.empty()) {
				code = node.attribute("code").as_string();
			}
		}
		if (code.empty()) {
			fmt::print(fg(fmt::color::yellow),
				">> [maps] '{}' has neither a file nor inline <code>; not converted\n", def.key);
			continue;
		}

		// Parsed on the way through so the asset carries records this build can
		// actually place, and so the origin can be folded in and retired.
		MapParseReport parseReport;
		def.entries = parseCode(code, def.originX, def.originY, parseReport);
		if (def.entries.empty()) {
			fmt::print(fg(fmt::color::yellow),
				">> [maps] '{}' parsed to nothing; not converted ({})\n",
				def.key, parseReport.summary());
			continue;
		}
		def.originX = 0;
		def.originY = 0;

		std::ofstream out(target, std::ios::binary | std::ios::trunc);
		if (!out) {
			fmt::print(fg(fmt::color::crimson), ">> [maps] could not write '{}'\n", target);
			continue;
		}
		out << composeAsset(def);
		if (!out.good()) {
			fmt::print(fg(fmt::color::crimson), ">> [maps] failed writing '{}'\n", target);
			continue;
		}
		++written;
		fmt::print(fg(fmt::color::green), ">> [maps] converted '{}' to {}\n", def.key, target);
	}

	if (written != 0) {
		fmt::print(fg(fmt::color::green) | fmt::emphasis::bold,
			">> [maps] {} map(s) converted out of {}. Each .map file now carries its own settings, "
			"so {} is no longer read for anything and can be deleted.\n",
			written, xmlPath, xmlPath);
	} else if (skipped != 0) {
		fmt::print(fg(fmt::color::yellow),
			">> [maps] {} is still present but all {} of its maps already exist as .map files; "
			"it is not read for anything and can be deleted.\n", xmlPath, skipped);
	}
	return written;
}

void MapImportManager::stampStartupMaps(const std::string& activeModeKey, bool preservePlayerBuilds)
{
	// The MANIFEST, not the library. A map is replayed into a rebuilt world only
	// if it is what the world is made of; anything an admin merely placed once
	// stays placed once. See MapDefinition::autoPlace.
	//
	// Sorted rather than hash order, because two maps sharing a tile must land
	// the same way every time: world layout is allowed to depend on the seed and
	// on nothing else, and unordered_map iteration is not a promise.
	std::vector<const std::string*> manifest;
	for (const auto& [id, def] : maps) {
		if (!def.enabled || !def.autoPlace) {
			continue;
		}
		if (!def.modeKey.empty() && def.modeKey != activeModeKey) {
			continue;
		}
		manifest.push_back(&id);
	}

	std::sort(manifest.begin(), manifest.end(),
		[](const std::string* a, const std::string* b) { return *a < *b; });

	for (const std::string* id : manifest) {
		queueStamp(*id, 0, preservePlayerBuilds);
	}
}

bool MapImportManager::queueStamp(const std::string& id, uint32_t adminGuid,
                                  bool forcePreservePlayerBuilds)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}

	// Anything this map already has standing goes first, so a re-stamp replaces
	// its placement instead of orphaning it. Without this the previous stamp's
	// objects stayed on the map owned by a record nothing could reach any more,
	// and !map-clear could never find them.
	queueRetire(id, adminGuid, /*quiet=*/true);

	Job job;
	job.type = JobType::Stamp;
	job.mapId = id;
	job.adminGuid = adminGuid;
	// One-way override: a caller may only make a stamp gentler than the map's
	// own setting, never more destructive.
	job.bulldozePlayerBuilds = it->second.bulldozePlayerBuilds && !forcePreservePlayerBuilds;
	jobs.push_back(std::move(job));
	return true;
}

bool MapImportManager::queueStampAt(const std::string& id, int32_t tileX, int32_t tileY,
                                    uint32_t adminGuid, std::string& error)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		error = fmt::format("No map '{}'. !map-list shows what is loaded.", id);
		return false;
	}

	const MapDefinition& def = it->second;
	const PlacementRect bounds = def.bounds();
	const int32_t width = bounds.x2 - bounds.x1;
	const int32_t height = bounds.y2 - bounds.y1;

	// Against the FOOTPRINT, not the corner, and refused rather than clipped:
	// the same rule placeStructureAt makes, for the same reason -- half a map is
	// a corrupt world that looks like a real one.
	if (tileX < 0 || tileY < 0 ||
	    tileX + width > MapSize::tilesX() || tileY + height > MapSize::tilesY()) {
		error = fmt::format(
			"'{}' is {}x{} tiles, so at {},{} it would reach {},{} on a {}x{} map. "
			"Move it to at most {},{}.",
			id, width, height, tileX, tileY, tileX + width, tileY + height,
			MapSize::tilesX(), MapSize::tilesY(),
			MapSize::tilesX() - width, MapSize::tilesY() - height);
		return false;
	}

	queueRetire(id, adminGuid, /*quiet=*/true);

	Job job;
	job.type = JobType::Stamp;
	job.mapId = id;
	job.adminGuid = adminGuid;
	job.bulldozePlayerBuilds = def.bulldozePlayerBuilds;
	// The delta from where it was drawn to where it was asked for. The records
	// are left alone, so the same map can be stamped again somewhere else.
	job.offsetX = tileX - bounds.x1;
	job.offsetY = tileY - bounds.y1;
	jobs.push_back(std::move(job));
	return true;
}

MapImportManager::PreviewReport MapImportManager::preview(const std::string& id,
                                                          const int32_t* atTileX,
                                                          const int32_t* atTileY) const
{
	PreviewReport out;

	const auto it = maps.find(id);
	if (it == maps.end()) {
		out.error = fmt::format("No map '{}'.", id);
		return out;
	}
	const MapDefinition& def = it->second;

	const PlacementRect bounds = def.bounds();
	int32_t offsetX = 0, offsetY = 0;
	if (atTileX && atTileY) {
		offsetX = *atTileX - bounds.x1;
		offsetY = *atTileY - bounds.y1;
	}

	out.valid = true;
	out.rect = PlacementRect{ bounds.x1 + offsetX, bounds.y1 + offsetY,
	                          bounds.x2 + offsetX, bounds.y2 + offsetY };
	out.objects = static_cast<uint32_t>(def.entries.size());
	out.idCost = out.objects;
	out.idsFree = mapObjectIdRoom();

	// Counted per TILE rather than per record, so a floor and the wall on it do
	// not report the same obstruction twice.
	std::unordered_set<uint32_t> seen;
	for (const MapEntry& entry : def.entries) {
		const int32_t tx = static_cast<int32_t>(entry.tileX) + offsetX;
		const int32_t ty = static_cast<int32_t>(entry.tileY) + offsetY;
		if (tx < 0 || ty < 0 || tx >= MapSize::tilesX() || ty >= MapSize::tilesY()) {
			++out.offMap;
			continue;
		}
		if (!seen.insert(tileKey(static_cast<uint16_t>(tx), static_cast<uint16_t>(ty))).second) {
			continue;
		}

		if (g_structures.structureAt(tx, ty)) {
			++out.structureTiles;
		}

		const Tile* tile = g_game.map.findTile(tx, ty);
		if (!tile) {
			continue;
		}
		for (Thing* thing : tile->getThings()) {
			if (thing->getResource()) {
				++out.resources;
				break;
			}
			if (const Object* obj = thing->getObject(); obj && obj->getOwnerPid() != 0) {
				++out.playerBuilds;
				break;
			}
		}
	}

	return out;
}

std::string MapImportManager::undoLastStamp(uint32_t adminGuid)
{
	// The most recent MAP placement, whichever map it belongs to. Structures are
	// undone with !structure-remove, which names one.
	const std::vector<const MapInstance*> live = g_placements.list(PlacementSource::Map);
	if (live.empty()) {
		return {};
	}

	const MapInstance* newest = live.front();
	for (const MapInstance* instance : live) {
		if (instance->placedAt >= newest->placedAt) {
			newest = instance;
		}
	}

	const std::string id = newest->assetKey;
	std::vector<uint32_t> victims;
	g_placements.retire(newest->id, victims);
	queueRemoval(std::move(victims), adminGuid, fmt::format("undo of '{}'", id));

	if (const auto it = maps.find(id); it != maps.end()) {
		it->second.stamped = false;
	}
	return id;
}

uint32_t MapImportManager::queueRetire(const std::string& id, uint32_t adminGuid, bool quiet)
{
	Job job;
	job.type = JobType::Clean;
	job.adminGuid = adminGuid;
	job.mapId = id;
	job.quiet = quiet;

	for (const uint32_t instanceId : g_placements.instancesOf(PlacementSource::Map, id)) {
		g_placements.retire(instanceId, job.victims);
	}

	const uint32_t count = static_cast<uint32_t>(job.victims.size());
	if (count == 0 && quiet) {
		return 0; // nothing standing; no point queueing an empty pass
	}
	jobs.push_back(std::move(job));
	return count;
}

MapParseReport MapImportManager::stampCode(const std::string& id, const std::string& code,
                                           uint32_t adminGuid, bool bulldozePlayerBuilds)
{
	MapParseReport parseReport;
	std::vector<MapEntry> entries = parseCode(code, pasteOriginX, pasteOriginY, parseReport);
	if (entries.empty()) {
		return parseReport;
	}

	MapDefinition def;
	def.key = id;
	def.originX = pasteOriginX;
	def.originY = pasteOriginY;
	def.respawnMs = defaultRespawnMs;
	def.bulldozePlayerBuilds = bulldozePlayerBuilds;
	def.entries = std::move(entries);
	// A paste is library-only until an admin says otherwise. Placing it now is
	// what was asked for; replaying it into every world rebuilt from here was
	// not, and is how a pasted map used to reappear after !clean + !seed.
	def.autoPlace = false;

	// Preserve the flag when re-pasting over a map that IS in the manifest: an
	// admin editing a world map in place should not silently demote it.
	if (const auto existing = maps.find(id); existing != maps.end()) {
		def.autoPlace = existing->second.autoPlace;
		def.modeKey = existing->second.modeKey;
		def.sourceFile = existing->second.sourceFile;
	}

	maps[id] = std::move(def);
	lastStampedId = id;
	queueStamp(id, adminGuid);
	return parseReport;
}

bool MapImportManager::clearMap(const std::string& id, uint32_t adminGuid)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}
	queueRetire(id, adminGuid, /*quiet=*/false);
	// Nothing of it is standing any more, so it is not on the respawn cycle
	// either -- otherwise the timer keeps queueing passes that find no placement
	// to top up and pop straight back off.
	it->second.stamped = false;
	return true;
}

bool MapImportManager::forgetMap(const std::string& id, uint32_t adminGuid)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}
	queueRetire(id, adminGuid, /*quiet=*/false);
	maps.erase(it);
	if (lastStampedId == id) {
		lastStampedId.clear();
	}
	return true;
}

bool MapImportManager::setAutoPlace(const std::string& id, bool autoPlace)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}
	it->second.autoPlace = autoPlace;
	return true;
}

void MapImportManager::queueClean(uint32_t adminGuid, bool retireInstances)
{
	Job job;
	job.type = JobType::Clean;
	job.adminGuid = adminGuid;

	if (retireInstances) {
		// Drop every placement record, maps and structures alike. The entities
		// are swept below either way; this is what stops the respawn timers
		// putting them back, and it is the only difference between !clean and
		// !clean-hard.
		std::vector<uint32_t> ignored;
		g_placements.retireAll(ignored);

		// Immediately, not on the next respawn pass: !clean-hard turns that timer
		// off, so waiting for it would leave every demolished building still
		// holding its ground against !structure-place forever.
		g_structures.pruneRetiredStructures();
	}

	// Snapshot ids now, act on them over the next few seconds. Pointers would
	// not survive: the job spans many ticks and anything in it can be destroyed
	// by ordinary play in between.
	for (Thing* thing : g_game.map.getThings()) {
		if (thing->getCreature()) {
			continue; // players and bots are never swept
		}
		if (thing->getObject() || thing->getResource() || thing->getLoot()) {
			job.victims.push_back(thing->getID());
		}
	}

	jobs.push_back(std::move(job));
}

std::string MapImportManager::composeAsset(const MapDefinition& def) const
{
	const PlacementRect bounds = def.bounds();

	std::string out;
	// Header first, then the records. Everything the map needs to load is in
	// here, which is the point: there is no second file to edit.
	out += "# Prevast map asset. Drop it in this directory and it loads.\n";
	out += fmt::format("# {}x{} tiles at {},{}, {} objects.\n",
		bounds.x2 - bounds.x1, bounds.y2 - bounds.y1, bounds.x1, bounds.y1, def.entries.size());
	out += fmt::format("key      = {}\n", def.key);
	out += fmt::format("auto     = {}\n", def.autoPlace ? "true" : "false");
	out += fmt::format("enabled  = {}\n", def.enabled ? "true" : "false");
	out += fmt::format("origin   = {},{}\n", def.originX, def.originY);
	if (!def.modeKey.empty()) {
		out += fmt::format("mode     = {}\n", def.modeKey);
	}
	out += fmt::format("respawn  = {}\n", def.respawnMs);
	out += fmt::format("bulldoze = {}\n", def.bulldozePlayerBuilds ? "true" : "false");
	out += "\n";

	// The editor's own format, origin already folded in, so the records are
	// exactly what the editor's paste button would have produced for this map.
	for (const MapEntry& entry : def.entries) {
		out += fmt::format("!b={}:", entry.od->id);
		if (entry.appliesSubtype) {
			out += fmt::format("{}:", static_cast<uint32_t>(entry.subtype));
		} else if (entry.od->explicitSubtype) {
			out += fmt::format("{}:", static_cast<uint32_t>(entry.od->subtype));
		}
		out += fmt::format("{}:{}:{}", entry.tileX, entry.tileY,
			static_cast<uint32_t>(entry.rotation));
	}
	out += "\n";
	return out;
}

void MapImportManager::queueRemoval(std::vector<uint32_t>&& victims, uint32_t adminGuid,
                                    const std::string& label)
{
	if (victims.empty()) {
		return;
	}

	Job job;
	job.type = JobType::Clean;
	job.adminGuid = adminGuid;
	job.mapId = label;
	job.victims = std::move(victims);
	jobs.push_back(std::move(job));
}

bool MapImportManager::saveMap(const std::string& id, std::string& outPath)
{
	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}
	// The key becomes a file name below. A map named through !map=<name> is
	// whatever an admin typed, so "../../foo" would have written outside the
	// maps directory.
	if (!isValidKey(id)) {
		return false;
	}

	const std::string dir = contentFile("maps");
	std::error_code ec;
	std::filesystem::create_directories(dir, ec);

	outPath = fmt::format("{}/{}.map", dir, id);

	// Written to a temporary and renamed over the target. There is no version
	// control here, so a crash or a full disk part-way through a save would
	// otherwise leave a truncated asset where a working one used to be. The
	// previous version is kept as .bak for the same reason.
	const std::string tempPath = outPath + ".tmp";
	{
		std::ofstream out(tempPath, std::ios::binary | std::ios::trunc);
		if (!out) {
			return false;
		}
		out << composeAsset(it->second);
		if (!out.good()) {
			return false;
		}
	}

	if (std::filesystem::exists(outPath, ec)) {
		std::filesystem::rename(outPath, outPath + ".bak", ec);
	}
	std::filesystem::rename(tempPath, outPath, ec);
	if (ec) {
		std::filesystem::remove(tempPath, ec);
		return false;
	}

	it->second.sourceFile = outPath;
	return true;
}

bool MapImportManager::setRespawnMs(const std::string& id, uint32_t ms)
{
	if (id.empty()) {
		defaultRespawnMs = ms;
		const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
		for (auto& [key, def] : maps) {
			def.respawnMs = ms;
			def.nextRespawnAt = (ms == 0) ? 0 : now + ms;
		}
		return true;
	}

	auto it = maps.find(id);
	if (it == maps.end()) {
		return false;
	}
	it->second.respawnMs = ms;
	it->second.nextRespawnAt = (ms == 0) ? 0 : static_cast<uint64_t>(OTSYS_TIME()) + ms;
	return true;
}

// --- Paste session ---------------------------------------------------------

std::string MapImportManager::nextPasteName()
{
	std::string name;
	do {
		name = fmt::format("paste{}", ++pasteCounter);
	} while (maps.count(name));
	return name;
}

void MapImportManager::beginSession(uint32_t adminGuid, const std::string& name)
{
	if (session.active) {
		commitSession();
	}

	session = Session{};
	session.active = true;
	session.adminGuid = adminGuid;
	// A rejected name falls back to the generated one rather than failing the
	// paste: the admin is mid-paste and the records are already arriving.
	session.name = (name.empty() || !isValidKey(name)) ? nextPasteName() : name;
	session.lastFragmentAt = static_cast<uint64_t>(OTSYS_TIME());
}

bool MapImportManager::feedSession(const std::string& fragment)
{
	if (!session.active) {
		return false;
	}

	session.lastFragmentAt = static_cast<uint64_t>(OTSYS_TIME());
	++session.fragments;

	if (session.code.size() + fragment.size() + 1 > SESSION_MAX_CODE_BYTES) {
		// Stop growing but keep the session alive, so the admin still gets a
		// report instead of silence.
		session.truncated = true;
		return true;
	}

	session.code += '!';
	session.code += fragment;
	return true;
}

void MapImportManager::commitSession()
{
	if (!session.active) {
		return;
	}

	const Session finished = session;
	session = Session{};

	if (finished.code.empty()) {
		report(finished.adminGuid, "Map paste: nothing received.");
		return;
	}

	auto it = maps.find(finished.name);
	const bool bulldoze = (it == maps.end()) ? true : it->second.bulldozePlayerBuilds;

	const MapParseReport parseReport = stampCode(finished.name, finished.code,
	                                             finished.adminGuid, bulldoze);

	std::string message = fmt::format("Map '{}': {}", finished.name, parseReport.summary());
	if (finished.truncated) {
		message += " [TRUNCATED - too large for one paste, use a file]";
	}
	report(finished.adminGuid, message);

	fmt::print(">> [maps] paste '{}' from {} fragments: {}{}\n", finished.name,
		finished.fragments, parseReport.summary(),
		finished.truncated ? " (TRUNCATED)" : "");
}

// --- Timers ----------------------------------------------------------------

void MapImportManager::update()
{
	if (session.active &&
	    static_cast<uint64_t>(OTSYS_TIME()) - session.lastFragmentAt >= SESSION_IDLE_MS) {
		commitSession();
	}

	if (jobs.empty()) {
		return;
	}

	// One slice of one job per call. Jobs stay strictly in order so "!clean
	// then paste" does what it reads like, rather than racing.
	runSlice(jobs.front());
}

void MapImportManager::runSlice(Job& job)
{
	switch (job.type) {
		case JobType::Stamp:   runStampSlice(job); break;
		case JobType::Respawn: runRespawnSlice(job); break;
		case JobType::Clean:   runCleanSlice(job); break;
	}
}

void MapImportManager::drainJobs()
{
	// Every slice either advances its cursor or pops the job, so this always
	// terminates.
	while (!jobs.empty()) {
		runSlice(jobs.front());
	}
}

void MapImportManager::warnOnStructureOverlap() const
{
	struct Rect { int32_t x1, y1, x2, y2; std::string id; };
	std::vector<Rect> rects;

	for (const auto& tracked : g_structures.getSpawnedStructures()) {
		const StructureTemplate* tmpl = g_structures.getTemplate(tracked.templateId);
		if (!tmpl) {
			continue;
		}
		const int32_t x1 = tracked.pos.x / TILE_SIZE;
		const int32_t y1 = tracked.pos.y / TILE_SIZE;
		rects.push_back({x1, y1, x1 + tmpl->width, y1 + tmpl->height, tracked.templateId});
	}

	if (rects.empty()) {
		return;
	}

	for (const auto& [id, def] : maps) {
		if (!def.stamped) {
			continue;
		}
		for (const Rect& rect : rects) {
			uint32_t hits = 0;
			for (const MapEntry& entry : def.entries) {
				const int32_t tx = entry.tileX;
				const int32_t ty = entry.tileY;
				if (tx >= rect.x1 && tx < rect.x2 && ty >= rect.y1 && ty < rect.y2) {
					++hits;
				}
			}
			if (hits == 0) {
				continue;
			}
			fmt::print(fg(fmt::color::yellow),
				">> [maps] WARNING: map '{}' overlaps structure '{}' on {} tile(s) at {},{}. "
				"Both respawn on their own timers and will keep overwriting each other. "
				"Move the map, or turn one off (!respawn-structures=off / "
				"!map-respawn={}:0).\n",
				id, rect.id, hits, rect.x1, rect.y1, id);
		}
	}
}

void MapImportManager::updateRespawn()
{
	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());

	for (auto& [id, def] : maps) {
		if (!def.enabled || def.respawnMs == 0 || !def.stamped) {
			continue;
		}
		if (def.nextRespawnAt == 0) {
			def.nextRespawnAt = now + def.respawnMs;
			continue;
		}
		if (now < def.nextRespawnAt) {
			continue;
		}
		def.nextRespawnAt = now + def.respawnMs;

		// Skip the cycle rather than stack a second pass on a map that is still
		// being stamped -- otherwise a respawn interval shorter than the stamp
		// takes would queue work faster than it drains.
		const bool alreadyQueued = std::any_of(jobs.begin(), jobs.end(),
			[&id](const Job& job) { return job.mapId == id; });
		if (alreadyQueued) {
			continue;
		}

		Job job;
		job.type = JobType::Respawn;
		job.mapId = id;
		jobs.push_back(std::move(job));
	}
}

// --- Job slices ------------------------------------------------------------

void MapImportManager::runStampSlice(Job& job)
{
	auto it = maps.find(job.mapId);
	if (it == maps.end()) {
		jobs.pop_front();
		return;
	}
	const MapDefinition& def = it->second;

	if (job.cursor == 0 && job.instanceId == 0) {
		// Asked once, before anything lands. A map is a bulk consumer like a
		// structure template, and the same argument applies: a stamp that stops
		// halfway leaves a building that looks real and is not, so it is refused
		// whole instead. The old code checked per entry and marked the map
		// stamped anyway, which recorded a partial map as a complete one.
		const uint32_t needed = static_cast<uint32_t>(def.entries.size());
		const uint32_t room = mapObjectIdRoom();
		if (needed > room) {
			const std::string message = fmt::format(
				"Map '{}' needs {} entity ids and only {} are free; nothing was placed. "
				"Clear something first, or raise clientMaxEntityId.", job.mapId, needed, room);
			report(job.adminGuid, message);
			fmt::print(fg(fmt::color::crimson), ">> [maps] {}\n", message);
			jobs.pop_front();
			return;
		}

		job.instanceId = g_placements.open(PlacementSource::Map, job.mapId, def.bounds(),
		                                   job.adminGuid);
	}

	const size_t end = std::min(def.entries.size(), job.cursor + STAMP_ENTRIES_PER_SLICE);
	for (; job.cursor < end; ++job.cursor) {
		placeEntry(def.entries[job.cursor], job, /*isRespawn=*/false);
		if (job.outOfIds) {
			break;
		}
	}

	if (job.cursor >= def.entries.size() || job.outOfIds) {
		// Only a stamp that ran to the end counts as stamped. A map that ran out
		// of ids mid-pass is incomplete, and marking it otherwise put it on the
		// respawn cycle as if it were whole.
		it->second.stamped = !job.outOfIds;
		if (def.respawnMs != 0 && it->second.stamped) {
			it->second.nextRespawnAt = static_cast<uint64_t>(OTSYS_TIME()) + def.respawnMs;
		}
		finishJob(job);
		jobs.pop_front();
	}
}

void MapImportManager::runRespawnSlice(Job& job)
{
	auto it = maps.find(job.mapId);
	if (it == maps.end()) {
		jobs.pop_front();
		return;
	}
	const MapDefinition& def = it->second;

	if (job.cursor == 0 && job.instanceId == 0) {
		// Tops up the placement that is already standing rather than opening a
		// new one, so a wall this restores belongs to the same record a later
		// !map-clear will read.
		const std::vector<uint32_t> live = g_placements.instancesOf(PlacementSource::Map, job.mapId);
		if (live.empty()) {
			// Cleared since the cycle was queued. Nothing to top up, and opening
			// a placement here would resurrect a map an admin removed.
			jobs.pop_front();
			return;
		}
		job.instanceId = live.front();
	}

	const size_t end = std::min(def.entries.size(), job.cursor + STAMP_ENTRIES_PER_SLICE);
	for (; job.cursor < end; ++job.cursor) {
		placeEntry(def.entries[job.cursor], job, /*isRespawn=*/true);
		if (job.outOfIds) {
			break;
		}
	}

	if (job.cursor >= def.entries.size() || job.outOfIds) {
		// Quiet unless it actually did something: this fires on a timer and a
		// settled map has nothing to report every cycle.
		if (job.placed != 0 || job.refilled != 0 || job.outOfIds) {
			fmt::print(">> [maps] '{}' respawn: {} restored, {} refilled, {} blocked{}\n",
				job.mapId, job.placed, job.refilled, job.skipped,
				job.outOfIds ? ", STOPPED (no entity ids left)" : "");
		}
		jobs.pop_front();
	}
}

void MapImportManager::runCleanSlice(Job& job)
{
	const size_t end = std::min(job.victims.size(), job.cursor + CLEAN_THINGS_PER_SLICE);
	for (; job.cursor < end; ++job.cursor) {
		// Re-resolved every slice: the snapshot is minutes old by the end of a
		// big sweep and an id that died meanwhile must not be touched.
		if (Thing* thing = g_game.map.getThingByID(job.victims[job.cursor])) {
			g_game.removeWorldThing(thing);
			++job.removed;
		}
	}

	if (job.cursor >= job.victims.size()) {
		finishJob(job);
		jobs.pop_front();
	}
}

void MapImportManager::placeEntry(const MapEntry& entry, Job& job, bool isRespawn)
{
	const ObjectData& od = *entry.od;
	// The record's drawn coordinates plus wherever this stamp was asked to put
	// them. Zero for every stamp except a !map-place that named a destination.
	const int32_t entryTileX = static_cast<int32_t>(entry.tileX) + job.offsetX;
	const int32_t entryTileY = static_cast<int32_t>(entry.tileY) + job.offsetY;
	if (entryTileX < 0 || entryTileY < 0 ||
	    entryTileX >= MapSize::tilesX() || entryTileY >= MapSize::tilesY()) {
		// Checked up front by queueStampAt, so reaching here means the map was
		// resized under a queued job. Skip the record rather than wrap the
		// coordinate, which Position's uint16 would do silently.
		++job.skipped;
		return;
	}

	const Position pos = g_game.tileCenterPosition(entryTileX, entryTileY);

	if (isRespawn) {
		const TileOccupancy occupancy = inspectTile(pos, od);
		if (occupancy.sameKey) {
			if (refillStorage(occupancy.sameKey)) {
				++job.refilled;
			}
			return;
		}
		if (occupancy.blocked) {
			++job.skipped;
			return;
		}
	}

	int32_t reachX = 0, reachY = 0;
	getFootprintTileReach(&od, entry.rotation, reachX, reachY);

	if (!isRespawn && worldgen::isActive()) {
		// Same rule as the structures: the map asked for this ground, so the
		// resources that fill in afterwards may not take it even if this entry
		// turns out to be unplaceable. See worldgen::claimTile.
		for (int32_t dx = -reachX; dx <= reachX; ++dx) {
			for (int32_t dy = -reachY; dy <= reachY; ++dy) {
				worldgen::claimTile(entryTileX + dx, entryTileY + dy);
			}
		}
	}

	if (!isRespawn) {
		if (!job.bulldozePlayerBuilds) {
			for (int32_t dx = -reachX; dx <= reachX; ++dx) {
				for (int32_t dy = -reachY; dy <= reachY; ++dy) {
					if (holdsPlayerBuild(g_game.tileCenterPosition(entryTileX + dx, entryTileY + dy))) {
						++job.skipped;
						return;
					}
				}
			}
		}
	}

	// Asked BEFORE anything is bulldozed. On exhaustion the tile is then left
	// exactly as it was, rather than cleared for an object that never arrives.
	if (!g_game.map.getEntityIdPool().canAcquire(EntityClass::Object)) {
		job.outOfIds = true;
		++job.failed;
		return;
	}

	if (!isRespawn) {
		// Whole footprint, or a multi-tile object lands overlapping its
		// neighbour. Once per tile per job: a tile legitimately takes several
		// records (a floor and the wall on it), and clearing again would delete
		// what an earlier record just placed.
		for (int32_t dx = -reachX; dx <= reachX; ++dx) {
			for (int32_t dy = -reachY; dy <= reachY; ++dy) {
				const int32_t tx = entryTileX + dx;
				const int32_t ty = entryTileY + dy;
				if (tx < 0 || ty < 0) {
					continue;
				}
				const uint32_t key = tileKey(static_cast<uint16_t>(tx), static_cast<uint16_t>(ty));
				if (job.clearedTiles.insert(key).second) {
					g_game.clearTile(g_game.tileCenterPosition(tx, ty));
				}
			}
		}
	}

	Object* obj = g_objects.createObject(od.key, pos, entry.rotation);
	if (!obj) {
		job.outOfIds = true;
		++job.failed;
		return;
	}

	// Fixed, so Game::updateSubtypes leaves it alone: the editor recorded an
	// exact texture and the map should look the way it was drawn. Floors carry
	// no subtype in the format, so they stay unfixed and autotile against their
	// neighbours exactly like a player-built floor.
	if (entry.appliesSubtype) {
		obj->setSubtype(entry.subtype, /*fixed=*/true);
	}

	// Owner 0: world-owned, like a city. Raidable by anyone, counts against
	// nobody's build footprint, and eligible for the respawn cycle.
	if (!g_game.placeThing(obj, pos)) {
		delete obj;
		++job.failed;
		return;
	}

	// Written down here, at the one point the object is known to be on the map.
	// Everything that later asks "is this ours?" reads this record.
	g_placements.record(job.instanceId, obj->getID());

	++job.placed;
}

void MapImportManager::finishJob(const Job& job)
{
	if (job.quiet) {
		return;
	}

	std::string message;

	if (job.type == JobType::Clean) {
		message = job.mapId.empty()
			? fmt::format("Cleaned {} entities.", job.removed)
			: fmt::format("Map '{}' cleared: {} objects removed.", job.mapId, job.removed);
	} else {
		message = fmt::format("Map '{}': {} placed", job.mapId, job.placed);
		if (job.skipped != 0) {
			message += fmt::format(", {} skipped", job.skipped);
		}
		if (job.failed != 0) {
			message += fmt::format(", {} failed", job.failed);
		}
		if (job.outOfIds) {
			message += " [OUT OF ENTITY IDS - map is incomplete]";
		}
	}

	report(job.adminGuid, message);
	fmt::print(">> [maps] {}\n", message);
}

void MapImportManager::report(uint32_t adminGuid, const std::string& message) const
{
	if (adminGuid == 0) {
		return; // startup or console-driven work; the fmt::print is the report
	}
	Player* admin = g_game.getPlayerByGUID(adminGuid);
	if (!admin) {
		return;
	}
	if (auto client = admin->getProtocolGame()) {
		client->sendAdminReply(message);
	}
}
