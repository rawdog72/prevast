// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/item.h"
#include "gameplay/object.h" // g_objects: crafting station key -> area id
#include "core/tools.h"
#include "content/xml_utils.h"
#include <fmt/format.h>
#include <set>
#include <fmt/color.h>

uint16_t Item::autoItemUid = 1;

// Crafting station key -> client Area ID.
//
// The pairs come from objects.xml, where a station is actually defined; this
// used to be a second copy of them written as a C++ literal, so adding a station
// meant editing code and the two could disagree without anything noticing. The
// ids match the AREAS enum in client.js.
//
// "player" is the one key with no object behind it -- area 0 is the player's own
// hand-craft menu, not a thing standing in the world -- so it stays here.
//
// Objects load AFTER items, which is why this cannot run during the items parse:
// see ItemManager::resolveStationAreas.
static bool lookupStationArea(const std::string& key, uint8_t& areaId)
{
	if (key == "player") {
		areaId = 0;
		return true;
	}
	return g_objects.getStationAreaId(key, areaId);
}

uint16_t Item::allocUid()
{
	if (autoItemUid == 0) {
		autoItemUid = 1;
	}
	return autoItemUid++;
}

Item::Item(uint16_t iid, uint8_t count, const ItemState& state) :
	Item(iid, count, state, allocUid()) {}

Item::Item(uint16_t iid, uint8_t count, const ItemState& state, uint16_t uid) :
	uid(uid), iid(iid), count(count), ammo(state.ammo), lastSyncedAmmo(state.ammo), mods(state.mods),
	data(ItemManager::getInstance().getItemData(iid)) {

	if (data && data->decayTimeMs > 0) {
		decayProgressMs = (static_cast<uint32_t>(255 - ammo) * data->decayTimeMs) / 255;
	}
}

void Item::setAmmo(uint8_t a)
{
	ammo = a;
	if (data && data->decayTimeMs > 0) {
		decayProgressMs = (static_cast<uint32_t>(255 - ammo) * data->decayTimeMs) / 255;
	}
}

// <crafting>: the recipe, the stations it can be made at, and the extractor job
// that is a station with no recipe. Ingredient keys are resolved to iids in the
// second pass, once every item is known.
static void parseCrafting(const pugi::xml_node& craft, ItemData& idata, const std::string& filename)
{
	idata.isCraftable = true;
	idata.crafting.yield = static_cast<uint8_t>(craft.attribute("yield").as_uint(1));

	if (pugi::xml_node recipe = craft.child("recipe")) {
		for (pugi::xml_node ingNode = recipe.child("ingredient"); ingNode; ingNode = ingNode.next_sibling("ingredient")) {
			RecipeIngredient ing;
			ing.itemKey = ingNode.attribute("itemKey").as_string();
			ing.amount = ingNode.attribute("amount").as_int();
			idata.crafting.recipe.push_back(ing);
		}
	}

	if (pugi::xml_node stations = craft.child("stations")) {
		for (pugi::xml_node stNode = stations.child("station"); stNode; stNode = stNode.next_sibling("station")) {
			CraftingStation st;
			st.key = stNode.attribute("key").as_string();
			st.timeMs = stNode.attribute("timeMs").as_uint();
			// st.id is filled by resolveStationAreas once objects.xml is loaded.
			idata.crafting.stations.push_back(st);
		}
	}

	// <extractor> is a station job with no recipe. Registering it as a
	// CraftingStation is what makes it reachable at all: the craft path
	// only accepts an item whose station list contains the area the
	// player has open, so an extractable mineral with no entry here is
	// silently rejected and the button does nothing.
	if (pugi::xml_node extractorNode = craft.child("extractor")) {
		idata.extractor.timeMs = extractorNode.attribute("timeMs").as_uint();
		idata.extractor.outputMin = static_cast<uint16_t>(extractorNode.attribute("outputMin").as_uint(1));
		idata.extractor.outputMax = static_cast<uint16_t>(extractorNode.attribute("outputMax").as_uint(idata.extractor.outputMin));
		if (idata.extractor.outputMax < idata.extractor.outputMin) {
			reportDataWarning(filename, fmt::format("item '{}' has outputMax < outputMin; clamping to outputMin", idata.key));
			idata.extractor.outputMax = idata.extractor.outputMin;
		}

		CraftingStation st;
		st.key = "extractor";
		st.timeMs = idata.extractor.timeMs;
		st.isExtraction = true;
		idata.crafting.stations.push_back(st);
	}
}

