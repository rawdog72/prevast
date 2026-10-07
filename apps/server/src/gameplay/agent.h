// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_AGENT_H
#define FS_AGENT_H

#include "gameplay/creature.h"
#include "gameplay/condition.h" // ConditionApplication, for <ability condition=>
#include "core/tools.h" // OTSYS_TIME, for the knockback window

#include <pugixml.hpp>
#include <cmath>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

// --- Agent definitions ---
//
// An agent is a server-spawned creature (monster / robot) rendered client-side
// as entity type 13 (__ENTITIE_AI__). AgentData mirrors one entry of the
// client's fixed AI[] catalog; `sprite` is the index into it. This is pure
// definition data -- which mode spawns an agent, and how many, lives in
// modes.xml (GameMode::agentSpawns), not here.

// `amount` alone is a fixed hit; `amountMax` above it makes the swing roll in
// [amount, amountMax]. Same vocabulary as ItemDrop and as equipables' <damage
// amount=>, which is the degenerate case of this one -- it used to be spelled
// min/max here and nowhere else.
struct AgentDamage {
	uint16_t amount = 0;
	uint16_t amountMax = 0;

	// The high end, for anything that wants one number: a fixed hit reads as
	// itself.
	uint16_t highest() const { return amountMax > amount ? amountMax : amount; }

	uint16_t roll() const
	{
		if (amountMax <= amount) return amount;
		return static_cast<uint16_t>(amount + rand() % (amountMax - amount + 1));
	}
};

// The kinds an ability / target / brain can be, interned from the XML strings
// at load (agent.cpp parse helpers own the mapping, and warn on an unknown
// string). Interned because these run inside the hottest predicates the AI has:
// isAgentHostileTo resolves a <target> rule per THING per TILE in
// findHostileInReach and per player per agent per tick in acquisition, and
// runAgentBrain dispatches on the brain kind per agent per tick. The XML keeps
// its readable strings; only the runtime test became an int compare.
// `None` never matches anything, which is also exactly how an unrecognised
// string behaved when these were compared as text.
enum class AgentAbilityType : uint8_t { None, Melee, Ranged, Repair, Heal };
enum class AgentTargetType : uint8_t { None, Player, Agent, Object, DamagedObject };
enum class AgentBrainType : uint8_t { None, Aggressive, Repair };

// The kind of damage a hit carries, for the <resistances> lookup. The player
// side of the same idea is a wearable's damageType string picking the
// ...Resistance modifier; the agent side is an enum for the reason above.
// None -- trap damage, sun damage, lifetime expiry -- is never reduced,
// exactly as a typeless hit bypasses a player's wearables.
enum class AgentDamageKind : uint8_t { None, Melee, Piercing, Explosion, Energy };

// Maps an equipable's damageType string ("melee" | "piercing" | "energy") to
// the agent damage kinds, for the call sites where the weapon decides the
// type. Unknown or empty -> None, i.e. no reduction.
inline AgentDamageKind agentDamageKindFromString(const std::string& s)
{
	if (s == "melee") return AgentDamageKind::Melee;
	if (s == "piercing") return AgentDamageKind::Piercing;
	if (s == "energy") return AgentDamageKind::Energy;
	if (s == "explosion") return AgentDamageKind::Explosion;
	return AgentDamageKind::None;
}

// One thing an agent does to a target on a cooldown. Unifies what the first
// draft split into <attacks>/<actions>: melee/ranged carry damage+knockback,
// repair/heal carry amount, ranged also names a projectile from projectiles.xml.
struct AgentAbility {
	AgentAbilityType type = AgentAbilityType::None;
	uint32_t cooldownMs = 0;
	uint32_t impactMs = 0;   // delay from action start to effect landing
	uint16_t range = 0;
	// Lateral half-width of a melee swing, matching <combat><radius> in
	// equipables.xml. An AGENT ignores it -- it swings at the one target it has
	// already chosen -- but a ghoul PLAYER swings through the player melee
	// pipeline, which traces an arc, so this is what decides how wide that arc
	// is. Per ability rather than per mode so each ghoul type can differ.
	// 0 falls back to MELEE_HIT_FORGIVENESS.
	uint16_t radius = 0;
	// Stamina one swing costs a ghoul PLAYER. Agents have no stamina gauge and
	// ignore this; it exists so a ghoul cannot swing forever, the same way a
	// player's <usage stamina=> limits them.
	uint8_t staminaUsage = 0;
	AgentDamage damage;      // melee/ranged
	float knockback = 0.0f;  // melee/ranged
	uint16_t amount = 0;     // repair/heal
	std::string projectile;  // ranged: key into projectiles.xml

	// What a landed swing does beyond its damage: <ability condition=> for the
	// condition it inflicts, plus optional <leech> and <crit> children. On the
	// ability rather than the agent because a creature with two attacks can
	// perfectly well have one that poisons and one that does not.
	//
	// A ranged ability leaves the condition empty and puts it on the projectile
	// instead -- the round carries what the round does, and the shot is what
	// lands.
	HitEffects hitEffects;
};

// One kind of thing an agent is interested in. The list in <brain> is what an
// agent will engage AT ALL: drop the entry and it stops noticing that kind.
struct AgentTarget {
	AgentTargetType type = AgentTargetType::None;
	uint16_t priority = 0;
	// Will the agent WALK to this kind of target, or only act on one already in
	// reach? Per TARGET rather than per agent, because the two answers differ
	// for the same bot: a lapabot walks across the base to a damaged wall but
	// never takes a step toward a player. `<brain chase=>` cannot express that,
	// since it governs the agent as a whole.
	bool pursue = true;
};

// Drops use the shared ItemDrop shape from definitions.h; this file used to
// declare its own identical-in-spirit struct.

struct AgentExplosion {
	bool enabled = false;
	uint16_t playerDamage = 0;
	uint16_t buildingDamage = 0;
	float knockback = 0.0f;
	uint16_t radius = 0;
	uint16_t area = 0;
	// What the BLAST inflicts on every creature caught in it -- a plague ghoul
	// bursting into a cloud. See ProjectileExplosion::onHit.
	ConditionApplication onHit;
};

// How much wider than `vision` the give-up range is when agents.xml does not
// state one. Anything above 1 breaks the per-tick acquire/lose flip-flop; 1.4
// keeps the agent committed without letting it track a player across the map.
static constexpr float AGENT_LOSE_TARGET_FACTOR = 1.4f;

// Extra distance a target must gain before an agent that has closed to contact
// decides to walk again. Without it the agent flips between "stand" (wire speed
// 0) and "run" every tick while the player strafes on the boundary, which
// judders both its position and the client's animation -- client.js _Ghoul
// picks walk vs idle by whether it has reached its target.
static constexpr float AGENT_REACH_HYSTERESIS = 24.0f;

// How far an agent presses INTO a rectangular target before it counts as having
// arrived. Only objects: agentTargetExtent reports a rect's LARGEST half-extent,
// so the nominal contact distance overstates the real one for every approach but
// the corner, and without this an agent parks a body's width from a thin wall
// and swings at air.
static constexpr float AGENT_CONTACT_OVERLAP = 12.0f;

// ...and the counterpart for a target with a real radius -- a player, another
// agent -- where the contact distance is EXACT. Bodies are solid, so the
// movement layer stops the agent with the two touching and not one unit closer;
// the arrival threshold therefore has to sit just OUTSIDE that distance, or it
// can never be reached at all and the agent chases something it is already
// pressed against. Small: it only has to cover the rounding to integer wire
// positions and the push-out landing exactly on the surface.
static constexpr float AGENT_CONTACT_TOLERANCE = 6.0f;

// --- Bodies are solid ------------------------------------------------------
//
// How much of a body-vs-body overlap ONE agent may resolve in a single tick.
//
// Agents used to pass straight through every creature: the movement resolver
// skipped anything with a Creature, so a ghoul walked into a player and kept
// going, and a pack piled into one point. Bodies are enforced now, and this cap
// is the whole difference between enforcing them and enforcing geometry.
//
// A wall does not move, so a body is pushed out of it by the exact penetration
// and lands on the surface. Two BODIES both resolve, in their own steps, in the
// same tick, and neither is anchored -- so an uncapped push turns a deep
// overlap (two agents spawned on the same spot, a knockback driving one into
// another) into a visible sideways teleport of both. Capped, they unstack over
// a few ticks instead.
//
// It must still exceed the distance an agent covers in a tick (16.5 at the
// fastest night speed) or collision would be soft: the push has to be able to
// fully cancel a step, which is what makes an agent stop at a body rather than
// sink into it.
static constexpr float AGENT_BODY_PUSHOUT_MAX = 40.0f;

// --- Pack behaviour --------------------------------------------------------
//
// None of this is coordinated. There is no pack object, no leader, no shared
// plan: each agent latches one number when it picks up a target, and the group
// behaviour falls out of them having latched different ones. Deliberate -- a
// coordinator would have to survive its members dying mid-plan, and the client
// cannot draw intent anyway, so anything a player cannot read off the movement
// is invisible work.

