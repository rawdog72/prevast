// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/item.h"
#include "gameplay/equipment.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include <algorithm>
#include <cmath>
#include <fmt/format.h>

namespace {
std::string weaponModTrim(std::string_view text)
{
	const size_t first = text.find_first_not_of(" \t");
	if (first == std::string_view::npos) return {};
	const size_t last = text.find_last_not_of(" \t");
	return std::string(text.substr(first, last - first + 1));
}

struct WeaponModLimit {
	double min;
	double max;
	bool integer;
};

// Indexed by ModStat. Same numbers as LIMITS in apps/client/src/world/weapon-mods.ts.
constexpr std::array<WeaponModLimit, MOD_STAT_COUNT> weaponModLimits = {{
	{1.0, 65535.0, true},     // damage
	{30.0, 600000.0, true},   // fireDelayMs
	{0.0, 10.0, false},       // spread (radians)
	{50.0, 65535.0, true},    // range
	{0.1, 100.0, false},      // bulletSpeed
	{0.0, 100.0, false},      // recoil
	{0.0, 100.0, false},      // knockback
	{100.0, 600000.0, true},  // reloadMs
	{100.0, 600000.0, true},  // drawMs
	{0.0, 10.0, false},       // aimSpread (radians)
	{0.1, 1.0, false},        // aimMove (walk-speed multiplier)
	{0.0, 600000.0, true},    // aimMs
}};
} // namespace

std::optional<ModStat> weapon_mods::statFromName(std::string_view name)
{
	for (size_t i = 0; i < MOD_STAT_COUNT; ++i) {
		if (MOD_STAT_NAMES[i] == name) return static_cast<ModStat>(i);
	}
	return std::nullopt;
}

std::vector<std::string> weapon_mods::parseMod(const pugi::xml_node& node, const ItemByKey& itemByKey, ModData& out)
{
	std::vector<std::string> problems;
	out = ModData{};
	out.key = node.attribute("key").as_string();
	if (out.key.empty()) {
		problems.push_back("a <mod> has no key=");
		return problems;
	}

	if (const ItemData* item = itemByKey(out.key)) {
		out.iid = item->id;
		if (item->stack != 1) {
			problems.push_back(fmt::format("mod '{}' must have stack=\"1\" in items.xml", out.key));
		}
		if (item->weaponModKey != out.key) {
			problems.push_back(fmt::format("item '{}' needs <weaponMod key=\"{}\"/> in items.xml", out.key, out.key));
		}
	} else {
		problems.push_back(fmt::format("mod '{}' is not an item in items.xml", out.key));
	}

	const std::string slotName = node.attribute("slot").as_string();
	const std::optional<ModSlot> slot = modSlotFromName(slotName);
	if (slot) {
		out.slot = *slot;
	} else {
		problems.push_back(fmt::format("mod '{}' has unknown slot=\"{}\"", out.key, slotName));
	}

	out.installMs = node.attribute("installMs").as_uint(0);
	if (out.installMs == 0) {
		problems.push_back(fmt::format("mod '{}' needs installMs greater than 0", out.key));
	}

	const pugi::xml_attribute capacity = node.attribute("capacity");
	if (slot == ModSlot::Magazine) {
		const uint32_t value = capacity.as_uint(0);
		if (value < 1 || value > 255) {
			problems.push_back(fmt::format("magazine '{}' needs a capacity from 1 to 255", out.key));
		} else {
			out.capacity = static_cast<uint8_t>(value);
		}
	} else if (capacity) {
		problems.push_back(fmt::format("mod '{}' is not a magazine; capacity= is only for magazines", out.key));
	}

	for (pugi::xml_node s = node.child("stat"); s; s = s.next_sibling("stat")) {
		const std::string name = s.attribute("name").as_string();
		const std::optional<ModStat> stat = statFromName(name);
		if (!stat) {
			problems.push_back(fmt::format("mod '{}' has unknown stat \"{}\"", out.key, name));
			continue;
		}
		if (!s.attribute("add") && !s.attribute("percent")) {
			problems.push_back(fmt::format("mod '{}' <stat name=\"{}\"> needs add= or percent=", out.key, name));
			continue;
		}
		out.stats.push_back({*stat, s.attribute("add").as_double(0.0), s.attribute("percent").as_double(0.0)});
	}
	if (const pugi::xml_node view = node.child("view")) {
		if (slot != ModSlot::Optic) {
			problems.push_back(fmt::format("mod '{}' is not an optic; only an optic carries a <view>", out.key));
		} else {
			for (std::string& p : aim_view::parseView(view, fmt::format("mod '{}'", out.key), out.view)) {
				problems.push_back(std::move(p));
			}
		}
	}
	return problems;
}

