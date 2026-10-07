// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/agent.h"

#include "gameplay/game.h"
#include "gameplay/progress/game_event.h"
#include "gameplay/item.h"
#include "gameplay/object.h"
#include "content/xml_utils.h"

#include <fmt/color.h>
#include <fmt/format.h>

extern Game g_game;

AgentManager g_agents;

// --- XML string <-> enum interning (see the enum comment in agent.h) ---

static AgentBrainType parseBrainType(const std::string& s, const std::string& agentKey, const std::string& fileName)
{
	if (s == "aggressive") return AgentBrainType::Aggressive;
	if (s == "repair") return AgentBrainType::Repair;
	if (!s.empty()) {
		reportDataWarning(fileName, fmt::format(
			"'{}' unknown brain type '{}'; the agent will stand and do nothing",
			agentKey, s));
	}
	return AgentBrainType::None;
}

static AgentTargetType parseTargetType(const std::string& s, const std::string& agentKey, const std::string& fileName)
{
	if (s == "player") return AgentTargetType::Player;
	if (s == "agent") return AgentTargetType::Agent;
	if (s == "object") return AgentTargetType::Object;
	if (s == "damaged_object") return AgentTargetType::DamagedObject;
	reportDataWarning(fileName, fmt::format(
		"'{}' unknown <target type=\"{}\">; the entry will never match",
		agentKey, s));
	return AgentTargetType::None;
}

static AgentAbilityType parseAbilityType(const std::string& s, const std::string& agentKey, const std::string& fileName)
{
	if (s == "melee") return AgentAbilityType::Melee;
	if (s == "ranged") return AgentAbilityType::Ranged;
	if (s == "repair") return AgentAbilityType::Repair;
	if (s == "heal") return AgentAbilityType::Heal;
	reportDataWarning(fileName, fmt::format(
		"'{}' unknown <ability type=\"{}\">; no brain will use it",
		agentKey, s));
	return AgentAbilityType::None;
}

// Names for the debug dump only; the runtime never goes back to strings.
static const char* brainTypeName(AgentBrainType t)
{
	switch (t) {
		case AgentBrainType::Aggressive: return "aggressive";
		case AgentBrainType::Repair: return "repair";
		default: return "none";
	}
}

static const char* targetTypeName(AgentTargetType t)
{
	switch (t) {
		case AgentTargetType::Player: return "player";
		case AgentTargetType::Agent: return "agent";
		case AgentTargetType::Object: return "object";
		case AgentTargetType::DamagedObject: return "damaged_object";
		default: return "none";
	}
}

static const char* abilityTypeName(AgentAbilityType t)
{
	switch (t) {
		case AgentAbilityType::Melee: return "melee";
		case AgentAbilityType::Ranged: return "ranged";
		case AgentAbilityType::Repair: return "repair";
		case AgentAbilityType::Heal: return "heal";
		default: return "none";
	}
}

// --- Agent ---

Agent::Agent(const AgentData* data) : data(data)
{
	if (data) {
		name = data->key;
		health = data->health;
	}
}

void Agent::setRuntimeId(uint32_t fullId)
{
	Thing::setID(fullId); // Thing::id / uid8 / id16 (uid8 is replaced by the pool at placement)
	id = fullId;          // Creature::id -- what getID() returns and Map keys on
}

uint16_t Agent::getMoveSpeed() const
{
	if (!data) {
		return 0;
	}

	// A paralysed agent does not move at all. Zero rather than a floor: this is
	// the movement INPUT, so zero here genuinely means a step of no distance,
	// and stepAgent then reports a wire speed of zero on its own.
	if (cannot(CONTROL_NO_MOVE)) {
		return 0;
	}

	// One configured speed, optionally faster after dark. Read live rather than
	// cached at spawn so an agent that survives into the night speeds up.
	const uint16_t base = (data->nightSpeed > 0 && g_game.isNight())
		? data->nightSpeed
		: data->speed;

	// The same slow a player takes, applied at the agent's own equivalent of
	// Player::getSpeed. Floored at 1 rather than 0 so a mere slow can never be
	// mistaken for a paralyse -- only <control move="false"/> stops an agent
	// dead, and that has already returned above.
	const ConditionTotals& totals = conditions.totals();
	if (totals.speedMultiplier == 1.0f && totals.speedAdd == 0) {
		return base;
	}
	const int32_t modified = static_cast<int32_t>(
		(static_cast<int32_t>(base) + totals.speedAdd) * totals.speedMultiplier);
	return static_cast<uint16_t>(std::clamp<int32_t>(modified, 1, 65535));
}

