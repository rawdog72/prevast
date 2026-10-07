// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/account_runs.h"

#include "gameplay/player.h"
#include "gameplay/projectile.h"
#include "gameplay/game.h"
#include "gameplay/progress/game_event.h"
#include "gameplay/quests/quest_system.h"

#include "content/configmanager.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "core/tasks.h"
#include "core/tools.h"
#include "gameplay/equipment.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/resource.h"
#include "gameplay/object.h"
#include "gameplay/agent.h"
#include "gameplay/scenarios/scenario_runtime.h"
#include "world/collision.h"

#include <cmath>
#include <limits>

extern Game g_game;

static constexpr float GAUGE_RATE_SCALE = 10000.0f;
static constexpr float MELEE_HIT_FORGIVENESS = 15.0f;

// NO PERIODIC GAUGE RESYNC. This is a deliberate constraint, not an omission.
//
// The client does not display what the server sends; it runs its own copy of
// every gauge and only takes a GAUGES packet as a correction.
//
// Both sides now integrate the SAME rates -- computeGaugeRates sends the
// effective per-player numbers and the tick then runs on exactly those, so
// resistances, the feeder and the life-drain multiplier all agree by identity
// rather than by two tables happening to match. (The client's own `gauge.bonus`
// resistance path is dead and stays dead: it reads `.warm`/`.rad` off
// `ENTITIES[player].clothes[skin]`, a sprite table with neither key, so it is
// pinned at 0. Reviving it would DOUBLE-count every resistance the rate already
// carries.)
//
// What remains apart is granularity: the server's value is an integer with a
// separate fractional partial and moves in whole steps, the client's is a float
// and moves every frame.
//
// So client and server are still a little apart, and any correction that is
// not actually needed drags the bar back to a value it already passed. Send
// those on a timer and the bar visibly stutters — it climbs, gets yanked back,
// climbs again — which is exactly what a 1-3s heartbeat produced here: a
// "wait, jump, wait, jump" food bar in a feeder and a cold bar that rose and
// fell in a loop at night.
//
// A gauge is therefore corrected only when there is a reason to believe the
// client is wrong: an out-of-band change it cannot predict (flushGaugeSync), a
// session that has just attached (requestFullGaugeResync), or a client that
// went away and came back (ProtocolGame::parsePacket's resume check). Never on
// a clock.

struct AreaEffectScan {
	bool radiation = false;
	bool warmth = false;
	bool food = false;
	float maxRadiationStrength = 0.0f;
};

struct ProjectileTrajectory {
	Position startPos;
	Position animStartPos;
	Position endPos;
	float velocityX = 0.0f;
	float velocityY = 0.0f;
	bool skipVisualAnimation = false;
};

struct MeleeTrace {
	Position startPos;
	Position endPos;
	float directionX = 0.0f;
	float directionY = 0.0f;
};

static float gaugeDelta(float rate, uint32_t elapsedMs)
{
	return (static_cast<float>(rate) / GAUGE_RATE_SCALE) * elapsedMs;
}

// A percentage OF THAT GAUGE'S ceiling, not of 255: the life thresholds are
// expressed as percentages in modes.xml, and `!gauge-X-size` can move what 100%
// of a gauge means.
static uint8_t percentToGaugeValue(uint8_t pct, uint8_t maxValue = 255)
{
	return static_cast<uint8_t>((static_cast<uint16_t>(pct) * maxValue) / 100);
}

// maxValue is the gauge's ceiling for the same reason increaseGauge takes one:
// eating past what the bar can draw is not a thing.
static uint8_t applyGaugeDelta(uint8_t value, int16_t amount, uint8_t maxValue)
{
	const int16_t nextValue = static_cast<int16_t>(value) + amount;
	return static_cast<uint8_t>(std::max<int16_t>(0, std::min<int16_t>(maxValue, nextValue)));
}

static float clampToMap(float value, float maxValue)
{
	return std::max(0.0f, std::min(maxValue, value));
}

static float getMapBoundedSegmentScale(float startX, float startY, float dx, float dy, float mapWidth, float mapHeight)
{
	float t = 1.0f;
	if (dx < 0 && startX + t * dx < 0) t = std::min(t, -startX / dx);
	if (dx > 0 && startX + t * dx > mapWidth) t = std::min(t, (mapWidth - startX) / dx);
	if (dy < 0 && startY + t * dy < 0) t = std::min(t, -startY / dy);
	if (dy > 0 && startY + t * dy > mapHeight) t = std::min(t, (mapHeight - startY) / dy);
	return t;
}

static ProjectileTrajectory buildProjectileTrajectory(const Position& origin, const EquipableData& edata, float angle, const Creature* shooter, float projectileBaseSpeed)
{
	const float cosA = cos(angle);
	const float sinA = sin(angle);

	const float mapWidth = static_cast<float>(MapSize::widthUnits());
	const float mapHeight = static_cast<float>(MapSize::heightUnits());
	const uint16_t range = edata.range > 0 ? edata.range : 800;
	// Two factors, two owners: the projectile says how fast IT flies
	// (projectiles.xml <physics baseSpeed>), the weapon scales that
	// (equipables.xml <fire><speed multiplier>). 600 is the reference speed both
	// are expressed against.
	const float speed = PROJECTILE_REFERENCE_SPEED * projectileBaseSpeed * edata.speedMultiplier;

	float startX = static_cast<float>(origin.x) + (edata.muzzleOffsetX * cosA) - (edata.muzzleOffsetY * sinA);
	float startY = static_cast<float>(origin.y) + (edata.muzzleOffsetX * sinA) + (edata.muzzleOffsetY * cosA);

	startX = clampToMap(startX, mapWidth);
	startY = clampToMap(startY, mapHeight);

	float animX = static_cast<float>(origin.x) + (edata.animOffsetX * cosA) - (edata.animOffsetY * sinA);
	float animY = static_cast<float>(origin.y) + (edata.animOffsetX * sinA) + (edata.animOffsetY * cosA);
	animX = clampToMap(animX, mapWidth);
	animY = clampToMap(animY, mapHeight);

	const float dx = cosA * range;
	const float dy = sinA * range;

	const float t = getMapBoundedSegmentScale(startX, startY, dx, dy, mapWidth, mapHeight);

	float endX = clampToMap(startX + t * dx, mapWidth);
	float endY = clampToMap(startY + t * dy, mapHeight);

	// Full 2D visual coordinate unification: align animStartPos directly onto the weapon muzzle of the rendered avatar.
	// client.js renders character sprites with exponential interpolation (lerp = 0.1 at ~60fps over 20Hz ticks), causing
	// the displayed character model to trail smoothly behind the authoritative instantaneous position.
	// Subtracting the full 2D spatial lag vector translates animStartPos directly onto (visualX, visualY), ensuring
	// zero lateral drift and zero forward/backward separation from the gun barrel under every angle, speed, and trajectory.
	if (shooter) {
		const float lagX = static_cast<float>(origin.x) - shooter->getVisualX();
		const float lagY = static_cast<float>(origin.y) - shooter->getVisualY();
		if (std::abs(lagX) > 0.05f || std::abs(lagY) > 0.05f) {
			animX = clampToMap(animX - lagX, mapWidth);
			animY = clampToMap(animY - lagY, mapHeight);
		}
	}

	// Spawn-time obstacle raycast: detect objects, resources, or creatures in front of weapon lateral trajectory
	float distToStart = (startX - static_cast<float>(origin.x)) * cosA + (startY - static_cast<float>(origin.y)) * sinA;
	float distToAnim = (animX - static_cast<float>(origin.x)) * cosA + (animY - static_cast<float>(origin.y)) * sinA;
	float maxScanDist = std::max(distToStart, distToAnim) + 40.0f;
	
	float lateralX = static_cast<float>(origin.x) - (edata.muzzleOffsetY * sinA);
	float lateralY = static_cast<float>(origin.y) + (edata.muzzleOffsetY * cosA);
	float checkEndX = lateralX + cosA * std::min(maxScanDist, static_cast<float>(range));
	float checkEndY = lateralY + sinA * std::min(maxScanDist, static_cast<float>(range));
	checkEndX = clampToMap(checkEndX, mapWidth);
	checkEndY = clampToMap(checkEndY, mapHeight);

	bool skipVisual = false;
	Position hitPos;
	Position rayStart(static_cast<uint16_t>(std::round(clampToMap(lateralX, mapWidth))), static_cast<uint16_t>(std::round(clampToMap(lateralY, mapHeight))));
	if (g_game.findClosestObstacleHit(shooter, rayStart, Position(static_cast<uint16_t>(std::round(checkEndX)), static_cast<uint16_t>(std::round(checkEndY))), hitPos)) {
		float distToHit = (static_cast<float>(hitPos.x) - lateralX) * cosA + 
		                  (static_cast<float>(hitPos.y) - lateralY) * sinA;
		// Suppress only when the obstacle is inside the shooter's own body. The
		// old threshold was the weapon's muzzle offset, which suppressed out to
		// 95 units on the ak47 and the sniper -- most close-quarters shots drew
		// no bullet at all. min() keeps every weapon at or below what it did
		// before, so nothing gained suppression from the change.
		const float suppressDist = std::min(distToStart + 15.0f, PROJECTILE_POINT_BLANK_SUPPRESS_DIST);
		if (distToHit <= suppressDist) {
			skipVisual = true;
			// Invisible, but still a bullet: without this it keeps the muzzle
			// offset and spawns PAST the obstacle it is touching, so hugging a
			// wall shot straight through it.
			startX = clampToMap(lateralX + cosA * std::max(0.0f, distToHit), mapWidth);
			startY = clampToMap(lateralY + sinA * std::max(0.0f, distToHit), mapHeight);
		} else {
			if (distToAnim > distToHit) {
				float scale = distToHit / (distToAnim > 0.0f ? distToAnim : 1.0f);
				animX = static_cast<float>(origin.x) + (animX - static_cast<float>(origin.x)) * scale;
				animY = static_cast<float>(origin.y) + (animY - static_cast<float>(origin.y)) * scale;
			}
			startX = animX;
			startY = animY;
		}
	} else {
		startX = animX;
		startY = animY;
	}

	// Close-range clamping protection: prevent visual animation origin from overshooting the trajectory endpoint
	float distToEnd = (endX - static_cast<float>(origin.x)) * cosA + (endY - static_cast<float>(origin.y)) * sinA;
	distToAnim = (animX - static_cast<float>(origin.x)) * cosA + (animY - static_cast<float>(origin.y)) * sinA;
	if (distToAnim > distToEnd) {
		if (distToEnd > 0.0f) {
			float scale = distToEnd / (distToAnim > 0.0f ? distToAnim : 1.0f);
			animX = static_cast<float>(origin.x) + (animX - static_cast<float>(origin.x)) * scale;
			animY = static_cast<float>(origin.y) + (animY - static_cast<float>(origin.y)) * scale;
		} else {
			animX = endX;
			animY = endY;
		}
	}

	ProjectileTrajectory trajectory;
	trajectory.startPos.x = static_cast<uint16_t>(std::round(startX));
	trajectory.startPos.y = static_cast<uint16_t>(std::round(startY));
	trajectory.animStartPos.x = static_cast<uint16_t>(std::round(animX));
	trajectory.animStartPos.y = static_cast<uint16_t>(std::round(animY));
	trajectory.endPos.x = static_cast<uint16_t>(std::round(endX));
	trajectory.endPos.y = static_cast<uint16_t>(std::round(endY));
	trajectory.velocityX = speed * cosA;
	trajectory.velocityY = speed * sinA;
	trajectory.skipVisualAnimation = skipVisual;
	return trajectory;
}

static MeleeTrace buildMeleeTrace(const Position& origin, uint8_t rotation, float offsetX, float offsetY, uint16_t range)
{
	const float angleRad = (rotation * MATH_TWO_PI) / 255.0f;
	const float cosA = cos(angleRad);
	const float sinA = sin(angleRad);
	const uint16_t dist = range > 0 ? range : 50;

	const float mapWidth = static_cast<float>(MapSize::widthUnits());
	const float mapHeight = static_cast<float>(MapSize::heightUnits());

	float startX = static_cast<float>(origin.x) + (offsetX * cosA) - (offsetY * sinA);
	float startY = static_cast<float>(origin.y) + (offsetX * sinA) + (offsetY * cosA);

	startX = clampToMap(startX, mapWidth);
	startY = clampToMap(startY, mapHeight);

	const float dx = cosA * dist;
	const float dy = sinA * dist;
	const float t = getMapBoundedSegmentScale(startX, startY, dx, dy, mapWidth, mapHeight);

	MeleeTrace trace;
	trace.startPos.x = static_cast<uint16_t>(std::round(startX));
	trace.startPos.y = static_cast<uint16_t>(std::round(startY));
	trace.endPos.x = static_cast<uint16_t>(std::round(clampToMap(startX + t * dx, mapWidth)));
	trace.endPos.y = static_cast<uint16_t>(std::round(clampToMap(startY + t * dy, mapHeight)));
	trace.directionX = cosA;
	trace.directionY = sinA;
	return trace;
}

static bool canMeleeHitTarget(Thing* target)
{
	// An agent is always attackable, whether or not it blocks movement. Those
	// are separate questions: agents.xml <body collision="false"> means "walk
	// through me", not "you cannot hurt me". Tying the two together silently
	// made non-solid agents invulnerable to melee AND to bullets.
	if (target->getAgent()) {
		return true;
	}

	if (target->hasCollision() || target->getResource() != nullptr) {
		return true;
	}

	if (Object* obj = target->getObject()) {
		const ObjectData* od = obj->getData();
		return od && obj->getMaxHealth() > 0 && !obj->isIndestructible();
	}

	return false;
}

// `sweep` is the lateral half-width of the swing -- <combat><radius>, or
// MELEE_HIT_FORGIVENESS when the weapon does not state one. Inflating every
// target shape by it turns the trace segment into a capsule, so a target beside
// the aim line is hit rather than only one the line passes through. It replaces
// the forgiveness constant rather than stacking on it: that constant exists to
// fatten the bare segment, which is the same job.
static bool checkMeleeTargetHit(Thing* target, const Position& startPos, const Position& endPos, float sweep, float& hitX, float& hitY)
{
	const float startX = static_cast<float>(startPos.x);
	const float startY = static_cast<float>(startPos.y);
	const float endX = static_cast<float>(endPos.x);
	const float endY = static_cast<float>(endPos.y);

	if (Object* obj = target->getObject()) {
		const ObjectData* od = obj->getData();
		if (!od) {
			return false;
		}

		CollisionRect rect;
		if (obj->getCollisionRect(rect)) {
			rect.halfWidth += sweep;
			rect.halfHeight += sweep;
			return Collision::checkSegmentRect(startX, startY, endX, endY, rect, hitX, hitY);
		}

		if (od->radius > 0) {
			CollisionCircle circle = { static_cast<float>(obj->getPosition().x), static_cast<float>(obj->getPosition().y), static_cast<float>(od->radius) + sweep };
			return Collision::checkSegmentCircle(startX, startY, endX, endY, circle, hitX, hitY);
		}

		CollisionRect fallbackRect;
		fallbackRect.x = static_cast<float>(obj->getPosition().x);
		fallbackRect.y = static_cast<float>(obj->getPosition().y);
		fallbackRect.halfWidth = 50.0f + sweep;
		fallbackRect.halfHeight = 50.0f + sweep;
		return Collision::checkSegmentRect(startX, startY, endX, endY, fallbackRect, hitX, hitY);
	}

	if (Resource* res = target->getResource()) {
		CollisionCircle circle = { static_cast<float>(res->getPosition().x), static_cast<float>(res->getPosition().y), res->getCollisionRadius() + sweep };
		return Collision::checkSegmentCircle(startX, startY, endX, endY, circle, hitX, hitY);
	}

	if (Creature* creature = target->getCreature()) {
		CollisionCircle circle = { static_cast<float>(creature->getPosition().x), static_cast<float>(creature->getPosition().y), creature->getCollisionRadius() + sweep };
		return Collision::checkSegmentCircle(startX, startY, endX, endY, circle, hitX, hitY);
	}

	return false;
}

// A gauge's ceiling as the byte the value actually is. GaugeMode::max is uint16
// because that is how it travels on the wire; a gauge byte cannot represent
// anything above 255, and a ceiling of 0 would make the bar undrawable.
static uint8_t gaugeCeiling(const GaugeMode& mode)
{
	return static_cast<uint8_t>(std::clamp<uint16_t>(mode.max, 1, 255));
}

// maxValue is the gauge's configured ceiling, not a constant 255: `!gauge-X-size`
// retunes it at runtime and the client is told the same number as `_max`, so a
// server that kept filling to 255 would sit off the top of the drawn bar.
static void increaseGauge(uint8_t& value, float& partial, float amount, bool resetPartialAtMax, uint8_t maxValue)
{
	if (value >= maxValue) {
		value = maxValue; // a size cut can leave a gauge above its new ceiling
		partial = 0.0f;
		return;
	}

	partial += amount;
	if (partial < 1.0f) {
		return;
	}

	uint8_t gain = static_cast<uint8_t>(partial);
	const uint8_t room = maxValue - value;
	if (gain >= room) {
		value = maxValue;
		partial = resetPartialAtMax ? 0.0f : partial - static_cast<float>(room);
	} else {
		value += gain;
		partial -= static_cast<float>(gain);
	}
}

static void decreaseGauge(uint8_t& value, float& partial, float amount, bool resetPartialAtMin)
{
	if (value == 0) {
		partial = 0.0f;
		return;
	}

	partial -= amount;
	if (partial > -1.0f) {
		return;
	}

	uint8_t loss = static_cast<uint8_t>(-partial);
	if (resetPartialAtMin && loss >= value) {
		value = 0;
		partial = 0.0f;
		return;
	}

	if (loss > value) {
		loss = value;
	}
	value -= loss;
	partial += static_cast<float>(loss);
}

// Appends `thing`'s currently-active area effects to `out` (which the caller
// owns and reuses).
//
// This used to return a std::vector by value and build it with a copy + insert
// + erase pass, which meant one or more heap allocations for EVERY entity in
// EVERY player's viewport on EVERY tick -- hundreds of thousands of
// allocations per second at scale, for a result that is empty for almost every
// entity (only a handful of object/resource types define area effects at all).
// Emitters bail out before touching `out`, so the common case now allocates
// nothing.
// POINTERS, not copies. This runs for every thing within reach of every player
// on every tick, and an AreaEffect holds a std::string -- copying each one into
// a scratch vector was the bulk of the environment scan's cost in a crowd,
// where "every thing within reach" is dozens of players plus the scenery. The
// pointees are owned by the loaded XML data (or by the Object itself) and
// outlive the scan.
static void appendActiveAreaEffects(Thing* thing, std::vector<const AreaEffect*>& out)
{
	// Agents can emit too (a radioactive ghoul irradiates like a radioactive
	// structure). The emitter moves, but the scan reads positions live, so
	// nothing else changes. A dying agent's field is already off.
	if (const Agent* agent = thing->getAgent()) {
		if (const AgentData* ad = agent->getData()) {
			if (!agent->isDying()) {
				for (const AreaEffect& effect : ad->areaEffects) {
					out.push_back(&effect);
				}
			}
		}
		return;
	}

	// A ghoul PLAYER emits its creature's fields too, so a radioactive ghoul
	// walking into someone irradiates them exactly as the world-spawned one
	// does. Read off the same AgentData as the branch above; the only difference
	// is which class is carrying the body around.
	//
	// It reaches itself and other ghouls as well, which costs nothing: a ghoul's
	// radiation rate is zeroed in computeGaugeRates, so the field lands on a
	// gauge that cannot move -- the same immunity agents get, by the same means.
	if (const Creature* creature = thing->getCreature()) {
		if (const Player* p = creature->getPlayer()) {
			if (const AgentData* gd = p->getGhoulData()) {
				for (const AreaEffect& effect : gd->areaEffects) {
					out.push_back(&effect);
				}
			}
		}
		return;
	}

	if (Resource* res = thing->getResource()) {
		if (const ResourceData* rd = g_resources.getResourceData(res->getResourceId())) {
			for (const AreaEffect& effect : rd->areaEffects) {
				out.push_back(&effect);
			}
		}
		return;
	}

	Object* obj = thing->getObject();
	if (!obj) {
		return;
	}

	// Cached on the Object, not a string-keyed lookup into ObjectManager: this
	// was one hash of the object's key per object per player per tick, and a
	// city tile box is full of objects.
	const ObjectData* od = obj->getData();
	if (!od) {
		return;
	}

	const std::vector<AreaEffect>& instanceEffects = obj->getInstanceAreaEffects();
	if (od->areaEffects.empty() && instanceEffects.empty()) {
		return;
	}

	// Same fuel filter as before, applied to type-level and per-instance
	// effects alike; hoisting the fuel read out of the loop keeps it a single
	// check instead of one per effect.
	const bool hasFuel = obj->getFuelMs() != 0;
	for (const AreaEffect& effect : od->areaEffects) {
		if (!effect.needsFuel || hasFuel) {
			out.push_back(&effect);
		}
	}
	for (const AreaEffect& effect : instanceEffects) {
		if (!effect.needsFuel || hasFuel) {
			out.push_back(&effect);
		}
	}
}

