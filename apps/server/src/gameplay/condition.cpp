// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/condition.h"
#include "gameplay/agent.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include <pugixml.hpp>
#include <fmt/color.h>
#include <fmt/format.h>

ConditionManager& ConditionManager::getInstance()
{
	static ConditionManager instance;
	return instance;
}

bool ConditionRepel::matches(const std::string& family, const std::string& key) const
{
	for (const std::string& f : families) {
		if (f == family) return true;
	}
	for (const std::string& k : keys) {
		if (k == key) return true;
	}
	return false;
}

// "ghoul, bot" -> {"ghoul", "bot"}. Empty entries are dropped rather than stored
// as an empty name that would match an agent with no family set.
static void appendNames(std::string_view list, std::vector<std::string>& out)
{
	for (std::string_view part : explodeString(list, ",")) {
		const size_t first = part.find_first_not_of(" \t");
		if (first == std::string_view::npos) continue;
		const size_t last = part.find_last_not_of(" \t");
		out.emplace_back(part.substr(first, last - first + 1));
	}
}

const ConditionStage* ConditionData::getStage(const std::string& stageKey) const
{
	for (const auto& st : stages) {
		if (st.key == stageKey) {
			return &st;
		}
	}
	return nullptr;
}

bool ConditionData::hasStageVisual(DrugTimerType timerType) const
{
	for (const auto& st : stages) {
		if (st.visuals.timerType == timerType) {
			return true;
		}
	}
	return false;
}

bool ConditionData::hasTag(const std::string& tag) const
{
	for (const std::string& t : tags) {
		if (t == tag) return true;
	}
	return false;
}

size_t ConditionData::getStageIndex(const std::string& stageKey) const
{
	for (size_t i = 0; i < stages.size(); ++i) {
		if (stages[i].key == stageKey) {
			return i;
		}
	}
	return static_cast<size_t>(-1);
}

// --- ConditionSet ------------------------------------------------------------

void ConditionSet::refresh() const
{
	cachedTotals = ConditionTotals{};
	for (const ActiveCondition& active : conditions) {
		cachedTotals.accumulate(active.stage().modifiers, active.strength);
	}
	totalsDirty = false;
}

bool ConditionSet::add(const ConditionData* data, uint32_t inflictorGuid, float resistance,
                       uint32_t durationOverrideMs, float strength)
{
	if (!data || data->stages.empty()) return false;

	// Resistance shrinks the DURATION and >= 1 blocks outright. Deterministic on
	// purpose: an armour stat that reads the same way every time it is applied,
	// rather than a lottery the wearer cannot plan around.
	if (resistance >= 1.0f) return false;

	// The source's own timing wins over the condition's, and resistance is
	// applied to whichever won -- so armour shortens a sledgehammer's long stun
	// by the same fraction it shortens a hatchet's short one.
	uint32_t firstDuration = durationOverrideMs != 0
		? durationOverrideMs
		: data->stages[0].durationMs;
	if (resistance > 0.0f) {
		firstDuration = static_cast<uint32_t>(
			static_cast<float>(firstDuration) * (1.0f - resistance));
		// A resistance short of total must never round a real condition away to
		// nothing -- that is immunity, and immunity has to be stated as such.
		if (firstDuration == 0) firstDuration = 1;
	}

	ActiveCondition* existing = nullptr;
	for (ActiveCondition& active : conditions) {
		if (active.data == data) {
			existing = &active;
			break;
		}
	}

	if (existing) {
		switch (data->stacking) {
			case ConditionStacking::Refresh:
				existing->stageIndex = 0;
				existing->remainingDurationMs = firstDuration;
				existing->tickTimers.fill(0);
				break;
			case ConditionStacking::Extend:
				// Keeps the stage it is on and tops the clock up. Saturating,
				// because the sum is what a duration is measured in and wrapping
				// it would end the effect instantly.
				existing->remainingDurationMs = static_cast<uint32_t>(std::min<uint64_t>(
					std::numeric_limits<uint32_t>::max(),
					static_cast<uint64_t>(existing->remainingDurationMs) + firstDuration));
				break;
			case ConditionStacking::Ignore:
				return false;
		}
		// The latest dose owns the kill AND sets the severity. Both surviving
		// stacking modes reach here, and both are a fresh application by
		// someone -- refusing to re-credit would leave a poison that a second
		// player topped up paying out to the first one forever, and refusing to
		// re-rate it would let a grenade's feeble slow be locked in by whoever
		// happened to land the first one.
		existing->inflictorGuid = inflictorGuid;
		existing->strength = strength;
	} else {
		ActiveCondition newActive;
		newActive.data = data;
		newActive.stageIndex = 0;
		newActive.remainingDurationMs = firstDuration;
		newActive.inflictorGuid = inflictorGuid;
		newActive.strength = strength;
		conditions.push_back(newActive);
	}

	totalsDirty = true;
	return true;
}

