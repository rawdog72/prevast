// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROJECTILE_H
#define FS_PROJECTILE_H

#include "world/thing.h"
#include "core/position.h"
#include "gameplay/condition.h" // ConditionApplication, for <onHit condition=>
#include "gameplay/effect.h"
#include <algorithm>
#include <unordered_map>
#include <string>

class Creature;

// What a projectile does where it goes off lives in gameplay/effect.h, shared
// with objects, agents and scripts. The old names stay for the code that uses
// them.
using ProjectileExplosion = EffectExplosion;
using ProjectileFragments = EffectFragments;
using ProjectileCloud = EffectZone;

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

	// <onDestroy>: what happens where it goes off -- a blast, fragments,
	// something left on the ground -- written inline or named from effects.xml
	// (<effect key=>). See EffectManager::parseEffects.
	EffectList effects;

	// Whether this projectile goes off where it dies rather than dropping as
	// an item.
	bool detonates() const { return !effects.empty(); }

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
