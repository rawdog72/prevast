// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/object.h"
#include "gameplay/agent.h"
#include "gameplay/game.h"
#include "world/collision.h"
#include "core/scheduler.h"
#include "gameplay/loot.h"
#include "gameplay/player.h"
#include "gameplay/resource.h"
#include "network/opcodes.h"
#include "core/tools.h"
#include "world/worldgen.h"
#include "content/xml_utils.h"
#include <algorithm>
#include <fmt/format.h>
#include <fmt/color.h>

ObjectManager g_objects;
extern Game g_game;

// A damaging trap shakes the screen at most this often (see executeTrigger).
static constexpr uint64_t TRAP_SHAKE_INTERVAL_MS = 1000;

// --- Object Entity ---

Object::Object(const std::string& key) : key(key)
{
	// Resolved once here rather than per lookup: the environment scan asks every
	// nearby object what it emits, per player, per tick. See Object::getData().
	data = g_objects.getObjectData(this->key);

	// Game::updateStations indexes up to STATION_QUEUE_SIZE.
	queue.resize(STATION_QUEUE_SIZE);
}

Tile* Object::getTile()
{
	return const_cast<Tile*>(const_cast<const Object*>(this)->getTile());
}

const Tile* Object::getTile() const
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

void Object::executeTrigger(const TriggerAction& trigger, Creature* target)
{
	if (!trigger.enabled || !target) return;

	if (trigger.damage > 0) {
		if (Player* p = target->getPlayer()) {
			Player* attacker = g_game.getPlayerByGUID(getOwnerPid());
			p->changeHealth(-trigger.damage, true, false, false, "", attacker);
			// A jolt as the trap bites -- at most once a second. A spike deals
			// its damage every 100 ms, and a 10-frame shake restarted that often
			// never stopped: the screen shook violently the whole time.
			p->sendTrapShake(OTSYS_TIME(), TRAP_SHAKE_INTERVAL_MS);
		} else if (Agent* a = target->getAgent()) {
			// Deferred by id: a lethal hit deletes the agent, and this runs
			// mid-step from the tile-crossing loop. Ambient keeps the 10Hz
			// DoT from strobing the hurt pulse.
			uint32_t agentId = a->getID();
			uint32_t attackerCharacterId = ownerCharacterId;
			int16_t dmg = trigger.damage;
			g_dispatcher.addTask([agentId, attackerCharacterId, dmg]() {
				if (Thing* t = g_game.getThingByID(agentId)) {
					if (Agent* ag = t->getAgent()) {
						ag->changeHealth(-dmg, 0, g_game.getPlayerByID(attackerCharacterId), true);
					}
				}
			});
		}
	} else if (trigger.heal > 0) {
		if (Player* p = target->getPlayer()) {
			p->changeHealth(trigger.heal);
		}
	}

	if (trigger.detonate && !isDestroyed) {
		// Deferred by id, never inline: this runs from the movement path's
		// tile-leave loop, where the mover is off the tile index (a broadcast
		// or splash sweep cannot find them) and where inline destruction would
		// erase this object from the tile list mid-iteration.
		uint32_t objId = getID();
		g_dispatcher.addTask([objId]() {
			if (Thing* t = g_game.getThingByID(objId)) {
				if (Object* o = t->getObject()) {
					o->detonate();
				}
			}
		});
	}
}

uint32_t Object::getOwnerPid() const
{
	if (ownerPid == 0) return 0;
	const Player* owner = g_game.getPlayerByID(ownerCharacterId);
	// UINT32_MAX denotes an abandoned owned object, not a public/world object.
	return owner ? owner->getGUID() : std::numeric_limits<uint32_t>::max();
}

void Object::setOwnerPid(uint32_t pid)
{
	const ObjectData* od = g_objects.getObjectData(key);
	const bool listens = od && !od->remoteChannel.empty();

	// Re-owning is not a thing today, but leaving the old entry behind would
	// hand the previous owner a detonator for someone else's charge.
	if (listens && ownerPid != 0 && ownerPid != pid) {
		g_game.noteRemoteObjectGone(ownerPid, getID());
	}

	ownerPid = pid;
	Player* owner = g_game.getPlayerByGUID(pid);
	ownerCharacterId = owner ? owner->getID() : 0;

	// Unowned charges (world spawns, ruins) stay off the registry: nobody holds
	// their detonator, and they still work as ordinary destructible explosives.
	if (listens && pid != 0) {
		g_game.noteRemoteObjectPlaced(pid, getID());
	}
}

void Object::detonate()
{
	// Attacker credit resolved at fire time: the owner may be gone by now.
	// int32: health is a uint16, and -static_cast<int16_t>(40000) is a heal.
	changeHealth(-static_cast<int32_t>(health), 0, g_game.getPlayerByGUID(getOwnerPid()));
}

ObjectOwner Object::ownerRelationTo(const Player* player) const
{
	if (ownerPid == 0) return ObjectOwner::None;
	const uint32_t owner = getOwnerPid();
	if (player && owner == player->getGUID()) return ObjectOwner::Self;
	if (player && owner != std::numeric_limits<uint32_t>::max() && g_game.isOwnerOrClanmate(owner, player)) return ObjectOwner::Clan;
	return ObjectOwner::Other;
}

bool Object::isTeammateOrOwner(Creature* target) const
{
	// Delegates to the single definition of "same side", which agent targeting
	// also uses -- a bot that spares someone this door would not would be the
	// same bug reported twice.
	return target && g_game.isOwnerOrClanmate(getOwnerPid(), target->getPlayer());
}

bool Object::canBeTriggeredBy(Creature* c) const
{
	if (!c) return false;

	// The stepper's controlling side: the player themself, or a bot's owner.
	// A world agent (ownerGuid 0) has no side, so it trips even world traps.
	const Player* side = c->getPlayer();
	if (!side) {
		if (Agent* a = c->getAgent()) {
			side = g_game.getPlayerByGUID(a->getOwnerGuid());
		}
	}

	// isOwnerOrClanmate is false for a world trap (getOwnerPid() 0) and for a null
	// side, so both of those trigger on everything.
	return !g_game.isOwnerOrClanmate(getOwnerPid(), side);
}

void Object::onCreatureEnter(Creature* c)
{
	if (!c || isDestroyed) return;

	const ObjectData* od = g_objects.getObjectData(key);
	if (!od) return;

	if (od->onStepIn.enabled) {
		if (!isTriggered) {
			if (!canBeTriggeredBy(c)) return;

			isTriggered = true;

			if (od->lifetimeMs > 0 && od->startLifetimeOnTrigger) {
				uint32_t objId = getID();
				uint32_t lifetimeMs = od->lifetimeMs;
				g_scheduler.addEvent(createSchedulerTask(lifetimeMs, [objId]() {
					g_dispatcher.addTask([objId]() {
						if (Thing* t = g_game.getThingByID(objId)) {
							if (Object* o = t->getObject()) {
								g_game.expireObject(o);
							}
						}
					});
				}));
			}

			EntityUpdate update;
			buildUpdate(update);
			g_game.broadcastSurgicalUpdate(update, getPosition());
		}

		executeTrigger(od->onStepIn, c);

		if (od->onStepIn.intervalMs > 0 && !isDestroyed) {
			activeTriggers[c->getID()] = OTSYS_TIME() + od->onStepIn.intervalMs;
			g_game.activeTriggerObjects.insert(this);
		}
	}
}

