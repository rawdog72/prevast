// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_EQUIPMENT_H
#define FS_EQUIPMENT_H

#include "gameplay/condition.h" // HitEffects, for <damage><onHit|leech|crit>
#include "gameplay/weapon_mods.h"
#include <string>
#include <unordered_map>
#include <vector>
#include <cstdint>
#include <pugixml.hpp>

struct ConsumableEffect {
	std::string type;
	int16_t amount = 0;
};

struct DamageModifier {
	std::string target;
	std::string ownership;
	float multiplier = 1.0f;
};

struct RepairData {
	bool enabled = false;
	uint16_t amount = 0;
	std::string target; // "objects" or "building"
	std::string delivery; // "melee" (default) or "projectile"
	
	// consume
	std::string consumeKey;
	uint8_t consumeAmountPerTarget = 0;
	bool requireForSwing = false;
};

struct EquipableData {
	// Index into the client's ENTITIES[player].weapons[] catalog -- what the
	// client renders in the player's hands. Sent via setHeldItemIID, so it is
	// not a free-choice server id: it must match client.js.
	uint16_t weaponId = 0;
	std::string key;
	uint16_t typeId = 0;

	// Space-separated field names this weapon knowingly differs from client.js
	// on, e.g. "cooldown damage meleeRadius". Read by
	// tools/check_client_sync.py, which fails on any difference NOT listed here
	// and equally on a name listed here that no longer differs -- so the list
	// cannot decay into a blanket excuse. The server itself never acts on it.
	std::string clientOverrides;

	// Timings. attack/shot/consume are COOLDOWNS -- the minimum gap between one
	// action and the next. impactMs is the opposite thing: a wind-up, the delay
	// from the click until the projectile actually leaves (a bow being drawn, a
	// spear wound back). 0 = fires inline on the click.
	uint32_t attackDelayMs = 0;
	uint32_t shotDelayMs = 0;
	uint32_t impactMs = 0;
	uint32_t consumeDelayMs = 0;

	// Damage & Usage
	uint16_t damage = 0;
	// Inclusive roll range, when a weapon's damage varies per swing. Both 0
	// means "always exactly `damage`", which is every entry in equipables.xml --
	// a tool that did an unpredictable amount of damage to a resource would make
	// harvesting feel broken. It is set by the ghoul melee synthesised from
	// agents.xml <damage min= max=>, where the variance is the characterisation.
	uint16_t damageMin = 0;
	uint16_t damageMax = 0;
	std::string damageType;

	// Does one swing of this roll, or always do exactly `damage`? Also the test
	// for "this weapon quotes a single number for everything it hits": an
	// agents.xml melee has no separate building damage, so a claw does its roll
	// to a wall as well, where a hatchet has its own <damage building=>.
	bool hasDamageRoll() const { return damageMax > damageMin; }
	uint16_t buildingDamage = 0;
	float knockback = 0.0f;

	// <onHit>, <leech> and <crit> inside <damage>: everything this weapon does
	// beyond the number. One shape shared with projectiles.xml and agents.xml,
	// resolved by Game::applyHitEffects -- see HitEffects in condition.h.
	HitEffects hitEffects;

	std::vector<DamageModifier> damageModifiers;
	RepairData repair;
	
	uint8_t staminaUsage = 0;
	float meleeOffsetX = 0.0f;
	float meleeOffsetY = 0.0f;
	uint16_t meleeRange = 0;
	// Lateral half-width of the swing. 0 = fall back to MELEE_HIT_FORGIVENESS.
	uint16_t meleeRadius = 0;

	// Firing Properties
	std::string fireMode = "semi"; // "semi" or "auto"
	std::string projectileKey;
	float speedMultiplier = 1.0f;
	float spreadRadians = 0.0f;
	uint16_t range = 0;