std::vector<std::string> weapon_mods::parseModSlots(const pugi::xml_node& modsNode, const std::string& weaponKey,
	uint16_t typeId, bool declaresMagazineSize, const ModByKey& modByKey, std::vector<ModSlotDef>& out)
{
	std::vector<std::string> problems;
	out.clear();
	if (typeId != 2) {
		problems.push_back(fmt::format("'{}' declares <mods> but is not a ranged weapon (typeId 2)", weaponKey));
		return problems;
	}

	std::array<bool, MOD_SLOT_COUNT> seen{};
	for (pugi::xml_node s = modsNode.child("slot"); s; s = s.next_sibling("slot")) {
		const std::string typeName = s.attribute("type").as_string();
		const std::optional<ModSlot> type = modSlotFromName(typeName);
		if (!type) {
			problems.push_back(fmt::format("'{}' has a slot of unknown type \"{}\"", weaponKey, typeName));
			continue;
		}
		if (seen[static_cast<size_t>(*type)]) {
			problems.push_back(fmt::format("'{}' declares the {} slot twice", weaponKey, typeName));
			continue;
		}
		seen[static_cast<size_t>(*type)] = true;

		ModSlotDef def;
		def.type = *type;
		for (std::string_view part : explodeString(s.attribute("accepts").as_string(), ",")) {
			const std::string key = weaponModTrim(part);
			if (key.empty()) continue;
			const ModData* mod = modByKey(key);
			if (!mod) {
				problems.push_back(fmt::format("'{}' {} slot accepts '{}', which is not a mod in mods.xml",
					weaponKey, typeName, key));
				continue;
			}
			if (mod->slot != *type) {
				problems.push_back(fmt::format("'{}' {} slot accepts '{}', which is a {} mod",
					weaponKey, typeName, key, modSlotName(mod->slot)));
				continue;
			}
			def.accepts.push_back(mod->iid);
		}
		if (def.accepts.empty()) {
			problems.push_back(fmt::format("'{}' {} slot accepts nothing", weaponKey, typeName));
			continue;
		}

		const std::string defaultKey = s.attribute("default").as_string();
		if (!defaultKey.empty()) {
			const ModData* mod = modByKey(defaultKey);
			if (!mod || std::find(def.accepts.begin(), def.accepts.end(), mod->iid) == def.accepts.end()) {
				problems.push_back(fmt::format("'{}' {} slot default '{}' is not in its accepts list",
					weaponKey, typeName, defaultKey));
			} else {
				def.defaultIid = mod->iid;
			}
		}
		out.push_back(std::move(def));
	}

	if (declaresMagazineSize && seen[static_cast<size_t>(ModSlot::Magazine)]) {
		problems.push_back(fmt::format("'{}' has a magazine slot, so <ammo magazineSize=> must go: the fitted "
			"magazine sets the capacity", weaponKey));
	}
	return problems;
}

std::optional<std::string> weapon_mods::moddableStackProblem(const ItemData& item, const EquipableData& weapon)
{
	if (weapon.modSlots.empty() || item.stack == 1) return std::nullopt;
	return fmt::format("item '{}' takes mods, so it must have stack=\"1\" in items.xml", item.key);
}