bool ConditionSet::remove(const std::vector<std::string>& keysOrTags)
{
	if (keysOrTags.empty() || conditions.empty()) return false;

	const size_t before = conditions.size();
	auto it = conditions.begin();
	while (it != conditions.end()) {
		bool cured = false;
		for (const std::string& k : keysOrTags) {
			// A name matches either the condition itself or one of its tags, so
			// <cureCondition keys="toxic_poison"> and tags="poison" are the same
			// mechanism and an antidote may mix them freely.
			if (k == "all" || k == it->data->key || it->data->hasTag(k)) {
				cured = true;
				break;
			}
		}
		it = cured ? conditions.erase(it) : it + 1;
	}

	if (conditions.size() == before) return false;
	totalsDirty = true;
	return true;
}

bool ConditionSet::removeOnDeath()
{
	const size_t before = conditions.size();
	std::erase_if(conditions, [](const ActiveCondition& active) {
		return active.data->removeOnDeath;
	});
	if (conditions.size() == before) return false;
	totalsDirty = true;
	return true;
}

void ConditionSet::update(uint32_t elapsedMs, UpdateResult& out)
{
	out.changed = false;
	out.ticks.clear();
	out.endSkin = StageEndSkin::Unchanged;
	if (conditions.empty()) return;

	auto it = conditions.begin();
	while (it != conditions.end()) {
		const ConditionStage& stage = it->stage();

		// Ticks are COLLECTED, never applied here. Applying one can kill the
		// creature, a kill can resurrect it, and a resurrection rewrites this
		// very container -- which left the iterator dangling and then wrote
		// through it. The owner applies them once the walk is over.
		for (size_t slot = 0; slot < GAUGE_SLOT_COUNT; ++slot) {
			const ConditionGaugeTick& tick = stage.modifiers.gaugeTicks[slot];
			if (!tick.active()) continue;
			it->tickTimers[slot] += elapsedMs;
			if (it->tickTimers[slot] >= tick.intervalMs) {
				it->tickTimers[slot] -= tick.intervalMs;
				// Scaled by this dose's severity, exactly as the folded
				// modifiers are: a half-strength poison ticks for half.
				out.ticks.push_back({static_cast<GaugeSlot>(slot),
				                     it->scaledTick(tick.amount), it->inflictorGuid});
			}
		}

		if (it->remainingDurationMs <= elapsedMs) {
			// What this stage leaves behind, from <visuals endSkin=>. The mark
			// outlives the condition that set it -- client.js draws a distinct
			// skin for a player whose withdrawal timer has expired but is
			// non-zero, and something has to cure it.
			//
			// Read from the data rather than inferred from the stage's own skin,
			// which is what it used to be: "a withdrawal stage always marks"
			// made "wear off back to normal" impossible to write. Unchanged is
			// the common case and must not clear, or an unrelated condition
			// ending would wipe a mark this one never set.
			if (stage.visuals.endSkin != StageEndSkin::Unchanged) {
				out.endSkin = stage.visuals.endSkin;
			}

			if (!stage.nextStage.empty()) {
				// The loader has already reported a nextStage that names
				// nothing, and the size is bounded to a byte at load, so the
				// only test left is that it does not point at itself -- which
				// would be an effect that never ends.
				const size_t nextIdx = it->data->getStageIndex(stage.nextStage);
				if (nextIdx != static_cast<size_t>(-1) && nextIdx != it->stageIndex) {
					it->stageIndex = static_cast<uint8_t>(nextIdx);
					it->remainingDurationMs = it->stage().durationMs;
					it->tickTimers.fill(0);
					out.changed = true;
					++it;
					continue;
				}
			}

			out.changed = true;
			it = conditions.erase(it);
		} else {
			it->remainingDurationMs -= elapsedMs;
			++it;
		}
	}

	if (out.changed) {
		totalsDirty = true;
	}
}