void Object::onCreatureLeave(Creature* c)
{
	if (!c || isDestroyed) return;

	const ObjectData* od = g_objects.getObjectData(key);
	if (!od) return;

	if (od->onStepOut.enabled) {
		if (!canBeTriggeredBy(c)) return;

		executeTrigger(od->onStepOut, c);
	}

	activeTriggers.erase(c->getID());
}

void Object::updateTriggers(uint64_t currentTimeMs)
{
	if (isDestroyed || activeTriggers.empty()) return;

	const ObjectData* od = g_objects.getObjectData(key);
	if (!od || !od->onStepIn.enabled || od->onStepIn.intervalMs == 0) return;

	std::vector<uint32_t> toRemove;

	for (auto& pair : activeTriggers) {
		if (currentTimeMs >= pair.second) {
			Thing* thing = g_game.getThingByID(pair.first);
			Creature* c = thing ? thing->getCreature() : nullptr;
			if (c) {
				// Re-verify they are still on the exact tile
				int32_t cx = c->getPosition().x / TILE_SIZE;
				int32_t cy = c->getPosition().y / TILE_SIZE;
				int32_t ox = position.x / TILE_SIZE;
				int32_t oy = position.y / TILE_SIZE;
				
				if (cx == ox && cy == oy) {
					if (!isTriggered) {
						continue;
					}

					executeTrigger(od->onStepIn, c);
					pair.second = currentTimeMs + od->onStepIn.intervalMs; // Schedule next
				} else {
					toRemove.push_back(pair.first);
				}
			} else {
				toRemove.push_back(pair.first); // Creature vanished
			}
		}
	}

	for (uint32_t id : toRemove) {
		activeTriggers.erase(id);
	}
}

void Object::addToQueue(uint16_t iid, uint16_t yield, uint32_t timeMs, std::vector<std::pair<uint16_t, uint8_t>>&& ingredients)
{
	for (auto& slot : queue) {
		if (slot.iid == 0) {
			slot.iid = iid;
			slot.yield = yield;
			slot.totalTimeMs = timeMs;
			slot.progressMs = 0;
			slot.ingredients = std::move(ingredients);
			return;
		}
	}
}

void Object::removeFromQueue(uint8_t slot)
{
	if (slot < queue.size()) {
		std::move(queue.begin() + slot + 1, queue.end(), queue.begin() + slot);
		queue.back() = QueueItem{};
	}
}

void Object::executeExplosion(const ObjectExplosion& exp, Player* attacker)
{
	if (!exp.enabled) return;

	// Shared explosion logic. The exploding object itself is safe as a splash
	// target: its damage is applied deferred by ID, and by then this object is
	// destroyed and off the map. Unlike the old inline copy this also respects
	// player invincibility, matching projectile explosions.
	g_game.executeExplosion(position, exp.radius, exp.area, exp.playerDamage, exp.buildingDamage, exp.knockback, attacker ? attacker->getID() : 0, &exp.onHit);
}

// Shared destruction tail: removal broadcast, map removal, subtype refresh,
// and deferred deletion. Callers decide whether drops/explosions happen first.
void Object::finishDestruction(const ObjectData* od)
{
	// Unregister before the deferred delete: the trigger set must never hold
	// a pointer to a destroyed (soon freed) object.
	g_game.activeTriggerObjects.erase(this);
	g_game.noteLogicObjectGone(this);   // circuit solver holds raw pointers too
	g_game.noteObjectRepaired(getID()); // nothing left to repair
	if (getOwnerPid() != 0 && od && !od->remoteChannel.empty()) {
		g_game.noteRemoteObjectGone(getOwnerPid(), getID()); // no longer detonable
	}

	EntityUpdate removal;
	removal.isDestruction = true;
	buildRemoval(removal);
	g_game.broadcastSurgicalUpdate(removal, position);

	g_game.map.removeThing(this);

	if (key == "road" || (od && od->isFloor)) {
		g_game.updateSubtypes(position);
	}

	g_scheduler.addEvent(createSchedulerTask(10, [this]() {
		g_dispatcher.addTask([this]() {
			delete this;
		});
	}));
}

void Object::removeSilently()
{
	if (isDestroyed) return;

	health = 0;
	isDestroyed = true;
	finishDestruction(g_objects.getObjectData(key));
}

uint16_t Object::getMaxHealth() const
{
	if (healthMaxOverride != 0) return healthMaxOverride;
	return data ? data->healthMax : 0;
}

int32_t Object::changeHealth(int32_t healthDelta, uint8_t angle, Player* attacker)
{
	if (isDestroyed) return 0;
	if (healthDelta < 0 && indestructible) return 0;

	const ObjectData* od = g_objects.getObjectData(key);
	const uint16_t oldHealth = health;

	if (healthDelta >= 0) {
		const int32_t ceiling = od ? static_cast<int32_t>(getMaxHealth()) : MAX_DAMAGE_AMOUNT;
		health = static_cast<uint16_t>(std::min<int32_t>(ceiling, health + healthDelta));

		if (healthDelta > 0) {
			impactAngle = angle;
			EntityUpdate update;
			buildUpdate(update);
			update.state |= 2; // Trigger client shake
			g_game.broadcastSurgicalUpdate(update, position);
		}

		// Back to full: repair bots stop being interested (see Game::damagedObjects).
		if (od && health >= getMaxHealth()) {
			g_game.noteObjectRepaired(getID());
		}
		return static_cast<int32_t>(health) - static_cast<int32_t>(oldHealth);
	} else {
		const uint32_t damage = static_cast<uint32_t>(-healthDelta);
		if (damage >= health) {
			health = 0;
			isDestroyed = true;
			// Destruction
			if (od) {

				if (od->explosion.enabled) {
					executeExplosion(od->explosion, attacker);
				}

				// Everything the object held spreads round it in one burst,
				// starting just outside its footprint.
				const float dropRadius = (std::max(od->width, od->height) / 2.0f) + 20.0f;
				std::vector<Game::LootDrop> drops;

				// 1. Drop XML defined loot
				for (const auto& drop : od->drops) {
					// iid comes straight off the drop now. It used to be
					// recovered from lootId by reverse lookup on every
					// destruction, because only lootId was stored.
					if (drop.iid == 0 || !drop.rollChance()) continue;
					const uint8_t amount = drop.rollAmount();
					if (amount == 0) continue;
					drops.push_back({ drop.lootId, drop.iid, amount, ItemState::fresh(drop.iid) });
				}

				// 2. Eject Container Storage
				for (auto& item : storage) {
					if (item) {
						const ItemData* idata = ItemManager::getInstance().getItemData(item->getIID());
						if (idata) {
							drops.push_back({ idata->lootId, item->getIID(), item->getCount(), ItemState::of(*item) });
						}
					}
				}

				// 3. Eject Station Queue
				for (const auto& qItem : queue) {
					if (qItem.iid != 0) {
						if (qItem.progressMs >= qItem.totalTimeMs) {
							// Finished item
							const ItemData* idata = ItemManager::getInstance().getItemData(qItem.iid);
							if (idata) {
								drops.push_back({ idata->lootId, qItem.iid, 1, ItemState::fresh(qItem.iid) });
							}
						} else {
							// Unfinished: Return ingredients
							for (const auto& ing : qItem.ingredients) {
								const ItemData* idata = ItemManager::getInstance().getItemData(ing.first);
								if (idata) {
									drops.push_back({ idata->lootId, ing.first, ing.second, ItemState::fresh(ing.first) });
								}
							}
						}
					}
				}

				g_game.dropLootBurst(position, drops, dropRadius);
			}

			if (attacker) {
				GameEvent destroyed{EventType::Destroy, attacker, key};
				destroyed.owner = ownerRelationTo(attacker);
				g_events.emit(destroyed);
			}
			finishDestruction(od);
			// Taken from oldHealth, not from `damage`: an overkill reports what
			// the object had left. oldHealth is a local, so this is safe after
			// finishDestruction whatever that does to `this`.
			return -static_cast<int32_t>(oldHealth);
		} else {
			health -= static_cast<uint16_t>(damage);
			impactAngle = angle;
			// Visual health stage update and hit animation
			EntityUpdate update;
			buildUpdate(update);
			update.state |= 2; // Trigger client shake
			g_game.broadcastSurgicalUpdate(update, position);

			// Advertise the damage so repair bots have something to find.
			if (od && getMaxHealth() > 0) {
				g_game.noteObjectDamaged(getID());
			}
			return -static_cast<int32_t>(damage);
		}
	}
}