// Where on the ring around its target an agent heads for, as an angle offset
// from the bearing it first saw that target on. Latched at ACQUISITION and never
// recomputed: a standoff derived from the agent's own live position moves as the
// agent moves, feeds back into itself, and is the original chase spasm.
//
// Agents converging from the same direction take consecutive slots, so they fan
// out over roughly +/-60 degrees instead of queueing up nose-to-tail -- the
// "train" of ghouls following one another in single file. Measuring from each
// agent's own approach bearing keeps the walk short: a slot assigned purely from
// the id would send an agent already north of you round to the south for no
// reason a player could see.
static constexpr float AGENT_SURROUND_STEP = 0.52f;  // 30 degrees between slots
static constexpr int32_t AGENT_SURROUND_SLOTS = 5;   // -60, -30, 0, +30, +60

// The slot only breaks the symmetry of the approach -- it is not what spaces a
// pack out, and it cannot be. Slots 30 degrees apart on a contact ring of ~60
// units put neighbouring agents about 32 units apart, half a body width, so they
// still overlap on arrival. Widening the slots enough to fit bodies would mean
// sending agents most of the way round the target for no reason a player could
// see. SPACING IS THE SEPARATION PASS'S JOB; the slot just stops them all
// starting from the same line.

// Separation, the force that actually spreads a pack.
//
// Applied TANGENTIALLY when the agents are closing on something (see
// Agent::spreadAnchor): the push is projected perpendicular to each agent's own
// line to the target, so it slides them around that target instead of away from
// it. That projection is what allows a useful strength here at all -- an
// omnidirectional push has to stay tiny, because the component pointing away
// from the target shoves agents back out of melee range, and a chasing agent
// then spends its next step undoing the spread. Perpendicular force cannot cost
// forward progress, so it can be strong enough to see.
//
// It also stays useful at contact, where the goal velocity is zero and this is
// the only force acting: a crowd pressed against a player slides around them
// into a ring rather than piling on one point.
static constexpr float AGENT_SEPARATION_MAX = 9.0f;   // units per tick
static constexpr float AGENT_SEPARATION_GAIN = 0.35f; // fraction of the shortfall
// Personal space is wider while closing than while fighting: a pack should
// arrive on a broad front, then be allowed to crowd in once it is on the target.
// Any spread bought during the approach is free -- there is room out there --
// whereas insisting on it at contact just holds agents out of reach.
static constexpr float AGENT_SEPARATION_APPROACH_SCALE = 1.7f;

// --- Sharing a base's walls out among the pack ------------------------------
//
// Separation spreads bodies that are already at the same target. It cannot
// spread a pack across DIFFERENT targets, and a base is many targets: each wall
// is its own tile-wide object, so "nearest hostile object" is the same object
// for every agent arriving from the same side. They all latch it, and
// stickiness -- deliberately -- never swaps one wall for another wall. In play
// that is a queue: two ghouls chewing, a dozen standing behind them with
// nothing to reach, and the other sides of the base untouched.
//
// So a thing that already has attackers is RANKED as though it were further
// away. Below its capacity there is no penalty at all (converging on one face
// is what a pack is for); past it, each extra attacker adds this fraction of
// the real distance, which is enough to send the next arrival to the wall next
// door. Nothing here is coordinated -- an agent reads a count and decides for
// itself, exactly like the surround slot.
static constexpr float AGENT_CROWD_DISTANCE_PENALTY = 1.0f;

// How many attackers a thing holds before that penalty starts, derived from its
// own geometry: a QUARTER of its perimeter per body diameter. A quarter rather
// than the whole because a wall in a wall is reachable from one side and not
// four, and over-estimating here is precisely what leaves a queue standing.
static constexpr uint16_t AGENT_CROWD_CAPACITY_MAX = 8;

// Calling for help: an agent that spots a target first-hand, or that gets hit,
// hands that target to nearby agents of its own family. The alert radius is the
// shouting agent's own `vision`, so it is already tuned per type in agents.xml.
//
// Alerted agents do NOT re-broadcast, and that needs no flag: only the ACQUIRE
// branch of findAgentTarget shouts, and an agent handed a target never reaches
// that branch -- the sticky-target path returns first. Without that property one
// shot would ripple across the map in hops. The cooldown bounds how often one
// agent can shout after repeatedly losing and re-finding the same player.
//
// Alerts go through the same eligibility rules as sight (Game::isAgentHostileTo), so
// being shouted about cannot strip a freshly spawned player of the survival
// grace period that keeps agents off them.
static constexpr uint32_t AGENT_ALERT_COOLDOWN_MS = 3000;

// How often an agent sweeps for NON-PLAYER targets (rival bots, buildings).
// Players are still checked every tick against the player table, which is small
// and already indexed, so nothing about noticing a player got slower. The lower
// tiers need a tile sweep over `vision` -- a 15x15 box for a ghoul -- which is
// exactly what must not run per agent per tick. Neither a wall nor a parked bot
// is going anywhere, so a second of latency on them is invisible.
static constexpr uint32_t AGENT_TARGET_SCAN_MS = 1000;

// How long after landing a hit a world-spawned agent still counts as fighting
// that side. A player's bots engage a monster only once it has turned on them
// (Game::isAgentTargeting), and its target alone is too twitchy an answer: it
// holds none at all between one being destroyed and the next being found, and
// it swings at whatever is in reach while walking to something else. Long
// enough to bridge both without keeping bots hostile to something that has
// plainly gone off to fight elsewhere.
static constexpr uint32_t AGENT_AGGRESSION_MEMORY_MS = 8000;

// Rank of a target KIND, smaller is better. Not a score to compare against
// <target priority> -- those order agent-vs-object only, inside one tier. This
// exists so "what I already have" and "what I have just found" can be ranked
// against each other at all, which is what keeps a sticky target from pinning an
// agent to something worse than what is now in front of it.
enum AgentTargetTier : int {
	AGENT_TIER_PLAYER = 0,
	AGENT_TIER_AGENT  = 1,
	AGENT_TIER_OBJECT = 2,
	AGENT_TIER_NONE   = 3, // no target at all: worse than any of them
};

// Chase where the target WILL be, not where it is. Capped hard: a jinking player
// produces a wildly swinging velocity estimate, and an agent that trusted it
// fully would swerve about instead of closing. This is enough to stop a melee
// agent being permanently one step behind someone strafing, and no more.
static constexpr float AGENT_LEAD_MAX_SECONDS = 0.35f;
// Exponential smoothing on the measured target velocity. Position deltas at 20Hz
// are noisy; without this the lead vector jitters every tick.
static constexpr float AGENT_LEAD_SMOOTHING = 0.7f;

// Consecutive movement ticks with no progress toward its goal before an agent
// gives up on walking straight at it and asks for a route around. ~0.4s at 20Hz.
//
// Chasing is straight-line FIRST and pathfinds only on this signal. The
// alternative -- testing line-of-sight every so often and picking a mode from
// the geometry -- flips as the agent shifts a few pixels near an obstacle, and
// an A* route can point sideways or backwards relative to the target, so the
// agent visibly alternated between walking at the player and walking away.
// "Have I actually stopped making progress" is latched and hysteretic, so it
// cannot flip that way.
static constexpr uint16_t AGENT_STUCK_TICKS = 8;

// --- Dodging bullets -------------------------------------------------------
//
// Per agent type, because it is a characterisation: a fast ghoul jinks, an
// armoured one walks through it, a bolted-down repair drone cannot move at all.
// Off unless agents.xml says otherwise.
//
// The whole feature is ONE sidestep: a lateral velocity added to whatever the
// agent was already doing for `durationMs`, so it keeps closing on its target
// while it slides. Nothing here interrupts a brain, a chase or a path -- a
// dodge that could cancel the walk would read as the agent stopping to flinch.
//
// Detection is driven from the BULLET, not from the agent (Game::updateAgentDodges):
// one pass over the live projectiles, each looking down its own path for agents
// it is about to hit. The other direction -- every agent sweeping tiles for
// projectiles -- is the per-agent-per-tick spatial query this codebase keeps
// removing, and it would cost the same whether anything was being shot at or
// not.
struct AgentDodge {
	bool enabled = false;
	// Probability of reacting to an incoming shot at all, rolled ONCE per
	// reaction window (a declined roll blocks the next for `reactionMs`, so a
	// bullet cannot be re-rolled at 20Hz on its way in and turn any chance
	// below 1 into a certainty). Below 1 is what makes dodging a trait rather
	// than an aimbot.
	float chance = 1.0f;
	// How late the agent notices: it reacts only once the hit is due within
	// this long. Also the look-ahead the bullet pass searches, so a big value
	// costs a wider corridor scan per projectile.
	uint32_t reactionMs = 250;
	// Lateral speed, world units per second. 0 = the agent's own move speed.
	uint16_t speed = 0;
	// How long one sidestep lasts. Under `reactionMs` and the agent stops
	// moving before the bullet arrives.
	uint32_t durationMs = 300;
	// From the START of one dodge to the earliest next: what stops an agent
	// strafing continuously under automatic fire.
	uint32_t cooldownMs = 1200;
	// Extra width on the body when deciding "this shot will hit me". 0 means it
	// only reacts to shots actually on line; a positive value makes it flinch
	// away from near misses too.
	uint16_t margin = 0;
};