// Fills in every CraftingStation::id, and must run after objects.xml is loaded:
// that file is where a station key gets its area, and items load first.
//
// A station that does not resolve is DROPPED rather than left at id 0. Zero is
// the player's hand-craft area, so keeping it would silently turn the recipe
// into a free one craftable anywhere -- the opposite of the intended failure.
void ItemManager::resolveStationAreas(const std::string& filename)
{
	size_t dropped = 0;
	size_t total = 0;

	for (auto& [id, idata] : itemDataMap) {
		auto& stations = idata.crafting.stations;
		total += stations.size();
		for (CraftingStation& st : stations) {
			if (!lookupStationArea(st.key, st.id)) {
				st.id = INVALID_STATION_AREA;
				reportDataWarning(filename, fmt::format(
					"item '{}' names crafting station '{}', which no object in objects.xml declares; "
					"that recipe is unreachable", idata.key, st.key));
			}
		}
		const size_t before = stations.size();
		std::erase_if(stations, [](const CraftingStation& st) { return st.id == INVALID_STATION_AREA; });
		dropped += before - stations.size();
	}

	// The "N station entries" line printed at load counts what was PARSED, and
	// resolution happens here -- so without this the log would still claim every
	// entry survived while some were just thrown away.
	if (dropped != 0) {
		reportDataWarning(filename, fmt::format(
			"{} of {} station entries were dropped; those recipes cannot be crafted anywhere",
			dropped, total));
	}
}