static AreaEffectScan scanAreaEffects(const Position& position)
{
	AreaEffectScan scan;

	// Reused across calls instead of reallocated: this runs once per player per
	// tick, and everything here is on the dispatcher thread. clear() keeps the
	// capacity, so after warmup these two buffers stop allocating entirely.
	static std::vector<Thing*> nearThings;
	static std::vector<const AreaEffect*> effects;

	// Only tiles that could hold an emitter reaching this position, not the
	// player's whole viewport. isWithinAreaEffect rejects everything further
	// away anyway, so this is the same answer for far less work: 25 tiles
	// against 2601 at maxViewport 2500, and the shipped content's longest
	// field is 2 tiles.
	const int32_t reach = static_cast<int32_t>(g_maxAreaEffectTileReach);
	const int32_t centerTileX = static_cast<int32_t>(position.x) / TILE_SIZE;
	const int32_t centerTileY = static_cast<int32_t>(position.y) / TILE_SIZE;

	nearThings.clear();
	g_game.map.getThingsInTileBox(centerTileX - reach, centerTileY - reach,
	                              centerTileX + reach, centerTileY + reach, nearThings);

	for (Thing* thing : nearThings) {
		effects.clear();
		appendActiveAreaEffects(thing, effects);
		if (effects.empty()) {
			continue;
		}

		const Position& emitterPos = thing->getPosition();
		for (const AreaEffect* areaEffect : effects) {
			if (!isWithinAreaEffect(*areaEffect, emitterPos, position)) {
				continue;
			}

			// Interned kind, not a string compare (see AreaEffectKind).
			switch (areaEffect->kind) {
				case AreaEffectKind::Radiation:
					scan.radiation = true;
					scan.maxRadiationStrength = std::max(scan.maxRadiationStrength,
					                                     static_cast<float>(areaEffect->strength));
					break;
				case AreaEffectKind::Warm:
					scan.warmth = true;
					break;
				case AreaEffectKind::Food:
					scan.food = true;
					break;
				case AreaEffectKind::Other:
					break;
			}
		}
	}

	return scan;
}

// Checks whether a gauge value has crossed one of three notification thresholds
// (80%/50%/20% of 255) and broadcasts a notification if so.
// notifLevel tracks the last level sent (0 = none, 1-3 = severity).
// If invert=false, notifications fire as the value drops (hunger, cold).
// If invert=true, notifications fire as the value rises (radiation).
//
// The latch clears with a margin, not at the same 204 it arms on. Without it a
// gauge dithering across the boundary re-armed and re-fired every few ticks --
// standing at the edge of a firepit's warmth at night, or at the edge of a
// feeder, is exactly that, and this runs four times per player per tick. These
// are BROADCASTS: every crossing costs a frame to every player in range and pops
// the icon again on all their screens, so it is the most expensive repeat in the
// gauge path.
static constexpr uint8_t GAUGE_NOTIFY_RELEASE_MARGIN = 8;

static void checkGaugeNotification(
	uint8_t& notifLevel, uint8_t value, bool invert,
	uint8_t pid, uint8_t notifType, const Position& pos)
{
	uint8_t v = invert ? (255 - value) : value;
	if (v > 204 + GAUGE_NOTIFY_RELEASE_MARGIN) {
		notifLevel = 0;
	} else if (v <= 204 && v > 127 && notifLevel < 1) {
		notifLevel = 1;
		g_game.broadcastNotification(pid, notifType, 0, pos); // ~80% threshold
	} else if (v <= 127 && v > 51 && notifLevel < 2) {
		notifLevel = 2;
		g_game.broadcastNotification(pid, notifType, 1, pos); // ~50% threshold
	} else if (v <= 51 && notifLevel < 3) {
		notifLevel = 3;
		g_game.broadcastNotification(pid, notifType, 2, pos); // ~20% threshold
	}
}

uint32_t Player::playerAutoID = 0x10000000;
uint32_t Player::playerIDLimit = 0x20000000;

Player::Player(ProtocolGame_ptr p) :
	Creature(),
	inventory(this),
	lastPing(OTSYS_TIME()),
	lastPong(lastPing),
	client(std::move(p))
{
	speed = 230;
	view = aim_view::normalView(ConfigManager::getNumber(ConfigManager::MAX_VIEWPORT_X),
		ConfigManager::getNumber(ConfigManager::MAX_VIEWPORT_Y));
	// config.lua startingLevel (0 = the client's own starting level). Seeding
	// experience to that level's threshold keeps the XP still owed for the NEXT
	// level identical whatever the starting level is. score stays 0: a level
	// handed out for free is not earned XP and must not seed the leaderboard.
	level = std::min<uint32_t>(std::max(0, ConfigManager::getNumber(ConfigManager::STARTING_LEVEL)), PLAYER_MAX_LEVEL);
	experience = getRequiredXP(level);
	clanId = -1;
	isClanLeader = false;
	lastClanActionTime = 0;
	lastClanCreateTime = 0;
	lastClanJoinRequestTime = 0;
	lastClanDeleteTime = 0;
	lastClanManageTime = 0;
	lastClanLeaveTime = 0;
	lastSentTeamPosition = Position(0, 0);
	lastSentTeamPositionTime = 0;
}

Player::~Player()
{
	// These scheduler tasks capture `this`; if the player is deleted (disconnect,
	// death) while one is pending, firing it would be a use-after-free. Player
	// ids are deterministic per login slot, so a reused slot could even land the
	// stale task on a new player. Stop them all here — the single choke point
	// every deletion path passes through.
	g_scheduler.stopEvent(actionEventId);
	g_scheduler.stopEvent(reloadEventId);
	g_scheduler.stopEvent(equipEventId);
	g_scheduler.stopEvent(modChange.eventId);
	g_scheduler.stopEvent(crafting.eventId);
}

void Player::setShift(bool val)
{
	shift = val;
}

bool Player::hasInteractionSlowLock() const
{
	// One shared, non-stacking slow lock: reloading, equipping (weapon,
	// wearable, or buildable), consuming, or crafting in the own inventory.
	return reloadEventId != 0 || equipEventId != 0 || isConsuming || crafting.iid != 0 || modChange.eventId != 0;
}

void Player::updateAim(int32_t viewX, int32_t viewY, uint64_t now)
{
	const EquipableData* weapon = getEquippedWeaponData();
	const bool canAim = weapon && weapon->aim.enabled;
	const bool active = aim_view::aimShouldBeActive(aimHeld, getHealth() > 0, isGhoul(), canAim, hasInteractionSlowLock());
	aimMoveFactor = active ? weapon->aim.move : 1.0f;
	if (active != aimActive) {
		aimActive = active;
		if (active) aimSince = now;
		if (client) {
			client->sendAimState(active, static_cast<uint16_t>(viewX), static_cast<uint16_t>(viewY));
		}
	}
	// Until the next tick, what canSee and the visibility scan answer with.
	// Rebuilt only here, with the static tile box in the same pass, so a
	// surgical update never inserts a static the strip diff would miss.
	// aimedView gives the normal view for a weapon without a <view>.
	view = (aimActive && weapon)
		? aim_view::aimedView(weapon->view, viewX, viewY, aim_view::rotationToRadians(getRotation()))
		: aim_view::normalView(viewX, viewY);
}

uint16_t Player::getSpeed() const
{
	// A ghoul walks at its creature's pace (agents.xml <movement speed>, or
	// nightSpeed after dark), and running adds the same FLAT bonus a player
	// gets -- 92, the gap between 230 and 322. Flat rather than the 1.4x ratio:
	// a fast_ghoul already outpaces a player at a walk, and scaling would
	// compound that into something nobody could ever break away from. The
	// stamina gate is the player's, unchanged, so a ghoul that has run itself
	// empty drops back to a walk exactly as a person does.
	// NOT gated on CONTROL_NO_MOVE, and that was a real bug when it was.
	//
	// This value is two things at once: the movement INPUT Game::updateMovement
	// divides into a per-tick step, and the WIRE speed Creature::buildUpdate
	// packs for the client to dead-reckon with. Returning 0 for a stun killed
	// both. Killing the input was right; killing the wire speed told every
	// client "this entity is not moving" while the server was still sliding them
	// under knockback, so the sprite sat still where the collision body had gone
	// -- a visible desync, reported from play.
	//
	// A stun takes away SELF-DIRECTED movement only. Being shoved is something
	// done TO you and must still land, which is what makes a stunned player
	// something you can knock out of a doorway rather than a statue. The gate
	// therefore lives on the move mask in Game::updateMovement, where the
	// player's own intent is read, and recoil is applied past it untouched.

	// Running is a separate permission from moving: a leg wound stops the sprint
	// and leaves the walk.
	// Aiming walks at the weapon's aimMove and never runs.
	const bool running = shift && stamina > 0 && !cannot(CONTROL_NO_RUN) && !aimActive;

	int32_t baseSpeed;
	if (ghoulData) {
		baseSpeed = (ghoulData->nightSpeed > 0 && g_game.isNight())
			? ghoulData->nightSpeed
			: ghoulData->speed;
		if (running) {
			baseSpeed += g_game.getGhoulRules().shiftSpeedBonus;
		}
	} else {
		// Calculate base speed dynamically to prevent infinite sprint bugs
		baseSpeed = running ? 322 : 230;
	}

	// Apply stepped-on tile speed modifiers (e.g. speed increase on roads)
	int32_t currentSpeed = baseSpeed + getTileSpeedDelta();

	if (hasInteractionSlowLock()) {
		// Flat reduction so the running bonus is fully preserved while locked.
		currentSpeed -= ConfigManager::getNumber(ConfigManager::INTERACTION_SLOW_AMOUNT);
	}

	// What the armour costs you. <modifier key="speedMultiplier"> is declared on
	// seven wearables in wearables.xml as a small NEGATIVE fraction (-0.01 for a
	// gas mask, -0.03 for the heaviest plate), was parsed into
	// WearableData::effects, and until now was read by absolutely nothing -- so
	// every weight penalty in the game was silently doing nothing at all.
	//
	// Signed as a delta to 1.0 rather than as an outright factor, which is what
	// the shipped values already assume: -0.03 means "three percent slower", not
	// "three percent of your speed".
	const float wearableSpeed = wearableSpeedModifier();

	// Apply Status Effect Speed Modifiers (multiplier & flat add)
	const ConditionTotals& effects = conditionTotals();
	currentSpeed = static_cast<int32_t>(
		(currentSpeed + effects.speedAdd) * effects.speedMultiplier * (1.0f + wearableSpeed) * aimMoveFactor);

	return static_cast<uint16_t>(std::max<int32_t>(PLAYER_MIN_SPEED, currentSpeed));
}

// The hit/heal flash. Normally everyone who can see this player gets it, which
// is what makes combat readable at a glance.
//
// The exception is environment damage. `isTick` is exactly the "a gauge did
// this" flag -- radiation, hunger, cold and poison ticks set it, every weapon,
// explosion and trap does not -- and it is the one source that fires for EVERY
// player at once. In a radioactive area that turns a cosmetic flash into the
// server's dominant cost: each victim's flash is a separate WebSocket frame to
// every player who can see them, so N players in one viewport cost N^2/2 frames
// every two seconds. Measured with ~200 players standing together: ~5,000 of the
// 6,400 frames/s leaving the server were these, while the entire entity stream
// was ~1,000.
//
// showEnvironmentDamageToOthers = false keeps the victim's own flash (and the
// screen shake, which only their client draws anyway) and drops the fan-out.
void Player::broadcastHealthAura(bool damage, bool isTick)
{
	const uint8_t pid = static_cast<uint8_t>(getGUID());

	if (isTick && !ConfigManager::getBoolean(ConfigManager::SHOW_ENVIRONMENT_DAMAGE_TO_OTHERS)) {
		if (client) {
			if (damage) {
				client->sendPlayerHit(pid, 0);
			} else {
				client->sendPlayerHeal(pid);
			}
		}
		return;
	}

	// `this` as the subject: a trap that fires from the tile-LEAVE hook damages
	// a player who is momentarily in no tile bucket, and the sweep cannot find
	// them.
	if (damage) {
		g_game.broadcastPlayerHit(pid, 0, getPosition(), this);
	} else {
		g_game.broadcastPlayerHeal(pid, getPosition(), this);
	}
}

int32_t Player::changeHealth(int32_t healthDelta, bool broadcast, bool force, bool isTick, const std::string& damageType, Player* attacker)
{
	if (healthDelta == 0) return 0;

	if (healthDelta < 0 && !force && isGhostMode()) {
		return 0;
	}

	if (healthDelta < 0 && hasGroupFlag(GroupFlag::Immortal)) {
		return 0;
	}

	// worldType. Deliberately the ONLY place PvP is gated: every damage path
	// funnels through here, so suppressing the health loss alone leaves the
	// knockback, hit flash and screen shake intact -- and players stay able to
	// shove each other out of doorways, which they cannot otherwise do.
	if (healthDelta < 0 && !g_game.canHarmPlayer(attacker, this)) {
		return 0;
	}

	if (healthDelta < 0 && !damageType.empty()) {
		float resistance = getWearableModifier(damageType + "Resistance");
		if (resistance > 0.0f) {
			float reducedAmount = static_cast<float>(healthDelta) * (1.0f - resistance);
			healthDelta = static_cast<int32_t>(std::round(reducedAmount));
			if (healthDelta == 0) return 0;
		}
	}

	// <damageTaken multiplier=>: vulnerability and fortification, applied to
	// every source rather than only typed ones -- being brittle should mean
	// brittle to a landmine as well as to a bullet, which is exactly the case a
	// damageType-gated version would miss.
	//
	// After the wearable resistance so armour is not scaled by it twice, and
	// rounded away from zero so a reduction can never turn a real hit into
	// immunity.
	if (healthDelta < 0) {
		const float takenMultiplier = conditionTotals().damageTakenMultiplier;
		if (takenMultiplier != 1.0f) {
			const int32_t scaled = static_cast<int32_t>(
				std::lround(static_cast<float>(healthDelta) * takenMultiplier));
			healthDelta = scaled == 0 ? -1 : scaled;
		}
	}

	// A ghoul's health pool is its creature's, not the 255 the bar can hold, so
	// damage quoted in weapon units has to be converted into bar units. See
	// getDamageToGaugeScale: an armoured ghoul (800) loses a fifth of a bar
	// point per point of damage where a normal one (160) loses one and a half.
	//
	// Only real damage. `isTick` marks the gauge-driven paths (hunger, cold,
	// radiation, poison), which already work in bar units -- scaling those would
	// convert a number that was never in weapon units in the first place. It is
	// moot for a ghoul today, whose gauges cannot reach a lethal threshold, but
	// the distinction has to be right for it to stay moot if they ever can.
	//
	// Rounded away from zero so a big pool never becomes immunity: an armoured
	// ghoul must still lose ground to a knife.
	if (healthDelta < 0 && !isTick && ghoulDamageScale != 1.0f) {
		const float scaled = static_cast<float>(-healthDelta) * ghoulDamageScale;
		const int32_t loss = std::max<int32_t>(1, static_cast<int32_t>(std::lround(scaled)));
		healthDelta = -std::min<int32_t>(loss, 255);
	}

	uint64_t now = OTSYS_TIME();
	bool canAura = broadcast && (force || (now - lastHealthAura >= 2000));
	uint8_t oldHealth = health;
	uint32_t fullHp = (ghoulData && ghoulData->health > 0) ? ghoulData->health : gaugeCeiling(g_game.getActiveGauges().life);
	if (fullHp == 0) fullHp = 255;

	if (healthDelta < 0) {
		// Health is a 0-255 gauge; damage above 255 must saturate, not wrap
		// (a truncating uint8_t cast would turn 300 damage into 44).
		uint8_t lose = static_cast<uint8_t>(std::min<int32_t>(255, -healthDelta));
		if (lose > health) lose = health;
		health -= lose;
		
		lastDamageTime = now;
		if (attacker && attacker != this) {
			registerAttacker(attacker->getGUID());
		}

		if (isTick) {
			accumulatedTickDamage += static_cast<int32_t>(lose);
			if ((canAura || health == 0) && accumulatedTickDamage > 0) {
				int32_t displayLoss = accumulatedTickDamage;
				accumulatedTickDamage = 0;
				uint8_t pct = static_cast<uint8_t>(std::clamp((displayLoss * 100) / static_cast<int32_t>(fullHp), 0, 100));
				g_game.broadcastDamageIndicator(getPosition(), -static_cast<int16_t>(displayLoss), pct, this);
				broadcastHealthAura(true, isTick);
				lastHealthAura = now;
			}
		} else {
			accumulatedTickDamage = 0;
			int32_t displayLoss = lose;
			if (ghoulData && ghoulDamageScale > 0.0f && ghoulDamageScale != 1.0f) {
				displayLoss = static_cast<int32_t>(std::lround(static_cast<float>(lose) / ghoulDamageScale));
			}
			if (displayLoss > 0) {
				uint8_t pct = static_cast<uint8_t>(std::clamp((displayLoss * 100) / static_cast<int32_t>(fullHp), 0, 100));
				g_game.broadcastDamageIndicator(getPosition(), -static_cast<int16_t>(displayLoss), pct, this);
			}
			if (canAura && lose > 0) {
				broadcastHealthAura(true, isTick);
				lastHealthAura = now;
			}
		}

		if (health == 0 && oldHealth > 0) {
			g_npcs.forget(getID());
			g_quests.forget(getID());
			if (g_game.tryResurrectPlayer(this)) {
				fmt::print("DEBUG: Player {} reached 0 HP but was resurrected by a respawner object.\n", getName());
			} else {
				g_events.emit({EventType::Death, this, ""});
                g_accountRuns.finish(this, true);
				if (attacker && attacker != this) {
					g_game.handlePlayerKill(attacker, this);
					GameEvent bounty{EventType::Bounty, attacker, "outlaw"};
					bounty.victim = this;
					g_events.emit(bounty);
				}
				// Server tab: who died and, when a player did it, who. The
				// victim's own client is about to be closed, so it is skipped.
				g_game.broadcastServerLog(ServerLogKind::DEATH, static_cast<uint8_t>(getGUID()),
					(attacker && attacker != this) ? static_cast<uint8_t>(attacker->getGUID()) : SERVER_LOG_NO_PLAYER, "", this);
				fmt::print("DEBUG: Player {} DIED! Destroying owned objects and dropping loot, score={}, client={}\n", getName(), getScore(), (client ? "yes" : "no"));
				if (ghoulData) {
					// A ghoul leaves what the creature leaves -- its
					// agents.xml <onDeath>, exactly as the world-spawned one
					// does. It has no inventory to spill and no buildings to
					// lose, so this replaces both of those rather than adding
					// to them. Free-for-all loot, owned by nobody.
					dropGhoulRemains();
				} else {
					// No kit for a ghoul: a kit rewards how far the last
					// CHARACTER got, and a body the round handed out is not
					// that. It would also survive into the NEXT round, where a
					// score earned before the world was rebuilt has no meaning.
					g_game.recordDeathForKit(getToken(), level);
					g_game.destroyObjectsOwnedBy(getGUID());
					g_game.cancelTrade(getID(), "Trade cancelled: player died.");
					cancelModChange();
					inventory.dropAllOnDeath();
				}
				g_game.onGhoulCharacterDied(this);
				if (client) {
					// What killed them may still be queued (e.g. the blast
					// entity): put it on the wire before the death opcode, or
					// it dies with the connection.
					client->flushUpdates();
					client->sendPlayerDie(static_cast<uint16_t>(std::min<uint32_t>(getKills(), 0xFFFF)));
					// The batch is normally flushed at the end of the tick, but the
					// graceful close below marks the connection closed first and a
					// late flush is dropped -- so the death opcode never reached the
					// client and it saw a plain "connection lost".
					client->flushOutputBatch();
					client->disconnect();
				}

				// Death removes the character in both cases. Losing the
				// connection only ends the session now — it leaves the player in
				// the world as AFK — so a dead player who still had a client has
				// to be removed here as well, not by the connection close.
				// Deferred: death by gauge tick happens while Game::update is
				// iterating the players map, and removePlayer erases from it.
				g_game.scheduleRemovePlayer(this);
			}
		}
	} else {
		const uint8_t lifeMax = gaugeCeiling(g_game.getActiveGauges().life);
		if (health < lifeMax) {
			// int32 throughout: healthDelta is now wide enough to overflow a
			// uint16 sum, and a heal that wrapped would read as a heal of ~0.
			const int32_t newHealth = static_cast<int32_t>(health) + healthDelta;
			uint8_t gain = static_cast<uint8_t>(std::min<int32_t>(lifeMax, newHealth) - health);
			health += gain;
			
			if (isTick) {
				accumulatedTickHeal += static_cast<int32_t>(gain);
				if (canAura && accumulatedTickHeal > 0) {
					int32_t displayGain = accumulatedTickHeal;
					accumulatedTickHeal = 0;
					uint8_t pct = static_cast<uint8_t>(std::clamp((displayGain * 100) / static_cast<int32_t>(fullHp), 0, 100));
					g_game.broadcastDamageIndicator(getPosition(), static_cast<int16_t>(displayGain), pct, this);
					broadcastHealthAura(false, isTick);
					lastHealthAura = now;
				}
			} else {
				accumulatedTickHeal = 0;
				if (gain > 0) {
					uint8_t pct = static_cast<uint8_t>(std::clamp((static_cast<int32_t>(gain) * 100) / static_cast<int32_t>(fullHp), 0, 100));
					g_game.broadcastDamageIndicator(getPosition(), static_cast<int16_t>(gain), pct, this);
				}
				if (canAura && gain > 0) {
					// Green Aura for health restoration (Opcode 22)
					broadcastHealthAura(false, isTick);
					lastHealthAura = now;
				}
			}
		}
	}

	// Health Notifications
	checkGaugeNotification(healthNotificationLevel, health, false,
		static_cast<uint8_t>(getGUID()), 0, getPosition());

	// Only correct the client's health bar for a direct action; a natural partial
	// tick is what the client already predicts. Queued, not sent: several of
	// these can land in one tick (a burst of hits, a heal on top of poison) and
	// they must cost one frame, not one each.
	if (health != oldHealth && !isTick) {
		markGaugesDirty();
	}

	int32_t deltaApplied = static_cast<int32_t>(health) - static_cast<int32_t>(oldHealth);
	return deltaApplied;

	// Measured off the BAR rather than off the request, so every clamp above is
	// already accounted for: the resistance reduction, the ghoul scale, the
	// saturation at 255 and the overkill trim to whatever the target had left.
	// Death is included -- a lethal hit reports exactly the health it removed.
	return deltaApplied;
}

