// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROJECTILE_H
#define FS_PROJECTILE_H

#include "world/thing.h"
#include "core/position.h"
#include "gameplay/condition.h" // ConditionApplication, for <onHit condition=>
#include <algorithm>
#include <unordered_map>
#include <string>

class Creature;

struct ProjectileExplosion {
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
	// charge, a cryo mine. Parsed by the shared parseExplosionChild, so all
	// three explosion shapes get it at once and cannot drift.
	ConditionApplication onHit;
};

// <onDestroy><fragments projectile= count= range= damage= buildingDamage=
//     knockback= speedMultiplier= spread= rangeVariation= speedVariation=
//     falloff=/></onDestroy>:
// a frag grenade's fragments. `count` real projectiles -- the `projectile`
// entry of this file, fired the way a gun fires its round -- fly out from the
// blast in every direction, each in its own slice of the circle. Each one is
// simulated, collided and sent to clients like any bullet, so it stops at the
// first wall, rock, tree or body in its way, and whatever stands in front
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
struct ProjectileFragments {
	bool enabled = false;
	// By key and resolved when the grenade goes off: projectiles.xml loads in
	// one pass, so the entry may come later in the file, and a content reload
	// must not leave a dangling id.
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

// <onDestroy><cloud kind= tiles= radius= growMs= holdMs= fadeMs= tickMs= damage= damageType=>
//     <onHit condition= durationMs= strength= chance=/></cloud>
// Something that lingers on the ground where it went off: a gas cloud now,
// smoke and fire later. It spreads over at most `tiles` tiles, nearest first,
// no further than `radius` tiles out, and walls and closed doors stop it (see
// area_fill.h). It grows over growMs, stays holdMs and thins out over fadeMs.
// Every tickMs while it is fully there (grow and hold), each player and agent
// standing on one of its tiles takes `damage` of `damageType` (a wearable's
// <modifier key="gasResistance"> reduces "gas") and gets <onHit>: a short
// condition, refreshed for as long as they stay, so walking out ends it soon
// after. The damage is the cloud's own and NOT a <healthTick> on the condition:
// a refresh restarts a condition's tick timers, so a condition re-applied every
// tickMs would never reach its own interval. See Game::spawnCloud.
struct ProjectileCloud {
	bool enabled = false;
	uint8_t kind = 1;            // CloudKind (opcodes.h): what the client draws
	uint8_t tiles = 0;
	float radius = 0.0f;         // in tiles
	uint16_t growMs = 0;
	uint16_t holdMs = 0;
	uint16_t fadeMs = 0;
	uint16_t tickMs = 500;
	uint16_t damage = 0;          // per tick, to each player and agent inside
	std::string damageType = "gas";
	// <cloud buildingDamage= burns="wood,cloth">: fire. Every tick, each building
	// on or right next to a covered tile whose material (ObjectData::material)
	// is in `burns` takes buildingDamage -- so it burns the wooden wall it is
	// up against, not the stone one. `burns` defaults to wood and cloth.
	uint16_t buildingDamage = 0;
	std::vector<std::string> burns;
	// <cloud blocksVision=>: smoke. While it is there (grow, hold and the first
	// half of the fade) nobody is sent what it hides; see smoke_sight.h.
	// Defaults to true for kind="smoke" and false otherwise.
	bool blocksVision = false;
	ConditionApplication onHit;
};

struct ProjectileData {
	// The client's projectile index, which a weapon cites as `bulletId` in
	// client.js. Must match that table; check_client_sync.py compares them.
	uint16_t id = 0;
	std::string key;
	uint32_t lifetimeMs = 0;

	// <physics baseSpeed="1.0">: how fast this projectile TRAVELS, as a factor
	// of PROJECTILE_REFERENCE_SPEED. The weapon's <fire><speed multiplier=>
	// scales it, so the two answer different questions -- an arrow is slow
	// whatever fires it, and a stronger bow makes that same arrow faster.
	//
	// Every shipped projectile is 1.0, so implementing this changed nothing on
	// the day. What it changes is that a new SLOW projectile becomes one number
	// here instead of a multiplier repeated on every weapon that fires it.
	float baseSpeed = 1.0f;

	// <damage type="piercing">: which resistance applies. A round fired by a
	// weapon takes the weapon's own damage type; this is the one used when no
	// weapon fired it -- a grenade's fragments.
	std::string damageType;

	// <onHit>, <leech> and <crit>: everything landing this round does beyond the
	// damage. On the projectile rather than the weapon because these are
	// properties of the AMMUNITION wherever it is fired from -- nine weapons
	// share 9mm_bullet, and a tipped dart is tipped in every launcher. A weapon
	// carries its own set too, and the two combine: see Game::applyHitEffects.
	HitEffects hitEffects;

	ProjectileExplosion explosion;
	ProjectileFragments fragments;
	ProjectileCloud cloud;

