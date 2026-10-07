// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/game.h"

#include "content/configmanager.h"
#include "gameplay/creature.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "gameplay/loot.h"
#include "gameplay/object.h"
#include "gameplay/resource.h"
#include "gameplay/agent.h"
#include "gameplay/scenarios/scenario_runtime.h"
#include "gameplay/item.h"
#include "world/collision.h"
#include "gameplay/projectile.h"
#include "gameplay/equipment.h"
#include "core/perf.h"
#include <array>
#include <cmath>
#include <fstream>

// --- Agent AI --------------------------------------------------------------
//
// Targeting, hostility, both brains, pathfinding, roaming, spawn placement and
// the per-tick driver (updateAgents). Moved out of game.cpp 2026-07-27 as a
// pure cut: every body is byte-identical to what game.cpp held; only file-scope
// linkage changed. Two agent-touching functions deliberately stayed behind:
// stepAgent (it shares the movement resolver's collision statics with
// updateMovement) and updateAgentSpawns (it shares the scheduled-loop helpers).

// Defined in game.cpp, where the movement resolver owns it. The agent planners
// (agentBodyBlockedAt, agentSettleBody) test bodies with the SAME predicate the
// movement layer resolves with, so the two can never disagree about overlap --
// which is the property the planner comments below rely on.
bool playerOverlapsObstacle(Thing* obstacle, float px, float py, float playerRadius, float& overlap, float& nx, float& ny);

// --- Agents (monster/robot AI) -----------------------------------------------

// Per-tick dump of every engaged agent's state to a FILE (agent_debug.log in
// the server's working dir) -- complete and ordered, unlike the console, which
// drops most lines under load. Toggled live with the !agent-debug admin
// command, so diagnosing a behaviour never costs a rebuild.
static bool g_agentDebug = false;
static uint32_t g_agentDebugTick = 0;

// How many A* searches all agents together may run in one movement tick. Each
// costs up to MAX_EXPANSIONS node pops plus the obstacle scan behind `blocked`,
// so this is the cap that keeps a large pack from stalling the tick. Agents
// that miss out chase straight this tick and re-decide on the next throttle
// window, which is a fraction of a second away.
static constexpr int32_t AGENT_PATH_SEARCHES_PER_TICK = 8;

// How close to its spawn point counts as "home". LATCHED with
// AGENT_REACH_HYSTERESIS on the way out (see the go-home branch of
// runAgentBrain): as a bare threshold an agent nudged a pixel past it takes a
// whole step back, and alternates between walking and standing every tick.
static constexpr float AGENT_HOME_ARRIVE = 20.0f;

// !agent-debug. Lives here so the flag has exactly one owner; the command table
// only dispatches to it.
void Game::adminToggleAgentDebug()
{
	g_agentDebug = !g_agentDebug;
	fmt::print(fmt::fg(fmt::color::cyan),
		">> [agent-debug] per-tick agent dump {} -> agent_debug.log\n", g_agentDebug ? "ON" : "OFF");
}

// Turns the agent toward (dx, dy) with a small dead-zone, so sub-pixel jitter in
// the target direction cannot spam the facing (the "shaking in place" symptom).
static void faceAgentToward(Agent* agent, float dx, float dy)
{
	if (dx == 0.0f && dy == 0.0f) return;
	float ang = std::atan2(dy, dx);
	if (ang < 0) ang += MATH_TWO_PI;
	const int target = static_cast<int>((ang * 255.0f) / MATH_TWO_PI) & 255;
	const int cur = agent->getRotation();
	int diff = target - cur;
	while (diff > 128) diff -= 256; // shortest way around the circle
	while (diff < -128) diff += 256;
	if (diff > -4 && diff < 4) return; // dead-zone against micro-jitter
	// Cap the turn speed so the facing can never whip around in one tick, even if
	// the target direction jumps.
	const int maxTurn = 24; // ~34 deg/tick
	if (diff > maxTurn) diff = maxTurn;
	else if (diff < -maxTurn) diff = -maxTurn;
	agent->setRotation(static_cast<uint8_t>((cur + diff) & 255));
}

// How close a body has to get to touch this object. Objects are rectangles as
// often as circles, so the radius alone is not the answer -- getCollisionRadius
// returns 0 for a rect. Same half-extent measure ObjectManager uses.
static float objectReachExtent(const Object* obj)
{
	const ObjectData* od = obj->getData();
	if (!od) return 0.0f;
	return static_cast<float>(std::max({static_cast<uint16_t>(od->width / 2),
	                                    static_cast<uint16_t>(od->height / 2),
	                                    od->radius}));
}

uint32_t Game::ownerOfThing(const Thing* thing) const
{
	if (!thing) return 0;
	// Agent before Creature: an Agent IS a Creature, and the specific answer is
	// the right one.
	if (const Agent* a = thing->getAgent()) return a->getOwnerGuid();
	if (const Object* o = thing->getObject()) return o->getOwnerPid();
	if (const Creature* c = thing->getCreature()) {
		if (const Player* p = c->getPlayer()) return p->getGUID();
	}
	return 0;
}

const AgentTarget* Game::agentTargetRuleFor(const AgentData* data, const Thing* thing)
{
	if (!data || !thing) return nullptr;
	if (thing->getAgent()) return data->findTarget(AgentTargetType::Agent);
	if (thing->getObject()) return data->findTarget(AgentTargetType::Object);
	if (const Creature* c = thing->getCreature()) {
		if (c->getPlayer()) return data->findTarget(AgentTargetType::Player);
	}
	return nullptr;
}

float Game::agentTargetExtent(const Thing* thing)
{
	if (const Object* obj = thing->getObject()) {
		return objectReachExtent(obj);
	}
	return thing->getCollisionRadius();
}

uint16_t Game::agentsTargeting(uint32_t thingId) const
{
	if (thingId == 0) return 0;
	const auto it = agentTargetCensus.find(thingId);
	return it == agentTargetCensus.end() ? 0 : it->second;
}

int64_t Game::agentCrowdedDistSq(int64_t distSq, const Thing* thing, float bodyRadius) const
{
	// OBJECTS ONLY, and that restriction is the point rather than an
	// optimisation. A player or a rival bot is ONE body: re-ranking them by how
	// many agents are already on them would be a rule for ignoring whoever is
	// under attack, which is the opposite of what a pack should do. It is
	// BUILDINGS that come in interchangeable tile-sized pieces, and a base with
	// its whole assault queued at one wall is the entire case this exists for.
	const Object* obj = thing->getObject();
	if (!obj || bodyRadius <= 0.0f) return distSq;

	const uint16_t attackers = agentsTargeting(thing->getID());
	if (attackers == 0) return distSq;

	// Capacity from the object's own geometry, so nothing has to be tuned per
	// object type: a quarter of the perimeter per body diameter. A tile-wide
	// wall holds a couple of ghouls, a long building proportionally more, and a
	// player who builds with something else gets a sensible answer for free.
	const ObjectData* od = obj->getData();
	const float perimeter = (od && (od->width > 0 || od->height > 0))
		? 2.0f * (static_cast<float>(od->width) + static_cast<float>(od->height))
		: MATH_TWO_PI * objectReachExtent(obj);
	const int32_t capacity = std::clamp(static_cast<int32_t>(perimeter / (4.0f * bodyRadius)),
	                                    1, static_cast<int32_t>(AGENT_CROWD_CAPACITY_MAX));

	const int32_t overflow = static_cast<int32_t>(attackers) - capacity;
	if (overflow <= 0) return distSq;

	// RANKED further away, never actually moved: the vision gate, reachability
	// and everything downstream still see the true distance. This number leaves
	// the comparison it was made for.
	return distSq + static_cast<int64_t>(static_cast<double>(distSq) *
	                                     overflow * AGENT_CROWD_DISTANCE_PENALTY);
}

// Which rank a thing occupies in an agent's target order; SMALLER IS BETTER,
// and nothing = worse than anything.
//
// The order is structural rather than a setting: the player pass is a walk of
// the player table and the rest needs a tile sweep, so the tiers cannot be
// compared against each other in the first place -- see findAgentTarget. The one
// configurable part is agent-vs-object, and that is settled inside
// scanAgentSecondaryTargets where both are in hand.
//
// Made explicit because stickiness needs it. A target is held so the goal does
// not thrash between two candidates of the SAME rank; holding one against a
// BETTER rank is a different thing entirely, and was why a ghoul went on chewing
// a wall while the bot that came to kill it hit it in the back.
static int agentTargetTier(const Thing* thing)
{
	if (!thing) return AGENT_TIER_NONE;
	if (thing->getAgent()) return AGENT_TIER_AGENT;
	if (thing->getObject()) return AGENT_TIER_OBJECT;
	if (const Creature* c = thing->getCreature()) {
		if (c->getPlayer()) return AGENT_TIER_PLAYER;
	}
	return AGENT_TIER_NONE;
}

// Is this world-spawned agent currently engaged against `side` -- that player
// themselves, one of their bots, or one of their buildings?
bool Game::isAgentTargeting(const Agent* agent, uint32_t side)
{
	if (!agent || side == 0) return false;

	// What it has actually HIT recently, first. targetId alone leaves two holes
	// a defender would feel as its bots going limp mid-fight: an agent takes
	// swings at whatever is in reach while walking to something else, and it
	// holds no target for the moment between its last one being destroyed and
	// the next being found. See Agent::noteAggressionAgainst.
	const uint64_t now = OTSYS_TIME();
	if (now < agent->getAggressionUntil() &&
	    isSameOwnerSide(side, agent->getAggressionSide())) {
		return true;
	}

	const uint32_t targetId = agent->getTargetId();
	if (targetId == 0) return false;

	Thing* target = map.getThingByID(targetId);
	if (!target) return false;
	return isSameOwnerSide(side, ownerOfThing(target));
}

// Is `obj` a sprung, damaging step-trap that `agent` is currently standing on?
// Same-tile is EXACTLY the condition under which the trap's DoT lands
// (Object::updateTriggers re-checks tile equality per pulse), so this answer
// flips off on the tick the agent steps clear -- which is what keeps the
// self-preservation exception below from ever making traps in general targets.
static bool isTrapPinningAgent(const Agent* agent, const Object* obj)
{
	if (obj->isDestroyed || !obj->isTriggered) return false;
	const ObjectData* od = obj->getData();
	if (!od || obj->getMaxHealth() == 0 || obj->isIndestructible()) return false;
	if (od->category != ObjectCategory::Trap) return false;
	if (!od->onStepIn.enabled || od->onStepIn.damage <= 0) return false;

	const Position apos = agent->getPosition();
	const Position opos = obj->getPosition();
	return (apos.x / TILE_SIZE == opos.x / TILE_SIZE) &&
	       (apos.y / TILE_SIZE == opos.y / TILE_SIZE);
}

// Is this thing on a side this agent fights?
//
// One question asked of three entity types, because "the player, their bots and
// their buildings" is one side and not three problems. Everything hangs off
// ownerOfThing, so extending hostility to a new kind of property is a matter of
// that accessor knowing about it.
bool Game::isAgentHostileTo(const Agent* agent, const Thing* thing)
{
	if (!thing || thing == static_cast<const Thing*>(agent)) return false;

	const AgentData* data = agent->getData();
	if (!data) return false;

	// SELF-PRESERVATION, ahead of every other rule INCLUDING the <target>
	// list: the sprung, damaging trap this agent is STANDING ON is hostile to
	// it no matter whose it is -- its own owner's included (user rule
	// 2026-07-27). Only TRIGGERING exempts a side; an already-sprung own spike
	// hurts own bots, and without this the bot could neither leave quickly
	// (the slow) nor fight back (own-side property is otherwise never
	// hostile). Because the predicate is shared, being pinned makes the trap
	// swingable-at (findHostileInReach), acquirable for agents with an object
	// target rule, and it drops out of ALL of those the moment the agent is
	// off the tile -- a freed agent goes back to its real business instead of
	// hunting traps.
	if (const Object* obj = thing->getObject()) {
		if (isTrapPinningAgent(agent, obj)) return true;
	}

	// The agent must engage this KIND of thing at all. Absence of a <target>
	// entry is the off switch, so a bot that should ignore buildings simply does
	// not list them.
	if (!agentTargetRuleFor(data, thing)) return false;

	// Per-kind liveness. A dying agent, a destroyed object and a ghosted player
	// are all "not there" for targeting purposes.
	if (const Agent* other = thing->getAgent()) {
		if (other->isDying()) return false;
	} else if (const Object* obj = thing->getObject()) {
		if (obj->isDestroyed) return false;
		const ObjectData* od = obj->getData();
		if (!od || obj->getMaxHealth() == 0 || obj->isIndestructible()) return false; // nothing to break
		// Hidden hazards are not targets: an unsprung trap is invisible to an
		// agent, and explosives are hidden (landmine) or a lit fuse (dynamite).
		if (od->category == ObjectCategory::Explosives) return false;
		if (od->category == ObjectCategory::Trap && !obj->isTriggered) return false;
	} else if (const Creature* c = thing->getCreature()) {
		const Player* p = c->getPlayer();
		if (!p || !p->client || p->isGhostMode()) return false;

		// A ghoul is a monster, and agents do not hunt monsters -- except that
		// in GHOUL MODE the monsters are the other side, and a base's bots are
		// the only thing a player can leave behind to hold ground. So a
		// player-BUILT agent treats a ghoul as an enemy body like any other,
		// while a world-spawned one still ignores it (ghouls have never fought
		// each other, and this mode spawns none anyway).
		//
		// Outside ghoul mode `ghoul` is never set on anyone, so the old blanket
		// rule and this one are the same rule for every existing world.
		if (p->isGhoul() && !(g_game.isGhoulMode() && agent->getOwnerGuid() != 0)) {
			return false;
		}
	} else {
		return false;
	}

	const uint32_t myOwner = agent->getOwnerGuid();
	const uint32_t theirOwner = ownerOfThing(thing);

	// REPELLENTS (the ghoul drug, conditions.xml <repel>): whether the
	// agent's KIND can smell this SIDE at all.
	//
	// Resolved through the OWNER, exactly as the survival grace below is, and
	// for the same reason -- a protection that covered your body but not your
	// home would protect the half you can run away with. A drugged player's
	// walls and bots go quiet with them, and because this is the one predicate
	// selection re-runs every tick, ghouls already chewing on them let go on
	// the spot rather than finishing what they started.
	//
	// It lives in the HOSTILITY predicate rather than at selection, which is the
	// rest of the feature: exempting only selection would leave the drugged
	// player swung at by any ghoul they walked past (findHostileInReach hits
	// whatever hostile is in reach while the agent walks elsewhere) and turned
	// on the moment they fired (agentProvoked). One predicate, so sight, alerts,
	// the in-reach swing and provocation cannot disagree.
	//
	// Matched on FAMILY first, which is what makes the drug selective: every
	// ghoul type shares family="ghoul", so one word stops the ghouls and leaves
	// the robots (family="bot") hunting exactly as before. Broken per TYPE by
	// hitting one -- see Player::breakRepelForAgentType.
	if (theirOwner != 0) {
		if (const Player* owner = getPlayerByGUID(theirOwner)) {
			if (owner->repelsAgent(data->family, data->key)) return false;
		}
	}

	// Two completely different rule sets, chosen by who spawned the agent.
	if (myOwner != 0) {
		// Built by a player: it DEFENDS its owner's side. Everything on another
		// player's side is fair game on sight -- that is a rivalry, and both
		// halves of it are somebody's choice. World things are not:
		//
		//   objects  unowned scenery is nobody's property to attack, ever.
		//   agents   a monster is a bot's business only once it has actually
		//            turned on this side -- come for the owner, their bots or
		//            their walls. Bots used to swing at every ghoul that
		//            wandered past, which is how a base picked fights it was
		//            never in; and because a swing PROVOKES (see agentProvoked),
		//            the ghoul then turned on the bot and the fight was real.
		//            The test therefore has to live in the hostility predicate
		//            itself, which is the one thing selection, the in-reach
		//            swing and provocation all agree on -- exempting only
		//            selection would have left the bot starting the fight with
		//            whatever walked past it anyway.
		if (theirOwner == 0) {
			if (thing->getObject()) return false;
			if (const Agent* wild = thing->getAgent()) {
				return isAgentTargeting(wild, myOwner);
			}
			return false;
		}
		// no-pvp: a bot may still RAID (buildings are fair game in both world
		// types) but never touches a rival's body or bots. Here rather than at
		// selection because a swing PROVOKES -- same reason as the rule above.
		if (!isPvpEnabled() && !thing->getObject()) return false;
		return !isSameOwnerSide(myOwner, theirOwner);
	}

	// Spawned by the world. Only player property is hostile: never other world
	// agents (ghouls do not fight each other) and never world scenery.
	if (theirOwner == 0) return false;

	// The survival grace resolves through the OWNER, so it covers a fresh
	// player's bots and buildings as well as their body -- a grace that
	// protected the body but not the home would protect the half you can run
	// away with.
	const uint64_t aggroAfter = data->aggroAfterMs(getDayNightCycleMs());
	if (aggroAfter > 0) {
		// Offline owners have no grace: they are not a player who just
		// respawned into danger, and their base should not be untouchable.
		if (const Player* owner = getPlayerByGUID(theirOwner)) {
			if (owner->getSurvivedMs() < aggroAfter && !owner->hasProvokedAgentType(data->key)) {
				return false;
			}
		}
	}
	return true;
}

