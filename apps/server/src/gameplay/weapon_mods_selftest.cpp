// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/item.h"
#include "gameplay/equipment.h"
#include <boost/json.hpp>
#include <cmath>
#include <fmt/format.h>
#include <fstream>
#include <sstream>

// Every file-local name carries a weaponModTest prefix: the server builds as
// unity files, where an unprefixed helper collides with another file's.
namespace {
int weaponModTestFailures = 0;

void weaponModTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++weaponModTestFailures;
		fmt::print(">> weapon mod self-test FAILED: {}\n", what);
	}
}

bool weaponModTestMentions(const std::vector<std::string>& problems, std::string_view fragment)
{
	for (const std::string& p : problems) {
		if (p.find(fragment) != std::string::npos) return true;
	}
	return false;
}

ItemData weaponModTestItem(uint16_t id, const std::string& key, uint8_t stack, const std::string& modKey)
{
	ItemData item;
	item.id = id;
	item.key = key;
	item.stack = stack;
	item.weaponModKey = modKey;
	return item;
}

void weaponModTestParsing()
{
	static const std::vector<ItemData> items = {
		weaponModTestItem(10, "mag_40", 1, "mag_40"),
		weaponModTestItem(11, "scope", 1, "scope"),
		weaponModTestItem(12, "heavy", 5, "heavy"),
		weaponModTestItem(13, "unlinked", 1, ""),
	};
	const weapon_mods::ItemByKey itemByKey = [](const std::string& key) -> const ItemData* {
		for (const ItemData& i : items) {
			if (i.key == key) return &i;
		}
		return nullptr;
	};
	auto parse = [&](const char* xml, ModData& out) {
		pugi::xml_document doc;
		doc.load_string(xml);
		return weapon_mods::parseMod(doc.document_element(), itemByKey, out);
	};

	ModData mag;
	auto problems = parse(R"(<mod key="mag_40" slot="magazine" installMs="2200" capacity="40">
		<stat name="reloadMs" add="400"/><stat name="recoil" percent="-30"/></mod>)", mag);
	weaponModTestCheck(problems.empty(), "a valid magazine parses");
	weaponModTestCheck(mag.iid == 10 && mag.slot == ModSlot::Magazine && mag.capacity == 40 && mag.installMs == 2200,
		"magazine fields");
	weaponModTestCheck(mag.stats.size() == 2 && mag.stats[0].stat == ModStat::ReloadMs && mag.stats[0].add == 400.0 &&
		mag.stats[1].stat == ModStat::Recoil && mag.stats[1].percent == -30.0, "magazine stats");

	ModData bad;
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="mag_40" slot="magazine" installMs="1"/>)", bad),
		"capacity"), "a magazine needs a capacity");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="scope" slot="optic" installMs="1" capacity="5"/>)", bad),
		"only for magazines"), "capacity on an optic is rejected");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="scope" slot="optic" installMs="1"><stat name="zoomies" add="1"/></mod>)", bad),
		"unknown stat"), "an unknown stat is rejected");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="scope" slot="optic" installMs="1"><stat name="damage"/></mod>)", bad),
		"add= or percent="), "a stat with no value is rejected");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="scope" slot="optic"/>)", bad),
		"installMs"), "installMs is required");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="scope" slot="barrel" installMs="1"/>)", bad),
		"unknown slot"), "an unknown slot is rejected");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="heavy" slot="stock" installMs="1"/>)", bad),
		"stack"), "a mod item must not stack");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="unlinked" slot="stock" installMs="1"/>)", bad),
		"<weaponMod"), "the item must link back to its mod");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="ghost" slot="stock" installMs="1"/>)", bad),
		"not an item"), "a mod must be an item");

	ModData scope;
	parse(R"(<mod key="scope" slot="optic" installMs="1500"/>)", scope);
	const weapon_mods::ModByKey modByKey = [&](const std::string& key) -> const ModData* {
		if (key == "mag_40") return &mag;
		if (key == "scope") return &scope;
		return nullptr;
	};
	auto slots = [&](const char* xml, uint16_t typeId, bool magazineSize, std::vector<ModSlotDef>& out) {
		pugi::xml_document doc;
		doc.load_string(xml);
		return weapon_mods::parseModSlots(doc.document_element(), "gun", typeId, magazineSize, modByKey, out);
	};
	std::vector<ModSlotDef> defs;
	problems = slots(R"(<mods><slot type="magazine" accepts="mag_40" default="mag_40"/>
		<slot type="optic" accepts=" scope "/></mods>)", 2, false, defs);
	weaponModTestCheck(problems.empty(), "valid slots parse");
	weaponModTestCheck(defs.size() == 2 && defs[0].type == ModSlot::Magazine && defs[0].defaultIid == 10 &&
		defs[1].type == ModSlot::Optic && defs[1].accepts == std::vector<uint16_t>{11}, "slot fields, keys trimmed");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="optic" accepts="mag_40"/></mods>)", 2, false, defs),
		"is a magazine mod"), "a mod of another slot type is rejected");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="optic" accepts="nothing"/></mods>)", 2, false, defs),
		"not a mod"), "an unknown key is rejected");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="optic" accepts="scope" default="mag_40"/></mods>)", 2, false, defs),
		"default"), "a default outside accepts is rejected");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="optic" accepts="scope"/><slot type="optic" accepts="scope"/></mods>)", 2, false, defs),
		"twice"), "the same slot type twice is rejected");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="optic" accepts="scope"/></mods>)", 1, false, defs),
		"ranged weapon"), "only ranged weapons take mods");
	weaponModTestCheck(weaponModTestMentions(slots(R"(<mods><slot type="magazine" accepts="mag_40"/></mods>)", 2, true, defs),
		"magazineSize"), "magazineSize and a magazine slot cannot both be set");

	// A <view> rides on an optic only; aim stats parse like any other.
	ModData optic;
	problems = parse(R"(<mod key="scope" slot="optic" installMs="1500">
		<view shape="stretch" ahead="250" zoom="0.95" extend="250"/><stat name="aimSpread" percent="-15"/></mod>)", optic);
	weaponModTestCheck(problems.empty() && optic.view.shape == ViewShape::Stretch && optic.stats.size() == 1 &&
		optic.stats[0].stat == ModStat::AimSpread, "an optic with a view and an aim stat parses");
	weaponModTestCheck(weaponModTestMentions(parse(R"(<mod key="mag_40" slot="magazine" installMs="1" capacity="40">
		<view shape="stretch" ahead="250" zoom="0.95" extend="250"/></mod>)", bad), "only an optic"),
		"a view on a magazine is rejected");
}