// --- Roaming ---------------------------------------------------------------
//
// Defaults for a world-spawned agent with nothing to chase, used when
// agents.xml does not override them. A player-BUILT agent never roams: it holds
// or returns to the spot its owner placed it (see runAgentBrain).
//
// A wander leg is a straight walk to a point the picker has PROVEN this agent's
// body can reach: Game::agentClearRun casts the body along the candidate
// bearing and the leg ends inside the clear run. The previous picker threw a
// dart at a random point up to fifteen tiles away and validated nothing, which
// is where roaming's stop-start came from -- a large share of legs ended inside
// a rock, behind one, or in the band along the map edge that a body of `radius`
// can never enter, and the agent stood pressed against the obstacle at zero
// wire speed until the leg timed out. Everything below exists to keep a
// roaming agent walking continuously.
static constexpr uint16_t AGENT_DEFAULT_ROAM_RADIUS = 1500;  // how far each wander leg goes
// Standing still between legs. Zero by default: legs are chained on the tick
// the previous one ends, so a roaming agent never reports a zero wire speed
// mid-patrol and the client never drops it into its idle animation. A type that
// wants a visible pause sets roamPauseMs in agents.xml.
static constexpr uint32_t AGENT_DEFAULT_ROAM_PAUSE_MS = 0;

// How close counts as "arrived" for a wander leg. Deliberately generous -- over
// half a tile -- because the end of a leg is a suggestion, not a destination
// that matters: an agent deflected by an obstacle slide, by separation from
// another agent or by knockback easily finishes a few tens of units wide of the
// point, and at the old 20-unit tolerance it never registered the arrival and
// burned the whole leg deadline standing next to it.
static constexpr int64_t AGENT_ROAM_ARRIVE_SQ = 60 * 60;

// Bearing of a new leg, relative to the last one: sector * TURN, plus jitter.
// Legs that carry on roughly the way the agent was already going are what makes
// roaming read as walking somewhere. A fresh uniform-random bearing every leg
// (the old behaviour) turned through more than a right angle half the time, so
// even a leg that worked perfectly looked like the agent stopping to change its
// mind.
static constexpr float AGENT_ROAM_TURN = 1.047f;   // 60 degrees per fan sector
static constexpr float AGENT_ROAM_JITTER = 0.35f;  // +/- 20 degrees

// Stop a leg this far short of whatever ended its clear run, so the agent
// finishes in the open and turns from there instead of arriving with its nose
// against a rock.
static constexpr float AGENT_ROAM_BACKOFF = 90.0f;
// A leg shorter than this is not worth walking; the picker keeps trying other
// bearings for one that is.
static constexpr float AGENT_ROAM_MIN_LEG = 250.0f;
// Boxed in on every bearing (spawned inside geometry, or standing in a pocket):
// walk this far toward the least blocked one anyway. Standing still would be
// permanent -- moving is what changes the situation, and the movement layer can
// walk a body out of something it is embedded in.
static constexpr float AGENT_ROAM_ESCAPE_LEG = 150.0f;

// --- Roaming: the journey --------------------------------------------------
//
// A roaming agent is always travelling to some far point of the map, and a leg
// is just the next straight stretch of that journey: each one is aimed at the
// destination, and fans away from it only as far as it must to get round
// whatever is in the way. Legs on their own are a random walk, which keeps an
// agent milling around wherever it spawned -- it never covers the map, and to
// anyone watching one it looks like it is pacing rather than going anywhere.
//
// Navigation toward the destination is greedy (aim, walk the clear run, re-aim)
// rather than a planned route: A* across a 655-tile map is not affordable per
// agent, and it is not needed, because nothing depends on the agent arriving.
// A destination it cannot reach costs nothing but a timeout, and it walks the
// whole time it is failing.
static constexpr int64_t AGENT_ROAM_DEST_ARRIVE_SQ = 300 * 300;  // 3 tiles
// Minimum journey length, so a destination is always a trek across country
// rather than the next field over.
static constexpr float AGENT_ROAM_DEST_MIN_DIST = 6000.0f;       // 60 tiles
static constexpr int32_t AGENT_ROAM_DEST_TRIES = 12;
// Journey deadline: three times the straight-line travel time, so a route that
// has to go around plenty still has room, clamped to keep both a destination
// next door and one across the map sane.
static constexpr uint32_t AGENT_ROAM_DEST_TIMEOUT_MIN_MS = 30000;
static constexpr uint32_t AGENT_ROAM_DEST_TIMEOUT_MAX_MS = 240000;

// Wander legs abandoned in a row before the DESTINATION is blamed and replaced.
// Low on purpose: a leg that fails is already 0.4s of an agent pressing on
// something, and a destination is only ever a suggestion.
static constexpr uint8_t AGENT_ROAM_FAIL_LIMIT = 3;

// Cost, in world units of leg length, of each 60-degree sector a leg is turned
// away from the destination. Turning off course has to be worth something, or
// the agent takes any long leg over a slightly shorter one that actually goes
// where it is going, and wanders in circles near obstacles.
static constexpr float AGENT_ROAM_SECTOR_PENALTY = 250.0f;

// Leg deadline = twice the time the leg should take, plus this slack, capped.
// Scaling it to the leg is the point: a validated straight leg of known length
// walked at a known speed has a known duration, so much past it means the leg
// stopped working and the agent belongs somewhere else. The old flat 8s was
// mostly spent standing against whatever the unvalidated goal was buried in.
static constexpr uint32_t AGENT_ROAM_TIMEOUT_SLACK_MS = 1500;
static constexpr uint32_t AGENT_ROAM_TIMEOUT_MAX_MS = 15000;

// Body scale A* tests the tile grid with. Must be >= 1: the pathfinder has to
// be at least as strict as the movement layer, or it hands back routes through
// gaps the agent cannot physically enter, and the agent wedges in the mouth of
// one re-planning the same impossible route forever. Slightly over 1 buys a
// margin for the fact that the grid only samples tile CENTRES, so the real path
// between two centres can clip a corner the centres themselves clear.
static constexpr float AGENT_PATH_RADIUS_MARGIN = 1.05f;

// How far the pathfinder will let a body be shoved sideways by the geometry
// while it works out whether a step is walkable.
//
// The counterpart to the margin above, and it is what lets an agent know it
// fits. Being strict at a POINT is not the same as being strict about the
// CORRIDOR: a tile grid samples tile centres and the steps between them, and
// the centre line of a real gap between two resources almost never lands on
// one. Demanding that those exact points be clear rejects gaps the agent walks
// through comfortably -- so it takes the long way round an opening the player
// just used, which is the whole "it does not know it fits" complaint.
//
// The planner therefore does not test points at all. It walks the agent's body
// along each step and lets it GLIDE, running the same push-out the movement
// layer runs, and asks whether the body comes out the other side. Two round
// surfaces push a body to the middle of the passage between them, so a gap
// wider than the body always resolves and a gap narrower than it never does --
// which is exactly the question, answered from the body radius in agents.xml.
// This slide cap is the sanity bound on that: a body shoved further than this
// to find room has not glided through anything, it has been squirted out of the
// gap sideways, and that is not a step it can walk.
//
// Half a tile, and deliberately tied to the GRID rather than to the body: it
// exists to cover how far a real passage can lie from the line between two tile
// points, which is a property of the grid. Every point in a cell is within this
// of that cell's centre, so no corridor can hide from the search between two
// samples of it.
static constexpr float AGENT_PATH_MAX_SLIDE = 50.0f;

// How far ahead an agent walking straight at something checks that the way is
// actually clear. Roughly two and a half tiles: far enough to start going round
// before it arrives, short enough that it is not re-deciding over ground it may
// never cover. See Game::agentChase.
static constexpr float AGENT_LOOKAHEAD = 250.0f;

// --- Reachability is part of being a TARGET AT ALL --------------------------
//
// An agent must not select something it cannot get to. A repair bot sealed
// inside a base would otherwise latch onto damaged property OUTSIDE the walls
// -- it is the nearest damaged thing, and nothing about "damaged and mine"
// mentions whether a body can travel there -- walk to the wall, and stop. The
// job being sticky then makes it permanent: it stares through the wall while
// damage beside it goes unrepaired.
//
// The fix is NOT to notice the stall and recover from it. It is that an
// unreachable object is not a candidate, so it never enters the list and the
// bot never turns toward it. `Game::canAgentReach` is the eligibility test, and
// it is exact: a clear straight run, or an A* route, or it is not a target.
//
// Everything below exists to make that test affordable, not to soften it.

// Selection is throttled and staggered per agent. Reachability is the only
// expensive question an idle bot asks, and asking it 20 times a second per bot
// is what would make the exact test unaffordable. A damaged wall is not
// urgent to the tick.
static constexpr uint32_t AGENT_JOB_SCAN_MS = 1000;

// Verdict cache. A bot that has just proved it cannot reach something must not
// re-prove it a second later -- that is the whole cost of the feature, paid
// repeatedly for an answer that rarely changes. Expiry, because reachability is
// a property of the world and the world changes: open a gate and the bot
// notices within this long.
static constexpr uint32_t AGENT_UNREACHABLE_MEMORY_MS = 30000;

// How many verdicts a bot remembers at once. Fixed and small: there may be
// hundreds of these bots, and forgetting the oldest costs one more test.
static constexpr size_t AGENT_UNREACHABLE_SLOTS = 4;

// The same verdict about something that MOVES expires far sooner. A wall stays
// where it is, so 30s of remembering is free; a player is unreachable only for
// as long as they stay inside whatever they ran into, and an agent that
// remembered that for half a minute would ignore them standing in the open. Not
// so short that it re-proves the same sealed building every second.
static constexpr uint32_t AGENT_UNREACHABLE_MOVER_MS = 4000;

