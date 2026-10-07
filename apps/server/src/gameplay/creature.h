// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_CREATURE_H
#define FS_CREATURE_H

#include "core/const.h"
#include "core/enums.h"
#include "world/thing.h"
#include "core/position.h"
#include "gameplay/condition.h"
#include <cmath>
#include <algorithm>

class Player;
class Object;

// How much knockback impulse a body will accept in one window, shared by
// everyone hitting it. See KNOCKBACK_WINDOW_MS: the recoil buffer is consumed
// and refilled every tick, so clamping its magnitude does nothing against a
// pack -- each fresh hit simply re-saturated it and the victim was carried
// away. Held here rather than in Player and Agent separately so the two cannot
// drift; a player shot by three people and a ghoul beaten by three bots are the
// same problem.
struct KnockbackBudget
{
	// Fraction (0..1) of an impulse of magnitude `mag` that may be applied now.
	float admit(float mag, int64_t now)
	{
		if (mag < 0.0001f) return 0.0f;
		if (now >= windowEnd) {
			windowEnd = now + KNOCKBACK_WINDOW_MS;
			remaining = MAX_KNOCKBACK_RECOIL;
		}
		if (remaining <= 0.0f) return 0.0f;

		const float admitted = std::min(mag, remaining);
		remaining -= admitted;
		return admitted / mag;
	}

private:
	int64_t windowEnd = 0;
	float remaining = 0.0f;
};

static constexpr uint32_t CREATURE_ID_MIN = 0x10000000;
static constexpr uint32_t CREATURE_ID_MAX = std::numeric_limits<uint32_t>::max();

class Creature : virtual public Thing
{
protected:
	Creature();

public:
	virtual ~Creature();

	// non-copyable
	Creature(const Creature&) = delete;
	Creature& operator=(const Creature&) = delete;

	Creature* getCreature() override final { return this; }
	const Creature* getCreature() const override final { return this; }
	virtual Player* getPlayer() { return nullptr; }
	virtual const Player* getPlayer() const { return nullptr; }

	virtual const std::string& getName() const = 0;
	virtual CreatureType_t getType() const = 0;
	virtual void setID() = 0;

	uint32_t getID() const { return id; }

	void incrementReferenceCounter() { ++referenceCounter; }
	void decrementReferenceCounter()
	{
		if (--referenceCounter == 0) {
			delete this;
		}
	}

	virtual void onThingAppear(Thing*, bool) {}

	// A ghoul body is SOLID, like every other creature's. This used to be
	// `ghoul == 0`, which did far more than stop ghouls bumping into people:
	// hasCollision() decides membership of Tile::getSolidThings, and both the
	// projectile sweep (Game::traceProjectileSegment) and the melee sweep
	// (Player::canMeleeHitTarget) filter on it -- so a ghoul could not be shot,
	// could not be hit, and walked through everyone. Harmless while `ghoul` was
	// a field nothing set; the whole point of ghoul mode is that it is set.
	bool hasCollision() const override { return true; }
	float getCollisionRadius() const override { return 32.0f; } // Default player radius
	bool isMobile() const override { return true; }

	const Position& getPosition() const { return position; }
	const Position& getLastPosition() const { return lastPosition; }
	void setPosition(const Position& newPos) {
		lastPosition = position;
		position = newPos;
		if (!visualInit || std::abs(static_cast<float>(newPos.x) - visualX) > 200.0f || std::abs(static_cast<float>(newPos.y) - visualY) > 200.0f) {
			visualX = static_cast<float>(newPos.x);
			visualY = static_cast<float>(newPos.y);
			visualInit = true;
		}
	}

	void updateVisualPosition(uint32_t elapsedMs) {
		const float tx = static_cast<float>(position.x);
		const float ty = static_cast<float>(position.y);
		if (!visualInit || std::abs(tx - visualX) > 200.0f || std::abs(ty - visualY) > 200.0f) {
			visualX = tx;
			visualY = ty;
			visualInit = true;
			return;
		}
		const float alpha = std::min(1.0f, elapsedMs * 0.0055f);
		visualX += (tx - visualX) * alpha;
		visualY += (ty - visualY) * alpha;
	}

	float getVisualX() const { return visualInit ? visualX : static_cast<float>(position.x); }
	float getVisualY() const { return visualInit ? visualY : static_cast<float>(position.y); }

	uint8_t getRotation() const { return rotation; }
	void setRotation(uint8_t rot) { rotation = rot; }

	virtual bool isDirty() const {
		return position != lastPosition || rotation != lastRotation ||
			lookType != lastLookType || skin != lastSkin || ghoul != lastGhoul ||
			heldItemIID != lastHeldItemIID || getSpeed() != lastSpeed;
	}

	virtual void resetDirty() {
		lastPosition = position;
		lastRotation = rotation;
		lastLookType = lookType;
		lastSkin = skin;
		lastGhoul = ghoul;
		lastHeldItemIID = heldItemIID;
		lastSpeed = getSpeed();
	}

	uint16_t getLookType() const { return lookType; }
	void setLookType(uint16_t type) { lookType = type; }

	uint8_t getSkin() const { return skin; }
	void setSkin(uint8_t s) { skin = s; }

	uint8_t getGhoul() const { return ghoul; }
	void setGhoul(uint8_t g) { ghoul = g; }

	uint16_t getHeldItemIID() const { return heldItemIID; }
	void setHeldItemIID(uint16_t iid) { heldItemIID = iid; }

