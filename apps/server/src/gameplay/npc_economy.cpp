// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/player.h"

namespace {
TradeItem snapshot(const Item& item, uint8_t count) {
    return {item.getIID(), item.getUID(), count, ItemState::of(item), item.getCount(), item.getDecayProgress()};
}
bool eligible(const Player* p, const Item* item) {
    // Stock only: unloaded, as it always was, and nothing fitted but the
    // weapon's defaults.
    return item && item->getUID() != p->getEquippedWeaponUID() &&
        item->getUID() != p->getEquippedWearableUID() &&
        item->getAmmo() == getFreshSpawnAmmo(ItemManager::getInstance().getItemData(item->getIID())) &&
        item->getMods() == ItemState::fresh(item->getIID()).mods;
}
}

uint32_t NpcSystem::takeable(const Player* p, uint16_t iid) const {
    uint32_t count = 0;
    for (uint8_t slot = 0; slot < p->inventory.getSlotCount(); ++slot) {
        const Item* item = p->inventory.getItem(slot);
        if (item && item->getIID() == iid && eligible(p, item)) count += item->getCount();
    }
    return count;
}

economy::Money NpcSystem::wallet(const Player* p) const {
    uint64_t amount = 0;
    for (uint8_t slot = 0; slot < p->inventory.getSlotCount(); ++slot) {
        const Item* item = p->inventory.getItem(slot);
        if (!item) continue;
        for (size_t i = 0; i < coins.size(); ++i)
            if (item->getIID() == coins[i]) amount += uint64_t(item->getCount()) * economy::VALUES[i];
    }
    return static_cast<economy::Money>(std::min<uint64_t>(amount, economy::MAX_MONEY));
}

// A simulation performs capacity checks without allocating item UIDs. Only a
// final successful transaction calls the real inventory planner. All coins are packed
// together so fragmented stacks cannot cause false insufficient-space errors.
bool NpcSystem::plan(Player* p, int64_t delta, uint16_t iid, int32_t quantity,
    Inventory::ExchangePlan* result, uint32_t convertAmount, uint8_t denomination,
    const std::vector<std::pair<uint16_t, uint32_t>>& take,
    const std::vector<std::pair<uint16_t, uint32_t>>& give) {
    const int64_t value = int64_t(wallet(p)) + delta;
    if (value < 0 || value > economy::MAX_MONEY || convertAmount > value || denomination > 2) return false;
    struct Slot { uint16_t iid; uint32_t count; uint8_t ammo; };
    std::vector<Slot> slots;
    std::vector<TradeItem> outgoing, incoming;
    std::map<uint16_t, uint32_t> removals;
    for (auto [item, count] : take) removals[item] += count;
    if (quantity < 0) removals[iid] += static_cast<uint32_t>(-quantity);
    for (uint8_t i = 0; i < p->inventory.getSlotCount(); ++i) {
        const Item* item = p->inventory.getItem(i);
        if (!item) { slots.push_back({0, 0, 0}); continue; }
        uint32_t removed = 0;
        if (std::find(coins.begin(), coins.end(), item->getIID()) != coins.end()) removed = item->getCount();
        else if (eligible(p, item)) {
            auto& need = removals[item->getIID()];
            removed = std::min<uint32_t>(need, item->getCount());
            need -= removed;
        }
        if (removed) outgoing.push_back(snapshot(*item, static_cast<uint8_t>(removed)));
        const uint32_t remaining = item->getCount() - removed;
        slots.push_back({remaining ? item->getIID() : uint16_t(0), remaining, item->getAmmo()});
    }
    for (auto [item, count] : removals) if (count) return false;
    auto add = [&](uint16_t item, uint32_t count) {
        const auto* data = ItemManager::getInstance().getItemData(item);
        if (!data || !data->stack || count > slots.size() * 255) return false;
        const auto ammo = getFreshSpawnAmmo(data);
        uint32_t remaining = count;
        for (auto& slot : slots) {
            if (slot.iid != item || slot.ammo != ammo) continue;
            const uint32_t n = std::min<uint32_t>(remaining, data->stack - slot.count);
            slot.count += n; remaining -= n;
        }
        for (auto& slot : slots) {
            if (slot.count || !remaining) continue;
            const uint32_t n = std::min<uint32_t>(remaining, data->stack);
            slot = {item, n, ammo}; remaining -= n;
        }
        if (remaining) return false;
        if (result) while (count) {
            const auto n = static_cast<uint8_t>(std::min<uint32_t>(count, data->stack));
            incoming.push_back({item, 0, n, ItemState::fresh(item), 0, 0}); count -= n;
        }
        return true;
    };
    // Pack currency first; item insertion then merges only compatible stacks.
    auto change = economy::change(static_cast<uint32_t>(value - convertAmount));
    if (convertAmount) {
        if (convertAmount % economy::VALUES[denomination]) return false;
        change[denomination] += convertAmount / economy::VALUES[denomination];
    }
    for (size_t i = 0; i < coins.size(); ++i) if (change[i] && !add(coins[i], change[i])) return false;
    if (quantity > 0 && !add(iid, static_cast<uint32_t>(quantity))) return false;
    for (auto [item, count] : give) if (!add(item, count)) return false;
    return !result || (p->inventory.prepareExchange(outgoing, incoming, *result) && result->overflow.empty());
}

