// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/effect.h"
#include "gameplay/area_fill.h"
#include "content/xml_utils.h"
#include "core/definitions.h"
#include "core/tools.h"
#include "network/opcodes.h"
#include <algorithm>
#include <cmath>
#include <fmt/format.h>
#include <pugixml.hpp>
#include <unordered_set>

namespace {

// How deep effects may chain into each other (<effect> in an effect, a zone's
// <onEnd>). Deeper is a loop in the data, not a design.
constexpr int effectMaxDepth = 8;

std::vector<std::string> effectSplitList(const std::string& text)
{
	std::vector<std::string> out;
	size_t start = 0;
	while (start <= text.size()) {
		const size_t comma = text.find(',', start);
		std::string part = text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
		part.erase(0, part.find_first_not_of(" \t"));
		part.erase(part.find_last_not_of(" \t") + 1);
		if (!part.empty()) out.push_back(part);
		if (comma == std::string::npos) break;
		start = comma + 1;
	}
	return out;
}

// Overrides on a reference, merged into a copy of the named effect: each
// attribute replaces the one of the same name, each child element merges into
// the copy's first child of that name (or is added if there is none). A nested
// <effect> is never merged: it is one more effect to chain.
void effectMergeOverrides(pugi::xml_node target, const pugi::xml_node& overrides)
{
	for (const pugi::xml_attribute attr : overrides.attributes()) {
		if (std::string_view(attr.name()) == "key" && std::string_view(target.name()) == "effect") continue;
		pugi::xml_attribute mine = target.attribute(attr.name());
		if (!mine) mine = target.append_attribute(attr.name());
		mine.set_value(attr.value());
	}
	for (pugi::xml_node child = overrides.first_child(); child; child = child.next_sibling()) {
		if (child.type() != pugi::node_element) continue;
		const std::string_view name = child.name();
		pugi::xml_node mine = name == "effect" ? pugi::xml_node() : target.child(child.name());
		// <cloud> and <zone> are one element under two names.
		if (!mine && name == "zone") mine = target.child("cloud");
		if (!mine && name == "cloud") mine = target.child("zone");
		if (mine) {
			effectMergeOverrides(mine, child);
		} else {
			target.append_copy(child);
		}
	}
}

} // namespace

bool EffectData::firesFragments() const
{
	if (fragments.enabled) return true;
	for (const EffectData& next : then) {
		if (next.firesFragments()) return true;
	}
	return zone.onEnd && zone.onEnd->firesFragments();
}

bool effectsFireFragments(const EffectList& effects)
{
	for (const EffectData& effect : effects) {
		if (effect.firesFragments()) return true;
	}
	return false;
}

