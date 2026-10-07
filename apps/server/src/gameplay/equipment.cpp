// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/equipment.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include <fmt/format.h>
#include <fmt/color.h>

bool EquipmentManager::loadFromXml(const std::string& equipFilename, const std::string& wearFilename)
{
	bool equipSuccess = loadEquipables(equipFilename);
	bool wearSuccess = loadWearables(wearFilename);
	if (equipSuccess && wearSuccess) {
		// The sub-block counts, not just the total: an equipable whose <fire> or
		// <consumable> failed to parse still counts as one equipable, so the
		// breakdown is what makes a broken parse visible here.
		size_t firing = 0, repairing = 0, consumable = 0, overrideFields = 0, falloff = 0;
		for (const auto& [key, ed] : equipables) {
			if (!ed.projectileKey.empty()) ++firing;
			if (ed.falloff.enabled) ++falloff;
			if (ed.repair.enabled) ++repairing;
			if (ed.isConsumable) ++consumable;
			if (!ed.clientOverrides.empty()) {
				overrideFields += explodeString(ed.clientOverrides, " ").size();
			}
		}
		reportDataFile(equipFilename, fmt::format(
			"{} equipables ({} firing, {} repairing, {} consumable, {} with range falloff, "
			"{} declared client overrides)",
			equipables.size(), firing, repairing, consumable, falloff, overrideFields));
		reportDataFile(wearFilename, fmt::format("{} wearables", wearables.size()));
		return true;
	}
	return false;
}

// <fire>: everything about how a weapon launches a projectile. Absent for melee.
static void parseFire(const pugi::xml_node& fire, EquipableData& ed, const std::string& filename)
{
	// Attributes, not a child element each. These were <range value="800"/> and
	// friends: an element whose NAME carried the meaning, wrapping an attribute
	// whose name carried none -- while <timing>, <damage> and <ammo> in this
	// same file already spelled the identical kind of data as plain attributes.
	ed.fireMode = fire.attribute("mode").as_string("semi");
	ed.projectileKey = fire.attribute("projectileKey").as_string();
	ed.speedMultiplier = fire.attribute("speedMultiplier").as_float(1.0f);
	ed.spreadRadians = fire.attribute("spreadRadians").as_float(0.0f);
	ed.range = static_cast<uint16_t>(fire.attribute("range").as_uint(0));
	ed.pellets = static_cast<uint8_t>(fire.attribute("pellets").as_uint(1));
	ed.recoilKickback = fire.attribute("recoilKickback").as_float(0.0f);

	// Read here, AFTER <range> above, because the sanity check below compares
	// against it. It lives under <fire> in the XML because it is a property of
	// firing, not of the weapon sitting in a hand.
	if (pugi::xml_node fo = fire.child("damageFalloff")) {
		ed.falloff.enabled = true;
		ed.falloff.start = static_cast<uint16_t>(fo.attribute("start").as_uint());
		ed.falloff.end = static_cast<uint16_t>(fo.attribute("end").as_uint());
		ed.falloff.minMultiplier = fo.attribute("minMultiplier").as_float(1.0f);

		// Each of these would divide by zero or invert the curve, so the block
		// is dropped rather than applied wrongly: no falloff is the behaviour
		// every weapon had before this was implemented.
		if (ed.falloff.end <= ed.falloff.start) {
			reportDataWarning(filename, fmt::format(
				"equipable '{}' has damageFalloff end {} at or below start {}; ignored",
				ed.key, ed.falloff.end, ed.falloff.start));
			ed.falloff.enabled = false;
		} else if (ed.falloff.minMultiplier < 0.0f || ed.falloff.minMultiplier > 1.0f) {
			reportDataWarning(filename, fmt::format(
				"equipable '{}' has damageFalloff minMultiplier {}; it must be 0..1, ignored",
				ed.key, ed.falloff.minMultiplier));
			ed.falloff.enabled = false;
		} else if (ed.range > 0 && ed.falloff.start >= ed.range) {
			// Not fatal, but the weapon cannot reach its own falloff, so the
			// block does nothing and the author meant something by it.
			reportDataWarning(filename, fmt::format(
				"equipable '{}' starts its damage falloff at {} but only reaches {}; "
				"it will never fade", ed.key, ed.falloff.start, ed.range));
		}
	}
}