float ConditionSet::resistanceTo(const std::string& key) const
{
	if (conditions.empty()) return 0.0f;

	// Composed as a product of what each source LETS THROUGH, so two 50%
	// resistances leave 25% rather than adding to total immunity. Immunity has
	// to be one source saying 1.0, never an accident of stacking.
	float letThrough = 1.0f;
	for (const ActiveCondition& active : conditions) {
		const ConditionModifiers& mod = active.stage().modifiers;
		if (mod.resistAllFraction > 0.0f) {
			letThrough *= (1.0f - std::min(1.0f, mod.resistAllFraction));
		}
		if (mod.resistKeyFraction > 0.0f) {
			for (const std::string& named : mod.resistKeys) {
				if (named == key) {
					letThrough *= (1.0f - std::min(1.0f, mod.resistKeyFraction));
					break;
				}
			}
		}
	}
	return 1.0f - letThrough;
}

bool ConditionSet::repels(const std::string& family, const std::string& agentKey) const
{
	for (const ActiveCondition& active : conditions) {
		const ConditionRepel& repel = active.stage().repel;
		if (!repel.empty() && repel.matches(family, agentKey)) {
			return true;
		}
	}
	return false;
}

uint32_t ConditionSet::longestRemainingWith(DrugTimerType timerType) const
{
	uint32_t longest = 0;
	for (const ActiveCondition& active : conditions) {
		if (active.stage().visuals.timerType == timerType) {
			longest = std::max(longest, active.remainingDurationMs);
		}
	}
	return longest;
}

uint32_t ConditionSet::longestRemainingPoisonScreen() const
{
	uint32_t longest = 0;
	for (const ActiveCondition& active : conditions) {
		if (active.stage().visuals.poisonScreenEffect) {
			longest = std::max(longest, active.remainingDurationMs);
		}
	}
	return longest;
}

std::vector<std::string> ConditionSet::keys() const
{
	std::vector<std::string> out;
	out.reserve(conditions.size());
	for (const ActiveCondition& active : conditions) {
		out.push_back(active.data->key);
	}
	return out;
}

void ConditionSet::rebind(const std::vector<std::string>& boundKeys)
{
	// Paired by index with the snapshot the caller took before the swap. A
	// mismatch means somebody applied a condition between the two, which cannot
	// happen -- both run on the dispatcher inside one admin command -- but
	// re-binding against the wrong key would be silent corruption, so refuse.
	if (boundKeys.size() != conditions.size()) {
		clear();
		return;
	}

	size_t kept = 0;
	for (size_t i = 0; i < conditions.size(); ++i) {
		const ConditionData* fresh = ConditionManager::getInstance().getEffectData(boundKeys[i]);
		if (!fresh || fresh->stages.empty()) {
			continue; // the new file dropped it
		}
		ActiveCondition rebound = conditions[i];
		rebound.data = fresh;
		if (rebound.stageIndex >= fresh->stages.size()) {
			// The stage it was on no longer exists. Restarting is the only
			// answer that leaves a valid index, and the alternative -- dropping
			// the condition -- would silently cure somebody for editing a file.
			rebound.stageIndex = 0;
			rebound.remainingDurationMs = fresh->stages[0].durationMs;
			rebound.tickTimers.fill(0);
		}
		conditions[kept++] = rebound;
	}
	conditions.resize(kept);
	// The reload can change what every surviving stage MODIFIES, not just which
	// conditions survive, so the fold is stale even when nothing was dropped.
	totalsDirty = true;
}