uint8_t Object::getFuelByte() const
{
	if (fuelMs == 0) return 0;
	const ObjectData* od = g_objects.getObjectData(key);
	if (!od || od->fuelBurnMs == 0) return static_cast<uint8_t>(std::min<uint32_t>(254, fuelMs / 1000));
	
	uint32_t units = (fuelMs + od->fuelBurnMs - 1) / od->fuelBurnMs;
	return static_cast<uint8_t>(std::min<uint32_t>(254, units)); 
}

bool Object::hasCollision() const
{
	const ObjectData* od = g_objects.getObjectData(key);
	if (!od || !od->collision) return false;
	if (key == "automatic_door" && isDoorOpen) return false;
	return true;
}

bool Object::blocksProjectiles() const
{
	const ObjectData* od = g_objects.getObjectData(key);
	if (!od || !od->blocksProjectiles) return false;
	if (key == "automatic_door" && isDoorOpen) return false;
	return true;
}

bool Object::getCollisionRect(CollisionRect& rect) const
{
	const ObjectData* od = g_objects.getObjectData(key);
	if (!od || !od->collision || od->radius > 0) {
		return false;
	}

	// 1. Calculate Rotated Dimensions
	float w = static_cast<float>(od->width);
	float h = static_cast<float>(od->height);
	if (rotation == 1 || rotation == 3) {
		std::swap(w, h);
	}
	rect.halfWidth = w / 2.0f;
	rect.halfHeight = h / 2.0f;

	// 2. Resolve Aligned Position (Tile corner to World space)
	float relX = 50.0f;
	float relY = 50.0f;

	if (od->alignType != AlignType::NONE) {
		uint8_t baseEdge = static_cast<uint8_t>(od->alignType) - 1; 
		uint8_t currentEdge = (baseEdge + rotation) % 4;

		if (currentEdge == 0)      relY = 100.0f - rect.halfHeight; // Snap Bottom
		else if (currentEdge == 1) relX = rect.halfWidth;           // Snap Left
		else if (currentEdge == 2) relY = rect.halfHeight;          // Snap Top
		else if (currentEdge == 3) relX = 100.0f - rect.halfWidth;  // Snap Right
	}

	// Convert Tile-Relative to World-Space
	float posX = static_cast<float>(position.x);
	float posY = static_cast<float>(position.y);
	rect.x = (posX - 50.0f) + relX;
	rect.y = (posY - 50.0f) + relY;

	// 3. Handle Door State Swings
	if (isDoorOpen) {
		if (od->blocksProjectiles) {
			// Big Door: Diagonal Corner Shift (Restored)
			int32_t jMove[4] = { -100, -100, 100, 100 };
			int32_t iMove[4] = { 100, -100, -100, 100 };
			uint8_t rot = rotation & 0x03;
			rect.x += static_cast<float>(jMove[rot]);
			rect.y += static_cast<float>(iMove[rot]);
		} else {
			// Small Door: Pivot 90 deg around hinge
			float pivotOffset = (100.0f - std::min(static_cast<float>(od->width), static_cast<float>(od->height))) / 2.0f;
			if (rotation == 0) {
				rect.x = posX - pivotOffset;
				rect.y = posY + 100.0f;
			} else if (rotation == 1) {
				rect.x = posX - 100.0f;
				rect.y = posY - pivotOffset;
			} else if (rotation == 2) {
				rect.x = posX + pivotOffset;
				rect.y = posY - 100.0f;
			} else if (rotation == 3) {
				rect.x = posX + 100.0f;
				rect.y = posY + pivotOffset;
			}
			std::swap(rect.halfWidth, rect.halfHeight);
		}
	}

	return true;
}

float Object::getCollisionRadius() const
{
	const ObjectData* od = g_objects.getObjectData(key);
	if (od && od->collision && od->radius > 0) {
		return static_cast<float>(od->radius);
	}
	return 0.0f;
}

void Object::buildUpdate(EntityUpdate& out) const
{
	const ObjectData* rd = g_objects.getObjectData(key);
	if (!rd) return;

	// Objects are world entities: pid 0, addressed by id16 alone like world-gen
	// structures. Sending getOwnerPid() aliased player-built objects on the client's
	// flat cache (same class as the ghost-loot bug) and leaked ownership to every
	// client. Server-side getOwnerPid() still drives placement/trigger rules; the wire
	// never needs it. See AI_REFACTORING_NOTES.
	out.pid = 0;
	out.rotation = 0; // Stations/structures use fixed rotation in extra field
	
	// Set protocol type from pre-calculated ID
	out.type = rd->protocolType;
	
	// Calculate Health/Destruction Stage (Bits 14-15 of state)
	uint16_t stateVal = 1; // Base active state

	if (const uint32_t maxHealth = getMaxHealth(); maxHealth > 0) {
		// health*100 <= pct*healthMax, not (health*100)/healthMax <= pct: the
		// division truncates, so 751/3000 (25.03%) would read as 25 and drop a
		// wall to the wrong sprite one hit early. The EFFECTIVE maximum, so an
		// overridden wall shows its damage against its own health.
		const uint32_t scaledHealth = static_cast<uint32_t>(health) * 100;
		const auto atOrBelow = [&](uint8_t pct) {
			return scaledHealth <= static_cast<uint32_t>(pct) * maxHealth;
		};
		uint8_t brokeStage = 0;
		if (atOrBelow(rd->destructionStagePct[2])) brokeStage = 3;
		else if (atOrBelow(rd->destructionStagePct[1])) brokeStage = 2;
		else if (atOrBelow(rd->destructionStagePct[0])) brokeStage = 1;
		stateVal |= (static_cast<uint16_t>(brokeStage) << 14);
	}
	
	// Bit 4: In Use (Lid open animation or Door open, or Trap triggered)
	if (rd->interaction == InteractionKind::Door) {
		if (isDoorOpen) stateVal |= 16;
	} else if (activeUserPid != 0 || isTriggered) {
		stateVal |= 16;
	}

	// Bit 5: Working / Burning / Door Open Failed
	if (rd->interaction == InteractionKind::Door) {
		if (openFailedPulse) {
			stateVal |= 32;
			openFailedPulse = false;
		}
	} else {
		bool isWorking = false;
		if (!rd->fuelItemKey.empty()) {
			// Fuel-based objects work/burn continuously as long as they have fuel
			isWorking = (fuelMs > 0);
		} else {
			// Non-fuel objects work as long as they have an active craft
			for (const auto& slot : queue) {
				if (slot.iid != 0 && slot.progressMs < slot.totalTimeMs) {
					isWorking = true;
					break;
				}
			}
		}
		
		if (isWorking) {
			stateVal |= 32;
		}
	}

	// Client building update:
	//   subtype = (state >> 5) & 63   -- road/floor variant, NOT growth stage
	//   stage   = (state >> 4) & 15   -- what the plant/seed renderers index
	//   rotation = (extra >> 5) & 3
	//   item = INVENTORY[extra >> 7]
	if (rd->isLogicObject) {
		if (key == "switch") {
			if (logicState.switchOn) stateVal |= 16;
		} else if (key == "gate_timer") {
			stateVal |= (static_cast<uint16_t>(logicState.timerRateIndex & 3) << 4);
		} else if (key == "lamp") {
			if (logicState.powered) stateVal |= 128;
			stateVal |= (static_cast<uint16_t>(logicState.lampColorIndex & 7) << 4);
		} else if (key == "automatic_door") {
			if (isDoorOpen) stateVal |= 128;
		}
	} else if (!rd->stages.empty()) {
		// Growth stages ride bits 4-7: the client's plant/seed renderers index
		// building[(state >> 4) & 15]. The variant subtype at bits 5-10 is a
		// different field that staged objects never use. Clearing first because
		// bits 4 and 5 (in-use / working) were already considered above.
		stateVal &= ~static_cast<uint16_t>(0xF0);
		stateVal |= (static_cast<uint16_t>(this->subtype & 0x0F) << 4);
	} else {
		stateVal |= (static_cast<uint16_t>(this->subtype & 0x3F) << 5);
	}
	out.state = stateVal;
	
	out.id = getId16(); 
	
	out.startX = static_cast<uint16_t>(position.x);
	out.startY = static_cast<uint16_t>(position.y);
	out.endX = static_cast<uint16_t>(position.x);
	out.endY = static_cast<uint16_t>(position.y);
	
	out.extra = static_cast<uint16_t>((impactAngle & 0x1F) | ((rotation & 0x03) << 5) | ((rd->id & 0x1FF) << 7));
}