// <repair>: the repair hammer's job, plus what it spends doing it.
static void parseRepair(const pugi::xml_node& repairNode, EquipableData& ed)
{
	ed.repair.enabled = true;
	ed.repair.amount = static_cast<uint16_t>(repairNode.attribute("amount").as_uint());
	ed.repair.target = repairNode.attribute("target").as_string("objects");
	ed.repair.delivery = repairNode.attribute("delivery").as_string("melee");

	if (pugi::xml_node consumeNode = repairNode.child("consume")) {
		ed.repair.consumeKey = consumeNode.attribute("key").as_string();
		ed.repair.consumeAmountPerTarget = static_cast<uint8_t>(consumeNode.attribute("amountPerTarget").as_uint());
		ed.repair.requireForSwing = consumeNode.attribute("requireForSwing").as_bool(false);
	}
}

// <consumable>: gauge effects, plus the status effect it applies or cures.
static void parseConsumable(const pugi::xml_node& cons, EquipableData& ed)
{
	ed.isConsumable = true;
	for (pugi::xml_node eff = cons.child("effect"); eff; eff = eff.next_sibling("effect")) {
		// Saturating, not truncating: this is a gauge delta on a 0-255 bar, so
		// any absurd number means "all of it" -- and a cast would flip its sign.
		ed.consumableEffects.push_back({eff.attribute("type").as_string(),
			static_cast<int16_t>(std::clamp<long long>(
				eff.attribute("amount").as_llong(), -32768, 32767))});
	}
	if (pugi::xml_node seNode = cons.child("condition")) ed.conditionKey = seNode.attribute("key").as_string();
	if (pugi::xml_node cureNode = cons.child("cureCondition")) {
		for (std::string_view part : explodeString(cureNode.attribute("keys").as_string(), ",")) {
			const size_t first = part.find_first_not_of(" \t");
			if (first == std::string_view::npos) continue;
			ed.cureConditionKeys.emplace_back(part.substr(first, part.find_last_not_of(" \t") - first + 1));
		}
	}
}