std::optional<std::string> weapon_mods::ammoProblem(const EquipableData& weapon)
{
	if (weapon.ammoKey.empty() || weapon.magazineSize > 0 || weapon.modSlot(ModSlot::Magazine)) return std::nullopt;
	return fmt::format("'{}' takes ammo but holds none: give <ammo> a magazineSize=, or the weapon a magazine slot",
		weapon.key);
}

std::optional<uint8_t> weapon_mods::kitAmmoCeiling(const EquipableData& weapon)
{
	const uint8_t capacity = magazineCapacity(weapon, defaultMods(weapon));
	if (capacity > 0 || weapon.modSlot(ModSlot::Magazine)) return capacity;
	return std::nullopt;
}

std::vector<std::string> weapon_mods::aimProblems(const EquipableData& weapon, const ModByIid& modByIid)
{
	std::vector<std::string> problems;
	if (weapon.aim.enabled) return problems;
	if (weapon.view.shape != ViewShape::None) {
		problems.push_back(fmt::format("'{}' has a <view> but no <aim>, so it can never be aimed", weapon.key));
	}
	for (const ModSlotDef& slot : weapon.modSlots) {
		for (uint16_t iid : slot.accepts) {
			const ModData* mod = modByIid(iid);
			if (!mod) continue;
			const bool aimStat = std::any_of(mod->stats.begin(), mod->stats.end(),
				[](const StatMod& s) { return static_cast<size_t>(s.stat) >= AIM_STAT_FIRST; });
			if (mod->view.shape != ViewShape::None || aimStat) {
				problems.push_back(fmt::format("'{}' accepts '{}', which only matters while aiming: give '{}' an <aim>",
					weapon.key, mod->key, weapon.key));
			}
		}
	}
	return problems;
}

ViewData weapon_mods::effectiveView(const ViewData& weaponView, const std::vector<const ModData*>& fitted)
{
	for (const ModData* mod : fitted) {
		if (mod && mod->slot == ModSlot::Optic && mod->view.shape != ViewShape::None) return mod->view;
	}
	return weaponView;
}

WeaponStats weapon_mods::resolveStats(const WeaponStats& base, const std::vector<const ModData*>& mods, bool hasMagazineSlot)
{
	WeaponStats out = base;
	std::array<double, MOD_STAT_COUNT> add{}, percent{};
	std::array<bool, MOD_STAT_COUNT> touched{};
	uint8_t capacity = 0;
	for (const ModData* mod : mods) {
		if (!mod) continue;
		if (mod->slot == ModSlot::Magazine) capacity = mod->capacity;
		for (const StatMod& s : mod->stats) {
			const size_t i = static_cast<size_t>(s.stat);
			add[i] += s.add;
			percent[i] += s.percent;
			touched[i] = true;
		}
	}
	const auto settle = [&](size_t i, double from) {
		const WeaponModLimit& limit = weaponModLimits[i];
		double v = (from + add[i]) * (1.0 + std::max(percent[i], -95.0) / 100.0);
		v = std::clamp(v, limit.min, limit.max);
		if (limit.integer) v = std::round(v);
		return v;
	};
	for (size_t i = 0; i < AIM_STAT_FIRST; ++i) {
		if (touched[i]) out.value[i] = settle(i, base.value[i]);
	}
	// The aimed spread is a share of the hip spread settled above; only then
	// do aim mods change it, like aimMove and aimMs.
	out.at(ModStat::AimSpread) = out.at(ModStat::Spread) * base.aimSpreadFactor;
	for (size_t i = AIM_STAT_FIRST; i < MOD_STAT_COUNT; ++i) {
		if (touched[i]) out.value[i] = settle(i, out.value[i]);
	}
	if (hasMagazineSlot) out.magazineSize = capacity;
	return out;
}