// --- Loader ------------------------------------------------------------------

bool ConditionManager::loadFromXml(const std::string& filename)
{
	ConditionTable staged;
	if (!parseInto(staged, filename)) {
		return false;
	}
	effects = std::move(staged);
	reportDataFile(filename, fmt::format("{} conditions", effects.size()));
	return true;
}

// Parses into a STAGING table so the caller decides whether to keep it. That is
// the whole difference between the boot load and a hot reload: a reload must not
// destroy a working set on the way to failing.
bool ConditionManager::reloadFromXml(const std::string& filename)
{
	ConditionTable staged;
	if (!parseInto(staged, filename)) {
		return false;
	}
	effects = std::move(staged);
	return true;
}

namespace {

// One <xTick amount= intervalMs=> element, for whichever gauge names it. The
// five spellings are one function because they are one mechanism; writing them
// out five times is how the fourth acquires a subtly different clamp.
void parseGaugeTick(const pugi::xml_node& modNode, const char* element, GaugeSlot slot,
                    ConditionModifiers& out, const std::string& filename,
                    const std::string& conditionKey, const std::string& stageKey)
{
	const pugi::xml_node tickNode = modNode.child(element);
	if (!tickNode) return;

	ConditionGaugeTick& tick = out.gaugeTicks[static_cast<size_t>(slot)];
	// Saturating: a tick is a gauge delta, and a cast would turn a large one
	// into its opposite. See MAX_DAMAGE_AMOUNT.
	tick.amount = static_cast<int16_t>(std::clamp<long long>(
		tickNode.attribute("amount").as_llong(0), -32768, 32767));
	tick.intervalMs = tickNode.attribute("intervalMs").as_uint(0);

	// The tick is driven from the movement loop and fires at most once per
	// frame, so anything under one frame silently becomes one frame --
	// intervalMs="1" and intervalMs="50" are the same effect, at 20 ticks a
	// second. Reported rather than clamped: the number the author wrote is the
	// one they will reason about, and quietly rewriting it hides the ceiling.
	if (tick.intervalMs > 0 && tick.intervalMs < MOVEMENT_TICK_MS) {
		reportDataWarning(filename, fmt::format(
			"condition '{}' stage '{}' has <{} intervalMs=\"{}\">, below the {} ms tick the "
			"effect loop runs at; it will fire once per tick, i.e. as if it said \"{}\"",
			conditionKey, stageKey, element, tick.intervalMs, MOVEMENT_TICK_MS,
			MOVEMENT_TICK_MS));
	}
	if (tick.amount != 0 && tick.intervalMs == 0) {
		reportDataWarning(filename, fmt::format(
			"condition '{}' stage '{}' has <{} amount=\"{}\"> with no intervalMs=, so it will "
			"never fire", conditionKey, stageKey, element, tick.amount));
	}
}

// Both damage multipliers, clamped to a sane band with a warning. They are the
// easiest knobs in the file to make a degenerate item with -- a
// damageTaken="100" is one-shot-everything, a damageDealt="0" is a weapon that
// cannot hurt anyone -- and a silent acceptance of either reads as a server bug.
float parseDamageMultiplier(const pugi::xml_node& node, const char* element,
                            const std::string& filename, const std::string& conditionKey,
                            const std::string& stageKey)
{
	constexpr float MIN_MULT = 0.1f;
	constexpr float MAX_MULT = 3.0f;

	const float raw = node.attribute("multiplier").as_float(1.0f);
	const float clamped = std::clamp(raw, MIN_MULT, MAX_MULT);
	if (clamped != raw) {
		reportDataWarning(filename, fmt::format(
			"condition '{}' stage '{}' has <{} multiplier=\"{}\">, outside the {}..{} band; "
			"clamping to {}", conditionKey, stageKey, element, raw, MIN_MULT, MAX_MULT, clamped));
	}
	return clamped;
}

// A 0..1 fraction, clamped with a warning. Used by every "how much is shrugged
// off" attribute here, so they cannot disagree about what out of range means.
float parseFraction(const pugi::xml_node& node, const char* attribute, float fallback,
                    const std::string& filename, const std::string& context)
{
	const pugi::xml_attribute attr = node.attribute(attribute);
	if (!attr) return fallback;

	const float raw = attr.as_float(fallback);
	const float clamped = std::clamp(raw, 0.0f, 1.0f);
	if (clamped != raw) {
		reportDataWarning(filename, fmt::format(
			"{} has {}=\"{}\", which is not a 0..1 fraction; clamping to {}",
			context, attribute, raw, clamped));
	}
	return clamped;
}

} // namespace