bool ItemManager::loadFromXml(const std::string& filename)
{
	// skills.xml first: the craft window's skill tabs, which an item joins by
	// <skill type=>. It is a declaration the server only checks against --
	// a type outside it lands the item in no tab on the client -- but it is
	// opened here through openDataFile so the manifest sees it load in order
	// and the exporter has the same file to hand to the client.
	std::set<std::string> skillTabs;
	{
		pugi::xml_document skillsDoc;
		const std::string skillsFile = contentFile("skills.xml");
		const pugi::xml_node skillsRoot = xml_utils::openDataFile(skillsDoc, skillsFile, "skills");
		if (!skillsRoot) return false;
		for (pugi::xml_node node = skillsRoot.child("skill"); node; node = node.next_sibling("skill")) {
			const std::string key = node.attribute("key").as_string();
			if (key.empty()) {
				reportDataWarning(skillsFile, "a <skill> has no key=");
				continue;
			}
			if (!skillTabs.insert(key).second) {
				reportDataWarning(skillsFile, fmt::format("skill tab '{}' is declared twice", key));
			}
		}
	}

	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "items");
	if (!root) return false;

	for (pugi::xml_node itemNode = root.child("item"); itemNode; itemNode = itemNode.next_sibling("item")) {
		ItemData idata;
		idata.id = itemNode.attribute("clientItemId").as_int();
		idata.key = itemNode.attribute("key").as_string();
		idata.name = itemNode.attribute("name").as_string();
		idata.currencyValue = itemNode.child("currency").attribute("value").as_uint(0);

		pugi::xml_node props = itemNode.child("properties");
		if (props) {
			idata.stack = props.attribute("stack").as_int(255);
			idata.lootId = props.attribute("lootId").as_int();
			idata.score = props.attribute("score").as_uint();
		}

		pugi::xml_node equip = itemNode.child("equipable");
		if (equip) {
			idata.isEquipable = true;
			idata.equipKey = equip.attribute("key").as_string();
			idata.equipTimeMs = equip.attribute("equipTimeMs").as_uint();
			if (idata.equipKey.empty()) idata.equipKey = idata.key;
		}

		pugi::xml_node wear = itemNode.child("wearable");
		if (wear) {
			idata.isWearable = true;
			idata.equipKey = wear.attribute("key").as_string();
			idata.wearTimeMs = wear.attribute("equipTimeMs").as_uint();
			if (idata.equipKey.empty()) idata.equipKey = idata.key;
		}

		if (pugi::xml_node mod = itemNode.child("weaponMod")) {
			idata.weaponModKey = mod.attribute("key").as_string();
			if (idata.weaponModKey.empty()) idata.weaponModKey = idata.key;
		}

		pugi::xml_node craft = itemNode.child("crafting");

		// One position. <skill> used to be read from EITHER here or inside
		// <crafting>, filling the same fields either way -- two spellings of one
		// thing, and the same kind of alias removed elsewhere. It reads
		// as two concepts but is not: `type` is always the skill TREE (one of
		// the client's ten SKILLS), and the eight entries that are pure
		// skill-tree nodes simply have no recipe to nest inside.
		pugi::xml_node skill = itemNode.child("skill");
		if (!skill && craft && craft.child("skill")) {
			reportDataWarning(filename, fmt::format(
				"item '{}' has <skill> inside <crafting>; it belongs directly under <item> and "
				"is being ignored here, so the item is neither gated nor in a skill tree", idata.key));
		}

		if (skill) {
			idata.crafting.skillType = skill.attribute("type").as_string();
			if (!skillTabs.count(idata.crafting.skillType)) {
				reportDataWarning(filename, fmt::format(
					"item '{}' has skill type '{}', which skills.xml does not declare; "
					"the client shows it under no tab", idata.key, idata.crafting.skillType));
			}
			idata.crafting.requiredLevel = skill.attribute("requiredLevel").as_uint();
			idata.crafting.skillCost = skill.attribute("skillCost").as_uint();
			idata.crafting.prerequisite = skill.attribute("prerequisite").as_string();

			// Only items with explicit skillCost (even if "0") are locked
			if (skill.attribute("skillCost")) {
				idata.requiresUnlock = true;
			}
		}

		if (craft) {
			parseCrafting(craft, idata, filename);
		}

		pugi::xml_node bagNode = itemNode.child("bag");
		if (bagNode) {
			idata.bagSlots = static_cast<uint8_t>(bagNode.attribute("addSlots").as_uint());
		}

		pugi::xml_node decayNode = itemNode.child("decay");
		if (decayNode) {
			idata.decayTimeMs = decayNode.attribute("timeMs").as_uint();
			idata.decayTransformKey = decayNode.attribute("transformTo").as_string();
		}

		itemDataMap[idata.id] = idata;
		keyToIdMap[idata.key] = idata.id;
	}

	// Secondary pass to link prerequisites, ingredient IIDs, and craft bonuses.
	// Unknown keys are reported instead of silently linking to iid 0 (which
	// makes the recipe permanently uncraftable) — and find() avoids the
	// phantom key->0 entries operator[] would insert into keyToIdMap.
	for (auto& [id, idata] : itemDataMap) {
		// Outside the isCraftable guard: a pure <skill> item (the inventory and
		// builder perks) has no recipe but still chains off another skill, and
		// an unresolved iid leaves UNLOCK_SKILL's prerequisite check disabled.
		if (!idata.crafting.prerequisite.empty()) {
			auto prereqIt = keyToIdMap.find(idata.crafting.prerequisite);
			if (prereqIt != keyToIdMap.end()) {
				idata.crafting.prerequisiteIid = prereqIt->second;
			} else {
				reportDataWarning(filename, fmt::format("item '{}' has unknown crafting prerequisite '{}'", idata.key, idata.crafting.prerequisite));
			}
		}

		// Same second pass as the prerequisite above, and for the same reason:
		// the target may be declared after this item.
		if (!idata.decayTransformKey.empty()) {
			auto decayIt = keyToIdMap.find(idata.decayTransformKey);
			if (decayIt != keyToIdMap.end()) {
				idata.decayTransformTo = decayIt->second;
			} else {
				reportDataWarning(filename, fmt::format("item '{}' decays into unknown item '{}'", idata.key, idata.decayTransformKey));
			}
		}

		if (idata.isCraftable) {
			for (auto& ing : idata.crafting.recipe) {
				auto ingIt = keyToIdMap.find(ing.itemKey);
				if (ingIt != keyToIdMap.end()) {
					ing.iid = ingIt->second;
				} else {
					reportDataWarning(filename, fmt::format("item '{}' recipe references unknown ingredient '{}'", idata.key, ing.itemKey));
				}
			}
		}

		// Resolve craft bonuses (item keys to IIDs).
		//
		// Looked up by clientItemId, NOT "id": the attribute was renamed and this
		// call still asked for the old name, so it matched nothing and every
		// craftBonus silently resolved to an empty map -- builder1's 2x on wood
		// walls, doors and floors did nothing at all. The count in the boot
		// summary exists so that cannot happen quietly again.
		pugi::xml_node itemNode = root.find_child_by_attribute("item", "clientItemId", std::to_string(id).c_str());
		pugi::xml_node bonusNode = itemNode.child("craftBonus");
		if (bonusNode) {
			for (pugi::xml_node bNode = bonusNode.child("item"); bNode; bNode = bNode.next_sibling("item")) {
				std::string targetKey = bNode.attribute("key").as_string();
				uint8_t multiplier = static_cast<uint8_t>(bNode.attribute("multiplier").as_uint(1));
				auto it = keyToIdMap.find(targetKey);
				if (it != keyToIdMap.end()) {
					idata.craftBonuses[it->second] = multiplier;
				}
			}
		}
	}

	// The crafting breakdown, not just the item count: a recipe or station list
	// that failed to parse leaves the item count untouched, so these are what
	// make a broken <crafting> visible at boot.
	size_t craftable = 0, ingredients = 0, stations = 0, gated = 0, bonuses = 0;
	for (const auto& [id, idata] : itemDataMap) {
		if (idata.requiresUnlock) ++gated;
		bonuses += idata.craftBonuses.size();
		if (!idata.isCraftable) continue;
		++craftable;
		ingredients += idata.crafting.recipe.size();
		stations += idata.crafting.stations.size();
	}
	reportDataFile(filename, fmt::format(
		"{} items ({} craftable, {} ingredients, {} station entries, {} skill-gated, {} craft bonuses)",
		itemDataMap.size(), craftable, ingredients, stations, gated, bonuses));
	return true;
}

const ItemData* ItemManager::getItemData(uint16_t id) const
{
	auto it = itemDataMap.find(id);
	return (it != itemDataMap.end()) ? &it->second : nullptr;
}

const ItemData* ItemManager::getItemData(const std::string& key) const
{
	auto it = keyToIdMap.find(key);
	return (it != keyToIdMap.end()) ? getItemData(it->second) : nullptr;
}

uint16_t ItemManager::getIIDByLootID(uint16_t lootId) const
{
	for (const auto& [id, idata] : itemDataMap) {
		if (idata.lootId == lootId) {
			return id;
		}
	}
	return 0;
}
