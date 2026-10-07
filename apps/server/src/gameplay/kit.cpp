// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/kit.h"
#include "gameplay/item.h"
#include "gameplay/equipment.h"
#include "gameplay/weapon_mods.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include <pugixml.hpp>
#include <fmt/format.h>
#include <fmt/color.h>

bool KitManager::loadFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "kits");
	if (!root) return false;

	deathRewardExpiryMinutes = root.attribute("deathRewardExpiryMinutes").as_uint(180);
	overflowStartLevelPercent = root.attribute("overflowStartLevelPercent").as_uint(50);

	for (pugi::xml_node kitNode = root.child("kit"); kitNode; kitNode = kitNode.next_sibling("kit")) {
		KitData kit;
		kit.level = kitNode.attribute("level").as_uint();
		const bool firstSession = kitNode.attribute("firstSession").as_bool(false);
		kit.startLevel = kitNode.attribute("startLevel").as_uint(0);

		if (pugi::xml_node itemsNode = kitNode.child("items")) {
			for (pugi::xml_node itemNode = itemsNode.child("item"); itemNode; itemNode = itemNode.next_sibling("item")) {
				const ItemData* idata = ItemManager::getInstance().getItemData(itemNode.attribute("key").as_string());
				if (!idata) {
					fmt::print(">> [Kit Error] Kit level {} grants unknown item key '{}'\n", kit.level, itemNode.attribute("key").as_string());
					continue;
				}
				KitItem item;
				item.iid = idata->id;
				item.count = static_cast<uint8_t>(std::min(255u, itemNode.attribute("amount").as_uint(1)));

				if (pugi::xml_attribute ammoAttr = itemNode.attribute("ammo")) {
					uint32_t ammo = std::min(255u, ammoAttr.as_uint(0));
					// Requires equipables to be loaded first (prevast_server.cpp).
					const EquipableData* edata = EquipmentManager::getInstance().getEquipable(idata->equipKey.empty() ? idata->key : idata->equipKey);
					// A kit gun is created, so it holds whatever its default magazine holds
					// -- nothing at all when it has a magazine slot and no default magazine.
					const std::optional<uint8_t> capacity = edata ? weapon_mods::kitAmmoCeiling(*edata) : std::nullopt;
					if (capacity && ammo > *capacity) {
						reportDataWarning(filename, fmt::format("kit level {} gives '{}' ammo=\"{}\" but its magazine holds {}; clamped",
							kit.level, idata->key, ammo, *capacity));
						ammo = *capacity;
					}
					item.ammo = static_cast<int16_t>(ammo);
				}

				kit.items.push_back(item);
			}
		}

		if (firstSession) {
			// Reserved for a token that has never died before; excluded from
			// the level-based lookup entirely (see KitManager::getFreshKit).
			freshKit = kit;
			hasFreshKit = true;
		} else {
			kits[kit.level] = kit;
		}
	}

	if (kits.find(0) == kits.end()) {
		reportDataWarning(filename, "no ordinary level=\"0\" kit; players who have died before but have no valid reward will receive no starting items");
	}
	if (!hasFreshKit) {
		reportDataWarning(filename, "no <kit firstSession=\"true\">; tokens that have never died before will fall back to the level-based lookup");
	}

	// Total granted units, not just the kit count: an empty or half-parsed kit
	// table still reports the right number of kits, so the quantity is what
	// makes a broken <item amount=> visible here.
	uint32_t grantedUnits = 0;
	for (const auto& [level, kit] : kits) {
		for (const KitItem& it : kit.items) grantedUnits += it.count;
	}
	for (const KitItem& it : freshKit.items) grantedUnits += it.count;

	reportDataFile(filename, fmt::format("{} leveled kits{} granting {} items (reward expiry {} min, overflow start {}%)",
		kits.size(), hasFreshKit ? " + 1 fresh-session" : "", grantedUnits, deathRewardExpiryMinutes, overflowStartLevelPercent));
	return true;
}

const KitData* KitManager::getKitForLevel(uint32_t targetLevel) const
{
	if (kits.empty()) {
		return nullptr;
	}

	// Largest defined tier <= targetLevel: upper_bound finds the first key
	// strictly greater than targetLevel, so the entry just before it (if any)
	// is the best match. When targetLevel is above every defined level, this
	// naturally resolves to the highest one — no separate cap needed.
	auto it = kits.upper_bound(targetLevel);
	if (it == kits.begin()) {
		return nullptr; // every defined tier is above targetLevel
	}
	--it;
	return &it->second;
}

KitAward KitManager::getAwardForDeathLevel(uint32_t deathLevel) const
{
	KitAward award;
	award.kit = getKitForLevel(deathLevel);
	if (!award.kit) {
		return award;
	}
	award.startLevel = award.kit->startLevel;

	// Past the last defined tier the table stops growing. Rather than flat-line
	// every high-level death at the top kit's startLevel, keep the granted
	// level proportional to the level actually lost; the items stay the top
	// kit's. kits is non-empty here (getKitForLevel returned a kit).
	if (overflowStartLevelPercent > 0 && deathLevel > kits.rbegin()->first) {
		const uint32_t scaled = static_cast<uint32_t>(
			(static_cast<uint64_t>(deathLevel) * overflowStartLevelPercent) / 100ULL);
		award.startLevel = std::max(award.startLevel, scaled);
	}
	return award;
}