void Player::applyResurrection(const RespawnerData& data)
{
	// A resurrection starts a new life, so the agent survival gate restarts too
	// and any grudges the previous life earned are forgotten.
	resetSurvivalTimer();

	// Both halves of "forgotten", which resetSurvivalTimer only did one of: the
	// broken repellents a previous life provoked went with the provocations they
	// came from, or a drug bought before dying would come back already cancelled.
	clearBrokenRepels();

	// And the effects themselves. This is the ONLY place removeOnDeath can be
	// observed -- an ordinary death removes the character outright, so nothing
	// survives to carry an effect -- and until now it was parsed and honoured
	// nowhere, so a respawner handed back a body that was still poisoned.
	conditions.removeOnDeath();
	drugWithdrawn = false;
	syncConditionVisual(0, true);

	// A new life. Anything holding state about the old one -- notably the
	// half-applied tick batch in Creature::updateConditions, whose entries came
	// from conditions the sweep above has just destroyed -- tests this to find
	// out. See Player::conditionTicksShouldContinue.
	++lifeGeneration;

	const Game::ActiveGauges& modes = g_game.getActiveGauges();
	health = std::max<uint8_t>(1, percentToGaugeValue(data.healthPercent, gaugeCeiling(modes.life)));
	stamina = percentToGaugeValue(data.staminaPercent, gaugeCeiling(modes.stamina));
	hunger = percentToGaugeValue(data.hungerPercent, gaugeCeiling(modes.food));
	cold = percentToGaugeValue(data.coldPercent, gaugeCeiling(modes.warmth));
	radiation = 0;

	healthPartial = 0.0f;
	staminaPartial = 0.0f;
	hungerPartial = 0.0f;
	coldPartial = 0.0f;
	radiationPartial = 0.0f;

	// Immediate: a resurrection jumps every gauge at once and the player is
	// looking right at it.
	gaugesDirty = false;
	gaugesForced = false;
	lastSentGauges = packGauges();
	if (client) client->sendGauges();
}

// Tail shared by the two environment-immune paths: the inventory decay tick.
// These used to run their own 1 Hz gauge resync; they no longer need one, for
// the same reason nothing else does (see the resync policy note at the top).
void Player::syncImmuneGauges(uint32_t elapsedMs)
{
	inventory.update(elapsedMs);
	updatePlayerConditions(elapsedMs);
}

// Two bits per gauge, GaugeSlot order, exactly as ServerOpcode::GAUGE_STATE
// carries it. The client unpacks with the same shifts.
uint16_t Player::packGaugeDirections(GaugeDirection life, GaugeDirection food, GaugeDirection warmth,
	GaugeDirection stamina, GaugeDirection radiation) const
{
	const auto bits = [](GaugeDirection d, GaugeSlot slot) {
		return static_cast<uint16_t>(static_cast<uint16_t>(d) << (static_cast<uint16_t>(slot) * 2));
	};

	return static_cast<uint16_t>(
		bits(life, GaugeSlot::LIFE) | bits(food, GaugeSlot::FOOD) | bits(warmth, GaugeSlot::WARMTH) |
		bits(stamina, GaugeSlot::STAMINA) | bits(radiation, GaugeSlot::RADIATION));
}

// Edge-triggered, and the ONLY writer of the client's five direction latches.
//
// This replaces syncLifeEffect + syncStaminaState + syncColdState + three
// syncAreaSignal calls + resendAreaSignals. Those were six independent
// edge detectors over one piece of state, and the bugs they produced were all
// the same bug: an edge that did not fire for a session that had just attached
// (the feeder bug -- reconnecting inside a feeder left the food bar draining
// for the rest of the session while the server held hunger at 255), or an edge
// that fired in the wrong order against another one.
void Player::flushGaugeDirections(uint16_t packed)
{
	if (!client) {
		// Nothing heard this, so the latch cannot be claimed as known -- the next
		// session to attach has to be told from scratch.
		gaugeDirectionsKnown = false;
		return;
	}

	if (gaugeDirectionsKnown && packed == lastSentGaugeDirections) {
		return;
	}

	gaugeDirectionsKnown = true;
	lastSentGaugeDirections = packed;
	client->sendGaugeState(packed);
}

// The one place a GAUGES frame is emitted from the tick, and it fires only when
// something asked for it. Read the note on the resync policy above first.
//
// `gaugesDirty` means a value moved in a way the client cannot predict — a hit
// taken, a bite of food, a stamina chunk spent on a swing. Several of those can
// land in one tick, so they are collapsed here into a single frame, and dropped
// entirely if the five bytes did not actually change.
//
// `gaugesForced` means the CLIENT is presumed wrong rather than the value having
// moved, so it bypasses that dedupe: the drifted-client cases are mostly ones
// where the server's own bytes have not changed at all (a full food bar the
// feeder has held at 255 the whole time the tab was hidden).
//
// Ordinary gauge drain is pushed by neither: a bar that is simply falling is
// exactly what the client predicts correctly.
void Player::flushGaugeSync()
{
	if (!client) {
		gaugesDirty = false;
		gaugesForced = false;
		return;
	}

	if (!gaugesDirty && !gaugesForced) {
		return;
	}

	const uint64_t packed = packGauges();
	if (!gaugesForced && packed == lastSentGauges) {
		gaugesDirty = false;
		return;
	}

	gaugesDirty = false;
	gaugesForced = false;
	lastSentGauges = packed;
	client->sendGauges();
}

int32_t Player::resistanceRate(std::string_view modifierKey) const
{
	// Bare-headed is the common case and getEquippedWearableData costs an item
	// lookup plus a string-keyed hash into EquipmentManager; this runs per
	// player per tick, so answer it from the iid alone.
	if (equippedWearableIID == 0) {
		return 0;
	}
	return static_cast<int32_t>(std::lround(getWearableModifier(modifierKey) * GAUGE_RATE_SCALE));
}

// The rates this particular player's client should be running, as integers.
//
// This is the mechanism the whole gauge design rests on: whatever goes out
// here, the tick then integrates on the SAME integers (see updateGauges), so
// client and server agree by identity instead of by two implementations
// happening to match. Three things are folded in that the client cannot work
// out for itself:
//
// 1. Resistances. `updateGauge` in client.js reads `gauge.bonus`, which is only
//    ever written from `ENTITIES[__ENTITIE_PLAYER__].clothes[skin]` -- a pure
//    sprite table (client.js 4839+) with no `warm` or `rad` key at all, so the
//    lookup always misses and both bonuses stay 0 for the whole session. The
//    real per-item `warm`/`rad` values live on `INVENTORY[iid]`, a different
//    table the gauge path never consults. Every point of
//    coldResistance/radiationResistance the server applied was therefore
//    invisible to the client and showed up as drift.
// 2. The radiation field's strength multiplier, which has no other wire
//    representation. Folding it in here is what closes the last known
//    divergence in this system; see updateRadiationGauge.
// 3. The life-drain multiplier. Each bad gauge takes a FULL speedDec off life
//    independently, so three bad gauges drain three times as fast -- and the
//    client, which only ever integrated one, predicted a third of the true
//    rate. Nothing corrected it either: gauge damage passes isTick=true, which
//    deliberately does not mark the gauges dirty. A starving, freezing,
//    irradiated player therefore watched a life bar that was lying to them
//    right up until they died. The multiplier rides in on the rate, and
//    computeLifeChange applies it once rather than looping.
//
// The feeder is deliberately NOT folded in any more. It used to force food
// speedDec to 0 to make the client hold, because no opcode could make a food
// bar rise; GAUGE_STATE can say RISE, so the rate states the configured speed
// and the DIRECTION states what is happening to it. That separation also means
// walking into a feeder no longer re-sends this message at all.
Player::GaugeRates Player::computeGaugeRates(const LifeDrainProfile& drain) const
{
	GaugeRates rates{};
	if (!g_game.getActiveMode()) {
		return rates; // no mode: no meaningful rates, and nothing integrates yet
	}

	const Game::ActiveGauges& g = g_game.getActiveGauges();
	const int32_t coldResist = resistanceRate("coldResistance");
	const int32_t radResist = resistanceRate("radiationResistance");

	auto rateOf = [&rates](GaugeSlot slot, RateField field) -> uint16_t& {
		return rates[gaugeRateIndex(slot, field)];
	};

	auto store = [&rateOf](GaugeSlot slot, uint16_t max, int32_t inc, int32_t dec) {
		constexpr int32_t RATE_MAX = 65535; // the wire field is uint16
		rateOf(slot, RateField::MAX) = max;
		rateOf(slot, RateField::INC) = static_cast<uint16_t>(std::clamp(inc, 0, RATE_MAX));
		rateOf(slot, RateField::DEC) = static_cast<uint16_t>(std::clamp(dec, 0, RATE_MAX));
	};

	// Status effect regen modifiers, folded in HERE and nowhere else.
	//
	// This is the only place they can go. The rates are what the client
	// integrates, and the tick below integrates the same numbers back out of
	// `rates` -- so a regen multiplier applied in the tick math instead would
	// speed the server's bar up while the client's kept the old pace, which is
	// precisely the drift this function exists to prevent. Folding it in here
	// also means the existing edge trigger re-sends the rates the moment a stage
	// changes them, and not one frame more often.
	//
	// These were parsed out of conditions.xml into four accessors that
	// nothing ever called, so <healthRegen>, <staminaRegen> and <staminaDrain>
	// did nothing whatsoever; regen_elixir was an entirely inert effect.
	const ConditionTotals& effects = conditionTotals();
	const auto scaled = [](int32_t rate, float multiplier) {
		return static_cast<int32_t>(std::lround(static_cast<float>(rate) * multiplier));
	};

	store(GaugeSlot::LIFE, g.life.max, scaled(g.life.speedInc, effects.healthRegenMultiplier),
		g.life.speedDec * drain.drains);
	store(GaugeSlot::FOOD, g.food.max, g.food.speedInc, g.food.speedDec);
	store(GaugeSlot::WARMTH, g.warmth.max, g.warmth.speedInc + coldResist, g.warmth.speedDec - coldResist);
	store(GaugeSlot::STAMINA, g.stamina.max,
		scaled(g.stamina.speedInc, effects.staminaRegenMultiplier),
		scaled(g.stamina.speedDec, effects.staminaDrainMultiplier));
	// Radiation is the inverted gauge: the client's bar is cleanliness, so its
	// speedDec is the server's rise-in-a-field rate and its speedInc the decay.
	// Resistance therefore signs the same way round as it does on cold.
	//
	// `radiationStrength` is the emitter's own multiplier, cached by the area
	// scan. It had no wire representation at all, so a field with strength != 1
	// irradiated faster on the server than the client predicted and only a value
	// push ever corrected it. Every shipped field is strength 1 (objects.xml),
	// so this was latent rather than live -- but it is the kind of latent that
	// surfaces the day someone authors a hot zone.
	const float radStrength = (inRadiation && radiationStrength > 0.0f) ? radiationStrength : 1.0f;
	const int32_t radRise = static_cast<int32_t>(
		std::lround((static_cast<float>(g.radiation.speedDec) - static_cast<float>(radResist)) * radStrength));
	store(GaugeSlot::RADIATION, g.radiation.max, g.radiation.speedInc + radResist, radRise);

	// A ghoul does not eat, freeze or irradiate, and it runs longer than a
	// person. These are the SAME adjustments client.js already makes for a ghoul
	// in World.initGauges -- and they have to be restated here rather than left
	// to the client, because MODDED_GAUGES_VALUES overwrites every gauge's rates
	// wholesale when it arrives, which would put a ghoul straight back onto
	// human metabolism. Restating them keeps the two simulations identical,
	// which is the whole contract of this function.
	if (ghoulData) {
		// Zeroing these rates is not just a message to the client: the tick
		// integrates on them too, and every direction below is derived from
		// "is this rate above zero", so a ghoul's food/warmth/radiation bars
		// come out HOLD without needing a second ghoul test anywhere.
		rateOf(GaugeSlot::FOOD, RateField::DEC) = 0;      // food never drains
		rateOf(GaugeSlot::WARMTH, RateField::DEC) = 0;    // warmth never drains
		rateOf(GaugeSlot::RADIATION, RateField::DEC) = 0; // radiation never accumulates
		rateOf(GaugeSlot::STAMINA, RateField::INC) =
			static_cast<uint16_t>(std::min<int32_t>(65535, g.stamina.speedInc * 2));
		rateOf(GaugeSlot::STAMINA, RateField::DEC) = static_cast<uint16_t>(g.stamina.speedDec / 2);

		// No passive life regen. Nothing else stops it: with food and warmth
		// pinned full and radiation at zero, every lifeRegenAbovePct threshold
		// in lifeDrainProfile passes forever, so a ghoul would heal to full
		// between fights -- and since ghouls also respawn instantly and without
		// limit, that removes any reward for chipping one down. Agents cannot
		// heal either, so this is also what the creature already is.
		rateOf(GaugeSlot::LIFE, RateField::INC) = 0;
	}

	return rates;
}

// Edge-triggered: one frame when a coat goes on, one when a life-drain
// threshold is crossed. Returns the rates either way, because the tick has to
// integrate on exactly what was sent.
Player::GaugeRates Player::syncGaugeRates(const GaugeRates& rates)
{
	if (!client) {
		gaugeRatesKnown = false;
		return rates;
	}

	if (gaugeRatesKnown && rates == lastSentGaugeRates) {
		return rates;
	}

	gaugeRatesKnown = true;
	lastSentGaugeRates = rates;
	client->sendModdedGaugesValues(rates);
	return rates;
}

bool Player::isRunningThisTick() const
{
	return shift && getMoveMask() != 0 && walkedLastTick && stamina > 0 && !aimActive;
}

// The rate each gauge a scenario region touches runs this tick: the region's,
// plus the ordinary branch's when that runs the same way. Mirrors the branch
// tests in the update functions below, from the same start-of-tick state.
Player::ScenarioNets Player::scenarioNets(const GaugeRates& legacy, const LifeDrainProfile& drain, uint64_t now) const
{
	ScenarioNets nets{};
	const auto inc = [&legacy](GaugeSlot slot) { return static_cast<int32_t>(legacy[gaugeRateIndex(slot, RateField::INC)]); };
	const auto dec = [&legacy](GaugeSlot slot) { return static_cast<int32_t>(legacy[gaugeRateIndex(slot, RateField::DEC)]); };
	const Game::ActiveGauges& g = g_game.getActiveGauges();
	for (size_t i = 0; i < GAUGE_SLOT_COUNT; ++i) {
		const int32_t extra = scenarioRates[i];
		if (extra == 0) continue;
		const GaugeSlot slot = static_cast<GaugeSlot>(i);
		int32_t base = 0;
		switch (slot) {
		case GaugeSlot::LIFE:
			if (drain.drains > 0) base = -dec(slot);
			else if (drain.regenAllowed && health > 0 && health < gaugeCeiling(g.life) && now - lastDamageTime >= 2000) base = inc(slot);
			break;
		case GaugeSlot::FOOD: base = inFeeder ? inc(slot) : -dec(slot); break;
		case GaugeSlot::WARMTH: base = g_game.isNight() && !inWarmth ? -dec(slot) : inc(slot); break;
		case GaugeSlot::STAMINA:
			if (isRunningThisTick()) base = -dec(slot);
			else if (!isAttacking && now - lastStaminaUse >= 2000 && stamina < gaugeCeiling(g.stamina)) base = inc(slot);
			break;
		// Server sense: the field's rate (the client's DEC) raises the value.
		case GaugeSlot::RADIATION: base = inRadiation ? dec(slot) : -inc(slot); break;
		default: break;
		}
		// The region sets the direction: ordinary drift the same way adds to it,
		// drift the other way pauses. A +90 radiation zone must contaminate even
		// though radiation normally decays at twice that, and a warm shelter must
		// warm at night rather than merely slow the cold.
		nets[i] = extra + ((base > 0) == (extra > 0) ? base : 0);
	}
	return nets;
}

// A combined rate goes out as the one field its direction reads; radiation is
// the inverted gauge, so its rise travels as the client's DEC.
void Player::foldScenarioNets(GaugeRates& rates, const ScenarioNets& nets)
{
	for (size_t i = 0; i < GAUGE_SLOT_COUNT; ++i) {
		if (!nets[i] || *nets[i] == 0) continue;
		const GaugeSlot slot = static_cast<GaugeSlot>(i);
		const int32_t net = *nets[i];
		const bool rising = (net > 0) != (slot == GaugeSlot::RADIATION);
		rates[gaugeRateIndex(slot, rising ? RateField::INC : RateField::DEC)] =
			static_cast<uint16_t>(std::min<int32_t>(std::abs(net), 65535));
	}
}