void parseZoneNode(const pugi::xml_node& node, EffectZone& zone, const std::string& fileName, const std::string& ownerKey)
{
	const std::string element = node.name();
	const std::string kind = node.attribute("kind").as_string("gas");
	if (kind == "gas") {
		zone.kind = static_cast<uint8_t>(CloudKind::GAS);
	} else if (kind == "smoke") {
		zone.kind = static_cast<uint8_t>(CloudKind::SMOKE);
	} else if (kind == "fire") {
		zone.kind = static_cast<uint8_t>(CloudKind::FIRE);
	} else {
		reportDataWarning(fileName, fmt::format(
			"{} has <{} kind=\"{}\">; the kinds are gas, smoke and fire. Using gas", ownerKey, element, kind));
		zone.kind = static_cast<uint8_t>(CloudKind::GAS);
	}

	const uint32_t tiles = node.attribute("tiles").as_uint(0);
	zone.tiles = static_cast<uint8_t>(std::min<uint32_t>(tiles, area_fill::kMaxCells));
	// Default radius: what `tiles` covers as a disc, plus a ring of slack so a
	// wall on one side lets it reach further on the other.
	const float defaultRadius = std::sqrt(static_cast<float>(zone.tiles) / 3.14159f) + 1.0f;
	const float radius = node.attribute("radius").as_float(defaultRadius);
	zone.radius = std::clamp(radius, 0.0f, static_cast<float>(area_fill::kMaxRadius));

	const auto phase = [&](const char* name, uint32_t fallback) {
		const uint32_t ms = node.attribute(name).as_uint(fallback);
		if (ms > CLOUD_MAX_PHASE_MS) {
			reportDataWarning(fileName, fmt::format(
				"{} has <{} {}=\"{}\">; clamped to {}", ownerKey, element, name, ms, CLOUD_MAX_PHASE_MS));
		}
		return static_cast<uint16_t>(std::min(ms, CLOUD_MAX_PHASE_MS));
	};
	zone.growMs = phase("growMs", 0);
	zone.holdMs = phase("holdMs", 0);
	zone.fadeMs = phase("fadeMs", 0);
	const uint32_t tickMs = node.attribute("tickMs").as_uint(500);
	zone.tickMs = static_cast<uint16_t>(std::clamp(tickMs, CLOUD_MIN_TICK_MS, CLOUD_MAX_PHASE_MS));

	zone.blocksVision = node.attribute("blocksVision").as_bool(zone.kind == static_cast<uint8_t>(CloudKind::SMOKE));
	zone.damage = clampDamageAmount(node.attribute("damage").as_llong());
	zone.buildingDamage = clampDamageAmount(node.attribute("buildingDamage").as_llong());
	zone.burns = effectSplitList(node.attribute("burns").as_string("wood,cloth"));
	zone.damageType = node.attribute("damageType").as_string("gas");
	zone.onHit = ConditionApplication{};
	xml_utils::parseConditionApplication(node.child("onHit"), zone.onHit, fileName, ownerKey);

	// The shape.
	const std::string shape = node.attribute("shape").as_string("fill");
	if (shape != "fill" && shape != "line") {
		reportDataWarning(fileName, fmt::format(
			"{} has <{} shape=\"{}\">; the shapes are fill and line. Using fill", ownerKey, element, shape));
	}
	zone.line = shape == "line";
	const float stretch = node.attribute("stretch").as_float(zone.line ? 3.0f : 1.0f);
	zone.stretch = std::clamp(stretch, 1.0f, 6.0f);
	const float forward = node.attribute("forward").as_float(0.0f);
	zone.forward = std::clamp(forward, -static_cast<float>(area_fill::kMaxRadius), static_cast<float>(area_fill::kMaxRadius));
	const float irregular = node.attribute("irregular").as_float(0.0f);
	zone.irregular = std::clamp(irregular, 0.0f, 1.0f);
	if (stretch != zone.stretch || forward != zone.forward || irregular != zone.irregular) {
		reportDataWarning(fileName, fmt::format(
			"{} has <{} stretch=\"{}\" forward=\"{}\" irregular=\"{}\">; clamped to {}, {} and {}",
			ownerKey, element, stretch, forward, irregular, zone.stretch, zone.forward, zone.irregular));
	}
	zone.blockedBy = 0;
	for (const std::string& what : effectSplitList(node.attribute("blockedBy").as_string("walls"))) {
		if (what == "walls") {
			zone.blockedBy |= ZoneBlock::Walls;
		} else if (what == "scenery") {
			zone.blockedBy |= ZoneBlock::Scenery;
		} else if (what == "none") {
			// Nothing but the map's edge.
		} else {
			reportDataWarning(fileName, fmt::format(
				"{} has <{} blockedBy=\"{}\">; the choices are walls, scenery and none", ownerKey, element, what));
		}
	}

	zone.enabled = zone.tiles > 0 && (zone.growMs + zone.holdMs + zone.fadeMs) > 0;
	if (tiles > zone.tiles || radius != zone.radius) {
		reportDataWarning(fileName, fmt::format(
			"{} has <{} tiles=\"{}\" radius=\"{}\">; clamped to {} and {}",
			ownerKey, element, tiles, radius, zone.tiles, zone.radius));
	}
	if (!zone.enabled) {
		reportDataWarning(fileName, fmt::format(
			"{} has a <{}> with no tiles or no duration; it does nothing", ownerKey, element));
	}
}