void Object::buildRemoval(EntityUpdate& out) const
{
	buildUpdate(out);
	// state 0 + extra = the keepInCache flag, never the look bits buildUpdate
	// packed there. See EntityUpdate::makeRemoval.
	out.makeRemoval();
}

// --- ObjectManager ---

bool ObjectManager::loadItemsFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	pugi::xml_parse_result result = doc.load_file(filename.c_str());

	if (!result) {
		fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, "[Error - ObjectManager::loadItemsFromXml] Failed to load {}: {}\n", filename, result.description());
		return false;
	}

	pugi::xml_node root = doc.child("items");
	if (!root) {
		fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold, "[Error - ObjectManager::loadItemsFromXml] Missing <items> root node.\n");
		return false;
	}

	for (pugi::xml_node itemNode = root.child("item"); itemNode; itemNode = itemNode.next_sibling("item")) {
		uint16_t id = itemNode.attribute("clientItemId").as_int();
		std::string key = itemNode.attribute("key").as_string();
		
		// Map the item key to its ID
		mapKeyToId[key] = id;
	}

	reportDataFile(filename, fmt::format("{} item id mappings", mapKeyToId.size()));
	return true;
}

static void parseTriggerDetonate(const pugi::xml_node& node, TriggerAction& trigger, const std::string& objKey)
{
	trigger.detonate = node.attribute("detonate").as_bool(false);
	if (node.child("explosion")) {
		trigger.detonate = true;
		fmt::print(">> [ObjectManager] '{}': <explosion> inside <{}> is deprecated; use detonate=\"true\" and define the blast in <onDestroy>.\n", objKey, node.name());
	}
}

// An unrecognised type is LogicType::None: the object still counts as a logic
// object (it renders and connects) but drives nothing, which is what an
// unknown string did before.
static LogicType parseLogicType(const std::string& str) {
	static const std::unordered_map<std::string, LogicType> types = {
		{"cable", LogicType::Cable},
		{"bridge", LogicType::Bridge},
		{"switch", LogicType::Switch},
		{"timer", LogicType::Timer},
		{"lamp", LogicType::Lamp},
		{"sink", LogicType::Sink},
		{"platform_source", LogicType::PlatformSource},
		{"gate_and", LogicType::GateAnd},
		{"gate_or", LogicType::GateOr},
		{"gate_not", LogicType::GateNot},
		{"gate_xor", LogicType::GateXor},
	};
	auto it = types.find(str);
	return it != types.end() ? it->second : LogicType::None;
}

// Unknown names return Other/None and the caller warns; an object with no
// attribute at all keeps whatever <base> gave it, which is why the caller only
// calls these when the attribute is present.
static ObjectCategory parseObjectCategory(const std::string& str) {
	static const std::unordered_map<std::string, ObjectCategory> categories = {
		{"plant", ObjectCategory::Plant},
		{"spawner", ObjectCategory::Spawner},
		{"station", ObjectCategory::Station},
		{"wall", ObjectCategory::Wall},
		{"container", ObjectCategory::Container},
		{"floor", ObjectCategory::Floor},
		{"road", ObjectCategory::Road},
		{"resurection", ObjectCategory::Resurection},
		{"trap", ObjectCategory::Trap},
		{"explosives", ObjectCategory::Explosives},
		{"logic", ObjectCategory::Logic},
		{"furniture", ObjectCategory::Furniture},
	};
	auto it = categories.find(str);
	return it != categories.end() ? it->second : ObjectCategory::Other;
}

static InteractionKind parseInteractionKind(const std::string& str) {
	static const std::unordered_map<std::string, InteractionKind> kinds = {
		{"station", InteractionKind::Station},
		{"door", InteractionKind::Door},
		{"container", InteractionKind::Container},
		{"switch", InteractionKind::Switch},
	};
	auto it = kinds.find(str);
	return it != kinds.end() ? it->second : InteractionKind::None;
}

static uint8_t parseSideMask(const std::string& str) {
	uint8_t mask = 0;
	for (char c : str) {
		if (c == 'T' || c == 't') mask |= 1;      // TOP
		else if (c == 'R' || c == 'r') mask |= 2; // RIGHT
		else if (c == 'B' || c == 'b') mask |= 4; // BOTTOM
		else if (c == 'L' || c == 'l') mask |= 8; // LEFT
	}
	return mask;
}