	// Whether this projectile goes off where it dies (a blast, fragments, a
	// cloud) rather than dropping as an item.
	bool detonates() const { return explosion.enabled || fragments.enabled || cloud.enabled; }

	// <shatter/>: breaks where it lands or on the first thing it hits -- a
	// molotov's bottle -- and goes off there and then. It never parks and never
	// bounces; its <lifetime> is only how long it can be held lit (the cook), and
	// one that leaves the hand with no speed (dropped, or its thrower died)
	// breaks where it falls.
	bool shatters = false;

	// <bounce restitution="0.45" maxBounces="3"/>: a fused projectile (grenade)
	// glances off walls, rocks and trees instead of stopping on them. Each bounce
	// keeps `restitution` of the speed and of the distance it had left to fly.
	// Absent = it stops on the first thing it hits, as it always has.
	struct Bounce {
		bool enabled = false;
		float restitution = 0.45f;
		uint8_t maxBounces = 3;
	} bounce;
};

class Projectile final : public Thing
{
public:
	static void* operator new(size_t size);
	static void operator delete(void* p);
	Projectile(uint32_t id, const Position& start, const Position& end, const Position& animStart, float velocityX, float velocityY, uint16_t damage, float knockback, Creature* shooter, uint16_t extra, const std::string& weaponKey = "");
	Projectile();
	~Projectile() override;

	void init(uint32_t id, const Position& start, const Position& end, const Position& animStart, float velocityX, float velocityY, uint16_t damage, float knockback, Creature* shooter, uint16_t extra, const std::string& weaponKey = "");
	void resetShooter();

	// non-copyable: holds a reference on the shooter
	Projectile(const Projectile&) = delete;
	Projectile& operator=(const Projectile&) = delete;

	// Thing overrides
	void buildUpdate(EntityUpdate& out) const override;
	void buildRemoval(EntityUpdate& out) const override;
	
	const Position& getPosition() const override { return currentPos; }
	void setPosition(const Position& pos) override { currentPos = pos; }

	bool hasCollision() const override { return false; }
	bool isMobile() const override { return true; }
	bool isVisualSuppressed() const override { return m_skipVisual; }

	Tile* getTile() override { return tile; }
	void setTile(Tile* t) { tile = t; }

	// Simulation. Returns false when the projectile is done: its fuse ran out,
	// it shatters where it lies, or its impact park is over.
	//
	// Reaching the end of its path is NOT done: the step that gets there is a
	// step like any other and has to be collision-tested first, or whatever
	// stands on the last stretch -- up to a whole tick of flight -- is flown
	// straight through. hasReachedEnd() says the position is now the endpoint;
	// the caller tests the step, then parks or finishes it (Game::updateProjectiles).
	bool update(uint32_t elapsedMs);
	bool hasReachedEnd() const { return m_reachedEnd; }
	void stopAt(const Position& pos);
	// A new flight leg from `from` toward `to` at (vx, vy): a bounce. Age and
	// fuse carry on; travel time, endpoints and speed start over, so the next
	// update the client gets is a fresh start/end pair it can glide along.
	void redirect(const Position& from, const Position& to, float vx, float vy);
	uint8_t getBounceCount() const { return bounceCount; }

	// Hit resolved (damage, explosion or drop already applied); the projectile
	// only stays alive to hold its sprite on the impact point for `ms`.
	void beginImpactLinger(uint32_t ms) { lingerMs = ms; impactResolved = true; }
	bool isImpactResolved() const { return impactResolved; }

	uint16_t getDamage() const { return damage; }
	float getKnockback() const { return knockback; }
	Creature* getShooter() const { return shooter; }
	const Position& getStartPos() const { return startPos; }
	const Position& getEndPos() const { return endPos; }
	const Position& getAnimStartPos() const { return animStartPos; }

	// EXACTLY who was sent this bullet's creation record, as a bitmask over the
	// 8-bit wire pid (Creature::buildUpdate sends `(uint8_t)getGUID()`, and the
	// player ceiling is 255 for that reason).
	//
	// The retract path used to re-evaluate the create path's visibility
	// predicate, and that CANNOT be made correct. Two separate leaks came out
	// of trying:
	//   - the live start/end/animStart positions are simulation state --
	//     stopAt() and update() collapse all three onto the impact point, so
	//     the predicate silently degenerated to "who can see where it died"
	//     (23,505 bullets leaked per client in 105s);
	//   - even against frozen spawn positions it still leaked 7,520, because a
	//     player who was in range when the shot was fired can walk out of range
	//     before it lands. Any position predicate is unstable under movement.
	// A record of who was actually told is the only stable answer, and it is
	// also CHEAPER than the predicate it replaces: one bit test per player
	// instead of four range checks.
	//
	// A pid reused by a later login can at worst receive one removal for a
	// bullet it never had, which Entitie.remove discards on the uid compare.
	void markSentTo(uint8_t pid) { sentMask[pid >> 6] |= (1ull << (pid & 63)); }
	bool wasSentTo(uint8_t pid) const { return (sentMask[pid >> 6] & (1ull << (pid & 63))) != 0; }
	uint16_t getExtra() const { return extra; }
	const std::string& getWeaponKey() const { return weaponKey; }

