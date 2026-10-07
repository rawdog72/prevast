// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROJECTILE_H
#define FS_PROJECTILE_H

#include "world/thing.h"
#include "core/position.h"
#include "gameplay/condition.h" // ConditionApplication, for <onHit condition=>
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
	// <explosion><onHit condition= chance= durationMs=/></explosion>: what the
	// BLAST inflicts on every creature caught in it. A stun grenade, a gas
	// charge, a cryo mine. Parsed by the shared parseExplosionChild, so all
	// three explosion shapes get it at once and cannot drift.
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

	// <onHit>, <leech> and <crit>: everything landing this round does beyond the
	// damage. On the projectile rather than the weapon because these are
	// properties of the AMMUNITION wherever it is fired from -- nine weapons
	// share 9mm_bullet, and a tipped dart is tipped in every launcher. A weapon
	// carries its own set too, and the two combine: see Game::applyHitEffects.
	HitEffects hitEffects;

	ProjectileExplosion explosion;
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

	// Simulation
	bool update(uint32_t elapsedMs);
	void stopAt(const Position& pos);

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
	uint32_t lingerMs = 0;
	bool m_skipVisual = false; // flag to skip sending visual EntityUpdates to client when hitting point-blank obstacles
	uint32_t ageMs = 0;
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