void Agent::applyConditionTick(GaugeSlot slot, int16_t amount, uint32_t inflictorGuid)
{
	// An agent has one gauge: its health pool. A condition that drains food or
	// stamina has nothing here to drain, and silently doing nothing is the right
	// answer -- it lets one <condition> be written once and applied to anyone.
	if (slot != GaugeSlot::LIFE || amount == 0) {
		return;
	}

	// Credited to whoever inflicted the condition, so a poison kill is their
	// kill: XP, provocation and the repel break all follow from the attacker
	// being named. Resolved per tick because they may have logged out since.
	Player* inflictor = inflictorGuid != 0 ? g_game.getPlayerByGUID(inflictorGuid) : nullptr;

	// AgentDamageKind::None: a condition's damage is not melee, piercing or
	// anything else the <resistances> block reduces -- resisting the CONDITION
	// is what shortens it, and reducing the damage as well would apply the same
	// protection twice.
	//
	// ambient=true throttles the hurt flash to the 2s cadence the player red
	// aura uses, so a 500ms poison does not make the agent visibly convulse.
	changeHealth(amount, 0, inflictor, true, AgentDamageKind::None);
}

float Agent::conditionResistanceFor(const std::string& key) const
{
	// Composed as a product of what each source lets through, so an agent that
	// is both naturally tough and running a <resist> approaches immunity without
	// two partial protections ever adding up to it.
	const float own = data ? data->conditionResistanceFor(key) : 0.0f;
	const float active = conditions.resistanceTo(key);
	return 1.0f - (1.0f - own) * (1.0f - active);
}

float Agent::tileSlowScaleFor(const Object* obj) const
{
	if (obj && ownerGuid != 0 && g_game.isSameOwnerSide(ownerGuid, obj->getOwnerPid())) {
		return 0.5f;
	}
	return 1.0f;
}

