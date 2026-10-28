// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_EFFECT_H
#define FS_EFFECT_H

#include "gameplay/condition.h" // ConditionApplication, for <onHit condition=>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace pugi {
class xml_node;
class xml_document;
}

// What happens at a point: a blast, fragments, something left lying on the
// ground, or any mix of them. data/XML/effects.xml names them, and anything that
// goes off -- a projectile's <onDestroy>, an object's <onDestroy>, an agent's
// <onDeath>, a script -- runs them by key:
//
//     <onDestroy><effect key="frag_blast"/></onDestroy>
//
// or writes the parts inline, as every file could before effects.xml existed.
// See EffectManager and Game::runEffect.

// <explosion radius= area= playerDamage= buildingDamage= knockback= throughWall=>
//     <onHit condition= chance= durationMs=/></explosion>
struct EffectExplosion {
	bool enabled = false;
	uint16_t radius = 0;   // circular pixel range (used when area == 0)
	uint16_t area = 0;     // tiles around the explosion's tile; overrides radius when > 0
	uint16_t playerDamage = 0;
	uint16_t buildingDamage = 0;
	float knockback = 0.0f;
	// <explosion throughWall="0.3">: the share of damage, knockback and condition
	// chance that reaches a creature with a wall between it and the blast. 0 (the
	// default) means cover protects completely. Buildings are never occluded.
	float throughWall = 0.0f;
	// <explosion><onHit condition= chance= durationMs=/></explosion>: what the
	// BLAST inflicts on every creature caught in it. A stun grenade, a gas
	// charge, a cryo mine. Parsed by the shared parseExplosionChild.
	ConditionApplication onHit;
};

// <fragments projectile= count= range= damage= buildingDamage= knockback=
//     speedMultiplier= spread= rangeVariation= speedVariation= falloff=/>:
// a frag grenade's fragments. `count` real projectiles -- the `projectile`
// entry of projectiles.xml, fired the way a gun fires its round -- fly out from
// the blast in every direction, each in its own slice of the circle. Each one
// is simulated, collided and sent to clients like any bullet, so it stops at
// the first wall, rock, tree or body in its way, and whatever stands in front
// takes the fragments meant for whoever is behind it. Fewer of them reach a
// far target, so damage falls off with distance on its own.
//
// What a weapon's <fire> and <damage> say for a gun, this says for the blast:
// `damage` per fragment to a player or agent (the fragment projectile's
// <damage type> picks the resistance), `buildingDamage` to a building or
// resource -- the same as `damage` unless stated, as a gun's is --
// `knockback` per fragment. The fragment projectile's <physics baseSpeed>
// times `speedMultiplier` is how fast the fastest of them fly. See
// Game::fireFragments.
struct EffectFragments {
	bool enabled = false;
	// By key and resolved when the effect runs: projectiles.xml loads after
	// effects.xml, and a content reload must not leave a dangling id.
	std::string projectileKey;
	uint8_t count = 0;
	uint16_t range = 0;
	uint16_t damage = 0;          // per fragment that lands on a player or agent
	uint16_t buildingDamage = 0;  // per fragment that lands on a building or resource
	float knockback = 0.0f;
	float speedMultiplier = 1.0f;
	// How far each fragment may wander inside its slice of the circle: 0 is a
	// perfect star, 1 anywhere in the slice.
	float spread = 1.0f;
	// The share of `range` a fragment may fall short by, so they do not all
	// stop on one ring.
	float rangeVariation = 0.6f;
	// The share of the speed a fragment may be slower by. All at one speed,
	// the burst's front is a perfect expanding circle however far each flies.
	float speedVariation = 0.4f;
	// The share of its damage (body and building alike) a fragment still does
	// when it lands `range` from the blast, falling off in a straight line from
	// all of it at the blast -- a gun's <falloff minMultiplier>. 1 = none.
	float falloff = 1.0f;
};

struct EffectData;

// <zone kind= tiles= radius= growMs= holdMs= fadeMs= tickMs= damage= damageType=
//     shape= stretch= forward= irregular= blockedBy=>
//     <onHit condition= durationMs= strength= chance=/>
//     <onEnd effect="..."/>
// </zone>
// (<cloud> is the same element under its old name.)
//
// Something that lingers on the ground where it went off: gas, smoke, fire. It
// spreads over at most `tiles` tiles, nearest first, no further than `radius`
// tiles out, and walls and closed doors stop it (see area_fill.h). It grows
// over growMs, stays holdMs and thins out over fadeMs. Every tickMs while it
// is fully there (grow and hold), each player and agent standing on one of its
// tiles takes `damage` of `damageType` (a wearable's <modifier
// key="gasResistance"> reduces "gas") and gets <onHit>: a short condition,
// refreshed for as long as they stay, so walking out ends it soon after. The
// damage is the zone's own and NOT a <healthTick> on the condition: a refresh
// restarts a condition's tick timers, so a condition re-applied every tickMs
// would never reach its own interval. See Game::spawnCloud.
struct EffectZone {
	bool enabled = false;
	uint8_t kind = 1;            // CloudKind (opcodes.h): how the client draws it without a look
	// The clientEffectId of the effects.xml entry this zone belongs to, sent
	// with it so the client draws that entry's <client> look. 0 for a zone
	// written inline, which the client draws by `kind`.
	uint16_t effectId = 0;
	uint8_t tiles = 0;
	float radius = 0.0f;         // in tiles
	uint16_t growMs = 0;
	uint16_t holdMs = 0;
	uint16_t fadeMs = 0;
	uint16_t tickMs = 500;
	uint16_t damage = 0;          // per tick, to each player and agent inside
	std::string damageType = "gas";
	// <zone buildingDamage= burns="wood,cloth">: fire. Every tick, each building
	// on or right next to a covered tile whose material (ObjectData::material)
	// is in `burns` takes buildingDamage -- so it burns the wooden wall it is
	// up against, not the stone one. `burns` defaults to wood and cloth.
	uint16_t buildingDamage = 0;
	std::vector<std::string> burns;
	// <zone blocksVision=>: smoke. While it is there (grow, hold and the first
	// half of the fade) nobody is sent what it hides; see smoke_sight.h.
	// Defaults to true for kind="smoke" and false otherwise.
	bool blocksVision = false;
	ConditionApplication onHit;