// Integrates a combined signed rate (server sense) and returns the direction
// in the client's sense for an ordinary, non-inverted gauge.
static GaugeDirection integrateSignedGauge(uint8_t& value, float& partial, int32_t net, uint32_t elapsedMs, uint8_t ceiling)
{
	if (net > 0) {
		increaseGauge(value, partial, gaugeDelta(static_cast<float>(net), elapsedMs), false, ceiling);
		return GaugeDirection::RISE;
	}
	if (net < 0) {
		decreaseGauge(value, partial, gaugeDelta(static_cast<float>(-net), elapsedMs), false);
		return GaugeDirection::FALL;
	}
	return GaugeDirection::HOLD;
}

GaugeDirection Player::updateStaminaGauge(uint32_t elapsedMs, const GaugeMode& sMode, uint64_t now)
{
	// Running burns, attacking holds, otherwise regen after 2s idle. Running
	// means actually covering ground: Shift held into a wall is standing still.
	if (isRunningThisTick()) {
		decreaseGauge(stamina, staminaPartial, gaugeDelta(sMode.speedDec, elapsedMs), false);
		lastStaminaUse = now;
		return stamina == 0 ? GaugeDirection::HOLD : GaugeDirection::FALL;
	}

	if (isAttacking) {
		lastStaminaUse = now;
		return GaugeDirection::HOLD;
	}

	if (now - lastStaminaUse >= 2000 && stamina < gaugeCeiling(sMode)) {
		increaseGauge(stamina, staminaPartial, gaugeDelta(sMode.speedInc, elapsedMs), true, gaugeCeiling(sMode));
		return GaugeDirection::RISE;
	}
	return GaugeDirection::HOLD;
}

// The feeder used to be unrepresentable: the client's food bar could only fall,
// so a feeder was expressed as "rate zero" plus a 4 Hz stream of authoritative
// GAUGES pushes to carry the climb. GAUGE_STATE can say RISE, so the client
// integrates the same speedInc the line below does and the pushes are gone --
// along with the lastFeederPush timer they needed.
GaugeDirection Player::updateHungerGauge(uint32_t elapsedMs, const GaugeMode& fMode)
{
	GaugeDirection dir;
	if (inFeeder) {
		increaseGauge(hunger, hungerPartial, gaugeDelta(fMode.speedInc, elapsedMs), false, gaugeCeiling(fMode));
		dir = fMode.speedInc > 0 ? GaugeDirection::RISE : GaugeDirection::HOLD;
	} else {
		decreaseGauge(hunger, hungerPartial, gaugeDelta(fMode.speedDec, elapsedMs), false);
		dir = fMode.speedDec > 0 ? GaugeDirection::FALL : GaugeDirection::HOLD;
	}

	checkGaugeNotification(hungerNotificationLevel, hunger, false,
		static_cast<uint8_t>(getGUID()), 1, getPosition());

	return dir;
}

GaugeDirection Player::updateColdGauge(uint32_t elapsedMs, const GaugeMode& cMode)
{
	// cMode is this player's EFFECTIVE mode: cold resistance is already folded
	// into the two speeds by computeGaugeRates, and the same integers were sent
	// to the client, so both sides integrate the identical rate.
	//
	// It used to be applied here instead, against a comment claiming the client
	// applied a matching `gauge.bonus`. It does not -- that bonus is read from a
	// sprite table with no `warm` key and is 0 for the entire session -- so every
	// point of coldResistance was a pure server/client rate divergence, and the
	// bar drifted until something forced a correction and yanked it back.
	//
	// Drains only at night away from warmth; resistance slows it, never reverses.
	//
	// The state returned is the branch taken, not whether the byte moved: the
	// client integrates the same rate from the same mode config and applies the
	// same resistance, so it is right between corrections as long as it is told
	// which way to run. Saturation is not reported as a hold either -- the
	// client clamps to _max/0 in updateGauge itself, so a bar pinned at 255 with
	// INCREASE latched costs nothing and saves an edge in each direction.
	//
	// A zero rate IS reported as a hold. Both sides then agree on "not moving",
	// and it keeps a mode with speedDec = 0 (benchmark ships one) from latching a
	// FALL the client would integrate against a rate of nothing.
	GaugeDirection dir;
	if (g_game.isNight() && !inWarmth) {
		decreaseGauge(cold, coldPartial, gaugeDelta(cMode.speedDec, elapsedMs), false);
		dir = cMode.speedDec > 0 ? GaugeDirection::FALL : GaugeDirection::HOLD;
	} else {
		increaseGauge(cold, coldPartial, gaugeDelta(cMode.speedInc, elapsedMs), false, gaugeCeiling(cMode));
		dir = cMode.speedInc > 0 ? GaugeDirection::RISE : GaugeDirection::HOLD;
	}

	checkGaugeNotification(coldNotificationLevel, cold, false,
		static_cast<uint8_t>(getGUID()), 2, getPosition());

	return dir;
}

GaugeDirection Player::updateRadiationGauge(uint32_t elapsedMs, const GaugeMode& rMode, bool inRadiationArea)
{
	// Inverted gauge: rises in a field, falls outside one, so the partial is
	// signed and cannot use increase/decreaseGauge. The DIRECTION returned is
	// the client's, not the server's, and is therefore the other way round: the
	// client's bar is cleanliness, so radiation accumulating is a bar FALLing.
	//
	// rMode carries this player's radiationResistance AND the field's strength
	// multiplier already (computeGaugeRates), for the same reason cold carries
	// resistance: the client's `rad.bonus` comes from a dead clothes lookup and
	// is always 0, so anything the server applies here only agrees with the
	// client if it rode in on the rate. Strength was the last thing in this
	// system that did not, and applying it here rather than folding it in was
	// the divergence -- so it is now folded in and NOT applied again below.
	if (inRadiationArea) {
		radiationPartial += (static_cast<float>(rMode.speedDec) / GAUGE_RATE_SCALE) * elapsedMs;
	} else if (radiation > 0) {
		radiationPartial -= (static_cast<float>(rMode.speedInc) / GAUGE_RATE_SCALE) * elapsedMs;
	}

	// Saturation zeroes the partial so a pinned player banks no progress toward
	// the opposite direction. Differs from the hunger/cold rule on purpose.
	if (radiationPartial >= 1.0f) {
		uint8_t gain = static_cast<uint8_t>(radiationPartial);
		const uint8_t radMax = gaugeCeiling(rMode);
		if (radiation + gain >= radMax) {
			radiation = radMax;
			radiationPartial = 0.0f;
		} else {
			radiation += gain;
			radiationPartial -= static_cast<float>(gain);
		}
	} else if (radiationPartial <= -1.0f) {
		uint8_t lose = static_cast<uint8_t>(-radiationPartial);
		if (lose >= radiation) {
			radiation = 0;
			radiationPartial = 0.0f;
		} else {
			radiation -= lose;
			radiationPartial += static_cast<float>(lose);
		}
	}

	// Inverted: fires as radiation rises.
	checkGaugeNotification(radiationNotificationLevel, radiation, true,
		static_cast<uint8_t>(getGUID()), 3, getPosition());

	if (inRadiationArea) {
		return rMode.speedDec > 0 ? GaugeDirection::FALL : GaugeDirection::HOLD;
	}
	// RISE even at radiation 0, where the bar is already pinned full and the
	// client's own clamp makes it a no-op. Reporting HOLD instead would be
	// marginally more truthful and would cost an extra edge in each direction
	// every time somebody's radiation finished decaying.
	return rMode.speedInc > 0 ? GaugeDirection::RISE : GaugeDirection::HOLD;
}

// Which gauges are dragging life down, and whether regen is permitted.
//
// Read from the values as they stand at the START of the tick, because the rate
// message goes out before the gauges are updated and the tick must then
// integrate on exactly what was sent. The alternative -- deriving the drain
// count again after the updates -- puts one tick of drift between the number
// the client was given and the number the server used, which is precisely the
// class of divergence this file exists to avoid.
Player::LifeDrainProfile Player::lifeDrainProfile() const
{
	LifeDrainProfile profile;

	const Game::ActiveGauges& g = g_game.getActiveGauges();

	if (health > 0) {
		if (hunger <= percentToGaugeValue(g.food.lifeDecBelowPct, gaugeCeiling(g.food))) {
			++profile.drains;
		}
		if (cold <= percentToGaugeValue(g.warmth.lifeDecBelowPct, gaugeCeiling(g.warmth))) {
			++profile.drains;
		}
		if (radiation >= percentToGaugeValue(g.radiation.lifeDecAbovePct, gaugeCeiling(g.radiation))) {
			++profile.drains;
		}
	}

	// Any one bad gauge blocks regen outright, so this is not just "drains == 0"
	// plus thresholds -- the regen bands are separate and stricter than the
	// drain bands (lifeRegenAbovePct vs lifeDecBelowPct).
	profile.regenAllowed = profile.drains == 0 &&
		hunger >= percentToGaugeValue(g.food.lifeRegenAbovePct, gaugeCeiling(g.food)) &&
		cold >= percentToGaugeValue(g.warmth.lifeRegenAbovePct, gaugeCeiling(g.warmth)) &&
		radiation <= percentToGaugeValue(g.radiation.lifeRegenBelowPct, gaugeCeiling(g.radiation));

	return profile;
}

// lMode.speedDec ALREADY carries the drain multiplier (computeGaugeRates folds
// `drains` into it), so this applies it once instead of looping over the three
// bad gauges. Same arithmetic -- gaugeDelta is linear in the rate, so
// `drains * gaugeDelta(base)` and `gaugeDelta(base * drains)` are the same
// number -- but now it is a number the client was actually told.
float Player::computeLifeChange(uint32_t elapsedMs, const GaugeMode& lMode, const LifeDrainProfile& drain,
	uint64_t now) const
{
	if (drain.drains > 0) {
		return -gaugeDelta(lMode.speedDec, elapsedMs);
	}

	// Only regen once 2 seconds have passed since the last damage taken.
	if (drain.regenAllowed && health > 0 && health < gaugeCeiling(lMode) &&
		(now - lastDamageTime >= 2000)) {
		return gaugeDelta(lMode.speedInc, elapsedMs);
	}

	return 0.0f;
}

uint8_t Player::getRadiationWireValue() const
{
	const uint8_t radMax = gaugeCeiling(g_game.getActiveGauges().radiation);
	return static_cast<uint8_t>(radMax - std::min(radiation, radMax));
}

// Re-clamps every gauge to its current ceiling. Called on every online player
// when an admin retunes a size, so a bar that was already above the new maximum
// comes down at once instead of sitting off the top until it decays there.
void Player::clampGaugesToMax()
{
	const Game::ActiveGauges& modes = g_game.getActiveGauges();
	health = std::min(health, gaugeCeiling(modes.life));
	stamina = std::min(stamina, gaugeCeiling(modes.stamina));
	hunger = std::min(hunger, gaugeCeiling(modes.food));
	cold = std::min(cold, gaugeCeiling(modes.warmth));
	radiation = std::min(radiation, gaugeCeiling(modes.radiation));
	markGaugesDirty();
}

// Ghost mode's "everything ideal" pin. Ceilings, not 255: a gauge pinned above
// its configured maximum would sit off the top of the bar the client draws.
void Player::pinGaugesToMax()
{
	const Game::ActiveGauges& modes = g_game.getActiveGauges();
	stamina = gaugeCeiling(modes.stamina);
	hunger = gaugeCeiling(modes.food);
	cold = gaugeCeiling(modes.warmth);
	health = gaugeCeiling(modes.life);
	radiation = 0;
}

void Player::updateGauges(uint32_t elapsedMs)
{
	const uint64_t now = OTSYS_TIME();

	// Every gauge held at its ceiling. Pinned means pinned: without stating this
	// the client keeps integrating whatever direction it last latched, and an
	// immune player's bars drain on screen while the server holds them still --
	// invisible to the value push, which dedupes an unchanged snapshot away.
	//
	// One call now covers all five. It used to be syncColdState(STOP) alone,
	// which left the other four latched at whatever they were when ghost mode or
	// admin was switched on.
	constexpr auto ALL_HOLD = GaugeDirection::HOLD;

	// The two immunity paths differ on purpose: ghost mode restores health
	// unconditionally and leaves the partials, admin/invincible does neither.
	if (isGhostMode()) {
		pinGaugesToMax();
		syncImmuneGauges(elapsedMs);
		flushGaugeDirections(packGaugeDirections(ALL_HOLD, ALL_HOLD, ALL_HOLD, ALL_HOLD, ALL_HOLD));
		flushGaugeSync();
		return;
	}

	// Admins and invincible players are immune to all environmental gauge changes.
	// Pin everything to ideal values and skip all gauge math so they cannot
	// freeze, starve, irradiate, or lose stamina/health through ticks.
	if (hasGroupFlag(GroupFlag::Immortal) || isInvincible()) {
		const Game::ActiveGauges& immuneModes = g_game.getActiveGauges();
		stamina = gaugeCeiling(immuneModes.stamina);
		hunger = gaugeCeiling(immuneModes.food);
		cold = gaugeCeiling(immuneModes.warmth);
		radiation = 0;
		// Only restore health if they are not already dead (health==0 should not
		// be silently overridden — that is handled by resurrect/respawn paths).
		const uint8_t immuneLifeMax = gaugeCeiling(immuneModes.life);
		if (health > 0 && health < immuneLifeMax) {
			health = immuneLifeMax;
		}
		staminaPartial = 0.0f;
		hungerPartial = 0.0f;
		coldPartial = 0.0f;
		radiationPartial = 0.0f;
		healthPartial = 0.0f;
		syncImmuneGauges(elapsedMs);
		flushGaugeDirections(packGaugeDirections(ALL_HOLD, ALL_HOLD, ALL_HOLD, ALL_HOLD, ALL_HOLD));
		flushGaugeSync();
		return;
	}

	inventory.update(elapsedMs);
	updatePlayerConditions(elapsedMs);
	updateGhoulDaylight(now);

	const GameMode* mode = g_game.getActiveMode();
	if (!mode) {
		flushGaugeSync();
		return;
	}

	// Resolved once when the mode was chosen, not looked up by name per player
	// per tick. References, not copies -- these outlive the call.
	const Game::ActiveGauges& gauges = g_game.getActiveGauges();

	const AreaEffectScan areaScan = scanAreaEffects(getPosition());

	// Plain assignment, no edge detection. These used to be three
	// syncAreaSignal() calls that each fired an opcode on a change, and their
	// ORDER was load-bearing -- the food signal wrote the client's cold latch,
	// so it had to be sent before the warmth one or it undid it. The direction
	// field carries all of that now, and a cached flag is just a cached flag.
	inFeeder = areaScan.food;
	inRadiation = areaScan.radiation;
	inWarmth = areaScan.warmth;
	radiationStrength = areaScan.maxRadiationStrength;

	// Scenario regions, in GaugeSlot order. A ghoul does not eat, freeze or
	// irradiate here either (see computeGaugeRates).
	{
		const scenario::StatRates regional = scenario::g_scenarioRuntime.gaugeRates(getPosition());
		using Stat = scenario::EffectStat;
		const auto at = [&regional](Stat s) { return regional[static_cast<size_t>(s)]; };
		scenarioRates[static_cast<size_t>(GaugeSlot::LIFE)] = at(Stat::Health);
		scenarioRates[static_cast<size_t>(GaugeSlot::STAMINA)] = at(Stat::Stamina);
		scenarioRates[static_cast<size_t>(GaugeSlot::FOOD)] = ghoulData ? 0 : at(Stat::Food);
		scenarioRates[static_cast<size_t>(GaugeSlot::WARMTH)] = ghoulData ? 0 : at(Stat::Warmth);
		scenarioRates[static_cast<size_t>(GaugeSlot::RADIATION)] = ghoulData ? 0 : at(Stat::Radiation);
	}

	// Resolved before the rates, because the life drain multiplier rides in on
	// them, and from the values as they stand NOW -- see lifeDrainProfile.
	const LifeDrainProfile drain = lifeDrainProfile();

	// After the area flags, because the feeder and the field strength change
	// this player's rates, and before the gauge math, because the math has to
	// run on exactly the numbers the client was given.
	GaugeRates rates = computeGaugeRates(drain);
	const ScenarioNets nets = scenarioNets(rates, drain, now);
	foldScenarioNets(rates, nets);
	syncGaugeRates(rates);

	// Copies, not references: every gauge can carry per-player rates now.
	// Copying the whole GaugeMode keeps the lifeDec*/lifeRegen* thresholds that
	// lifeDrainProfile reads off the same struct.
	//
	// All FIVE are rebuilt from `rates`, including stamina and life. Those two
	// used to be taken straight from the mode, which was identical for a human
	// and so read as equivalent -- it is not for a ghoul, whose stamina rates
	// and life regen computeGaugeRates rewrites. Driving every gauge from the
	// numbers that were just sent is the invariant this function is built on:
	// the client integrates exactly these, so the server must too.
	const auto effectiveMode = [&rates](const GaugeMode& base, GaugeSlot slot) {
		GaugeMode mode = base;
		mode.speedInc = rates[gaugeRateIndex(slot, RateField::INC)];
		mode.speedDec = rates[gaugeRateIndex(slot, RateField::DEC)];
		return mode;
	};

	const GaugeMode lMode = effectiveMode(gauges.life, GaugeSlot::LIFE);
	const GaugeMode fMode = effectiveMode(gauges.food, GaugeSlot::FOOD);
	const GaugeMode cMode = effectiveMode(gauges.warmth, GaugeSlot::WARMTH);
	const GaugeMode sMode = effectiveMode(gauges.stamina, GaugeSlot::STAMINA);
	const GaugeMode rMode = effectiveMode(gauges.radiation, GaugeSlot::RADIATION);

	// Each of these integrates its own gauge and reports which way it went, so
	// the direction the client is told is the branch the server actually took
	// rather than a second derivation of it.
	//
	// A gauge a scenario region touches runs its combined rate instead (see
	// scenarioNets); the rest run exactly the ordinary branch.
	const auto net = [&nets](GaugeSlot slot) { return nets[static_cast<size_t>(slot)]; };

	GaugeDirection staminaDir;
	if (const auto n = net(GaugeSlot::STAMINA)) {
		if (isRunningThisTick() || isAttacking) lastStaminaUse = now;
		staminaDir = integrateSignedGauge(stamina, staminaPartial, *n, elapsedMs, gaugeCeiling(sMode));
	} else {
		staminaDir = updateStaminaGauge(elapsedMs, sMode, now);
	}

	GaugeDirection foodDir;
	if (const auto n = net(GaugeSlot::FOOD)) {
		foodDir = integrateSignedGauge(hunger, hungerPartial, *n, elapsedMs, gaugeCeiling(fMode));
		checkGaugeNotification(hungerNotificationLevel, hunger, false, static_cast<uint8_t>(getGUID()), 1, getPosition());
	} else {
		foodDir = updateHungerGauge(elapsedMs, fMode);
	}

	GaugeDirection warmthDir;
	if (const auto n = net(GaugeSlot::WARMTH)) {
		warmthDir = integrateSignedGauge(cold, coldPartial, *n, elapsedMs, gaugeCeiling(cMode));
		checkGaugeNotification(coldNotificationLevel, cold, false, static_cast<uint8_t>(getGUID()), 2, getPosition());
	} else {
		warmthDir = updateColdGauge(elapsedMs, cMode);
	}

	GaugeDirection radiationDir;
	if (const auto n = net(GaugeSlot::RADIATION)) {
		// Inverted on the client: accumulating radiation is its bar falling.
		const GaugeDirection serverDir = integrateSignedGauge(radiation, radiationPartial, *n, elapsedMs, gaugeCeiling(rMode));
		radiationDir = serverDir == GaugeDirection::RISE ? GaugeDirection::FALL
		             : serverDir == GaugeDirection::FALL ? GaugeDirection::RISE : GaugeDirection::HOLD;
		checkGaugeNotification(radiationNotificationLevel, radiation, true, static_cast<uint8_t>(getGUID()), 3, getPosition());
	} else {
		radiationDir = updateRadiationGauge(elapsedMs, rMode, areaScan.radiation);
	}

	const auto lifeNet = net(GaugeSlot::LIFE);
	const float lifeChange = lifeNet ? gaugeDelta(static_cast<float>(*lifeNet), elapsedMs)
	                                 : computeLifeChange(elapsedMs, lMode, drain, now);
	applyHealthPartial(lifeChange);

	const GaugeDirection lifeDir = lifeChange < 0.0f ? GaugeDirection::FALL
	                             : lifeChange > 0.0f ? GaugeDirection::RISE
	                                                 : GaugeDirection::HOLD;

	// One message, all five directions, and nothing after it can reorder them
	// against each other. This replaces syncLifeEffect + syncStaminaState +
	// syncColdState and the three area signals above.
	flushGaugeDirections(packGaugeDirections(lifeDir, foodDir, warmthDir, staminaDir, radiationDir));

	// Last: everything above may have moved a value or set the dirty flag, and
	// this is the only frame any of it costs.
	flushGaugeSync();
}

