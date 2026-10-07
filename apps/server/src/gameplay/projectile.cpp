// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/projectile.h"
#include "world/tile.h"
#include "gameplay/creature.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include <cmath>
#include <fmt/format.h>

Projectile::Projectile() : shooter(nullptr)
{
}

Projectile::Projectile(uint32_t id, const Position& start, const Position& end, const Position& animStart, float vx, float vy, uint16_t damage, float knockback, Creature* shooter, uint16_t extra, const std::string& weaponKey) : shooter(nullptr)
{
	init(id, start, end, animStart, vx, vy, damage, knockback, shooter, extra, weaponKey);
}

void Projectile::init(uint32_t id, const Position& start, const Position& end, const Position& animStart, float vx, float vy, uint16_t damage, float knockback, Creature* shooter, uint16_t extra, const std::string& weaponKey)
{
	setID(id);
	startPos = start;
	endPos = end;
	animStartPos = animStart;
	currentPos = start;

	// MUST be cleared here, not just on construction: operator new recycles
	// projectile memory from a free list, so a fresh bullet can land on the
	// bytes of a previous one and inherit its recipients.
	sentMask[0] = sentMask[1] = sentMask[2] = sentMask[3] = 0;
	velocityX = vx;
	velocityY = vy;
	this->damage = damage;
	this->knockback = knockback;
	this->shooter = shooter;
	this->extra = extra;
	this->weaponKey = weaponKey;
	
	dropItemIid = 0;
	expired = false;
	m_stopped = false;
	impactResolved = false;
	lingerMs = 0;
	m_skipVisual = false;
	ageMs = 0;
	travelTime = 0;
	tile = nullptr;

	floatX = static_cast<float>(start.x);
	floatY = static_cast<float>(start.y);
	angle = std::atan2(vy, vx);

	float dx = static_cast<float>(end.x - start.x);
	float dy = static_cast<float>(end.y - start.y);
	float dist = std::sqrt(dx * dx + dy * dy);
	m_speed = std::sqrt(vx * vx + vy * vy); // Cache speed — reused in buildUpdate

	if (m_speed > 0) {
		maxTravelTime = static_cast<uint32_t>((dist / m_speed) * 1000.0f);
	} else {
		maxTravelTime = 0;
		expired = true;
	}

	// Keep the shooter alive while the projectile is in flight: players are
	// reference counted and deleted on disconnect/death, and getShooter() is
	// dereferenced when the projectile hits or explodes.
	if (this->shooter) {
		this->shooter->incrementReferenceCounter();
	}
}

void Projectile::resetShooter()
{
	if (shooter) {
		shooter->decrementReferenceCounter();
		shooter = nullptr;
	}
}

Projectile::~Projectile()
{
	resetShooter();
	if (tile) {
		tile->removeThing(this);
		tile = nullptr;
	}
}

bool Projectile::update(uint32_t elapsedMs)
{
	if (expired) return false;

	// Parked on an impact point: nothing left to simulate, just hold the sprite
	// there until the client's smoothing has caught up with it.
	if (impactResolved) {
		if (lingerMs <= elapsedMs) {
			expired = true;
			return false;
		}
		lingerMs -= elapsedMs;
		return true;
	}

	ageMs += elapsedMs;

	const ProjectileData* pdata = ProjectileManager::getInstance().getProjectileData(getExtra());
	if (pdata && pdata->lifetimeMs > 0) {
		if (ageMs >= pdata->lifetimeMs) {
			expired = true;
			return false; // Time to explode/die
		}
	}

	if (!m_stopped) {
		travelTime += elapsedMs;
		if (travelTime >= maxTravelTime) {
			currentPos = endPos;
			if (pdata && pdata->lifetimeMs > 0) {
				m_stopped = true;
				velocityX = 0;
				velocityY = 0;
				startPos = currentPos;
				endPos = currentPos;
			} else {
				expired = true;
				return false;
			}
		} else {
			floatX += velocityX * (elapsedMs / 1000.0f);
			floatY += velocityY * (elapsedMs / 1000.0f);

			currentPos.x = static_cast<uint16_t>(std::round(floatX));
			currentPos.y = static_cast<uint16_t>(std::round(floatY));
		}
	}

	return true;
}

void Projectile::stopAt(const Position& pos)
{
	currentPos = pos;
	floatX = static_cast<float>(pos.x);
	floatY = static_cast<float>(pos.y);
	velocityX = 0;
	velocityY = 0;
	startPos = pos;
	endPos = pos;
	animStartPos = pos;
	m_stopped = true;
}