void parseFragmentsNode(const pugi::xml_node& fragNode, EffectFragments& frags, const std::string& fileName,
                        const std::string& ownerKey)
{
	frags.projectileKey = fragNode.attribute("projectile").as_string();
	const uint32_t count = fragNode.attribute("count").as_uint(0);
	const uint32_t range = fragNode.attribute("range").as_uint(0);
	// Every fragment is a projectile entity sent to every watcher, three
	// records each (create, stop, remove): the count is the bandwidth of a
	// blast, so it is capped.
	frags.count = static_cast<uint8_t>(std::min<uint32_t>(count, PROJECTILE_FRAGMENT_MAX_COUNT));
	frags.range = static_cast<uint16_t>(std::min<uint32_t>(range, PROJECTILE_FRAGMENT_MAX_RANGE));
	frags.damage = clampDamageAmount(fragNode.attribute("damage").as_llong());
	// Like a gun's <buildingDamage>: what it does to a body unless stated.
	frags.buildingDamage = fragNode.attribute("buildingDamage")
		? clampDamageAmount(fragNode.attribute("buildingDamage").as_llong())
		: frags.damage;
	frags.knockback = std::max(0.0f, fragNode.attribute("knockback").as_float(0.0f));
	frags.speedMultiplier = fragNode.attribute("speedMultiplier").as_float(1.0f);
	if (frags.speedMultiplier <= 0.0f) {
		reportDataWarning(fileName, fmt::format(
			"{} has <fragments speedMultiplier=\"{}\">; using 1.0", ownerKey, frags.speedMultiplier));
		frags.speedMultiplier = 1.0f;
	}
	const EffectFragments defaults;
	frags.spread = std::clamp(fragNode.attribute("spread").as_float(defaults.spread), 0.0f, 1.0f);
	frags.rangeVariation = std::clamp(fragNode.attribute("rangeVariation").as_float(defaults.rangeVariation), 0.0f, 0.9f);
	frags.speedVariation = std::clamp(fragNode.attribute("speedVariation").as_float(defaults.speedVariation), 0.0f, 0.9f);
	frags.falloff = std::clamp(fragNode.attribute("falloff").as_float(defaults.falloff), 0.0f, 1.0f);
	frags.enabled = !frags.projectileKey.empty() && frags.count > 0 && frags.range > 0;
	if (count != frags.count || range != frags.range) {
		reportDataWarning(fileName, fmt::format(
			"{} has <fragments count=\"{}\" range=\"{}\">; clamped to {} and {}",
			ownerKey, count, range, frags.count, frags.range));
	}
	if (!frags.enabled) {
		reportDataWarning(fileName, fmt::format(
			"{} has <fragments> without a projectile, a count and a range; it does nothing", ownerKey));
	}
}

bool EffectManager::parseBody(const pugi::xml_node& node, EffectData& out, const std::string& fileName,
                              const std::string& ownerKey, int depth) const
{
	bool any = false;

	if (node.child("explosion")) {
		out.explosion = EffectExplosion{};
		xml_utils::parseExplosionChild(node, out.explosion, true);
		any = true;
	}

	if (pugi::xml_node fragNode = node.child("fragments")) {
		out.fragments = EffectFragments{};
		parseFragmentsNode(fragNode, out.fragments, fileName, ownerKey);
		any = true;
	}

	if (node.child("shrapnel")) {
		reportDataWarning(fileName, fmt::format(
			"{} has <shrapnel>, which is gone: fragments are real projectiles now. "
			"Write <fragments projectile=\"...\" count= range= damage=/> instead", ownerKey));
	}

	pugi::xml_node zoneNode = node.child("zone");
	if (pugi::xml_node cloudNode = node.child("cloud")) {
		if (zoneNode) {
			reportDataWarning(fileName, fmt::format(
				"{} has both <zone> and <cloud>, which are one element under two names; the <cloud> is ignored. "
				"Chain a second effect for a second zone", ownerKey));
		} else {
			zoneNode = cloudNode;
		}
	}
	if (zoneNode) {
		out.zone = EffectZone{};
		parseZoneNode(zoneNode, out.zone, fileName, ownerKey);
		out.zone.effectId = out.clientEffectId;
		if (pugi::xml_node endNode = zoneNode.child("onEnd")) {
			EffectData after;
			pugi::xml_document refDoc;
			pugi::xml_node ref = refDoc.append_child("effect");
			ref.append_attribute("key").set_value(endNode.attribute("effect").as_string());
			for (pugi::xml_node child = endNode.first_child(); child; child = child.next_sibling()) {
				if (child.type() == pugi::node_element) ref.append_copy(child);
			}
			if (resolve(ref, after, fileName, ownerKey, depth + 1)) {
				out.zone.onEnd = std::make_shared<const EffectData>(std::move(after));
			}
		}
		any = true;
	}

	for (pugi::xml_node ref = node.child("effect"); ref; ref = ref.next_sibling("effect")) {
		EffectData next;
		if (resolve(ref, next, fileName, ownerKey, depth + 1)) {
			out.then.push_back(std::move(next));
		}
		any = true;
	}
	return any;
}