void Player::applyHealthPartial(float lifeChange)
{
	if (lifeChange == 0.0f) {
		return;
	}

	healthPartial += lifeChange;

	if (healthPartial <= -1.0f) {
		uint8_t lose = static_cast<uint8_t>(-healthPartial);
		if (lose > health) {
			changeHealth(-static_cast<int16_t>(health), true, false, true);
			healthPartial = 0.0f;
		} else {
			changeHealth(-static_cast<int16_t>(lose), true, false, true);
			healthPartial += static_cast<float>(lose);
		}
	} else if (healthPartial >= 1.0f) {
		uint8_t gain = static_cast<uint8_t>(healthPartial);
		const uint8_t lifeMax = gaugeCeiling(g_game.getActiveGauges().life);
		if (health + gain > lifeMax) {
			changeHealth(static_cast<int16_t>(lifeMax - health), true, false, true);
			healthPartial = 0.0f;
		} else {
			changeHealth(static_cast<int16_t>(gain), true, false, true);
			healthPartial -= static_cast<float>(gain);
		}
	}
}

// Total XP needed to BE level l, counted from level 0 = 0. This must mirror
// client.js exactly: the client's getXpFromLevel(L) = floor-chain of
// __XP_START__=900 * __XP_SPEED__=1.105 is the PER-LEVEL requirement to
// advance from L to L+1 (updatePlayerXP subtracts it and multiplies by 1.105
// each fill), so the server's cumulative threshold is the SUM of that chain.
// Treating the chain value itself as the total (the old code) made every
// level after the first cost only the ~10.5% increment — reaching level 3
// took ~104 XP after level 2's 994 — while the client bar showed total XP
// against its per-level requirement (~90% full right after each level-up).
//
// The origin is level 0, not level 1: the client starts a session at level 0
// owing getXpFromLevel(0) = 900, so summing from level 1 skipped that first
// rung and made level 1 free. Any startingLevel above 0 seeds `experience` to
// its threshold (see the constructor), which leaves the XP still owed for the
// next level unchanged — so this rebase is invisible unless a player actually
// starts below level 1.
uint32_t Player::getRequiredXP(uint32_t l) const
{
	if (l == 0) return 0;

	uint64_t total = 0;
	double perLevel = 900.0; // client getXpFromLevel(0): the 0 -> 1 cost
	for (uint32_t i = 0; i < l; i++) {
		total += static_cast<uint64_t>(perLevel);
		// Saturate: keeps the level-up loop terminating at max experience.
		if (total >= std::numeric_limits<uint32_t>::max()) {
			return std::numeric_limits<uint32_t>::max();
		}
		perLevel = std::floor(perLevel * 1.105); // client getXpFromLevel(i+1)
	}
	return static_cast<uint32_t>(total);
}

void Player::addXP(uint32_t amount, bool rankedEligible)
{
    const uint32_t before = experience;
	float multiplier = 1.0f;
	if (const GameMode* mode = g_game.getActiveMode()) {
		multiplier = mode->rateExperience;
	}
	multiplier *= getKarmaXPMultiplier();

	uint32_t finalAmount = static_cast<uint32_t>(std::round(static_cast<float>(amount) * multiplier));
	// Saturate instead of wrapping: near the uint32 cap (reachable via admin XP
	// grants) a plain add would wrap experience/score back to ~0.
	if (finalAmount > std::numeric_limits<uint32_t>::max() - experience) {
		experience = std::numeric_limits<uint32_t>::max();
	} else {
		experience += finalAmount;
	}
	score = experience;
    g_accountRuns.earned(this, experience - before, rankedEligible);
	

	if (client) {
		client->sendPlayerXp(static_cast<uint16_t>(finalAmount & 0xFFFF));
		client->sendScore(score);
	}

	bool leveledUp = false;
	// Hard level cap guarantees termination even if experience sits at the
	// uint32 max where required XP also saturates to max.
	while (level < PLAYER_MAX_LEVEL && experience >= getRequiredXP(level + 1)) {
		level++;
		leveledUp = true;
	}

	if (leveledUp && client) {
		client->sendPlayerXpSkill(); // Full sync
	}
}

// Directly fast-forwards a brand new character to startLevel (starting
// kits). Unlike addXP this is not "earned" XP: no rate/karma multiplier, no
// incremental client sync — the caller runs this before sendLoginSetup(),
// which sends the resulting level/XP/score to the client as part of the
// normal login packets.
void Player::grantStartingLevel(uint32_t startLevel)
{
	if (startLevel <= level) {
		return;
	}

	experience = getRequiredXP(startLevel);
	score = experience;

	while (level < PLAYER_MAX_LEVEL && experience >= getRequiredXP(level + 1)) {
		level++;
	}
}

void Player::handleMouseDown()
{
	// Clicking counts as activity: a player can fight, craft or build for a
	// long stretch without ever sending a move or a turn.
	resetIdleTime();
	if (modChange.eventId != 0) return; // the hands are busy with the gun

	// A press cancels a running reload, the same way a press during an eat
	// cancels that. A loaded weapon still fires on that same press, which is
	// what keeps a per-shell refill usable; an empty one has no shot to take,
	// so the press is spent on the cancel and the held trigger is dropped with
	// it -- otherwise updateActions restarts the reload on the next tick.
	if (reloadEventId != 0) {
		const bool wasEmpty = isEquippedWeaponEmpty();
		cancelReload();
		if (wasEmpty) {
			isClicking = false;
			return;
		}
	}

	// Clicking during a pending equip cancels it, mirroring consumable cancel.
	if (equipEventId != 0) {
		cancelEquipping();
		return;
	}

	uint16_t iid = equippedWeaponIID;
	const EquipableData* edata = getEquippedWeaponData();

	if (!edata) return;

	// Eating, drinking and setting off a charge are USES, not attacks, and a
	// condition can forbid them separately -- nausea should stop you eating
	// without stopping you fighting. The weapon branch below is not gated here:
	// updateActions owns the swing, and gating it there covers a held trigger as
	// well as this press.
	const bool isUse = !edata->remoteTriggerChannel.empty() || edata->typeId == 5;
	if (isUse && cannot(CONTROL_NO_USE)) {
		return;
	}

	if (!edata->remoteTriggerChannel.empty()) { // Detonator
		// Checked before typeId: a trigger shares the client's consumable slot
		// (type 5, but consumable: 0) and must NOT be eaten -- one detonator
		// serves every charge its owner ever plants.
		if (actionEventId != 0) {
			cancelAction();
		} else {
			beginRemoteTrigger(*edata);
		}
	} else if (edata->typeId == 5) { // Consumable
		if (actionEventId != 0) {
			cancelAction();
		} else {
			beginConsumableAction(iid, equippedWeaponUID, *edata);
		}
	} else if (edata->typeId == 3) { // Throwable (spear, grenade)
		// typeId, not "has a wind-up". A throwable is a weapon that is SPENT to
		// use it -- completeThrow takes it out of the inventory, and
		// spawnProjectiles puts it back on the ground via typeId 3 as well. A
		// wind-up is just a timing, and a bow has one without being consumed;
		// keying this off impactMs deleted the bow from the inventory on every
		// shot. Both halves of "throwable" now read the same field.
		if (actionEventId != 0) {
			cancelAction();
		} else {
			beginThrowAction(iid, *edata);
		}
	} else {
		isClicking = true;
		updateActions(); // Trigger first attack
	}
}

void Player::handleMouseUp()
{
	isClicking = false;
}

void Player::cancelAction()
{
	cancelInteractionEvent(actionEventId);
}

void Player::cancelReload()
{
	cancelInteractionEvent(reloadEventId);
}

void Player::updateActions()
{
	bool couldAttack = false;

	// A stun stops the swing. Gated in the REPEAT loop rather than at the click,
	// because the client sends MOUSE_DOWN once per press and the server owns the
	// held-button repeat -- so refusing only the initial click would let a
	// trigger held from before the stun keep firing right through it, and
	// refusing only the click would also mean a stun that ends while the button
	// is still down never resumes.
	if (isClicking && equipEventId == 0 && modChange.eventId == 0 && !cannot(CONTROL_NO_ATTACK)) {
		const EquipableData* edata = getEquippedWeaponData();

		if (edata && edata->typeId != 5 && edata->typeId != 3) { // Weapons only (non-throwable)
			uint32_t delay = edata->attackDelayMs;
			if (delay == 0) delay = edata->shotDelayMs;

			// Ran dry with the trigger still held: the reload performAction
			// started runs to completion instead of being cancelled by the next
			// shot, and fire resumes on its own the tick after rounds land. Only
			// an EMPTY weapon waits -- a reload with rounds still in the magazine
			// (a shotgun mid-refill, or a manual one) is interrupted by the shot
			// as before, which is what makes per-shell weapons usable.
			const bool waitingOnReload = (reloadEventId != 0 && isEquippedWeaponEmpty());

			if (!waitingOnReload && stamina >= edata->staminaUsage) {
				couldAttack = true;

				uint64_t now = OTSYS_TIME();
				if (now - lastActionTime >= delay) {
					lastActionTime = now;
					performAction();
				}
			}
		}
	}

	isAttacking = couldAttack;

	// isConsuming should only be true for actual consumables (typeId 5)
	// to avoid blocking weapon animations (Bit 1) with Bit 2.
	bool consuming = false;
	if (actionEventId != 0) {
		const EquipableData* edata = getEquippedWeaponData();
		if (edata && edata->typeId == 5) {
			consuming = true;
		}
	}
	isConsuming = consuming;
}

// Turns this character into an agents.xml creature: the client renders it as
// that creature's sprite, and the server gives it that creature's body.
//
// The melee is SYNTHESISED into an EquipableData rather than handled by a
// parallel ghoul-attack path. Everything a swing has to get right -- the arc
// trace, the knockback, the stamina spend, hitting a resource vs a building vs
// an agent vs a player, the harvest yield and its XP -- already exists once, in
// the player pipeline, and a second implementation of it would be a second set
// of bugs. So a ghoul's claw is simply a weapon that happens to be described in
// a different file.
void Player::becomeGhoul(const AgentData* data)
{
	if (!data) return;

	ghoulData = data;
	// sprite + 1: client.js reads this byte as `ghoul` and draws AI[ghoul - 1],
	// reserving 0 for "this is a person". See the ghoul-mode branch in Render.
	setGhoul(static_cast<uint8_t>(data->sprite + 1));

	// A ghoul is nobody. Whoever was driving it does not get their name over a
	// monster's head, which is both the point of the mode and what stops the
	// horde being scoreboard-readable at a glance.
	//
	// Cleared HERE rather than at login so it cannot be missed by any other path
	// that makes a ghoul, and before Game::addPlayer files the name in
	// mappedPlayerNames -- several ghouls therefore share the empty key, which
	// that map already tolerates (removePlayer only erases an entry still
	// pointing at the departing player).
	name.clear();

	// The life bar is ONE BYTE, so a creature's real health cannot live in it --
	// an armoured ghoul has 800. Instead the bar stays a percentage and incoming
	// damage is converted into it, which is the same thing arithmetically and
	// keeps the bar full at spawn. See getDamageToGaugeScale.
	const uint16_t pool = data->health > 0 ? data->health : 255;
	ghoulDamageScale = 255.0f / static_cast<float>(pool);

	ghoulMelee.reset();
	for (const AgentAbility& ability : data->abilities) {
		if (ability.type != AgentAbilityType::Melee) continue;

		auto melee = std::make_unique<EquipableData>();
		melee->key = data->key;
		melee->typeId = 0;         // melee weapon: not throwable, not consumable
		melee->weaponId = 0;       // bare hands, which is what the AI sprite draws
		melee->attackDelayMs = ability.cooldownMs;
		// A ghoul's swing keeps its wind-up. The AI sprite animates the same
		// number of milliseconds, so firing on the click instead would land the
		// damage before the claw visibly moved.
		melee->impactMs = ability.impactMs;
		melee->damageMin = ability.damage.amount;
		melee->damageMax = ability.damage.highest();
		melee->damage = ability.damage.highest();
		melee->damageType = "melee";
		melee->knockback = ability.knockback;
		melee->staminaUsage = ability.staminaUsage;
		melee->meleeRange = ability.range;
		melee->meleeRadius = ability.radius;
		ghoulMelee = std::move(melee);
		break;
	}

	// Nothing to swing with is survivable (they can still run, and their body
	// still blocks), but it is always a content mistake.
	if (!ghoulMelee) {
		fmt::print(fg(fmt::color::yellow),
			">> [Warning] ghoul '{}' has no <ability type=\"melee\">; players in this body cannot attack.\n",
			data->key);
	}
}

// The sun, for a ghoul that is being driven by a person.
//
// For a world ghoul this is what balances the night speed boost: the population
// burns off at dawn without a spawner having to cull it (see updateAgents).
// That reasoning does not carry over to a player -- there is no population to
// thin, only a round that would end on the clock instead of on the fight -- so
// GhoulRules::daylightDamage is off in the shipped mode and this does nothing.
// It exists because the ghoul's body is supposed to BE the creature, and leaving
// one of its rules permanently unimplemented would make that claim false the
// moment someone turned the switch on.
void Player::updateGhoulDaylight(uint64_t now)
{
	if (!ghoulData || !ghoulData->daylightEnabled) return;
	if (!g_game.getGhoulRules().daylightDamage) return;
	if (g_game.isNight()) {
		// Re-arm, so walking into dawn costs the full interval rather than
		// landing a burn on the first daylight tick.
		ghoulNextDaylightAt = 0;
		return;
	}

	if (ghoulNextDaylightAt == 0) {
		ghoulNextDaylightAt = now + std::max<uint32_t>(100, ghoulData->daylightIntervalMs);
		return;
	}
	if (now < ghoulNextDaylightAt) return;

	ghoulNextDaylightAt = now + std::max<uint32_t>(100, ghoulData->daylightIntervalMs);
	// isTick: the sun is an environment source, so it is quoted in bar units
	// like hunger and cold rather than in weapon units, and it obeys the
	// showEnvironmentDamageToOthers gate on the hit flash.
	changeHealth(-static_cast<int32_t>(ghoulData->daylightDamage), true, false, true);
}

// What a ghoul leaves behind, from its agents.xml <onDeath>. The world-spawned
// version of this is Agent::die; the two must not drift, because a player
// hunting ghouls for animal fat should not care which kind they killed.
//
// Called from changeHealth while the character is still in the world, so the
// position is the one it died at.
void Player::dropGhoulRemains()
{
	if (!ghoulData) return;

	const Position pos = getPosition();

	std::vector<Game::LootDrop> drops;
	for (const ItemDrop& drop : ghoulData->drops) {
		if (drop.iid == 0 || !drop.rollChance()) continue;
		ItemState dropState = ItemState::fresh(drop.iid);
		dropState.ammo = 0; // these drops have always spawned with ammo 0
		drops.push_back({ drop.lootId, drop.iid, drop.rollAmount(), dropState });
	}
	g_game.dropLootBurst(pos, drops);

	// The explosive ghoul's whole point: killing one in a crowd is a mistake.
	// Attacker id 0 -- the blast belongs to the corpse, not to whoever popped
	// it, so it cannot be farmed as a weapon against a third party.
	if (ghoulData->explosion.enabled) {
		g_game.executeExplosion(pos, ghoulData->explosion.radius, ghoulData->explosion.area,
			ghoulData->explosion.playerDamage, ghoulData->explosion.buildingDamage,
			ghoulData->explosion.knockback, 0, &ghoulData->explosion.onHit);
	}
}

const EquipableData* Player::getEquippedWeaponData() const
{
	// A ghoul has no inventory and cannot equip, so its claw is the only answer
	// here -- including for the paths that ask what is in hand for reasons other
	// than attacking (the resource tool multiplier, the held-item sprite).
	if (ghoulMelee) {
		return ghoulMelee.get();
	}

	if (equippedWeaponIID == 0) {
		return EquipmentManager::getInstance().getEquipable("hand");
	}

	const ItemData* idata = getItemData(equippedWeaponIID);
	const EquipableData* base = idata ? EquipmentManager::getInstance().getEquipable(idata->key) : nullptr;
	if (!base || base->modSlots.empty()) return base;

	// A moddable gun: every path that asks what is in hand -- fire, spread,
	// reload, capacity -- gets the numbers its fitted mods make.
	const Item* item = getInventoryItemByUid(equippedWeaponIID, equippedWeaponUID);
	const WeaponMods mods = item ? item->getMods() : WeaponMods{};
	const uint32_t generation = EquipmentManager::getInstance().getGeneration();
	if (!resolvedWeapon || resolvedWeaponBase != base || resolvedWeaponGeneration != generation ||
	    resolvedWeaponMods != mods) {
		if (resolvedWeapon) *resolvedWeapon = weapon_mods::resolveWeapon(*base, mods);
		else resolvedWeapon = std::make_unique<EquipableData>(weapon_mods::resolveWeapon(*base, mods));
		resolvedWeaponBase = base;
		resolvedWeaponGeneration = generation;
		resolvedWeaponMods = mods;
	}
	return resolvedWeapon.get();
}

const ItemData* Player::getItemData(uint16_t iid) const
{
	return ItemManager::getInstance().getItemData(iid);
}

const WearableData* Player::getEquippedWearableData() const
{
	if (equippedWearableIID == 0) {
		return nullptr;
	}

	const ItemData* idata = getItemData(equippedWearableIID);
	return idata ? EquipmentManager::getInstance().getWearable(idata->key) : nullptr;
}

uint8_t Player::getCraftBonusForSkill(uint16_t skillIid, uint16_t craftedIid) const
{
	const ItemData* skillData = getItemData(skillIid);
	if (!skillData) {
		return 1;
	}

	auto it = skillData->craftBonuses.find(craftedIid);
	return it != skillData->craftBonuses.end() ? it->second : 1;
}

bool Player::cancelInteractionEvent(uint32_t& eventId)
{
	if (eventId == 0) {
		return false;
	}

	g_scheduler.stopEvent(eventId);
	eventId = 0;
	sendInterruptInteraction();
	return true;
}

void Player::beginConsumableAction(uint16_t iid, uint32_t itemUid, const EquipableData& edata)
{
	if (edata.consumeDelayMs > 0) {
		sendStartInteraction(static_cast<uint16_t>(edata.consumeDelayMs / 100));
		// Re-resolve by id at fire time: the scheduled task can outlive this
		// player (disconnect/death), and player ids are reused across slots.
		const uint32_t pid = getID();
		actionEventId = g_scheduler.addEvent(createSchedulerTask(edata.consumeDelayMs, [pid, iid, itemUid]() {
			if (Player* p = g_game.getPlayerByID(pid)) p->consumeItem(iid, itemUid);
		}));
		return;
	}

	consumeItem(iid, itemUid);
}

void Player::beginThrowAction(uint16_t iid, const EquipableData& edata)
{
	attackPulse = true; // Start animation
	const uint32_t pid = getID();
	actionEventId = g_scheduler.addEvent(createSchedulerTask(edata.impactMs, [pid, iid]() {
		if (Player* p = g_game.getPlayerByID(pid)) p->completeThrow(iid, p->getEquippedWeaponUID());
	}));
}