int32_t Agent::changeHealth(int32_t healthDelta, uint8_t angle, Player* attacker, bool ambient,
                            AgentDamageKind kind)
{
	if (dying) {
		return 0; // already resolving death; ignore further hits
	}

	const uint16_t oldHealth = health;

	if (healthDelta >= 0) {
		// Healing (repair bots later); clamp to the agent's max.
		uint16_t maxHp = data ? data->health : health;
		if (maxHp == 0) maxHp = 100;
		health = static_cast<uint16_t>(std::min<int32_t>(maxHp, health + healthDelta));
		const int32_t applied = static_cast<int32_t>(health) - static_cast<int32_t>(oldHealth);
		if (applied > 0) {
			const uint8_t pct = static_cast<uint8_t>(std::clamp((applied * 100) / static_cast<int32_t>(maxHp), 0, 100));
			g_game.broadcastDamageIndicator(getPosition(), static_cast<int16_t>(applied), pct);
		}
		return applied;
	}

	// Resistances, the player's wearable rule exactly: the kind picks a 0..1
	// fraction and the damage shrinks by it, rounded. A hit absorbed to nothing
	// does not provoke or alert either -- the player path returns before
	// registering the attacker in the same situation.
	if (kind != AgentDamageKind::None && data) {
		const float r = data->resistanceFor(kind);
		if (r > 0.0f) {
			healthDelta = static_cast<int32_t>(
				std::round(static_cast<float>(healthDelta) * (1.0f - r)));
			if (healthDelta == 0) {
				return 0;
			}
		}
	}

	// <damageTaken multiplier=>, the same rule the player path applies and in
	// the same order: after the kind resistance, and never able to round a real
	// hit away to nothing.
	const float takenMultiplier = conditions.totals().damageTakenMultiplier;
	if (takenMultiplier != 1.0f) {
		const int32_t scaled = static_cast<int32_t>(
			std::lround(static_cast<float>(healthDelta) * takenMultiplier));
		healthDelta = scaled == 0 ? -1 : scaled;
	}

	// Picking a fight with one member makes the whole type hostile to you, and
	// waives the survival grace period that would otherwise keep them off a
	// freshly spawned player. Recorded on the hit, not on the kill, so it
	// applies even if the agent survives.
	if (attacker && data && !data->key.empty()) {
		attacker->provokeAgentType(data->key);
		// ...and it cancels a REPELLENT for this type too, for a while. Same
		// rule, same scope, different clock: a repellent is bought protection
		// rather than spawn protection, so the temper it provokes cools off
		// instead of lasting the whole life. See AgentData::repelBreakMs.
		attacker->breakRepelForAgentType(data->key, data->repelBreakMs);
	}

	// Turn on the attacker, and shout. Being shot at is the other thing worth
	// telling the neighbours about, and it is the one a player feels: opening
	// fire on one ghoul brings the ones around it, instead of letting you pick a
	// pack off one at a time from cover. Rate-limited inside alertNearbyAgents,
	// and the shout carries the same eligibility rules as being seen.
	//
	// Before the lethal branch below on purpose: a dying agent has every reason
	// to raise the alarm, and after die() runs `this` may be gone.
	if (attacker) {
		g_game.agentProvoked(this, attacker);
	}

	const uint32_t damage = static_cast<uint32_t>(-healthDelta);
	const uint16_t maxHp = (data && data->health > 0) ? data->health : (oldHealth > 0 ? oldHealth : 100);
	if (attacker) {
		DamageShare& share = damageBy[attacker->getID()];
		share.damage += std::min<uint32_t>(damage, oldHealth);
		share.lastHitMs = OTSYS_TIME();
	}
	if (damage >= health) {
		// Trimmed to what was actually there: an overkill reports the health it
		// removed, not the swing that removed it. Computed BEFORE die(), which
		// may delete `this`.
		const int32_t applied = -static_cast<int32_t>(oldHealth);
		const uint8_t pct = static_cast<uint8_t>(std::clamp((static_cast<int32_t>(oldHealth) * 100) / static_cast<int32_t>(maxHp), 0, 100));
		const Position pos = getPosition();
		g_game.broadcastDamageIndicator(pos, static_cast<int16_t>(applied), pct);
		health = 0;
		die(attacker);
		return applied; // die() removed us from the map and may have deleted `this`
	}

	health -= static_cast<uint16_t>(damage);
	const int32_t applied = -static_cast<int32_t>(damage);
	const uint8_t pct = static_cast<uint8_t>(std::clamp((static_cast<int32_t>(damage) * 100) / static_cast<int32_t>(maxHp), 0, 100));

	if (ambient) {
		accumulatedAmbientDamage += static_cast<int32_t>(damage);
		const uint64_t now = OTSYS_TIME();
		if (now - lastAmbientPulseMs < 2000) {
			return applied; // the damage landed; only the flash was throttled
		}
		lastAmbientPulseMs = now;
		const int32_t displayLoss = accumulatedAmbientDamage;
		accumulatedAmbientDamage = 0;
		const uint8_t ambientPct = static_cast<uint8_t>(std::clamp((displayLoss * 100) / static_cast<int32_t>(maxHp), 0, 100));
		g_game.broadcastDamageIndicator(getPosition(), -static_cast<int16_t>(displayLoss), ambientPct);
	} else {
		accumulatedAmbientDamage = 0;
		g_game.broadcastDamageIndicator(getPosition(), static_cast<int16_t>(applied), pct);
	}

	// Non-lethal: flash the hurt. The pulse is held for a couple of ticks
	// (tickPulses in updateAgents decrements it) so a chasing agent's per-tick
	// movement update carries the bit too; this surgical broadcast guarantees
	// delivery even when the agent is standing still (not otherwise re-sent).
	hitPulseTicks = 2;
	hitAngle31 = angle & 31;
	EntityUpdate update;
	buildUpdate(update);
	g_game.broadcastSurgicalUpdate(update, getPosition());
	return applied;
}

void Agent::expire()
{
	if (dying) {
		return;
	}
	health = 0;
	die(nullptr); // no killer -> no XP, but drops and the onDeath explosion stand
}

// Kill credit for a death no player dealt: the player who did at least half
// the agent's health in damage, hitting it within the last 30 s, gets the kill
// for quests and account stats (not the XP). Half, so chipping a ghoul and
// walking away before sunrise does not farm kills; 30 s, so the credit belongs
// to the fight that actually happened.
Player* Agent::creditedKiller() const
{
	constexpr uint64_t CREDIT_WINDOW_MS = 30000;
	const uint32_t maxHp = (data && data->health > 0) ? data->health : 100;
	const uint64_t now = OTSYS_TIME();
	uint32_t bestId = 0, bestDamage = 0;
	for (const auto& [playerId, share] : damageBy) {
		if (share.damage * 2 < maxHp || now > share.lastHitMs + CREDIT_WINDOW_MS || share.damage <= bestDamage) continue;
		bestId = playerId;
		bestDamage = share.damage;
	}
	Player* player = bestId ? g_game.getPlayerByID(bestId) : nullptr;
	return player && player->getHealth() > 0 ? player : nullptr;
}