bool EffectManager::resolve(const pugi::xml_node& ref, EffectData& out, const std::string& fileName,
                            const std::string& ownerKey, int depth) const
{
	const std::string key = ref.attribute("key").as_string();
	if (key.empty()) {
		reportDataWarning(fileName, fmt::format("{} has an <effect> with no key=", ownerKey));
		return false;
	}
	if (depth > effectMaxDepth) {
		reportDataWarning(fileName, fmt::format(
			"{}: effect '{}' chains more than {} effects deep; an effect probably names itself. Cut off there",
			ownerKey, key, effectMaxDepth));
		return false;
	}
	const auto it = nodes.find(key);
	if (it == nodes.end()) {
		reportDataWarning(fileName, fmt::format(
			"{} names effect '{}', which effects.xml does not define", ownerKey, key));
		return false;
	}

	bool overridden = false;
	for (pugi::xml_node child = ref.first_child(); child; child = child.next_sibling()) {
		if (child.type() == pugi::node_element) {
			overridden = true;
			break;
		}
	}
	if (!overridden) {
		const auto cached = effects.find(key);
		if (cached != effects.end()) {
			out = cached->second;
			return true;
		}
	}

	pugi::xml_document merged;
	pugi::xml_node body = merged.append_copy(it->second);
	if (overridden) effectMergeOverrides(body, ref);

	out = EffectData{};
	out.key = key;
	out.clientEffectId = static_cast<uint16_t>(it->second.attribute("clientEffectId").as_uint(0));
	// Problems in an override belong to the file that wrote it; the rest to
	// effects.xml, where the entry is.
	if (overridden) {
		parseBody(body, out, fileName, fmt::format("{} (effect '{}')", ownerKey, key), depth);
	} else {
		parseBody(body, out, sourceFile, fmt::format("effect '{}'", key), depth);
	}
	return true;
}

bool EffectManager::loadFromXml(const std::string& filename)
{
	auto doc = std::make_shared<pugi::xml_document>();
	pugi::xml_document file;
	const pugi::xml_node root = xml_utils::openDataFile(file, filename, "effects");
	if (!root) return false;

	sources = doc;
	sourceFile = filename;
	nodes.clear();
	effects.clear();

	pugi::xml_node kept = doc->append_child("effects");
	std::unordered_map<uint16_t, std::string> ids;
	std::vector<std::string> order;
	for (pugi::xml_node node = root.child("effect"); node; node = node.next_sibling("effect")) {
		const std::string key = node.attribute("key").as_string();
		if (key.empty()) {
			reportDataWarning(filename, fmt::format("{}: an <effect> has no key=; skipped", xml_utils::locate(filename, node)));
			continue;
		}
		if (nodes.count(key)) {
			reportDataWarning(filename, fmt::format("effect '{}' is defined twice; the second is skipped", key));
			continue;
		}
		if (!node.attribute("clientEffectId")) {
			reportDataWarning(filename, fmt::format(
				"effect '{}' has no clientEffectId=; the content export needs one on every effect", key));
		} else {
			const uint16_t id = static_cast<uint16_t>(node.attribute("clientEffectId").as_uint(0));
			if (id == 0) {
				reportDataWarning(filename, fmt::format(
					"effect '{}' has clientEffectId=\"0\", which means \"no look\"; ids start at 1", key));
			} else if (auto [at, fresh] = ids.emplace(id, key); !fresh) {
				reportDataWarning(filename, fmt::format(
					"effects '{}' and '{}' share clientEffectId {}; clients will draw both as '{}'",
					at->second, key, id, at->second));
			}
		}
		nodes[key] = kept.append_copy(node);
		order.push_back(key);
	}

	// Every entry is known now, so one may name another declared after it.
	for (const std::string& key : order) {
		pugi::xml_document refDoc;
		pugi::xml_node ref = refDoc.append_child("effect");
		ref.append_attribute("key").set_value(key.c_str());
		EffectData data;
		if (resolve(ref, data, filename, fmt::format("effect '{}'", key), 0)) {
			if (!data.any()) {
				reportDataWarning(filename, fmt::format("effect '{}' does nothing", key));
			}
			effects[key] = std::move(data);
		}
	}

	reportDataFile(filename, fmt::format("{} effects", effects.size()));
	return true;
}

const EffectData* EffectManager::get(const std::string& key) const
{
	const auto it = effects.find(key);
	return it == effects.end() ? nullptr : &it->second;
}

bool EffectManager::parseEffects(const pugi::xml_node& parent, EffectList& out, const std::string& fileName,
                                 const std::string& ownerKey) const
{
	if (!parent) return false;
	EffectData inline_;
	const bool any = parseBody(parent, inline_, fileName, ownerKey, 0);
	if (!any) return false;
	out.clear();
	if (inline_.explosion.enabled || inline_.fragments.enabled || inline_.zone.enabled) {
		std::vector<EffectData> chained = std::move(inline_.then);
		inline_.then.clear();
		out.push_back(std::move(inline_));
		for (EffectData& next : chained) out.push_back(std::move(next));
	} else {
		for (EffectData& next : inline_.then) out.push_back(std::move(next));
	}
	return true;
}

bool EffectManager::parseReference(const pugi::xml_node& ref, EffectData& out, const std::string& fileName,
                                   const std::string& ownerKey) const
{
	return resolve(ref, out, fileName, ownerKey, 0);
}