// The verdict a STALLED CHASE writes, which is a different kind of answer from
// the two above and needs its own clock.
//
// canAgentReach cannot see this case at all: creatures are transparent to the
// planner (deliberately -- a body yields, so routing around one would have
// every agent re-planning as the pack shuffles), so a wall with a dozen ghouls
// packed against it is "reachable" by every measure the search has. The only
// evidence that the ghoul at the back is never going to touch it is that it has
// stood in one place not touching it -- see AGENT_STALL_MS.
//
// Deliberately LONGER than that stall window. An agent that gives up on a target
// it can still see will re-acquire it the moment this expires, so the two
// numbers set the ratio between pressing uselessly and doing something useful
// instead; this one wants to be the bigger of the pair.
static constexpr uint32_t AGENT_UNREACHABLE_CROWD_MS = 10000;

// --- Standing there doing nothing -------------------------------------------
//
// A chasing agent that has not LEFT A SPOT and has not LANDED A HIT for this
// long has given up in every sense but the bookkeeping, so the bookkeeping
// catches up: it drops the target, remembers it for AGENT_UNREACHABLE_CROWD_MS
// and re-scans at once -- which normally means it turns on the wall in front of
// it instead of queueing behind the pack.
//
// Displacement is the signal, and it has to be, because the two things that
// actually block a base assault are invisible to everything else:
//
//   * ANOTHER AGENT in the doorway. Creatures are transparent to the planner on
//     purpose (a body yields, so routing round one would have the whole pack
//     re-planning every time it shuffled), so canAgentReach answers Yes, every
//     scan, forever.
//   * geometry the search cannot solve from here, where A* keeps handing back a
//     route that stalls. That case oscillates -- search succeeds, route stalls,
//     search succeeds -- so counting agentChase's verdicts never accumulates.
//     Where the agent IS does not oscillate.
//
// It cannot misfire on the two states that look identical from the movement
// side and are perfectly healthy: an agent chasing a fleeing player MOVES, and
// an agent demolishing a wall HITS (see AGENT_TARGET_ENGAGED_MS -- a square wall
// never satisfies the contact threshold, so a wall-chewer sits in the chase
// branch making no progress by construction).
static constexpr uint32_t AGENT_STALL_MS = 4000;
// How far it has to get from where the clock started for the clock to restart.
// Comfortably over the jitter separation and push-out produce inside a crowd,
// well under a body diameter, so genuine walking always clears it.
static constexpr float AGENT_STALL_MOVE_MIN = 48.0f;

// How recently a hit has to have landed for an agent to count as engaged with
// its target, which VETOES the rule above.
//
// It has to, because "no progress" is the normal steady state of an agent doing
// its job on a building. Its aim is the ring slot it is already standing on, so
// it cannot get closer by construction; and a square wall never satisfies the
// contact threshold either (agentTargetExtent reports the half-extent, and
// closeDistance sits inside that), so it never latches and stops. A ghoul
// demolishing a wall therefore reports "this goal has stopped working" for as
// long as the wall stands. What separates it from the ghoul queued behind it is
// not where either of them is -- it is that one of them is landing hits.
//
// Comfortably over any attack cooldown in agents.xml, so a slow swing does not
// read as a lull.
static constexpr uint32_t AGENT_TARGET_ENGAGED_MS = 3000;

// Default for <brain repelBreakMs>: how long hitting one member of an agent
// type cancels a repellent for that whole type. A minute -- long enough that
// picking a fight through a ghoul repellent is a real decision, short enough
// that one stray shot does not spend the rest of the drug.
static constexpr uint32_t AGENT_REPEL_BREAK_DEFAULT_MS = 60000;

// Backstop for a job that was reachable when it was taken and stopped being so
// on the way (someone walled it off mid-walk). Nothing can pre-empt that, so it
// is the one case that must be recovered from rather than prevented. Reset
// every time the bot lands a repair.
static constexpr uint32_t AGENT_JOB_TIMEOUT_MS = 20000;

struct AgentData {
	std::string key;
	std::string family;
	uint8_t sprite = 0;      // clientAiId: index into client.js AI[]

	// body
	uint16_t radius = 0;
	// Does this agent block movement (players, projectiles, world geometry)?
	// Independent of `separation` below: `collision` governs everything ELSE
	// running into this agent, `separation` governs agents running into each
	// other.
	bool collision = true;
	// Crowd behaviour. With separation on, an agent steers away from other
	// agents so a pack spreads around its target instead of piling into one
	// point (ghouls). With it off, any number may occupy the same spot and the
	// O(neighbours) spread loop is skipped entirely -- which is what makes a
	// hundred bots standing on one tile affordable (lapabots).
	bool separation = true;
	uint16_t separationRadius = 0;  // desired spacing; 0 = 2 * radius

	// Does this agent's body block OTHER AGENTS? Independent of `collision`
	// again: false here leaves it solid to players, bullets and geometry while
	// every agent walks through it. The narrower version of the same idea is
	// `stackGroup` below -- transparent to its OWN kind only -- and that is the
	// one most types want; this is for a body that should never be in another
	// agent's way at all.
	//
	// It also turns off `separation` against those agents, and must: separation
	// is the soft half of the same question, and a body nothing collides with
	// that still shoves its neighbours around is not a coherent thing to be.
	bool agentCollision = true;
	// Agents sharing a non-zero stack group pass through each other and never
	// push each other apart, while staying solid to everything else -- players,
	// other agent types, world geometry. Interned from <body stackGroup="name">
	// at load so the test is an int compare, because it runs per neighbour per
	// agent per tick inside a pile.
	//
	// This is what a hundred lapabots standing on one spot needs, and it cannot
	// be done with `collision` or `separation`: both are unary properties of one
	// agent, and "solid, except to my own kind" is a property of the PAIR.
	// 0 = no stacking (the default): normal collision with everything.
	uint16_t stackGroup = 0;

	// vitals
	uint16_t health = 0;
	uint32_t experience = 0;  // XP granted on kill (client calls this "score")
	uint32_t lifetimeMs = 0;

	// <resistances>: fraction of incoming damage of a kind shrugged off, 0..1,
	// the same semantics as the player's wearable ...Resistance modifiers (a
	// 0.4 melee resistance turns 20 melee damage into 12). Applied in ONE
	// place, Agent::changeHealth, off the kind the call site declares.
	float meleeResistance = 0.0f;
	float piercingResistance = 0.0f;
	float explosionResistance = 0.0f;
	float energyResistance = 0.0f;

	float resistanceFor(AgentDamageKind kind) const
	{
		switch (kind) {
			case AgentDamageKind::Melee: return meleeResistance;
			case AgentDamageKind::Piercing: return piercingResistance;
			case AgentDamageKind::Explosion: return explosionResistance;
			case AgentDamageKind::Energy: return energyResistance;
			default: return 0.0f;
		}
	}

	// <resistances><condition key="toxic_poison" fraction="1"/></resistances>:
	// what this agent shrugs off from CONDITIONS, as opposed to from damage. A
	// fraction shrinks the duration and 1.0 is outright immunity -- the same
	// semantics everywhere, so a robot that cannot be poisoned and armour that
	// halves it are one vocabulary.
	//
	// A map rather than fields because the set of conditions is content, not
	// code: agents.xml may name anything conditions.xml defines.
	std::unordered_map<std::string, float> conditionResistances;
	// The blanket form, <resistances conditions="0.5">: everything lasts less.
	float allConditionResistance = 0.0f;

	float conditionResistanceFor(const std::string& key) const
	{
		float letThrough = 1.0f - allConditionResistance;
		auto it = conditionResistances.find(key);
		if (it != conditionResistances.end()) {
			letThrough *= (1.0f - it->second);
		}
		return 1.0f - letThrough;
	}

	// <areaEffects>: fields this agent EMITS while alive (radiation being the
	// point -- a radioactive ghoul irradiates like a radioactive structure).
	// Exactly the object/resource schema and machinery: parsed by the shared
	// xml_utils::appendAreaEffects (which also feeds g_maxAreaEffectTileReach,
	// so the gauge scan's tile box widens automatically), consumed by the
	// player gauge scan. Environment effects stay players-only, deliberately:
	// an agent aura hurts players, never other agents.
	std::vector<AreaEffect> areaEffects;

	// daylight sun-damage (ghoul biology); robots omit the <daylight> node
	bool daylightEnabled = false;
	uint16_t daylightDamage = 0;
	uint32_t daylightIntervalMs = 0;

	// movement (world units per second; same scale as player speed).
	// ONE speed, not a range: a per-instance random pick made two agents of the
	// same type behave differently for no gameplay reason and made the wire
	// speed harder to reason about. `nightSpeed` is the (usually higher) speed
	// used while g_game.isNight(); 0 means "same as day".
	uint16_t speed = 0;
	uint16_t nightSpeed = 0;

	// brain
	AgentBrainType brain = AgentBrainType::None;
	// Sensing uses TWO radii on purpose. `vision` acquires a target; the agent
	// then keeps it until the player passes `loseTarget`, which is deliberately
	// wider. With a single radius a player standing near it is seen on one tick
	// and lost on the next, so the agent alternates "run at the player" with
	// "walk back home" 20 times a second.
	uint16_t vision = 0;
	uint16_t loseTarget = 0;  // 0 = vision * AGENT_LOSE_TARGET_FACTOR
	uint16_t leash = 0;       // max distance from home before it gives up and returns
	// false: never pursues. Holds its ground and hits whatever walks into
	// reach (guard bots). Skips pathfinding and line-of-sight entirely.
	bool chase = true;
	// Wander tuning for world-spawned agents; 0 = use the AGENT_DEFAULT_ROAM_*
	// values. Whether an agent roams at all is decided by ownership, not here.
	uint16_t roamRadius = 0;
	uint32_t roamPauseMs = 0;