// Latches which side of the target this agent will approach from. See
// AGENT_SURROUND_STEP: the slot is measured from the bearing the agent is on
// RIGHT NOW, so the walk stays short, and offset by the agent's id so a group
// arriving together fans out instead of forming a queue.
static void latchAgentSurroundSlot(Agent* agent, const Position& targetPos)
{
	const Position apos = agent->getPosition();
	const float dx = static_cast<float>(apos.x) - targetPos.x;
	const float dy = static_cast<float>(apos.y) - targetPos.y;
	const float bearing = (dx == 0.0f && dy == 0.0f) ? 0.0f : std::atan2(dy, dx);
	const int32_t slot = static_cast<int32_t>(agent->getID() % AGENT_SURROUND_SLOTS) -
	                     (AGENT_SURROUND_SLOTS / 2);
	agent->setSurroundAngle(bearing + static_cast<float>(slot) * AGENT_SURROUND_STEP);
}

void Game::alertNearbyAgents(Agent* source, Thing* target)
{
	const AgentData* data = source->getData();
	if (!data || !target) {
		return;
	}

	const uint64_t now = OTSYS_TIME();
	if (now < source->getNextAlertAt()) {
		return;
	}
	source->setNextAlertAt(now + AGENT_ALERT_COOLDOWN_MS);

	// Radius is the shouting agent's own vision, so it needs no separate tuning.
	const int32_t radius = data->vision;
	if (radius <= 0) {
		return;
	}

	const Position spos = source->getPosition();
	const int32_t margin = radius / TILE_SIZE + 1;
	const int32_t tx = spos.x / TILE_SIZE;
	const int32_t ty = spos.y / TILE_SIZE;
	agentAlertScratch.clear();
	map.getThingsInTileBox(tx - margin, ty - margin, tx + margin, ty + margin, agentAlertScratch);

	const int64_t radiusSq = static_cast<int64_t>(radius) * radius;
	const Position tpos = target->getPosition();
	for (Thing* thing : agentAlertScratch) {
		Agent* other = thing->getAgent();
		// Only agents of the same family, only ones with nothing to chase, and
		// only ones that would pursue at all. Leaving engaged agents alone also
		// keeps a shout from yanking a pack off the player it is already on.
		if (!other || other == source || other->isDying() || other->isEngaged()) continue;
		const AgentData* od = other->getData();
		if (!od || !od->chase || od->family != data->family) continue;

		const Position opos = other->getPosition();
		const int64_t dx = static_cast<int64_t>(opos.x) - spos.x;
		const int64_t dy = static_cast<int64_t>(opos.y) - spos.y;
		if (dx * dx + dy * dy > radiusSq) continue;

		// Through the same gate as sight: a shout must never reach a target that
		// looking at it would not have.
		if (!isAgentHostileTo(other, target)) continue;

		other->setTargetId(target->getID());
		other->resetTargetVelocity();
		latchAgentSurroundSlot(other, tpos);
		// Whatever it was doing is over; the roam leg would otherwise keep
		// pulling it the other way until the leg ended.
		other->abandonRoamLeg();
		other->clearPath();
		other->resetStuck();
	}
}

void Game::agentProvoked(Agent* agent, Thing* attacker)
{
	if (!attacker || agent->isDying()) {
		return;
	}

	// Turn on whoever is shooting. Without this an agent hit from beyond its
	// `vision` just stands there being shot: it only ever notices what walks
	// into sight. Bounded for free by loseTargetRange -- a target further off
	// than that is dropped on the very next tick -- so this cannot pull an agent
	// across the map, only out of the last stretch it could not quite see.
	//
	// Only a STRICTLY BETTER tier may take the target over. Switching to every
	// fresh attacker would let whoever hit last steer the agent, and two of them
	// would hand it back and forth 20 times a second -- but that only happens
	// between attackers of the SAME rank, and a tier can only be climbed a
	// couple of times before there is nothing better to climb to.
	//
	// So an unengaged agent (tier NONE, the worst) still turns on anything that
	// hits it, two bots beating on one ghoul still cannot pull it back and forth
	// between them, and a ghoul demolishing a wall now turns on the bot that is
	// killing it instead of chewing on regardless. What stops an agent ignoring
	// an attacker it will NOT retarget onto is unchanged: the brain swings at
	// whatever hostile is already in reach (findHostileInReach).
	const int attackerTier = agentTargetTier(attacker);
	const int currentTier = agentTargetTier(map.getThingByID(agent->getTargetId()));
	if (attackerTier < currentTier && isAgentHostileTo(agent, attacker)) {
		agent->setTargetId(attacker->getID());
		agent->resetTargetVelocity();
		latchAgentSurroundSlot(agent, attacker->getPosition());
		agent->abandonRoamLeg();
		agent->clearPath();
		agent->resetStuck();
	}

	alertNearbyAgents(agent, attacker);
}

Thing* Game::findAgentTarget(Agent* agent)
{
	const Position apos = agent->getPosition();
	const AgentData* data = agent->getData();
	const uint64_t now = OTSYS_TIME();

	auto distSqTo = [&apos](const Thing* t) -> int64_t {
		const int64_t dx = static_cast<int64_t>(t->getPosition().x) - apos.x;
		const int64_t dy = static_cast<int64_t>(t->getPosition().y) - apos.y;
		return dx * dx + dy * dy;
	};

	// How close this agent has to get to land a hit on a given thing -- the
	// distance canAgentReach has to prove it can close to.
	const AgentAbility* meleeAbility = agent->getMeleeAbility();
	const float reachBase =
		(meleeAbility ? static_cast<float>(meleeAbility->range) : 0.0f) + agent->getCollisionRadius();
	auto reachFor = [&reachBase](const Thing* t) { return reachBase + agentTargetExtent(t); };

	// ONE throttle decision per tick, shared by everything below that needs the
	// ~1s clock: re-confirming the current target's reachability, and the tile
	// sweep for bots and buildings. Taken up front rather than per question,
	// because an agent holding a wall now wants BOTH in the same tick -- check
	// what it has, and look for something better than it.
	const bool scanDue = now >= agent->getNextTargetScanAt();
	if (scanDue) {
		agent->setNextTargetScanAt(now + AGENT_TARGET_SCAN_MS + (agent->getID() % 16) * 25);
	}

	// STICKY target, dropped at a range deliberately WIDER than the one that
	// acquired it. Re-picking from scratch every tick gave the agent two ways to
	// thrash its own goal: it flipped between "has a target" and "has none" for
	// something sitting on the vision boundary -- running at it one tick and
	// walking home the next -- and it swapped between two similarly distant
	// candidates. Both moved the goal 20 times a second. See
	// AgentData::vision / loseTargetRange.
	//
	// Stickiness matters MORE now that a player, their bots and their walls all
	// compete for the same slot: without it an agent in a base would flick
	// between the wall in front of it and the bot beside it forever.
	//
	// But stickiness ranks EQUALS, not betters. Held unconditionally it pinned a
	// ghoul to the first wall it latched: the passes below never ran, so a bot
	// walking up to kill it was never even looked at, and it went on demolishing
	// the wall with something chewing on its back. What survives below is a
	// sticky target that only a STRICTLY BETTER tier can take away -- which is
	// the thrash-free half of the rule, since nothing of equal rank can ever
	// displace it. See agentTargetTier.
	Thing* sticky = nullptr;
	if (const uint32_t stickyId = agent->getTargetId()) {
		Thing* current = map.getThingByID(stickyId);
		const int64_t loseRange = static_cast<int64_t>(data->loseTargetRange());
		bool keep = isAgentHostileTo(agent, current) && distSqTo(current) <= loseRange * loseRange;

		// Re-confirm REACHABILITY on the throttle. Something that was reachable
		// when it was acquired can stop being so, and for a target that MOVES
		// that is not an edge case -- a player running into a server-spawned
		// building the agent cannot break into is the ordinary way to escape
		// one. Without this the agent stands at the wall for as long as they
		// care to stay there.
		if (keep && scanDue) {
			const AgentTarget* rule = agentTargetRuleFor(data, current);
			if (rule && rule->pursue &&
			    canAgentReach(agent, current->getPosition(), reachFor(current), true) ==
			        Reachable::No) {
				agent->noteUnreachable(stickyId, now, AGENT_UNREACHABLE_MOVER_MS);
				keep = false;
			}
		}

		if (keep) {
			sticky = current;
		} else {
			agent->setTargetId(0); // out of range, gone, no longer hostile, or walled off
			agent->resetTargetVelocity();
		}
	}

	const int stickyTier = agentTargetTier(sticky);
	if (stickyTier == AGENT_TIER_PLAYER) {
		return sticky; // nothing outranks a player, so there is nothing to look for
	}

	// --- Tier 1: players ---------------------------------------------------
	//
	// Checked EVERY TICK, over the player table, exactly as it always was: the
	// table is small and already indexed, so noticing a player costs what it
	// always cost and happens as fast as it always did.
	//
	// Running this pass first is also what implements the tier order. A player
	// in sight wins outright -- over a wall or a bot this agent is already on,
	// as well as over one it has just found; the sweep for bots and walls below
	// is only consulted when there is no player to be had, so no comparison
	// between tiers ever has to be made.
	//
	// EVERYTHING BELOW THIS POINT RUNS ONLY ON A FIRST-HAND SIGHTING. An agent
	// that was handed a PLAYER by someone else's shout returned from the sticky
	// branch above and never gets here, which is the whole reason alerts cannot
	// cascade across the map in hops.
	Thing* best = nullptr;
	if (const AgentTarget* playerRule = data->findTarget(AgentTargetType::Player)) {
		int64_t bestDistSq = static_cast<int64_t>(data->vision) * data->vision;
		for (const auto& it : players) {
			Player* p = it.second;
			// DISTANCE FIRST. Almost every player in the table is out of sight of
			// any given agent, and rejecting them costs two multiplies here
			// against a string-keyed <target> lookup inside isAgentHostileTo.
			// This pass now also runs for an agent that is holding a lower-tier
			// target (so a player can take it over), so it is walked by every
			// agent every tick and the order matters.
			const int64_t d2 = distSqTo(p);
			if (d2 > bestDistSq) continue;
			if (!isAgentHostileTo(agent, p)) continue;
			// Proved unreachable a moment ago: not a candidate, so the agent
			// picks the next nearest instead of re-proving the same wall.
			if (agent->knownUnreachable(p->getID(), now)) continue;
			bestDistSq = d2;
			best = p;
		}

		// Reachability is part of being a target AT ALL -- a player standing
		// inside a server-spawned building an agent cannot break into is not
		// something to walk at and give up on, it is something never to turn
		// toward. Same rule the repair bots got.
		//
		// Tested on the WINNER only, and only for an agent that would actually
		// walk to it: testing every candidate would spend the A* budget proving
		// things about players this agent was never going to chase. A verdict of
		// No is remembered, so the next tick considers the next nearest.
		if (best && playerRule->pursue) {
			switch (canAgentReach(agent, best->getPosition(), reachFor(best), true)) {
				case Reachable::Yes:
					break;
				case Reachable::No:
					agent->noteUnreachable(best->getID(), now, AGENT_UNREACHABLE_MOVER_MS);
					best = nullptr;
					break;
				case Reachable::Unknown:
					// Budget spent. Decide nothing rather than guess: acquiring
					// blind risks the wall-stare, condemning blind makes an agent
					// ignore someone it could have reached. Changing nothing means
					// keeping whatever it already had, not dropping it.
					return sticky;
			}
		}
	}

	// --- Tiers 2 and 3: the owner's bots, then their buildings --------------
	//
	// `sticky` goes in so the sweep knows what it has to BEAT: with a wall
	// already latched only a bot can take the slot, and with a bot latched
	// there is nothing down here that could, so the tile box is never built.
	if (!best) {
		best = scanAgentSecondaryTargets(agent, scanDue, sticky);
	}

	if (!best) {
		if (sticky) return sticky; // nothing better in sight: carry on with it
		agent->setTargetId(0);
		return nullptr;
	}

	agent->setTargetId(best->getID());
	agent->resetTargetVelocity();
	latchAgentSurroundSlot(agent, best->getPosition());
	alertNearbyAgents(agent, best);
	return best;
}

// The throttled half of acquisition: everything that is not a player.
//
// Separate from the player pass because it costs differently. Players come from
// a table; bots and buildings have to be found by sweeping tiles over `vision`,
// which for a ghoul is a 15x15 box -- precisely the per-agent-per-tick sweep the
// viewport rule exists to forbid. Neither a wall nor a parked bot is going
// anywhere, so the sweep runs about once a second, staggered by id.
//
// `current` is what the agent is already committed to, if anything (never a
// player -- findAgentTarget settles that tier before calling). Whatever comes
// back must strictly OUTRANK it, so the only move this can make is a wall for a
// bot; it can never swap one wall for a marginally nearer wall, which is the
// thrashing stickiness exists to prevent.
Thing* Game::scanAgentSecondaryTargets(Agent* agent, bool scanDue, const Thing* current)
{
	if (!scanDue) return nullptr;

	const AgentData* data = agent->getData();
	const AgentTarget* agentRule = data->findTarget(AgentTargetType::Agent);
	const AgentTarget* objectRule = data->findTarget(AgentTargetType::Object);
	if (!agentRule && !objectRule) return nullptr;

	const int32_t vision = data->vision;
	if (vision <= 0) return nullptr;

	// Which of the two outranks the other IS configurable, unlike the player
	// tier above them.
	const bool agentsFirst = !objectRule ||
	                         (agentRule && agentRule->priority >= objectRule->priority);

	// Already holding the best thing this sweep could offer: there is nothing to
	// look for, so the tile box is not worth building. This is the common case
	// for an agent that has latched a bot, and it keeps that agent off the sweep
	// entirely rather than merely discarding the result.
	if (current && (current->getAgent() != nullptr) == agentsFirst) return nullptr;

	const uint64_t now = OTSYS_TIME();
	const Position apos = agent->getPosition();
	// Content-derived margin, never a constant: a thing is filed under the tile
	// holding its CENTRE while its body reaches as far as the largest one
	// loaded, and a margin that is too small fails silently.
	const int32_t margin = vision / TILE_SIZE + Map::collisionScanTileMargin() + 1;
	const int32_t tx = apos.x / TILE_SIZE;
	const int32_t ty = apos.y / TILE_SIZE;
	agentTargetScratch.clear();
	map.getThingsInTileBox(tx - margin, ty - margin, tx + margin, ty + margin, agentTargetScratch);

	const int64_t visionSq = static_cast<int64_t>(vision) * vision;

	// Two passes rather than one comparison, because the tiers are strict: a
	// rival bot at the edge of sight still outranks a wall underfoot. Returning
	// as soon as the higher tier finds anything is also what keeps the object
	// pass off the clock in the common case.
	Thing* bestAgent = nullptr;
	int64_t bestAgentD2 = visionSq;
	Thing* bestObject = nullptr;
	// SCORE, not distance: the object tier is ranked by agentCrowdedDistSq, so a
	// wall the pack is already queued at loses to an emptier one a little
	// further off. Sight is still decided on the true distance below -- a
	// penalty must never smuggle something out of vision into range, nor a
	// crowded thing out of it.
	int64_t bestObjectScore = std::numeric_limits<int64_t>::max();

	for (Thing* thing : agentTargetScratch) {
		const bool isAgentThing = thing->getAgent() != nullptr;
		if (isAgentThing ? !agentRule : (thing->getObject() == nullptr || !objectRule)) continue;
		if (!isAgentHostileTo(agent, thing)) continue;
		if (agent->knownUnreachable(thing->getID(), now)) continue;

		const int64_t dx = static_cast<int64_t>(thing->getPosition().x) - apos.x;
		const int64_t dy = static_cast<int64_t>(thing->getPosition().y) - apos.y;
		const int64_t d2 = dx * dx + dy * dy;

		if (isAgentThing) {
			if (d2 <= bestAgentD2) {
				bestAgentD2 = d2;
				bestAgent = thing;
			}
		} else if (d2 <= visionSq) {
			const int64_t score = agentCrowdedDistSq(d2, thing, agent->getCollisionRadius());
			// STRICTLY better wins, so the FIRST thing found keeps a tie rather
			// than the last. `<=` handed every tie to whatever the tile sweep
			// happened to visit last, which is the highest-x tile in the box --
			// a systematic bias toward the right-hand wall of any base, applied
			// identically by every agent in the pack.
			if (score < bestObjectScore) {
				bestObjectScore = score;
				bestObject = thing;
			}
		}
	}

	// Reachability, on the winner of each tier in turn. Same rule as the player
	// pass: something that cannot be walked to is not a target, so an agent
	// never turns toward a rival bot sealed inside a building. A tier whose
	// winner fails falls through to the next one.
	const AgentAbility* melee = agent->getMeleeAbility();
	const float reachBase =
		(melee ? static_cast<float>(melee->range) : 0.0f) + agent->getCollisionRadius();

	auto acceptable = [&](Thing* candidate, const AgentTarget* rule) -> bool {
		if (!candidate) return false;
		if (!rule || !rule->pursue) return true; // it will never walk there anyway
		switch (canAgentReach(agent, candidate->getPosition(),
		                      reachBase + agentTargetExtent(candidate), true)) {
			case Reachable::Yes:
				return true;
			case Reachable::No:
				agent->noteUnreachable(candidate->getID(), now);
				return false;
			case Reachable::Unknown:
				return false; // try again on the next scan
		}
		return false;
	};

	Thing* first = agentsFirst ? bestAgent : bestObject;
	Thing* second = agentsFirst ? bestObject : bestAgent;
	const AgentTarget* firstRule = agentsFirst ? agentRule : objectRule;
	const AgentTarget* secondRule = agentsFirst ? objectRule : agentRule;

	if (acceptable(first, firstRule)) return first;
	// The lower tier is an ACQUISITION, never an upgrade: an agent holding a
	// wall reaches here only because no bot qualified, and swapping it for
	// another wall is exactly the goal-thrashing stickiness is for.
	if (!current && acceptable(second, secondRule)) return second;
	return nullptr;
}