	// The shape (area_fill::Shape). shape="line" lies ACROSS the direction it
	// came from (a smoke wall); "fill" (the default) is round, or stretched
	// ALONG that direction by `stretch` (a molotov's splash). `forward` moves
	// the middle of the shape that many tiles on along the direction, so the
	// splash lands ahead of where the bottle broke. Without a direction --
	// something that went off where it lay, or a dead ghoul -- both are round.
	// `irregular` (0..1) roughens the edge. `blockedBy` is what stops it
	// spreading: walls and closed doors (the default), plus rocks and trees
	// with "walls,scenery", or nothing but the map's edge with "none".
	bool line = false;
	float stretch = 1.0f;
	float forward = 0.0f;
	float irregular = 0.0f;
	uint8_t blockedBy = 1;       // ZoneBlock bits

	// <onEnd effect="..."/>: what happens where it was once it is gone -- a
	// fire that leaves a wisp of smoke. Runs at the zone's origin tile.
	std::shared_ptr<const EffectData> onEnd;
};

// What stops a zone spreading (EffectZone::blockedBy).
namespace ZoneBlock {
inline constexpr uint8_t Walls = 1;   // walls and closed doors: what stops a bullet
inline constexpr uint8_t Scenery = 2; // rocks and trees
}

struct EffectData {
	// Its effects.xml key and clientEffectId, or empty and 0 for the parts a
	// projectile, object or agent writes inline.
	std::string key;
	uint16_t clientEffectId = 0;

	EffectExplosion explosion;
	EffectFragments fragments;
	EffectZone zone;
	// <effect key="..."/> inside an effect: run after this one's own parts, at
	// the same point. Resolved when effects.xml loads, overrides and all.
	std::vector<EffectData> then;

	bool any() const { return explosion.enabled || fragments.enabled || zone.enabled || !then.empty(); }
	// Whether running it fires fragments, anywhere down its chain.
	bool firesFragments() const;
};

// Everything one source runs where it goes off, in order.
using EffectList = std::vector<EffectData>;

bool effectsFireFragments(const EffectList& effects);

class EffectManager {
public:
	static EffectManager& getInstance()
	{
		static EffectManager instance;
		return instance;
	}

	// data/XML/effects.xml. Loads before every file that names an effect.
	bool loadFromXml(const std::string& filename);

	// A loaded effect by key; nullptr for an unknown one.
	const EffectData* get(const std::string& key) const;
	size_t size() const { return effects.size(); }

	// Everything a source's <onDestroy> / <onDeath> holds: its inline
	// <explosion>, <fragments> and <zone> (or <cloud>) as one unnamed effect,
	// then each <effect key=> in order. Returns whether the node held any of
	// them, so a definition that inherits from a base can keep the base's when
	// it says nothing.
	bool parseEffects(const pugi::xml_node& parent, EffectList& out, const std::string& fileName,
	                  const std::string& ownerKey) const;

	// One <effect key="..."> reference. Child elements override the named
	// effect's own: <effect key="toxic_gas"><zone holdMs="20000"/></effect> is
	// toxic_gas with a longer hold. False (and a warning) for an unknown key.
	bool parseReference(const pugi::xml_node& ref, EffectData& out, const std::string& fileName,
	                    const std::string& ownerKey) const;

private:
	EffectManager() = default;

	// The authored XML of every entry, kept so a reference with overrides can
	// be parsed as the entry with the overrides merged in.
	std::shared_ptr<pugi::xml_document> sources;
	std::unordered_map<std::string, pugi::xml_node> nodes;
	std::unordered_map<std::string, EffectData> effects;
	std::string sourceFile;

	bool parseBody(const pugi::xml_node& node, EffectData& out, const std::string& fileName,
	               const std::string& ownerKey, int depth) const;
	bool resolve(const pugi::xml_node& ref, EffectData& out, const std::string& fileName,
	             const std::string& ownerKey, int depth) const;
};

// The shared parsers, also used for the inline parts.
void parseZoneNode(const pugi::xml_node& node, EffectZone& zone, const std::string& fileName,
                   const std::string& ownerKey);
void parseFragmentsNode(const pugi::xml_node& node, EffectFragments& frags, const std::string& fileName,
                        const std::string& ownerKey);

#endif // FS_EFFECT_H
