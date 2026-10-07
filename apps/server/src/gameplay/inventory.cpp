// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/inventory.h"
#include "gameplay/player.h"
#include "gameplay/loot.h"
#include "gameplay/game.h"
#include "gameplay/weapon_mods.h"
#include "network/opcodes.h"
#include <optional>

extern Game g_game;

bool Inventory::prepareExchange(const std::vector<TradeItem>& outgoing,
    const std::vector<TradeItem>& incoming, ExchangePlan& plan) const
{
    plan.slots.clear();
    plan.overflow.clear();
    for (const auto& item : slots) {
        plan.slots.push_back(item ? std::make_unique<Item>(*item) : nullptr);
    }
    for (const auto& offer : outgoing) {
        auto it = std::find_if(plan.slots.begin(), plan.slots.end(), [&](const auto& item) {
            return item && item->getUID() == offer.uid && item->getIID() == offer.iid;
        });
        if (it == plan.slots.end() || offer.count == 0 || (*it)->getCount() < offer.count) return false;
        if ((*it)->getCount() == offer.count) it->reset();
        else (*it)->setCount((*it)->getCount() - offer.count);
    }
    for (const auto& offer : incoming) {
        const auto* data = ItemManager::getInstance().getItemData(offer.iid);
        if (!data || data->stack == 0) return false;
        uint16_t remaining = offer.count;
        for (auto& item : plan.slots) {
            if (!item || item->getIID() != offer.iid || item->getCount() >= data->stack) continue;
            // Different loaded ammo/durability must never silently collapse into one stack.
            if (item->getMods() != offer.state.mods) continue;
            if (!data->decayTimeMs && item->getAmmo() != offer.state.ammo) continue;
            const uint8_t added = static_cast<uint8_t>(std::min<uint16_t>(remaining, data->stack - item->getCount()));
            if (added == 0) continue;
            if (data->decayTimeMs) {
                const auto progress = static_cast<uint32_t>((uint64_t(item->getDecayProgress()) * item->getCount() +
                    uint64_t(offer.decayProgress) * added) / (item->getCount() + added));
                item->setAmmo(255 - static_cast<uint8_t>((uint64_t(progress) * 255) / data->decayTimeMs));
                item->setDecayProgress(progress);
            }
            item->setCount(item->getCount() + added);
            remaining -= added;
        }
        for (auto& item : plan.slots) {
            if (item || remaining == 0) continue;
            const uint8_t added = static_cast<uint8_t>(std::min<uint16_t>(remaining, data->stack));
            uint16_t uid = Item::allocUid();
            auto uidTaken = [&](uint16_t candidate) {
                return std::any_of(plan.slots.begin(), plan.slots.end(), [&](const auto& slot) {
                    return slot && static_cast<uint8_t>(slot->getUID()) == static_cast<uint8_t>(candidate);
                });
            };
            while (uidTaken(uid)) uid = Item::allocUid();
            item = std::make_unique<Item>(offer.iid, added, offer.state, uid);
            item->setDecayProgress(offer.decayProgress);
            remaining -= added;
        }
        if (remaining) {
            auto overflow = offer;
            overflow.count = static_cast<uint8_t>(remaining);
            // Ground loot encodes decay as a byte; round towards older, never refresh food.
            if (data->decayTimeMs) overflow.state.ammo = 255 - static_cast<uint8_t>(
                (uint64_t(offer.decayProgress) * 255 + data->decayTimeMs - 1) / data->decayTimeMs);
            plan.overflow.push_back(overflow);
        }
    }
    return true;
}

void Inventory::commitExchange(ExchangePlan&& plan)
{
    slots.swap(plan.slots);
    player->cancelAction();
    player->cancelReload();
    player->cancelModChange();
    // All server items survive as copies with the same identities, except
    // fully removed offers. Pending equipment actions cannot resurrect those.
    for (const auto& old : plan.slots) {
        if (!old) continue;
        bool remains = std::any_of(slots.begin(), slots.end(), [&](const auto& item) {
            return item && item->getUID() == old->getUID();
        });
        if (!remains) {
            if (player->getEquippedWeaponUID() == old->getUID()) player->completeEquip(0, 0, Player::EquipmentType::WEAPON);
            if (player->getEquippedWearableUID() == old->getUID()) player->completeEquip(0, 0, Player::EquipmentType::WEARABLE);
        }
    }
    player->sendFullInventory();
}