// One swing, against a player, a rival bot or a building.
//
// The swing itself is identical for all three -- same animation, same damage
// roll -- so only the landing differs, and each kind already has a changeHealth
// that knows how to be hurt. NOTE: a lethal hit on an agent or an object begins
// its removal, so `target` must not be touched after the damage lands.
void Game::agentMeleeAttack(Agent* agent, Thing* target, const AgentAbility& melee)
{
	// A stunned agent does not swing. The same permission a stunned player is
	// refused in Player::updateActions -- one vocabulary for both, so a stun
	// grenade works on whatever it lands near.
	if (agent->cannot(CONTROL_NO_ATTACK)) return;

	const Position apos = agent->getPosition();
	const Position tpos = target->getPosition();

	float angle = std::atan2(static_cast<float>(tpos.y) - apos.y, static_cast<float>(tpos.x) - apos.x);
	if (angle < 0) angle += MATH_TWO_PI;

	int32_t dmg = static_cast<int32_t>(melee.damage.roll());

	// Landing a hit is a world monster declaring which side it is fighting, and
	// it is a better answer than its targetId: an agent swings at whatever is in
	// reach while walking somewhere else, and holds no target at all in the gap
	// between one being destroyed and the next being found. Recorded BEFORE the
	// damage, because a lethal hit begins the target's removal. See
	// Game::isAgentTargeting -- this is what a player's bots read to decide
	// whether a monster is their business.
	if (agent->getOwnerGuid() == 0) {
		agent->noteAggressionAgainst(ownerOfThing(target), OTSYS_TIME());
	}

	// The same moment answers a second question: is this agent actually getting
	// at the thing it committed to? Recorded here for the same reason and with
	// the same care -- before the damage, because a lethal hit begins the
	// target's removal. See Agent::noteTargetHit.
	if (target->getID() == agent->getTargetId()) {
		agent->noteTargetHit(static_cast<uint64_t>(OTSYS_TIME()));
	}

	Player* victim = target->getCreature() ? target->getCreature()->getPlayer() : nullptr;

	// Same immunity rules every other damage path applies at the call site
	// (Player::meleeAttack, Game::executeExplosion): the swing still plays, it
	// just does nothing. Player::changeHealth does not check these itself.
	if (victim && (victim->isGhostMode() || victim->isInvincible())) {
		dmg = 0;
	}

	// Play the agent's swing on clients (state bit 1, held a couple ticks).
	agent->triggerAttackPulse();
	EntityUpdate swing;
	agent->buildUpdate(swing);
	broadcastSurgicalUpdate(swing, apos);

	const uint8_t angleByte = static_cast<uint8_t>((angle * 255.0f) / MATH_TWO_PI);

	if (victim) {
		// attacker is null: an agent kill is not a PvP kill (no karma / self-defense).
		if (dmg > 0) {
			// The bite's own crit, if agents.xml gives it one. No attacker
			// player, so there is no condition-granted crit chance to add --
			// only what the ability itself declares.
			bool crit = false;
			const int32_t swing = rollOutgoingDamage(nullptr, -dmg, melee.hitEffects, crit);
			const int32_t dealt = victim->changeHealth(swing, true, false, false, "", nullptr);

			// What the BITE inflicts, from agents.xml. Gated on the damage
			// actually landing, which is why it reads the returned amount: a
			// swing that ghost mode, invincibility or armour absorbed must not
			// deliver a condition either, or immunity would stop the damage and
			// let the poison through.
			//
			// Attacker is null, so nothing leeches here unless a future agent
			// grows a way to be credited -- an agent has no gauges to refill.
			applyHitEffects(nullptr, victim, dealt, melee.hitEffects, crit);
		}
		broadcastPlayerHit(static_cast<uint8_t>(victim->getGUID()), angleByte, tpos, victim);
		if (melee.knockback > 0) {
			victim->applyKnockback(std::cos(angle) * melee.knockback * 1.5f,
			                       std::sin(angle) * melee.knockback * 1.5f);
		}
		return;
	}

	// Impact direction is 0..31 for the non-player hit paths, not 0..255.
	const uint8_t impactAngle31 = static_cast<uint8_t>((angle * 31.0f) / MATH_TWO_PI);

	if (Agent* other = target->getAgent()) {
		if (dmg > 0) {
			// A bot's kill pays its owner. XP is credited HERE, not by passing the
			// owner as `attacker` into changeHealth -- that would also provoke the
			// victim's whole type against the owner and retarget the victim onto
			// them (agentProvoked has no range gate), and the fight is the bot's,
			// not the owner's. Read before the hit; a lethal hit starts removal.
			const uint32_t victimXp = other->getData() ? other->getData()->experience : 0;
			// `other` stays valid after a lethal hit only because updateAgents
			// holds a reference on every agent for the length of the pass.
			other->changeHealth(-dmg, impactAngle31, nullptr, false, AgentDamageKind::Melee);
			if (other->isDying()) {
				if (victimXp > 0 && agent->getOwnerGuid() != 0) {
					if (Player* owner = getPlayerByGUID(agent->getOwnerGuid())) {
						owner->addXP(victimXp);
					}
				}
			} else {
				// Fight back. Only lands if it had nothing else, which is what
				// keeps two bots from handing each other around; see agentProvoked.
				agentProvoked(other, agent);
			}
		}
		if (melee.knockback > 0 && !other->isDying()) {
			other->applyKnockback(std::cos(angle) * melee.knockback * 1.5f,
			                      std::sin(angle) * melee.knockback * 1.5f);
		}
		return;
	}

	if (Object* obj = target->getObject()) {
		if (dmg > 0) {
			obj->changeHealth(-dmg, impactAngle31, nullptr);
		}
	}
}

// Would a body of `radius` centred at (px, py) overlap world geometry?
//
// The single passability predicate the agent AI plans with: the A* grid, the
// roam ray march and the roam destination picker all ask this one question, so
// none of them can quietly drift into being more optimistic than the others --
// and an optimistic planner is the whole family of "it walks into something and
// then stands there" bugs. Creatures are passed through, matching the movement
// layer, which resolves against world geometry only.
//
// The 3x3 neighbourhood, not the tile under the point: Map files a Thing under
// the single tile holding its centre, but its body reaches across boundaries.
// --- The map edge is a wall, and the planner has to know it -----------------
//
// stepAgent clamps every agent body to [radius, size - radius] every tick
// (clampToMapBounds, game.cpp), so the band within one body radius of the
// boundary is somewhere no agent can ever stand, and outside the map is
// somewhere no agent can ever go. Nothing in the search knew that: a tile was
// blocked only by the things standing IN it, so the void past the boundary read
// as perfectly open ground.
//
// That is one lie with two faces, and both were reported from play:
//
//   * a base built into a CORNER. A* routed around it through the void, so the
//     whole pack funnelled to the single wall that imaginary detour arrived at
//     -- and the ones behind stood in the boundary band, clamped, holding a
//     target the route said was reachable and their bodies could not approach.
//   * anything sheltered AGAINST the edge (a lapabot parked in the corner):
//     canAgentReach answered Yes off a route through the void, so it stayed a
//     target instead of being written off, and the agents never fell back to
//     the wall actually in front of them.
//
// Enforced with whatever radius the caller is testing with, which for the
// planner is the slightly inflated AGENT_PATH_RADIUS_MARGIN body. That errs
// strict, which is the standing rule here: the planner must never promise a
// step the mover will refuse.
static bool agentInsideMapBounds(float px, float py, float radius)
{
	const float maxX = static_cast<float>(MapSize::widthUnits()) - radius;
	const float maxY = static_cast<float>(MapSize::heightUnits()) - radius;
	return px >= radius && py >= radius && px <= maxX && py <= maxY;
}

// The same rule as a SURFACE rather than a veto, mirroring what stepAgent does
// to a real body: a step into the edge slides along it instead of being
// refused outright. Travelling THROUGH the edge is caught by the drift test in
// agentCanTraverse, exactly as it is for geometry.
static void agentClampToMapBounds(float& x, float& y, float radius)
{
	const float maxX = static_cast<float>(MapSize::widthUnits()) - radius;
	const float maxY = static_cast<float>(MapSize::heightUnits()) - radius;
	// max(): a body wider than the map would hand clamp() an inverted range.
	x = std::clamp(x, radius, std::max(radius, maxX));
	y = std::clamp(y, radius, std::max(radius, maxY));
}

static bool agentBodyBlockedAt(Map& map, float px, float py, float radius)
{
	if (!agentInsideMapBounds(px, py, radius)) return true;

	const int32_t tx = static_cast<int32_t>(px) / TILE_SIZE;
	const int32_t ty = static_cast<int32_t>(py) / TILE_SIZE;
	for (int32_t ox = -1; ox <= 1; ++ox) {
		for (int32_t oy = -1; oy <= 1; ++oy) {
			// findTile, not getTile: getTile allocates a permanent empty Tile for
			// every coordinate asked about, and planning probes a long way past
			// anything the agent will actually walk on.
			Tile* tile = map.findTile(tx + ox, ty + oy);
			if (!tile) continue;
			for (Thing* t : tile->getThings()) {
				if (t->getCreature() || !t->hasCollision()) continue;
				float ov = 0.0f, nx = 0.0f, ny = 0.0f;
				if (playerOverlapsObstacle(t, px, py, radius, ov, nx, ny)) return true;
			}
		}
	}
	return false;
}

// World geometry that could touch a body travelling from (ax, ay) to (bx, by),
// pre-filtered to things that actually block one (creatures are walked through,
// as everywhere else in this AI).
//
// The margin is content-derived, never a constant: an obstacle is filed under
// the tile holding its CENTRE but its body reaches as far as the largest one
// loaded, and a margin that is too small fails SILENTLY -- the planner simply
// does not see the rock it is routing through.
static void agentGatherBlockers(Map& map, float ax, float ay, float bx, float by, std::vector<Thing*>& out)
{
	const int32_t margin = Map::collisionScanTileMargin() + 1;
	const int32_t minTx = static_cast<int32_t>(std::min(ax, bx)) / TILE_SIZE - margin;
	const int32_t maxTx = static_cast<int32_t>(std::max(ax, bx)) / TILE_SIZE + margin;
	const int32_t minTy = static_cast<int32_t>(std::min(ay, by)) / TILE_SIZE - margin;
	const int32_t maxTy = static_cast<int32_t>(std::max(ay, by)) / TILE_SIZE + margin;

	out.clear();
	map.getThingsInTileBox(minTx, minTy, maxTx, maxTy, out);
	out.erase(std::remove_if(out.begin(), out.end(),
		[](Thing* t) { return t->getCreature() || !t->hasCollision(); }), out.end());
}

// Push a body of `radius` at (x, y) out of everything it overlaps and report
// whether it ends up clear without having been shoved further than `maxSlide`.
// Updates (x, y) to where it settled. `obstacles` comes from
// agentGatherBlockers, so it is already filtered.
//
// This is not an approximation of what stepAgent does to a moving agent -- it is
// the same computation, which is the point. A planner that models the mover
// cannot promise a spot the mover will refuse, nor refuse one the mover would
// glide into happily.
//
// The slide cap separates the two outcomes: gliding to the middle of a passage
// moves the body a little, being squirted out of a gap it does not fit moves it
// a lot.
static bool agentSettleBody(const std::vector<Thing*>& obstacles, float& x, float& y, float radius, float maxSlide)
{
	const float startX = x;
	const float startY = y;
	float overlap = 0.0f, nx = 0.0f, ny = 0.0f;

	// The map edge, before anything else and again after every push-out: it is a
	// surface like any other here, so a body shoved toward it lands ON it rather
	// than outside the world. Getting this order wrong would let a push-out put
	// the body past the boundary and then declare it clear, which is the void
	// route the search used to find.
	agentClampToMapBounds(x, y, radius);

	for (int iter = 0; iter < 4; ++iter) {
		bool displaced = false;
		for (Thing* obstacle : obstacles) {
			if (playerOverlapsObstacle(obstacle, x, y, radius, overlap, nx, ny)) {
				x += nx * overlap;
				y += ny * overlap;
				displaced = true;
			}
		}
		agentClampToMapBounds(x, y, radius);
		if (!displaced) break; // already clear; nothing to resolve
	}

	for (Thing* obstacle : obstacles) {
		if (playerOverlapsObstacle(obstacle, x, y, radius, overlap, nx, ny) && overlap > 0.01f) {
			// Still inside something after four passes: the two sides are pushing
			// it into each other, which is precisely a gap narrower than the body.
			return false;
		}
	}

	const float dx = x - startX;
	const float dy = y - startY;
	return dx * dx + dy * dy <= maxSlide * maxSlide;
}

// Can the agent's body actually travel from (ax, ay) to (bx, by)?
//
// Walks the body along the step and lets it glide, exactly as it will when it
// walks the route for real. Anything narrower than the body stops it; anything
// wider it slides through.
//
// THE BODY IS CARRIED FROM SAMPLE TO SAMPLE, not re-placed on the ideal line at
// each one, and that is the whole correctness property. Settling every sample
// independently asks "could a body rest near here", which is a different and
// much weaker question than "could a body travel through here" -- consecutive
// samples can settle on OPPOSITE SIDES of something impassable and both report
// success, so the sweep passes a step the mover can never make.
//
// Two full-tile walls placed corner to corner is the case that exposed it. A
// diagonal step between them puts one sample just short of the corner and the
// next just past it; each is pushed clear of the pair by less than the slide
// cap, in opposite directions, and the body teleports across a seam with zero
// gap in it. The agent then wedges in the corner re-planning the same
// impossible route, which is what "it thinks it can walk diagonally between two
// walls" looks like from outside.
//
// Carrying the body makes the sweep continuous, and the drift test is what
// turns "it got pushed back" into a refusal: a body shoved back to the same
// spot while the line walks away from it has not travelled anywhere, however
// clear each individual resting place was.
//
// One obstacle gather serves the whole step, and a step with nothing near it
// costs only that gather -- which is the case for most of any search.
static bool agentCanTraverse(Map& map, float ax, float ay, float bx, float by, float radius,
                             float maxSlide, std::vector<Thing*>& scratch)
{
	agentGatherBlockers(map, ax, ay, bx, by, scratch);
	// Nothing to collide with AND the step stays in the world: the two endpoints
	// settle it, because the legal region is a rectangle and a straight step
	// between two points inside one never leaves it. A step that DOES leave it
	// falls through to the sweep below, where the clamp in agentSettleBody holds
	// the body at the boundary and the drift test refuses the crossing -- the
	// same treatment a solid wall gets.
	if (scratch.empty() && agentInsideMapBounds(ax, ay, radius) && agentInsideMapBounds(bx, by, radius)) {
		return true;
	}

	const float dx = bx - ax;
	const float dy = by - ay;
	const float dist = std::sqrt(dx * dx + dy * dy);
	// Half a body radius, so consecutive body positions overlap and nothing can
	// hide between two samples.
	const int samples = std::max(1, static_cast<int>(dist / (radius * 0.5f)));
	const float stepX = dx / static_cast<float>(samples);
	const float stepY = dy / static_cast<float>(samples);

	float x = ax;
	float y = ay;
	if (!agentSettleBody(scratch, x, y, radius, maxSlide)) {
		return false;
	}

	for (int i = 1; i <= samples; ++i) {
		// Advance from where the body ACTUALLY is, by the step delta.
		x += stepX;
		y += stepY;
		if (!agentSettleBody(scratch, x, y, radius, maxSlide)) {
			return false;
		}

		// ...and it has to still be on the step it is supposed to be walking.
		const float t = static_cast<float>(i) / static_cast<float>(samples);
		const float offX = x - (ax + dx * t);
		const float offY = y - (ay + dy * t);
		if (offX * offX + offY * offY > maxSlide * maxSlide) {
			return false;
		}
	}
	return true;
}

