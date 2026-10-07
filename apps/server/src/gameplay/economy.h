// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <array>
#include <cstdint>
#include <limits>

namespace economy {
using Money = uint32_t;
inline constexpr Money MAX_MONEY = 2000000000;
inline constexpr uint32_t MAX_QUANTITY = 4096;
inline constexpr std::array<Money, 3> VALUES{1, 255, 65025};
inline uint32_t stacks(uint32_t count) { return (count + 254) / 255; }

// One full stack exchanges for one unit of the next denomination. Base-255
// decomposition gives exact change with minimum occupied currency slots.
inline std::array<uint32_t, 3> change(Money value) {
    return {value % VALUES[1], (value / VALUES[1]) % 255, value / VALUES[2]};
}
inline bool price(Money unit, uint32_t quantity, Money& total) {
    const uint64_t n = uint64_t(unit) * quantity;
    if (!quantity || quantity > MAX_QUANTITY || n > MAX_MONEY) return false;
    total = static_cast<Money>(n);
    return true;
}
inline Money adjusted(Money value, uint32_t bps, bool buy) {
    const uint64_t n = (uint64_t(value) * bps + (buy ? 9999 : 0)) / 10000;
    return n > MAX_MONEY ? 0 : static_cast<Money>(n);
}
}