	// <damageFalloff start= end= minMultiplier=>: a shot does full damage out to
	// `start`, fades linearly to `minMultiplier` at `end`, and stays there.
	// Distance is measured from where the shot LEFT to where it landed, so a
	// shotgun is lethal in a doorway and a nuisance across a field, while the
	// sniper barely fades at all.
	//
	// Absent means no falloff, which is what every weapon did before this was
	// implemented -- so a weapon that declares none is unchanged.
	struct DamageFalloff {
		bool enabled = false;
		uint16_t start = 0;
		uint16_t end = 0;
		float minMultiplier = 1.0f;

		float multiplierAt(float distance) const
		{
			if (!enabled || distance <= start) return 1.0f;
			if (distance >= end) return minMultiplier;
			// end > start is guaranteed by the loader, which rejects the rest.
			const float t = (distance - start) / static_cast<float>(end - start);
			return 1.0f - t * (1.0f - minMultiplier);
		}
	};
	DamageFalloff falloff;
	uint8_t pellets = 1;
	float recoilKickback = 0.0f;
	float muzzleOffsetX = 0.0f;
	float muzzleOffsetY = 0.0f;
	float animOffsetX = 0.0f;
	float animOffsetY = 0.0f;

	// Ammo Properties
	std::string ammoKey;
	uint8_t magazineSize = 0;
	uint32_t reloadMs = 0;
	bool reloadPerShell = false;

	// <mods>: the slots this weapon has, in declaration (display) order. Empty
	// for every weapon that takes no mods, which keeps those unchanged.
	std::vector<ModSlotDef> modSlots;
	const ModSlotDef* modSlot(ModSlot type) const
	{
		for (const ModSlotDef& slot : modSlots) {
			if (slot.type == type) return &slot;
		}
		return nullptr;
	}

	// <aim>: absent = cannot aim. See AimData.
	AimData aim;
	// <view>: a built-in scope. A fitted optic's <view> replaces it (weapon_mods::effectiveView).
	ViewData view;

	// Remote trigger (detonator). Non-empty = using this item sends a signal on
	// that channel to every object THIS PLAYER placed that listens on it; what
	// each object does about it is the object's own <remote action=>. The item
	// is not consumed, so one detonator serves any number of charges.
	std::string remoteTriggerChannel;

	// Consumable
	bool isConsumable = false;
	std::vector<ConsumableEffect> consumableEffects;
	std::string conditionKey;
	// Split once at load rather than on every use: <cureCondition keys="a,b">
	// used to be kept as the raw string and run through a std::stringstream on
	// every single cure. "all" survives as a literal entry and is the
	// cure-everything sentinel.
	std::vector<std::string> cureConditionKeys;
};

struct WearableEffect {
	std::string key;
	float multiplier = 0.0f;
};

struct WearableData {
	// The client's clothes index: Player::setSkin sends it and client.js draws
	// ENTITIES[__ENTITIE_PLAYER__].clothes[skin]. Not a free server id -- it has
	// to match that table, which is why it is not called `id`.
	uint16_t skinId = 0;
	std::string key;
	std::vector<WearableEffect> effects;
};

class EquipmentManager {
public:
	static EquipmentManager& getInstance() {
		static EquipmentManager instance;
		return instance;
	}

	bool loadFromXml(const std::string& equipFilename, const std::string& wearFilename);
	bool loadEquipables(const std::string& equipFilename);
	bool loadWearables(const std::string& wearFilename);
	
	const EquipableData* getEquipable(const std::string& key) const;
	const WearableData* getWearable(const std::string& key) const;

	// Whole-set access, for startup analysis that has to ask a question of the
	// loaded content rather than of one item (the projectile id reserve is
	// sized from the worst weapon here, not from a hardcoded number).
	const std::unordered_map<std::string, EquipableData>& getEquipables() const { return equipables; }

	// Bumped by every equipables load (boot and !reload-xml). A player caches
	// its gun's resolved stats against it, because a reload replaces the map
	// the cached base pointer pointed into.
	uint32_t getGeneration() const { return generation; }

private:
	std::unordered_map<std::string, EquipableData> equipables;
	std::unordered_map<std::string, WearableData> wearables;
	uint32_t generation = 0;
};

#endif // FS_EQUIPMENT_H