	// <dodge>: sidestep incoming fire. Absent from the XML = never dodges.
	AgentDodge dodge;

	// How long a player must have SURVIVED before this agent type will hunt
	// them unprovoked, so a fresh spawn is not immediately swarmed. Expressed
	// either in day/night cycles (preferred -- it scales with the mode's own
	// clock) or in flat minutes. 0/0 = hostile from the moment you spawn.
	//
	// Attacking an agent bypasses this entirely: see Player::provokeAgentType.
	// Only applies to world-spawned agents; a player-BUILT agent picks targets
	// by ownership instead (see Game::findAgentTarget).
	uint16_t aggroAfterCycles = 0;
	uint16_t aggroAfterMinutes = 0;

	// <brain repelBreakMs="...">: how long hitting one member of this type
	// cancels a repellent (conditions.xml <repel>) for the WHOLE type.
	//
	// Same idea as provokeAgentType above and the same scope -- you started a
	// fight with this type, so this type is coming -- but on a clock rather than
	// for the life of the character, because a repellent is a thing you paid for
	// and a temper is supposed to cool. The rest of the repelled family is
	// untouched: shoot a normal_ghoul and normal_ghouls come for you while the
	// fast and armoured ones keep walking past.
	//
	// Deliberately NOT aggroAfterMs: that number is a spawn-protection window
	// measured in day/night cycles, and it is legitimately 0 for the ghouls, so
	// reusing it would make hitting one do nothing at all.
	uint32_t repelBreakMs = AGENT_REPEL_BREAK_DEFAULT_MS;

	// Resolved against the active mode's day/night cycle length, since that is
	// what "one cycle" means and it is per-mode.
	uint64_t aggroAfterMs(uint32_t dayNightCycleMs) const
	{
		if (aggroAfterCycles > 0) {
			return static_cast<uint64_t>(aggroAfterCycles) * dayNightCycleMs;
		}
		return static_cast<uint64_t>(aggroAfterMinutes) * 60000ull;
	}
	std::vector<AgentTarget> targets;

	std::vector<AgentAbility> abilities;

	// onDeath
	std::vector<ItemDrop> drops;
	AgentExplosion explosion;

	// Resolved spacing for the separation pass (separationRadius, or 2*radius).
	float spacing() const
	{
		return separationRadius > 0 ? static_cast<float>(separationRadius)
		                            : static_cast<float>(radius) * 2.0f;
	}

	// The <target> entry for a kind of thing, or nullptr if this agent does not
	// engage that kind at all.
	const AgentTarget* findTarget(AgentTargetType type) const
	{
		for (const AgentTarget& t : targets) {
			if (t.type == type) return &t;
		}
		return nullptr;
	}

	// The first ability of a kind, or nullptr. Abilities are addressed by type
	// rather than by index so a brain asks for what it needs (Repair) and the
	// XML decides whether the agent has one.
	const AgentAbility* findAbility(AgentAbilityType type) const
	{
		for (const AgentAbility& a : abilities) {
			if (a.type == type) return &a;
		}
		return nullptr;
	}

	// Range at which an acquired target is dropped. Always >= vision, so the
	// acquire/lose pair can never collapse back into a single radius.
	uint16_t loseTargetRange() const
	{
		if (loseTarget >= vision) {
			return loseTarget;
		}
		return static_cast<uint16_t>(static_cast<float>(vision) * AGENT_LOSE_TARGET_FACTOR);
	}
};

// --- World spawning (Game::updateAgentSpawns) ------------------------------
//
// How much of the NIGHT the population takes to fill, as a fraction. This is
// the whole shape of the feature: spawning the night's full complement at dusk
// would drop a wall of ghouls on the map in one frame, but trickling them in
// over the whole night means the last ones spawn just in time to burn at dawn
// and nothing they do ever lands. A third of the night gets them out and
// hunting with the bulk of the dark still ahead of them.
//
// A fraction rather than a rate, so it holds whatever the mode's dayNightCycle
// is and whatever maxTotal is set to: change either and the ramp still finishes
// in the same part of the night.
static constexpr float AGENT_SPAWN_FILL_FRACTION = 0.33f;

// Fallback cadence when modes.xml omits respawnDelayMs. Only controls how lumpy
// the trickle looks -- how MANY spawn per tick is derived from the fill
// fraction, so a shorter period means smaller, more frequent batches, not a
// faster fill.
static constexpr uint32_t AGENT_SPAWN_DEFAULT_PERIOD_MS = 2000;

// Never drop an agent closer than this to any player. Comfortably outside ghoul
// `vision` (700), so one cannot appear already hunting someone: they spawn out
// in the dark and have to find you. Also the difference between atmosphere and
// something materialising at your shoulder.
static constexpr int32_t AGENT_SPAWN_MIN_PLAYER_DIST = 1200;

// Placement attempts per agent before giving up for this tick. The next tick is
// seconds away and the population target is unchanged, so a failure costs
// nothing but a slightly slower ramp on a very crowded map.
static constexpr int32_t AGENT_SPAWN_PLACE_TRIES = 24;

// Highest sprite id the client can render: client.js AI[] holds 9 entries
// (0-8), and _EntitieAI indexes AI[extra & 15], so 15 is the hard ceiling and
// 8 the last defined one. New agents must reuse a sprite in this range until
// client.js gains more.
static constexpr uint8_t AGENT_MAX_CLIENT_SPRITE = 8;

// Wire entity type for agents: client.js __ENTITIE_AI__ (see COUNTER_ENTITIE).
static constexpr uint8_t ENTITY_TYPE_AI = 13;

// A live agent on the map. Non-player Creature, so the map layer already treats
// it as mobile and gives it a type-13 UID pool slot (Map::resolveUidType). Its
// stats live in the shared AgentData; the instance owns only per-entity state.
class Agent final : public Creature
{
public:
	explicit Agent(const AgentData* data);
	~Agent() override = default;

	Agent(const Agent&) = delete;
	Agent& operator=(const Agent&) = delete;

	Agent* getAgent() override { return this; }
	const Agent* getAgent() const override { return this; }

	// Creature pure virtuals
	const std::string& getName() const override { return name; }
	CreatureType_t getType() const override { return CREATURETYPE_MONSTER; }
	// The runtime id is assigned by AgentManager::createAgent (via setRuntimeId)
	// before placement, so the generic Game::internalPlaceThing setID() call is a
	// no-op here.
	void setID() override {}

	// Assigns the full 32-bit banded id. Creature keeps its OWN `id` field (what
	// getID() returns, and what Map keys on), separate from Thing's id16/uid8
	// (what the wire uses), so both must be set. Thing::setID sets id16/uid8;
	// this also updates Creature::id.
	void setRuntimeId(uint32_t fullId);

	// Emits the type-13 (__ENTITIE_AI__) wire record instead of Creature's
	// player/monster branches.
	void buildUpdate(EntityUpdate& out) const override;

	const AgentData* getData() const { return data; }
	uint8_t getSprite() const { return data ? data->sprite : 0; }

	uint16_t getHealth() const { return health; }
	void setHealth(uint16_t hp) { health = hp; }

	// --- Brain / movement state ---
	// Agents report their raw movement speed to the wire (state high byte) rather
	// than running Creature::getSpeed's per-tile object scan every frame.
	uint16_t getSpeed() const override { return speed; }

	// The agent's configured movement speed, boosted at night when agents.xml
	// gives it a nightSpeed. Defined in agent.cpp because it asks Game for the
	// world clock.
	uint16_t getMoveSpeed() const;

	// An own-side trap's slow applies at HALF strength to this agent (user
	// rule 2026-07-27): a player's defences hinder their own bots less. Enemy
	// and world traps apply in full, and a world-spawned agent gets no
	// discount anywhere (owner 0 is not a side). Defined in agent.cpp; it asks
	// Game for the side comparison.
	float tileSlowScaleFor(const Object* obj) const override;

	// --- Conditions -----------------------------------------------------------
	//
	// An agent has ONE gauge -- its health pool -- so a condition that drains
	// food or stamina simply has nothing to drain here. That is a real answer,
	// not a gap: the same <condition> can then be written once and applied to
	// anyone, and a poison that also starves you starves only the things that
	// can starve.
	void applyConditionTick(GaugeSlot slot, int16_t amount, uint32_t inflictorGuid) override;

	// A lethal tick deletes the agent, so nothing may touch it afterward -- the
	// shared tick loop asks this between ticks and stops.
	bool conditionTicksShouldContinue() const override { return !dying; }

	// The agent side of "what do you shrug off": its agents.xml <resistances>
	// answer for named conditions on top of whatever <resist> it is running.
	float conditionResistanceFor(const std::string& key) const override;

	const Position& getHomePos() const { return homePos; }
	void setHomePos(const Position& p) { homePos = p; }

	// GUID of the player who built this agent; 0 = spawned by the world.
	//
	// Agents that share a non-zero owner ignore each other's personal space, so
	// one builder can pack a hundred bots onto a single spot while a rival's
	// bots are still pushed apart. This does NOT affect `collision`: an owned
	// bot is still solid to every player, including its owner.
	uint32_t getOwnerGuid() const { return ownerGuid; }
	void setOwnerGuid(uint32_t guid) { ownerGuid = guid; }