void Agent::die(Player* killer)
{
	dying = true;
	if (data) {
		if (Player* credited = killer ? killer : creditedKiller()) {
			GameEvent kill{EventType::Kill, credited, data->key};
			kill.tag = questTag;
			g_events.emit(kill);
		}
	}
	const Position pos = getPosition();

	// Reward: score == experience in this game (Player::addXP sets score =
	// experience and applies the mode rate + karma), so this is the whole reward.
	if (killer && data && data->experience > 0) {
		killer->addXP(data->experience);
	}

	if (data) {
		// Drops spread round the death spot together, so they land side by
		// side rather than on top of each other (shared drop path).
		std::vector<Game::LootDrop> drops;
		for (const ItemDrop& drop : data->drops) {
			if (drop.iid == 0 || !drop.rollChance()) continue;
			ItemState dropState = ItemState::fresh(drop.iid);
			dropState.ammo = 0; // these drops have always spawned with ammo 0
			drops.push_back({ drop.lootId, drop.iid, drop.rollAmount(), dropState });
		}
		g_game.dropLootBurst(pos, drops);

		// onDeath explosion (explosive_ghoul): hurts players/buildings around it.
		if (data->explosion.enabled) {
			g_game.executeExplosion(pos, data->explosion.radius, data->explosion.area,
				data->explosion.playerDamage, data->explosion.buildingDamage,
				data->explosion.knockback, killer ? killer->getID() : 0,
				&data->explosion.onHit);
		}
	}

	// Tell clients it died (isDestruction -> extra=1 triggers the death animation,
	// which the client draws from the cached sprite).
	EntityUpdate removal;
	removal.isDestruction = true;
	buildRemoval(removal);
	g_game.broadcastSurgicalUpdate(removal, pos);

	// Off the map. For a Creature this decrements the reference counter placed by
	// internalPlaceThing; at count 0 it deletes `this`, so nothing may touch this
	// agent afterward.
	g_game.map.removeThing(this);
}

void Agent::buildUpdate(EntityUpdate& out) const
{
	out.pid = 0;                 // world entity (pid 0), addressed by id16
	out.type = ENTITY_TYPE_AI;   // 13 == __ENTITIE_AI__
	out.id = getId16();
	out.rotation = getRotation();

	// state: high byte = speed/10 (client reads (state>>8)/100), bit 0 = alive
	// (state 0 is the removal sentinel), bit 1 = attack swing (client _Ghoul).
	//
	// The byte is CLAMPED, not truncated into the low byte: speeds above 2550
	// would otherwise overflow across the byte boundary and corrupt the alive
	// and attack bits, silently removing the agent client-side. stepAgent
	// already reports a multiple of 10, so this division is exact.
	const uint16_t speedByte = static_cast<uint16_t>(std::min<uint32_t>(255u, getSpeed() / 10u));
	uint16_t stateVal = static_cast<uint16_t>((speedByte << 8) | 1);
	if (attackPulseTicks > 0) stateVal |= 2;
	out.state = stateVal;

	// extra: bits 0-3 select the client sprite (AI[extra & 15]); bit 4 is a hurt
	// trigger and bits 5-9 the hurt direction (client _EntitieAI).
	uint16_t extra = static_cast<uint16_t>(getSprite() & 0x0F);
	if (hitPulseTicks > 0) {
		extra |= 16;                                             // bit 4: hurt
		extra |= static_cast<uint16_t>((hitAngle31 & 31) << 5); // bits 5-9: angle
	}
	out.extra = extra;

	// Client interpolates start->end; equal for a stationary agent (placeThing
	// syncs lastPosition via resetDirty, so no glide on the first frame).
	out.startX = static_cast<uint16_t>(getLastPosition().x);
	out.startY = static_cast<uint16_t>(getLastPosition().y);
	out.endX = static_cast<uint16_t>(getPosition().x);
	out.endY = static_cast<uint16_t>(getPosition().y);
}

const AgentData* AgentManager::getAgentData(const std::string& key) const
{
	auto it = agents.find(key);
	return (it != agents.end()) ? &it->second : nullptr;
}

Agent* AgentManager::createAgent(const std::string& key, const Position& pos, uint32_t ownerGuid)
{
	const AgentData* ad = getAgentData(key);
	if (!ad) {
		return nullptr;
	}

	// Named before it is placed: on exhaustion there is nothing to clean up.
	const uint32_t id = g_game.map.acquireEntityId(EntityClass::Agent);
	if (id == 0) {
		if (!warnedExhausted) {
			warnedExhausted = true;
			fmt::print(fmt::fg(fmt::color::yellow),
				">> [Warning] No entity id available for a new agent ({} live). The id pool is "
					"full; agent spawning is paused until ids are freed.\n",
				g_game.map.getEntityIdPool().liveCount(EntityClass::Agent));
		}
		return nullptr;
	}
	warnedExhausted = false;

	Agent* agent = new Agent(ad);
	agent->setRuntimeId(id);
	agent->setPosition(pos);
	agent->setHomePos(pos);
	agent->setHealth(ad->health);
	agent->setOwnerGuid(ownerGuid);
	if (ad->lifetimeMs > 0) {
		agent->setExpiresAt(static_cast<uint64_t>(OTSYS_TIME()) + ad->lifetimeMs);
	}
	if (ad->daylightEnabled) {
		agent->setNextDaylightAt(static_cast<uint64_t>(OTSYS_TIME()) + ad->daylightIntervalMs);
	}
	// Movement speed is not stored per instance: it comes from AgentData via
	// getMoveSpeed(), which also applies the night boost. Creature::speed holds
	// the WIRE speed instead -- how far the agent actually moved this tick --
	// and stepAgent sets it every tick.
	agent->setSpeed(0);

	return agent;
}