// The nine hip stats are required in every case. A case with "aim" gives the
// weapon an <aim>, and its expect then names the three aim stats as well.
WeaponStats weaponModTestStats(const boost::json::object& o, const boost::json::object* aim)
{
	WeaponStats s;
	for (size_t i = 0; i < AIM_STAT_FIRST; ++i) {
		s.value[i] = o.at(MOD_STAT_NAMES[i]).to_number<double>();
	}
	s.magazineSize = static_cast<uint8_t>(o.at("magazineSize").to_number<int>());
	if (aim) {
		s.aimSpreadFactor = 1.0 + aim->at("spreadPercent").to_number<double>() / 100.0;
		s.at(ModStat::AimMove) = 1.0 + aim->at("movePercent").to_number<double>() / 100.0;
		s.at(ModStat::AimMs) = aim->at("timeMs").to_number<double>();
	}
	return s;
}

void weaponModTestResolver(const std::string& fixtureDir)
{
	std::ifstream in(fixtureDir + "/resolve-cases.json", std::ios::binary);
	weaponModTestCheck(static_cast<bool>(in), "resolve-cases.json is readable");
	if (!in) return;
	std::stringstream text;
	text << in.rdbuf();
	const boost::json::value doc = boost::json::parse(text.str());

	for (const boost::json::value& c : doc.at("cases").as_array()) {
		const std::string name(c.at("name").as_string());
		std::vector<ModData> mods;
		for (const boost::json::value& m : c.at("mods").as_array()) {
			ModData mod;
			mod.slot = modSlotFromName(std::string(m.at("slot").as_string())).value_or(ModSlot::Optic);
			if (const boost::json::value* cap = m.as_object().if_contains("capacity")) {
				mod.capacity = static_cast<uint8_t>(cap->to_number<int>());
			}
			for (const boost::json::value& s : m.at("stats").as_array()) {
				const boost::json::object& o = s.as_object();
				StatMod stat;
				stat.stat = weapon_mods::statFromName(std::string(o.at("name").as_string())).value_or(ModStat::Damage);
				if (const boost::json::value* add = o.if_contains("add")) stat.add = add->to_number<double>();
				if (const boost::json::value* pct = o.if_contains("percent")) stat.percent = pct->to_number<double>();
				mod.stats.push_back(stat);
			}
			mods.push_back(std::move(mod));
		}
		std::vector<const ModData*> pointers;
		for (const ModData& mod : mods) pointers.push_back(&mod);

		const boost::json::value* aimValue = c.as_object().if_contains("aim");
		const boost::json::object* aim = aimValue ? &aimValue->as_object() : nullptr;
		const WeaponStats got = weapon_mods::resolveStats(
			weaponModTestStats(c.at("base").as_object(), aim), pointers, c.at("hasMagazineSlot").as_bool());
		const boost::json::object& want = c.at("expect").as_object();
		for (size_t i = 0; i < MOD_STAT_COUNT; ++i) {
			// Hip stats are required; aim stats are named only by aiming cases.
			const boost::json::value* expected =
				i < AIM_STAT_FIRST ? &want.at(MOD_STAT_NAMES[i]) : want.if_contains(MOD_STAT_NAMES[i]);
			if (!expected) continue;
			const ModStat stat = static_cast<ModStat>(i);
			const double w = expected->to_number<double>();
			weaponModTestCheck(std::fabs(got.at(stat) - w) < 1e-6,
				fmt::format("{}: {} is {}, expected {}", name, MOD_STAT_NAMES[i], got.at(stat), w));
		}
		weaponModTestCheck(got.magazineSize == static_cast<uint8_t>(want.at("magazineSize").to_number<int>()),
			fmt::format("{}: magazineSize", name));
	}
}