bool ConditionManager::parseInto(ConditionTable& out, const std::string& filename) const
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "conditions");
	if (!root) return false;

	for (pugi::xml_node effNode = root.child("condition"); effNode; effNode = effNode.next_sibling("condition")) {
		ConditionData data;
		data.key = effNode.attribute("key").as_string();
		data.name = effNode.attribute("name").as_string(data.key.c_str());
		data.removeOnDeath = effNode.attribute("removeOnDeath").as_bool(true);
		appendNames(effNode.attribute("tags").as_string(), data.tags);

		// Interned here, and anything unrecognised is reported rather than
		// quietly becoming a no-op. The old code kept the raw string and one
		// call site compared it to "refresh", so every other spelling -- a typo,
		// a capital R, a mode somebody assumed existed -- meant "ignore the
		// second dose" in total silence.
		if (pugi::xml_node stackNode = effNode.child("stacking")) {
			const std::string mode = stackNode.attribute("mode").as_string("refresh");
			if (mode == "refresh") {
				data.stacking = ConditionStacking::Refresh;
			} else if (mode == "extend") {
				data.stacking = ConditionStacking::Extend;
			} else if (mode == "ignore") {
				data.stacking = ConditionStacking::Ignore;
			} else {
				reportDataWarning(filename, fmt::format(
					"condition '{}' has <stacking mode=\"{}\">; only \"refresh\", \"extend\" and "
					"\"ignore\" exist, so a second dose will refresh", data.key, mode));
			}
		}

		for (pugi::xml_node stageNode = effNode.child("stage"); stageNode; stageNode = stageNode.next_sibling("stage")) {
			ConditionStage stage;
			stage.key = stageNode.attribute("key").as_string();
			stage.durationMs = stageNode.attribute("durationMs").as_uint(0);
			stage.nextStage = stageNode.attribute("nextStage").as_string();

			pugi::xml_node modNode = stageNode.child("modifiers");
			if (modNode) {
				const std::string context = fmt::format(
					"condition '{}' stage '{}'", data.key, stage.key);

				if (pugi::xml_node spNode = modNode.child("speed")) {
					stage.modifiers.speedMultiplier = spNode.attribute("multiplier").as_float(1.0f);
					stage.modifiers.speedAdd = spNode.attribute("add").as_int(0);
				}
				// <maxHealth> is refused rather than ignored. It was parsed and
				// read by nothing for months, and it cannot be honoured as
				// written: life is a uint8_t gauge already at max="255" in
				// modes.xml, so there is nowhere for a bonus to go.
				if (modNode.child("maxHealth")) {
					reportDataWarning(filename, fmt::format(
						"condition '{}' stage '{}' has a <maxHealth> modifier; life is a 0-255 gauge "
						"whose ceiling modes.xml already sets to its maximum, so there is no room "
						"for one. Lower the mode's life max first if you want this",
						data.key, stage.key));
				}
				if (pugi::xml_node hpRegNode = modNode.child("healthRegen")) {
					stage.modifiers.healthRegenMultiplier = hpRegNode.attribute("multiplier").as_float(1.0f);
				}
				if (pugi::xml_node stRegNode = modNode.child("staminaRegen")) {
					stage.modifiers.staminaRegenMultiplier = stRegNode.attribute("multiplier").as_float(1.0f);
				}
				if (pugi::xml_node stDrnNode = modNode.child("staminaDrain")) {
					stage.modifiers.staminaDrainMultiplier = stDrnNode.attribute("multiplier").as_float(1.0f);
				}

				// One tick channel per gauge. <healthTick> keeps its original
				// spelling and is simply LIFE's.
				parseGaugeTick(modNode, "healthTick", GaugeSlot::LIFE, stage.modifiers,
				               filename, data.key, stage.key);
				parseGaugeTick(modNode, "foodTick", GaugeSlot::FOOD, stage.modifiers,
				               filename, data.key, stage.key);
				parseGaugeTick(modNode, "warmthTick", GaugeSlot::WARMTH, stage.modifiers,
				               filename, data.key, stage.key);
				parseGaugeTick(modNode, "staminaTick", GaugeSlot::STAMINA, stage.modifiers,
				               filename, data.key, stage.key);
				parseGaugeTick(modNode, "radiationTick", GaugeSlot::RADIATION, stage.modifiers,
				               filename, data.key, stage.key);

				if (pugi::xml_node dealtNode = modNode.child("damageDealt")) {
					stage.modifiers.damageDealtMultiplier = parseDamageMultiplier(
						dealtNode, "damageDealt", filename, data.key, stage.key);
				}
				if (pugi::xml_node takenNode = modNode.child("damageTaken")) {
					stage.modifiers.damageTakenMultiplier = parseDamageMultiplier(
						takenNode, "damageTaken", filename, data.key, stage.key);
				}
				if (pugi::xml_node critNode = modNode.child("critChance")) {
					stage.modifiers.critChanceAdd = critNode.attribute("add").as_float(0.0f);
				}
				if (pugi::xml_node kbNode = modNode.child("knockbackResist")) {
					stage.modifiers.knockbackResist = parseFraction(
						kbNode, "fraction", 0.0f, filename, context);
				}
				if (pugi::xml_node leechNode = modNode.child("leech")) {
					stage.modifiers.leech.life = parseFraction(
						leechNode, "life", 0.0f, filename, context);
					stage.modifiers.leech.stamina = parseFraction(
						leechNode, "stamina", 0.0f, filename, context);
				}

				// <control move="false" attack="false"/>: what the stage FORBIDS.
				// Spelled as what you can still do rather than as what is taken
				// away, because "move=false" reads as a state of the victim while
				// "noMove=true" reads as a property of the effect.
				if (pugi::xml_node ctrlNode = modNode.child("control")) {
					uint8_t mask = CONTROL_NONE;
					const auto forbid = [&](const char* attr, ConditionControl bit) {
						const pugi::xml_attribute a = ctrlNode.attribute(attr);
						if (a && !a.as_bool(true)) mask |= bit;
					};
					forbid("move", CONTROL_NO_MOVE);
					forbid("run", CONTROL_NO_RUN);
					forbid("attack", CONTROL_NO_ATTACK);
					forbid("use", CONTROL_NO_USE);
					forbid("build", CONTROL_NO_BUILD);
					forbid("turn", CONTROL_NO_TURN);
					if (mask == CONTROL_NONE) {
						reportDataWarning(filename, fmt::format(
							"{} has a <control> forbidding nothing; every attribute defaults to "
							"true (allowed), so write e.g. move=\"false\" to take something away",
							context));
					}
					// A full paralyse should stop the sprint too, or the run bit
					// would still be consulted for a creature that cannot walk.
					if (mask & CONTROL_NO_MOVE) mask |= CONTROL_NO_RUN;
					stage.modifiers.controlMask = mask;
				}

				// <resist conditions="a,b" fraction="0.5" all="0.2"/>
				if (pugi::xml_node resNode = modNode.child("resist")) {
					appendNames(resNode.attribute("conditions").as_string(),
					            stage.modifiers.resistKeys);
					stage.modifiers.resistKeyFraction = parseFraction(
						resNode, "fraction", 1.0f, filename, context);
					stage.modifiers.resistAllFraction = parseFraction(
						resNode, "all", 0.0f, filename, context);
					if (stage.modifiers.resistKeys.empty() &&
					    stage.modifiers.resistAllFraction <= 0.0f) {
						reportDataWarning(filename, fmt::format(
							"{} has a <resist> naming no conditions= and no all=; it protects "
							"against nothing", context));
					}
				}
			}

			pugi::xml_node visNode = stageNode.child("visuals");
			if (visNode) {
				stage.visuals.poisonScreenEffect = visNode.attribute("poisonScreenEffect").as_bool(false);

				// One spelling: skin="1" (repellent) or skin="2" (withdrawal),
				// the only two the protocol can carry. This used to also accept
				// skinType=, timer=, drug= and six string forms, and anything it
				// did not recognise became NONE in silence -- which is how
				// skin="4" sat here sending no skin at all.
				const pugi::xml_attribute skinNode = visNode.attribute("skin");
				const std::string skin = skinNode.as_string();
				if (skin == "1") {
					stage.visuals.timerType = DrugTimerType::REPELLENT;
				} else if (skin == "2") {
					stage.visuals.timerType = DrugTimerType::WITHDRAWAL;
				} else {
					stage.visuals.timerType = DrugTimerType::NONE;
					if (skinNode) {
						reportDataWarning(filename, fmt::format(
							"condition '{}' stage '{}' has skin=\"{}\"; only \"1\" (repellent) and \"2\" "
							"(withdrawal) exist, so no skin will be sent",
							data.key, stage.key, skin));
					}
				}

				// endSkin: what the stage leaves behind when it expires, as
				// opposed to what it looks like while it runs. Same numbering as
				// skin= so there is one vocabulary, and the same treatment for an
				// unrecognised value.
				//
				// "1" and "2" get their own message: they are not typos, they are
				// a reasonable thing to try that the protocol genuinely cannot do
				// -- both need a live timer to be drawn at all.
				const pugi::xml_attribute endSkinNode = visNode.attribute("endSkin");
				const std::string endSkin = endSkinNode.as_string();
				if (endSkin == "0") {
					stage.visuals.endSkin = StageEndSkin::Normal;
				} else if (endSkin == "4") {
					stage.visuals.endSkin = StageEndSkin::Withdrawn;
				} else if (endSkinNode) {
					stage.visuals.endSkin = StageEndSkin::Unchanged;
					if (endSkin == "1" || endSkin == "2") {
						reportDataWarning(filename, fmt::format(
							"condition '{}' stage '{}' has endSkin=\"{}\"; skins 1 and 2 need a live "
							"timer, so a stage that has ended cannot leave one behind. Only \"0\" "
							"(normal) and \"4\" (post-lapadone) can",
							data.key, stage.key, endSkin));
					} else {
						reportDataWarning(filename, fmt::format(
							"condition '{}' stage '{}' has endSkin=\"{}\"; only \"0\" (normal) and \"4\" "
							"(post-lapadone) exist, so the stage will leave the skin as it is",
							data.key, stage.key, endSkin));
					}
				}
			}

			// <repel families="ghoul" keys="halbot"/>, repeatable. Both lists are
			// comma-separated and a stage may carry either or both; an agent is
			// repelled if EITHER matches, so families are the broad brush and
			// keys the exception.
			for (pugi::xml_node repelNode = stageNode.child("repel"); repelNode;
			     repelNode = repelNode.next_sibling("repel")) {
				appendNames(repelNode.attribute("families").as_string(), stage.repel.families);
				appendNames(repelNode.attribute("keys").as_string(), stage.repel.keys);
				if (stage.repel.empty()) {
					reportDataWarning(filename, fmt::format(
						"condition '{}' stage '{}' has a <repel> naming no families= or keys=; "
						"it repels nothing",
						data.key, stage.key));
				}
			}

			data.stages.push_back(stage);
		}

		// A nextStage that names nothing strands the effect on its first stage.
		for (const ConditionStage& stage : data.stages) {
			if (!stage.nextStage.empty() && !data.getStage(stage.nextStage)) {
				reportDataWarning(filename, fmt::format(
					"condition '{}' stage '{}' has nextStage=\"{}\", which is not a stage of it",
					data.key, stage.key, stage.nextStage));
			}
		}

		// ActiveCondition addresses a stage with one byte, so an effect past
		// that is refused rather than silently truncated. Nothing real is close
		// -- the longest shipped effect has two stages.
		if (data.stages.size() > 255) {
			reportDataWarning(filename, fmt::format(
				"condition '{}' has {} stages; the limit is 255 and this condition is skipped",
				data.key, data.stages.size()));
			continue;
		}

		if (!data.key.empty()) {
			out[data.key] = data;
		}
	}

	return true;
}