uint16_t AgentManager::internStackGroup(const std::string& name)
{
	if (name.empty()) {
		return 0; // no stacking
	}
	auto it = stackGroups.find(name);
	if (it != stackGroups.end()) {
		return it->second;
	}
	const uint16_t id = static_cast<uint16_t>(stackGroups.size() + 1);
	stackGroups[name] = id;
	return id;
}

// <brain>: what the agent looks for, how far, and whether it gives chase.
static void parseBrain(const pugi::xml_node& brain, AgentData& ad, const std::string& filename)
{
	ad.brain = parseBrainType(brain.attribute("type").as_string(), ad.key, filename);
	ad.vision = static_cast<uint16_t>(brain.attribute("vision").as_uint());
	ad.loseTarget = static_cast<uint16_t>(brain.attribute("loseTarget").as_uint(0));
	ad.leash = static_cast<uint16_t>(brain.attribute("leash").as_uint());
	// chase="false" -> holds its ground and only hits what walks into
	// reach. No pursuit, no pathfinding, no line-of-sight tests.
	ad.chase = brain.attribute("chase").as_bool(true);
	ad.roamRadius = static_cast<uint16_t>(brain.attribute("roamRadius").as_uint(0));
	ad.roamPauseMs = brain.attribute("roamPauseMs").as_uint(0);
	ad.aggroAfterCycles = static_cast<uint16_t>(brain.attribute("aggroAfterCycles").as_uint(0));
	ad.aggroAfterMinutes = static_cast<uint16_t>(brain.attribute("aggroAfterMinutes").as_uint(0));
	ad.repelBreakMs = brain.attribute("repelBreakMs").as_uint(AGENT_REPEL_BREAK_DEFAULT_MS);

	for (pugi::xml_node t = brain.child("target"); t; t = t.next_sibling("target")) {
		AgentTarget at;
		at.type = parseTargetType(t.attribute("type").as_string(), ad.key, filename);
		at.priority = static_cast<uint16_t>(t.attribute("priority").as_uint());
		// Defaults to the agent-wide `chase` so an existing <target> that
		// says nothing keeps behaving exactly as it did.
		at.pursue = t.attribute("pursue").as_bool(ad.chase);
		ad.targets.push_back(at);
	}

	if (ad.loseTarget > 0 && ad.loseTarget < ad.vision) {
		reportDataWarning(filename, fmt::format(
			"'{}' loseTarget={} is below vision={}; using {} instead "
			"(a give-up range narrower than the acquire range makes the agent flicker)",
			ad.key, ad.loseTarget, ad.vision, ad.loseTargetRange()));
	}
}

// <dodge>: sidestep incoming fire. Presence enables it, like <daylight>.
static void parseDodge(const pugi::xml_node& node, AgentData& ad, const std::string& filename)
{
	AgentDodge& d = ad.dodge;
	d.enabled = true;
	d.chance = node.attribute("chance").as_float(1.0f);
	d.reactionMs = node.attribute("reactionMs").as_uint(d.reactionMs);
	d.speed = static_cast<uint16_t>(node.attribute("speed").as_uint(0));
	d.durationMs = node.attribute("durationMs").as_uint(d.durationMs);
	d.cooldownMs = node.attribute("cooldownMs").as_uint(d.cooldownMs);
	d.margin = static_cast<uint16_t>(node.attribute("margin").as_uint(0));

	if (d.chance < 0.0f || d.chance > 1.0f) {
		reportDataWarning(filename, fmt::format(
			"'{}' <dodge chance=\"{}\"> is outside 0..1; clamping", ad.key, d.chance));
		d.chance = std::min(1.0f, std::max(0.0f, d.chance));
	}
	if (d.chance == 0.0f) {
		reportDataWarning(filename, fmt::format(
			"'{}' <dodge chance=\"0\"> never fires; remove the node instead so the "
			"bullet pass can skip this type entirely", ad.key));
	}
	if (d.reactionMs == 0) {
		reportDataWarning(filename, fmt::format(
			"'{}' <dodge reactionMs=\"0\"> means it never sees a shot coming; disabling",
			ad.key));
		d.enabled = false;
	}
	// A sidestep shorter than the warning it acts on is over before the bullet
	// arrives -- the agent flinches and steps back into the shot.
	if (d.enabled && d.durationMs < d.reactionMs) {
		reportDataWarning(filename, fmt::format(
			"'{}' <dodge durationMs=\"{}\"> is shorter than reactionMs=\"{}\"; the sidestep "
			"ends before the shot lands. Using {}",
			ad.key, d.durationMs, d.reactionMs, d.reactionMs));
		d.durationMs = d.reactionMs;
	}
}

