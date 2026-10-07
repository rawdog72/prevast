// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/weapon_mod_types.h"
#include "gameplay/aim_view.h"
#include <functional>
#include <optional>
#include <pugixml.hpp>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

struct EquipableData;
struct ItemData;

// The stats a mod may change (<stat name=>), in whitelist order. The three aim
// stats come last because they resolve last: the aimed spread is a share of
// the hip spread the stats before them settle on.
enum class ModStat : uint8_t {
	Damage,
	FireDelayMs,
	Spread,
	Range,
	BulletSpeed,
	Recoil,
	Knockback,
	ReloadMs,
	DrawMs,
	AimSpread,
	AimMove,
	AimMs,
	Count
};

inline constexpr size_t MOD_STAT_COUNT = static_cast<size_t>(ModStat::Count);
inline constexpr size_t AIM_STAT_FIRST = static_cast<size_t>(ModStat::AimSpread);

inline constexpr std::array<std::string_view, MOD_STAT_COUNT> MOD_STAT_NAMES = {
	"damage", "fireDelayMs", "spread", "range", "bulletSpeed", "recoil", "knockback", "reloadMs", "drawMs",
	"aimSpread", "aimMove", "aimMs",
};

struct StatMod {
	ModStat stat = ModStat::Damage;
	double add = 0.0;
	double percent = 0.0;
};

// One <mod> in mods.xml. `iid` is the item that IS this mod (same key).
struct ModData {
	std::string key;
	uint16_t iid = 0;
	ModSlot slot = ModSlot::Magazine;
	uint32_t installMs = 0;
	// Magazines only: the weapon's capacity while this is fitted.
	uint8_t capacity = 0;
	std::vector<StatMod> stats;
	// Optics only: what aiming with it shows. ViewShape::None when it has none.
	ViewData view;
};

// One <mods><slot> of a weapon, keys resolved to item ids.
struct ModSlotDef {
	ModSlot type = ModSlot::Magazine;
	std::vector<uint16_t> accepts; // mod item ids, in declaration order
	uint16_t defaultIid = 0;       // fitted when the weapon is created; 0 = none
};

// A weapon's moddable numbers: the resolver's input and output. Held as
// doubles so C++ and the TypeScript mirror compute identically.
struct WeaponStats {
	std::array<double, MOD_STAT_COUNT> value{};
	uint8_t magazineSize = 0;
	// <aim spreadPercent> as a factor: before aim mods, the aimed spread is the
	// resolved hip spread times this. 1 for a weapon that cannot aim.
	double aimSpreadFactor = 1.0;

	double& at(ModStat stat) { return value[static_cast<size_t>(stat)]; }
	double at(ModStat stat) const { return value[static_cast<size_t>(stat)]; }
};

namespace weapon_mods {
using ItemByKey = std::function<const ItemData*(const std::string&)>;
using ModByKey = std::function<const ModData*(const std::string&)>;
using ModByIid = std::function<const ModData*(uint16_t)>;

std::optional<ModStat> statFromName(std::string_view name);

// Parses one <mod>. Returns every problem found; `out` is usable only when the
// list is empty. Pure: the lookups are injected so the self-test can run it.
std::vector<std::string> parseMod(const pugi::xml_node& node, const ItemByKey& itemByKey, ModData& out);

// Parses a weapon's <mods>. Slots that resolve land in `out`; the problems are
// returned for the loader to report, and a slot with a problem is dropped.
std::vector<std::string> parseModSlots(const pugi::xml_node& modsNode, const std::string& weaponKey,
	uint16_t typeId, bool declaresMagazineSize, const ModByKey& modByKey, std::vector<ModSlotDef>& out);

// Content rules the loaders report as warnings. Pure, so the self-test can run
// them. Each returns the problem, or nullopt when the content is fine.
//
// An item whose equipable takes mods must be stack="1": two stacked guns would
// merge (Inventory::stackItem, NPC capacity) without comparing what is fitted.
std::optional<std::string> moddableStackProblem(const ItemData& item, const EquipableData& weapon);
// A weapon that takes ammo needs a magazine: <ammo magazineSize=> above 0, or a
// magazine slot, whose fitted magazine sets the capacity.
std::optional<std::string> ammoProblem(const EquipableData& weapon);
// The most rounds a kit may put in a weapon it creates, or nullopt when there is
// no ceiling. A weapon with a magazine slot is capped at its default magazine's
// capacity, 0 when it has none; any other at <ammo magazineSize>, when it has one.
std::optional<uint8_t> kitAmmoCeiling(const EquipableData& weapon);
// A weapon that cannot aim must not carry a <view>, or accept a mod that only
// matters while aiming: an optic with a <view>, or any mod with an aim stat.
std::vector<std::string> aimProblems(const EquipableData& weapon, const ModByIid& modByIid);
// What a weapon shows when aimed with these mods: the fitted optic's <view>
// when it has one, otherwise the weapon's own.
ViewData effectiveView(const ViewData& weaponView, const std::vector<const ModData*>& fitted);

// final = clamp((base + sum of adds) x (1 + max(sum of percents, -95) / 100)).
// A stat no mod touches keeps its base value exactly. A weapon with a magazine
// slot takes its capacity from the fitted magazine, 0 when none is.
WeaponStats resolveStats(const WeaponStats& base, const std::vector<const ModData*>& mods, bool hasMagazineSlot);

WeaponStats baseStats(const EquipableData& weapon, uint32_t drawMs);
std::vector<const ModData*> fittedMods(const WeaponMods& mods);

// The weapon's EquipableData with every moddable field, magazineSize included,
// replaced by its resolved value. What getEquippedWeaponData hands out.
EquipableData resolveWeapon(const EquipableData& base, const WeaponMods& mods);
uint32_t resolveDrawMs(const EquipableData& base, uint32_t baseDrawMs, const WeaponMods& mods);

// The single authority on capacity: the fitted magazine's for a weapon with a
// magazine slot (0 = none fitted), <ammo magazineSize> for any other.
uint8_t magazineCapacity(const EquipableData& base, const WeaponMods& mods);

// What a newly created weapon has fitted.
WeaponMods defaultMods(const EquipableData& base);

// Rounds belong to the magazine they are in. `gunRounds` is what the fitted
// magazine holds now; `incomingRounds` is what the magazine being fitted holds
// (nullopt when removing). The outgoing magazine leaves with the gun's rounds.
struct RoundsAfter {
	uint8_t gun = 0;
	uint8_t outgoing = 0;
};
RoundsAfter moveRounds(uint8_t gunRounds, std::optional<uint8_t> incomingRounds);

// The moddable weapon an item is, or nullptr when the item takes no mods.
const EquipableData* moddableWeapon(uint16_t iid);
bool takesMods(uint16_t iid);

// A lower bound on the weapon's shot delay under any combination of the mods
// it accepts. Sizes the projectile id reserve, which must never be short.
uint32_t fastestShotDelayMs(const EquipableData& base);

int runSelfTest(const std::string& fixtureDir);
} // namespace weapon_mods

class ModManager {
public:
	static ModManager& getInstance()
	{
		static ModManager instance;
		return instance;
	}

	bool loadFromXml(const std::string& filename);
	const ModData* byKey(const std::string& key) const;
	const ModData* byItem(uint16_t iid) const;
	// Every loaded mod, by key: for startup checks over the whole set.
	const std::unordered_map<std::string, ModData>& all() const { return mods; }

private:
	std::unordered_map<std::string, ModData> mods;
	std::unordered_map<uint16_t, std::string> keyByIid;
};