void Projectile::buildUpdate(EntityUpdate& out) const
{
	out.pid = 0;
	out.rotation = static_cast<uint8_t>((angle * 255.0f) / MATH_TWO_PI);

	out.type = 2; // __ENTITIE_BULLET__

	// The client expects speed in the upper 8 bits: speed = (state >> 8) / 100;
	// If stopped, we send 0 for speed
	uint16_t clientSpeed = 0;
	if (!m_stopped) {
		// Reuse the cached speed (pixels/sec) computed in the constructor
		float speedPxPerMs = m_speed / 1000.0f;
		clientSpeed = static_cast<uint16_t>(speedPxPerMs * 100.0f);
	}
	out.state = (clientSpeed << 8) | 1; // Active
	
	out.id = static_cast<uint16_t>(getID() & 0xFFFF);
	
	out.startX = static_cast<uint16_t>(animStartPos.x);
	out.startY = static_cast<uint16_t>(animStartPos.y);
	out.endX = static_cast<uint16_t>(endPos.x);
	out.endY = static_cast<uint16_t>(endPos.y);
	out.extra = extra;
}

void Projectile::buildRemoval(EntityUpdate& out) const
{
	buildUpdate(out);
	// state 0 + extra = the keepInCache flag, never the projectile id
	// buildUpdate packed there. See EntityUpdate::makeRemoval: leaving the id
	// in place gave the 7.62 round (clientProjectileId 1) client.js's 200 ms
	// removal fade and no other ammo type. Game::removeProjectile marks every
	// retraction a destruction, so now they all fade, which is what the fade
	// in client.js _Bullets was written for.
	out.makeRemoval();
}

bool ProjectileManager::loadFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "projectiles");
	if (!root) return false;

	for (pugi::xml_node node = root.child("projectile"); node; node = node.next_sibling("projectile")) {
		uint16_t id = static_cast<uint16_t>(node.attribute("clientProjectileId").as_uint());
		std::string key = node.attribute("key").as_string();

		// Presence, not value: clientProjectileId 0 is 9mm_bullet, a real entry,
		// so only a missing attribute can be detected -- and a missing one
		// silently makes every such projectile draw as that first sprite.
		if (!node.attribute("clientProjectileId")) {
			reportDataWarning(filename, fmt::format(
				"projectile '{}' has no clientProjectileId=; the client will draw it as projectile 0",
				key));
		}
		projectileKeys[key] = id;
		
		ProjectileData pdata;
		pdata.id = id;
		pdata.key = key;

		if (pugi::xml_node physicsNode = node.child("physics")) {
			pdata.baseSpeed = physicsNode.attribute("baseSpeed").as_float(1.0f);
			if (pdata.baseSpeed <= 0.0f) {
				reportDataWarning(filename, fmt::format(
					"projectile '{}' has baseSpeed {}; it would never leave the barrel, using 1.0",
					key, pdata.baseSpeed));
				pdata.baseSpeed = 1.0f;
			}
		}

		if (pugi::xml_node lifetimeNode = node.child("lifetime")) {
			pdata.lifetimeMs = lifetimeNode.attribute("durationMs").as_uint(0);
		}

		if (pugi::xml_node onDestroyNode = node.child("onDestroy")) {
			xml_utils::parseExplosionChild(onDestroyNode, pdata.explosion);
		}

		// What this round does on landing beyond its damage. Any condition key
		// resolves nowhere yet -- conditions.xml loads later -- so
		// validateDataReferences checks it once everything is in.
		xml_utils::parseHitEffects(node, pdata.hitEffects, filename, key);

		projectiles[id] = std::move(pdata);
	}

	reportDataFile(filename, fmt::format("{} projectiles", projectiles.size()));
	return true;
}

uint16_t ProjectileManager::getProjectileId(const std::string& key) const
{
	auto it = projectileKeys.find(key);
	if (it != projectileKeys.end()) {
		return it->second;
	}
	return 0; // Default to 0 if not found
}

const ProjectileData* ProjectileManager::getProjectileData(uint16_t id) const
{
	auto it = projectiles.find(id);
	if (it != projectiles.end()) {
		return &it->second;
	}
	return nullptr;
}

const ProjectileData* ProjectileManager::getProjectileData(const std::string& key) const
{
	auto it = projectileKeys.find(key);
	if (it == projectileKeys.end()) {
		return nullptr;
	}
	return getProjectileData(it->second);
}

static std::vector<void*> g_freeProjectiles;

void* Projectile::operator new(size_t size) {
    if (!g_freeProjectiles.empty()) {
        void* p = g_freeProjectiles.back();
        g_freeProjectiles.pop_back();
        return p;
    }
    return ::operator new(size);
}

void Projectile::operator delete(void* p) {
    g_freeProjectiles.push_back(p);
}