static uint32_t mergeDecayProgress(uint32_t progressA, uint32_t countA, uint32_t progressB, uint32_t countB)
{
	return static_cast<uint32_t>(
		(static_cast<uint64_t>(progressA) * countA + static_cast<uint64_t>(progressB) * countB) / (countA + countB)
	);
}

static void autoUnequipIfNeeded(Player* player, uint32_t uid)
{
	player->cancelModChangeFor(uid);
	if (player->getEquippedWeaponUID() == uid) {
		player->cancelReload();
		player->completeEquip(0, 0, Player::EquipmentType::WEAPON);
	}
	if (player->getEquippedWearableUID() == uid) {
		player->completeEquip(0, 0, Player::EquipmentType::WEARABLE);
	}
}

Inventory::Inventory(Player* player) : player(player)
{
	slots.resize(8); // Default size
}

bool Inventory::isWireUidTaken(uint8_t wireUid) const
{
	for (const auto& slot : slots) {
		if (slot && static_cast<uint8_t>(slot->getUID() & 0xFF) == wireUid) {
			return true;
		}
	}
	return false;
}

// An item's ENTIRE identity on the wire is the low byte of its uid: that is what
// every item message carries and what both sides address a slot by. The uid
// counter is global and 16-bit, so it aliases every 256 items created anywhere
// on the server -- and two stacks of the same iid in one inventory that alias
// are then indistinguishable to the client's slot scan AND to
// findItemByUidSlot. Whichever came first wins, silently, so an equip or a drop
// lands on the wrong stack.
//
// The uniqueness only ever has to hold WITHIN one inventory, which is a space of
// at most getSlotCount() values out of 256. So buy it outright here: skip
// forward until the low byte is free. At most slots.size() + 1 iterations, and
// only when an item is created.
// State a slot as it now is -- the one way this class tells a client anything.
// Whatever changed (count, ammo, or the slot coming into existence), the message
// is the same and the client needs no prior belief about the slot to apply it.
//
// lastSyncedAmmo is bookkeeping for the decay throttle in update(), nothing
// more: it used to be the ammo value the client had to be told to MATCH on, so
// getting it wrong dropped the update instead of merely delaying a redraw.
void Inventory::syncSlot(Item& item) const
{
	player->sendInventorySlot(item.getIID(), item.getCount(), item.getUID(), item.getAmmo());
	// A moddable gun is always stated with its mods, so a client can never hold
	// the gun without them (and a reused uid never inherits another's).
	if (weapon_mods::takesMods(item.getIID())) player->sendItemMods(item);
	item.setLastSyncedAmmo(item.getAmmo());
}

std::unique_ptr<Item> Inventory::makeItem(uint16_t iid, uint8_t count, const ItemState& state) const
{
	uint16_t uid = Item::allocUid();
	while (isWireUidTaken(static_cast<uint8_t>(uid & 0xFF))) {
		uid = Item::allocUid();
	}
	return std::make_unique<Item>(iid, count, state, uid);
}

uint8_t Inventory::addItem(uint16_t iid, uint8_t count)
{
	return addItem(iid, count, ItemState::fresh(iid));
}