WeaponStats weapon_mods::baseStats(const EquipableData& w, uint32_t drawMs)
{
	WeaponStats s;
	s.at(ModStat::Damage) = w.damage;
	s.at(ModStat::FireDelayMs) = w.shotDelayMs;
	s.at(ModStat::Spread) = w.spreadRadians;
	s.at(ModStat::Range) = w.range;
	s.at(ModStat::BulletSpeed) = w.speedMultiplier;
	s.at(ModStat::Recoil) = w.recoilKickback;
	s.at(ModStat::Knockback) = w.knockback;
	s.at(ModStat::ReloadMs) = w.reloadMs;
	s.at(ModStat::DrawMs) = drawMs;
	s.at(ModStat::AimSpread) = w.aim.spread;
	s.at(ModStat::AimMove) = w.aim.enabled ? 1.0 + w.aim.movePercent / 100.0 : 1.0;
	s.at(ModStat::AimMs) = w.aim.timeMs;
	s.aimSpreadFactor = w.aim.enabled ? 1.0 + w.aim.spreadPercent / 100.0 : 1.0;
	s.magazineSize = w.magazineSize;
	return s;
}

std::vector<const ModData*> weapon_mods::fittedMods(const WeaponMods& mods)
{
	std::vector<const ModData*> out;
	for (uint16_t iid : mods.iid) {
		if (iid == 0) continue;
		if (const ModData* mod = ModManager::getInstance().byItem(iid)) out.push_back(mod);
	}
	return out;
}

EquipableData weapon_mods::resolveWeapon(const EquipableData& base, const WeaponMods& mods)
{
	const std::vector<const ModData*> fitted = fittedMods(mods);
	const WeaponStats r = resolveStats(baseStats(base, 0), fitted, base.modSlot(ModSlot::Magazine) != nullptr);
	EquipableData out = base;
	out.damage = static_cast<uint16_t>(r.at(ModStat::Damage));
	out.shotDelayMs = static_cast<uint32_t>(r.at(ModStat::FireDelayMs));
	out.spreadRadians = static_cast<float>(r.at(ModStat::Spread));
	out.range = static_cast<uint16_t>(r.at(ModStat::Range));
	out.speedMultiplier = static_cast<float>(r.at(ModStat::BulletSpeed));
	out.recoilKickback = static_cast<float>(r.at(ModStat::Recoil));
	out.knockback = static_cast<float>(r.at(ModStat::Knockback));
	out.reloadMs = static_cast<uint32_t>(r.at(ModStat::ReloadMs));
	out.magazineSize = r.magazineSize;
	if (base.aim.enabled) {
		out.aim.spread = static_cast<float>(r.at(ModStat::AimSpread));
		out.aim.move = static_cast<float>(r.at(ModStat::AimMove));
		out.aim.ms = static_cast<uint32_t>(r.at(ModStat::AimMs));
	}
	out.view = effectiveView(base.view, fitted);
	return out;
}

uint32_t weapon_mods::resolveDrawMs(const EquipableData& base, uint32_t baseDrawMs, const WeaponMods& mods)
{
	if (base.modSlots.empty()) return baseDrawMs;
	const WeaponStats r = resolveStats(baseStats(base, baseDrawMs), fittedMods(mods), base.modSlot(ModSlot::Magazine) != nullptr);
	return static_cast<uint32_t>(r.at(ModStat::DrawMs));
}

uint8_t weapon_mods::magazineCapacity(const EquipableData& base, const WeaponMods& mods)
{
	if (!base.modSlot(ModSlot::Magazine)) return base.magazineSize;
	const ModData* mag = ModManager::getInstance().byItem(mods.at(ModSlot::Magazine));
	return mag ? mag->capacity : 0;
}

WeaponMods weapon_mods::defaultMods(const EquipableData& base)
{
	WeaponMods mods;
	for (const ModSlotDef& slot : base.modSlots) mods.set(slot.type, slot.defaultIid);
	return mods;
}

weapon_mods::RoundsAfter weapon_mods::moveRounds(uint8_t gunRounds, std::optional<uint8_t> incomingRounds)
{
	return {incomingRounds.value_or(0), gunRounds};
}

