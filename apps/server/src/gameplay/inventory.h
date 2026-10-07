// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_INVENTORY_H
#define FS_INVENTORY_H

#include "gameplay/item.h"
#include "gameplay/trade.h"
#include <vector>
#include <memory>
#include <cstdint>

class Player;
class Inventory {
public:
	explicit Inventory(Player* player);
	~Inventory() = default;

	// Creates: a new item, fresh ammo and default mods (crafting, admin give,
	// resurrection grants, harvesting).
	uint8_t addItem(uint16_t iid, uint8_t count = 1);
	// Moves: an item arriving from somewhere else, with the state it had there.
	uint8_t addItem(uint16_t iid, uint8_t count, const ItemState& state);
	bool removeItem(uint8_t slot, uint8_t count = 1);
	bool dropItem(uint8_t slot, uint8_t count);
	void dropAllOnDeath();
	bool splitItem(uint8_t slot);
	bool stackItem(uint32_t dragUid, uint16_t dragIid, uint32_t targetUid);

	int8_t findItemByUidSlot(uint32_t uid, uint16_t iid) const;
	// Slot lookups for the mod change, which names items by uid alone.
	int8_t findSlotByUid(uint32_t uid) const;
	int8_t findSlotByWireUid(uint8_t wireUid) const;
	int8_t firstFreeSlot() const;
	// Applies a planned mod change (Player::planModChange checked it). The mod
	// at modSlot goes onto the gun; whatever it replaces takes that slot, or
	// freeSlot when removing. Rounds follow their magazine.
	void applyModChange(uint8_t gunSlot, ModSlot slot, int8_t modSlot, int8_t freeSlot);
	Item* getItem(uint8_t slot) const;
	uint8_t getSlotCount() const { return static_cast<uint8_t>(slots.size()); }
	void expand(uint8_t extraSlots) { slots.resize(slots.size() + extraSlots); }


    struct ExchangePlan {
        std::vector<std::unique_ptr<Item>> slots;
        std::vector<TradeItem> overflow;
    };
    bool prepareExchange(const std::vector<TradeItem>& outgoing, const std::vector<TradeItem>& incoming, ExchangePlan& plan) const;
    void commitExchange(ExchangePlan&& plan);
	void update(uint32_t elapsedMs);

private:
	// The only place an item enters an inventory. Guarantees the invariant the
	// whole item protocol rests on -- see the comment on its definition.
	std::unique_ptr<Item> makeItem(uint16_t iid, uint8_t count, const ItemState& state) const;
	bool isWireUidTaken(uint8_t wireUid) const;
	void syncSlot(Item& item) const;

	Player* player;
	std::vector<std::unique_ptr<Item>> slots;
};

#endif // FS_INVENTORY_H