	// Knockback: hits add an impulse consumed (with decay) by the agent movement
	// pass, the same model player recoil uses -- including the per-window budget
	// (see KnockbackBudget), so a ghoul surrounded by bots is no more launchable
	// than a player surrounded by ghouls.
	void applyKnockback(float dx, float dy)
	{
		// <knockbackResist fraction=>, exactly as Player::applyKnockback applies
		// it: one body being heavier than another, as opposed to the shared
		// per-window budget below.
		const float letThrough = conditions.totals().knockbackLetThrough;
		if (letThrough <= 0.0f) return;
		dx *= letThrough;
		dy *= letThrough;

		const float mag = std::sqrt(dx * dx + dy * dy);
		const float scale = knockback.admit(mag, OTSYS_TIME());
		if (scale <= 0.0f) return;

		recoilX += dx * scale;
		recoilY += dy * scale;

		const float magSq = recoilX * recoilX + recoilY * recoilY;
		if (magSq > MAX_KNOCKBACK_RECOIL * MAX_KNOCKBACK_RECOIL) {
			const float clamp = MAX_KNOCKBACK_RECOIL / std::sqrt(magSq);
			recoilX *= clamp;
			recoilY *= clamp;
		}
	}
	float getRecoilX() const { return recoilX; }
	float getRecoilY() const { return recoilY; }
	void setRecoil(float x, float y) { recoilX = x; recoilY = y; }

	uint64_t getNextAttackAt() const { return nextAttackAt; }
	void setNextAttackAt(uint64_t t) { nextAttackAt = t; }

	// --- Repair job (brain type="repair") ----------------------------------
	// Runtime id of the object being repaired, 0 = none. STICKY for the same
	// reason the player target is: re-picking the nearest damaged object every
	// tick would make a bot standing between two damaged walls walk at each of
	// them alternately and reach neither. It holds the first one it commits to
	// until that object is whole, gone, or no longer on its side.
	uint32_t getRepairTargetId() const { return repairTargetId; }
	void setRepairTargetId(uint32_t id) { repairTargetId = id; }
	uint64_t getNextRepairAt() const { return nextRepairAt; }
	void setNextRepairAt(uint64_t t) { nextRepairAt = t; }

	// Deadline for arriving at the current job; 0 = no job. See
	// AGENT_JOB_TIMEOUT_MS.
	uint64_t getRepairDeadline() const { return repairDeadline; }
	void setRepairDeadline(uint64_t t) { repairDeadline = t; }

	// Throttle on asking the reachability question. See AGENT_JOB_SCAN_MS.
	uint64_t getNextJobScanAt() const { return nextJobScanAt; }
	void setNextJobScanAt(uint64_t t) { nextJobScanAt = t; }

	// Cached "cannot get there" verdicts. See AGENT_UNREACHABLE_MEMORY_MS.
	bool knownUnreachable(uint32_t objId, uint64_t now) const
	{
		for (const Unreachable& u : unreachable) {
			if (u.id == objId && now < u.until) return true;
		}
		return false;
	}
	void noteUnreachable(uint32_t objId, uint64_t now,
	                     uint32_t forMs = AGENT_UNREACHABLE_MEMORY_MS)
	{
		// Refresh this object's entry if it has one, otherwise take the slot
		// expiring soonest -- the least useful thing still remembered.
		size_t slot = 0;
		for (size_t i = 0; i < AGENT_UNREACHABLE_SLOTS; ++i) {
			if (unreachable[i].id == objId) {
				slot = i;
				break;
			}
			if (unreachable[i].until < unreachable[slot].until) slot = i;
		}
		unreachable[slot].id = objId;
		unreachable[slot].until = now + forMs;
	}

	// Drops the current job. `remember` records it as unreachable, for the one
	// case selection cannot prevent: it was reachable when taken and something
	// closed the way afterwards.
	void abandonRepairJob(uint64_t now, bool remember)
	{
		if (remember && repairTargetId != 0) {
			noteUnreachable(repairTargetId, now);
		}
		repairTargetId = 0;
		repairDeadline = 0;
		clearPath();
	}

	// --- Target engagement -------------------------------------------------
	// The target is STICKY: stored by player GUID and re-validated each tick,
	// never re-picked from scratch. Two failure modes that closes:
	//   * acquire/lose flicker at the edge of `vision` (see AgentData::vision),
	//   * "nearest player" swapping between two players at similar range, which
	//     yanked the goal back and forth just as hard.
	// 0 = no target.
	// Runtime entity id, NOT a player GUID: a target is any Thing on a hostile
	// side -- the player, their bots, their buildings -- and one id space
	// addresses all three through Map::getThingByID.
	uint32_t getTargetId() const { return targetId; }
	void setTargetId(uint32_t id)
	{
		// A fresh target starts with a clean slate: both records below describe
		// how this agent is getting on against ONE thing, and carrying either
		// across would write off a perfectly good wall on the strength of the
		// last one's queue.
		if (id != targetId) {
			targetId = id;
			lastTargetHitAt = 0;
			stallSince = 0;
		}
	}
	bool isEngaged() const { return targetId != 0; }

	// When this agent last landed a hit on the target it currently holds; 0 =
	// never. Cleared with the target, so it can only ever describe this one.
	//
	// It is the answer to a question no movement signal can settle: is the agent
	// actually GETTING at the thing it committed to? An agent chewing a wall and
	// an agent queued behind three others that are chewing it look identical
	// from the outside -- neither is moving, and neither can -- and only one of
	// them is doing its job. See AGENT_TARGET_ENGAGED_MS.
	uint64_t getLastTargetHitAt() const { return lastTargetHitAt; }
	void noteTargetHit(uint64_t now) { lastTargetHitAt = now; }

	// Where this agent was when its stall clock started, and when that was;
	// stallSince 0 = not started. See AGENT_STALL_MS.
	const Position& getStallAnchor() const { return stallAnchor; }
	uint64_t getStallSince() const { return stallSince; }
	void resetStall(const Position& pos, uint64_t now) { stallAnchor = pos; stallSince = now; }

	// Whose side this agent last landed a hit on, and how long that still counts
	// for. Read only through Game::isAgentTargeting, which is what decides
	// whether a wandering monster is a given player's bots' business at all --
	// they leave alone anything that has not turned on them. One slot, because
	// the question is "who am I fighting", and the answer is whoever it just
	// hit; a longer history would keep bots hostile to monsters that walked off
	// to fight somebody else entirely.
	uint32_t getAggressionSide() const { return aggressionSide; }
	uint64_t getAggressionUntil() const { return aggressionUntil; }
	void noteAggressionAgainst(uint32_t side, uint64_t now)
	{
		if (side == 0) return; // hit a world thing: nobody's grievance
		aggressionSide = side;
		aggressionUntil = now + AGENT_AGGRESSION_MEMORY_MS;
	}

	// Throttle on the spatial sweep for non-player targets. Players are still
	// checked every tick; see Game::findAgentTarget.
	uint64_t getNextTargetScanAt() const { return nextTargetScanAt; }
	void setNextTargetScanAt(uint64_t t) { nextTargetScanAt = t; }

	// Angle offset from the target that this agent walks toward, latched when the
	// target was acquired. See AGENT_SURROUND_STEP.
	float getSurroundAngle() const { return surroundAngle; }
	void setSurroundAngle(float radians) { surroundAngle = radians; }

	// The point a pack is closing on this tick, if any -- set by the brain before
	// it moves, read by the movement pass. Per-tick, not persistent state: it is
	// a parameter to stepAgent in all but name, kept here so it does not have to
	// be threaded through agentChase, which has no interest in it.
	//
	// With an anchor set, agents push each other TANGENTIALLY around it instead
	// of straight apart. See AGENT_SEPARATION_MAX.
	bool hasSpreadAnchor() const { return spreadAnchorSet; }
	const Position& getSpreadAnchor() const { return spreadAnchor; }
	void setSpreadAnchor(const Position& p) { spreadAnchor = p; spreadAnchorSet = true; }
	void clearSpreadAnchor() { spreadAnchorSet = false; }

	// Is this agent standing on, or walking back to, the post its owner placed
	// it on? Per-tick state like the spread anchor above -- a parameter to
	// stepAgent in all but name, set by the brain before it moves.
	//
	// It turns SEPARATION OFF. The post is a fixed point somebody chose, and
	// separation is for a pack converging on a moving target; letting the two
	// argue is a bug, not a balance: two bots placed 50 units apart want 129
	// between them (spacing x the approach scale), so the push (up to 9/tick)
	// beats the walk home (5-6/tick for a bot), the agent can never reach its
	// post, and it jitters at the equilibrium forever without ever settling.
	// Nothing else spreads agents, so this is the whole force.
	bool isOnPost() const { return onPost; }
	void setOnPost(bool v) { onPost = v; }

	// Latch for "I have arrived home"; see AGENT_HOME_ARRIVE.
	bool isHomeSettled() const { return homeSettled; }
	void setHomeSettled(bool v) { homeSettled = v; }

	// Rate limit on shouting for help. See AGENT_ALERT_COOLDOWN_MS.
	uint64_t getNextAlertAt() const { return nextAlertAt; }
	void setNextAlertAt(uint64_t t) { nextAlertAt = t; }

