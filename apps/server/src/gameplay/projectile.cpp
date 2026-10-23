// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/projectile.h"
#include "world/tile.h"
#include "gameplay/creature.h"
#include "core/tools.h"
#include "content/xml_utils.h"
#include "gameplay/area_fill.h"
#include "network/opcodes.h"
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
	m_reachedEnd = false;
	m_fragment = false;
	m_fragmentBuildingDamage = 0;
	m_fragmentRange = 0;
	m_fragmentFalloff = 1.0f;
	lingerMs = 0;
	m_skipVisual = false;
	ageMs = 0;
	ownFuseMs = 0;
	bounceCount = 0;
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
	const uint32_t fuse = fuseMs(pdata);
	if (fuse > 0) {
		if (ageMs >= fuse) {
			expired = true;
			return false; // Time to explode/die
		}
	}

	// Something that breaks on impact does not lie anywhere: dropped at the
	// thrower's feet, it breaks there at once.
	const bool shatters = pdata && pdata->shatters;
	if (shatters && m_stopped) {
		expired = true;
		return false;
	}

	if (!m_stopped) {
		travelTime += elapsedMs;
		if (travelTime >= maxTravelTime) {
			// At the end of the path, but the step that got here is untested.
			// The caller tests it and then parks or finishes the projectile.
			currentPos = endPos;
			floatX = static_cast<float>(endPos.x);
			floatY = static_cast<float>(endPos.y);
			m_reachedEnd = true;
		} else {
			floatX += velocityX * (elapsedMs / 1000.0f);
			floatY += velocityY * (elapsedMs / 1000.0f);

			currentPos.x = static_cast<uint16_t>(std::round(floatX));
			currentPos.y = static_cast<uint16_t>(std::round(floatY));
		}
	}

	return true;
}

void Projectile::setFuse(uint32_t ms)
{
	ownFuseMs = ms;
	// init() expires a projectile with no speed at once: it has nowhere to go.
	// One with a fuse still has something to do, so it lies where it is.
	if (ms > 0 && m_speed <= 0.0f) {
		expired = false;
		m_stopped = true;
	}
}

uint32_t Projectile::fuseMs(const ProjectileData* pdata) const
{
	if (ownFuseMs > 0) return ownFuseMs;
	return pdata ? pdata->lifetimeMs : 0;
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
	m_reachedEnd = false;
}

