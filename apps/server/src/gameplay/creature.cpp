// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/creature.h"

#include "content/configmanager.h"
#include "gameplay/game.h"
#include "core/scheduler.h"
#include "world/map.h"
#include "gameplay/object.h"

#include <cmath>

extern Game g_game;

Creature::Creature() = default;

Creature::~Creature() = default;

// Deliberately NOT condition-modified, and the asymmetry with Player::getSpeed
// is load-bearing. For a player this IS the movement input -- Game::updateMovement
// divides it into a per-tick step -- so a slow belongs there. For an agent
// `speed` is the WIRE speed, a MEASUREMENT of how far the last step actually
// carried it, written by stepAgent after the fact. Scaling that would report a
// number the agent is not moving at, and slow nothing at all. An agent's slow
// lives in Agent::getMoveSpeed, which is its real input.
uint16_t Creature::getSpeed() const
{
	return static_cast<uint16_t>(std::max<int32_t>(10, speed + getTileSpeedDelta()));
}

bool Creature::addCondition(const std::string& key, uint32_t inflictorGuid,
                            uint32_t durationOverrideMs, float strength)
{
	const ConditionData* data = ConditionManager::getInstance().getEffectData(key);
	if (!data) return false;

	if (!conditions.add(data, inflictorGuid, conditionResistanceFor(key),
	                    durationOverrideMs, strength)) {
		return false;
	}
	onConditionApplied(data);
	onConditionsChanged();
	return true;
}

void Creature::removeConditions(const std::vector<std::string>& keysOrTags)
{
	if (conditions.remove(keysOrTags)) {
		onConditionsChanged();
	}
}

void Creature::updateConditions(uint32_t elapsedMs)
{
	// The result is a plain local: an empty tick list costs no allocation, so
	// the overwhelmingly common "nothing is active" case pays for nothing, and a
	// reused static would be corrupted outright if a tick re-entered here.
	ConditionSet::UpdateResult result;
	conditions.update(elapsedMs, result);

	if (result.endSkin != StageEndSkin::Unchanged) {
		onConditionStageEnd(result.endSkin);
	}

	// Applied only now that nothing holds an iterator into the active set: a
	// lethal tick can kill and resurrect this creature, and a resurrection
	// rewrites that very container.
	if (!result.ticks.empty()) {
		beginConditionTicks();
	}
	for (const ConditionSet::Tick& tick : result.ticks) {
		applyConditionTick(tick.slot, tick.amount, tick.inflictorGuid);
		// This life ended. The conditions the remaining ticks came from have
		// been wiped, so their damage must not be carried onto the new life --
		// and for an agent, `this` may already be gone.
		if (!conditionTicksShouldContinue()) {
			return;
		}
	}

	if (result.changed) {
		onConditionsChanged();
	}
}

int32_t Creature::getTileSpeedDelta() const
{
	int32_t delta = 0;
	const Tile* tile = getTile();
	if (tile) {
		for (Thing* t : tile->getThings()) {
			// getObject(), not dynamic_cast. This is reached from
			// Creature::isDirty() via getSpeed(), which the visibility diff asks
			// once per OBSERVER per entity -- ~62,500 times a tick at 250
			// clients -- and each call walked the whole tile doing an MSVC RTTI
			// string-compare per thing on it. Same vtable-slot pattern as every
			// other tile scan here; see the comment on Thing::getObject.
			if (const Object* obj = t->getObject()) {
				const ObjectData* od = obj->getData();
				if (od && od->onStepIn.enabled && od->onStepIn.changeSpeed != 0 && !obj->isDestroyed) {
					if (obj->isTriggered) {
						int32_t contribution = od->onStepIn.changeSpeed;
						if (contribution < 0) {
							// Slows only: a boost is never discounted.
							contribution = static_cast<int32_t>(std::lround(
								static_cast<float>(contribution) * tileSlowScaleFor(obj)));
						}
						delta += contribution;
					}
				}
			}
		}
	}
	return delta;
}

Tile* Creature::getTile()
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

const Tile* Creature::getTile() const
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

void Creature::buildUpdate(EntityUpdate& out) const
{
	// Fetch the player pointer once for reuse in all branches below
	const Player* p = getPlayer();

	if (getType() == CREATURETYPE_PLAYER) {
		if (p) {
			out.pid = static_cast<uint8_t>(p->getGUID());
			out.id = 0;
			// Bits 8-15: Held Item IID, Bits 0-7: Wearable Skin ID
			out.extra = static_cast<uint16_t>((p->getHeldItemIID() << 8) | (p->getSkin() & 0xFF));
		}
	}
	else if (getType() == CREATURETYPE_MONSTER) {
		out.id = static_cast<ClientEntityId>(getID() & CLIENT_ENTITY_ID_MASK);
		out.extra = getLookType();
	}

	uint16_t speedByte = getSpeed() / 10;
	uint16_t stateVal = (speedByte << 8) | 1;

	if (p) {
		// Bit 1 (2): Weapon Swing Trigger (Pulse)
		if (p->attackPulse) {
			stateVal |= 2;
		}
		// Bit 2 (4): Hand-to-Mouth Animation (Continuous)
		if (p->isConsuming) {
			stateVal |= 4;
		}
	}

	out.state = stateVal;

	out.rotation = getRotation();
	out.type = getType();
	out.startX = static_cast<uint16_t>(getLastPosition().x);
	out.startY = static_cast<uint16_t>(getLastPosition().y);
	out.endX = static_cast<uint16_t>(getPosition().x);
	out.endY = static_cast<uint16_t>(getPosition().y);

	// out.extra is set above for Players/Monsters
}

void Creature::buildRemoval(EntityUpdate& out) const
{
	buildUpdate(out);
	// state 0 + extra = the keepInCache flag, never the look bits buildUpdate
	// packed there. See EntityUpdate::makeRemoval.
	out.makeRemoval();

	out.startX = static_cast<uint16_t>(getPosition().x);
	out.startY = static_cast<uint16_t>(getPosition().y);
	out.endX = out.startX;
	out.endY = out.startY;
}