const EquipableData* weapon_mods::moddableWeapon(uint16_t iid)
{
	const ItemData* data = ItemManager::getInstance().getItemData(iid);
	if (!data || !data->isEquipable) return nullptr;
	const EquipableData* weapon = EquipmentManager::getInstance().getEquipable(data->equipKey);
	return weapon && !weapon->modSlots.empty() ? weapon : nullptr;
}

bool weapon_mods::takesMods(uint16_t iid)
{
	return moddableWeapon(iid) != nullptr;
}

ItemState ItemState::fresh(uint16_t iid)
{
	const EquipableData* weapon = weapon_mods::moddableWeapon(iid);
	return ItemState(getFreshSpawnAmmo(ItemManager::getInstance().getItemData(iid)),
		weapon ? weapon_mods::defaultMods(*weapon) : WeaponMods{});
}

uint32_t weapon_mods::fastestShotDelayMs(const EquipableData& base)
{
	if (base.modSlots.empty()) return base.shotDelayMs;
	// Per slot, the most negative add and percent any accepted mod carries
	// (summed within one mod first). Taking the two minima independently can
	// only undershoot a real combination, which is the safe direction.
	double add = 0.0, percent = 0.0;
	for (const ModSlotDef& slot : base.modSlots) {
		double bestAdd = 0.0, bestPercent = 0.0;
		for (uint16_t iid : slot.accepts) {
			const ModData* mod = ModManager::getInstance().byItem(iid);
			if (!mod) continue;
			double a = 0.0, p = 0.0;
			for (const StatMod& s : mod->stats) {
				if (s.stat != ModStat::FireDelayMs) continue;
				a += s.add;
				p += s.percent;
			}
			bestAdd = std::min(bestAdd, a);
			bestPercent = std::min(bestPercent, p);
		}
		add += bestAdd;
		percent += bestPercent;
	}
	if (add == 0.0 && percent == 0.0) return base.shotDelayMs;
	ModData fastest;
	fastest.slot = ModSlot::Optic;
	fastest.stats.push_back({ModStat::FireDelayMs, add, percent});
	const WeaponStats r = resolveStats(baseStats(base, 0), {&fastest}, false);
	return static_cast<uint32_t>(r.at(ModStat::FireDelayMs));
}

bool ModManager::loadFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "mods");
	if (!root) return false;

	std::unordered_map<std::string, ModData> loaded;
	std::unordered_map<uint16_t, std::string> byIid;
	const weapon_mods::ItemByKey itemByKey = [](const std::string& key) {
		return ItemManager::getInstance().getItemData(key);
	};
	for (pugi::xml_node node = root.child("mod"); node; node = node.next_sibling("mod")) {
		ModData mod;
		const std::vector<std::string> problems = weapon_mods::parseMod(node, itemByKey, mod);
		for (const std::string& problem : problems) reportDataWarning(filename, problem);
		if (!problems.empty()) continue;
		if (loaded.count(mod.key)) {
			reportDataWarning(filename, fmt::format("mod '{}' is declared twice", mod.key));
			continue;
		}
		byIid[mod.iid] = mod.key;
		loaded.emplace(mod.key, std::move(mod));
	}

	// The other direction of the link: an item that says it is a mod must be one.
	for (const auto& [iid, item] : ItemManager::getInstance().all()) {
		if (!item.weaponModKey.empty() && !loaded.count(item.weaponModKey)) {
			reportDataWarning(filename, fmt::format("item '{}' has <weaponMod key=\"{}\">, which is not a mod here",
				item.key, item.weaponModKey));
		}
	}

	mods = std::move(loaded);
	keyByIid = std::move(byIid);
	reportDataFile(filename, fmt::format("{} weapon mods", mods.size()));
	return true;
}

const ModData* ModManager::byKey(const std::string& key) const
{
	const auto it = mods.find(key);
	return it != mods.end() ? &it->second : nullptr;
}

const ModData* ModManager::byItem(uint16_t iid) const
{
	const auto it = keyByIid.find(iid);
	return it != keyByIid.end() ? byKey(it->second) : nullptr;
}