// A weapon with a different number in every moddable field, so a mapping that
// swaps two of them (baseStats or resolveWeapon) cannot pass by coincidence.
EquipableData weaponModTestWeapon()
{
	EquipableData w;
	w.damage = 21;
	w.shotDelayMs = 137;
	w.spreadRadians = 0.31f;
	w.range = 733;
	w.speedMultiplier = 1.5f;
	w.recoilKickback = 2.25f;
	w.knockback = 3.75f;
	w.reloadMs = 1900;
	w.magazineSize = 17;
	return w;
}

ModSlotDef weaponModTestSlot(ModSlot type, uint16_t defaultIid, std::vector<uint16_t> accepts = {})
{
	ModSlotDef slot;
	slot.type = type;
	slot.defaultIid = defaultIid;
	slot.accepts = std::move(accepts);
	return slot;
}

// The helpers that read an EquipableData. Everything here works without
// ModManager content: no mod is ever looked up, only slots and empty WeaponMods.
void weaponModTestHelpers()
{
	const EquipableData plain = weaponModTestWeapon();

	// baseStats: each field lands on its own ModStat, the draw time is the argument.
	const WeaponStats base = weapon_mods::baseStats(plain, 1234);
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::Damage)] == 21.0, "baseStats: damage -> Damage");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::FireDelayMs)] == 137.0, "baseStats: shotDelayMs -> FireDelayMs");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::Spread)] == static_cast<double>(0.31f), "baseStats: spreadRadians -> Spread");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::Range)] == 733.0, "baseStats: range -> Range");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::BulletSpeed)] == 1.5, "baseStats: speedMultiplier -> BulletSpeed");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::Recoil)] == 2.25, "baseStats: recoilKickback -> Recoil");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::Knockback)] == 3.75, "baseStats: knockback -> Knockback");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::ReloadMs)] == 1900.0, "baseStats: reloadMs -> ReloadMs");
	weaponModTestCheck(base.value[static_cast<size_t>(ModStat::DrawMs)] == 1234.0, "baseStats: the drawMs argument -> DrawMs");
	weaponModTestCheck(base.magazineSize == 17, "baseStats: magazineSize");

	// resolveWeapon with nothing fitted returns every moddable field unchanged,
	// for a weapon with no slots and for one with slots but nothing in them.
	EquipableData slotted = plain;
	slotted.modSlots = {weaponModTestSlot(ModSlot::Optic, 0, {1}), weaponModTestSlot(ModSlot::Muzzle, 0, {2})};
	auto unchanged = [](const EquipableData& w, const char* label) {
		const EquipableData out = weapon_mods::resolveWeapon(w, WeaponMods{});
		weaponModTestCheck(out.damage == w.damage, fmt::format("resolveWeapon ({}): damage", label));
		weaponModTestCheck(out.shotDelayMs == w.shotDelayMs, fmt::format("resolveWeapon ({}): shotDelayMs", label));
		weaponModTestCheck(out.spreadRadians == w.spreadRadians, fmt::format("resolveWeapon ({}): spreadRadians", label));
		weaponModTestCheck(out.range == w.range, fmt::format("resolveWeapon ({}): range", label));
		weaponModTestCheck(out.speedMultiplier == w.speedMultiplier, fmt::format("resolveWeapon ({}): speedMultiplier", label));
		weaponModTestCheck(out.recoilKickback == w.recoilKickback, fmt::format("resolveWeapon ({}): recoilKickback", label));
		weaponModTestCheck(out.knockback == w.knockback, fmt::format("resolveWeapon ({}): knockback", label));
		weaponModTestCheck(out.reloadMs == w.reloadMs, fmt::format("resolveWeapon ({}): reloadMs", label));
		weaponModTestCheck(out.magazineSize == w.magazineSize, fmt::format("resolveWeapon ({}): magazineSize", label));
	};
	unchanged(plain, "no slots");
	unchanged(slotted, "slots, nothing fitted");

	// A weapon with a magazine slot and no magazine fitted holds nothing, even
	// if its base magazineSize says otherwise.
	EquipableData magSlot = plain; // magazineSize 17 in the base
	magSlot.modSlots = {weaponModTestSlot(ModSlot::Magazine, 0, {9})};
	weaponModTestCheck(weapon_mods::resolveWeapon(magSlot, WeaponMods{}).magazineSize == 0,
		"resolveWeapon: an empty magazine slot resolves to capacity 0");

	// Draw time: the base one when there are no slots, and when there are slots
	// but nothing fitted.
	weaponModTestCheck(weapon_mods::resolveDrawMs(plain, 1234, WeaponMods{}) == 1234, "resolveDrawMs: no slots keeps the base");
	weaponModTestCheck(weapon_mods::resolveDrawMs(slotted, 1234, WeaponMods{}) == 1234, "resolveDrawMs: nothing fitted keeps the base");

	// Fastest shot delay: the base one for a weapon that takes no mods, and for
	// slots that accept nothing.
	weaponModTestCheck(weapon_mods::fastestShotDelayMs(plain) == 137, "fastestShotDelayMs: no slots keeps the base");
	EquipableData emptyAccepts = plain;
	emptyAccepts.modSlots = {weaponModTestSlot(ModSlot::Optic, 0)};
	weaponModTestCheck(weapon_mods::fastestShotDelayMs(emptyAccepts) == 137, "fastestShotDelayMs: no accepted mods keeps the base");

	// Capacity: <ammo magazineSize> without a magazine slot, 0 with one and none fitted.
	weaponModTestCheck(weapon_mods::magazineCapacity(plain, WeaponMods{}) == 17, "magazineCapacity: no slots is the base magazineSize");
	weaponModTestCheck(weapon_mods::magazineCapacity(slotted, WeaponMods{}) == 17, "magazineCapacity: slots other than magazine leave the base");
	weaponModTestCheck(weapon_mods::magazineCapacity(magSlot, WeaponMods{}) == 0, "magazineCapacity: an empty magazine slot holds nothing");

	// Default mods: each slot's default lands in its own slot, everything else is 0.
	EquipableData withDefaults = plain;
	withDefaults.modSlots = {
		weaponModTestSlot(ModSlot::Magazine, 11, {11, 12}),
		weaponModTestSlot(ModSlot::Optic, 21, {21}),
		weaponModTestSlot(ModSlot::Muzzle, 0, {31}),
		weaponModTestSlot(ModSlot::Handguard, 61, {61}),
	};
	const WeaponMods defaults = weapon_mods::defaultMods(withDefaults);
	weaponModTestCheck(defaults.at(ModSlot::Magazine) == 11, "defaultMods: magazine");
	weaponModTestCheck(defaults.at(ModSlot::Optic) == 21, "defaultMods: optic");
	weaponModTestCheck(defaults.at(ModSlot::Muzzle) == 0, "defaultMods: a slot with no default stays empty");
	weaponModTestCheck(defaults.at(ModSlot::Underbarrel) == 0, "defaultMods: underbarrel (no slot)");
	weaponModTestCheck(defaults.at(ModSlot::Side) == 0, "defaultMods: side (no slot)");
	weaponModTestCheck(defaults.at(ModSlot::Stock) == 0, "defaultMods: stock (no slot)");
	weaponModTestCheck(defaults.at(ModSlot::Handguard) == 61, "defaultMods: handguard");
	weaponModTestCheck(weapon_mods::defaultMods(plain).empty(), "defaultMods: a weapon with no slots fits nothing");

	// An aiming weapon's aim numbers are recomputed from its percentages and time
	// when nothing is fitted: the three in-use fields start stale, so the check
	// passes only if resolveWeapon really derives them.
	EquipableData aiming = slotted;
	aiming.aim.enabled = true;
	aiming.aim.spreadPercent = -50.0;
	aiming.aim.movePercent = -20.0;
	aiming.aim.timeMs = 300;
	aiming.aim.spread = 0.0f;
	aiming.aim.move = 1.0f;
	aiming.aim.ms = 0;
	const EquipableData aimed = weapon_mods::resolveWeapon(aiming, WeaponMods{});
	weaponModTestCheck(std::fabs(aimed.aim.spread - 0.155f) < 1e-6f && std::fabs(aimed.aim.move - 0.8f) < 1e-6f &&
		aimed.aim.ms == 300, "resolveWeapon: an aiming weapon's aim numbers with nothing fitted");
}

