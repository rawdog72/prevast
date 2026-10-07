// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/trade.h"

#include "content/contentexport.h"

#include "content/xml_utils.h"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fmt/color.h>
#include <fmt/format.h>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>

namespace contentexport {
namespace {

namespace json = boost::json;

// parent>child pairs that are always arrays. A repeated pair not listed here
// is an export error rather than a silent shape change.
const std::set<std::string> ARRAY_PAIRS = {
	"recipe>ingredient", "stations>station", "craftBonus>item", "drops>item", "items>item", "contents>item",
	"tools>tool", "types>type", "areaEffects>areaEffect", "consumable>effect", "modifiers>modifier",
	"damageModifiers>modifier", "mods>slot", "mod>stat", "modArt>anchor", "stages>stage", "condition>stage", "brain>target", "abilities>ability",
	"karma>level", "gauges>gauge", "spawns>spawn", "spawn>structure", "spawn>agent", "ghoulRules>ghoul",
	"achievement>requires", "achievement>reward",
	"client>loot", "client>sound", "client>frame", "client>broken", "client>offset", "client>swing",
	"client>light", "client>on", "client>top", "client>hidden", "client>deployed", "client>wire",
	"client>variant", "client>type",
};

// Never copied from a base= entry (matches object.cpp / game.cpp).
const std::set<std::string> NON_INHERITED = {"key", "abstract", "base", "itemKey"};

json::value parseScalar(std::string_view name, std::string_view value)
{
	if (xml_utils::detail::isNameAttribute(name)) return json::string(value);
	if (value == "true") return true;
	if (value == "false") return false;
	if (xml_utils::detail::isNumber(value)) {
		const std::string text(value);
		if (text.find_first_of(".eE") == std::string::npos) return json::value(static_cast<int64_t>(std::stoll(text)));
		const double number = std::stod(text);
		if (!std::isfinite(number)) throw std::runtime_error("non-finite content number: " + text);
		return json::value(number);
	}
	return json::string(value);
}

json::object elementToObject(const pugi::xml_node& node, const std::string& path)
{
	json::object out;
	for (pugi::xml_attribute attr : node.attributes()) {
		out[attr.name()] = parseScalar(attr.name(), attr.value());
	}

	std::vector<std::string> order;
	std::map<std::string, json::array> groups;
	std::string text;
	for (pugi::xml_node child : node.children()) {
		if (child.type() == pugi::node_element) {
			auto it = groups.find(child.name());
			if (it == groups.end()) {
				order.emplace_back(child.name());
				it = groups.emplace(child.name(), json::array()).first;
			}
			it->second.push_back(elementToObject(child, path + "/" + child.name()));
		} else if (child.type() == pugi::node_pcdata || child.type() == pugi::node_cdata) {
			text += child.value();
		}
	}
	for (const std::string& tag : order) {
		json::array& list = groups[tag];
		if (out.contains(tag)) throw std::runtime_error(path + ": attribute/child collision " + tag);
		const std::string pair = std::string(node.name()) + ">" + tag;
		if (ARRAY_PAIRS.count(pair)) {
			out[tag] = std::move(list);
		} else if (list.size() == 1) {
			out[tag] = std::move(list[0]);
		} else {
			throw std::runtime_error(fmt::format("{}: <{}> occurs {}x under <{}> but '{}' is not in ARRAY_PAIRS",
				path, tag, list.size(), node.name(), pair));
		}
	}

	const size_t first = text.find_first_not_of(" \t\r\n");
	if (first != std::string::npos) {
		if (out.contains("text")) throw std::runtime_error(path + ": attribute/text collision");
		const size_t last = text.find_last_not_of(" \t\r\n");
		out["text"] = text.substr(first, last - first + 1);
	}
	return out;
}

struct Raw {
	std::string key;
	bool abstract = false;
	std::string base;
	json::object object;
};

json::object resolveInheritance(const std::vector<Raw>& raw, const std::string& fileName)
{
	std::map<std::string, json::object> resolved; // abstract entries stay resolvable
	json::object out;
	for (const Raw& entry : raw) {
		json::object merged;
		if (!entry.base.empty()) {
			auto base = resolved.find(entry.base);
			if (base == resolved.end()) {
				throw std::runtime_error(fmt::format("{}: '{}' has base=\"{}\" which is not declared above it",
					fileName, entry.key, entry.base));
			}
			for (const auto& kv : base->second) {
				if (!NON_INHERITED.count(std::string(kv.key()))) merged[kv.key()] = kv.value();
			}
			for (const auto& kv : entry.object) merged[kv.key()] = kv.value();
		} else {
			merged = entry.object;
		}
		merged.erase("base");
		merged.erase("abstract");
		resolved[entry.key] = merged;
		if (entry.abstract) continue;
		if (out.contains(entry.key)) {
			throw std::runtime_error(fmt::format("{}: duplicate key '{}'", fileName, entry.key));
		}
		out[entry.key] = merged;
	}
	return out;
}

// Keys sorted recursively, so serialize() yields the canonical text the hash is taken over.
json::value canonical(const json::value& value)
{
	if (value.is_object()) {
		std::vector<std::pair<std::string, const json::value*>> items;
		for (const auto& kv : value.get_object()) items.emplace_back(std::string(kv.key()), &kv.value());
		std::sort(items.begin(), items.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
		json::object out;
		for (const auto& [key, item] : items) out[key] = canonical(*item);
		return out;
	}
	if (value.is_array()) {
		json::array out;
		for (const json::value& item : value.get_array()) out.push_back(canonical(item));
		return out;
	}
	return value;
}

uint64_t fnv1a64(std::string_view text)
{
	uint64_t hash = 0xcbf29ce484222325ULL;
	for (const unsigned char c : text) {
		hash ^= c;
		hash *= 0x100000001b3ULL;
	}
	return hash;
}

} // namespace

const std::vector<TableSpec>& tables()
{
	static const std::vector<TableSpec> specs = {
		{"npcs", "npcs.xml", "npcs", "npc", "id"},
		{"skills",      "skills.xml",      "skills",      "skill",      nullptr},
		{"items",       "items.xml",       "items",       "item",       "clientItemId"},
		{"resources",   "resources.xml",   "resources",   "resource",   "id"},
		{"equipables",  "equipables.xml",  "equipables",  "equipable",  "idWeapon"},
		{"mods",        "mods.xml",        "mods",        "mod",        nullptr},
		{"wearables",   "wearables.xml",   "wearables",   "wearable",   "skinId"},
		{"kits",        "kits.xml",        "kits",        "kit",        nullptr},
		{"objects",     "objects.xml",     "objects",     "object",     nullptr},
		{"furnitures",  "furnitures.xml",  "objects",     "object",     nullptr},
		{"projectiles", "projectiles.xml", "projectiles", "projectile", "clientProjectileId"},
		{"agents",      "agents.xml",      "agents",      "agent",      "sprite"},
		{"structures",  "structures.xml",  "structures",  "template",   nullptr},
		{"conditions",  "conditions.xml",  "conditions",  "condition",  nullptr},
		{"modes",       "modes.xml",       "modes",       "mode",       "clientModeId"},
		{"stats",        "stats.xml",        "stats",        "stat",        "id"},
		{"achievements", "achievements.xml", "achievements", "achievement", "id"},
	};
	return specs;
}

json::object exportTable(const TableSpec& spec, const std::string& fileName)
{
	pugi::xml_document doc;
	const auto root = content_files::load(doc, fileName, spec.root);

	json::object attributes;
	for (pugi::xml_attribute attr : root.attributes()) attributes[attr.name()] = parseScalar(attr.name(), attr.value());

	std::vector<Raw> raw;
	size_t index = 0;
	for (pugi::xml_node node = root.child(spec.entry); node; node = node.next_sibling(spec.entry)) {
		Raw entry;
		if (std::string(spec.name) == "npcs") {
            for (auto name : {"key", "id", "name", "rangeTiles"})
                if (auto a = node.attribute(name)) entry.object[name] = parseScalar(name, a.value());
            if (auto client = node.child("client")) entry.object["client"] = elementToObject(client, "npc/client");
        } else if (std::string(spec.name) == "stats" || std::string(spec.name) == "achievements") {
			// Stats keep no <count> rules; a secret achievement keeps nothing but
			// its identity. Same rule as tools/content/xml-to-json.ts.
			pugi::xml_document publicDoc;
			pugi::xml_node copy = publicDoc.append_copy(node);
			const bool secret = std::string(spec.name) == "achievements" && std::string(node.attribute("secret").as_string()) == "true";
			if (std::string(spec.name) == "stats" || secret) {
				while (pugi::xml_node child = copy.first_child()) copy.remove_child(child);
			}
			if (secret) {
				copy.remove_attribute("name");
				copy.remove_attribute("description");
			}
			entry.object = elementToObject(copy, fmt::format("{}/{}[{}]", fileName, spec.entry, index));
        } else entry.object = elementToObject(node, fmt::format("{}/{}[{}]", fileName, spec.entry, index));
		const json::value* key = entry.object.if_contains("key");
		if (std::string(spec.name) != "kits" && (!key || !key->is_string() || key->get_string().empty()))
			throw std::runtime_error(fileName + ": missing entry key");
		entry.key = key && key->is_string() ? std::string(key->get_string()) : std::to_string(index);
		const json::value* abstract = entry.object.if_contains("abstract");
		entry.abstract = abstract && abstract->is_bool() && abstract->get_bool();
		const json::value* base = entry.object.if_contains("base");
		if (base && base->is_string()) entry.base = std::string(base->get_string());
		raw.push_back(std::move(entry));
		++index;
	}

	json::object entries = resolveInheritance(raw, fileName);
	if (spec.idAttribute) {
		for (auto& kv : entries) {
			json::object& entry = kv.value().as_object();
			const json::value* id = entry.if_contains(spec.idAttribute);
			if (!id || !(id->is_int64() || id->is_double())) {
				throw std::runtime_error(fmt::format("{}: entry '{}' has no numeric {}", fileName, kv.key(), spec.idAttribute));
			}
			const double number = id->is_int64() ? static_cast<double>(id->get_int64()) : id->get_double();
			if (!std::isfinite(number) || number < 0 || number > 9007199254740991.0 || std::floor(number) != number)
				throw std::runtime_error(fileName + ": invalid numeric id");
			entry["id"] = *id;
		}
	}

	json::object body;
	body["attributes"] = attributes;
	body["entries"] = entries;
	const std::string canonicalText = json::serialize(canonical(body));

	json::object table;
	table["name"] = spec.name;
	table["version"] = 1;
	table["hash"] = fmt::format("{:016x}", fnv1a64(canonicalText));
	table["attributes"] = std::move(attributes);
	table["entries"] = std::move(entries);
	return table;
}

bool exportAll(const std::string& xmlDir, const std::string& outDir)
{
	std::filesystem::create_directories(outDir);
	bool ok = true;
	for (const TableSpec& spec : tables()) {
		try {
			const json::object table = exportTable(spec, xmlDir + "/" + spec.file);
			std::ofstream out(outDir + "/" + spec.name + ".json", std::ios::binary);
			if (!out) throw std::runtime_error(fmt::format("cannot write {}/{}.json", outDir, spec.name));
			out << json::serialize(table) << '\n';
			out.flush();
			if (!out) throw std::runtime_error("failed writing content table: " + std::string(spec.name));
			fmt::print("{}: {} entries, hash {}\n", spec.name,
				table.at("entries").as_object().size(), table.at("hash").as_string().c_str());
		} catch (const std::exception& e) {
			fmt::print(fmt::fg(fmt::color::crimson) | fmt::emphasis::bold, ">> [Error] {}\n", e.what());
			ok = false;
		}
	}
	return ok;
}

boost::json::value diffMergePatch(const boost::json::value& from, const boost::json::value& to)
{
	if (!from.is_object() || !to.is_object()) {
		return to;
	}
	const auto& fromObj = from.as_object();
	const auto& toObj = to.as_object();
	boost::json::object patch;

	for (const auto& kv : fromObj) {
		if (!toObj.contains(kv.key())) {
			patch[kv.key()] = nullptr;
		}
	}

	for (const auto& kv : toObj) {
		auto it = fromObj.find(kv.key());
		if (it == fromObj.end()) {
			patch[kv.key()] = kv.value();
		} else if (it->value().is_object() && kv.value().is_object()) {
			boost::json::value inner = diffMergePatch(it->value(), kv.value());
			if (inner.is_object() && !inner.as_object().empty()) {
				patch[kv.key()] = inner;
			}
		} else if (it->value() != kv.value()) {
			patch[kv.key()] = kv.value();
		}
	}

	return patch;
}

boost::json::object ContentManager::exportConfigTable(const std::string& configLuaPath, const boost::json::object& modesTable)
{
	std::map<std::string, std::string> luaValues;
	std::ifstream file(configLuaPath);
	if (file.is_open()) {
		std::string line;
		while (std::getline(file, line)) {
			size_t start = line.find_first_not_of(" \t");
			if (start == std::string::npos || line[start] == '-') continue;
			size_t eq = line.find('=', start);
			if (eq == std::string::npos) continue;
			std::string key = line.substr(start, eq - start);
			size_t keyEnd = key.find_last_not_of(" \t");
			if (keyEnd != std::string::npos) key = key.substr(0, keyEnd + 1);

			std::string val = line.substr(eq + 1);
			size_t valStart = val.find_first_not_of(" \t");
			if (valStart != std::string::npos) val = val.substr(valStart);
			size_t comment = val.find("--");
			if (comment != std::string::npos) val = val.substr(0, comment);
			size_t semi = val.find(';');
			if (semi != std::string::npos) val = val.substr(0, semi);
			size_t valEnd = val.find_last_not_of(" \t\r\n");
			if (valEnd != std::string::npos) val = val.substr(0, valEnd + 1);

			if (val.size() >= 2 && ((val.front() == '"' && val.back() == '"') || (val.front() == '\'' && val.back() == '\''))) {
				val = val.substr(1, val.size() - 2);
			}
			luaValues[key] = val;
		}
	}

	std::string modeKey = luaValues.count("gameMode") ? luaValues["gameMode"] : "survival";
	int64_t maxPlayers = luaValues.count("maxPlayers") ? std::stoll(luaValues["maxPlayers"]) : 255;
	int64_t mapWidth = luaValues.count("mapTilesX") ? std::stoll(luaValues["mapTilesX"]) : 150;
	int64_t mapHeight = luaValues.count("mapTilesY") ? std::stoll(luaValues["mapTilesY"]) : 150;
	int64_t clanActionDelayMs = luaValues.count("clanActionDelay") ? std::stoll(luaValues["clanActionDelay"]) : 2000;

	int64_t dayCycleMs = 960000;
	double craftSpeed = 1.0;
	int64_t maxClans = 0;
	int64_t clanSize = 0;

	if (modesTable.contains("entries") && modesTable.at("entries").is_object()) {
		const auto& entries = modesTable.at("entries").as_object();
		auto it = entries.find(modeKey);
		if (it != entries.end() && it->value().is_object()) {
			const auto& m = it->value().as_object();
			if (m.contains("dayNightCycle")) {
				dayCycleMs = m.at("dayNightCycle").as_int64();
			}
			if (m.contains("craftSpeed")) {
				const auto& cs = m.at("craftSpeed");
				craftSpeed = cs.is_double() ? cs.as_double() : (cs.is_int64() ? static_cast<double>(cs.as_int64()) : 1.0);
			}
			if (m.contains("clans") && m.at("clans").is_object()) {
				const auto& clans = m.at("clans").as_object();
				if (clans.contains("maxClans")) maxClans = clans.at("maxClans").as_int64();
				if (clans.contains("maxMembers")) clanSize = clans.at("maxMembers").as_int64();
			}
		}
	}

	json::object entries;
	entries["mode"] = modeKey;
	entries["maxPlayers"] = maxPlayers;
	entries["maxClans"] = maxClans;
	entries["clanSize"] = clanSize;
	entries["clanNameMaxLength"] = 5;
	entries["clanActionDelayMs"] = clanActionDelayMs;
	entries["mapWidth"] = mapWidth;
	entries["mapHeight"] = mapHeight;
	entries["tileSize"] = 100;
	entries["dayCycleMs"] = dayCycleMs;
	if (std::floor(craftSpeed) == craftSpeed) {
		entries["craftSpeed"] = static_cast<int64_t>(craftSpeed);
	} else {
		entries["craftSpeed"] = craftSpeed;
	}
	entries["inventorySlots"] = 8;
	entries["chatMaxLength"] = 200;
	entries["nicknameMaxLength"] = 16;
	entries["passwordMaxLength"] = 16;
	entries["xpStart"] = 900;
	entries["xpGrowth"] = 1.105;
	entries["maxLevel"] = 200;
	entries["craftQueueSize"] = 4;
	entries["chestMaxSlots"] = 64;
	entries["interactionRange"] = 150;
	entries["lootPickupRange"] = 200;
	entries["tradeRangeTiles"] = TRADE_RANGE_TILES;
	entries["fuelMaxUnits"] = 254; // game.cpp playerAddFuel: currentFuelUnits >= 254 is full

	json::object body;
	body["attributes"] = json::object{};
	body["entries"] = entries;
	const std::string canonicalText = json::serialize(canonical(body));

	json::object table;
	table["name"] = "config";
	table["version"] = 1;
	table["hash"] = fmt::format("{:016x}", fnv1a64(canonicalText));
	table["attributes"] = json::object{};
	table["entries"] = std::move(entries);
	return table;
}

void ContentManager::init(const std::string& xmlDir, const std::string& configLuaPath)
{
	std::lock_guard<std::mutex> lock(contentMutex);
	xmlDirectory = xmlDir;
	configPath = configLuaPath;
	storedTables.clear();

	for (const TableSpec& spec : tables()) {
		try {
			json::object table = exportTable(spec, xmlDir + "/" + spec.file);
			std::string hash = std::string(table.at("hash").as_string());
			storedTables[spec.name] = StoredTable{spec.name, 1, hash, std::move(table)};
		} catch (const std::exception& e) {
			fmt::print(fmt::fg(fmt::color::crimson) | fmt::emphasis::bold,
				">> [ContentManager] Error exporting {}: {}\n", spec.name, e.what());
		}
	}

	auto modesIt = storedTables.find("modes");
	if (modesIt != storedTables.end()) {
		try {
			json::object cfg = exportConfigTable(configLuaPath, modesIt->second.table);
			std::string hash = std::string(cfg.at("hash").as_string());
			storedTables["config"] = StoredTable{"config", 1, hash, std::move(cfg)};
		} catch (const std::exception& e) {
			fmt::print(fmt::fg(fmt::color::crimson) | fmt::emphasis::bold,
				">> [ContentManager] Error exporting config: {}\n", e.what());
		}
	}
	fmt::print(">> [ContentManager] Loaded {} content tables\n", storedTables.size());
}

std::string ContentManager::getManifestJson() const
{
	std::lock_guard<std::mutex> lock(contentMutex);
	json::object root;
	root["protocol"] = 1;
	json::object tablesObj;
	for (const auto& [name, st] : storedTables) {
		json::object t;
		t["version"] = st.version;
		t["hash"] = st.hash;
		tablesObj[name] = t;
	}
	root["tables"] = tablesObj;
	return json::serialize(root);
}

std::string ContentManager::getTableJson(const std::string& name) const
{
	std::lock_guard<std::mutex> lock(contentMutex);
	auto it = storedTables.find(name);
	if (it == storedTables.end()) return {};
	return json::serialize(it->second.table);
}

std::string ContentManager::getCombinedHash() const
{
	std::lock_guard<std::mutex> lock(contentMutex);
	std::string text;
	for (const auto& [name, st] : storedTables) {
		text += name + ":" + st.hash + ";";
	}
	return fmt::format("{:016x}", fnv1a64(text));
}

std::vector<ContentPatch> ContentManager::reloadTable(const std::string& name, const std::string& xmlDir)
{
	std::lock_guard<std::mutex> lock(contentMutex);
	std::vector<ContentPatch> patches;

	if (name == "config") {
		auto modesIt = storedTables.find("modes");
		if (modesIt == storedTables.end()) return patches;
		json::object newTable = exportConfigTable(configPath, modesIt->second.table);
		std::string newHash = std::string(newTable.at("hash").as_string());
		auto it = storedTables.find("config");
		if (it != storedTables.end()) {
			if (it->second.hash != newHash) {
				uint32_t fromV = it->second.version;
				uint32_t toV = fromV + 1;
				newTable["version"] = toV;
				json::value patch = diffMergePatch(it->second.table.at("entries"), newTable.at("entries"));
				it->second.version = toV;
				it->second.hash = newHash;
				it->second.table = newTable;
				patches.push_back(ContentPatch{"config", fromV, toV, newHash, std::move(patch)});
			}
		}
		return patches;
	}

	const TableSpec* foundSpec = nullptr;
	for (const TableSpec& spec : tables()) {
		if (spec.name == name) {
			foundSpec = &spec;
			break;
		}
	}
	if (!foundSpec) return patches;

	const std::string dir = xmlDir.empty() ? xmlDirectory : xmlDir;
	try {
		json::object newTable = exportTable(*foundSpec, dir + "/" + foundSpec->file);
		std::string newHash = std::string(newTable.at("hash").as_string());
		auto it = storedTables.find(name);
		if (it != storedTables.end()) {
			if (it->second.hash != newHash) {
				uint32_t fromV = it->second.version;
				uint32_t toV = fromV + 1;
				newTable["version"] = toV;
				json::value patch = diffMergePatch(it->second.table.at("entries"), newTable.at("entries"));
				it->second.version = toV;
				it->second.hash = newHash;
				it->second.table = newTable;
				patches.push_back(ContentPatch{name, fromV, toV, newHash, std::move(patch)});
			}
		} else {
			storedTables[name] = StoredTable{name, 1, newHash, newTable};
		}
	} catch (const std::exception& e) {
		fmt::print(">> [ContentManager] Reload failed for {}: {}\n", name, e.what());
	}

	return patches;
}

std::vector<ContentPatch> ContentManager::reloadAll(const std::string& xmlDir)
{
	std::vector<ContentPatch> allPatches;
	for (const TableSpec& spec : tables()) {
		auto p = reloadTable(spec.name, xmlDir);
		allPatches.insert(allPatches.end(), p.begin(), p.end());
	}
	auto cp = reloadTable("config", xmlDir);
	allPatches.insert(allPatches.end(), cp.begin(), cp.end());
	return allPatches;
}

} // namespace contentexport

