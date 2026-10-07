// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_XML_UTILS_H
#define FS_XML_UTILS_H

#include "gameplay/condition.h" // ConditionApplication, for parseConditionApplication
#include "core/definitions.h"
#include "gameplay/item.h"
#include "core/tools.h"
#include "content/content_files.h"

#include <algorithm>
#include <cstdio>
#include <fmt/format.h>
#include <map>
#include <pugixml.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace xml_utils {

// --- Data-file validation ---------------------------------------------------
//
// A malformed number is the quietest failure this content layer has: pugixml's
// as_uint/as_float stop at the first character they cannot use and report
// nothing, so agents.xml `explosion="0.0.1"` silently became 0.0 and nobody
// noticed until an audit. There is no hook on those accessors, so rather than
// wrap 200 call sites this walks the document once after it loads.
//
// It cannot know which attributes a loader will read as numbers, so it works
// the other way round: anything that BEGINS like a number is expected to be
// one, and the handful of attributes that legitimately hold digit-leading names
// are named below. A new string attribute starting with a digit produces a
// spurious warning, which is the right direction to be wrong in.

namespace detail {

// Attribute values that are names, not quantities. "9mm_bullet", "762_round"
// and "12G Pellet" all start with a digit, so without this they read as
// malformed numbers.
//
// Anything ending in "Key" is a name by construction -- itemKey, projectileKey,
// produceItemKey, fuelItemKey -- so that is a rule rather than a list entry, and
// a new ...Key attribute needs no maintenance here. The rest are named
// individually because their spelling says nothing about what they hold.
inline bool isNameAttribute(std::string_view attr)
{
	if (attr.size() > 3 && attr.substr(attr.size() - 3) == "Key") {
		return true;
	}
	return attr == "key" || attr == "name" ||
	       attr == "prerequisite" || attr == "base" || attr == "channel" ||
	       attr == "spawnCreature" ||
	       // A comma-separated list, not a single number.
	       attr == "ratesMs";
}

inline bool looksNumeric(std::string_view v)
{
	size_t i = 0;
	if (i < v.size() && (v[i] == '-' || v[i] == '+')) ++i;
	if (i < v.size() && v[i] == '.') ++i;
	return i < v.size() && v[i] >= '0' && v[i] <= '9';
}

// Whole string must be consumed: "0.0.1", "10px" and "5 " are all rejected.
inline bool isNumber(std::string_view v)
{
	size_t i = 0;
	if (i < v.size() && (v[i] == '-' || v[i] == '+')) ++i;
	size_t digits = 0;
	while (i < v.size() && v[i] >= '0' && v[i] <= '9') { ++i; ++digits; }
	if (i < v.size() && v[i] == '.') {
		++i;
		while (i < v.size() && v[i] >= '0' && v[i] <= '9') { ++i; ++digits; }
	}
	if (digits == 0) return false;
	if (i < v.size() && (v[i] == 'e' || v[i] == 'E')) {
		++i;
		if (i < v.size() && (v[i] == '-' || v[i] == '+')) ++i;
		size_t expDigits = 0;
		while (i < v.size() && v[i] >= '0' && v[i] <= '9') { ++i; ++expDigits; }
		if (expDigits == 0) return false;
	}
	return i == v.size();
}

// Source text, read on demand so a clean boot never touches the disk twice.
// Startup is single-threaded; this is not safe to call once the game is live.
inline const std::string& sourceOf(const std::string& fileName)
{
	static std::map<std::string, std::string> cache;
	auto it = cache.find(fileName);
	if (it != cache.end()) return it->second;

	std::string text;
	if (FILE* f = std::fopen(fileName.c_str(), "rb")) {
		char buf[8192];
		size_t n;
		while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, n);
		std::fclose(f);
	}
	return cache.emplace(fileName, std::move(text)).first->second;
}

} // namespace detail

// "items.xml:1523" when pugixml can place the node in its source, otherwise
// just the file name. offset_debug() is a byte offset into the parsed buffer;
// converting it costs a file read, which only ever happens on a warning.
inline std::string locate(const std::string& fileName, const pugi::xml_node& node)
{
	const ptrdiff_t offset = node.offset_debug();
	if (offset < 0) return fileName;

	const std::string& src = detail::sourceOf(fileName);
	if (src.empty() || static_cast<size_t>(offset) > src.size()) return fileName;

	size_t line = 1;
	for (size_t i = 0; i < static_cast<size_t>(offset); ++i) {
		if (src[i] == '\n') ++line;
	}
	return fileName + ":" + std::to_string(line);
}