// The content rules the loaders report: they are pure, so they run here on
// hand-made items and weapons. No ModManager content is read.
void weaponModTestContentRules()
{
	EquipableData plain = weaponModTestWeapon();
	plain.key = "plain_gun";
	plain.ammoKey = "round";
	EquipableData slotted = plain;
	slotted.key = "slotted_gun";
	slotted.modSlots = {weaponModTestSlot(ModSlot::Optic, 0, {1})};

	// A moddable weapon's item must be stack="1".
	const std::optional<std::string> stacking = weapon_mods::moddableStackProblem(weaponModTestItem(5, "slotted_gun", 5, ""), slotted);
	weaponModTestCheck(stacking && stacking->find("slotted_gun") != std::string::npos && stacking->find("stack") != std::string::npos,
		"a stackable item that takes mods is a problem naming the item and the rule");
	weaponModTestCheck(!weapon_mods::moddableStackProblem(weaponModTestItem(5, "slotted_gun", 1, ""), slotted),
		"a stack-1 item that takes mods is fine");
	weaponModTestCheck(!weapon_mods::moddableStackProblem(weaponModTestItem(5, "plain_gun", 5, ""), plain),
		"a stackable item that takes no mods is fine");

	// A weapon with ammo needs a magazineSize or a magazine slot.
	weaponModTestCheck(!weapon_mods::ammoProblem(plain), "ammo with a magazineSize is fine");
	EquipableData noMagazine = plain;
	noMagazine.magazineSize = 0;
	const std::optional<std::string> noRounds = weapon_mods::ammoProblem(noMagazine);
	weaponModTestCheck(noRounds && noRounds->find("plain_gun") != std::string::npos && noRounds->find("magazineSize") != std::string::npos,
		"ammo with no magazineSize and no magazine slot is a problem naming the weapon and the fix");
	noMagazine.modSlots = {weaponModTestSlot(ModSlot::Magazine, 0, {9})};
	weaponModTestCheck(!weapon_mods::ammoProblem(noMagazine), "ammo with no magazineSize but a magazine slot is fine");
	noMagazine.modSlots.clear();
	noMagazine.ammoKey.clear();
	weaponModTestCheck(!weapon_mods::ammoProblem(noMagazine), "a weapon with no ammo needs no magazine");

	// What a kit may put in a gun it creates.
	weaponModTestCheck(weapon_mods::kitAmmoCeiling(plain) == std::optional<uint8_t>{17}, "kit ammo: magazineSize caps a plain weapon");
	EquipableData noSize = plain;
	noSize.magazineSize = 0;
	weaponModTestCheck(!weapon_mods::kitAmmoCeiling(noSize), "kit ammo: no magazineSize and no slot has no ceiling");
	EquipableData emptyMagSlot = plain;
	emptyMagSlot.modSlots = {weaponModTestSlot(ModSlot::Magazine, 0, {9})};
	weaponModTestCheck(weapon_mods::kitAmmoCeiling(emptyMagSlot) == std::optional<uint8_t>{0},
		"kit ammo: a magazine slot with no default magazine holds nothing");
}