bool Game::findAgentPath(const Position& start, const Position& goal, float agentRadius, std::vector<Position>& outPath)
{
	outPath.clear();
	const int32_t sx = start.x / TILE_SIZE, sy = start.y / TILE_SIZE;
	const int32_t gx = goal.x / TILE_SIZE, gy = goal.y / TILE_SIZE;
	if (sx == gx && sy == gy) return false;

	constexpr int32_t GRID = 1024; // key STRIDE only; tile coords fit in 0..654
	// The real edge of the world. Expansion stops here rather than at GRID: the
	// tiles past it are not merely empty, they are somewhere no body can ever
	// be, and letting the search walk them is what produced routes "around" a
	// corner base through the void. The sweep would refuse those steps anyway
	// (agentSettleBody clamps to the boundary), so this is the cheap half of the
	// same rule -- it keeps the expensive half from being asked at all.
	const int32_t tilesX = std::min<int32_t>(MapSize::tilesX(), GRID);
	const int32_t tilesY = std::min<int32_t>(MapSize::tilesY(), GRID);
	// Budget so a hard search cannot stall the tick. Halved from 800 when the
	// edge test became a body sweep rather than a point test: an expansion costs
	// more now, and it buys more, since a search that reads gaps correctly does
	// not have to explore its way around openings it wrongly refused. A chase
	// goal is inside `loseTarget` (10 tiles), which explores a small fraction of
	// this; anything that needs more is a detour the agent is better off
	// abandoning, and it falls back to walking straight and re-deciding.
	constexpr int32_t MAX_EXPANSIONS = 400;
	auto key = [](int32_t x, int32_t y) { return y * GRID + x; };

	// The graph must use the agent's TRUE body, never a shrunken one.
	//
	// Being generous with the RADIUS looks like it would open up tight corridors,
	// but it does the opposite: A* routes through a gap the body does not fit,
	// the movement layer refuses the step, the agent stalls, the stuck counter
	// fires, and A* returns the same impossible route again -- so the agent
	// stands in the mouth of the gap for as long as it wants to go that way. A
	// route the agent cannot walk is worse than no route: without one it at least
	// heads straight at the target and slides around what it meets.
	//
	// What the search does instead of being generous with the radius is stop
	// asking about points and start asking about travel: both tests below walk
	// this body along the step and let it glide, so a passage counts as open when
	// the body fits THROUGH it, wherever in it the room happens to be. Shrinking
	// the radius would invent clearance that exists nowhere; this finds clearance
	// that does exist but is not centred on a tile grid nobody laid the map out
	// on. Only the first is a lie.
	const float gridRadius = agentRadius * AGENT_PATH_RADIUS_MARGIN;

	// A node is the point in a tile where the agent's body actually SETTLES, not
	// the tile centre. Two things depend on carrying the point rather than a
	// bare yes/no:
	//
	//   * a tile whose centre is inside a rock can still have a gap crossing it,
	//     and refusing every such tile is what makes an agent walk the long way
	//     round an opening it fits through;
	//   * the route is emitted from these points, so a waypoint is always
	//     somewhere the agent can stand. Emitting the CENTRE of a tile that only
	//     passes off-centre would aim it straight at the rock.
	struct TileNode {
		bool blocked;
		float x, y;
	};
	std::unordered_map<int32_t, TileNode> nodeCache;
	auto nodeOf = [&](int32_t x, int32_t y) -> const TileNode& {
		const int32_t k = key(x, y);
		auto it = nodeCache.find(k);
		if (it != nodeCache.end()) return it->second;

		const float cx = static_cast<float>(x) * TILE_SIZE + TILE_SIZE * 0.5f;
		const float cy = static_cast<float>(y) * TILE_SIZE + TILE_SIZE * 0.5f;
		TileNode node{true, cx, cy};
		float sx2 = cx, sy2 = cy;
		agentGatherBlockers(map, cx, cy, cx, cy, agentPlanScratch);
		if (agentSettleBody(agentPlanScratch, sx2, sy2, gridRadius, AGENT_PATH_MAX_SLIDE)) {
			node.blocked = false;
			node.x = sx2;
			node.y = sy2;
		}
		// unordered_map keeps references valid across later inserts.
		return nodeCache.emplace(k, node).first->second;
	};

	// Both ends of a step being free does not mean the step between them is, and
	// neither does any single point along it. Two resources can sit either side
	// of a tile boundary leaving both nodes perfectly clear while the passage
	// between their surfaces is narrower than the agent -- that is the gap it
	// "thought it could fit through" and wedged in. Equally, a passage the agent
	// walks through fine is usually not centred on any point a tile grid would
	// have sampled.
	//
	// Both are answered by walking the body along the step and letting it glide,
	// which is what it will really do. Nothing else is a substitute: the width of
	// a gap is a property of the whole passage, not of any point in it.
	std::unordered_map<int32_t, bool> crossingCache;
	auto blockedCrossing = [&](int32_t x, int32_t y, int32_t tx, int32_t ty, int32_t dirIdx) -> bool {
		// Keyed on the unordered pair, so a crossing is not recomputed once per
		// direction of travel.
		const int32_t k = std::min(key(x, y), key(tx, ty)) * 4 + dirIdx;
		auto it = crossingCache.find(k);
		if (it != crossingCache.end()) return it->second;

		const TileNode& from = nodeOf(x, y);
		const TileNode& to = nodeOf(tx, ty);
		const bool b = !agentCanTraverse(map, from.x, from.y, to.x, to.y, gridRadius,
		                                 AGENT_PATH_MAX_SLIDE, agentPlanScratch);
		crossingCache[k] = b;
		return b;
	};

	// The two tiles whose node is known exactly rather than derived: the agent is
	// standing at `start`, and `goal` is where the target is. Seeding them means
	// the first step is swept from where the agent ACTUALLY is and the last one
	// to where the target ACTUALLY is -- up to half a tile out from the centres
	// otherwise, which is easily the difference between a gap being reachable
	// from here and not.
	nodeCache.emplace(key(sx, sy),
		TileNode{false, static_cast<float>(start.x), static_cast<float>(start.y)});
	nodeCache.emplace(key(gx, gy),
		TileNode{false, static_cast<float>(goal.x), static_cast<float>(goal.y)});

	auto heur = [&](int32_t x, int32_t y) -> int32_t {
		const int32_t dx = std::abs(x - gx), dy = std::abs(y - gy);
		return 10 * (dx + dy) - 6 * std::min(dx, dy); // octile (10 orthogonal / 14 diagonal)
	};

	struct OpenNode { int32_t f, x, y; };
	struct Cmp { bool operator()(const OpenNode& a, const OpenNode& b) const { return a.f > b.f; } };
	std::priority_queue<OpenNode, std::vector<OpenNode>, Cmp> open;
	std::unordered_map<int32_t, int32_t> gScore;
	std::unordered_map<int32_t, int32_t> cameFrom;
	std::unordered_set<int32_t> closed;

	gScore[key(sx, sy)] = 0;
	open.push({heur(sx, sy), sx, sy});

	static const int32_t DX[8] = {1, -1, 0, 0, 1, 1, -1, -1};
	static const int32_t DY[8] = {0, 0, 1, -1, 1, -1, 1, -1};

	bool found = false;
	int32_t expansions = 0;
	while (!open.empty() && expansions < MAX_EXPANSIONS) {
		const OpenNode cur = open.top();
		open.pop();
		const int32_t ck = key(cur.x, cur.y);
		if (closed.count(ck)) continue;
		closed.insert(ck);
		if (cur.x == gx && cur.y == gy) { found = true; break; }
		++expansions;
		const int32_t curG = gScore[ck];
		for (int i = 0; i < 8; ++i) {
			const int32_t nx = cur.x + DX[i], ny = cur.y + DY[i];
			if (nx < 0 || ny < 0 || nx >= tilesX || ny >= tilesY) continue;
			const bool isGoal = (nx == gx && ny == gy);
			if (!isGoal && nodeOf(nx, ny).blocked) continue;
			const bool diagonal = (i >= 4);

			// NO "no corner cutting" RULE HERE, deliberately. The usual grid
			// guard -- refuse a diagonal if either orthogonal neighbour is
			// blocked -- is what stopped an agent walking between two resources
			// standing side by side, which is the commonest gap on this map:
			// getting between them IS a diagonal step, and both of the tiles the
			// resources sit in are blocked, so the step was refused however wide
			// the gap was. The rule is a proxy for "can the body get through the
			// corner", and blockedCrossing below answers that question directly
			// by walking the body along the diagonal. A proxy that overrules the
			// real test only ever loses information.
			//
			// That argument only holds while the real test is actually right.
			// It was not: agentCanTraverse used to settle each sample of the
			// sweep independently, so a diagonal between two full-tile walls
			// touching at a corner passed -- one sample settled on each side of
			// a seam with no gap in it. The sweep is continuous now, so it
			// rejects that corner while still admitting a real gap between two
			// rocks. Do NOT "fix" a future diagonal complaint by adding the
			// proxy rule here; fix the sweep.

			// The crossing itself must admit the body, not just the two ends.
			// Exempted for the goal tile, which is exempt from the node test too:
			// the goal is wherever the target happens to be standing, and
			// refusing to plan a route to a player pressed against a rock would
			// be worse than planning one that ends a body-width short.
			if (!isGoal) {
				const int32_t dirIdx = (DY[i] == 0) ? 0 : (DX[i] == 0 ? 1 : (DX[i] == DY[i] ? 2 : 3));
				if (blockedCrossing(cur.x, cur.y, nx, ny, dirIdx)) continue;
			}
			const int32_t ng = curG + (diagonal ? 14 : 10);
			const int32_t nk = key(nx, ny);
			auto it = gScore.find(nk);
			if (it == gScore.end() || ng < it->second) {
				gScore[nk] = ng;
				cameFrom[nk] = ck;
				open.push({ng + heur(nx, ny), nx, ny});
			}
		}
	}

	if (!found) {
		if (g_agentDebug) {
			fmt::print("[APATH] FAIL start=({},{}) goal=({},{}) expansions={} openEmpty={}\n",
				sx, sy, gx, gy, expansions, open.empty() ? 1 : 0);
		}
		return false;
	}

	// Reconstruct goal -> start, then reverse into start..goal order (start tile
	// excluded -- the agent is already there). Waypoints are the per-tile free
	// points, not raw centres, so every one of them is somewhere the body fits.
	std::vector<Position> rev;
	int32_t ck = key(gx, gy);
	const int32_t startK = key(sx, sy);
	while (ck != startK) {
		const TileNode& node = nodeOf(ck % GRID, ck / GRID);
		rev.push_back(clampPositionToMap(static_cast<int32_t>(std::lround(node.x)),
		                                 static_cast<int32_t>(std::lround(node.y))));
		auto it = cameFrom.find(ck);
		if (it == cameFrom.end()) return false; // broken chain (shouldn't happen)
		ck = it->second;
	}
	outPath.assign(rev.rbegin(), rev.rend());

	// String-pull the route. A* returns one waypoint per tile, so the raw path
	// zig-zags between cell points even in the open. Smoothing keeps only the
	// waypoints the agent cannot walk straight past, which is what turns a
	// staircase of tile steps into the direct line a player would take.
	//
	// Smoothed with the SAME glide model the steps were tested with -- not a
	// strict line of sight. A strict test refuses to straighten anything that
	// passes near geometry, so precisely the routes that matter (the ones
	// threading a gap) kept every tile-by-tile kink, and the agent walked a
	// visible staircase through an opening it could have crossed in one line.
	// Greedy forward scan: O(waypoints) sweeps, once per search.
	if (outPath.size() > 1) {
		agentPathSmoothScratch.clear();
		Position from = start;
		size_t i = 0;
		while (i < outPath.size()) {
			size_t j = i;
			while (j + 1 < outPath.size() &&
			       agentCanTraverse(map, static_cast<float>(from.x), static_cast<float>(from.y),
			                        static_cast<float>(outPath[j + 1].x), static_cast<float>(outPath[j + 1].y),
			                        gridRadius, AGENT_PATH_MAX_SLIDE, agentPlanScratch)) {
				++j;
			}
			agentPathSmoothScratch.push_back(outPath[j]);
			from = outPath[j];
			i = j + 1;
		}
		outPath.swap(agentPathSmoothScratch);
	}

	return !outPath.empty();
}

float Game::agentClearRun(const Position& from, float dirX, float dirY, float radius, float maxDist)
{
	// Half a tile per sample: comfortably under a body diameter, so nothing
	// narrower than the agent can be stepped over between two samples.
	const float step = TILE_SIZE * 0.5f;

	// Stay a tile clear of the map edge, the same inset isSpawnPositionValid
	// keeps. stepAgent clamps the body to [radius, map - radius], so a goal any
	// closer to the boundary than that can never be arrived at -- the agent
	// walks into the edge and leans on it for the rest of the leg. This is the
	// half of the old roaming stalls that had no obstacle involved at all.
	const float inset = static_cast<float>(TILE_SIZE);
	const float mapW = static_cast<float>(MapSize::widthUnits());
	const float mapH = static_cast<float>(MapSize::heightUnits());

	for (float d = step; d <= maxDist; d += step) {
		const float px = static_cast<float>(from.x) + dirX * d;
		const float py = static_cast<float>(from.y) + dirY * d;
		if (px < inset || py < inset || px > mapW - inset || py > mapH - inset) {
			return d - step;
		}
		if (agentBodyBlockedAt(map, px, py, radius)) {
			return d - step;
		}
	}
	return maxDist;
}