// "--" inside an XML comment is illegal, and pugixml is the only reader here
// that accepts it. So the server boots happily on a file that every other tool
// -- an editor's validator, a formatter, ElementTree, any future XSD step --
// refuses outright, which is how the whole content set was once unusable by
// anything but this server. Cheap to check, and it stays checked.
//
// Scans the source text rather than the tree because pugixml discards comments
// unless asked for them, and the text is already cached for locate().
inline void validateComments(const std::string& fileName)
{
	const std::string& src = detail::sourceOf(fileName);
	size_t pos = 0;
	while ((pos = src.find("<!--", pos)) != std::string::npos) {
		const size_t bodyStart = pos + 4;
		const size_t end = src.find("-->", bodyStart);
		if (end == std::string::npos) break;

		const size_t bad = src.find("--", bodyStart);
		if (bad != std::string::npos && bad < end) {
			size_t line = 1;
			for (size_t i = 0; i < bad; ++i) {
				if (src[i] == '\n') ++line;
			}
			reportDataWarning(fileName, fmt::format(
				"{}:{}: \"--\" inside a comment. pugixml allows it; standard XML does not, "
				"so every other tool will reject this file", fileName, line));
		}
		pos = end + 3;
	}
}

// Walk a freshly loaded data file and report anything structurally wrong that
// no loader would notice. One call per file; see the note above for why this is
// a document pass rather than a wrapper on the accessors.
inline void validateDocument(const std::string& fileName, const pugi::xml_node& node)
{
	// Presentation belongs to the client; the server only exports these subtrees.
	if (std::string_view(node.name()) == "client") return;
	for (const pugi::xml_attribute attr : node.attributes()) {
		const std::string_view name = attr.name();
		const std::string_view value = attr.value();

		if (value.empty()) {
			reportDataWarning(fileName, fmt::format("{}: <{} {}=\"\"> is empty",
				locate(fileName, node), node.name(), name));
			continue;
		}
		if (detail::isNameAttribute(name)) continue;
		if (!detail::looksNumeric(value)) continue;
		if (detail::isNumber(value)) continue;

		reportDataWarning(fileName, fmt::format("{}: <{} {}=\"{}\"> is not a number",
			locate(fileName, node), node.name(), name, value));
	}

	for (pugi::xml_node child = node.first_child(); child; child = child.next_sibling()) {
		if (child.type() == pugi::node_element) validateDocument(fileName, child);
	}
}

// --- What actually got loaded, in the order it got loaded ------------------
//
// Every content file passes through openDataFile, which makes it the one place
// that can record the real load ORDER. content.xml declares what that order is
// supposed to be and why; verifyContentManifest compares the two.
//
// The order is load-bearing and was documented only in comments spread over two
// functions: items before everything that resolves an item key, objects before
// the map records that name them, agents before the modes that spawn them. A
// comment cannot be checked, and getting it wrong is silent -- resources.xml
// used to load before items.xml and nobody noticed until a key had to resolve.
struct LoadedFile {
	std::string name;  // bare file name, no directory
	std::string root;  // the root element it actually had
};

inline std::vector<LoadedFile>& loadedFiles()
{
	static std::vector<LoadedFile> files;
	return files;
}

// Bare file name, so the manifest does not have to know about contentPath.
inline void noteFileLoaded(const std::string& fileName, const std::string& rootName)
{
	const size_t slash = fileName.find_last_of("/\\");
	std::string bare = slash == std::string::npos ? fileName : fileName.substr(slash + 1);
	// objects.xml and items.xml are each opened twice by different managers;
	// the first time is the one that fixes the order.
	for (const LoadedFile& f : loadedFiles()) {
		if (f.name == bare) return;
	}
	loadedFiles().push_back({std::move(bare), rootName});
}