// <abilities>: the unified melee/ranged/repair/heal list.
static void parseAbilities(const pugi::xml_node& abilities, AgentData& ad, const std::string& filename)
{
	for (pugi::xml_node ab = abilities.child("ability"); ab; ab = ab.next_sibling("ability")) {
		AgentAbility aa;
		aa.type = parseAbilityType(ab.attribute("type").as_string(), ad.key, filename);
		aa.cooldownMs = ab.attribute("cooldownMs").as_uint();
		aa.impactMs = ab.attribute("impactMs").as_uint();
		aa.range = static_cast<uint16_t>(ab.attribute("range").as_uint());
		aa.radius = static_cast<uint16_t>(ab.attribute("radius").as_uint());
		aa.staminaUsage = static_cast<uint8_t>(ab.attribute("staminaUsage").as_uint());
		aa.amount = static_cast<uint16_t>(ab.attribute("amount").as_uint());
		aa.projectile = ab.attribute("projectile").as_string();
		if (pugi::xml_node dmg = ab.child("damage")) {
			aa.damage.amount = clampDamageAmount(dmg.attribute("amount").as_llong());
			aa.damage.amountMax = clampDamageAmount(dmg.attribute("amountMax").as_llong(aa.damage.amount));

			// A <damage> block that declares no amount is an ability that hits
			// for nothing -- which looks exactly like a monster that will not
			// attack, and used to be reported as such by nobody.
			if (aa.damage.amount == 0 && aa.damage.amountMax == 0) {
				reportDataWarning(filename, fmt::format(
					"'{}' ability '{}' has a <damage> with no amount=; it hits for 0",
					ad.key, abilityTypeName(aa.type)));
			}
		}
		aa.knockback = ab.attribute("knockback").as_float(0.0f);

		// condition= / chance= on the ability itself: what a landed swing
		// inflicts. Checked against conditions.xml by validateDataReferences,
		// which is the only place both tables exist.
		// The condition rides the <ability> element itself (condition= on the
		// ability), while <leech> and <crit> are children of it -- which is why
		// this is not one parseHitEffects call.
		const std::string owner = fmt::format("'{}' ability '{}'", ad.key, abilityTypeName(aa.type));
		xml_utils::parseConditionApplication(ab, aa.hitEffects.onHit, filename, owner);
		xml_utils::parseLeech(ab, aa.hitEffects.leech, filename, owner);
		xml_utils::parseCrit(ab, aa.hitEffects.crit, filename, owner);

		ad.abilities.push_back(aa);
	}
}