bool Game::agentChase(Agent* agent, const Position& targetPos, uint16_t speed, bool allowPathfinding)
{
	// Half a tile diagonal. At the old 45px an agent that had been deflected off
	// the direct line -- by a wall slide, separation or knockback -- could pass
	// a tile centre wide of it, never register it as reached, and TURN AROUND to
	// go collect it before carrying on. That is the "walks up, changes its mind,
	// retreats, tries again" loop, and it happens with a perfectly still player.
	constexpr int64_t WAYPOINT_REACHED_SQ = 72 * 72;
	// Abandon a committed route once the goal has wandered this far off its end.
	constexpr int64_t REPATH_DRIFT_SQ = (2 * TILE_SIZE) * (2 * TILE_SIZE);
	// Floor on how often ONE agent may search. Stops an agent that cannot find a
	// route from re-searching every tick.
	constexpr uint32_t REPATH_INTERVAL_MS = 400;

	const Position apos = agent->getPosition();
	const uint64_t now = OTSYS_TIME();
	auto distSq = [](const Position& a, const Position& b) -> int64_t {
		int64_t dx = static_cast<int64_t>(a.x) - b.x, dy = static_cast<int64_t>(a.y) - b.y;
		return dx * dx + dy * dy;
	};

	// --- Route policy: walk STRAIGHT, and pathfind only once that has stalled.
	//
	// The previous policy picked a mode from the geometry (line-of-sight clear ->
	// straight, else A*) on a timer. Two things went wrong with that. The test
	// flips as the agent shifts a few pixels near an obstacle, so the mode
	// alternated; and because an A* leg can point sideways or backwards relative
	// to the target, alternating modes is directly visible as the agent walking
	// at the player, then away, then at them again.
	//
	// Progress is a latched signal instead: it takes AGENT_STUCK_TICKS of
	// genuinely getting no closer to commit to a route, and once committed the
	// route is followed until it is consumed, the goal leaves it, or following
	// it stalls too.
	bool hasRoute = agent->pathIndex < agent->path.size();

	// False once this goal is judged not to be working; see the header comment.
	bool working = true;

	if (hasRoute && distSq(agent->path.back(), targetPos) > REPATH_DRIFT_SQ) {
		agent->clearPath();
		agent->resetStuck();
		hasRoute = false;
	}

	if (hasRoute) {
		// Advance past every waypoint already reached OR already passed. The
		// second test is what stops the backtracking: if we are nearer to the
		// NEXT waypoint than this one is, this one is behind us and walking back
		// to it would be pure regression.
		bool advanced = false;
		while (agent->pathIndex < agent->path.size()) {
			const Position& wp = agent->path[agent->pathIndex];
			if (distSq(apos, wp) < WAYPOINT_REACHED_SQ) {
				++agent->pathIndex;
				advanced = true;
				continue;
			}
			if (agent->pathIndex + 1 < agent->path.size()) {
				const Position& next = agent->path[agent->pathIndex + 1];
				if (distSq(apos, next) < distSq(wp, next)) {
					++agent->pathIndex;
					advanced = true;
					continue;
				}
			}
			break;
		}
		// Collecting a waypoint IS progress, and the measurement below is about
		// to start comparing against a different point.
		if (advanced) {
			agent->resetStuck();
		}
		hasRoute = agent->pathIndex < agent->path.size();
		if (!hasRoute) {
			// Route consumed: back to walking straight at the target.
			agent->clearPath();
			agent->resetStuck();
		}
	}

	// The point stepAgent is actually aimed at this tick.
	Position aim = hasRoute ? agent->path[agent->pathIndex] : targetPos;

	// --- Progress, measured against the AIM POINT --------------------------
	//
	// Against the aim point, NOT the final goal. Measuring against the goal is
	// only meaningful while walking straight at it -- a route legitimately walks
	// away from the goal to round an obstacle -- which is why this used to be
	// skipped entirely whenever a route was active. The cost of skipping it was
	// that an agent wedged ON a route was never noticed: nothing reset the route
	// and nothing re-planned, so it stood at that waypoint indefinitely. A chase
	// eventually escapes by itself because the player moves and drags the goal
	// off the end of the route, but a wander goal is a fixed point and nothing
	// rescued it short of the leg deadline. A leg of a route is straight by
	// construction (they are string-pulled through clear line of sight), so
	// distance to the current waypoint is a sound progress measure for both
	// modes and one counter now covers them.
	constexpr int64_t GOAL_JUMP_SQ = (3 * TILE_SIZE) * (3 * TILE_SIZE);
	if (agent->getLastGoalDist() >= 0 && distSq(agent->getLastGoalPos(), aim) > GOAL_JUMP_SQ) {
		// The aim JUMPED -- target lost and it turned for home, it acquired
		// someone new, or a fresh route put a waypoint somewhere else entirely.
		// Progress measured against the old point says nothing about this one,
		// and would otherwise read as a stalled approach.
		agent->resetStuck();
	}
	agent->setLastGoalPos(aim);

	const int32_t aimDist = static_cast<int32_t>(std::sqrt(static_cast<double>(distSq(apos, aim))));
	const int32_t previous = agent->getLastGoalDist();
	if (previous < 0 || aimDist < previous) {
		agent->setStuckTicks(0);
	} else {
		agent->setStuckTicks(agent->getStuckTicks() + 1);
	}
	agent->setLastGoalDist(aimDist);

	// --- Look ahead before walking into something --------------------------
	//
	// Straight-line chasing is the right default -- it is smooth, and it is
	// free -- but waiting for the stuck counter means the agent walks THROUGH
	// the decision: it presses into the obstacle for AGENT_STUCK_TICKS before it
	// will consider going round, which from outside looks exactly like it
	// believed it could fit and then changed its mind. One short ray down the
	// line it is about to walk answers that before it commits.
	//
	// This is a repath TRIGGER, not a mode switch, and the difference is what
	// keeps it from flapping. It can only cause a route to be searched; a route,
	// once found, is committed to until it is consumed, drifts or stalls.
	// Choosing per tick between "walk straight" and "follow a route" from a
	// geometry test is what used to make an agent alternate between advancing
	// and retreating near an obstacle -- an A* leg can point sideways, so the
	// flip itself was visible as the walk-toward/walk-away.
	//
	// Throttled on the repath window, since a search is the only thing it can
	// lead to, and measured with the TRUE body radius: the question here is
	// whether the agent is about to bump into something, not whether a planner
	// would route through it.
	const bool mayRedecide = now >= agent->getNextRepathAt();
	bool blockedAhead = false;
	if (mayRedecide && !hasRoute && aimDist > 1) {
		const float invDist = 1.0f / static_cast<float>(aimDist);
		const float ahead = std::min(static_cast<float>(aimDist), AGENT_LOOKAHEAD);
		const float run = agentClearRun(apos, (static_cast<float>(aim.x) - apos.x) * invDist,
		                                      (static_cast<float>(aim.y) - apos.y) * invDist,
		                                agent->getCollisionRadius(), ahead);
		blockedAhead = run < ahead - 1.0f;
	}

	if (agent->getStuckTicks() >= AGENT_STUCK_TICKS || blockedAhead) {
		if (hasRoute) {
			// Stalled while following a route it should have been able to walk:
			// something arrived after the search (a structure went up, a door
			// closed, a pile of agents) or the push-out has it pinned. Drop the
			// route and report the goal as not working -- re-searching from here
			// would most likely hand back the same blocked legs.
			agent->clearPath();
			agent->resetStuck();
			hasRoute = false;
			aim = targetPos;
			working = false;
		} else if (!allowPathfinding) {
			// The caller does its own navigating; just tell it this is not
			// working, and hold off on being asked again for a while.
			agent->setNextRepathAt(now + REPATH_INTERVAL_MS);
			agent->resetStuck();
			working = false;
		} else if (mayRedecide && agentPathBudget > 0) {
			// Staggered by id so a pack never all searches on the same tick.
			agent->setNextRepathAt(now + REPATH_INTERVAL_MS + (agent->getID() % 8) * 10);
			--agentPathBudget;
			if (findAgentPath(apos, targetPos, agent->getCollisionRadius(), agent->path)) {
				agent->pathIndex = 0;
				if (agent->pathIndex < agent->path.size()) {
					aim = agent->path[agent->pathIndex];
				}
			} else {
				// Straight is stalled and there is no way round: as far as this
				// agent can tell the goal is unreachable from here.
				agent->clearPath();
				working = false;
			}
			// Fresh window either way: on success the route takes over, on
			// failure we do not want to re-search on the very next tick.
			agent->resetStuck();
		}
	}

	stepAgent(agent, aim, speed);
	return working;
}

// "It just stands there." Called once per tick by a CHASING agent, after it has
// moved, and it gives up on the target when the agent has neither left the spot
// nor landed a hit for AGENT_STALL_MS. Returns true if it gave up.
//
// Displacement is the signal, and picking it took two wrong turns worth
// recording. Reachability cannot answer this: creatures are transparent to the
// planner on purpose (a body yields, so routing around one would have the whole
// pack re-planning every time it shuffled), so a doorway plugged by another
// ghoul is "reachable" by every measure the search has, every scan, forever.
// Counting agentChase's "goal not working" verdicts cannot either: that signal
// OSCILLATES -- stuck, search, route found (verdict good), route stalls (verdict
// bad), search again -- so a consecutive count never accumulates past one. Where
// the agent physically IS does not oscillate.
//
// The two states that look identical from outside and are perfectly healthy are
// both excluded, and both exclusions are load-bearing:
//   * chasing someone who is running away -- the agent MOVES, so the clock keeps
//     restarting;
//   * demolishing a wall -- the agent does NOT move and cannot: its aim is the
//     ring slot it is already standing on, and a square wall never satisfies the
//     contact threshold (agentTargetExtent reports the half-extent and
//     closeDistance sits inside it), so a wall-chewer lives in the chase branch
//     making no progress by construction. What separates it from the ghoul
//     queued behind it is that it is LANDING HITS.
bool Game::noteAgentStall(Agent* agent, uint32_t targetId, uint64_t now)
{
	const Position apos = agent->getPosition();

	auto movedFar = [&] {
		const Position& anchor = agent->getStallAnchor();
		const int64_t dx = static_cast<int64_t>(apos.x) - anchor.x;
		const int64_t dy = static_cast<int64_t>(apos.y) - anchor.y;
		return dx * dx + dy * dy >
		       static_cast<int64_t>(AGENT_STALL_MOVE_MIN) * static_cast<int64_t>(AGENT_STALL_MOVE_MIN);
	};

	if (agent->getStallSince() == 0 || movedFar() ||
	    now - agent->getLastTargetHitAt() < AGENT_TARGET_ENGAGED_MS) {
		agent->resetStall(apos, now);
		return false;
	}

	if (now - agent->getStallSince() < AGENT_STALL_MS) return false;

	// Written off. The window is the same whether the target moves or not: this
	// verdict is about a physical blockage rather than about the target, and a
	// blockage does not clear in the four seconds AGENT_UNREACHABLE_MOVER_MS
	// allows a player to walk out of a building.
	agent->noteUnreachable(targetId, now, AGENT_UNREACHABLE_CROWD_MS);
	agent->setTargetId(0); // also clears the hit record and this clock
	agent->resetTargetVelocity();
	agent->clearPath();
	agent->resetStuck();
	// Re-scan on the next tick rather than up to a second later. The sweep is
	// throttled because walls do not move; this agent has just learned something
	// none of them had to move for, and standing idle waiting out the throttle
	// is the behaviour being fixed. Normally it turns straight onto whatever is
	// blocking it, which for a base assault is the wall in front of its face.
	agent->setNextTargetScanAt(0);
	return true;
}

// --- Repair brain -----------------------------------------------------------
//
// A repair bot is a guard with a job. It stands still until something on its
// owner's side is damaged, walks to the first such thing it commits to, mends it
// until it is whole, and swings at anything hostile that comes within reach on
// the way -- without ever giving up the job to chase.

void Game::agentIdle(Agent* agent, const Position& apos)
{
	agent->clearPath();
	agent->resetStuck();

	// An agent with nothing to do and no impulse left to spend does not run the
	// movement pass AT ALL. stepAgent collects its neighbourhood every call,
	// which is O(things nearby) per agent per tick -- quadratic across a pile --
	// and a hundred idle bots stacked on one spot is exactly the case this
	// exists for. Skipping is safe rather than an approximation: stepAgent with
	// a zero goal and no recoil leaves the position and the wire speed exactly
	// as they already are.
	//
	// SEPARATION is the exception to that, and it is why this early-out used to
	// never fire for a parked bot with a neighbour: a zero-goal step still
	// carries a separation push, which keeps the wire speed non-zero, which
	// keeps this from firing, which lets the next push land. An agent on its
	// post no longer separates at all (Agent::isOnPost), so it now settles to a
	// zero step and drops out of the pass for good.
	//
	// getSpeed() is the WIRE speed the last step reported, so an agent that has
	// just stopped still runs one final step to settle it to zero.
	//
	// A DODGE is the other thing a settled agent can still owe: it has no goal,
	// no recoil and no wire speed, and the sidestep is the entire motion. The
	// clock read is behind the cheap tests on purpose -- by the time it is
	// reached the agent is already known to be standing still, which is the
	// case this early-out exists for.
	if (agent->getRecoilX() == 0.0f && agent->getRecoilY() == 0.0f && agent->getSpeed() == 0 &&
	    !agent->isDodging(static_cast<uint64_t>(OTSYS_TIME()))) {
		return;
	}
	stepAgent(agent, apos, 0);
}

bool Game::isSameOwnerSide(uint32_t guidA, uint32_t guidB) const
{
	// An unowned side is not a side: a world-spawned bot has nobody to defend,
	// and a world-generated object is nobody's property to repair.
	if (guidA == 0 || guidB == 0) return false;
	if (guidA == guidB) return true;

	for (const auto& [id, clan] : clans) {
		if (clan.members.find(guidA) != clan.members.end() &&
		    clan.members.find(guidB) != clan.members.end()) {
			return true;
		}
	}
	return false;
}

bool Game::isRepairableBy(const Agent* agent, const Object* obj) const
{
	if (!obj || obj->isDestroyed) return false;

	const ObjectData* od = obj->getData();
	if (!od || obj->getMaxHealth() == 0 || obj->getHealth() >= obj->getMaxHealth()) return false;

	// Never repair the sprung trap this bot is STANDING IN. It is currently
	// allowed -- told -- to destroy it (see the self-preservation rule in
	// isAgentHostileTo), and its repair pulse (30) beats its own chewing
	// (10-18), so mending it would hold the trap alive under its own feet
	// while it bleeds. Off the tile, the trap is an ordinary repair job again.
	if (isTrapPinningAgent(agent, obj)) return false;

	return isSameOwnerSide(agent->getOwnerGuid(), obj->getOwnerPid());
}

Object* Game::resolveRepairTarget(Agent* agent)
{
	const uint32_t id = agent->getRepairTargetId();
	if (id == 0) return nullptr;

	Object* obj = nullptr;
	if (Thing* t = map.getThingByID(id)) {
		obj = t->getObject();
	}

	if (isRepairableBy(agent, obj)) {
		// Dropped only if the bot somehow ended up far outside the range it
		// could have acquired the job from -- knocked back, or the job was
		// handed to it. Uses the same wider give-up range player targets use, so
		// a bot cannot lose a job it is standing next to.
		const AgentData* data = agent->getData();
		const int64_t dx = static_cast<int64_t>(obj->getPosition().x) - agent->getPosition().x;
		const int64_t dy = static_cast<int64_t>(obj->getPosition().y) - agent->getPosition().y;
		const int64_t loseRange = static_cast<int64_t>(data->loseTargetRange());
		if (dx * dx + dy * dy <= loseRange * loseRange) {
			return obj;
		}
	}

	agent->abandonRepairJob(0, false);
	return nullptr;
}

Game::Reachable Game::canAgentReach(Agent* agent, const Position& goal, float reach, bool keepRoute)
{
	const Position apos = agent->getPosition();
	const float dx = static_cast<float>(goal.x) - apos.x;
	const float dy = static_cast<float>(goal.y) - apos.y;
	const float dist = std::sqrt(dx * dx + dy * dy);

	// Standing in it already.
	if (dist <= reach) return Reachable::Yes;

	// A clear straight run is the common answer inside a base, and it costs one
	// ray instead of a search. Only has to be clear up to `reach` short of the
	// goal, since that is where the agent stops.
	const float need = dist - reach;
	const float invDist = 1.0f / dist;
	if (agentClearRun(apos, dx * invDist, dy * invDist, agent->getCollisionRadius(), need) >= need - 1.0f) {
		if (keepRoute) agent->clearPath();
		return Reachable::Yes;
	}

	// Something is in the way, so the only honest answer is whether a route
	// exists. Shares the per-tick A* budget with chasing; out of budget means
	// UNKNOWN, and the caller waits rather than condemning the target.
	if (agentPathBudget <= 0) return Reachable::Unknown;
	--agentPathBudget;

	// The route is the useful by-product: a target selected this way arrives
	// with its path already planned, so proving reachability costs nothing extra
	// over the search agentChase would have run on the next stall.
	if (findAgentPath(apos, goal, agent->getCollisionRadius(), agent->path)) {
		if (keepRoute) {
			agent->pathIndex = 0;
		} else {
			agent->clearPath();
		}
		return Reachable::Yes;
	}

	agent->clearPath();
	return Reachable::No;
}