void ConditionManager::validateRepelTargets(const std::string& filename) const
{
	for (const auto& [effectKey, data] : effects) {
		for (const ConditionStage& stage : data.stages) {
			for (const std::string& family : stage.repel.families) {
				if (!g_agents.hasFamily(family)) {
					reportDataWarning(filename, fmt::format(
						"condition '{}' stage '{}' repels family=\"{}\", which no agent in "
						"agents.xml belongs to; nothing will be repelled",
						effectKey, stage.key, family));
				}
			}
			for (const std::string& key : stage.repel.keys) {
				if (!g_agents.getAgentData(key)) {
					reportDataWarning(filename, fmt::format(
						"condition '{}' stage '{}' repels key=\"{}\", which is not an agent in "
						"agents.xml; nothing will be repelled",
						effectKey, stage.key, key));
				}
			}
			// A <resist> naming a condition nothing defines protects against
			// nothing, which is the same failure a bad <repel> is. Checked here
			// rather than in parseInto because a stage may legally name a
			// condition declared LATER in the same file.
			for (const std::string& key : stage.modifiers.resistKeys) {
				if (!getEffectData(key)) {
					reportDataWarning(filename, fmt::format(
						"condition '{}' stage '{}' resists \"{}\", which is not a condition in "
						"this file; it protects against nothing",
						effectKey, stage.key, key));
				}
			}
		}
	}
}

bool ConditionManager::hasTag(const std::string& tag) const
{
	for (const auto& [key, data] : effects) {
		if (data.hasTag(tag)) return true;
	}
	return false;
}

std::vector<const ConditionData*> ConditionManager::allEffects() const
{
	std::vector<const ConditionData*> out;
	out.reserve(effects.size());
	for (const auto& [key, data] : effects) {
		out.push_back(&data);
	}
	std::sort(out.begin(), out.end(),
		[](const ConditionData* a, const ConditionData* b) { return a->key < b->key; });
	return out;
}

const ConditionData* ConditionManager::getEffectData(const std::string& key) const
{
	auto it = effects.find(key);
	if (it != effects.end()) {
		return &it->second;
	}
	return nullptr;
}