	// --- Target velocity, measured by this agent -------------------------
	// Player exposes no velocity, so an agent derives its target's from the
	// positions it already reads every tick. Per-agent rather than shared: it
	// costs two floats, and the agent is the only thing that wants it.
	//
	// Reset on a target change, or the first lead after switching targets is
	// computed from the distance between two different players.
	void resetTargetVelocity()
	{
		targetVelX = 0.0f;
		targetVelY = 0.0f;
		targetTracked = false;
	}
	// Feeds this tick's observation and returns the smoothed velocity in world
	// units per second.
	void observeTargetPosition(const Position& pos, float ticksPerSec)
	{
		if (targetTracked) {
			const float vx = (static_cast<float>(pos.x) - targetLastPos.x) * ticksPerSec;
			const float vy = (static_cast<float>(pos.y) - targetLastPos.y) * ticksPerSec;
			targetVelX = targetVelX * AGENT_LEAD_SMOOTHING + vx * (1.0f - AGENT_LEAD_SMOOTHING);
			targetVelY = targetVelY * AGENT_LEAD_SMOOTHING + vy * (1.0f - AGENT_LEAD_SMOOTHING);
		}
		targetLastPos = pos;
		targetTracked = true;
	}
	float getTargetVelX() const { return targetVelX; }
	float getTargetVelY() const { return targetVelY; }

	// True while the agent is parked in melee range swinging rather than
	// closing. Latched, with AGENT_REACH_HYSTERESIS of slack, so the boundary
	// cannot flip per tick.
	bool isHolding() const { return holding; }
	void setHolding(bool v) { holding = v; }

	// True while walking home after being dragged past `leash`. Held until the
	// agent is well back inside, so it cannot re-engage on the boundary.
	bool isLeashReturning() const { return leashReturning; }
	void setLeashReturning(bool v) { leashReturning = v; }

	// Client swing animation: triggered by state bit 1 (like players). Held for a
	// couple of ticks so a moving agent's per-tick position update also carries
	// the bit -- otherwise it overwrites the pulse before the client renders it.
	void triggerAttackPulse() { attackPulseTicks = 2; }

	// Decrement the one-shot pulses once per movement tick (see updateAgents).
	void tickPulses()
	{
		if (attackPulseTicks > 0) --attackPulseTicks;
		if (hitPulseTicks > 0) --hitPulseTicks;
	}

	// --- Pathfinding state (Game::agentChase / findAgentPath) ---
	// Waypoints (tile centres) from the agent toward the current goal; pathIndex
	// is the next one to reach. Recomputed on a throttle / when the goal drifts
	// off the route. Public because the Game AI code owns this behaviour.
	std::vector<Position> path;
	size_t pathIndex = 0;
	void clearPath() { path.clear(); pathIndex = 0; }

	// Earliest OTSYS_TIME() at which this agent may run another A* search. Both
	// a CPU budget and a stability property: it stops an agent that keeps
	// failing to find a route from re-searching every tick.
	uint64_t getNextRepathAt() const { return nextRepathAt; }
	void setNextRepathAt(uint64_t t) { nextRepathAt = t; }

	// Straight-line progress tracking; the sole trigger for pathfinding. See
	// AGENT_STUCK_TICKS. lastGoalDist < 0 means "no measurement yet".
	uint16_t getStuckTicks() const { return stuckTicks; }
	void setStuckTicks(uint16_t t) { stuckTicks = t; }
	int32_t getLastGoalDist() const { return lastGoalDist; }
	void setLastGoalDist(int32_t d) { lastGoalDist = d; }
	// Goal the distance above was measured against, so a goal that JUMPS (target
	// lost and it turns for home, or it acquires someone new) can discard the
	// measurement instead of reading as a stalled approach.
	const Position& getLastGoalPos() const { return lastGoalPos; }
	void setLastGoalPos(const Position& p) { lastGoalPos = p; }
	void resetStuck() { stuckTicks = 0; lastGoalDist = -1; }

	// --- Roaming (world-spawned agents with nothing to chase) ---
	// One wander leg at a time. `roamDeadline` means "give up on this leg" while
	// a goal is set, and "do not pick the next leg before this" while one is not,
	// which is what produces the pause between legs.
	bool hasRoamGoal() const { return roamGoalSet; }
	const Position& getRoamGoal() const { return roamGoal; }
	void setRoamGoal(const Position& p) { roamGoal = p; roamGoalSet = true; }
	void clearRoamGoal() { roamGoalSet = false; }
	// Drop the current leg AND allow the next one immediately. Anything that
	// interrupts roaming from outside the roam brain must use this, not
	// clearRoamGoal: the brain will not pick a new leg until the deadline
	// passes, so clearing the goal alone leaves the agent standing still for the
	// remainder of a leg it is no longer walking -- up to
	// AGENT_ROAM_TIMEOUT_MAX_MS of looking broken.
	void abandonRoamLeg() { roamGoalSet = false; roamDeadline = 0; }
	uint64_t getRoamDeadline() const { return roamDeadline; }
	void setRoamDeadline(uint64_t t) { roamDeadline = t; }

	// Bearing (radians) the current wander leg was taken on. Kept so a leg that
	// has to fan away from the destination still remembers which way the agent
	// is actually walking. See AGENT_ROAM_TURN.
	bool hasRoamHeading() const { return roamHeadingSet; }
	float getRoamHeading() const { return roamHeading; }
	void setRoamHeading(float radians) { roamHeading = radians; roamHeadingSet = true; }

	// The JOURNEY: a far point of the map this agent is currently crossing to.
	// Legs are aimed at it, so a roaming agent covers the map instead of milling
	// around its spawn. Survives a chase -- an agent that breaks off to hunt
	// someone resumes the same journey afterward. See AGENT_ROAM_DEST_ARRIVE_SQ.
	bool hasRoamDest() const { return roamDestSet; }
	const Position& getRoamDest() const { return roamDest; }
	void setRoamDest(const Position& p) { roamDest = p; roamDestSet = true; }
	void clearRoamDest() { roamDestSet = false; }
	uint64_t getRoamDestDeadline() const { return roamDestDeadline; }
	void setRoamDestDeadline(uint64_t t) { roamDestDeadline = t; }

	// Consecutive wander legs given up on before they finished. Aiming at the
	// destination and walking the longest clear run toward it is greedy, and
	// greedy navigation can walk into a concave pocket and keep re-entering it:
	// every leg is abandoned at the same back wall, and the bias toward the
	// destination points straight back in. Enough failures in a row means the
	// destination itself is the problem, not the leg. See AGENT_ROAM_FAIL_LIMIT.
	uint8_t getRoamFailures() const { return roamFailures; }
	void noteRoamFailure() { if (roamFailures < 255) ++roamFailures; }
	void resetRoamFailures() { roamFailures = 0; }

	// --- Timed effects (driven once per tick by Game::updateAgents) ---
	// OTSYS_TIME() at which this agent dies of old age; 0 = never. Ghouls set
	// lifetimeMs="0" because daylight already kills them.
	uint64_t getExpiresAt() const { return expiresAt; }
	void setExpiresAt(uint64_t t) { expiresAt = t; }

	// Next sun-damage tick while it is daytime (<daylight> in agents.xml).
	uint64_t getNextDaylightAt() const { return nextDaylightAt; }
	void setNextDaylightAt(uint64_t t) { nextDaylightAt = t; }

	// Kills the agent with no killer: no XP is awarded, but drops and any
	// onDeath explosion still happen. Used by sun-damage and lifetime expiry.
	void expire();

	// First melee ability, or nullptr.
	const AgentAbility* getMeleeAbility() const
	{
		return data ? data->findAbility(AgentAbilityType::Melee) : nullptr;
	}

	// Applies damage (healthDelta < 0) from `attacker`. On a non-lethal hit it
	// broadcasts a hurt pulse (client flashes AI[..] toward `angle`); on a lethal
	// hit it runs death (drops, onDeath explosion, XP to the killer) and takes the
	// agent off the map. `angle` is the 0..31 impact direction. Mirrors
	// Resource::changeHealth. NOTE: a lethal hit deletes `this` -- callers must
	// not touch the agent afterward. `ambient` marks damage-over-time (standing
	// in spikes at 10Hz): it throttles the hurt pulse to the same 2s cadence the
	// player red aura uses, so the agent does not visibly convulse. `kind` picks
	// the <resistances> fraction; None (traps, sun) is never reduced.
	// int32_t delta, same reason as Object::changeHealth (see definitions.h).
	//
	// RETURNS the delta actually applied to the agent's pool, signed like the
	// request and 0 when nothing landed (already dying, or a resistance absorbed
	// it whole). An overkill reports the health it removed, not the swing --
	// which is what leech and any other damage-derived effect has to read. Safe
	// on a lethal hit: the value is taken before die() runs.
	int32_t changeHealth(int32_t healthDelta, uint8_t angle = 0, class Player* attacker = nullptr, bool ambient = false,
	                     AgentDamageKind kind = AgentDamageKind::None);

	bool isDying() const { return dying; }

	// Collision reflects the agent's own body/flag rather than the 32px player
	// default. Enforcement against player movement is via collectNearbyObstacles,
	// which already honours any Thing with hasCollision().
	bool hasCollision() const override { return data && data->collision; }

	// Solid to everything except the agents it shares a footprint with. See
	// AgentData::stackGroup / agentCollision.
	bool collidesWith(const Thing* other) const override
	{
		if (!hasCollision()) return false;
		if (other) {
			if (const Agent* a = other->getAgent()) {
				if (ignoresBodyOf(a)) return false;
			}
		}
		return true;
	}