Object* Game::findRepairJob(Agent* agent)
{
	// The registry is normally empty, and that is the point: this is the whole
	// cost of an idle repair bot. Sweeping tiles for `vision` instead would be a
	// 15x15 tile box per bot per tick to answer "no".
	if (damagedObjects.empty()) return nullptr;

	// Reachability is the expensive part of selection, so selection is throttled
	// and staggered by id rather than run every tick by every bot.
	const uint64_t now = OTSYS_TIME();
	if (now < agent->getNextJobScanAt()) return nullptr;
	agent->setNextJobScanAt(now + AGENT_JOB_SCAN_MS + (agent->getID() % 16) * 25);

	const AgentData* data = agent->getData();
	const Position apos = agent->getPosition();
	const int64_t visionSq = static_cast<int64_t>(data->vision) * data->vision;

	// Candidates first, nearest last so the cheapest pop is the best one. Two
	// passes rather than one, because the reachability test must run in distance
	// order and only until something passes -- testing every candidate would
	// spend the A* budget proving things the bot was never going to walk to.
	struct Candidate {
		Object* obj;
		int64_t d2;
	};
	std::vector<Candidate> candidates;

	// Ids whose object has gone without passing through finishDestruction. The
	// registry is self-healing rather than trusted; erasing inside the loop
	// would invalidate the iterator.
	std::vector<uint32_t> stale;

	for (uint32_t id : damagedObjects) {
		Thing* t = map.getThingByID(id);
		Object* obj = t ? t->getObject() : nullptr;
		if (!obj) {
			stale.push_back(id);
			continue;
		}
		if (!isRepairableBy(agent, obj)) continue;
		if (agent->knownUnreachable(id, now)) continue;

		const int64_t dx = static_cast<int64_t>(obj->getPosition().x) - apos.x;
		const int64_t dy = static_cast<int64_t>(obj->getPosition().y) - apos.y;
		const int64_t d2 = dx * dx + dy * dy;
		if (d2 <= visionSq) {
			candidates.push_back({obj, d2});
		}
	}

	for (uint32_t id : stale) {
		damagedObjects.erase(id);
	}
	if (candidates.empty()) return nullptr;

	std::sort(candidates.begin(), candidates.end(),
	          [](const Candidate& a, const Candidate& b) { return a.d2 < b.d2; });

	const AgentAbility* repair = data->findAbility(AgentAbilityType::Repair);
	const float baseReach = (repair ? static_cast<float>(repair->range) : 0.0f) +
	                        agent->getCollisionRadius();

	for (const Candidate& c : candidates) {
		const float reach = baseReach + objectReachExtent(c.obj);
		switch (canAgentReach(agent, c.obj->getPosition(), reach, true)) {
			case Reachable::Yes:
				agent->setRepairTargetId(c.obj->getID());
				agent->setRepairDeadline(now + AGENT_JOB_TIMEOUT_MS);
				return c.obj;
			case Reachable::No:
				// Not a target at all. Remembered so the next scan does not pay
				// to prove the same wall again.
				agent->noteUnreachable(c.obj->getID(), now);
				continue;
			case Reachable::Unknown:
				// Budget spent. Decide nothing -- neither select it nor condemn
				// it -- and try again on the next scan.
				return nullptr;
		}
	}
	return nullptr;
}

void Game::agentRepairObject(Agent* agent, Object* obj, const AgentAbility& ability)
{
	// Free and unlimited: the bot itself is the cost, and it repairs for as long
	// as it is alive. changeHealth already clamps to healthMax, broadcasts the
	// pulse, and takes the object back out of the damaged registry when it is
	// whole again.
	obj->changeHealth(static_cast<int32_t>(ability.amount), 0, nullptr);

	// The client has exactly one action animation for a type-13 entity, so a
	// repair swing and a melee swing look the same. Held a couple of ticks like
	// every other pulse (see Agent::triggerAttackPulse).
	agent->triggerAttackPulse();
	EntityUpdate swing;
	agent->buildUpdate(swing);
	broadcastSurgicalUpdate(swing, agent->getPosition());

	// Landing a repair is proof the job is working, so the arrival backstop is
	// pushed out rather than left to expire mid-job.
	agent->setRepairDeadline(OTSYS_TIME() + AGENT_JOB_TIMEOUT_MS);

	const ObjectData* od = obj->getData();
	if (od && obj->getHealth() >= obj->getMaxHealth()) {
		agent->abandonRepairJob(0, false); // whole again: look for new work
	}
}

Thing* Game::findHostileInReach(Agent* agent, const AgentAbility& ability)
{
	const Position apos = agent->getPosition();
	const float reach = static_cast<float>(ability.range) + agent->getCollisionRadius();

	// Tile-local. Melee reach is well under a tile, so the 3x3 neighbourhood
	// covers it and this never walks the player table -- which at 255 players
	// times a base full of bots would be the most expensive thing in the tick.
	const int32_t cx = static_cast<int32_t>(apos.x) / TILE_SIZE;
	const int32_t cy = static_cast<int32_t>(apos.y) / TILE_SIZE;

	Thing* best = nullptr;
	float bestD2 = 0.0f;

	for (int32_t dx = -1; dx <= 1; ++dx) {
		for (int32_t dy = -1; dy <= 1; ++dy) {
			Tile* tile = map.findTile(cx + dx, cy + dy);
			if (!tile) continue;

			for (Thing* t : tile->getThings()) {
				if (!isAgentHostileTo(agent, t)) continue;

				const float ex = static_cast<float>(t->getPosition().x) - apos.x;
				const float ey = static_cast<float>(t->getPosition().y) - apos.y;
				const float d2 = ex * ex + ey * ey;
				const float hit = reach + agentTargetExtent(t);
				if (d2 > hit * hit) continue;

				if (!best || d2 < bestD2) {
					best = t;
					bestD2 = d2;
				}
			}
		}
	}
	return best;
}

Thing* Game::agentTrySwing(Agent* agent, const AgentAbility& melee, uint64_t now, Thing* preferred, bool face)
{
	if (now < agent->getNextAttackAt()) return nullptr;

	Thing* victim = preferred ? preferred : findHostileInReach(agent, melee);
	if (!victim) return nullptr;

	if (face) {
		const Position apos = agent->getPosition();
		faceAgentToward(agent, static_cast<float>(victim->getPosition().x) - apos.x,
		                static_cast<float>(victim->getPosition().y) - apos.y);
	}
	agentMeleeAttack(agent, victim, melee);
	agent->setNextAttackAt(now + melee.cooldownMs);
	return victim;
}

void Game::runRepairBrain(Agent* agent)
{
	const AgentData* data = agent->getData();
	const Position apos = agent->getPosition();
	const uint64_t now = OTSYS_TIME();

	// A repair bot holds a spot rather than a formation, so it never encircles
	// anything.
	agent->clearSpreadAnchor();
	agent->setHolding(false);

	// It is standing where it needs to stand -- parked with no work, or pressed
	// up against the thing it is mending -- so separation must not walk it off,
	// exactly as for a guard on its post. Cleared below only for the walk TO a
	// job, which is the one leg where spreading is still wanted.
	agent->setOnPost(true);

	// --- 1. Hit whatever hostile is already in reach ------------------------
	//
	// This does NOT cost the repair job, and that is the whole design: the swing
	// knocks the target back out of reach, the bot returns to work on the same
	// tick, and anything that steps in again gets hit again. The rhythm comes out
	// of the knockback, so there is no aggro state to enter or leave and nothing
	// to thrash. What counts as hostile is the <target> list -- drop the player
	// entry and it will not hit players, drop the agent entry and it will not
	// defend itself against rival bots or ghouls.
	if (const AgentAbility* melee = agent->getMeleeAbility()) {
		// face=true: this brain faces its JOB the rest of the tick, so the swing
		// must turn it toward the victim itself.
		agentTrySwing(agent, *melee, now, nullptr, true);
	}

	// --- 2. The job ---------------------------------------------------------
	const AgentTarget* jobTarget = data->findTarget(AgentTargetType::DamagedObject);
	const AgentAbility* repair = data->findAbility(AgentAbilityType::Repair);
	if (!jobTarget || !repair) {
		agentIdle(agent, apos); // no repair ability or not interested: just a guard
		return;
	}

	Object* job = resolveRepairTarget(agent);
	if (!job) {
		job = findRepairJob(agent);
	}
	if (!job) {
		agentIdle(agent, apos);
		return;
	}

	const Position opos = job->getPosition();
	const int64_t dx = static_cast<int64_t>(opos.x) - apos.x;
	const int64_t dy = static_cast<int64_t>(opos.y) - apos.y;
	const int64_t d2 = dx * dx + dy * dy;

	const float reach = static_cast<float>(repair->range) + agent->getCollisionRadius() +
	                    objectReachExtent(job);

	if (d2 > 16 * 16) {
		faceAgentToward(agent, static_cast<float>(dx), static_cast<float>(dy));
	}

	if (static_cast<float>(d2) <= reach * reach) {
		if (now >= agent->getNextRepairAt()) {
			agentRepairObject(agent, job, *repair);
			agent->setNextRepairAt(now + repair->cooldownMs);
		}
		agentIdle(agent, apos);
	} else if (jobTarget->pursue) {
		// Walking, not posted: bots converging on the same wreck should still
		// spread rather than queue up on one point.
		agent->setOnPost(false);

		// Walks to the job using the same chase/pathfinding stack the aggressive
		// brain uses, which already takes a plain Position goal. A building does
		// not move, so this is the easy case for it: no lead, no ring slot, and
		// the goal never jitters.
		//
		// The job was proved reachable before it was taken, so a refusal here
		// means the world changed under it -- somebody walled the way off while
		// it was walking. That is the one case selection cannot pre-empt, so it
		// is the one case handled by recovery: drop the job and remember it, or
		// the next scan walks straight back into it.
		if (!agentChase(agent, opos, agent->getMoveSpeed())) {
			agent->abandonRepairJob(now, true);
		} else if (now >= agent->getRepairDeadline()) {
			// Still not arrived long after it should have. Nothing has reported
			// a failure, so this is the catch-all: a route it keeps almost
			// walking, a crowd it cannot push through, an A* budget it never
			// wins. Bounded either way.
			agent->abandonRepairJob(now, true);
		}
	} else {
		agentIdle(agent, apos);
	}
}

// The per-tick engaged-agent dump behind !agent-debug. Written to a FILE
// (complete, ordered -- the console dropped ~90% of lines under load).
// pre/post are exactly the startX/endX this tick's wire update carries;
// `moved` is how far the agent actually went this tick.
static void logEngagedAgent(const Agent* agent, const Position& apos, const Position& tpos,
                            int64_t d2, float closeDistance, float attackRange, bool atContact,
                            const Position& home)
{
	const Position np = agent->getPosition();
	int wx = -1, wy = -1;
	if (agent->pathIndex < agent->path.size()) {
		wx = agent->path[agent->pathIndex].x;
		wy = agent->path[agent->pathIndex].y;
	}
	auto dist = [](const Position& a, const Position& b) {
		const double dx = static_cast<double>(a.x) - b.x, dy = static_cast<double>(a.y) - b.y;
		return std::sqrt(dx * dx + dy * dy);
	};
	static std::ofstream adbg("agent_debug.log", std::ios::app);
	adbg << "t=" << g_agentDebugTick << " id=" << (agent->getID() & 0xFFFF)
	     << " pre=(" << apos.x << "," << apos.y << ") post=(" << np.x << "," << np.y << ")"
	     << " moved=" << dist(apos, np) << " rot=" << static_cast<int>(agent->getRotation())
	     << " spd=" << agent->getSpeed() << " tgt=(" << tpos.x << "," << tpos.y << ")"
	     << " d=" << static_cast<int>(std::sqrt(static_cast<double>(d2)))
	     << " close=" << static_cast<int>(closeDistance)
	     << " atk=" << static_cast<int>(attackRange)
	     << (atContact ? " CONTACT" : " CHASE")
	     << " homeD=" << static_cast<int>(dist(apos, home))
	     << " leashRet=" << (agent->isLeashReturning() ? 1 : 0)
	     << " wp=(" << wx << "," << wy << ")"
	     << " idx=" << agent->pathIndex << "/" << agent->path.size() << "\n";
	adbg.flush();
}