bool EquipmentManager::loadEquipables(const std::string& equipFilename)
{
	pugi::xml_document equipDoc;
	const pugi::xml_node equipRoot = xml_utils::openDataFile(equipDoc, equipFilename, "equipables");
	if (!equipRoot) return false;

	std::unordered_map<std::string, EquipableData> newEquipables;
	{
		const pugi::xml_node& root = equipRoot;
		for (pugi::xml_node node = root.child("equipable"); node; node = node.next_sibling("equipable")) {
			EquipableData ed;
			ed.weaponId = node.attribute("idWeapon").as_int();
			ed.key = node.attribute("key").as_string();
			ed.typeId = node.attribute("typeId").as_int();

			// Fields this weapon deliberately disagrees with client.js on.
			// The server does not act on it -- tools/check_client_sync.py is
			// what reads the list, and treats anything NOT named here as drift.
			// Parsed anyway so the count is visible at boot and so the value is
			// live data rather than a comment nothing reads.
			ed.clientOverrides = node.attribute("clientOverrides").as_string();
			
			pugi::xml_node timing = node.child("timing");
			if (timing) {
				ed.attackDelayMs = timing.attribute("attackDelayMs").as_uint();
				ed.shotDelayMs = timing.attribute("shotDelayMs").as_uint();
				ed.impactMs = timing.attribute("impactMs").as_uint();
				ed.consumeDelayMs = timing.attribute("consumeDelayMs").as_uint();

				// A wind-up at least as long as the weapon's own cooldown lets a
				// second shot start before the first has left, stacking pending
				// releases -- an auto weapon would queue them indefinitely.
				// Clamped rather than rejected so a typo degrades to "releases
				// at the cooldown" instead of failing silently at runtime.
				// Throwables have no cooldown (one click, one throw) and are
				// self-limiting, so they are left alone.
				const uint32_t cooldownMs = ed.shotDelayMs > 0 ? ed.shotDelayMs : ed.attackDelayMs;
				if (cooldownMs > 0 && ed.impactMs >= cooldownMs) {
					reportDataWarning(equipFilename, fmt::format(
						"equipable '{}' has impactMs {} >= its cooldown {}; clamped to {}",
						ed.key, ed.impactMs, cooldownMs, cooldownMs - 1));
					ed.impactMs = cooldownMs - 1;
				}
			}

			if (pugi::xml_node fire = node.child("fire")) {
				parseFire(fire, ed, equipFilename);
			}

			pugi::xml_node muzzle = node.child("muzzleOffset");
			if (muzzle) {
				ed.muzzleOffsetX = muzzle.attribute("x").as_float(0.0f);
				ed.muzzleOffsetY = muzzle.attribute("y").as_float(0.0f);
			}

			pugi::xml_node animOffset = node.child("animOffset");
			if (animOffset) {
				ed.animOffsetX = animOffset.attribute("x").as_float(ed.muzzleOffsetX);
				ed.animOffsetY = animOffset.attribute("y").as_float(ed.muzzleOffsetY);
			} else {
				ed.animOffsetX = ed.muzzleOffsetX;
				ed.animOffsetY = ed.muzzleOffsetY;
			}

			pugi::xml_node ammo = node.child("ammo");
			if (ammo) {
				ed.ammoKey = ammo.attribute("key").as_string();
				ed.magazineSize = static_cast<uint8_t>(ammo.attribute("magazineSize").as_uint(0));
				ed.reloadMs = ammo.attribute("reloadMs").as_uint(0);
				ed.reloadPerShell = ammo.attribute("reloadPerShell").as_bool(false);
			}

			if (pugi::xml_node modsNode = node.child("mods")) {
				const bool declaresMagazineSize = static_cast<bool>(node.child("ammo").attribute("magazineSize"));
				const weapon_mods::ModByKey modByKey = [](const std::string& key) {
					return ModManager::getInstance().byKey(key);
				};
				for (const std::string& problem : weapon_mods::parseModSlots(
						modsNode, ed.key, ed.typeId, declaresMagazineSize, modByKey, ed.modSlots)) {
					reportDataWarning(equipFilename, problem);
				}
			}
			if (const std::optional<std::string> problem = weapon_mods::ammoProblem(ed)) {
				reportDataWarning(equipFilename, *problem);
			}
			if (pugi::xml_node aimNode = node.child("aim")) {
				for (const std::string& problem :
						aim_view::parseAim(aimNode, fmt::format("'{}'", ed.key), ed.spreadRadians, ed.aim)) {
					reportDataWarning(equipFilename, problem);
				}
			}
			if (pugi::xml_node viewNode = node.child("view")) {
				for (const std::string& problem : aim_view::parseView(viewNode, fmt::format("'{}'", ed.key), ed.view)) {
					reportDataWarning(equipFilename, problem);
				}
			}
			const weapon_mods::ModByIid modByIid = [](uint16_t iid) { return ModManager::getInstance().byItem(iid); };
			for (const std::string& problem : weapon_mods::aimProblems(ed, modByIid)) {
				reportDataWarning(equipFilename, problem);
			}

			pugi::xml_node dmg = node.child("damage");
			if (dmg) {
				// Clamped, not cast: see MAX_DAMAGE_AMOUNT.
				ed.damage = clampDamageAmount(dmg.attribute("amount").as_llong());
				ed.damageType = dmg.attribute("type").as_string();
				ed.knockback = dmg.attribute("knockback").as_float(0.0f);

				// <onHit>, <leech> and <crit> live inside <damage>, because they
				// are all things this weapon's damage DOES. A melee weapon could
				// not inflict a condition at all before this -- only projectiles
				// and agent bites could -- so a poisoned blade was unwritable.
				xml_utils::parseHitEffects(dmg, ed.hitEffects, equipFilename, ed.key);

				// Only the FIRST <damage> is read, so a second one is invisible --
				// and that is exactly how somebody adds an <onHit> to a weapon,
				// boots with no warnings at all, and finds it does nothing. The
				// natural edit is to leave the original self-closing <damage/>
				// alone and add a second block below it with the new children in.
				if (dmg.next_sibling("damage")) {
					reportDataWarning(equipFilename, fmt::format(
						"'{}' has more than one <damage> element; only the first is read, so "
						"anything in the others -- <onHit>, <leech>, <crit> -- is ignored. Merge "
						"them into one block", ed.key));
				}
			}

			ed.buildingDamage = ed.damage; // Default to normal damage
			pugi::xml_node bDmg = node.child("buildingDamage");
			if (bDmg) {
				ed.buildingDamage = clampDamageAmount(bDmg.attribute("amount").as_llong());
			}

			pugi::xml_node dmgMods = node.child("damageModifiers");
			if (dmgMods) {
				for (pugi::xml_node mod = dmgMods.child("modifier"); mod; mod = mod.next_sibling("modifier")) {
					DamageModifier dm;
					dm.target = mod.attribute("target").as_string();
					dm.ownership = mod.attribute("ownership").as_string();
					dm.multiplier = mod.attribute("multiplier").as_float(1.0f);
					ed.damageModifiers.push_back(dm);
				}
			}

			if (pugi::xml_node repairNode = node.child("repair")) {
				parseRepair(repairNode, ed);
			}

			pugi::xml_node usage = node.child("usage");
			if (usage) {
				ed.staminaUsage = usage.attribute("stamina").as_int();
			}

			pugi::xml_node combat = node.child("combat");
			if (combat) {
				pugi::xml_node offset = combat.child("offset");
				if (offset) {
					ed.meleeOffsetX = offset.attribute("x").as_float(0.0f);
					ed.meleeOffsetY = offset.attribute("y").as_float(0.0f);
				}
				ed.meleeRange = static_cast<uint16_t>(combat.attribute("range").as_uint(0));
				ed.meleeRadius = static_cast<uint16_t>(combat.attribute("radius").as_uint(0));
			}
			
			pugi::xml_node remote = node.child("remoteTrigger");
			if (remote) {
				ed.remoteTriggerChannel = remote.attribute("channel").as_string();
				if (ed.remoteTriggerChannel.empty()) {
					reportDataWarning(equipFilename, fmt::format(
						"equipable '{}' has <remoteTrigger> with no channel; it will do nothing", ed.key));
				}
			}

			if (pugi::xml_node cons = node.child("consumable")) {
				parseConsumable(cons, ed);
			}
			newEquipables[ed.key] = std::move(ed);
		}
	}

	// items.xml loads first, so the other direction of the link can be checked
	// here: an item bound to a moddable equipable must not stack.
	for (const auto& [iid, item] : ItemManager::getInstance().all()) {
		if (!item.isEquipable) continue;
		const auto weapon = newEquipables.find(item.equipKey);
		if (weapon == newEquipables.end()) continue;
		if (const std::optional<std::string> problem = weapon_mods::moddableStackProblem(item, weapon->second)) {
			reportDataWarning(equipFilename, *problem);
		}
	}

	equipables = std::move(newEquipables);
	++generation;
	return true;
}

