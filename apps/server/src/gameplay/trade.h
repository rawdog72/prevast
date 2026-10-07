// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/item.h"
#include <cstdint>
#include <vector>

inline constexpr uint8_t TRADE_RANGE_TILES = 2;
inline constexpr uint8_t TRADE_MAX_OFFERS = 32;

struct TradeItem {
    uint16_t iid = 0;
    uint32_t uid = 0; // Full server identity; only its low byte travels to clients.
    uint8_t count = 0;
    // Ammo byte and fitted mods. Part of the offer: validateTrade compares both,
    // so a gun cannot change between the offer and the accept.
    ItemState state = ItemState::withAmmo(0);
    uint8_t inventoryCount = 0;
    uint32_t decayProgress = 0;
};

struct TradeSession {
    uint32_t id = 0;
    uint32_t revision = 1;
    uint32_t players[2]{};
    bool open = false;
    bool accepted[2]{};
    uint64_t expiresAt = 0;
    std::vector<TradeItem> offers[2];
};