// <stages>: a plant's growth chain, or any object that becomes something else
// over time. Each stage may produce on harvest, drop loot, or replace the object
// with a resource/object/creature.
static void parseStages(const pugi::xml_node& stagesNode, ObjectData& od, const std::string& filename)
{
	od.stages.clear();
	for (pugi::xml_node stageNode = stagesNode.child("stage"); stageNode; stageNode = stageNode.next_sibling("stage")) {
		ObjectStage stage;
		// Stages go out in 4 bits, so ids above 15 have no sprite to land
		// on -- the client would index past building[] and throw mid-frame.
		const unsigned int rawStageId = stageNode.attribute("id").as_uint();
		if (rawStageId > 15) {
			reportDataWarning(filename, fmt::format(
				"object '{}' stage id {} exceeds the 15 the client can render; clamped",
				od.key, rawStageId));
		}
		stage.id = static_cast<uint8_t>(std::min(15u, rawStageId));
		stage.durationMs = stageNode.attribute("durationMs").as_uint(0);
		stage.next = static_cast<int16_t>(stageNode.attribute("next").as_int(-1));

		stage.harvestable = stageNode.attribute("harvestable").as_bool(false);
		if (stage.harvestable) {
			const ItemData* produceData = ItemManager::getInstance().getItemData(stageNode.attribute("produceItemKey").as_string());
			if (produceData) {
				stage.produce.iid = produceData->id;
				stage.produce.min = static_cast<uint8_t>(stageNode.attribute("produceMin").as_uint(1));
				stage.produce.max = static_cast<uint8_t>(std::max(stageNode.attribute("produceMax").as_uint(stage.produce.min), static_cast<uint32_t>(stage.produce.min)));
				stage.produce.perStack = 1; // harvested produce drops as single-item loot entities
			} else {
				reportDataWarning(filename, fmt::format("object '{}' stage {} produces unknown item key '{}'",
					od.key, stage.id, stageNode.attribute("produceItemKey").as_string()));
				stage.harvestable = false;
			}
			stage.postHarvestStage = static_cast<int16_t>(stageNode.attribute("postHarvestStage").as_int(-1));
		}

		if (pugi::xml_attribute lootAttr = stageNode.attribute("spawnLoot")) {
			const ItemData* lootData = ItemManager::getInstance().getItemData(lootAttr.as_string());
			if (lootData) {
				stage.spawnLoot.iid = lootData->id;
				stage.spawnLoot.min = static_cast<uint8_t>(stageNode.attribute("lootMin").as_uint(1));
				stage.spawnLoot.max = static_cast<uint8_t>(std::max(stageNode.attribute("lootMax").as_uint(stage.spawnLoot.min), static_cast<uint32_t>(stage.spawnLoot.min)));
				stage.spawnLoot.perStack = static_cast<uint8_t>(std::max(1u, stageNode.attribute("lootPerStack").as_uint(1)));
			} else {
				reportDataWarning(filename, fmt::format("object '{}' stage {} spawns unknown loot item key '{}'",
					od.key, stage.id, lootAttr.as_string()));
			}
		}

		stage.spawnResource = stageNode.attribute("spawnResource").as_string();
		stage.spawnObject = stageNode.attribute("spawnObject").as_string();

		stage.spawnCreature = stageNode.attribute("spawnCreature").as_string();
		if (!stage.spawnCreature.empty()) {
			stage.spawnCreatureCount = static_cast<uint8_t>(
				std::clamp(stageNode.attribute("spawnCreatureCount").as_uint(1), 1u, 255u));

			// All three consume the object, so a stage naming more than one
			// of them is asking it to become two different things.
			if (!stage.spawnResource.empty() || !stage.spawnObject.empty()) {
				reportDataWarning(filename, fmt::format(
					"object '{}' stage {} has spawnCreature together with "
					"spawnResource/spawnObject; all three replace the object, ignoring spawnCreature",
					od.key, stage.id));
				stage.spawnCreature.clear();
			}
		}

		od.stages.push_back(stage);
	}
}

// <logic>: cables, gates, switches and the rest of the wiring layer. The four
// rot masks are the sides that connect at each rotation.
static void parseLogic(const pugi::xml_node& logicNode, ObjectData& od, const std::string& filename)
{
	od.isLogicObject = true;
	const std::string logicTypeStr = logicNode.attribute("type").as_string();
	od.logicType = parseLogicType(logicTypeStr);
	if (od.logicType == LogicType::None) {
		reportDataWarning(filename, fmt::format("object '{}' has unknown logic type '{}'", od.key, logicTypeStr));
	}

	// Spelled out rather than looped over a format string: tools/check_xml_vocabulary.py
	// derives the known attribute set from attribute("literal") occurrences, and a
	// generated name is invisible to it -- these eight would report as unread.
	od.connectionMask[0] = parseSideMask(logicNode.attribute("connections_rot0").as_string());
	od.connectionMask[1] = parseSideMask(logicNode.attribute("connections_rot1").as_string());
	od.connectionMask[2] = parseSideMask(logicNode.attribute("connections_rot2").as_string());
	od.connectionMask[3] = parseSideMask(logicNode.attribute("connections_rot3").as_string());

	od.inputMask[0] = parseSideMask(logicNode.attribute("input_rot0").as_string());
	od.inputMask[1] = parseSideMask(logicNode.attribute("input_rot1").as_string());
	od.inputMask[2] = parseSideMask(logicNode.attribute("input_rot2").as_string());
	od.inputMask[3] = parseSideMask(logicNode.attribute("input_rot3").as_string());

	od.lampColorCount = static_cast<uint8_t>(std::max(1u, logicNode.attribute("colorCount").as_uint(7)));
	od.pulseIsOneShot = std::string(logicNode.attribute("pulseType").as_string("pulse")) == "pulse";
	od.pulseDurationMs = logicNode.attribute("pulseDurationMs").as_uint(100);
	od.platformDelayInMs = logicNode.attribute("platformDelayInMs").as_uint(500);
	od.platformDelayOutMs = logicNode.attribute("platformDelayOutMs").as_uint(500);

	const std::string ratesStr = logicNode.attribute("ratesMs").as_string();
	if (!ratesStr.empty()) {
		std::stringstream ss(ratesStr);
		std::string itemRate;
		while (std::getline(ss, itemRate, ',')) {
			if (itemRate.empty()) continue;
			try {
				od.timerRatesMs.push_back(std::stoul(itemRate));
			} catch (const std::exception&) {
				reportDataWarning(filename, fmt::format("object '{}' has invalid timer rate '{}'", od.key, itemRate));
			}
		}
	}
	if (od.timerRatesMs.empty()) {
		od.timerRatesMs = {500, 1000, 2000, 4000};
	}
}