	// Do these two agents share a footprint on purpose -- because a type opted
	// out of agent-vs-agent collision entirely, or because both are in the same
	// stack group? The ONE place that question is answered: collision and
	// separation are the hard and soft halves of the same thing, and letting
	// them disagree is how a pile of bots ends up being shoved apart by a force
	// that nothing then stops.
	bool ignoresBodyOf(const Agent* other) const
	{
		if (!data || !other) return false;
		const AgentData* od = other->getData();
		if (!od) return false;
		if (!data->agentCollision || !od->agentCollision) return true;
		return data->stackGroup != 0 && od->stackGroup == data->stackGroup;
	}

	// Should this agent be pushed away from `other` by the separation pass?
	bool separatesFrom(const Agent* other) const
	{
		if (!data || !data->separation || !other || other == this) return false;
		const AgentData* od = other->getData();
		if (!od || !od->separation) return false;
		return !ignoresBodyOf(other);
	}

	// --- Dodging (Game::updateAgentDodges sets it, stepAgent spends it) -----
	// A sidestep in progress is a unit direction plus a deadline. Read every
	// movement tick, so both are plain state rather than a queued event.
	bool isDodging(uint64_t now) const { return now < dodgeUntil; }
	float getDodgeDirX() const { return dodgeDirX; }
	float getDodgeDirY() const { return dodgeDirY; }

	// Is this agent even in the market for a dodge this tick? Checked before
	// the geometry, because it is one compare and rejects every agent that is
	// already dodging or still on cooldown.
	bool mayConsiderDodge(uint64_t now) const
	{
		return data && data->dodge.enabled && now >= nextDodgeAt;
	}

	void beginDodge(float dirX, float dirY, uint64_t now)
	{
		if (!data) return;
		dodgeDirX = dirX;
		dodgeDirY = dirY;
		dodgeUntil = now + data->dodge.durationMs;
		// Cooldown runs from the START of the dodge, and can never expire
		// mid-sidestep: re-deciding a direction halfway through would let a
		// burst of fire pin an agent in place, jinking on the spot.
		nextDodgeAt = now + std::max(data->dodge.cooldownMs, data->dodge.durationMs);
	}

	// Rolled and lost: this agent did not react to that shot. Held off for the
	// reaction window so the SAME bullet cannot be re-rolled every tick on its
	// way in, which would turn any chance below 1 into a certainty.
	void declineDodge(uint64_t now)
	{
		if (!data) return;
		nextDodgeAt = now + data->dodge.reactionMs;
	}

	float getCollisionRadius() const override { return data ? static_cast<float>(data->radius) : 32.0f; }

private:
	void die(class Player* killer);

	const AgentData* data = nullptr;
	std::string name;
	uint16_t health = 0;

	// Brain / movement state
	Position homePos;          // spawn point; leash distance is measured from here
	uint32_t ownerGuid = 0;    // builder's GUID, 0 = world-spawned
	float recoilX = 0.0f;
	float recoilY = 0.0f;
	KnockbackBudget knockback; // this window's remaining allowance; see applyKnockback
	uint64_t nextAttackAt = 0; // OTSYS_TIME() deadline for the next melee swing
	uint32_t repairTargetId = 0; // object being repaired, 0 = none
	uint64_t nextRepairAt = 0;   // OTSYS_TIME() deadline for the next repair pulse
	uint64_t repairDeadline = 0; // give up on the current job after this
	uint64_t nextJobScanAt = 0;  // throttle on the reachability scan

	struct Unreachable {
		uint32_t id = 0;
		uint64_t until = 0;
	};
	Unreachable unreachable[AGENT_UNREACHABLE_SLOTS];
	uint64_t nextRepathAt = 0; // OTSYS_TIME() deadline for the next A* search
	uint32_t targetId = 0;        // sticky target (runtime entity id), 0 = none
	uint64_t lastTargetHitAt = 0; // last hit landed on it; see AGENT_TARGET_ENGAGED_MS
	Position stallAnchor;         // where the stall clock started; see AGENT_STALL_MS
	uint64_t stallSince = 0;      // ...and when, 0 = clock not running
	uint32_t aggressionSide = 0;  // owner GUID this agent last hit; see noteAggressionAgainst
	uint64_t aggressionUntil = 0; // ...and when that stops counting
	uint64_t nextTargetScanAt = 0; // throttle on the non-player target sweep
	float surroundAngle = 0.0f;  // latched ring slot around the target
	Position spreadAnchor;       // what the pack is closing on, this tick only
	bool spreadAnchorSet = false;
	bool onPost = false;         // heading for / stood on its post, this tick only
	bool homeSettled = false;    // latched "arrived home"; see AGENT_HOME_ARRIVE
	uint64_t nextAlertAt = 0;    // earliest time this agent may shout for help
	Position targetLastPos;      // last seen target position (velocity estimate)
	float targetVelX = 0.0f;
	float targetVelY = 0.0f;
	bool targetTracked = false;  // is targetLastPos a valid previous sample?
	Position lastGoalPos;      // goal lastGoalDist was measured against
	int32_t lastGoalDist = -1; // previous tick's distance to goal, -1 = unmeasured
	uint16_t stuckTicks = 0;   // consecutive ticks without progress
	Position roamGoal;         // current wander destination
	uint64_t roamDeadline = 0; // give up on this leg / earliest time for the next
	float roamHeading = 0.0f;  // bearing of the current leg, radians
	Position roamDest;         // far point of the map the legs are heading for
	uint64_t roamDestDeadline = 0; // give up on this journey
	uint8_t roamFailures = 0;  // legs abandoned in a row; see AGENT_ROAM_FAIL_LIMIT
	bool roamGoalSet = false;
	bool roamHeadingSet = false;
	bool roamDestSet = false;
	uint64_t dodgeUntil = 0;   // sidestep in progress until this time
	uint64_t nextDodgeAt = 0;  // earliest time this agent may react to a shot
	float dodgeDirX = 0.0f;    // unit lateral direction of the current sidestep
	float dodgeDirY = 0.0f;
	uint64_t expiresAt = 0;      // death by old age, 0 = never
	uint64_t nextDaylightAt = 0; // next sun-damage tick
	bool holding = false;      // latched "in melee range, standing and swinging"
	bool leashReturning = false;

	// One-shot pulses, in ticks remaining. Set on a hit / attack and held for a
	// couple of ticks so both the surgical broadcast and any movement update the
	// same window carry the bit (a moving agent is re-sent every tick, which
	// would otherwise clear the pulse before the client renders it).
	uint8_t hitPulseTicks = 0;
	uint8_t attackPulseTicks = 0;
	uint8_t hitAngle31 = 0;
	uint64_t lastAmbientPulseMs = 0;
	int32_t accumulatedAmbientDamage = 0;
	bool dying = false;

	// Who hurt this agent, for kill credit when the finishing blow has no
	// player behind it (sun, fire, a trap nobody owns). See Agent::die.
	struct DamageShare {
		uint32_t damage = 0;
		uint64_t lastHitMs = 0;
	};
	std::unordered_map<uint32_t, DamageShare> damageBy; // by player id
	Player* creditedKiller() const;

public:
	// Spawned by a quest script (spawnAgent): the tag a kill objective can name
	// as target="@tag", the quest and the player it was spawned for.
	std::string questTag, questKey;
	uint32_t questOwner = 0;
};

class AgentManager
{
public:
	AgentManager() = default;

	// non-copyable
	AgentManager(const AgentManager&) = delete;
	AgentManager& operator=(const AgentManager&) = delete;

	bool loadFromXml(const std::string& filename);
	const AgentData* getAgentData(const std::string& key) const;
	size_t size() const { return agents.size(); }

	// Does any loaded agent belong to this family? Only a load-time validator
	// wants this (conditions.xml <repel families="...">), so it walks the
	// table rather than keeping an index of families nothing else would read.
	bool hasFamily(const std::string& family) const
	{
		for (const auto& [key, data] : agents) {
			if (data.family == family) return true;
		}
		return false;
	}

	// Widest <dodge reactionMs> any loaded type asks for, and 0 when nothing
	// dodges at all. Read from the loaded content rather than hardcoded, for
	// the same reason Map::maxCollisionExtent is: it sizes the corridor the
	// bullet pass searches, and a bound that is too small fails SILENTLY -- the
	// agent is simply never told the shot is coming. 0 is what lets that whole
	// pass return before it looks at a single projectile.
	uint32_t maxDodgeReactionMs() const { return maxDodgeReaction; }

	// Allocates + initialises an Agent with a banded id. Does NOT place it: the
	// caller must Game::placeThing it immediately (the banded-id liveness check
	// requires the previous agent to be on the map before the next id is drawn).
	// `ownerGuid` is the building player, or 0 for a world spawn.
	// Returns nullptr if the key is unknown or the agent id band is exhausted.
	Agent* createAgent(const std::string& key, const Position& pos, uint32_t ownerGuid = 0);

	// Prints one agent's parsed definition to the console (admin diagnostic).
	void debugDump(const std::string& key) const;

private:
	// Interns a <body stackGroup="name"> to a small id; 0 for an empty name.
	uint16_t internStackGroup(const std::string& name);

	std::unordered_map<std::string, AgentData> agents;
	std::unordered_map<std::string, uint16_t> stackGroups;
	uint32_t maxDodgeReaction = 0;
	bool warnedExhausted = false;
};

extern AgentManager g_agents;

#endif // FS_AGENT_H