uint8_t Inventory::addItem(uint16_t iid, uint8_t count, const ItemState& state)
{
	if (count == 0) return 0;
	// A ghoul carries nothing. Returning 0 rather than refusing higher up is
	// what makes the rest fall out for free: every caller already handles a
	// partial add by dropping the remainder on the ground (Resource::harvestDrops
	// is the one that matters -- it is the full-inventory path), so a ghoul
	// clawing a tree spills the wood at its feet exactly as a loaded player
	// does, with no branch anywhere that knows what a ghoul is.
	//
	// Here rather than only at the packet gate because the yield paths are not
	// packets: nothing a modified client sends is involved in a resource drop.
	if (player && player->isGhoul()) {
		return 0;
	}

	const ItemData* data = ItemManager::getInstance().getItemData(iid);
	if (!data) return 0;

	const uint8_t actualAmmo = state.ammo;

	uint16_t remaining = count;

	// 1. Try to fill existing stacks
	for (size_t i = 0; i < slots.size(); ++i) {
		if (slots[i] && slots[i]->getIID() == iid && slots[i]->getMods() == state.mods) {
			uint8_t current = slots[i]->getCount();
			uint8_t canAdd = static_cast<uint8_t>(std::min<uint16_t>(remaining, data->stack - current));
			
			if (canAdd > 0) {
				// Calculate weighted average of decay progress if perishable
				if (data->decayTimeMs > 0) {
					uint32_t existingProgress = slots[i]->getDecayProgress();
					uint32_t addedProgress = (static_cast<uint32_t>(255 - actualAmmo) * data->decayTimeMs) / 255;

					uint32_t newProgress = mergeDecayProgress(existingProgress, current, addedProgress, canAdd);

					slots[i]->setDecayProgress(newProgress);
					slots[i]->setAmmo(255 - static_cast<uint8_t>((static_cast<uint64_t>(newProgress) * 255) / data->decayTimeMs));
				}

				slots[i]->setCount(current + canAdd);
				remaining -= canAdd;

				syncSlot(*slots[i]);
			}
		}
		if (remaining == 0) return count;
	}

	// 2. Occupy empty slots
	for (size_t i = 0; i < slots.size(); ++i) {
		if (!slots[i]) {
			uint8_t toAdd = static_cast<uint8_t>(std::min<uint16_t>(remaining, data->stack));
			slots[i] = makeItem(iid, toAdd, state);
			remaining -= toAdd;
			syncSlot(*slots[i]);
		}
		if (remaining == 0) return count;
	}

	return static_cast<uint8_t>(count - remaining);
}

bool Inventory::removeItem(uint8_t slot, uint8_t count)
{
	if (count == 0) return false;
	if (slot >= slots.size() || !slots[slot]) return false;

	const uint32_t uid = slots[slot]->getUID();

	if (slots[slot]->getCount() <= count) {
		slots[slot].reset();
		player->sendClearInventorySlot(uid);

		// Auto-Unequip if removed
		autoUnequipIfNeeded(player, uid);
	} else {
		slots[slot]->setCount(slots[slot]->getCount() - count);
		syncSlot(*slots[slot]);
	}
	return true;
}

bool Inventory::dropItem(uint8_t slot, uint8_t count)
{
	if (count == 0) return false;
	if (slot >= slots.size() || !slots[slot]) return false;

	Item* item = slots[slot].get();
	uint16_t iid = item->getIID();
	uint8_t actualCount = std::min(count, item->getCount());

	const ItemData* data = item->getData();
	if (!data) return false;

	float angle = (player->getRotation() * 2.0f * 3.14159f) / 255.0f;
	Position spawnPos = player->getPosition();
	Position landingPos = g_game.findThrowLootPosition(spawnPos, angle, 80.0f);

	if (actualCount == 0 || !g_game.spawnLoot(data->lootId, iid, actualCount, ItemState::of(*item), spawnPos, landingPos)) return false;

	return removeItem(slot, actualCount);
}

void Inventory::dropAllOnDeath()
{
	std::vector<Game::LootDrop> drops;
	for (auto& slot : slots) {
		if (slot) {
			if (const ItemData* data = slot->getData()) {
				drops.push_back({ data->lootId, slot->getIID(), slot->getCount(), ItemState::of(*slot) });
			}
			slot.reset();
		}
	}
	g_game.dropLootBurst(player->getPosition(), drops, 80.0f);
}

bool Inventory::splitItem(uint8_t slot)
{
	if (slot >= slots.size() || !slots[slot]) return false;

	Item* item = slots[slot].get();
	if (item->getCount() < 2) return false;

	uint8_t totalBefore = item->getCount();
	uint8_t splitAmount = totalBefore / 2;
	uint8_t remainingAmount = totalBefore - splitAmount;

	// Find empty slot for the split stack
	int8_t emptySlot = -1;
	for (size_t i = 0; i < slots.size(); ++i) {
		if (!slots[i]) {
			emptySlot = static_cast<int8_t>(i);
			break;
		}
	}

	if (emptySlot == -1) return false;

	uint16_t iid = item->getIID();
	uint32_t decayProgress = item->getDecayProgress();

	// Update current stack
	item->setCount(remainingAmount);

	// Create new stack
	slots[emptySlot] = makeItem(iid, splitAmount, ItemState::of(*item));
	slots[emptySlot]->setDecayProgress(decayProgress); // Preserve progress

	// Two slots changed, so two statements. SPLIT_ITEM used to be a single
	// message that told the client to work the halves out for itself -- a second
	// implementation of `totalBefore / 2` that had to agree with this one.
	syncSlot(*item);
	syncSlot(*slots[emptySlot]);

	return true;
}