void Player::beginRemoteTrigger(const EquipableData& edata)
{
	attackPulse = true; // the press itself is the animation

	if (edata.impactMs == 0) {
		fireRemoteTrigger(edata.remoteTriggerChannel);
		return;
	}

	// Re-resolve by id at fire time: the task can outlive this player, and the
	// charges must still go off if the plunger was already pressed.
	const uint32_t pid = getID();
	const std::string channel = edata.remoteTriggerChannel;
	actionEventId = g_scheduler.addEvent(createSchedulerTask(edata.impactMs, [pid, channel]() {
		if (Player* p = g_game.getPlayerByID(pid)) p->fireRemoteTrigger(channel);
	}));
}

void Player::fireRemoteTrigger(const std::string& channel)
{
	actionEventId = 0;
	g_game.fireRemoteTrigger(this, channel);
}

bool Player::consumeStaminaForAction(uint8_t amount, bool syncWhenZero)
{
	if (amount == 0) {
		if (syncWhenZero) {
			lastStaminaUse = OTSYS_TIME();
			markGaugesDirty();
		}
		return true;
	}

	if (stamina < amount) {
		return false;
	}

	stamina -= amount;
	lastStaminaUse = OTSYS_TIME();
	markGaugesDirty();
	return true;
}

int8_t Player::findInventorySlotByItemKey(const std::string& itemKey, uint8_t minCount) const
{
	const ItemData* itemData = ItemManager::getInstance().getItemData(itemKey);
	if (!itemData) {
		return -1;
	}

	for (uint8_t i = 0; i < inventory.getSlotCount(); ++i) {
		Item* item = inventory.getItem(i);
		if (item && item->getIID() == itemData->id && item->getCount() >= minCount) {
			return static_cast<int8_t>(i);
		}
	}

	return -1;
}

Item* Player::getInventoryItemByUid(uint16_t iid, uint32_t itemUid) const
{
	int8_t slot = inventory.findItemByUidSlot(itemUid, iid);
	return slot != -1 ? inventory.getItem(slot) : nullptr;
}

// The old ammo used to be a parameter, because the retired REPLACE_AMMO carried
// it as a match key. INVENTORY_SLOT states the new value and nothing else.
void Player::syncEquippedAmmo(uint16_t iid, Item& item)
{
	sendInventorySlot(iid, item.getCount(), equippedWeaponUID, item.getAmmo());
	item.setLastSyncedAmmo(item.getAmmo());
}

bool Player::tryRepairObject(Object* targetObj, const EquipableData* edata, uint8_t impactAngle)
{
	if (!targetObj || !edata || !edata->repair.enabled || edata->repair.delivery == "projectile") {
		return false;
	}

	const ObjectData* objectData = targetObj->getData();
	if (!objectData || targetObj->getHealth() >= targetObj->getMaxHealth()) {
		return false;
	}

	int8_t consumeSlot = -1;
	if (!edata->repair.consumeKey.empty() && edata->repair.consumeAmountPerTarget > 0) {
		consumeSlot = findInventorySlotByItemKey(edata->repair.consumeKey, edata->repair.consumeAmountPerTarget);
		if (consumeSlot == -1) {
			return false;
		}
	}

	if (consumeSlot != -1) {
		inventory.removeItem(consumeSlot, edata->repair.consumeAmountPerTarget);
	}

	targetObj->changeHealth(edata->repair.amount, impactAngle, this);
	return true;
}

int16_t Player::applyConsumableEffect(const ConsumableEffect& effect)
{
	if (effect.type == "food") {
		hunger = applyGaugeDelta(hunger, effect.amount, gaugeCeiling(g_game.getActiveGauges().food));
		return 0;
	}

	if (effect.type == "energy") {
		stamina = applyGaugeDelta(stamina, effect.amount, gaugeCeiling(g_game.getActiveGauges().stamina));
		return effect.amount;
	}

	if (effect.type == "heal") {
		changeHealth(effect.amount, true, true);
		return 0;
	}

	if (effect.type == "radiation") {
		radiation = applyGaugeDelta(radiation, effect.amount, gaugeCeiling(g_game.getActiveGauges().radiation));
		radiationPartial = 0.0f;
	}

	return 0;
}

// Damage one swing does, rolled once. Weapons in equipables.xml quote a single
// number and get it back unchanged; a ghoul's claw quotes a range (agents.xml
// <damage min= max=>) and gets a roll, because the variance is part of what
// makes one ghoul type feel different from another.
//
// Rolled once per SWING and then shared by every target the arc catches, not
// re-rolled per target: one claw sweep that reaches a player and the wall behind
// them is one blow, and it would read as a bug if it took 8 off one and 20 off
// the other.
static uint16_t rollMeleeDamage(const EquipableData& edata)
{
	if (edata.hasDamageRoll()) {
		return static_cast<uint16_t>(edata.damageMin +
			(rand() % (edata.damageMax - edata.damageMin + 1)));
	}
	return edata.damage;
}

int32_t Player::getMeleeObjectDamage(const Object& targetObj, const EquipableData& edata, uint16_t swingDamage) const
{
	// A weapon with its own <damage building=> uses it; a claw has only the one
	// number, so the swing itself is what hits the wall.
	float damage = edata.hasDamageRoll()
		? static_cast<float>(swingDamage)
		: static_cast<float>(edata.buildingDamage);
	for (const auto& mod : edata.damageModifiers) {
		if (mod.target == "building") {
			if (mod.ownership == "own" && targetObj.getOwnerPid() == getGUID()) {
				damage *= mod.multiplier;
			} else if (mod.ownership == "enemy" && targetObj.getOwnerPid() != getGUID()) {
				damage *= mod.multiplier;
			}
		}
	}
	// Saturating: <buildingDamage> is already clamped to MAX_DAMAGE_AMOUNT, but
	// a <damageModifiers> multiplier can lift it back over the ceiling.
	return damageDelta(damage);
}

void Player::applyMeleeHit(Thing* target, const EquipableData& edata, const Position& startPos, float hitX, float hitY, float directionX, float directionY, uint16_t swingDamage)
{
	float angleHit = std::atan2(hitY - startPos.y, hitX - startPos.x);
	if (angleHit < 0) angleHit += MATH_TWO_PI;
	uint8_t impactAngle31 = static_cast<uint8_t>((angleHit * 31.0f) / MATH_TWO_PI);

	Object* targetObj = target->getObject();
	bool repaired = tryRepairObject(targetObj, &edata, impactAngle31);
	if (repaired) {
		return;
	}

	int32_t damage = -static_cast<int32_t>(swingDamage);

	// The swing's crit and any damage-dealt modifier, applied to the OUTGOING
	// number so armour still counts against a crit. Rolled once here and used
	// for whatever the swing turns out to hit.
	bool crit = false;
	damage = g_game.rollOutgoingDamage(this, damage, edata.hitEffects, crit);

	Creature* targetCr = target->getCreature();
	if (Player* targetPlayer = targetCr ? targetCr->getPlayer() : nullptr) {
		if (targetPlayer->isGhostMode()) {
			damage = 0;
		} else if (targetPlayer->isInvincible() && !hasGroupFlag(GroupFlag::BypassInvincible)) {
			damage = 0;
		}
		int32_t dealt = 0;
		if (damage < 0) {
			// The weapon's own damageType, exactly as the projectile path and
			// the player-vs-AGENT branch below already pass it. This was a bare
			// "" for as long as melee has existed, which meant armour's melee and
			// piercing resistance protected you from arrows but not from an axe:
			// the resistance lookup in changeHealth is skipped outright on an
			// empty type. A weapon that declares no damageType still passes ""
			// and is still unresisted, so this changes nothing for those.
			dealt = targetPlayer->changeHealth(damage, true, false, false, edata.damageType, this);
		}

		// Melee could not inflict a condition AT ALL before this -- only
		// projectiles and agent bites could -- so a poisoned blade was
		// unwritable. Same resolver as both of those now.
		g_game.applyHitEffects(this, targetPlayer, dealt, edata.hitEffects, crit);

		uint8_t angleByte = static_cast<uint8_t>((angleHit * 255.0f) / MATH_TWO_PI);
		g_game.broadcastPlayerHit(static_cast<uint8_t>(targetPlayer->getGUID()), angleByte, targetPlayer->getPosition(), targetPlayer);

		if (edata.knockback > 0) {
			targetPlayer->applyKnockback(directionX * static_cast<float>(edata.knockback) * 1.5f, directionY * static_cast<float>(edata.knockback) * 1.5f);
		}
	} else if (targetObj) {
		// Harvestable growth stages drop their produce; the hit still damages the plant
		g_game.tryHarvestObject(targetObj);
		targetObj->changeHealth(getMeleeObjectDamage(*targetObj, edata, swingDamage), impactAngle31, this);
	} else if (Resource* targetRes = target->getResource()) {
		targetRes->changeHealth(damage, impactAngle31, this);
	} else if (Agent* targetAgent = target->getAgent()) {
		// Knockback before the hit: a lethal changeHealth deletes the agent.
		if (edata.knockback > 0) {
			targetAgent->applyKnockback(directionX * static_cast<float>(edata.knockback) * 1.5f,
			                            directionY * static_cast<float>(edata.knockback) * 1.5f);
		}
		// The weapon's own damageType picks the agent resistance, so an axe
		// (melee) and a thrown spear (piercing) are reduced by different stats.
		//
		// A LETHAL hit deletes the agent inside changeHealth, so the pointer may
		// be dangling the moment it returns -- `targetAgent->isDying()` would
		// itself be a read of freed memory. The id is captured first and the
		// agent re-resolved through the map afterwards, which is the same
		// resolve-by-id rule Game::scheduleExplosionDamage follows and for the
		// same reason: not found means it is gone.
		const uint32_t agentId = targetAgent->getID();
		const int32_t dealt = targetAgent->changeHealth(damage, impactAngle31, this, false,
		                          agentDamageKindFromString(edata.damageType));

		// Leech off a killing blow still pays -- what landed is what it was
		// worth -- so this runs whether or not the agent survived. A dead one
		// simply takes no condition.
		Thing* survivor = g_game.getThingByID(agentId);
		g_game.applyHitEffects(this, survivor ? survivor->getCreature() : nullptr,
		                       dealt, edata.hitEffects, crit);
	}
}

void Player::spawnProjectiles(const EquipableData* edata, Item* equippedItem)
{
	if (!edata || edata->projectileKey.empty()) return;

	uint16_t projExtraId = ProjectileManager::getInstance().getProjectileId(edata->projectileKey);

	// The projectile's own travel speed; the weapon scales it below. Defaults to
	// 1.0 for a weapon whose projectile key does not resolve, which is the speed
	// every shot had before <physics baseSpeed> was implemented.
	float projBaseSpeed = 1.0f;
	if (const ProjectileData* pdata = ProjectileManager::getInstance().getProjectileData(projExtraId)) {
		projBaseSpeed = pdata->baseSpeed;
	}

	float baseAngle = (getRotation() * MATH_TWO_PI) / 255.0f;

	// Every entity we send with pid == 0 needs a globally unique id16 -- bullets
	// used to be issued across 4096-61440, overlapping resources, objects and
	// loot, which aliased them in the client's entity cache (see definitions.h).
	//
	// Projectiles are the one class holding a RESERVE in the shared id pool:
	// this failing is the only exhaustion with no visible explanation (the shot
	// simply does not happen), so it must not be reachable by another class
	// filling the space.
	static bool warnedProjectilePoolFull = false;
	static std::vector<Player*> spectators;
	spectators.clear();
	// Bounded by the projectile range, not the viewport: a bullet further away
	// than this cannot be drawn by the client at all. MUST match the range
	// Game::removeProjectile retracts with -- see there.
	const int32_t projRange = g_game.projectileViewRange();
	if (edata->pellets > 0) {
		g_game.map.getPotentialSpectatorPlayers(getPosition(), spectators, projRange);
	}

	// Aiming eases the spread from the hip value to the aimed one over aimMs.
	const float spreadNow = aim_view::spreadAt(edata->spreadRadians, edata->aim, aimActive,
		static_cast<uint64_t>(OTSYS_TIME()) - aimSince);

	for (uint8_t i = 0; i < edata->pellets; i++) {
		const uint32_t projectileId = g_game.map.acquireEntityId(EntityClass::Projectile);
		if (projectileId == 0) {
			// Transient entities, so this means an implausible number are in
			// flight at once. Dropping the pellet is the only safe option: a
			// reused id would corrupt whatever currently holds it.
			if (!warnedProjectilePoolFull) {
				warnedProjectilePoolFull = true;
				fmt::print(fg(fmt::color::yellow),
					">> [Warning] No entity id available for a projectile ({} in flight, reserve "
					"{}); shots are being dropped. Raise entityIdReserveProjectiles in config.lua.\n",
					g_game.map.getEntityIdPool().liveCount(EntityClass::Projectile),
					g_game.map.getEntityIdPool().reserveOf(EntityClass::Projectile));
			}
			break;
		}
		warnedProjectilePoolFull = false;
		g_game.map.commitEntityId(projectileId);

		float spread = ((static_cast<float>(rand() % 1000) / 1000.0f) - 0.5f) * spreadNow;
		float finalAngle = baseAngle + spread;
		const ProjectileTrajectory trajectory = buildProjectileTrajectory(getPosition(), *edata, finalAngle, this, projBaseSpeed);

		auto projectile = std::make_unique<Projectile>(projectileId, trajectory.startPos, trajectory.endPos, trajectory.animStartPos, trajectory.velocityX, trajectory.velocityY, edata->damage, edata->knockback, this, projExtraId, edata->key);
		projectile->setSkipVisual(trajectory.skipVisualAnimation);

		if (edata->typeId == 3 && equippedItem) {
			projectile->setDropItemIid(equippedItem->getIID());
		}

		// Initial broadcast for visual sync (check both start and end positions like old code)
		if (!trajectory.skipVisualAnimation) {
			EntityUpdate bullet;
			projectile->buildUpdate(bullet);
			
			// No knownCreatures.insert here, deliberately. A projectile is never
			// placed on the map, so it never appears in the visibility diff's
			// `visible` set -- an id inserted here was therefore dropped again by
			// the very same tick's diff (in `known`, not in `visible` -> the
			// removal branch), which meant the insert bought nothing and cost an
			// O(n) memmove through a ~600-entry sorted vector, once per spectator
			// per pellet. In the 250-bot combat capture that was ~62,500 of them
			// per tick. Retraction is positional instead; see Game::removeProjectile.
			for (Player* p : spectators) {
				if (p->canSeeWithin(trajectory.startPos, projRange, projRange) ||
				    p->canSeeWithin(trajectory.endPos, projRange, projRange) ||
				    p->canSeeWithin(trajectory.animStartPos, projRange, projRange)) {
					p->pushUpdate(bullet);
					// Recorded so the retract path can reach exactly this set
					// again, whatever has moved since. See Projectile::markSentTo.
					projectile->markSentTo(static_cast<uint8_t>(p->getGUID()));
				}
			}
		}

		// Projectiles are no longer placed in the map grid for extreme performance.

		g_game.addProjectile(std::move(projectile));
	}
}

void Player::performMeleeAttack(const EquipableData* edata)
{
	if (!edata) return;

	const MeleeTrace trace = buildMeleeTrace(getPosition(), getRotation(), edata->meleeOffsetX, edata->meleeOffsetY, edata->meleeRange);

	// How far to the side of the aim line the swing still connects.
	const float sweep = std::max(MELEE_HIT_FORGIVENESS, static_cast<float>(edata->meleeRadius));

	// Tiles the swing's own segment covers, plus the collision margin -- not
	// the attacker's whole viewport. A hatchet reaches 59 units; asking for
	// 2601 tiles and ~830 entities to find what a 3x3 neighbourhood holds cost
	// the same as a full visibility sweep, on every swing of every player.
	// checkMeleeTargetHit rejects everything outside the trace anyway, so the
	// set of things that can be hit is unchanged.
	//
	// The sweep widens the shape being tested, so it must widen the box too --
	// a target standing beside the trace but in an uncollected tile is never
	// offered to checkMeleeTargetHit at all, and the miss is silent.
	// One roll for the whole arc; see rollMeleeDamage.
	const uint16_t swingDamage = rollMeleeDamage(*edata);

	const int32_t meleeMargin = Map::collisionScanTileMargin() +
		(static_cast<int32_t>(sweep) + TILE_SIZE - 1) / TILE_SIZE;
	const int32_t minTileX = std::min(trace.startPos.x, trace.endPos.x) / TILE_SIZE - meleeMargin;
	const int32_t maxTileX = std::max(trace.startPos.x, trace.endPos.x) / TILE_SIZE + meleeMargin;
	const int32_t minTileY = std::min(trace.startPos.y, trace.endPos.y) / TILE_SIZE - meleeMargin;
	const int32_t maxTileY = std::max(trace.startPos.y, trace.endPos.y) / TILE_SIZE + meleeMargin;

	std::vector<Thing*> spectators;
	g_game.map.getThingsInTileBox(minTileX, minTileY, maxTileX, maxTileY, spectators);

	for (Thing* target : spectators) {
		if (target == this || !canMeleeHitTarget(target)) continue;

		float tx = 0, ty = 0;
		if (checkMeleeTargetHit(target, trace.startPos, trace.endPos, sweep, tx, ty)) {
			applyMeleeHit(target, *edata, trace.startPos, tx, ty, trace.directionX, trace.directionY, swingDamage);
		}
	}
}

void Player::applyRecoil(const EquipableData& edata)
{
	if (edata.recoilKickback <= 0) {
		return;
	}

	const float angleRad = (getRotation() * MATH_TWO_PI) / 255.0f;
	// Recoil is in opposite direction of aim
	recoilX = -cos(angleRad) * edata.recoilKickback * 2.0f;
	recoilY = -sin(angleRad) * edata.recoilKickback * 2.0f;
}

// The landing half of a melee swing with a wind-up (see performAction). The
// weapon is re-read rather than captured: it is the CURRENT reach and damage
// that decide what the blow does, and for a ghoul -- the only thing that has a
// melee wind-up -- the claw cannot change mid-swing anyway.
//
// The blow is owed once the click was committed, so unlike releaseShot there is
// nothing to validate against a weapon swap; but a player who died during the
// wind-up is already gone and the id lookup in the scheduler task returns null.
void Player::releaseMeleeSwing()
{
	const EquipableData* edata = getEquippedWeaponData();
	if (!edata || !edata->projectileKey.empty()) {
		return;
	}
	performMeleeAttack(edata);
}

void Player::releaseShot(uint16_t iid, uint32_t itemUid)
{
	// The weapon that was drawn must still be the one held. Switching weapons,
	// dropping it or dying mid-draw cancels the shot rather than firing it out
	// of whatever is in hand when the timer lands.
	if (equippedWeaponIID != iid || equippedWeaponUID != itemUid) {
		return;
	}

	const EquipableData* edata = getEquippedWeaponData();
	if (!edata || edata->projectileKey.empty()) {
		return;
	}

	// Ammo and stamina were already spent at the click, so the shot is owed
	// even if the magazine has since emptied -- this is the arrow that was
	// already on the string.
	Item* equippedItem = iid != 0 ? getInventoryItemByUid(iid, itemUid) : nullptr;
	spawnProjectiles(edata, equippedItem);
	applyRecoil(*edata);
}