bool ObjectManager::loadFromXml(const std::string& filename)
{
	static const std::unordered_map<std::string, uint8_t> layerMap = {
		{"top", 3}, {"mid", 4}, {"low", 4}, {"bottom", 6}, {"bottom2", 6}
	};

	// openDataFile validates as it opens. loadItemsFromXml deliberately does NOT
	// use it: that pass re-reads items.xml, which ItemManager has already
	// validated, and would report every warning a second time.
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "objects");
	if (!root) return false;

	// This is called once per object file and `objects` accumulates across them,
	// so report what THIS file contributed. The old log printed the running
	// total twice ("62 objects" then "123 objects") which read as a double load.
	const size_t before = objects.size();
	// Running total across files, so each file can report only its own share.
	static uint32_t unitsBefore = 0;

	for (pugi::xml_node objNode = root.child("object"); objNode; objNode = objNode.next_sibling("object")) {
		ObjectData od;
		
		std::string baseKey = objNode.attribute("base").as_string();
		if (!baseKey.empty()) {
			auto itBase = objects.find(baseKey);
			if (itBase != objects.end()) {
				od = itBase->second;
			} else {
				reportDataWarning(filename, fmt::format("base object '{}' not found for object '{}'", baseKey, objNode.attribute("key").as_string()));
			}
		}

		if (objNode.attribute("key")) od.key = objNode.attribute("key").as_string();
		// Tracked so the "no category=" check below does not fire a second time
		// for an object that already reported an unknown VALUE here.
		bool declaredCategory = false;
		if (pugi::xml_attribute catAttr = objNode.attribute("category")) {
			declaredCategory = true;
			od.category = parseObjectCategory(catAttr.as_string());
			if (od.category == ObjectCategory::Other) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has unknown category '{}'; it will behave as a plain object",
					od.key, catAttr.as_string()));
			}
		}
		if (objNode.attribute("healthMax")) od.healthMax = objNode.attribute("healthMax").as_int();
		if (objNode.attribute("layer")) od.layer = objNode.attribute("layer").as_string();
		
		// Unconditional: it is derived purely from `category`, which is already
		// correct whether declared here or inherited through base=. It used to be
		// guarded on the attribute being PRESENT, and when type= became category=
		// that guard kept testing the old name -- so isFloor silently stayed
		// false for every object without a base, and floors stopped counting as
		// floors for stacking, doors, auto-tiling and resource spawning.
		od.isFloor = (od.category == ObjectCategory::Floor || od.category == ObjectCategory::Road);

		// <destruction> declares the thresholds the client's damaged sprite
		// steps at. Omit it to keep the defaults in ObjectData.
		if (pugi::xml_node destructionNode = objNode.child("destruction")) {
			std::vector<uint8_t> pcts;
			for (pugi::xml_node s = destructionNode.child("stage"); s; s = s.next_sibling("stage")) {
				pcts.push_back(static_cast<uint8_t>(s.attribute("hpPercent").as_uint()));
			}
			if (pcts.size() != 3) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has {} <destruction> stages; the client's sprite has room for exactly 3, so the block is ignored",
					od.key, pcts.size()));
			} else if (!(pcts[0] > pcts[1] && pcts[1] > pcts[2])) {
				reportDataWarning(filename, fmt::format(
					"object '{}' <destruction> stages are not descending ({}/{}/{}); the block is ignored",
					od.key, pcts[0], pcts[1], pcts[2]));
			} else {
				od.destructionStagePct[0] = pcts[0];
				od.destructionStagePct[1] = pcts[1];
				od.destructionStagePct[2] = pcts[2];
			}
		}

		pugi::xml_node stationNode = objNode.child("station");
		if (stationNode) {
			od.stationId = stationNode.attribute("areaId").as_int();
			// Area 0 is the player's own hand-craft area, so a station that
			// lands there opens a menu holding every recipe with no station.
			if (od.stationId == 0) {
				reportDataWarning(filename, fmt::format(
					"station '{}' has no areaId (0 is hand-craft); its craft menu will be wrong", od.key));
			}

			// The name items.xml cites in <station key=>. Registering it here is
			// what lets that file resolve a station without a second table.
			const std::string stationKey = stationNode.attribute("key").as_string();
			if (stationKey.empty()) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has a <station> with no key=; no recipe can name it", od.key));
			} else if (auto [it, inserted] = stationAreaByKey.emplace(stationKey, od.stationId);
			           !inserted && it->second != od.stationId) {
				reportDataWarning(filename, fmt::format(
					"station key '{}' maps to areaId {} here but {} elsewhere; recipes will use {}",
					stationKey, od.stationId, it->second, it->second));
			}
		}

		if (pugi::xml_node concealNode = objNode.child("conceal")) {
			const unsigned tiles = concealNode.attribute("tiles").as_uint(0);
			if (tiles == 0 || tiles > 255) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has <conceal tiles=\"{}\">; it needs 1..255, so it stays visible",
					od.key, tiles));
				od.concealTiles = 0;
			} else {
				od.concealTiles = static_cast<uint8_t>(tiles);
			}
		}

		if (pugi::xml_node placeNode = objNode.child("place")) {
			od.placeDelayMs = placeNode.attribute("delayMs").as_uint(0);
			if (od.placeDelayMs == 0) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has a <place> with no delayMs=; it can be placed as fast as a "
					"client can click", od.key));
			}
		}

		pugi::xml_node fuelNode = objNode.child("fuel");
		if (fuelNode) {
			od.fuelItemKey = fuelNode.attribute("itemKey").as_string();
			od.fuelBurnMs = fuelNode.attribute("burnDurationPerUnitMs").as_uint();
			od.fuelAddAmount = fuelNode.attribute("addAmount").as_uint(1);

			// Items load before objects, so the key can be resolved here. An
			// unfuellable burner is not a visible failure -- the object stands
			// there and simply never lights.
			if (od.fuelItemKey.empty()) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has a <fuel> with no itemKey=; nothing can fuel it", od.key));
			} else if (!ItemManager::getInstance().getItemData(od.fuelItemKey)) {
				reportDataWarning(filename, fmt::format(
					"object '{}' burns '{}', which is not an item in items.xml; nothing can fuel it",
					od.key, od.fuelItemKey));
			}
		}

		pugi::xml_node interactNode = objNode.child("interaction");
		if (interactNode) {
			const std::string kindStr = interactNode.attribute("type").as_string();
			od.interaction = parseInteractionKind(kindStr);
			if (od.interaction == InteractionKind::None) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has unknown interaction type '{}'; it cannot be interacted with",
					od.key, kindStr));
			}
			od.interactionDelayMs = interactNode.attribute("interactionDelayMs").as_uint(0);
		}

		// Map XML layer/type to protocol ID (Match client.js ENTITIES indices)
		// 3: __ENTITIE_BUILD_TOP__ (Walls, High things)
		// 4: __ENTITIE_BUILD_DOWN__ (Furnitures, Low walls)
		// 5: __ENTITIE_BUILD_GROUND__ (Roads)
		// 6: __ENTITIE_BUILD_GROUND2__ (Floors)
		if (!od.layer.empty()) {
			auto it = layerMap.find(od.layer);
			// A misspelled layer used to fall through to 4 in silence, which
			// draws the object on the wrong plane and looks like a sprite bug.
			if (it == layerMap.end()) {
				reportDataWarning(filename, fmt::format(
					"object '{}' has unknown layer '{}'; drawing it on the default plane",
					od.key, od.layer));
			}
			od.protocolType = (it != layerMap.end()) ? it->second : 4;
		}

		if (objNode.attribute("subtype")) {
			od.subtype = static_cast<uint8_t>(objNode.attribute("subtype").as_uint());
			od.explicitSubtype = true;
		}

		// Not inherited from <base>: "this is a template" is a property of the
		// declaration, not of the thing it describes.
		od.isAbstract = objNode.attribute("abstract").as_bool(false);

		// Special case: Road force Item ID to 86 if it was not found in items.xml
		if (od.key == "road") {
			if (od.id == 0) od.id = 86;
		}

		// Which item this object IS, for the client. Two rules only:
		// an explicit itemKey=, else the object's own key.
		//
		// There used to be a third: fall back to the object's TYPE. Nothing in
		// objects.xml ever used it -- all 62 bind by their own key -- and it
		// existed solely so furniture could collapse onto <item key="furniture">
		// via type="furniture". That is now spelled out with itemKey= on all 61,
		// because the fallback was a silent trap: adding an item keyed "station"
		// or "wall" would have re-bound every station or wall object to it.
		std::string explicitItemKey = objNode.attribute("itemKey").as_string();
		const std::string& itemKey = explicitItemKey.empty() ? od.key : explicitItemKey;
		auto itemIt = mapKeyToId.find(itemKey);
		if (itemIt != mapKeyToId.end()) {
			od.id = itemIt->second;
		}

		// Check for alignment
		std::string align = objNode.attribute("align").as_string();

		pugi::xml_node transformNode = objNode.child("transform");
		if (transformNode) {
			od.width = transformNode.attribute("width").as_int();
			od.height = transformNode.attribute("height").as_int();
			od.radius = transformNode.attribute("radius").as_int(0);
			od.collision = transformNode.attribute("collision").as_bool();
			od.blocksProjectiles = transformNode.attribute("blocksProjectiles").as_bool();
			
			if (align.empty()) {
				align = transformNode.attribute("align").as_string();
			}
		}
		
		if (!align.empty()) {
			if (align == "bottom" || align == "edge") od.alignType = AlignType::BOTTOM;
			else if (align == "left") od.alignType = AlignType::LEFT;
			else if (align == "top") od.alignType = AlignType::TOP;
			else if (align == "right") od.alignType = AlignType::RIGHT;
		}

		pugi::xml_node storageNode = objNode.child("storage");
		if (storageNode) {
			int32_t slots = storageNode.attribute("slots").as_int();
			if (slots > MAX_CHEST_SLOTS) {
				reportDataWarning(filename, fmt::format("'{}' declares {} storage slots exceeding MAX_CHEST_SLOTS ({}); clamping", od.key, slots, MAX_CHEST_SLOTS));
				slots = MAX_CHEST_SLOTS;
			}
			od.storageSlots = static_cast<uint8_t>(std::max(0, slots));
			od.refrigeration = storageNode.attribute("refrigeration").as_bool(false);
			
			pugi::xml_node contentsNode = storageNode.child("contents");
			if (contentsNode) {
				// Cleared first, like <drops> and <areaEffects>: an object with
				// base= starts as a COPY of its template, so appending here would
				// give it the base's loot table plus its own. Nothing ships that
				// combination today, which is exactly why it would have been
				// found by a doubled chest rather than by a warning.
				od.initialStorage.clear();
				for (pugi::xml_node itemNode = contentsNode.child("item"); itemNode; itemNode = itemNode.next_sibling("item")) {
					StorageContent content;
					std::string itemKey = itemNode.attribute("key").as_string();
					const ItemData* idata = ItemManager::getInstance().getItemData(itemKey);
					if (idata) {
						content.iid = idata->id;
						content.count = itemNode.attribute("amount").as_int(1);
						content.chance = itemNode.attribute("chance").as_float(1.0f);
						od.initialStorage.push_back(content);
					}
				}
			}
		}

		pugi::xml_node effectsNode = objNode.child("areaEffects");
		if (effectsNode) {
			od.areaEffects.clear(); // Override base effects if new ones are provided
			xml_utils::appendAreaEffects(effectsNode, od.areaEffects);
		}

		if (pugi::xml_node stagesNode = objNode.child("stages")) {
			parseStages(stagesNode, od, filename);
		}

		pugi::xml_node respawnerNode = objNode.child("respawner");
		if (respawnerNode) {
			od.respawner = RespawnerData{};
			od.respawner.enabled = true;

			pugi::xml_node gaugesNode = respawnerNode.child("gauges");
			if (gaugesNode) {
				od.respawner.healthPercent = static_cast<uint8_t>(std::min(100u, gaugesNode.attribute("health").as_uint(30)));
				od.respawner.staminaPercent = static_cast<uint8_t>(std::min(100u, gaugesNode.attribute("stamina").as_uint(30)));
				od.respawner.hungerPercent = static_cast<uint8_t>(std::min(100u, gaugesNode.attribute("food").as_uint(30)));
				od.respawner.coldPercent = static_cast<uint8_t>(std::min(100u, gaugesNode.attribute("cold").as_uint(30)));
			}

			pugi::xml_node itemsNode = respawnerNode.child("items");
			if (itemsNode) {
				for (pugi::xml_node itemNode = itemsNode.child("item"); itemNode; itemNode = itemNode.next_sibling("item")) {
					const ItemData* grantData = ItemManager::getInstance().getItemData(itemNode.attribute("key").as_string());
					if (grantData) {
						RespawnerItem grant;
						grant.iid = grantData->id;
						grant.count = static_cast<uint8_t>(std::min(255u, itemNode.attribute("amount").as_uint(1)));
						od.respawner.items.push_back(grant);
					} else {
						fmt::print(">> [Respawner Error] Object '{}' grants unknown item key '{}'\n", od.key, itemNode.attribute("key").as_string());
					}
				}
			}
		}

		pugi::xml_node lifetimeNode = objNode.child("lifetime");
		if (lifetimeNode) {
			od.lifetimeMs = lifetimeNode.attribute("durationMs").as_uint(0);
			if (od.lifetimeMs == 0) {
				// Fallback if they provide ms directly
				od.lifetimeMs = lifetimeNode.attribute("durationMs").as_uint(0);
			}
			od.startLifetimeOnTrigger = lifetimeNode.attribute("startOnTrigger").as_bool(false);
		}

		pugi::xml_node remoteNode = objNode.child("remote");
		if (remoteNode) {
			od.remoteChannel = remoteNode.attribute("channel").as_string();
			od.remoteAction = remoteNode.attribute("action").as_string("detonate");
			if (od.remoteChannel.empty()) {
				reportDataWarning(filename, fmt::format(
					"'{}': <remote> with no channel; it will never be signalled", od.key));
			}
			if (od.remoteAction != "detonate") {
				reportDataWarning(filename, fmt::format(
					"'{}': unknown <remote action=\"{}\">; only \"detonate\" is implemented, so the signal will be ignored",
					od.key, od.remoteAction));
			}
		}

		pugi::xml_node onDestroyNode = objNode.child("onDestroy");
		if (onDestroyNode) {
			xml_utils::parseExplosionChild(onDestroyNode, od.explosion, true);
		}

		pugi::xml_node onStepInNode = objNode.child("onStepIn");
		if (onStepInNode) {
			od.onStepIn.enabled = true;
			od.onStepIn.damage = static_cast<int16_t>(std::min<long long>(
				onStepInNode.attribute("damage").as_llong(), 32767));
			od.onStepIn.heal = onStepInNode.attribute("heal").as_int();
			od.onStepIn.changeSpeed = onStepInNode.attribute("changeSpeed").as_int();
			od.onStepIn.intervalMs = onStepInNode.attribute("intervalMs").as_uint();
			parseTriggerDetonate(onStepInNode, od.onStepIn, od.key);
		}

		pugi::xml_node onStepOutNode = objNode.child("onStepOut");
		if (onStepOutNode) {
			od.onStepOut.enabled = true;
			od.onStepOut.damage = static_cast<int16_t>(std::min<long long>(
				onStepOutNode.attribute("damage").as_llong(), 32767));
			od.onStepOut.heal = onStepOutNode.attribute("heal").as_int();
			od.onStepOut.changeSpeed = onStepOutNode.attribute("changeSpeed").as_int();
			parseTriggerDetonate(onStepOutNode, od.onStepOut, od.key);
		}

		// Logic tag parsing
		if (pugi::xml_node logicNode = objNode.child("logic")) {
			parseLogic(logicNode, od, filename);
		}

		pugi::xml_node dropsNode = objNode.child("drops");
		if (!dropsNode && onDestroyNode) {
			dropsNode = onDestroyNode.child("drops");
		}

		if (dropsNode) {
			// Cleared first: a base= object inherits its parent's drops, and a
			// child that declares its own replaces them rather than adding to
			// them -- the same "present block replaces" rule modes.xml uses.
			od.drops.clear();
			xml_utils::parseItemDrops(dropsNode, od.drops, filename,
				fmt::format("object '{}'", od.key));
		}

		// Every real object belongs to a category; the six that omit it inherit
		// one through base=. Checked AFTER the base merge, so what is tested is
		// the value the object ends up with.
		//
		// This is what protects the attribute NAME, not just its value: a
		// misspelled `categroy=` (or the old `type=`) is simply an attribute
		// nobody reads, and without this it would leave the object uncategorised
		// in silence. check_xml_vocabulary.py cannot catch it either -- `type` is
		// still read on other elements, so its flat name set says it is legal.
		if (!od.isAbstract && od.category == ObjectCategory::Other && !declaredCategory) {
			reportDataWarning(filename, fmt::format(
				"object '{}' has no category=; it will not act as a plant, trap, door or anything else",
				od.key));
		}

		noteCollisionExtent(od);
		if (!objects.count(od.key)) {
			declarationOrder.push_back(od.key);
		}
		objects[od.key] = od;
	}

	// Drop/storage units alongside the object count, for the same reason kits
	// report their granted total: a silently emptied <item amount=> still leaves
	// the object count right, so the quantity is the part worth showing.
	// Per-file like the count is -- `objects` accumulates across both files.
	uint32_t contentUnits = 0;
	for (const auto& [key, od] : objects) {
		for (const auto& d : od.drops) contentUnits += d.amount;
		for (const auto& c : od.initialStorage) contentUnits += c.count;
	}

	reportDataFile(filename, fmt::format("{} objects, {} drop/storage units",
		objects.size() - before, contentUnits - unitsBefore));
	unitsBefore = contentUnits;
	return true;
}