bool AgentManager::loadFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "agents");
	if (!root) return false;

	agents.clear();

	for (pugi::xml_node agentNode = root.child("agent"); agentNode; agentNode = agentNode.next_sibling("agent")) {
		AgentData ad;
		ad.key = agentNode.attribute("key").as_string();
		if (ad.key.empty()) {
			reportDataWarning(filename, "<agent> with no key skipped");
			continue;
		}
		ad.family = agentNode.attribute("family").as_string();

		int sprite = agentNode.attribute("sprite").as_int(0);
		if (sprite < 0 || sprite > AGENT_MAX_CLIENT_SPRITE) {
			reportDataWarning(filename, fmt::format(
				"'{}' sprite={} is outside the client's renderable range 0-{}; it will not draw correctly",
				ad.key, sprite, AGENT_MAX_CLIENT_SPRITE));
		}
		ad.sprite = static_cast<uint8_t>(sprite < 0 ? 0 : sprite);

		// body
		if (pugi::xml_node body = agentNode.child("body")) {
			ad.radius = static_cast<uint16_t>(body.attribute("radius").as_uint());
			ad.collision = body.attribute("collision").as_bool(true);
			// agentCollision="false" leaves the body solid to players, bullets
			// and geometry while every OTHER AGENT walks through it.
			ad.agentCollision = body.attribute("agentCollision").as_bool(true);
			// separation="false" lets any number of this agent occupy one spot
			// (and skips the crowd-spreading pass entirely).
			ad.separation = body.attribute("separation").as_bool(true);
			ad.separationRadius = static_cast<uint16_t>(body.attribute("separationRadius").as_uint(0));
			ad.stackGroup = internStackGroup(body.attribute("stackGroup").as_string());
		}

		// vitals
		if (pugi::xml_node vitals = agentNode.child("vitals")) {
			ad.health = static_cast<uint16_t>(vitals.attribute("health").as_uint());
			ad.experience = vitals.attribute("experience").as_uint();
			ad.lifetimeMs = vitals.attribute("lifetimeMs").as_uint();
		}

		// daylight sun-damage (optional; presence enables it)
		if (pugi::xml_node daylight = agentNode.child("daylight")) {
			ad.daylightEnabled = true;
			ad.daylightDamage = clampDamageAmount(daylight.attribute("damage").as_llong());
			ad.daylightIntervalMs = daylight.attribute("intervalMs").as_uint(1000);
		}

		// areaEffects (optional): fields the agent emits, object/resource schema.
		// The shared parser also notes the reach into g_maxAreaEffectTileReach.
		if (pugi::xml_node effects = agentNode.child("areaEffects")) {
			xml_utils::appendAreaEffects(effects, ad.areaEffects);
		}

		// resistances (optional): 0..1 fractions, the wearable semantics
		if (pugi::xml_node res = agentNode.child("resistances")) {
			auto frac = [&](const char* name) -> float {
				float v = res.attribute(name).as_float(0.0f);
				if (v < 0.0f || v > 1.0f) {
					reportDataWarning(filename, fmt::format(
						"'{}' resistance {}=\"{}\" is outside 0..1; clamping",
						ad.key, name, v));
					v = std::min(1.0f, std::max(0.0f, v));
				}
				return v;
			};
			ad.meleeResistance = frac("melee");
			ad.piercingResistance = frac("piercing");
			ad.explosionResistance = frac("explosion");
			ad.energyResistance = frac("energy");
			// The blanket condition resistance rides on the same element, since
			// "what this creature shrugs off" is one idea.
			ad.allConditionResistance = frac("conditions");

			// <condition key= fraction=>, repeatable: protection from one named
			// condition. The key is NOT resolved here -- conditions.xml loads
			// after agents.xml, so the table does not exist yet. Checked by
			// validateDataReferences once everything is loaded, exactly as
			// <ability condition=> already is.
			for (pugi::xml_node condNode = res.child("condition"); condNode;
			     condNode = condNode.next_sibling("condition")) {
				const std::string condKey = condNode.attribute("key").as_string();
				if (condKey.empty()) {
					reportDataWarning(filename, fmt::format(
						"'{}' has a <resistances><condition> with no key=; it protects "
						"against nothing", ad.key));
					continue;
				}
				float v = condNode.attribute("fraction").as_float(1.0f);
				if (v < 0.0f || v > 1.0f) {
					reportDataWarning(filename, fmt::format(
						"'{}' condition resistance {}=\"{}\" is outside 0..1; clamping",
						ad.key, condKey, v));
					v = std::clamp(v, 0.0f, 1.0f);
				}
				ad.conditionResistances[condKey] = v;
			}
		}

		// movement: one speed, optionally boosted at night
		if (pugi::xml_node movement = agentNode.child("movement")) {
			ad.speed = static_cast<uint16_t>(movement.attribute("speed").as_uint());
			ad.nightSpeed = static_cast<uint16_t>(movement.attribute("nightSpeed").as_uint(0));
		}
		if (ad.speed == 0) {
			reportDataWarning(filename, fmt::format(
				"'{}' has no <movement speed=\"...\"/>; it will never move", ad.key));
		}

		// brain
		if (pugi::xml_node brain = agentNode.child("brain")) {
			parseBrain(brain, ad, filename);
		}

		// dodge (optional; presence enables it)
		if (pugi::xml_node dodge = agentNode.child("dodge")) {
			parseDodge(dodge, ad, filename);
		}

		// abilities (unified melee/ranged/repair/heal)
		if (pugi::xml_node abilities = agentNode.child("abilities")) {
			parseAbilities(abilities, ad, filename);
		}

		// onDeath: explosion + drops
		if (pugi::xml_node onDeath = agentNode.child("onDeath")) {
			xml_utils::parseExplosionChild(onDeath, ad.explosion);
			if (pugi::xml_node drops = onDeath.child("drops")) {
				xml_utils::parseItemDrops(drops, ad.drops, filename,
					fmt::format("agent '{}'", ad.key));
			}
		}

		agents[ad.key] = std::move(ad);
	}

	// Targets and abilities alongside the agent count: an agent whose <brain> or
	// <abilities> failed to parse still counts as one agent, and would simply
	// stand there doing nothing.
	size_t targets = 0, abilities = 0;
	maxDodgeReaction = 0;
	for (const auto& [key, ad] : agents) {
		targets += ad.targets.size();
		abilities += ad.abilities.size();
		if (ad.dodge.enabled) {
			maxDodgeReaction = std::max(maxDodgeReaction, ad.dodge.reactionMs);
		}
	}
	reportDataFile(filename, fmt::format("{} agents ({} targets, {} abilities)",
		agents.size(), targets, abilities));
	return true;
}