void Game::runAgentBrain(Agent* agent)
{
	const AgentData* data = agent->getData();
	if (!data || agent->isDying()) return;

	auto distSq = [](const Position& a, const Position& b) -> int64_t {
		int64_t dx = static_cast<int64_t>(a.x) - b.x, dy = static_cast<int64_t>(a.y) - b.y;
		return dx * dx + dy * dy;
	};

	// Per-tick, and cleared here so every path below is opt-in: only the go-home
	// branch grants it. Ahead of the repair dispatch because that brain is
	// reached only through this function.
	agent->setOnPost(false);

	if (data->brain == AgentBrainType::Repair) {
		runRepairBrain(agent);
		return;
	}

	if (data->brain != AgentBrainType::Aggressive) {
		// Unknown brain: stand, but still consume any knockback so a hit does
		// not stick to it forever.
		agentIdle(agent, agent->getPosition());
		return;
	}

	const Position apos = agent->getPosition();
	const Position home = agent->getHomePos();

	Thing* target = findAgentTarget(agent);

	// The leash constrains MOVEMENT ONLY. It never blinds the agent.
	//
	// Nulling the target while walking home means the agent ignores a player
	// standing right next to it for the entire length of that walk -- it stops
	// caring about you for seconds at a time for no reason you can see, and no
	// amount of re-approaching helps. The leash exists to stop an agent being
	// dragged across the map, so it limits where it will WALK and nothing else:
	// it keeps seeing, keeps swinging at anything in reach, and resumes the
	// chase the instant it is back inside.
	//
	// Hysteresis (trip at leash, clear at 70%) applies to that movement choice,
	// so it cannot pace back and forth across the boundary.
	bool beyondLeash = false;
	if (data->chase && data->leash > 0) {
		const int64_t homeDistSq = distSq(apos, home);
		const int64_t leashSq = static_cast<int64_t>(data->leash) * data->leash;
		if (agent->isLeashReturning()) {
			if (static_cast<double>(homeDistSq) <= static_cast<double>(leashSq) * 0.49) {
				agent->setLeashReturning(false);
			}
		} else if (homeDistSq > leashSq) {
			agent->setLeashReturning(true);
		}
		beyondLeash = agent->isLeashReturning();
	}

	const AgentAbility* melee = agent->getMeleeAbility();

	if (target) {
		// Off the post the moment it has something to fight, so the walk back
		// afterwards re-earns the tight arrival distance instead of stopping at
		// the wider one the latch hands out to an agent already settled.
		agent->setHomeSettled(false);

		const Position tpos = target->getPosition();
		const int64_t d2 = distSq(apos, tpos);
		// agentTargetExtent, not getCollisionRadius: a target may now be a
		// building, and getCollisionRadius returns 0 for a rectangular one --
		// which would have the agent try to stand in the middle of a wall.
		const float radii = agent->getCollisionRadius() + agentTargetExtent(target);

		// Read BEFORE the swing below, with everything else derived from the
		// target. A lethal swing begins the victim's removal, so `target` is not
		// safe to dereference afterwards -- which is why the stall verdict is
		// reported by id rather than by pointer.
		const uint32_t targetId = target->getID();

		// Track how fast the target is moving, from the positions this brain
		// already reads every tick. Player exposes no velocity of its own, and
		// this is the only consumer. A building's is simply always zero.
		agent->observeTargetPosition(tpos, static_cast<float>(MOVEMENT_TICKS_PER_SEC));

		// Everything this agent does below closes on the target, so the movement
		// pass should spread the pack AROUND it rather than straight apart.
		// Covers the standing-at-contact case too, which is where a pile is most
		// visible and where separation is the only force acting.
		agent->setSpreadAnchor(tpos);

		// TWO DIFFERENT DISTANCES, and keeping them apart is the whole point.
		//
		//   attackRange  -- can I land a hit from here?
		//   closeDistance-- am I close enough to stop walking?
		//
		// The old code used one distance for both, which forced the agent to
		// STOP in order to swing. So it halted at full attack range -- 50px of
		// clear air in front of the player, which reads as "it stopped short" --
		// and then had to start again the instant the player stepped away.
		// Attacking while still closing removes that stop/go entirely.
		const float attackRange = (melee ? static_cast<float>(melee->range) : 0.0f) + radii;
		//
		// Bodies are solid now, and that changes where "close enough" IS for a
		// creature target: the movement layer stops the agent with the two
		// bodies touching, at exactly `radii`, so a threshold BELOW that can
		// never be reached. Left as it was, an agent pressed against a player
		// would never latch -- it would run the chase branch forever, make no
		// progress, and every eighth tick spend a shared A* slot trying to
		// route around the body it is already touching.
		//
		// A rectangular OBJECT is the other case and keeps the old inward
		// press: agentTargetExtent reports its LARGEST half-extent, so `radii`
		// already overstates the touching distance for every approach but the
		// corner, and adding to it would park an agent a body's width from a
		// thin wall.
		const float closeDistance = target->getObject()
			? std::max(1.0f, radii - AGENT_CONTACT_OVERLAP)
			: std::max(1.0f, radii + AGENT_CONTACT_TOLERANCE);

		// Face the player, always -- it is a far, stable reference, so the facing
		// stops reacting to the per-tick position jitter that separation causes
		// (the source of the violent rotation). Skipped only at point blank, where
		// the angle is unstable and it is already looking the right way.
		if (d2 > 16 * 16) {
			faceAgentToward(agent, static_cast<float>(tpos.x) - apos.x, static_cast<float>(tpos.y) - apos.y);
		}

		// Swing whenever the target is in range, moving or not.
		//
		// If it is NOT in range, swing at whatever else hostile is -- the rival
		// bot it is squeezing past, the wall between it and the player. This is
		// what makes two bots meeting on the way to something else actually
		// fight, without either one changing target: retargeting on contact
		// would let whoever touched it last steer it, and two of them would hand
		// it back and forth every tick. Hitting what is in front of you costs
		// nothing and thrashes nothing.
		const uint64_t now = OTSYS_TIME();
		if (melee) {
			Thing* preferred =
				(static_cast<float>(d2) <= attackRange * attackRange) ? target : nullptr;
			// face=false: this brain already faces its target every tick above.
			agentTrySwing(agent, *melee, now, preferred, false);
		}

		// LATCHED contact range: arriving costs closeDistance, leaving costs
		// closeDistance + AGENT_REACH_HYSTERESIS. As a bare threshold a player
		// walking at their own speed crosses it every single tick, and the agent
		// alternates a full run step with a dead stop -- wire speed 250, 0, 250,
		// 0 at 20Hz. The client shows that twice over, because moveEntitie
		// freezes rx on the zero-speed ticks and client.js _Ghoul picks its
		// walk-vs-idle animation from whether the entity reached its target.
		const float bound = agent->isHolding() ? closeDistance + AGENT_REACH_HYSTERESIS : closeDistance;
		const bool atContact = static_cast<float>(d2) <= bound * bound;
		agent->setHolding(atContact);

		// The stall clock only runs while CHASING, and every other branch below
		// restarts it. Standing still is the whole job of the other two -- an
		// agent at contact is exactly where it wants to be, and one walking home
		// is not trying to reach its target at all -- so letting the clock run
		// through them would write off targets for behaving correctly.
		if (atContact) {
			// Pressed up against the target: stand and keep swinging on cooldown
			// (separation still spreads a cluster; recoil is consumed).
			agent->clearPath();
			agent->resetStuck(); // standing still is not being stuck
			agent->resetStall(apos, now);
			stepAgent(agent, apos, 0);
		} else if (beyondLeash) {
			// Dragged past its leash: head back, but KEEP the target, so the
			// chase resumes the moment it is inside again and it still swings at
			// anything that closes on it during the walk.
			agent->resetStall(apos, now);
			agentChase(agent, home, agent->getMoveSpeed());
		} else if (data->chase) {
			// Chase a point on the ring around the target, at the slot latched
			// when this agent acquired it, and lead the target's movement.
			//
			// Both are offsets from the TARGET's position, never from the agent's
			// own. That distinction is the whole safety property here: an earlier
			// version derived its standoff from where the agent was standing, so
			// the goal moved as the agent moved, fed back into itself, recomputed
			// the path every time it crossed a tile and never committed to a
			// route -- the "can't decide" spasm. A latched angle and a velocity
			// estimate of somebody else both move exactly as smoothly as the
			// target does.
			//
			// The ring slot is what breaks up the "train": without it every agent
			// walks at the identical point and they queue nose-to-tail behind
			// whichever got there first, since separation only prises them apart
			// once they are already touching.
			const float ringX = std::cos(agent->getSurroundAngle()) * radii;
			const float ringY = std::sin(agent->getSurroundAngle()) * radii;

			// Lead: aim at where the target will be by the time we arrive,
			// capped, because a jinking player's velocity estimate swings wildly
			// and an agent that trusted it would swerve instead of close.
			const float speed = std::max<uint16_t>(1, agent->getMoveSpeed());
			const float closeSeconds =
				std::min(AGENT_LEAD_MAX_SECONDS, std::sqrt(static_cast<float>(d2)) / speed);
			const float leadX = agent->getTargetVelX() * closeSeconds;
			const float leadY = agent->getTargetVelY() * closeSeconds;

			const Position aimPos = clampPositionToMap(
				static_cast<int32_t>(std::lround(tpos.x + ringX + leadX)),
				static_cast<int32_t>(std::lround(tpos.y + ringY + leadY)));
			agentChase(agent, aimPos, agent->getMoveSpeed());
			// After the move, so it reads where the agent actually ended up.
			if (noteAgentStall(agent, targetId, now)) {
				return; // target dropped; next tick picks something reachable
			}
		} else {
			// Guard: it has seen the player but will not pursue. It holds its
			// post and waits for the player to walk into reach.
			agent->resetStall(apos, now);
			stepAgent(agent, apos, 0);
		}

		if (g_agentDebug) {
			logEngagedAgent(agent, apos, tpos, d2, closeDistance, attackRange, atContact, home);
		}
		return;
	}

	// --- No target: hold post, go home, or go looking ---------------------
	agent->setHolding(false);
	// Nothing to encircle: separation goes back to pushing straight apart, which
	// is what two agents crossing paths on the open map want.
	agent->clearSpreadAnchor();

	const auto idle = [&]() { agentIdle(agent, apos); };

	// A guard never leaves its post at all -- so where it is standing IS its
	// post, and separation must not walk it off one either. Without this a
	// guard with a neighbour inside its spacing drifts off the spot it was
	// placed on, a pixel at a time, and never stops running the movement pass.
	if (!data->chase) {
		agent->clearRoamGoal();
		agent->setOnPost(true);
		idle();
		return;
	}

	// OWNERSHIP decides what "nothing to do" means.
	//
	//   built by a player (owner != 0) -- it is stationed somewhere on purpose,
	//     so it walks back to the spot its owner placed it and waits there.
	//   spawned by the world (owner 0) -- it has no post to hold. Sending it
	//     back to an arbitrary spawn point is the "gives up and runs home"
	//     behaviour; it should be out hunting instead.
	//
	// A leash drag also sends an agent home regardless, since that is precisely
	// what the leash is for.
	if (agent->getOwnerGuid() != 0 || agent->isLeashReturning()) {
		agent->clearRoamGoal();

		// ON POST for the whole branch, walking back as much as standing there.
		// Granting it only on arrival would be useless: separation pushes a bot
		// harder than a bot walks (9/tick against 5-6), so one that is being
		// pushed never arrives, and never gets the exemption that would let it.
		agent->setOnPost(true);

		// LATCHED, exactly like the contact range in the target branch above and
		// for the same reason: as a bare threshold an agent sitting near the
		// boundary crosses it every tick and alternates a full step home with a
		// dead stop -- wire speed 120, 0, 120, 0 at 20Hz, which reads as a shake
		// rather than as walking. Arriving costs AGENT_HOME_ARRIVE, leaving
		// costs AGENT_HOME_ARRIVE + AGENT_REACH_HYSTERESIS.
		//
		// It also covers the case arrival cannot: a post the agent can get near
		// but not exactly onto, because geometry pushes its body back out. It
		// settles just outside instead of walking at it forever.
		const float homeBound = agent->isHomeSettled()
		                            ? AGENT_HOME_ARRIVE + AGENT_REACH_HYSTERESIS
		                            : AGENT_HOME_ARRIVE;
		const bool atPost = distSq(apos, home) <= static_cast<int64_t>(homeBound * homeBound);
		agent->setHomeSettled(atPost);

		if (!atPost) {
			faceAgentToward(agent, static_cast<float>(home.x) - apos.x, static_cast<float>(home.y) - apos.y);
			agentChase(agent, home, agent->getMoveSpeed());
		} else {
			idle();
		}
		return;
	}

	// Roam. findAgentTarget already runs every tick, so wandering IS the search:
	// anything that comes within `vision` on the way is picked up and chased.
	//
	// The shape of this is "always be walking somewhere". A leg is picked to be
	// straight-line walkable (pickAgentRoamGoal casts the body along the
	// bearing), the next one is chained on the tick the last one ends rather
	// than after a stand, and any leg that stops working is replaced
	// immediately. Those three together are what the stop-a-few-tiles-and-wait
	// behaviour was: an unvalidated goal buried in geometry, no reaction to it
	// beyond a flat eight-second deadline, and a mandatory pause on top.
	const uint64_t now = OTSYS_TIME();

	if (agent->hasRoamGoal() &&
	    (distSq(apos, agent->getRoamGoal()) <= AGENT_ROAM_ARRIVE_SQ || now >= agent->getRoamDeadline())) {
		agent->clearRoamGoal();
		agent->resetRoamFailures(); // a leg that ran its course clears the streak
		// Zero by default, so the next leg starts on this very tick and the
		// agent never reports a zero wire speed between legs.
		const uint32_t pause = data->roamPauseMs > 0 ? data->roamPauseMs : AGENT_DEFAULT_ROAM_PAUSE_MS;
		agent->setRoamDeadline(now + pause);
	}

	if (!agent->hasRoamGoal() && now >= agent->getRoamDeadline()) {
		pickAgentRoamGoal(agent);
	}

	if (!agent->hasRoamGoal()) {
		idle(); // pausing between legs, or boxed in and waiting to try again
		return;
	}

	// allowPathfinding = false: a wanderer navigates by aiming and walking clear
	// runs, so being told "this leg is not working" is worth more to it than an
	// A* route, and costs a fraction as much. Roaming therefore never competes
	// with chasing agents for the per-tick search budget.
	if (!agentChase(agent, agent->getRoamGoal(), agent->getMoveSpeed(), false)) {
		// This leg has stopped working: wedged, or the way ahead is blocked. A
		// wander has no stake in any particular point, so take a new bearing now
		// rather than lean on the obstacle until the leg deadline -- that wait is
		// what read as "stops for no reason".
		agent->noteRoamFailure();
		if (agent->getRoamFailures() >= AGENT_ROAM_FAIL_LIMIT) {
			// Not the legs -- the destination. Every bearing that makes progress
			// toward it is blocked, which is what being in a pocket looks like
			// from the inside. Somewhere else entirely is the way out.
			agent->clearRoamDest();
			agent->resetRoamFailures();
		}
		pickAgentRoamGoal(agent);
	}

	// Face where it ACTUALLY went, not where it was aiming. A roaming agent
	// spends a good part of its time sliding along geometry or cutting to a
	// waypoint off to one side, and facing the distant goal through all of that
	// makes it walk visibly sideways. The threshold keeps sub-pixel push-out
	// jitter from touching the facing (the old "shaking in place" symptom);
	// below it, aim at the goal, which is still the meaningful direction.
	const Position npos = agent->getPosition();
	if (distSq(apos, npos) > 9) {
		faceAgentToward(agent, static_cast<float>(npos.x) - apos.x, static_cast<float>(npos.y) - apos.y);
	} else if (agent->hasRoamGoal()) {
		const Position& g = agent->getRoamGoal();
		faceAgentToward(agent, static_cast<float>(g.x) - npos.x, static_cast<float>(g.y) - npos.y);
	}
}

// Uniform float in [lo, hi). Shared by the two roam pickers.
//
// uniform_random, not rand(): MSVC's RAND_MAX is 32767, so `rand() % n` for any
// n past that is not uniform -- and on a 65500-unit map, picking a destination
// coordinate that way would confine every roaming agent to the top-left corner.
// It is also the generator config.lua's `seed` pins, so agent behaviour
// stays reproducible in a seeded benchmark world.
static float agentRandf(float lo, float hi)
{
	return lo + (static_cast<float>(uniform_random(0, 10000)) / 10000.0f) * (hi - lo);
}

void Game::pickAgentRoamDestination(Agent* agent)
{
	const Position apos = agent->getPosition();
	const float radius = agent->getCollisionRadius() * AGENT_PATH_RADIUS_MARGIN;

	// Two tiles of inset: one for the band along the edge that a body of
	// `radius` can never enter (stepAgent clamps it out), one so the agent is
	// not aiming at a point it can only approach from a single direction.
	const int32_t inset = TILE_SIZE * 2;
	const int32_t maxX = std::max(inset, MapSize::widthUnits() - inset);
	const int32_t maxY = std::max(inset, MapSize::heightUnits() - inset);

	// Anywhere on the map, far enough away to be a journey, and somewhere the
	// agent could actually stand. Nothing depends on it being reachable -- the
	// legs handle whatever is in between, and a destination behind a lake just
	// times out after the agent has spent the whole time walking toward it.
	Position chosen = apos;
	int64_t chosenDist = -1;
	for (int32_t attempt = 0; attempt < AGENT_ROAM_DEST_TRIES; ++attempt) {
		const Position candidate =
			clampPositionToMap(uniform_random(inset, maxX), uniform_random(inset, maxY));
		const int64_t dx = static_cast<int64_t>(candidate.x) - apos.x;
		const int64_t dy = static_cast<int64_t>(candidate.y) - apos.y;
		const int64_t d2 = dx * dx + dy * dy;
		if (d2 < static_cast<int64_t>(AGENT_ROAM_DEST_MIN_DIST) * static_cast<int64_t>(AGENT_ROAM_DEST_MIN_DIST)) {
			continue;
		}
		if (agentBodyBlockedAt(map, static_cast<float>(candidate.x), static_cast<float>(candidate.y), radius)) {
			continue;
		}
		chosen = candidate;
		chosenDist = d2;
		break;
	}

	// Every candidate was too close or sat in geometry (a small map, or a very
	// unlucky dozen draws). Take a far bearing instead of standing: the point of
	// a destination is to give the legs a direction, and one that turns out to
	// be unwalkable is no worse than one behind a rock.
	if (chosenDist < 0) {
		const float bearing = agentRandf(0.0f, MATH_TWO_PI);
		chosen = clampPositionToMap(
			static_cast<int32_t>(std::lround(apos.x + std::cos(bearing) * AGENT_ROAM_DEST_MIN_DIST)),
			static_cast<int32_t>(std::lround(apos.y + std::sin(bearing) * AGENT_ROAM_DEST_MIN_DIST)));
		const int64_t dx = static_cast<int64_t>(chosen.x) - apos.x;
		const int64_t dy = static_cast<int64_t>(chosen.y) - apos.y;
		chosenDist = dx * dx + dy * dy;
	}

	agent->setRoamDest(chosen);

	const uint32_t speed = std::max<uint16_t>(1, agent->getMoveSpeed());
	const uint32_t travelMs =
		static_cast<uint32_t>((std::sqrt(static_cast<double>(chosenDist)) * 1000.0) / speed);
	agent->setRoamDestDeadline(OTSYS_TIME() +
		std::clamp(travelMs * 3, AGENT_ROAM_DEST_TIMEOUT_MIN_MS, AGENT_ROAM_DEST_TIMEOUT_MAX_MS));
}

void Game::pickAgentRoamGoal(Agent* agent)
{
	const AgentData* data = agent->getData();
	const float range = static_cast<float>((data && data->roamRadius > 0) ? data->roamRadius
	                                                                     : AGENT_DEFAULT_ROAM_RADIUS);
	const Position apos = agent->getPosition();
	const uint64_t now = OTSYS_TIME();

	// Test the body at the same margin A* uses. The rule everywhere in this AI
	// is that whatever plans a move must be at least as strict as the layer that
	// executes it: a leg the movement resolver then refuses is worse than no leg
	// at all, because the agent commits to it and leans on the obstacle.
	const float radius = agent->getCollisionRadius() * AGENT_PATH_RADIUS_MARGIN;

	// Journey first: legs are meaningless without somewhere to be going.
	const auto distSqTo = [&apos](const Position& p) -> int64_t {
		const int64_t dx = static_cast<int64_t>(p.x) - apos.x;
		const int64_t dy = static_cast<int64_t>(p.y) - apos.y;
		return dx * dx + dy * dy;
	};
	if (!agent->hasRoamDest() || now >= agent->getRoamDestDeadline() ||
	    distSqTo(agent->getRoamDest()) <= AGENT_ROAM_DEST_ARRIVE_SQ) {
		pickAgentRoamDestination(agent);
	}

	const Position dest = agent->getRoamDest();
	const float toDest = std::atan2(static_cast<float>(dest.y) - apos.y,
	                                static_cast<float>(dest.x) - apos.x);

	// Candidate bearings, as sectors either side of the destination: straight
	// at it, then progressively further round, and at worst back the way it
	// came. Which side is tried first is fixed per agent, so an agent meeting an
	// obstacle head-on commits to going round one way instead of dithering, and
	// two agents at the same obstacle split around it.
	static constexpr float FAN[] = {0.0f, 1.0f, -1.0f, 2.0f, -2.0f, 3.0f};
	const float side = (agent->getID() & 1) ? 1.0f : -1.0f;

	// A leg worth taking outright: aimed at the destination and long enough to
	// be worth committing to. Anything less and the fan keeps looking.
	const float goodLeg = std::max(AGENT_ROAM_MIN_LEG, range * 0.5f);

	float bestBearing = toDest;
	float bestRun = 0.0f;
	float bestScore = -std::numeric_limits<float>::max();
	for (size_t s = 0; s < sizeof(FAN) / sizeof(FAN[0]); ++s) {
		const float sector = FAN[s];
		const float bearing = toDest + sector * side * AGENT_ROAM_TURN +
		                      agentRandf(-AGENT_ROAM_JITTER, AGENT_ROAM_JITTER);
		const float run = agentClearRun(apos, std::cos(bearing), std::sin(bearing), radius,
		                                range + AGENT_ROAM_BACKOFF);
		// Finish in the open, short of whatever stopped the ray.
		const float usable = run - AGENT_ROAM_BACKOFF;
		// A long leg in the wrong direction is not better than a shorter one
		// that makes progress; without the penalty the agent takes whichever
		// bearing happens to be clearest and drifts sideways forever.
		const float score = usable - std::abs(sector) * AGENT_ROAM_SECTOR_PENALTY;
		if (score > bestScore) {
			bestScore = score;
			bestRun = usable;
			bestBearing = bearing;
		}
		if (s == 0 && usable >= goodLeg) {
			break; // clear run straight at the destination: nothing to weigh up
		}
	}

	// Distance: random inside the proven-clear run, so a pack does not march in
	// lockstep, but never past what the ray actually cleared.
	float dist = bestRun;
	if (bestRun > goodLeg) {
		dist = agentRandf(goodLeg, std::min(bestRun, range));
	}
	if (dist < AGENT_ROAM_ESCAPE_LEG) {
		// Boxed in on every bearing -- spawned inside geometry, or standing in a
		// pocket. Walk the escape leg anyway rather than stand: the movement
		// layer can push a body out of what it is embedded in, and a stationary
		// agent's situation never changes on its own. The short deadline below
		// means it reconsiders quickly.
		dist = AGENT_ROAM_ESCAPE_LEG;
	}

	const float dx = std::cos(bestBearing);
	const float dy = std::sin(bestBearing);

	agent->setRoamHeading(bestBearing);
	// Any route still held was computed toward the goal being replaced.
	agent->clearPath();
	agent->resetStuck();
	agent->setRoamGoal(clampPositionToMap(
		static_cast<int32_t>(std::lround(apos.x + dx * dist)),
		static_cast<int32_t>(std::lround(apos.y + dy * dist))));

	// Deadline scaled to the leg rather than flat: this leg is straight and its
	// length and speed are both known, so its duration is known too, and much
	// past that means it stopped working.
	const uint32_t speed = std::max<uint16_t>(1, agent->getMoveSpeed());
	const uint32_t travelMs = static_cast<uint32_t>((dist * 1000.0f) / static_cast<float>(speed));
	agent->setRoamDeadline(OTSYS_TIME() +
		std::min(AGENT_ROAM_TIMEOUT_MAX_MS, travelMs * 2 + AGENT_ROAM_TIMEOUT_SLACK_MS));
}