bool Inventory::stackItem(uint32_t dragUid, uint16_t dragIid, uint32_t targetUid)
{
	int8_t dragSlot = findItemByUidSlot(dragUid, dragIid);
	int8_t targetSlot = findItemByUidSlot(targetUid, dragIid);

	if (dragSlot == -1 || targetSlot == -1 || dragSlot == targetSlot) return false;

	Item* dragItem = slots[dragSlot].get();
	Item* targetItem = slots[targetSlot].get();

	// Both slots matched dragIid, so either item answers for the type.
	const ItemData* data = targetItem->getData();
	if (!data) return false;

	uint8_t dragCount = dragItem->getCount();
	uint8_t targetCount = targetItem->getCount();

	uint8_t canAdd = static_cast<uint8_t>(std::min<uint16_t>(dragCount, data->stack - targetCount));
	if (canAdd == 0) return false;

	// 1. Update target stack
	//
	// Calculate weighted average of decay progress if perishable
	if (data->decayTimeMs > 0) {
		uint32_t targetProgress = targetItem->getDecayProgress();
		uint32_t dragProgress = dragItem->getDecayProgress();

		uint32_t newProgress = mergeDecayProgress(targetProgress, targetCount, dragProgress, canAdd);

		targetItem->setDecayProgress(newProgress);
		targetItem->setAmmo(255 - static_cast<uint8_t>((static_cast<uint64_t>(newProgress) * 255) / data->decayTimeMs));
	}

	targetItem->setCount(targetCount + canAdd);
	syncSlot(*targetItem);

	// 2. Update drag stack
	if (canAdd == dragCount) {
		slots[dragSlot].reset();
		player->sendClearInventorySlot(dragUid);

		// Auto-Unequip if removed
		autoUnequipIfNeeded(player, dragUid);
	} else {
		dragItem->setCount(dragCount - canAdd);
		syncSlot(*dragItem);
	}

	return true;
}

int8_t Inventory::findItemByUidSlot(uint32_t uid, uint16_t iid) const
{
	for (size_t i = 0; i < slots.size(); ++i) {
		// Match by the 8-bit uid the protocol carries. At most one slot can
		// answer: makeItem keeps that byte unique within this inventory. The iid
		// is still checked, as a guard against a client addressing a slot whose
		// contents it has a stale view of.
		if (slots[i] && (slots[i]->getUID() & 0xFF) == (uid & 0xFF) && slots[i]->getIID() == iid) {
			return static_cast<int8_t>(i);
		}
	}
	return -1;
}

int8_t Inventory::findSlotByUid(uint32_t uid) const
{
	for (size_t i = 0; i < slots.size(); ++i) {
		if (slots[i] && slots[i]->getUID() == uid) return static_cast<int8_t>(i);
	}
	return -1;
}

int8_t Inventory::findSlotByWireUid(uint8_t wireUid) const
{
	// makeItem keeps the low byte unique inside one inventory, so at most one
	// slot answers.
	for (size_t i = 0; i < slots.size(); ++i) {
		if (slots[i] && static_cast<uint8_t>(slots[i]->getUID() & 0xFF) == wireUid) return static_cast<int8_t>(i);
	}
	return -1;
}

int8_t Inventory::firstFreeSlot() const
{
	for (size_t i = 0; i < slots.size(); ++i) {
		if (!slots[i]) return static_cast<int8_t>(i);
	}
	return -1;
}