void Player::performAction()
{
	uint16_t iid = equippedWeaponIID;
	const EquipableData* edata = getEquippedWeaponData();
	Item* equippedItem = nullptr;
	
	if (iid != 0) {
		equippedItem = getInventoryItemByUid(iid, equippedWeaponUID);
	}

	if (edata) {
		// 1. Ammo Check
		if (!edata->ammoKey.empty()) {
			if (!equippedItem || equippedItem->getAmmo() == 0) {
				// Out of ammo. The trigger is still held, so roll straight into a
				// reload and leave isClicking set: one held click becomes
				// fire -> reload -> fire again, with updateActions holding fire
				// for as long as the magazine is empty.
				startReload();
				if (reloadEventId == 0) {
					// Nothing to reload with (no spare ammo, or a weapon with no
					// reload at all): click-click, exactly as before.
					isClicking = false;
				}
				return;
			}
		}

		// 2. Stamina Check
		if (!consumeStaminaForAction(edata->staminaUsage)) {
			return;
		}

		// 3. Consume Ammo
		if (!edata->ammoKey.empty() && equippedItem) {
			cancelReload(); // Shooting cancels reload
			uint8_t oldAmmo = equippedItem->getAmmo();
			equippedItem->setAmmo(oldAmmo - 1);
			syncEquippedAmmo(iid, *equippedItem);
		}

		// 4. Attack Logic (Projectile vs Melee)
		//
		// A weapon with a wind-up (<timing impactMs>) does NOT fire here: the
		// click starts the animation and spends the ammo and stamina above --
		// that is the commitment -- but the projectile leaves impactMs later,
		// when the bow is fully drawn. Weapons without one fire inline exactly
		// as before, so nothing that shipped changes.
		bool windingUp = false;
		if (!edata->projectileKey.empty()) {
			if (edata->impactMs > 0) {
				windingUp = true;
				// Re-resolve by id at release: the task can outlive this player
				// (disconnect, death), and player ids are reused across slots.
				// Not stored in actionEventId -- the cooldown is always longer
				// than the wind-up (equipment.cpp clamps it), so at most one
				// shot is ever pending and there is nothing to cancel against.
				const uint32_t pid = getID();
				const uint32_t drawnUid = equippedWeaponUID;
				g_scheduler.addEvent(createSchedulerTask(edata->impactMs, [pid, iid, drawnUid]() {
					if (Player* p = g_game.getPlayerByID(pid)) p->releaseShot(iid, drawnUid);
				}));
			} else {
				spawnProjectiles(edata, equippedItem);
			}
		} else if (edata->impactMs > 0) {
			// A melee weapon can have a wind-up too, and a ghoul's claw always
			// does: agents.xml gives every ghoul an <ability impactMs> that the
			// client's AI sprite animates, so landing the damage on the click
			// would resolve the hit before the claw visibly moved. Nothing in
			// equipables.xml sets impactMs on a melee weapon, so no tool or
			// hatchet changes behaviour.
			//
			// Not stored in actionEventId: the cooldown is longer than the
			// wind-up for every ghoul in agents.xml, so at most one swing is
			// pending and there is nothing to cancel against. Re-resolved by id
			// at landing time because the task can outlive this player.
			windingUp = true;
			const uint32_t pid = getID();
			g_scheduler.addEvent(createSchedulerTask(edata->impactMs, [pid]() {
				if (Player* p = g_game.getPlayerByID(pid)) p->releaseMeleeSwing();
			}));
		} else {
			performMeleeAttack(edata);
		}

		// 5. Apply Recoil Kickback -- with the shot, so a drawn weapon kicks
		// when it releases rather than when the draw begins.
		if (!windingUp) {
			applyRecoil(*edata);
		}
	}

	// Visual swing is handled by pulsing attackPulse
	attackPulse = true;
}

// A weapon that does not take ammo at all is never "empty" -- bare hands and
// melee must not be mistaken for a gun that needs reloading.
bool Player::isEquippedWeaponEmpty() const
{
	const EquipableData* edata = getEquippedWeaponData();
	if (!edata || edata->ammoKey.empty()) {
		return false;
	}

	const Item* weapon = equippedWeaponIID != 0
		? getInventoryItemByUid(equippedWeaponIID, equippedWeaponUID)
		: nullptr;
	return !weapon || weapon->getAmmo() == 0;
}

void Player::startReload()
{
	if (reloadEventId != 0 || equipEventId != 0 || modChange.eventId != 0) return;

	uint16_t iid = equippedWeaponIID;
	if (iid == 0) return;

	const EquipableData* edata = getEquippedWeaponData();
	if (!edata || edata->ammoKey.empty() || edata->reloadMs == 0) return;

	Item* weapon = getInventoryItemByUid(iid, equippedWeaponUID);
	if (!weapon || weapon->getAmmo() >= edata->magazineSize) return;

	if (findInventorySlotByItemKey(edata->ammoKey) == -1) return;

	// Start reload interaction
	sendStartInteraction(static_cast<uint16_t>(edata->reloadMs / 100));
	const uint32_t pid = getID();
	reloadEventId = g_scheduler.addEvent(createSchedulerTask(edata->reloadMs, [pid]() {
		if (Player* p = g_game.getPlayerByID(pid)) p->completeReload();
	}));
}

void Player::completeReload()
{
	reloadEventId = 0;

	uint16_t iid = equippedWeaponIID;
	const EquipableData* edata = getEquippedWeaponData();
	if (!edata) return;
	if (!ItemManager::getInstance().getItemData(edata->ammoKey)) return;

	Item* weapon = getInventoryItemByUid(iid, equippedWeaponUID);
	if (!weapon) return;

	int8_t ammoSlot = findInventorySlotByItemKey(edata->ammoKey);
	if (ammoSlot == -1) {
		sendInterruptInteraction();
		return;
	}

	uint8_t oldAmmo = weapon->getAmmo();
	uint8_t bulletsNeeded = edata->magazineSize - oldAmmo;
	
	if (edata->reloadPerShell) {
		// Reload 1 shell
		if (inventory.removeItem(ammoSlot, 1)) {
			weapon->setAmmo(oldAmmo + 1);
			syncEquippedAmmo(iid, *weapon);
			
			// Continue reloading if not full and ammo still available
			if (weapon->getAmmo() < edata->magazineSize) {
				startReload();
			}
		}
	} else {
		// Full reload
		Item* ammoItem = inventory.getItem(ammoSlot);
		uint8_t toReload = std::min(bulletsNeeded, ammoItem->getCount());
		
		if (inventory.removeItem(ammoSlot, toReload)) {
			weapon->setAmmo(oldAmmo + toReload);
			syncEquippedAmmo(iid, *weapon);
		}
	}
}

std::string Player::planModChange(uint32_t weaponUid, ModSlot slot, bool fit, uint32_t modUid, ModChangePlan& plan) const
{
	const int8_t gunSlot = inventory.findSlotByUid(weaponUid);
	const Item* gun = gunSlot < 0 ? nullptr : inventory.getItem(static_cast<uint8_t>(gunSlot));
	const EquipableData* weapon = gun ? weapon_mods::moddableWeapon(gun->getIID()) : nullptr;
	if (!gun || !weapon) return "That weapon is no longer in your inventory.";
	const std::string weaponName = gun->getData() ? gun->getData()->name : std::string("weapon");
	const ModSlotDef* def = weapon->modSlot(slot);
	if (!def) return fmt::format("The {} has no {} slot.", weaponName, modSlotName(slot));
	if (g_game.isOfferedInTrade(getID(), weaponUid)) return "Take it out of the trade first.";

	plan = ModChangePlan{};
	plan.gunSlot = static_cast<uint8_t>(gunSlot);
	if (fit) {
		const int8_t modSlot = inventory.findSlotByUid(modUid);
		const Item* mod = modSlot < 0 ? nullptr : inventory.getItem(static_cast<uint8_t>(modSlot));
		if (!mod) return "That mod is no longer in your inventory.";
		const std::string modName = mod->getData() ? mod->getData()->name : std::string("mod");
		const ModData* data = ModManager::getInstance().byItem(mod->getIID());
		if (!data || std::find(def->accepts.begin(), def->accepts.end(), mod->getIID()) == def->accepts.end()) {
			return fmt::format("The {} doesn't fit the {}.", modName, weaponName);
		}
		if (g_game.isOfferedInTrade(getID(), modUid)) return "Take it out of the trade first.";
		plan.modSlot = modSlot;
		plan.durationMs = data->installMs;
	} else {
		const uint16_t outgoing = gun->getMods().at(slot);
		const ModData* data = ModManager::getInstance().byItem(outgoing);
		if (!data) return "Nothing is fitted in that slot.";
		plan.freeSlot = inventory.firstFreeSlot();
		if (plan.freeSlot < 0) {
			const ItemData* item = ItemManager::getInstance().getItemData(outgoing);
			return fmt::format("No room in your inventory for the {}.", item ? item->name : std::string("mod"));
		}
		plan.durationMs = data->installMs;
	}
	return {};
}

std::string Player::startModChange(uint8_t weaponWireUid, ModSlot slot, bool fit, uint8_t modWireUid)
{
	if (getHealth() == 0 || isGhoul()) return "You can't change mods right now.";
	if (reloadEventId != 0 || equipEventId != 0 || actionEventId != 0 || isConsuming || crafting.iid != 0 ||
	    modChange.eventId != 0) {
		return "Finish what you're doing first.";
	}
	const int8_t gunSlot = inventory.findSlotByWireUid(weaponWireUid);
	if (gunSlot < 0) return "That weapon is no longer in your inventory.";
	const uint32_t weaponUid = inventory.getItem(static_cast<uint8_t>(gunSlot))->getUID();
	uint32_t modUid = 0;
	if (fit) {
		const int8_t modSlot = inventory.findSlotByWireUid(modWireUid);
		if (modSlot < 0) return "That mod is no longer in your inventory.";
		modUid = inventory.getItem(static_cast<uint8_t>(modSlot))->getUID();
	}

	ModChangePlan plan;
	const std::string refusal = planModChange(weaponUid, slot, fit, modUid, plan);
	if (!refusal.empty()) return refusal;

	modChange = PendingModChange{0, weaponUid, modUid, slot, fit};
	sendStartInteraction(static_cast<uint16_t>(plan.durationMs / 100));
	const uint32_t pid = getID();
	modChange.eventId = g_scheduler.addEvent(createSchedulerTask(plan.durationMs, [pid]() {
		if (Player* p = g_game.getPlayerByID(pid)) p->completeModChange();
	}));
	return {};
}

void Player::completeModChange()
{
	const PendingModChange change = modChange;
	modChange = PendingModChange{};
	ModChangePlan plan;
	const std::string refusal = planModChange(change.weaponUid, change.slot, change.fit, change.modUid, plan);
	if (!refusal.empty()) {
		sendInterruptInteraction();
		g_game.sendStatus(this, refusal, StatusKind::FAILURE);
		return;
	}
	inventory.applyModChange(plan.gunSlot, change.slot, plan.modSlot, plan.freeSlot);
}

void Player::cancelModChange()
{
	if (modChange.eventId == 0) return;
	cancelInteractionEvent(modChange.eventId); // stops it, zeroes it, tells the client
	modChange = PendingModChange{};
}

void Player::cancelModChangeFor(uint32_t uid)
{
	if (modChange.eventId != 0 && (uid == modChange.weaponUid || (modChange.fit && uid == modChange.modUid))) {
		cancelModChange();
	}
}

void Player::consumeItem(uint16_t iid, uint32_t itemUid)
{
	actionEventId = 0;
	
	// 1. Verify item exists using UID
	int8_t slot = inventory.findItemByUidSlot(itemUid, iid);

	if (slot == -1) return;

	const ItemData* idata = getItemData(iid);
	if (!idata) return;
	const EquipableData* edata = EquipmentManager::getInstance().getEquipable(idata->key);
	if (!edata) return;

	// 2. Apply effects
	int16_t energyTotal = 0;

	for (const auto& effect : edata->consumableEffects) {
		energyTotal += applyConsumableEffect(effect);
	}

	if (!edata->conditionKey.empty()) {
		addCondition(edata->conditionKey);
	}

	if (!edata->cureConditionKeys.empty()) {
		cureConditions(edata->cureConditionKeys);
	}

	// 3. Visuals (Only for non-life effects, as life effects are now handled in changeHealth)
	if (energyTotal > 0) {
		// Yellow Aura for stamina restoration (Opcode 65)
		g_game.broadcastPlayerEat(static_cast<uint8_t>(getGUID()), getPosition());
	}

	// 4. Consume and Sync
	inventory.removeItem(static_cast<uint8_t>(slot), 1);
	g_events.emit({EventType::Use, this, idata->key});
	markGaugesDirty();
}

ConditionVisual Player::conditionVisual() const
{
	ConditionVisual visual;
	visual.withdrawn = drugWithdrawn;

	// Longest remaining wins per channel. Two effects wanting the same skin at
	// once is not a case the shipped content has, but the client keeps exactly
	// ONE timer per channel, so the longest is the only answer that cannot end
	// a skin while something is still asking for it.
	visual.repellentMs = conditions.longestRemainingWith(DrugTimerType::REPELLENT);
	visual.withdrawalMs = conditions.longestRemainingWith(DrugTimerType::WITHDRAWAL);
	return visual;
}

namespace {

struct ConditionVisualWire {
	ServerOpcode op;
	uint8_t value;
};

// A whole ConditionVisual as the opcode sequence that carries it. Both the
// broadcast and the single-client path walk this same table, so they cannot
// disagree about what the truth looks like on the wire.
//
// RESET_DRUG goes first, and unconditionally. It is the only message that
// CLEARS, it clears both channels at once, and its second byte is the only
// carrier for the withdrawn marker -- so stating the whole truth means wiping
// the slate and re-asserting whatever is still live, in that order. Sending it
// every time is what makes an unrelated effect ending harmless: the re-assert
// is part of the same statement, where the old code sent the bare clear on its
// own and left a live ghoul-drug skin wiped off every screen.
uint8_t buildConditionVisualWire(const ConditionVisual& visual, std::array<ConditionVisualWire, 3>& out)
{
	uint8_t count = 0;
	out[count++] = {ServerOpcode::RESET_DRUG, static_cast<uint8_t>(visual.withdrawn ? 1 : 0)};

	// Both channels clamp to at least 1: the client reads a zero byte as "not
	// drugged at all", so a channel with less than one wire unit left would
	// blink off early rather than run down. The upper clamp is the byte itself
	// -- see CONDITION_VISUAL_RESTATE_MS for why losing the top of a long
	// repellent is survivable.
	if (visual.repellentMs != 0) {
		out[count++] = {ServerOpcode::REPELLENT,
			static_cast<uint8_t>(std::clamp<uint32_t>(visual.repellentMs / 2000, 1, 255))};
	}
	if (visual.withdrawalMs != 0) {
		out[count++] = {ServerOpcode::LAPADOINE,
			static_cast<uint8_t>(std::clamp<uint32_t>(visual.withdrawalMs / 1000, 1, 255))};
	}
	return count;
}

} // namespace

void Player::syncPoisonScreen(bool force)
{
	if (!client) return;

	// Longest remaining wins, exactly as the drug channels do: the client keeps
	// one animation, so the only answer that cannot end it while something is
	// still asking for it is the longest.
	const uint32_t poisonMs = conditions.longestRemainingPoisonScreen();

	const bool running = poisonMs != 0;
	if (!force && running == poisonScreenSent) return;

	poisonScreenSent = running;
	// A zero byte is the stop, which client.js now honours through
	// Render.stopPoisonEffect. It used to be sent unconditionally from every
	// cure and was a no-op in the only case it was written for.
	client->sendPoisened(running
		? static_cast<uint8_t>(std::clamp<uint32_t>(poisonMs / 1000, 1, 255))
		: 0);
}

void Player::syncConditionVisual(uint32_t elapsedMs, bool force)
{
	syncPoisonScreen(force);

	const ConditionVisual visual = conditionVisual();
	const bool shapeChanged = !conditionVisualKnown || !visual.sameShapeAs(lastSentConditionVisual);

	if (!shapeChanged && !force) {
		// Nothing has changed, so the only reason left to speak is the re-state
		// window -- and a player with nothing drawn on them has nothing to
		// re-state. That is almost everyone, every tick, and it is why this test
		// comes before the timer.
		if (visual.isClean()) return;

		conditionVisualRestateMs += elapsedMs;
		if (conditionVisualRestateMs < CONDITION_VISUAL_RESTATE_MS) return;
	}

	conditionVisualRestateMs = 0;
	lastSentConditionVisual = visual;

	// A character nobody has been told anything about is already clean on every
	// client. Saying so would be one broadcast per player at login to change
	// nothing at all.
	const bool firstStatement = !conditionVisualKnown;
	conditionVisualKnown = true;
	if (firstStatement && visual.isClean()) return;

	std::array<ConditionVisualWire, 3> wire;
	const uint8_t count = buildConditionVisualWire(visual, wire);
	const uint8_t pid = static_cast<uint8_t>(getGUID());

	// One NetworkMessage reused across the sequence: the object carries a 24 KB
	// buffer, so three of them on the stack is three __chkstk probes for nine
	// bytes of payload.
	//
	// broadcastStateToWatchers, not broadcastToWatchers: this is what the player
	// IS, not what happened to them, and the event frame budget would drop it.
	NetworkMessage msg;
	for (uint8_t i = 0; i < count; ++i) {
		msg.reset();
		msg.addByte(static_cast<uint8_t>(wire[i].op));
		msg.addByte(pid);
		msg.addByte(wire[i].value);
		g_game.broadcastStateToWatchers(msg, getPosition(), this);
	}
}

void Player::sendConditionVisualTo(ProtocolGame* target) const
{
	if (!target) return;

	const ConditionVisual visual = conditionVisual();
	if (visual.isClean()) return;

	std::array<ConditionVisualWire, 3> wire;
	const uint8_t count = buildConditionVisualWire(visual, wire);
	const uint8_t pid = static_cast<uint8_t>(getGUID());
	for (uint8_t i = 0; i < count; ++i) {
		target->sendMessage(wire[i].op, pid, wire[i].value);
	}
}

// A fresh dose of anything that repels wipes the grudges. Without this a drug
// bought specifically to be left alone would arrive already cancelled for
// whatever the player shot on the way, which is not what taking it is for -- and
// there would be no way to clear a broken repel short of dying.
//
// Hung off "a condition was applied" rather than off the generic "the set
// changed", which also fires on an expiry and on a cure: clearing the grudges
// when a poison wore off would be wrong.
void Player::onConditionApplied(const ConditionData* data)
{
	for (const ConditionStage& stage : data->stages) {
		if (!stage.repel.empty()) {
			clearBrokenRepels();
			return;
		}
	}
}

float Player::conditionResistanceFor(const std::string& key) const
{
	// The wearable's own <key>Resistance, read through the same generic lookup
	// that damage types already use -- so <modifier key="toxic_poisonResistance">
	// on a hazmat suit works with no new plumbing at all. A ghoul answers from
	// its agents.xml <resistances> through the same function.
	const float wearable = std::clamp(getWearableModifier(key + "Resistance"), 0.0f, 1.0f);
	const float active = conditions.resistanceTo(key);
	// Composed as a product of what each source lets through, so armour plus a
	// running <resist> approaches immunity without two partial protections ever
	// adding up to it.
	return 1.0f - (1.0f - wearable) * (1.0f - active);
}

void Player::applyConditionTick(GaugeSlot slot, int16_t amount, uint32_t inflictorGuid)
{
	if (amount == 0) return;

	// Resolved per tick rather than held: the inflictor may have logged out or
	// died since. A null one is the normal way an effect outlives its applier and
	// degrades to exactly the old behaviour -- environment damage, credited to
	// nobody.
	Player* inflictor = inflictorGuid != 0 ? g_game.getPlayerByGUID(inflictorGuid) : nullptr;

	if (slot == GaugeSlot::LIFE) {
		// The one channel that can kill, and so the one that can resurrect and
		// rewrite the whole active set. isTick=true marks it as gauge damage:
		// the amount is already in bar units, so the ghoul damage scale must not
		// touch it. damageType "poison" is what a wearable's poisonResistance
		// reduces.
		const uint8_t oldHp = health;
		changeHealth(amount, true, false, true, "poison", inflictor);
		if (health != oldHp) {
			markGaugesDirty();
		}
		return;
	}

	// The other four gauges. Saturating in both directions against this mode's
	// ceiling for the slot, so a drain cannot wrap a uint8 round to full.
	const Game::ActiveGauges& modes = g_game.getActiveGauges();
	uint8_t* gauge = nullptr;
	uint8_t ceiling = 255;
	switch (slot) {
		case GaugeSlot::FOOD:      gauge = &hunger;    ceiling = gaugeCeiling(modes.food); break;
		case GaugeSlot::WARMTH:    gauge = &cold;      ceiling = gaugeCeiling(modes.warmth); break;
		case GaugeSlot::STAMINA:   gauge = &stamina;   ceiling = gaugeCeiling(modes.stamina); break;
		case GaugeSlot::RADIATION: gauge = &radiation; ceiling = gaugeCeiling(modes.radiation); break;
		default: return;
	}

	const int32_t updated = std::clamp<int32_t>(
		static_cast<int32_t>(*gauge) + amount, 0, static_cast<int32_t>(ceiling));
	if (updated == static_cast<int32_t>(*gauge)) return;

	*gauge = static_cast<uint8_t>(updated);
	// The client integrates these gauges from rates it was told; a condition
	// moving one out of band is exactly the correction it cannot predict.
	markGaugesDirty();
}