bool ObjectManager::getStationAreaId(const std::string& key, uint8_t& areaId) const
{
	auto it = stationAreaByKey.find(key);
	if (it == stationAreaByKey.end()) {
		return false;
	}
	areaId = it->second;
	return true;
}

void ObjectManager::buildMapItemIndex()
{
	mapItemIndex.clear();

	for (const std::string& key : declarationOrder) {
		auto it = objects.find(key);
		if (it == objects.end()) {
			continue;
		}

		const ObjectData& od = it->second;
		// id 0 means items.xml has no entry for this key or its type, so the
		// client has no INVENTORY slot for it and no map record can name it.
		if (od.isAbstract || od.id == 0) {
			continue;
		}
		mapItemIndex[od.id].push_back(&it->second);
	}

	// Indented to match the data-file lines: this index is derived from the
	// object files just above it, so it belongs to that block rather than
	// splitting it in half.
	fmt::print("   {:<21} {} item ids resolve to a placeable object\n", "(map item index)", mapItemIndex.size());
}

const ObjectData* ObjectManager::resolveMapItem(uint16_t iid, uint8_t subtype, bool hasSubtype) const
{
	auto it = mapItemIndex.find(iid);
	if (it == mapItemIndex.end()) {
		return nullptr;
	}
	const std::vector<const ObjectData*>& candidates = it->second;

	if (hasSubtype) {
		for (const ObjectData* od : candidates) {
			if (od->explicitSubtype && od->subtype == subtype) {
				return od;
			}
		}
		for (const ObjectData* od : candidates) {
			if (!od->explicitSubtype) {
				return od;
			}
		}
		return nullptr;
	}

	for (const ObjectData* od : candidates) {
		if (!od->explicitSubtype) {
			return od;
		}
	}
	for (const ObjectData* od : candidates) {
		if (od->explicitSubtype && od->subtype == 0) {
			return od;
		}
	}
	return nullptr;
}