// Open a data file and hand back its root element, having already validated the
// document. Returns an EMPTY node on failure -- a caller that gets one must
// return false, because loading nothing is not success.
//
// This exists because both failure modes were silent in several loaders. A
// parse error returned false with no message (items, projectiles, resources,
// modes), and a missing or renamed root element was worse: the record loop
// simply found nothing, the loader reported "0 items" and returned TRUE.
inline pugi::xml_node openDataFile(pugi::xml_document& doc, const std::string& fileName, const char* rootName)
{
	pugi::xml_node root;
	try { root = content_files::load(doc, fileName, rootName); }
	catch (const std::exception& e) { fmt::print(">> [Error] {}\n", e.what()); return {}; }

	validateDocument(fileName, root);
	validateComments(fileName);
	noteFileLoaded(fileName, rootName);
	return root;
}

// Reads a <drops> block into the shared ItemDrop shape (definitions.h). See the
// note there for the format and why there is only one of it.
// Reads every <item> under `dropsNode`. `ownerKey` only ever appears in warnings.
inline void parseItemDrops(const pugi::xml_node& dropsNode, std::vector<ItemDrop>& out,
                           const std::string& fileName, const std::string& ownerKey)
{
	for (pugi::xml_node node = dropsNode.child("item"); node; node = node.next_sibling("item")) {
		ItemDrop drop;
		drop.itemKey = node.attribute("key").as_string();
		drop.amount = static_cast<uint8_t>(node.attribute("amount").as_uint(1));
		drop.amountMax = static_cast<uint8_t>(node.attribute("amountMax").as_uint(0));
		drop.chance = node.attribute("chance").as_float(1.0f);

		if (drop.itemKey.empty()) {
			reportDataWarning(fileName, fmt::format(
				"{}: <item> drop with no key=; it drops nothing", ownerKey));
			continue;
		}
		const ItemData* idata = ItemManager::getInstance().getItemData(drop.itemKey);
		if (!idata) {
			reportDataWarning(fileName, fmt::format(
				"{}: drops '{}', which is not an item in items.xml", ownerKey, drop.itemKey));
			continue;
		}
		drop.iid = idata->id;
		drop.lootId = idata->lootId;

		if (drop.amountMax != 0 && drop.amountMax < drop.amount) {
			reportDataWarning(fileName, fmt::format(
				"{}: drop '{}' has amountMax {} below amount {}; treating it as fixed",
				ownerKey, drop.itemKey, drop.amountMax, drop.amount));
			drop.amountMax = 0;
		}
		out.push_back(std::move(drop));
	}
}

// A `condition=` / `chance=` pair off whatever element carries it, into the
// shared ConditionApplication shape (condition.h). Used by projectiles.xml
// <onHit> and agents.xml <ability>.
//
// The key is NOT resolved here: conditions.xml loads after both of those files,
// so there is nothing to resolve against yet. validateDataReferences checks it
// afterwards, which is also why an absent attribute is silence rather than a
// warning -- most projectiles and abilities inflict nothing, and that is normal.
inline void parseConditionApplication(const pugi::xml_node& node, ConditionApplication& out,
                                      const std::string& fileName, const std::string& ownerKey)
{
	const pugi::xml_attribute keyAttr = node.attribute("condition");
	if (!keyAttr) return;

	out.key = keyAttr.as_string();
	out.chance = node.attribute("chance").as_float(1.0f);
	out.chancePerDamage = node.attribute("chancePerDamage").as_float(0.0f);
	// This source's own timing and severity, overriding the condition's first
	// stage. Absent means "whatever conditions.xml says", which is what every
	// existing entry means.
	out.durationMs = node.attribute("durationMs").as_uint(0);
	out.strength = node.attribute("strength").as_float(1.0f);

	if (out.key.empty()) {
		reportDataWarning(fileName, fmt::format(
			"{}: <{} condition=\"\"> is empty; it inflicts nothing", ownerKey, node.name()));
		return;
	}
	// A chance of 0 is a condition nobody can ever suffer, which is almost
	// always a typo for "always" rather than a deliberate never.
	//
	// Unless chancePerDamage carries it: "0 base, rising with the hit" is the
	// whole point of a damage-scaled stun, and refusing it would make the
	// feature unusable in its most natural form.
	if (out.chance < 0.0f || out.chance > 1.0f ||
	    (out.chance == 0.0f && out.chancePerDamage <= 0.0f)) {
		reportDataWarning(fileName, fmt::format(
			"{}: <{} condition=\"{}\" chance=\"{}\"> is outside 0..1 (or zero with no "
			"chancePerDamage to raise it); using 1.0",
			ownerKey, node.name(), out.key, out.chance));
		out.chance = 1.0f;
	}
	if (out.chancePerDamage < 0.0f) {
		reportDataWarning(fileName, fmt::format(
			"{}: <{} condition=\"{}\" chancePerDamage=\"{}\"> is negative, which would make a "
			"bigger hit LESS likely to land it; ignoring",
			ownerKey, node.name(), out.key, out.chancePerDamage));
		out.chancePerDamage = 0.0f;
	}
	// A strength of 0 is a dose that does nothing measurable while still
	// occupying the slot -- almost always a typo for "leave it alone" (omit the
	// attribute) rather than a deliberate inert application. Negative is
	// meaningless outright: it would invert every modifier, turning a slow into
	// a speed boost.
	if (out.strength <= 0.0f) {
		reportDataWarning(fileName, fmt::format(
			"{}: <{} condition=\"{}\" strength=\"{}\"> must be above 0 -- 0 applies a condition "
			"that does nothing and a negative one would INVERT it (a slow becomes a boost). "
			"Using 1.0; omit the attribute for the condition as written",
			ownerKey, node.name(), out.key, out.strength));
		out.strength = 1.0f;
	}
}