	// This projectile's own fuse, overriding projectiles.xml <lifetime>: a
	// cooked grenade leaves the hand with only what is left of it. A fused
	// projectile with no speed (dropped live at someone's feet) is parked where
	// it lies instead of expiring on the spot.
	void setFuse(uint32_t ms);
	// The fuse that applies: the per-throw one if set, else the data's.
	uint32_t fuseMs(const ProjectileData* pdata) const;

	// A grenade's fragment (Game::fireFragments): fired by a blast, not a
	// weapon. It can hit whoever threw the grenade -- a bullet never hits its
	// own shooter, but nothing protects you from your own frag -- and a
	// building or resource takes `buildingDamage` instead of the round's damage.
	void setFragment(uint16_t buildingDamage, uint16_t range, float falloff)
	{
		m_fragment = true;
		m_fragmentBuildingDamage = buildingDamage;
		m_fragmentRange = range;
		m_fragmentFalloff = falloff;
	}
	bool isFragment() const { return m_fragment; }
	uint16_t getFragmentBuildingDamage() const { return m_fragmentBuildingDamage; }
	// What a fragment's damage is multiplied by when it lands `distance` from
	// the blast; see ProjectileFragments::falloff.
	float fragmentFalloffAt(float distance) const
	{
		if (m_fragmentFalloff >= 1.0f || m_fragmentRange == 0) return 1.0f;
		const float t = std::clamp(distance / static_cast<float>(m_fragmentRange), 0.0f, 1.0f);
		return 1.0f - t * (1.0f - m_fragmentFalloff);
	}

	void setDropItemIid(uint16_t iid) { dropItemIid = iid; }
	uint16_t getDropItemIid() const { return dropItemIid; }
	void setSkipVisual(bool skip) { m_skipVisual = skip; }
	bool getSkipVisual() const { return m_skipVisual; }
	bool isExpired() const { return expired; }
	bool isStopped() const { return m_stopped; }
	float getVelocityX() const { return velocityX; }
	float getVelocityY() const { return velocityY; }
	float getSpeed() const { return m_speed; } // launch speed, survives stopAt()

	float getFloatX() const { return floatX; }
	float getFloatY() const { return floatY; }
	float getAngle() const { return angle; }

private:
	Position startPos;
	Position endPos;
	Position animStartPos;
	Position currentPos;
	// One bit per wire pid: who was sent the creation record. See markSentTo.
	uint64_t sentMask[4];
	float velocityX;
	float velocityY;
	float angle;
	uint16_t damage;
	float knockback = 0.0f;
	Creature* shooter;
	uint16_t extra;
	std::string weaponKey;
	uint16_t dropItemIid = 0;
	
	float floatX;
	float floatY;
	
	bool expired = false;
	bool m_stopped = false;    // renamed from isStopped_flag for naming consistency
	bool impactResolved = false;
	bool m_reachedEnd = false; // at endPos, last step not yet resolved; see update()
	bool m_fragment = false;
	uint16_t m_fragmentBuildingDamage = 0;
	uint16_t m_fragmentRange = 0;
	float m_fragmentFalloff = 1.0f;
	uint32_t lingerMs = 0;
	bool m_skipVisual = false; // flag to skip sending visual EntityUpdates to client when hitting point-blank obstacles
	uint32_t ageMs = 0;
	uint32_t ownFuseMs = 0;    // 0 = use projectiles.xml <lifetime>; see setFuse
	uint8_t bounceCount = 0;   // legs started by redirect(); see ProjectileData::bounce
	uint32_t travelTime = 0;
	uint32_t maxTravelTime;
	float m_speed = 0.0f;      // cached speed magnitude (pixels/sec), computed once in ctor
	Tile* tile = nullptr;
};

class ProjectileManager {
public:
	static ProjectileManager& getInstance() {
		static ProjectileManager instance;
		return instance;
	}

	bool loadFromXml(const std::string& filename);
	uint16_t getProjectileId(const std::string& key) const;
	const ProjectileData* getProjectileData(uint16_t id) const;
	// By KEY, and not as getProjectileData(getProjectileId(key)): that returns 0
	// for an unknown key and 0 is 9mm_bullet, a real projectile, so a typo would
	// silently answer with the wrong entry. This one returns nullptr.
	const ProjectileData* getProjectileData(const std::string& key) const;

private:
	std::unordered_map<std::string, uint16_t> projectileKeys;
	std::unordered_map<uint16_t, ProjectileData> projectiles;
};

#endif // FS_PROJECTILE_H