void AgentManager::debugDump(const std::string& key) const
{
	const AgentData* ad = getAgentData(key);
	if (!ad) {
		fmt::print(fmt::fg(fmt::color::yellow), ">> [spawn-agent] unknown agent '{}'\n", key);
		return;
	}

	fmt::print(fmt::fg(fmt::color::cyan) | fmt::emphasis::bold,
		">> [spawn-agent] '{}' (family='{}', sprite={})\n", ad->key, ad->family, ad->sprite);
	fmt::print("     body: radius={} collision={} agentCollision={} separation={} spacing={}\n",
		ad->radius, ad->collision, ad->agentCollision, ad->separation, ad->spacing());
	fmt::print("     vitals: health={} experience={} lifetimeMs={}\n", ad->health, ad->experience, ad->lifetimeMs);
	if (ad->daylightEnabled) {
		fmt::print("     daylight: {} damage every {}ms\n", ad->daylightDamage, ad->daylightIntervalMs);
	}
	if (ad->meleeResistance > 0.0f || ad->piercingResistance > 0.0f ||
	    ad->explosionResistance > 0.0f || ad->energyResistance > 0.0f) {
		fmt::print("     resistances: melee={} piercing={} explosion={} energy={}\n",
			ad->meleeResistance, ad->piercingResistance, ad->explosionResistance, ad->energyResistance);
	}
	for (const AreaEffect& e : ad->areaEffects) {
		fmt::print("     areaEffect: {} strength={} radius={} area={}\n",
			e.type, e.strength, e.radius, e.area);
	}
	fmt::print("     movement: speed={} nightSpeed={}\n",
		ad->speed, ad->nightSpeed > 0 ? ad->nightSpeed : ad->speed);
	fmt::print("     brain: type='{}' chase={} vision={} loseTarget={} leash={} ({} targets)\n",
		brainTypeName(ad->brain), ad->chase, ad->vision, ad->loseTargetRange(), ad->leash, ad->targets.size());
	if (ad->dodge.enabled) {
		fmt::print("     dodge: chance={} reaction={}ms speed={} duration={}ms cooldown={}ms margin={}\n",
			ad->dodge.chance, ad->dodge.reactionMs,
			ad->dodge.speed > 0 ? ad->dodge.speed : ad->speed,
			ad->dodge.durationMs, ad->dodge.cooldownMs, ad->dodge.margin);
	}
	fmt::print("     roam (world-spawned only): leg={} pause={}ms\n",
		ad->roamRadius > 0 ? ad->roamRadius : AGENT_DEFAULT_ROAM_RADIUS,
		ad->roamPauseMs > 0 ? ad->roamPauseMs : AGENT_DEFAULT_ROAM_PAUSE_MS);
	if (ad->aggroAfterCycles > 0 || ad->aggroAfterMinutes > 0) {
		fmt::print("     aggro: only hunts players who have survived {} (or who attacked one)\n",
			ad->aggroAfterCycles > 0 ? fmt::format("{} day/night cycle(s)", ad->aggroAfterCycles)
			                         : fmt::format("{} minute(s)", ad->aggroAfterMinutes));
	} else {
		fmt::print("     aggro: hostile to any player on sight\n");
	}
	for (const auto& t : ad->targets) {
		fmt::print("        target: {} priority={}\n", targetTypeName(t.type), t.priority);
	}
	fmt::print("     abilities: {}\n", ad->abilities.size());
	for (const auto& a : ad->abilities) {
		fmt::print("        {} cd={}ms impact={}ms range={} dmg={}-{} kb={} amount={} proj='{}'\n",
			abilityTypeName(a.type), a.cooldownMs, a.impactMs, a.range, a.damage.amount, a.damage.amountMax, a.knockback, a.amount, a.projectile);
	}
	if (ad->explosion.enabled) {
		fmt::print("     onDeath explosion: radius={} area={} playerDmg={} buildingDmg={}\n",
			ad->explosion.radius, ad->explosion.area, ad->explosion.playerDamage, ad->explosion.buildingDamage);
	}
	for (const auto& d : ad->drops) {
		fmt::print("     onDeath drop: {} x{} (iid={})\n", d.itemKey, d.amount, d.iid);
	}
}