// <leech life= stamina= maxPerHit=>: a fraction of the damage dealt returned to
// the attacker. One parser for a weapon, a round and a bite.
inline void parseLeech(const pugi::xml_node& parent, LeechSpec& out,
                       const std::string& fileName, const std::string& ownerKey)
{
	const pugi::xml_node node = parent.child("leech");
	if (!node) return;

	const auto fraction = [&](const char* attr) {
		float v = node.attribute(attr).as_float(0.0f);
		if (v < 0.0f || v > 1.0f) {
			reportDataWarning(fileName, fmt::format(
				"{}: <leech {}=\"{}\"> is not a 0..1 fraction; clamping", ownerKey, attr, v));
			v = std::clamp(v, 0.0f, 1.0f);
		}
		return v;
	};
	out.life = fraction("life");
	out.stamina = fraction("stamina");
	out.maxPerHit = static_cast<uint16_t>(
		std::clamp<long long>(node.attribute("maxPerHit").as_llong(0), 0, 65535));

	if (out.empty()) {
		reportDataWarning(fileName, fmt::format(
			"{}: <leech> returns neither life= nor stamina=; it does nothing", ownerKey));
		return;
	}

	// An uncapped leech is a footgun on any multi-projectile weapon, because it
	// pays out once per PELLET: a 5-pellet shotgun at 15% returns 75% of a full
	// volley. Defaulted rather than refused -- a single-shot weapon is fine
	// without one -- but said out loud, because the author of a shotgun almost
	// certainly did not mean it.
	if (out.maxPerHit == 0) {
		out.maxPerHit = LEECH_DEFAULT_MAX_PER_HIT;
		reportDataWarning(fileName, fmt::format(
			"{}: <leech> has no maxPerHit=; defaulting to {}. A multi-pellet weapon leeches "
			"once per pellet, so an uncapped one returns far more than one hit's worth",
			ownerKey, LEECH_DEFAULT_MAX_PER_HIT));
	}
}

// <crit chance= multiplier= condition= conditionChance=>.
inline void parseCrit(const pugi::xml_node& parent, CritSpec& out,
                      const std::string& fileName, const std::string& ownerKey)
{
	const pugi::xml_node node = parent.child("crit");
	if (!node) return;

	out.chance = node.attribute("chance").as_float(0.0f);
	out.multiplier = node.attribute("multiplier").as_float(2.0f);

	if (out.chance < 0.0f || out.chance > 1.0f) {
		reportDataWarning(fileName, fmt::format(
			"{}: <crit chance=\"{}\"> is not a 0..1 fraction; clamping", ownerKey, out.chance));
		out.chance = std::clamp(out.chance, 0.0f, 1.0f);
	}
	// Below 1 is not a critical hit, it is a critical MISS, and nothing in the
	// vocabulary here says that. Refused rather than honoured so it cannot be
	// written by accident and read as working.
	if (out.multiplier < 1.0f) {
		reportDataWarning(fileName, fmt::format(
			"{}: <crit multiplier=\"{}\"> is below 1, which would make a crit hurt LESS; "
			"using 2.0", ownerKey, out.multiplier));
		out.multiplier = 2.0f;
	}

	// The crit's own condition rides the shared shape, but spells its chance
	// `conditionChance` and its duration `conditionDurationMs` so the two of
	// each on one element cannot be confused.
	const pugi::xml_attribute condAttr = node.attribute("condition");
	if (condAttr) {
		out.onCrit.key = condAttr.as_string();
		out.onCrit.durationMs = node.attribute("conditionDurationMs").as_uint(0);
		out.onCrit.strength = node.attribute("conditionStrength").as_float(1.0f);
		out.onCrit.chance = node.attribute("conditionChance").as_float(1.0f);
		if (out.onCrit.chance < 0.0f || out.onCrit.chance > 1.0f) {
			reportDataWarning(fileName, fmt::format(
				"{}: <crit conditionChance=\"{}\"> is outside 0..1; using 1.0",
				ownerKey, out.onCrit.chance));
			out.onCrit.chance = 1.0f;
		}
	}
}