bool EquipmentManager::loadWearables(const std::string& wearFilename)
{
	pugi::xml_document wearDoc;
	const pugi::xml_node wearRoot = xml_utils::openDataFile(wearDoc, wearFilename, "wearables");
	if (!wearRoot) return false;

	std::unordered_map<std::string, WearableData> newWearables;
	{
		const pugi::xml_node& root = wearRoot;
		for (pugi::xml_node node = root.child("wearable"); node; node = node.next_sibling("wearable")) {
			WearableData wd;
			wd.skinId = static_cast<uint16_t>(node.attribute("skinId").as_uint());
			wd.key = node.attribute("key").as_string();

			// Absence, not zero: skin 0 is a real value (bare), so only a
			// MISSING attribute is the mistake. Without this a wearable simply
			// drew as no clothes at all and said nothing about it.
			if (!node.attribute("skinId")) {
				reportDataWarning(wearFilename, fmt::format(
					"wearable '{}' has no skinId=; wearing it will show no clothes", wd.key));
			}
			
			pugi::xml_node modifiersNode = node.child("modifiers");
			if (modifiersNode) {
				for (pugi::xml_node mod = modifiersNode.child("modifier"); mod; mod = mod.next_sibling("modifier")) {
					wd.effects.push_back({mod.attribute("key").as_string(), mod.attribute("multiplier").as_float()});
				}
			}
			newWearables[wd.key] = std::move(wd);
		}
	}

	wearables = std::move(newWearables);
	return true;
}


const EquipableData* EquipmentManager::getEquipable(const std::string& key) const
{
	auto it = equipables.find(key);
	return (it != equipables.end()) ? &it->second : nullptr;
}

const WearableData* EquipmentManager::getWearable(const std::string& key) const
{
	auto it = wearables.find(key);
	return (it != wearables.end()) ? &it->second : nullptr;
}