// Aim rules and the effective view: pure, on hand-made mods and weapons.
void weaponModTestAimRules()
{
	ModData viewOptic;
	viewOptic.key = "scope";
	viewOptic.iid = 11;
	viewOptic.slot = ModSlot::Optic;
	viewOptic.view.shape = ViewShape::Shift;
	viewOptic.view.ahead = 450;
	viewOptic.view.extend = 500;
	ModData aimGrip;
	aimGrip.key = "grip";
	aimGrip.iid = 12;
	aimGrip.slot = ModSlot::Underbarrel;
	aimGrip.stats.push_back({ModStat::AimSpread, 0.0, -10.0});
	ModData plainStock;
	plainStock.key = "stock";
	plainStock.iid = 13;
	plainStock.slot = ModSlot::Stock;
	plainStock.stats.push_back({ModStat::Recoil, 0.0, -20.0});
	const weapon_mods::ModByIid modByIid = [&](uint16_t iid) -> const ModData* {
		if (iid == 11) return &viewOptic;
		if (iid == 12) return &aimGrip;
		if (iid == 13) return &plainStock;
		return nullptr;
	};

	EquipableData gun = weaponModTestWeapon();
	gun.key = "gun";
	gun.modSlots = {weaponModTestSlot(ModSlot::Optic, 0, {11}), weaponModTestSlot(ModSlot::Underbarrel, 0, {12}),
		weaponModTestSlot(ModSlot::Stock, 0, {13})};
	const std::vector<std::string> noAim = weapon_mods::aimProblems(gun, modByIid);
	weaponModTestCheck(noAim.size() == 2 && weaponModTestMentions(noAim, "'scope'") && weaponModTestMentions(noAim, "'grip'"),
		"a weapon without <aim> may not take the scope with a view or the grip with an aim stat; the stock is fine");
	gun.aim.enabled = true;
	weaponModTestCheck(weapon_mods::aimProblems(gun, modByIid).empty(), "with <aim> they are fine");
	gun.aim.enabled = false;
	gun.modSlots.clear();
	gun.view.shape = ViewShape::Stretch;
	weaponModTestCheck(weaponModTestMentions(weapon_mods::aimProblems(gun, modByIid), "no <aim>"),
		"a built-in view without <aim> is a problem");

	ViewData own;
	own.shape = ViewShape::Stretch;
	own.ahead = 100;
	weaponModTestCheck(weapon_mods::effectiveView(own, {&viewOptic, &aimGrip}) == viewOptic.view,
		"the fitted optic's view wins over the weapon's own");
	weaponModTestCheck(weapon_mods::effectiveView(own, {&aimGrip}) == own, "without one, the weapon's own view");
}