bool Game::findAgentSpawnPosition(const AgentData* data, Position& out)
{
	const int32_t inset = TILE_SIZE * 2;
	const int32_t maxX = std::max(inset, MapSize::widthUnits() - inset);
	const int32_t maxY = std::max(inset, MapSize::heightUnits() - inset);
	const float radius = static_cast<float>(data->radius) * AGENT_PATH_RADIUS_MARGIN;
	const int64_t minPlayerDistSq =
		static_cast<int64_t>(AGENT_SPAWN_MIN_PLAYER_DIST) * AGENT_SPAWN_MIN_PLAYER_DIST;

	for (int32_t attempt = 0; attempt < AGENT_SPAWN_PLACE_TRIES; ++attempt) {
		const Position candidate =
			clampPositionToMap(uniform_random(inset, maxX), uniform_random(inset, maxY));

		// Never within sight of a player. An agent that materialises already
		// hunting someone is not a monster appearing in the dark, it is a monster
		// appearing at your shoulder, and there is no counterplay to it.
		bool tooClose = false;
		for (const auto& it : players) {
			const Player* p = it.second;
			if (!p || !p->client) continue;
			const int64_t dx = static_cast<int64_t>(p->getPosition().x) - candidate.x;
			const int64_t dy = static_cast<int64_t>(p->getPosition().y) - candidate.y;
			if (dx * dx + dy * dy < minPlayerDistSq) {
				tooClose = true;
				break;
			}
		}
		if (tooClose) continue;

		// The established placement rule: nothing solid on the tile or reaching
		// into it -- objects, colliding resources, loot, other creatures. Strict,
		// because an agent appearing inside somebody's base is exactly the sort
		// of thing that rule exists to stop.
		if (!isSpawnPositionValid(candidate, nullptr, SpawnRule::Strict)) continue;
		if (scenario::g_scenarioRuntime.permission(scenario::PermissionKind::Spawn, candidate) == false) continue;

		// And again against this agent's OWN body, which isSpawnPositionValid
		// knows nothing about -- it works in fixed clearances, so a wide agent
		// can pass it and still be born overlapping a rock.
		if (agentBodyBlockedAt(map, static_cast<float>(candidate.x), static_cast<float>(candidate.y), radius)) {
			continue;
		}

		out = candidate;
		return true;
	}
	return false;
}

// --- Spawner objects (objects.xml <stage spawnCreature="...">) --------------

bool Game::agentBodyFitsAt(const AgentData* data, const Position& at)
{
	const float radius = static_cast<float>(data->radius) * AGENT_PATH_RADIUS_MARGIN;
	return !agentBodyBlockedAt(map, static_cast<float>(at.x), static_cast<float>(at.y), radius);
}

bool Game::findAgentBodyFitNear(const AgentData* data, const Position& origin, Position& out)
{
	const float bodyRadius = static_cast<float>(data->radius) * AGENT_PATH_RADIUS_MARGIN;

	// Rings outward, nearest first, at a random bearing offset per ring. Body fit
	// is the ONLY question asked: the object that hatched was standing here, so
	// this ground is already legal to occupy -- floors, roads and loot under it
	// are exactly what a base is made of and must not push the creature away.
	constexpr int32_t RINGS = 3;
	constexpr int32_t BEARINGS = 8;
	const int32_t step = static_cast<int32_t>(data->radius) + TILE_SIZE / 2;
	for (int32_t ring = 1; ring <= RINGS; ++ring) {
		const float base = agentRandf(0.0f, MATH_TWO_PI);
		for (int32_t b = 0; b < BEARINGS; ++b) {
			const float angle = base + static_cast<float>(b) * (MATH_TWO_PI / BEARINGS);
			const Position candidate = clampPositionToMap(
				static_cast<int32_t>(origin.x) + static_cast<int32_t>(std::cos(angle) * ring * step),
				static_cast<int32_t>(origin.y) + static_cast<int32_t>(std::sin(angle) * ring * step));

			if (agentBodyBlockedAt(map, static_cast<float>(candidate.x),
			                       static_cast<float>(candidate.y), bodyRadius)) {
				continue;
			}

			out = candidate;
			return true;
		}
	}
	return false;
}

void Game::hatchStageCreatures(Object* obj, const ObjectStage& stage)
{
	// Everything needed must be read BEFORE the object goes: removeSilently
	// unregisters it and queues the delete.
	const std::string key = stage.spawnCreature;
	const uint8_t count = std::max<uint8_t>(1, stage.spawnCreatureCount);
	const Position origin = obj->getPosition();

	// Ownership is the point of the feature, and it is one field: the player who
	// placed the object owns what it becomes. Every owned-agent behaviour then
	// follows from it with no separate code path -- the creature treats its
	// owner's side as friendly and everyone else as hostile (isAgentHostileTo), ignores
	// its owner's other agents' personal space, and holds the post it hatched on
	// rather than roaming (runAgentBrain). A WORLD-placed object has ownerPid 0,
	// which yields a wild agent that roams and hunts everyone, through exactly
	// the same call.
	const uint32_t owner = obj->getOwnerPid();

	// Consume first, so the creature can take the exact spot the object was
	// standing on. removeSilently, like the other replacement actions: this is a
	// transformation, not a destruction, so no drops and no explosion. It leaves
	// the map synchronously and the delete is deferred, so `obj` must not be
	// touched past this line.
	const AgentData* data = g_agents.getAgentData(key);
	obj->removeSilently();

	if (!data) {
		return; // unknown key; warned once at boot by validateStageCreatures
	}

	const float bodyRadius = static_cast<float>(data->radius) * AGENT_PATH_RADIUS_MARGIN;

	for (uint8_t i = 0; i < count; ++i) {
		// The exact spot is the point: the creature steps into the place the
		// object just left, so it appears where the player watched it grow. Two
		// things send it elsewhere -- being an EXTRA from a count > 1 hatch (the
		// body check passes through creatures, so they would all land on one
		// point), or a body that genuinely does not fit, e.g. a seed planted hard
		// against a rock.
		Position spawnPos = origin;
		if (i > 0 || agentBodyBlockedAt(map, static_cast<float>(origin.x),
		                                static_cast<float>(origin.y), bodyRadius)) {
			if (!findAgentBodyFitNear(data, origin, spawnPos)) {
				continue; // walled in
			}
		}

		Agent* agent = g_agents.createAgent(key, spawnPos, owner);
		if (!agent) {
			break; // id band exhausted; nothing else would succeed either
		}
		if (!placeThing(agent, spawnPos)) {
			delete agent; // refcount still 0
			continue;
		}
	}
}

// --- Dodging bullets --------------------------------------------------------
//
// One pass over the live projectiles, each looking down its own remaining path
// for agents it is about to hit. See the AgentDodge comment in agent.h for why
// this runs from the bullet rather than from the agent.
void Game::updateAgentDodges()
{
	// Two early-outs that between them make this free in every ordinary frame:
	// nothing in flight, or nothing loaded that dodges at all.
	const uint32_t maxReactionMs = g_agents.maxDodgeReactionMs();
	if (maxReactionMs == 0 || projectiles.empty()) {
		return;
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	const float lookSeconds = static_cast<float>(maxReactionMs) / 1000.0f;
	// The same content-derived margin the projectile collision scan uses: a
	// thing is filed under the tile holding its CENTRE while its body reaches
	// further, so a box built from the path alone silently misses the agents
	// standing just outside it.
	const int32_t tileMargin = Map::collisionScanTileMargin();

	for (const std::unique_ptr<Projectile>& owned : projectiles) {
		Projectile* p = owned.get();
		// Parked, spent or already resolved: it is a sprite, not a threat.
		if (!p || p->isStopped() || p->isExpired() || p->isImpactResolved()) {
			continue;
		}

		const float speed = std::sqrt(p->getVelocityX() * p->getVelocityX() +
		                              p->getVelocityY() * p->getVelocityY());
		if (speed < 1.0f) {
			continue;
		}
		const float ux = p->getVelocityX() / speed;
		const float uy = p->getVelocityY() / speed;

		// The stretch of flight anyone could still react to. Beyond it every
		// agent would reject the shot as too far out anyway, so it is also the
		// exact width of the search.
		const float px = p->getFloatX();
		const float py = p->getFloatY();
		const float reach = speed * lookSeconds;
		const float ex = px + ux * reach;
		const float ey = py + uy * reach;

		const auto tileOf = [](float v) {
			return static_cast<int32_t>(std::floor(v / static_cast<float>(TILE_SIZE)));
		};
		agentDodgeScratch.clear();
		map.getThingsInTileBox(tileOf(std::min(px, ex)) - tileMargin,
		                       tileOf(std::min(py, ey)) - tileMargin,
		                       tileOf(std::max(px, ex)) + tileMargin,
		                       tileOf(std::max(py, ey)) + tileMargin,
		                       agentDodgeScratch);

		for (Thing* thing : agentDodgeScratch) {
			Agent* agent = thing->getAgent();
			if (!agent || agent->isDying()) continue;
			if (static_cast<Creature*>(agent) == p->getShooter()) continue;

			// Cheapest first: the flag and the cooldown reject every agent that
			// does not dodge, is already dodging, or has just declined a shot.
			if (!agent->mayConsiderDodge(now)) continue;
			const AgentData* data = agent->getData();

			const Position apos = agent->getPosition();
			const float rx = static_cast<float>(apos.x) - px;
			const float ry = static_cast<float>(apos.y) - py;

			// Distance along the flight path, and signed offset from it. The
			// bullet is a ray, not a line: anything behind the muzzle has
			// already been missed.
			const float along = rx * ux + ry * uy;
			if (along <= 0.0f) continue;
			const float side = ux * ry - uy * rx;
			const float hitWidth = agent->getCollisionRadius() + static_cast<float>(data->dodge.margin);
			if (std::abs(side) > hitWidth) continue; // not on line: no reason to move

			// How late it notices. A shot still seconds away is one the agent
			// has no business reacting to -- it would sidestep, finish the
			// sidestep, and be standing still again when the bullet arrived.
			const float impactMs = (along / speed) * 1000.0f;
			if (impactMs > static_cast<float>(data->dodge.reactionMs)) continue;

			if (data->dodge.chance < 1.0f && agentRandf(0.0f, 1.0f) >= data->dodge.chance) {
				agent->declineDodge(now);
				continue;
			}

			// Sidestep to whichever side it is ALREADY on, so the step adds to
			// the miss instead of carrying it across the line. Dead centre has
			// no better side, so the id picks one -- which also splits a pair
			// standing in the same shot instead of sending both the same way.
			float dirX = -uy;
			float dirY = ux;
			const bool flip = (std::abs(side) < 1.0f) ? ((agent->getID() & 1) != 0) : (side < 0.0f);
			if (flip) {
				dirX = -dirX;
				dirY = -dirY;
			}
			agent->beginDodge(dirX, dirY, now);
		}
	}
}

void Game::updateAgents()
{
	++g_agentDebugTick;

	// Before any brain runs, so a sidestep armed by this tick's bullets is
	// spent by this tick's movement.
	updateAgentDodges();

	// Snapshot the agents first, holding a reference on each.
	//
	// The mobile index is still the source of truth, but it cannot be iterated
	// directly: a brain can kill an agent (an explosive chain now; daylight
	// sun-damage and lifetime expiry as soon as those land), and Agent::die ->
	// Map::removeThing swap-pops the very vector getMobiles() hands out. That
	// silently skips whichever agent got swapped into the freed slot and then
	// walks off the end of a shorter vector. The reference keeps a dying agent's
	// memory alive until the pass finishes, so the loop can never touch freed
	// storage; isDying() is what stops us running a corpse's brain.
	agentTickScratch.clear();
	for (const Map::MobileEntry& entry : map.getMobiles()) {
		if (Agent* agent = entry.thing->getAgent()) {
			agent->incrementReferenceCounter();
			agentTickScratch.push_back(agent);
		}
	}

	// Per-tick A* budget, shared across all agents. A crowd that all lose their
	// route in the same frame must not be able to blow the movement tick; the
	// ones that miss out chase straight for a tick and re-decide next time.
	agentPathBudget = AGENT_PATH_SEARCHES_PER_TICK;

	// Who is already on what, from the snapshot above and before any brain runs
	// -- so every agent this tick reads the SAME census and none of them sees a
	// half-updated one. Cleared rather than rebuilt so the buckets survive.
	agentTargetCensus.clear();
	for (const Agent* agent : agentTickScratch) {
		if (agent->isDying()) continue;
		if (const uint32_t id = agent->getTargetId()) {
			++agentTargetCensus[id];
		}
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	const bool daytime = !isNight();

	for (Agent* agent : agentTickScratch) {
		if (agent->isDying()) continue;

		// Old age. Ghouls set lifetimeMs="0" (never) because the sun already
		// deals with them; the field is here for agents that need a hard cap.
		const uint64_t expiresAt = agent->getExpiresAt();
		if (expiresAt > 0 && now >= expiresAt) {
			agent->expire();
			continue; // expire() removed it from the map; our reference keeps it alive
		}

		// Sun damage. This is what balances the night speed boost: ghouls own
		// the dark and burn away in daylight, so their numbers fall off on their
		// own without a spawner having to cull them.
		const AgentData* data = agent->getData();
		if (data && data->daylightEnabled && daytime && now >= agent->getNextDaylightAt()) {
			agent->setNextDaylightAt(now + std::max<uint32_t>(100, data->daylightIntervalMs));
			agent->changeHealth(-static_cast<int32_t>(data->daylightDamage));
			if (agent->isDying()) continue; // burnt to death this tick
		}

		// Conditions, before the brain: a poison that kills this tick must not
		// have a corpse's brain run afterwards, and a slow applied this tick has
		// to be in force for the step the brain is about to take.
		//
		// MOVEMENT_TICK_MS rather than a measured elapsed: updateAgents runs on
		// the same movement tick the players do, and the durations in
		// conditions.xml mean the same thing on both sides only if both advance
		// by the same amount.
		if (!agent->getConditionSet().empty()) {
			agent->updateConditions(MOVEMENT_TICK_MS);
			if (agent->isDying()) continue; // poisoned to death this tick
		}

		agent->tickPulses(); // decrement hit/attack pulses before this tick's diff
		runAgentBrain(agent);
	}

	// Releases our reference; deletes any agent whose death removed it from the
	// map during the pass.
	for (Agent* agent : agentTickScratch) {
		agent->decrementReferenceCounter();
	}
	agentTickScratch.clear();
}