void Projectile::redirect(const Position& from, const Position& to, float vx, float vy)
{
	currentPos = from;
	startPos = from;
	animStartPos = from;
	endPos = to;
	floatX = static_cast<float>(from.x);
	floatY = static_cast<float>(from.y);
	velocityX = vx;
	velocityY = vy;
	angle = std::atan2(vy, vx);
	m_speed = std::sqrt(vx * vx + vy * vy);
	m_stopped = false;
	m_reachedEnd = false;
	travelTime = 0;
	++bounceCount;

	const float dx = static_cast<float>(to.x) - floatX;
	const float dy = static_cast<float>(to.y) - floatY;
	const float dist = std::sqrt(dx * dx + dy * dy);
	maxTravelTime = m_speed > 0.0f ? static_cast<uint32_t>((dist / m_speed) * 1000.0f) : 0;
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
		// Reuse the cached speed (pixels/sec) computed in the constructor.
		// Eight bits on the wire: anything faster than 2.55 units/ms would
		// wrap round to a crawl, so it is held at the ceiling instead.
		float speedPxPerMs = m_speed / 1000.0f;
		clientSpeed = static_cast<uint16_t>(std::min(speedPxPerMs * 100.0f, 255.0f));
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

		if (pugi::xml_node damageNode = node.child("damage")) {
			pdata.damageType = damageNode.attribute("type").as_string();
		}

		if (pugi::xml_node lifetimeNode = node.child("lifetime")) {
			pdata.lifetimeMs = lifetimeNode.attribute("durationMs").as_uint(0);
		}

		if (pugi::xml_node onDestroyNode = node.child("onDestroy")) {
			xml_utils::parseExplosionChild(onDestroyNode, pdata.explosion);

			if (pugi::xml_node cloudNode = onDestroyNode.child("cloud")) {
				ProjectileCloud& cloud = pdata.cloud;
				const std::string kind = cloudNode.attribute("kind").as_string("gas");
				if (kind == "gas") {
					cloud.kind = static_cast<uint8_t>(CloudKind::GAS);
				} else if (kind == "smoke") {
					cloud.kind = static_cast<uint8_t>(CloudKind::SMOKE);
				} else if (kind == "fire") {
					cloud.kind = static_cast<uint8_t>(CloudKind::FIRE);
				} else {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has <cloud kind=\"{}\">; the kinds are gas, smoke and fire. Using gas",
						key, kind));
					cloud.kind = static_cast<uint8_t>(CloudKind::GAS);
				}

				const uint32_t tiles = cloudNode.attribute("tiles").as_uint(0);
				cloud.tiles = static_cast<uint8_t>(std::min<uint32_t>(tiles, area_fill::kMaxCells));
				// Default radius: what `tiles` covers as a disc, plus a ring of
				// slack so a wall on one side lets it reach further on the other.
				const float defaultRadius = std::sqrt(static_cast<float>(cloud.tiles) / 3.14159f) + 1.0f;
				const float radius = cloudNode.attribute("radius").as_float(defaultRadius);
				cloud.radius = std::clamp(radius, 0.0f, static_cast<float>(area_fill::kMaxRadius));

				const auto phase = [&](const char* name, uint32_t fallback) {
					const uint32_t ms = cloudNode.attribute(name).as_uint(fallback);
					if (ms > CLOUD_MAX_PHASE_MS) {
						reportDataWarning(filename, fmt::format(
							"projectile '{}' has <cloud {}=\"{}\">; clamped to {}", key, name, ms, CLOUD_MAX_PHASE_MS));
					}
					return static_cast<uint16_t>(std::min(ms, CLOUD_MAX_PHASE_MS));
				};
				cloud.growMs = phase("growMs", 0);
				cloud.holdMs = phase("holdMs", 0);
				cloud.fadeMs = phase("fadeMs", 0);
				const uint32_t tickMs = cloudNode.attribute("tickMs").as_uint(500);
				cloud.tickMs = static_cast<uint16_t>(std::clamp(tickMs, CLOUD_MIN_TICK_MS, CLOUD_MAX_PHASE_MS));

				cloud.blocksVision = cloudNode.attribute("blocksVision").as_bool(cloud.kind == static_cast<uint8_t>(CloudKind::SMOKE));
				cloud.damage = clampDamageAmount(cloudNode.attribute("damage").as_llong());
				cloud.buildingDamage = clampDamageAmount(cloudNode.attribute("buildingDamage").as_llong());
				{
					std::string burns = cloudNode.attribute("burns").as_string("wood,cloth");
					size_t start = 0;
					while (start <= burns.size()) {
						const size_t comma = burns.find(',', start);
						std::string material = burns.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
						material.erase(0, material.find_first_not_of(" \t"));
						material.erase(material.find_last_not_of(" \t") + 1);
						if (!material.empty()) cloud.burns.push_back(material);
						if (comma == std::string::npos) break;
						start = comma + 1;
					}
				}
				cloud.damageType = cloudNode.attribute("damageType").as_string("gas");
				xml_utils::parseConditionApplication(cloudNode.child("onHit"), cloud.onHit, filename, key);

				cloud.enabled = cloud.tiles > 0 && (cloud.growMs + cloud.holdMs + cloud.fadeMs) > 0;
				if (tiles > cloud.tiles || radius != cloud.radius) {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has <cloud tiles=\"{}\" radius=\"{}\">; clamped to {} and {}",
						key, tiles, radius, cloud.tiles, cloud.radius));
				}
				if (!cloud.enabled) {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has a <cloud> with no tiles or no duration; it does nothing", key));
				}
			}

			if (onDestroyNode.child("shrapnel")) {
				reportDataWarning(filename, fmt::format(
					"projectile '{}' has <shrapnel>, which is gone: fragments are real projectiles now. "
					"Write <fragments projectile=\"...\" count= range= damage=/> instead", key));
			}

			if (pugi::xml_node fragNode = onDestroyNode.child("fragments")) {
				ProjectileFragments& frags = pdata.fragments;
				frags.projectileKey = fragNode.attribute("projectile").as_string();
				const uint32_t count = fragNode.attribute("count").as_uint(0);
				const uint32_t range = fragNode.attribute("range").as_uint(0);
				// Every fragment is a projectile entity sent to every watcher,
				// three records each (create, stop, remove): the count is the
				// bandwidth of a blast, so it is capped.
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
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has <fragments speedMultiplier=\"{}\">; using 1.0", key, frags.speedMultiplier));
					frags.speedMultiplier = 1.0f;
				}
				frags.spread = std::clamp(fragNode.attribute("spread").as_float(frags.spread), 0.0f, 1.0f);
				frags.rangeVariation = std::clamp(fragNode.attribute("rangeVariation").as_float(frags.rangeVariation), 0.0f, 0.9f);
				frags.speedVariation = std::clamp(fragNode.attribute("speedVariation").as_float(frags.speedVariation), 0.0f, 0.9f);
				frags.falloff = std::clamp(fragNode.attribute("falloff").as_float(frags.falloff), 0.0f, 1.0f);
				frags.enabled = !frags.projectileKey.empty() && frags.count > 0 && frags.range > 0;
				if (count != frags.count || range != frags.range) {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has <fragments count=\"{}\" range=\"{}\">; clamped to {} and {}",
						key, count, range, frags.count, frags.range));
				}
				if (!frags.enabled) {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' has <fragments> without a projectile, a count and a range; it does nothing", key));
				} else if (frags.projectileKey == key) {
					reportDataWarning(filename, fmt::format(
						"projectile '{}' fires itself as its own <fragments>; ignored", key));
					frags.enabled = false;
				}
			}
		}

		pdata.shatters = static_cast<bool>(node.child("shatter"));

		if (pugi::xml_node bounceNode = node.child("bounce")) {
			if (pdata.shatters) {
				reportDataWarning(filename, fmt::format(
					"projectile '{}' has both <shatter/> and <bounce>; something that breaks on impact "
					"cannot bounce, so <bounce> is ignored", key));
			}
			pdata.bounce.enabled = true;
			const float restitution = bounceNode.attribute("restitution").as_float(pdata.bounce.restitution);
			pdata.bounce.restitution = std::clamp(restitution, 0.05f, 1.0f);
			if (restitution != pdata.bounce.restitution) {
				reportDataWarning(filename, fmt::format(
					"projectile '{}' has <bounce restitution=\"{}\">; clamped to {}",
					key, restitution, pdata.bounce.restitution));
			}
			const uint32_t maxBounces = bounceNode.attribute("maxBounces").as_uint(pdata.bounce.maxBounces);
			pdata.bounce.maxBounces = static_cast<uint8_t>(std::min<uint32_t>(maxBounces, 16));
			if (pdata.lifetimeMs == 0) {
				// Only a fused projectile parks on a hit; a bullet's payload lands
				// there and then. A bounce on one would be read and never used.
				reportDataWarning(filename, fmt::format(
					"projectile '{}' has <bounce> but no <lifetime>; only fused projectiles bounce",
					key));
			}
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