	virtual uint16_t getSpeed() const;
	void setSpeed(uint16_t s) { speed = s; }

	// Summed changeSpeed of triggered step-in objects on the current tile
	// (wood_spike slow, road boost). One definition for players and agents.
	int32_t getTileSpeedDelta() const;

	// --- Conditions -----------------------------------------------------------
	//
	// On Creature, not on Player, and that is the point: an agent that cannot be
	// poisoned makes a poison weapon useless against the things the world is
	// actually full of. What differs between a player and an agent is not the
	// bookkeeping -- it is what a tick DOES, which is why ConditionSet::update
	// collects ticks and applies none of them, and why applyConditionTick below
	// is the one thing a subclass must supply.
	ConditionSet& getConditionSet() { return conditions; }
	const ConditionSet& getConditionSet() const { return conditions; }

	// Apply one, honouring this creature's own resistance to it. `inflictorGuid`
	// is the player to credit for anything the condition goes on to do -- a
	// poison kill is that player's kill. 0 means the environment, an agent, or
	// the creature itself, which is what eating a bad mushroom is.
	// `durationOverrideMs` lets the SOURCE decide how long its dose lasts
	// (<onHit durationMs=>), overriding the condition's own first stage; 0 keeps
	// whatever conditions.xml says. `strength` is the same idea for HOW HARD it
	// hits (<onHit strength=>); 1.0 is the condition exactly as written.
	bool addCondition(const std::string& key, uint32_t inflictorGuid = 0,
	                  uint32_t durationOverrideMs = 0, float strength = 1.0f);
	void removeConditions(const std::vector<std::string>& keysOrTags);

	// Advance every active condition and apply what they owe. Call once per
	// movement tick from the owner's own update.
	void updateConditions(uint32_t elapsedMs);

	// This creature's 0..1 protection from a named condition; >= 1 is immunity.
	// The base answers from active conditions alone (<resist>); Player adds its
	// wearable, Agent its agents.xml <resistances>.
	virtual float conditionResistanceFor(const std::string& key) const
	{
		return conditions.resistanceTo(key);
	}

	// Is this creature forbidden from doing something right now? One spelling
	// for every gate, so a new control bit cannot be honoured in three places
	// and forgotten in a fourth.
	bool cannot(ConditionControl what) const { return conditions.totals().forbids(what); }

	uint8_t getMoveMask() const { return moveMask; }
	void setMoveMask(uint8_t mask) { moveMask = mask; }

	virtual bool canSee(const Position&) const { return true; }
	virtual bool canSeeCreature(const Creature*) const { return true; }

	Tile* getTile() override;
	const Tile* getTile() const override;

	void buildUpdate(EntityUpdate& out) const override;
	void buildRemoval(EntityUpdate& out) const override;

protected:
	// Scale getTileSpeedDelta applies to one triggered object's SLOW (negative
	// changeSpeed) for THIS creature; boosts are never scaled. Base: face
	// value for everyone. Agent overrides it to halve an own-side trap's slow
	// (user rule 2026-07-27); players always take the configured effect.
	virtual float tileSlowScaleFor(const Object*) const { return 1.0f; }

	// One gauge delta a condition owes this creature. A player has all five
	// gauges; an agent has only a health pool and ignores the rest. Called
	// AFTER the walk over the active set is finished, so it is free to kill the
	// creature -- and on a player, to resurrect it and rewrite the whole set.
	virtual void applyConditionTick(GaugeSlot slot, int16_t amount, uint32_t inflictorGuid) = 0;

	// The set's membership or a stage changed: re-derive anything cached off it.
	virtual void onConditionsChanged() {}

	// One condition was just applied successfully. Distinct from
	// onConditionsChanged, which also fires on expiry and on a cure: this is
	// specifically "somebody dosed this creature with THIS", which is the only
	// thing a repellent's grudge-clearing can hang off.
	virtual void onConditionApplied(const ConditionData*) {}

	// A stage that declared <visuals endSkin=> has expired. Player-only in
	// practice -- an agent has no drug skin -- but it rides the shared tick.
	virtual void onConditionStageEnd(StageEndSkin) {}

	// Called once before a batch of collected ticks is applied, so a subclass can
	// snapshot whatever conditionTicksShouldContinue compares against.
	virtual void beginConditionTicks() {}

	// True while this creature's life has not ended during the current tick
	// application. A player can be resurrected mid-tick, which wipes the very
	// conditions the remaining ticks came from; an agent simply dies.
	virtual bool conditionTicksShouldContinue() const { return true; }

	ConditionSet conditions;

	Position position;
	Position lastPosition;
	float visualX = 0.0f;
	float visualY = 0.0f;
	bool visualInit = false;
	uint8_t rotation = 0;
	uint8_t lastRotation = 0;
	
	uint16_t lookType = 0;
	uint16_t lastLookType = 0;
	uint8_t skin = 0;
	uint8_t lastSkin = 0;
	uint8_t ghoul = 0;
	uint8_t lastGhoul = 0;
	uint16_t heldItemIID = 0;
	uint16_t lastHeldItemIID = 0;

	uint16_t speed = 0;
	uint16_t lastSpeed = 0;
	uint8_t moveMask = 0;

	uint32_t referenceCounter = 0;
	uint32_t id = 0;

	friend class Game;
	friend class Map;
};

#endif // FS_CREATURE_H