void ObjectManager::validateStageCreatures() const
{
	for (const auto& [key, od] : objects) {
		for (const ObjectStage& stage : od.stages) {
			if (stage.spawnCreature.empty()) continue;
			if (g_agents.getAgentData(stage.spawnCreature)) continue;
			// Only objects.xml defines <stages>, so that is the file to name even
			// though `objects` also holds everything from furnitures.xml.
			reportDataWarning(contentFile("objects.xml"), fmt::format(
				"object '{}' stage {} spawns unknown agent '{}'; add it to agents.xml "
				"or the spawner will do nothing",
				key, stage.id, stage.spawnCreature));
		}
	}
}

void ObjectManager::noteCollisionExtent(const ObjectData& od)
{
	// Half-extent per axis for the rect form, plain radius for the circular
	// one. getCollisionRect swaps width/height on rotation 1/3, so taking the
	// max of both axes covers every rotation.
	const uint16_t extent = std::max({static_cast<uint16_t>(od.width / 2),
	                                  static_cast<uint16_t>(od.height / 2),
	                                  od.radius});
	maxCollisionExtent = std::max(maxCollisionExtent, extent);
}

const ObjectData* ObjectManager::getObjectData(const std::string& key) const
{
	auto it = objects.find(key);
	if (it != objects.end()) {
		return &it->second;
	}
	return nullptr;
}

const ObjectData* ObjectManager::getObjectData(uint16_t id) const
{
	for (const auto& pair : objects) {
		if (pair.second.id == id) {
			return &pair.second;
		}
	}
	return nullptr;
}

Object* ObjectManager::createObject(const std::string& key, const Position& pos, uint8_t rotation)
{
	const ObjectData* od = getObjectData(key);
	if (!od) {
		return nullptr;
	}

	// Named before it is built: on exhaustion there is nothing to clean up.
	const uint32_t uid = g_game.map.acquireEntityId(EntityClass::Object);
	if (uid == 0) {
		if (!warnedExhausted) {
			warnedExhausted = true;
			fmt::print(fg(fmt::color::yellow),
				">> [Warning] No entity id available for a new object ({} live). Nothing further "
				"can be built or spawned. Lower or clear entityIdCapObjects in config.lua, "
				"or free ids by removing objects.\n",
					g_game.map.getEntityIdPool().liveCount(EntityClass::Object));
		}
		return nullptr;
	}
	warnedExhausted = false;

	Object* obj = new Object(key);
	obj->setID(uid);
	obj->setPosition(pos);
	obj->setRotation(rotation);
	obj->setHealth(od->healthMax);
	obj->placedTime = OTSYS_TIME();
	if (!od->stages.empty()) {
		obj->setSubtype(od->stages.front().id); // staged objects start at their first stage
	} else {
		obj->setSubtype(od->subtype, od->explicitSubtype);
	}

	if (od->storageSlots > 0) {
		obj->initStorage(od->storageSlots);

		uint8_t currentSlot = 0;
		uint32_t rollIndex = 0;
		for (const auto& content : od->initialStorage) {
			if (currentSlot >= od->storageSlots) break;

			// While the world is being generated these rolls are keyed by WHERE
			// the chest is, not by when it was rolled. Under the shared stream a
			// single skipped tile -- a bot standing in the footprint -- changed
			// how many rolls the pass made and moved every structure placed
			// after it, so the same seed built a different map each time.
			// A player building a chest is not generation and still rolls live.
			const float roll = worldgen::isActive()
				? worldgen::contentRoll(pos.x, pos.y, key, rollIndex++)
				: static_cast<float>(rand() % 1000) / 1000.0f;
			if (roll <= content.chance) {
				const ItemData* idata = ItemManager::getInstance().getItemData(content.iid);
				if (idata) {
					obj->setStorageItem(currentSlot++, std::make_unique<Item>(content.iid, content.count, ItemState::fresh(content.iid)));
				}
			}
		}
	}

	if (od->lifetimeMs > 0 && !od->startLifetimeOnTrigger) {
		uint32_t objId = obj->getID();
		g_scheduler.addEvent(createSchedulerTask(od->lifetimeMs, [objId]() {
			g_dispatcher.addTask([objId]() {
				if (Thing* t = g_game.getThingByID(objId)) {
					if (Object* o = t->getObject()) {
						g_game.expireObject(o);
					}
				}
			});
		}));
	}

	return obj;
}