// The cure, wrapping Creature::removeConditions with the one thing only a player
// has: a mark that OUTLIVES the effect that set it.
//
// The withdrawn marker is not in the active list, so nothing there can clear it
// -- a cure naming an effect that HAS a withdrawal stage is what does, whether
// or not that effect is still running. This is the antidote's advertised job
// ("remove the withdrawal effects (pink skin)"), and deriving it from the cure
// list rather than from a stored cause means a narrower future cure will
// correctly leave the mark alone.
void Player::cureConditions(const std::vector<std::string>& keysToCure)
{
	if (keysToCure.empty()) return;

	bool markerCleared = false;
	const ConditionManager& manager = ConditionManager::getInstance();
	for (const std::string& k : keysToCure) {
		if (k == "all") {
			markerCleared = drugWithdrawn;
			drugWithdrawn = false;
			break;
		}
		const ConditionData* cured = manager.getEffectData(k);
		if (cured && cured->hasStageVisual(DrugTimerType::WITHDRAWAL)) {
			markerCleared = drugWithdrawn;
			drugWithdrawn = false;
			break;
		}
	}

	// conditions.remove directly rather than Creature::removeConditions, so the
	// statement below happens exactly ONCE. Going through the base would fire
	// onConditionsChanged and then this would force a second identical frame --
	// which it did, and checkpoisonscreen saw the antidote send two stops.
	const bool removed = conditions.remove(keysToCure);

	// Either half is a visible change on its own: an antidote taken by somebody
	// with no active conditions still has the marker to clear.
	if (removed || markerCleared) {
		// One statement, derived from what is left rather than from what this
		// cure was aimed at. Both halves used to be sent by hand here and both
		// were wrong: the bare clear wiped a live ghoul-drug skin off every
		// client that could see the player, and the sendPoisened(0) fired
		// whether or not any poison had been cured -- and was a no-op anyway,
		// because client.js used to ignore opcode 67 while its animation was
		// running. It stops one now, so this is where the antidote finally
		// clears the green screen.
		onConditionsChanged();
	}
}

// The per-tick half a PLAYER owes on top of Creature::updateConditions, which
// does the actual advancing. Split because the shared walk has no business
// knowing about drug skins, and a player has a client to keep informed.
//
// syncConditionVisual is called on EVERY tick, not only on a change: it carries
// its own edge test and a re-state window, and a long repellent has to be
// re-asserted every 10 seconds because the wire carries its remaining time in
// one byte that cannot hold 600 seconds. See CONDITION_VISUAL_RESTATE_MS.
void Player::updatePlayerConditions(uint32_t elapsedMs)
{
	updateConditions(elapsedMs);

	// One statement of the whole truth, after every effect has moved. No visual
	// is sent from inside the walk: a stage transition used to state only its own
	// channel and an expiry used to send a bare clear, so two effects running
	// together could not help but overwrite each other.
	syncConditionVisual(elapsedMs);
}

void Player::breakRepelForAgentType(const std::string& key, uint32_t forMs)
{
	if (key.empty() || forMs == 0) return;

	const uint64_t until = static_cast<uint64_t>(OTSYS_TIME()) + forMs;
	for (BrokenRepel& br : brokenRepels) {
		if (br.key == key) {
			// EXTEND only. Hitting one member while the type is already angry
			// re-starts its clock; it must never shorten one, which a bare
			// assignment would do for a type with a longer window that was
			// provoked by something else.
			br.until = std::max(br.until, until);
			return;
		}
	}
	brokenRepels.push_back({key, until});
}

bool Player::isRepelBrokenForAgentType(const std::string& key) const
{
	if (brokenRepels.empty()) return false;

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	for (const BrokenRepel& br : brokenRepels) {
		if (br.key == key) return now < br.until;
	}
	return false;
}

bool Player::repelsAgent(const std::string& family, const std::string& key) const
{
	// The overwhelmingly common answer, reached without touching the effect
	// table at all.
	if (conditions.empty()) return false;

	// You started this fight. Checked ahead of the effect table because it is
	// the cheaper test and it overrides whatever the table would have said --
	// for THIS type only, which is the whole point: the rest of the family
	// carries on ignoring you.
	if (isRepelBrokenForAgentType(key)) return false;

	// Per STAGE, not per effect: a drug can perfectly well protect you while it
	// is working and stop the moment it wears off into withdrawal.
	return conditions.repels(family, key);
}

// The reload rebind, wrapping ConditionSet::rebind with the client half. See
// ConditionSet::keys for why the keys have to be captured before the swap.
void Player::rebindConditions(const std::vector<std::string>& keys)
{
	conditions.rebind(keys);

	// The set may have changed shape, and every client's idea of this player was
	// formed under the old table.
	conditionVisualKnown = false;
	syncConditionVisual(0, true);
}

void Player::restoreStamina(uint8_t amount)
{
	if (amount == 0) return;

	const uint8_t ceiling = gaugeCeiling(g_game.getActiveGauges().stamina);
	if (stamina >= ceiling) return;

	stamina = static_cast<uint8_t>(
		std::min<int32_t>(ceiling, static_cast<int32_t>(stamina) + amount));
	// The client integrates this gauge from a rate it was told, so a gain out of
	// band is exactly the correction it cannot predict.
	markGaugesDirty();
}

float Player::wearableSpeedModifier() const
{
	if (wearableCacheDirty) {
		cachedWearableSpeed = getWearableModifier("speedMultiplier");
		wearableCacheDirty = false;
	}
	return cachedWearableSpeed;
}

void Player::setID()
{
	if (id == 0) {
		// allowClones id assignment
		if (getBoolean(ConfigManager::ALLOW_CLONES)) {
			id = playerAutoID++;
			return;
		}

		// normal id assignment
		if (guid != 0) {
			id = playerAutoID + guid;
		}
	}
}

void Player::sendKeepAlive()
{
	// The interval lives in ProtocolGame now, which also knows whether real
	// traffic already reset the client's watchdog.
	if (client) {
		client->sendKeepAlive();
	}
}

Connection::Address Player::getIP() const
{
	if (client) {
		return client->getIP();
	}

	return lastIP; // A dormant character still counts against its origin.
}

void Player::onThingAppear(Thing* thing, bool isLogin)
{
	if (client) {
		knownCreatures.insert(thing->getID());
		EntityUpdate update;
		thing->buildUpdate(update);
		pushUpdate(update);
		if (isLogin) {
			pendingIsLogin = true;
		}
	}
}

bool Player::canSeeCreature(const Creature* creature) const
{
	if (creature == this) {
		return true;
	}
	/*
	if (creature->isInGhostMode() && !canSeeGhostMode(creature)) {
		return false;
	}

	if (!creature->getPlayer() && !canSeeInvisibility() && creature->isInvisible()) {
		return false;
	}
	*/
	return true;
}

bool Player::canSee(const Position& pos) const
{
	// The view settled by updateAim this tick: the box, inclusive as isInRange
	// was, or a strong scope's rear circle and outer shape.
	const Position& me = getPosition();
	return aim_view::viewContains(view, static_cast<int32_t>(pos.x) - static_cast<int32_t>(me.x),
		static_cast<int32_t>(pos.y) - static_cast<int32_t>(me.y));
}

bool Player::canSeeScenery(const Position& pos) const
{
	const Position& me = getPosition();
	return view.box.containsInclusive(static_cast<int32_t>(pos.x) - static_cast<int32_t>(me.x),
		static_cast<int32_t>(pos.y) - static_cast<int32_t>(me.y));
}

void Player::equipItem(uint8_t slot)
{
	Item* item = inventory.getItem(slot);
	startEquipping(item ? item->getIID() : 0, item ? item->getUID() : 0);
}

// Inventory item UIDs travel over the protocol as their low byte only, so
// equality against a client-sent UID must compare that byte (see
// Inventory::findItemByUidSlot).
static bool matchesClientUid(uint32_t fullUid, uint32_t clientUid)
{
	return (fullUid & 0xFF) == (clientUid & 0xFF);
}

void Player::startEquipping(uint16_t iid, uint32_t itemUid)
{
	// Re-clicking the item that is currently being equipped cancels the equip,
	// mirroring consumable cancel behavior.
	if (equipEventId != 0 && pendingEquipIID == iid && matchesClientUid(pendingEquipUID, itemUid)) {
		cancelEquipping();
		return;
	}

	cancelReload();
	cancelModChange(); // switching weapon cancels a mod change
	cancelEquipping();
	cancelAction(); // NEW: Consumables/Attacks stop when swapping items

	const ItemData* idata = (iid != 0) ? getItemData(iid) : nullptr;
	
	// Default to clearing weapon if clicking empty or invalid
	if (!idata) {
		if (equippedWeaponIID != 0) {
			queueEquipCompletion(300, 0, 0, EquipmentType::WEAPON);
		}
		return;
	}

	uint32_t delay = 0;
	EquipmentType type = EquipmentType::WEAPON;
	bool isToggleOff = false;

	if (idata->isEquipable) {
		type = EquipmentType::WEAPON;
		delay = idata->equipTimeMs;
		// A moddable gun draws as fast as its mods let it (the drawMs stat).
		if (const EquipableData* weapon = weapon_mods::moddableWeapon(iid)) {
			if (const Item* item = getInventoryItemByUid(iid, itemUid)) {
				delay = weapon_mods::resolveDrawMs(*weapon, delay, item->getMods());
			}
		}
		if (equippedWeaponIID == iid && matchesClientUid(equippedWeaponUID, itemUid)) isToggleOff = true;
	} else if (idata->isWearable) {
		type = EquipmentType::WEARABLE;
		delay = idata->wearTimeMs;
		if (equippedWearableIID == iid && matchesClientUid(equippedWearableUID, itemUid)) isToggleOff = true;
	} else {
		return;
	}

	uint16_t targetIid = isToggleOff ? 0 : iid;
	uint32_t targetUid = isToggleOff ? 0 : itemUid;

	queueEquipCompletion(delay, targetIid, targetUid, type);
}

void Player::cancelEquipping()
{
	cancelInteractionEvent(equipEventId);
}

void Player::queueEquipCompletion(uint32_t delay, uint16_t targetIid, uint32_t targetUid, EquipmentType type)
{
	if (delay > 0) {
		pendingEquipIID = targetIid;
		pendingEquipUID = targetUid;
		sendStartInteraction(static_cast<uint16_t>(delay / 100));

		const uint32_t pid = getID();
		equipEventId = g_scheduler.addEvent(createSchedulerTask(delay, [pid, targetIid, targetUid, type]() {
			if (Player* p = g_game.getPlayerByID(pid)) p->completeEquip(targetIid, targetUid, type);
		}));
		return;
	}

	completeEquip(targetIid, targetUid, type);
}

static const std::string& getEffectiveEquipKey(const ItemData* d)
{
	return d->equipKey.empty() ? d->key : d->equipKey;
}

void Player::completeEquip(uint16_t iid, uint32_t itemUid, EquipmentType type)
{
	equipEventId = 0;
	pendingEquipIID = 0;
	pendingEquipUID = 0;

	if (iid == 0) {
		if (type == EquipmentType::WEAPON) {
			equippedWeaponIID = 0;
			equippedWeaponUID = 0;
			setHeldItemIID(0);
			sendSelectedItem(0);
			sendBlueprint(0);
		} else {
			equippedWearableIID = 0;
			equippedWearableUID = 0;
			setSkin(0);
			// Taking armour off returns its speed penalty. See
			// Player::markWearableCacheDirty.
			markWearableCacheDirty();
		}
		return;
	}

	Item* invItem = getInventoryItemByUid(iid, itemUid);
	if (!invItem) {
		fmt::print(">> [Equip Error] Item IID {} UID {} not found in inventory for {}.\n", iid, itemUid, getName());
		return;
	}

	const ItemData* idata = getItemData(iid);
	if (!idata) return;

	if (type == EquipmentType::WEAPON) {
		const EquipableData* edata = EquipmentManager::getInstance().getEquipable(getEffectiveEquipKey(idata));
		if (edata) {
			equippedWeaponIID = iid;
			// Store the full item UID so full-width comparisons (auto-unequip on
			// removal, decay transform) match; the client-sent UID is only 8 bits.
			equippedWeaponUID = invItem->getUID();
			setHeldItemIID(edata->weaponId);
			sendSelectedItem(iid);
			
			// Handle building mode (typeId 6)
			if (edata->typeId == 6) {
				sendBlueprint(iid);
			} else {
				sendBlueprint(0);
			}
			fmt::print(">> Player {} equipped weapon {}, visual index: {}\n", getName(), idata->name, edata->weaponId);
		} else {
			fmt::print(">> [Equip Error] No equipable data for key '{}' (item: {})\n", getEffectiveEquipKey(idata), idata->name);
		}
	} else if (type == EquipmentType::WEARABLE) {
		const WearableData* wdata = EquipmentManager::getInstance().getWearable(getEffectiveEquipKey(idata));
		if (wdata) {
			equippedWearableIID = iid;
			equippedWearableUID = invItem->getUID();
			setSkin(static_cast<uint8_t>(wdata->skinId));
			// New armour, new weight penalty. See Player::markWearableCacheDirty.
			markWearableCacheDirty();
			fmt::print(">> Player {} equipped wearable {}, skin: {}\n", getName(), idata->name, skin);
		} else {
			fmt::print(">> [Equip Error] No wearable data for key '{}' (item: {})\n", getEffectiveEquipKey(idata), idata->name);
		}
	}
}

void Player::useItem(uint8_t slot)
{
	if (modChange.eventId != 0) return;
	Item* item = inventory.getItem(slot);
	if (!item) return;

	const ItemData* idata = getItemData(item->getIID());
	if (!idata) return;

	const EquipableData* edata = EquipmentManager::getInstance().getEquipable(idata->key);
	if (!edata || !edata->isConsumable) return;

	consumeItem(item->getIID(), item->getUID());
}

void Player::unlockSkill(uint16_t iid)
{
	if (unlockedSkills.contains(iid)) return;
	unlockedSkills.insert(iid);

	const ItemData* idata = getItemData(iid);
	if (idata && idata->bagSlots > 0) {
		inventory.expand(idata->bagSlots);
	}
}

float Player::getWearableModifier(std::string_view modifierKey) const
{
	// A ghoul wears nothing, so its <resistances> answer here instead -- this is
	// the one place any damage path asks what the victim shrugs off, for weapons
	// (via damageType + "Resistance") and for the cold and radiation rates
	// alike. Routing agent resistances through it is what makes an armoured
	// ghoul's plating work against a player's hatchet without a second rule.
	//
	// Same semantics either way: a fraction of 0..1 removed from the hit.
	if (ghoulData) {
		if (modifierKey.size() > 10 &&
		    modifierKey.substr(modifierKey.size() - 10) == "Resistance") {
			const std::string kind(modifierKey.substr(0, modifierKey.size() - 10));
			return ghoulData->resistanceFor(agentDamageKindFromString(kind));
		}
		return 0.0f;
	}

	float total = 0.0f;
	if (const WearableData* wdata = getEquippedWearableData()) {
		for (const auto& effect : wdata->effects) {
			// Explicit view: there is no std::string == std::string_view
			// operator to deduce.
			if (std::string_view(effect.key) == modifierKey) {
				total += effect.multiplier;
			}
		}
	}
	return total;
}

uint8_t Player::getCraftMultiplier(uint16_t iid) const
{
	uint8_t multiplier = 1;
	for (uint16_t skillIid : unlockedSkills) {
		multiplier *= getCraftBonusForSkill(skillIid, iid);
	}
	return multiplier;
}

void Player::completeThrow(uint16_t iid, uint32_t itemUid)
{
	actionEventId = 0;

	const ItemData* idata = getItemData(iid);
	if (!idata) return;

	const EquipableData* edata = EquipmentManager::getInstance().getEquipable(idata->key);
	if (!edata) return;

	int8_t slot = inventory.findItemByUidSlot(itemUid, iid);
	if (slot == -1) return;

	Item* item = inventory.getItem(slot);
	if (!item) return;

	// 1. Stamina Check
	if (!consumeStaminaForAction(edata->staminaUsage, true)) return;

	// 2. Spawn Projectile
	spawnProjectiles(edata, item);

	// 3. Consume Item
	inventory.removeItem(static_cast<uint8_t>(slot), 1);
}

void Player::setKarmaLevel(uint8_t newKarma)
{
	if (newKarma > 5) {
		newKarma = 5;
	}
	karmaLevel = newKarma;

	if (client) {
		client->sendKarma(getKarmaClientIcon());
	}

	g_game.broadcastLeaderboard();
}

float Player::getKarmaXPMultiplier() const
{
	if (const GameMode* mode = g_game.getActiveMode()) {
		auto it = mode->karmaLevels.find(karmaLevel);
		if (it != mode->karmaLevels.end()) {
			return it->second.xpMultiplier;
		}
	}

	switch (karmaLevel) {
		case 0: return 1.25f; // Angel
		case 1: return 1.00f; // Normal
		case 2: return 0.95f; // Orange
		case 3: return 0.90f; // Red
		case 4: return 0.85f; // Savage
		case 5: return 0.80f; // Devil
		default: return 1.00f;
	}
}

uint8_t Player::getKarmaClientIcon() const
{
	return karmaLevel;
}

void Player::setKarmaKills(uint32_t kills)
{
	if (karmaLevel >= 4) {
		return;
	}

	karmaKills = kills;

	if (const GameMode* mode = g_game.getActiveMode()) {
		uint8_t evaluatedLevel = 1;

		if (karmaLevel == 0 && karmaKills == 0) {
			evaluatedLevel = 0;
		} else {
			for (uint8_t lvl = 1; lvl <= 5; ++lvl) {
				auto it = mode->karmaLevels.find(lvl);
				if (it != mode->karmaLevels.end()) {
					if (karmaKills <= it->second.maxKills) {
						evaluatedLevel = lvl;
						break;
					}
				}
			}
		}

		if (evaluatedLevel != karmaLevel) {
			setKarmaLevel(evaluatedLevel);
		}
	}
}

void Player::forceKarma(uint8_t level, uint32_t kills)
{
	if (level > 5) level = 5;
	karmaLevel = level;
	karmaKills = kills;
	if (client) {
		client->sendKarma(getKarmaClientIcon());
	}
	g_game.broadcastLeaderboard();
}

void Player::registerAttacker(uint32_t attackerGuid)
{
	recentAttackers[attackerGuid] = OTSYS_TIME();
}

bool Player::hasAttackedRecently(uint32_t attackerGuid) const
{
	auto it = recentAttackers.find(attackerGuid);
	if (it == recentAttackers.end()) {
		return false;
	}
	uint64_t limitMs = static_cast<uint64_t>(ConfigManager::getNumber(ConfigManager::SELF_DEFENSE_MINUTES)) * 60 * 1000;
	return (OTSYS_TIME() - it->second < limitMs);
}

void Player::sendInventorySlot(uint16_t iid, uint8_t count, uint32_t uid, uint8_t ammo)
{
    g_game.tradeInventoryChanged(getID(), uid, iid, count, ammo);
    if (client) client->sendInventorySlot(iid, count, uid, ammo);
}
void Player::sendClearInventorySlot(uint32_t uid)
{
    g_game.tradeInventoryChanged(getID(), uid, 0, 0, 0);
    if (client) client->sendClearInventorySlot(uid);
}