// Everything a damage source does beyond the damage itself, in one call.
inline void parseHitEffects(const pugi::xml_node& parent, HitEffects& out,
                            const std::string& fileName, const std::string& ownerKey)
{
	parseConditionApplication(parent.child("onHit"), out.onHit, fileName, ownerKey);
	parseLeech(parent, out.leech, fileName, ownerKey);
	parseCrit(parent, out.crit, fileName, ownerKey);
}

template <typename Explosion>
bool parseExplosionChild(const pugi::xml_node& parentNode, Explosion& explosion, bool allowMisspelledKnockback = false)
{
	const pugi::xml_node explosionNode = parentNode.child("explosion");
	if (!explosionNode) {
		return false;
	}

	explosion.enabled = true;
	explosion.playerDamage = clampDamageAmount(explosionNode.attribute("playerDamage").as_llong());
	explosion.buildingDamage = clampDamageAmount(explosionNode.attribute("buildingDamage").as_llong());
	explosion.knockback = explosionNode.attribute("knockback").as_float(0.0f);
	if (allowMisspelledKnockback && explosion.knockback == 0.0f) {
		explosion.knockback = explosionNode.attribute("knocback").as_float(0.0f);
	}
	explosion.radius = static_cast<uint16_t>(explosionNode.attribute("radius").as_uint());
	explosion.area = static_cast<uint16_t>(explosionNode.attribute("area").as_uint());

	// <explosion><onHit condition= chance= durationMs=/></explosion>: what the
	// blast inflicts on every creature it catches -- a stun grenade, a gas
	// charge. Here rather than in each of the three callers so the projectile,
	// object and agent explosions cannot drift apart; the file name is not
	// available at this depth, so the owner string is generic.
	parseConditionApplication(explosionNode.child("onHit"), explosion.onHit,
	                          "explosion", "an <explosion>");
	return true;
}

inline AreaEffect parseAreaEffect(const pugi::xml_node& effectNode)
{
	AreaEffect areaEffect;
	areaEffect.id = static_cast<uint16_t>(effectNode.attribute("id").as_uint());
	areaEffect.type = effectNode.attribute("type").as_string();
	areaEffect.strength = static_cast<uint16_t>(effectNode.attribute("strength").as_uint());
	areaEffect.radius = static_cast<uint16_t>(effectNode.attribute("radius").as_uint());
	// -1 when the attribute is absent, so area="0" survives as a real value and
	// means the emitter's own tile. as_int on a missing attribute returns the
	// default, which is what makes this work.
	areaEffect.area = effectNode.attribute("area").as_int(-1);
	areaEffect.needsFuel = effectNode.attribute("needsFuel").as_bool(false);
	// Every area effect in the game data is built here, so this is the one
	// place that has to keep the search-box bound current.
	noteAreaEffectReach(areaEffect);
	return areaEffect;
}

inline void appendAreaEffects(const pugi::xml_node& effectsNode, std::vector<AreaEffect>& areaEffects)
{
	for (pugi::xml_node effectNode = effectsNode.child("areaEffect"); effectNode; effectNode = effectNode.next_sibling("areaEffect")) {
		areaEffects.push_back(parseAreaEffect(effectNode));
	}
}

} // namespace xml_utils

#endif // FS_XML_UTILS_H