void weaponModTestRounds()
{
	const weapon_mods::RoundsAfter swap = weapon_mods::moveRounds(22, uint8_t{8});
	weaponModTestCheck(swap.gun == 8 && swap.outgoing == 22,
		"a swap: the gun fires the new magazine's rounds and the old one keeps its own");
	const weapon_mods::RoundsAfter removed = weapon_mods::moveRounds(17, std::nullopt);
	weaponModTestCheck(removed.gun == 0 && removed.outgoing == 17, "removing: the magazine leaves with every round");
	bool conserved = true;
	for (int gun = 0; gun <= 40; gun += 5) {
		for (int in = 0; in <= 40; in += 5) {
			const weapon_mods::RoundsAfter r = weapon_mods::moveRounds(static_cast<uint8_t>(gun), static_cast<uint8_t>(in));
			conserved = conserved && r.gun + r.outgoing == gun + in;
		}
	}
	weaponModTestCheck(conserved, "no magazine change creates or loses a round");
}
} // namespace

int weapon_mods::runSelfTest(const std::string& fixtureDir)
{
	weaponModTestFailures = 0;
	weaponModTestParsing();
	weaponModTestResolver(fixtureDir);
	weaponModTestHelpers();
	weaponModTestContentRules();
	weaponModTestAimRules();
	weaponModTestRounds();
	if (weaponModTestFailures == 0) fmt::print(">> weapon mod self-test passed\n");
	return weaponModTestFailures == 0 ? 0 : 1;
}