void Inventory::applyModChange(uint8_t gunSlot, ModSlot slot, int8_t modSlot, int8_t freeSlot)
{
	Item& gun = *slots[gunSlot];
	WeaponMods mods = gun.getMods();
	const uint16_t outgoing = mods.at(slot);
	const bool magazine = slot == ModSlot::Magazine;

	uint16_t incomingIid = 0;
	std::optional<uint8_t> incomingRounds;
	if (modSlot >= 0) {
		Item& incoming = *slots[modSlot];
		incomingIid = incoming.getIID();
		incomingRounds = magazine ? incoming.getAmmo() : uint8_t{0};
		const uint32_t incomingUid = incoming.getUID();
		slots[modSlot].reset();
		player->sendClearInventorySlot(incomingUid);
	}
	const weapon_mods::RoundsAfter rounds = weapon_mods::moveRounds(magazine ? gun.getAmmo() : 0, incomingRounds);

	// The outgoing mod takes the slot the incoming one left, so a swap never
	// needs free space; a removal uses the free slot the plan found.
	if (outgoing != 0) {
		const int8_t target = modSlot >= 0 ? modSlot : freeSlot;
		slots[target] = makeItem(outgoing, 1, ItemState::withAmmo(magazine ? rounds.outgoing : 0));
		syncSlot(*slots[target]);
	}
	mods.set(slot, incomingIid);
	gun.setMods(mods);
	if (magazine) gun.setAmmo(rounds.gun);
	syncSlot(gun);
}

Item* Inventory::getItem(uint8_t slot) const
{
	if (slot >= slots.size()) return nullptr;
	return slots[slot].get();
}

void Inventory::update(uint32_t elapsedMs)
{
	for (size_t i = 0; i < slots.size(); ++i) {
		if (!slots[i]) continue;

		const ItemData* idata = slots[i]->getData();
		if (!idata || idata->decayTimeMs == 0) continue;

		uint32_t currentProgress = slots[i]->getDecayProgress();
		uint32_t newProgress = currentProgress + elapsedMs;
		slots[i]->setDecayProgress(newProgress);

		uint32_t totalMs = idata->decayTimeMs;
		if (newProgress >= totalMs) {
			// Transform item
			uint16_t transformTo = idata->decayTransformTo;
			uint8_t count = slots[i]->getCount();
			uint32_t uid = slots[i]->getUID();

			// No (valid) transform target: the stack simply rots away instead
			// of turning into a phantom item the client cannot render.
			const bool rotsAway = !ItemManager::getInstance().getItemData(transformTo);

			// Made while the old item still holds its slot, so the new uid's
			// low byte differs from it (see makeItem).
			std::unique_ptr<Item> replacement = rotsAway ? nullptr : makeItem(transformTo, count, ItemState::withAmmo(255)); // Reset to fresh state
			const uint32_t newUid = replacement ? replacement->getUID() : 0;

			// Decay is not the owner changing an offer: an open trade follows
			// the item to its new form before the clear below would cancel it.
			g_game.tradeItemReplaced(player->getID(), uid, rotsAway ? 0 : transformTo, newUid, count,
				replacement ? replacement->getAmmo() : 0);

			// A transform is a genuinely different item under a new uid, so it
			// is a clear plus a statement rather than one update.
			player->sendClearInventorySlot(uid);

			if (rotsAway) {
				slots[i].reset();
				autoUnequipIfNeeded(player, uid);
				g_game.resendTrade(player->getID());
				continue;
			}

			slots[i] = std::move(replacement);
			syncSlot(*slots[i]);
			g_game.resendTrade(player->getID());

			// Handle Equipment Update: If the decaying item was held in hand, update to new item
			if (player->getEquippedWeaponUID() == uid) {
				player->completeEquip(transformTo, newUid, Player::EquipmentType::WEAPON);
			} else if (player->getEquippedWearableUID() == uid) {
				player->completeEquip(transformTo, newUid, Player::EquipmentType::WEARABLE);
			}

			continue;
		}

		// Freshness runs continuously but only 20 discrete stages are drawn, so
		// the slot is restated when the STAGE moves, not when the byte does --
		// otherwise every perishable in every inventory sends a message a tick.
		uint8_t calculatedAmmo = 255 - static_cast<uint8_t>((static_cast<uint64_t>(newProgress) * 255) / totalMs);

		uint8_t lastSyncedStage = static_cast<uint8_t>(slots[i]->getLastSyncedAmmo() / 12.8f);
		uint8_t calculatedStage = static_cast<uint8_t>(calculatedAmmo / 12.8f);

		if (calculatedStage != lastSyncedStage) {
			slots[i]->setAmmo(calculatedAmmo);
			syncSlot(*slots[i]);
		}
	}
}
