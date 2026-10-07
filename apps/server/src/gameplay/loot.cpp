// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/loot.h"
#include "gameplay/game.h"
#include "core/tools.h"

extern Game g_game;

Loot::Loot(uint16_t lootId, uint16_t itemIid, uint8_t count, const ItemState& state, const Position& spawnPos) :
	lootId(lootId), itemIid(itemIid), count(count), state(state), spawnPosition(spawnPos), spawnTime(OTSYS_TIME()) {}

void Loot::setTaken(bool taken)
{
	if (isTakenVal == taken) {
		return;
	}

	isTakenVal = taken;
	takenTime = taken ? OTSYS_TIME() : 0;
}

Tile* Loot::getTile()
{
	return const_cast<Tile*>(const_cast<const Loot*>(this)->getTile());
}

const Tile* Loot::getTile() const
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

void Loot::buildUpdate(EntityUpdate& out) const
{
	out.pid = 0;
	out.rotation = 0;
	out.type = 1; // __ENTITIE_LOOT__
	
	// upper byte = hit (who took it), lower byte = 1 (active)
	uint16_t stateVal = (static_cast<uint16_t>(attackerPid) << 8) | 1;
	
	out.state = stateVal;
	out.id = getId16();

	// If spawned recently, send glide from spawnPos to landingPos
	if (OTSYS_TIME() - spawnTime < LOOT_GLIDE_WINDOW_MS) {
		out.startX = static_cast<uint16_t>(spawnPosition.x);
		out.startY = static_cast<uint16_t>(spawnPosition.y);
	} else {
		out.startX = static_cast<uint16_t>(position.x);
		out.startY = static_cast<uint16_t>(position.y);
	}
	
	out.endX = static_cast<uint16_t>(position.x);
	out.endY = static_cast<uint16_t>(position.y);
	
	out.extra = lootId;
}

void Loot::buildRemoval(EntityUpdate& out) const
{
	buildUpdate(out);
	// Deliberately NOT makeRemoval(): ground loot fades out (client.js _Loots)
	// however it leaves, picked up or not, so the keepInCache flag is stated as
	// 1 unconditionally rather than taken from isDestruction. Everything else
	// must go through makeRemoval -- see the note on it.
	out.state = 0;
	out.extra = 1;
	out.isDestruction = true;
}

Loot* LootManager::createLoot(uint16_t lootId, uint16_t itemIid, uint8_t count, const ItemState& state, const Position& spawnPos, const Position& landingPos)
{
	if (count == 0) return nullptr;
	// Named before it is built: on exhaustion there is nothing to clean up.
	const uint32_t uid = g_game.map.acquireEntityId(EntityClass::Loot);
	if (uid == 0) {
		if (!warnedExhausted) {
			warnedExhausted = true;
			fmt::print(fg(fmt::color::yellow),
				">> [Warning] No entity id available for ground loot ({} live). No more will "
				"spawn until some is picked up or despawns. Set lootDespawnSeconds > 0, or "
				"raise entityIdCapLoot in config.lua.\n",
					g_game.map.getEntityIdPool().liveCount(EntityClass::Loot));
		}
		return nullptr;
	}
	warnedExhausted = false;

	Loot* loot = new Loot(lootId, itemIid, count, state, spawnPos);
	loot->setPosition(landingPos);
	loot->setID(uid);
	return loot;
}