uint32_t NpcSystem::maximum(Player* p, const NpcOffer& offer, bool buy, economy::Money price, uint32_t limit) {
    if (!price) return 0;
    limit = std::min(limit, economy::MAX_QUANTITY);
    if (buy) limit = std::min(limit, wallet(p) / price);
    else {
        uint32_t count = 0;
        for (uint8_t i = 0; i < p->inventory.getSlotCount(); ++i) {
            auto* item = p->inventory.getItem(i);
            if (eligible(p, item) && item->getIID() == offer.iid) count += item->getCount();
        }
        limit = std::min(limit, count);
        limit = std::min(limit, (economy::MAX_MONEY - wallet(p)) / price);
    }
    // Count capacity once. Each candidate then uses integer arithmetic only;
    // no ExchangePlan, heap allocations, or full bag scan inside this loop.
    // Capacity is not monotone when payment/removal frees stacks.
    const auto* data = ItemManager::getInstance().getItemData(offer.iid);
    if (!data || !data->stack) return 0;
    const auto freshAmmo = getFreshSpawnAmmo(data);
    uint32_t empty = 0, merge = 0, removed = 0;
    std::vector<uint32_t> freedAt;
    for (uint8_t slot = 0; slot < p->inventory.getSlotCount(); ++slot) {
        const auto* item = p->inventory.getItem(slot);
        if (!item || std::find(coins.begin(), coins.end(), item->getIID()) != coins.end()) { ++empty; continue; }
        if (item->getIID() != offer.iid) continue;
        if (buy && item->getAmmo() == freshAmmo) merge += data->stack - item->getCount();
        if (!buy && eligible(p, item)) { removed += item->getCount(); freedAt.push_back(removed); }
    }
    const auto carried = wallet(p);
    for (uint32_t n = limit; n; --n) {
        const int64_t total = int64_t(price) * n;
        const auto change = economy::change(static_cast<uint32_t>(buy ? carried - total : carried + total));
        const auto coinSlots = economy::stacks(change[0]) + economy::stacks(change[1]) + economy::stacks(change[2]);
        if (buy) {
            const auto extra = n > merge ? (n - merge + data->stack - 1) / data->stack : 0;
            if (coinSlots + extra <= empty) return n;
        } else {
            const auto freed = std::upper_bound(freedAt.begin(), freedAt.end(), n) - freedAt.begin();
            if (coinSlots <= empty + freed) return n;
        }
    }
    return 0;
}

bool NpcSystem::planExchange(Player* p, int64_t moneyDelta,
    const std::vector<std::pair<uint16_t, uint32_t>>& take,
    const std::vector<std::pair<uint16_t, uint32_t>>& give,
    Inventory::ExchangePlan& out) {
    return plan(p, moneyDelta, 0, 0, &out, 0, 0, take, give);
}
