// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_POSITION_H
#define FS_POSITION_H

#include "core/definitions.h"

#include <algorithm>
#include <cmath>

enum Direction : uint8_t
{
	DIRECTION_NORTH = 8,
	DIRECTION_EAST = 2,
	DIRECTION_SOUTH = 4,
	DIRECTION_WEST = 1,
	DIRECTION_SOUTHWEST = 5,
	DIRECTION_SOUTHEAST = 6,
	DIRECTION_NORTHWEST = 9,
	DIRECTION_NORTHEAST = 10,
	DIRECTION_NONE = 0
};

namespace tfs {

	inline constexpr auto abs(std::integral auto num) { return num < 0 ? -num : num; }

} // namespace tfs

struct Position
{
	constexpr Position() = default;
	constexpr Position(uint16_t x, uint16_t y) : x(x), y(y) {}

	constexpr bool isInRange(const Position& p, int32_t deltax, int32_t deltay) const
	{
		return getDistanceX(p) <= deltax && getDistanceY(p) <= deltay;
	}

	constexpr bool isInRange(const Position& p, int32_t deltax, int32_t deltay, int16_t) const
	{
		return getDistanceX(p) <= deltax && getDistanceY(p) <= deltay;
	}

	constexpr int32_t getOffsetX(const Position& p) const { return getX() - p.getX(); }
	constexpr int32_t getOffsetY(const Position& p) const { return getY() - p.getY(); }

	constexpr int32_t getDistanceX(const Position& p) const { return tfs::abs(getOffsetX(p)); }
	constexpr int32_t getDistanceY(const Position& p) const { return tfs::abs(getOffsetY(p)); }
	
	int32_t getDistance(const Position& p) const {
		int32_t dx = getOffsetX(p);
		int32_t dy = getOffsetY(p);
		return static_cast<int32_t>(std::sqrt(dx * dx + dy * dy));
	}

	uint16_t x = 0;
	uint16_t y = 0;

	constexpr bool operator==(const Position& p) const { return std::tie(x, y) == std::tie(p.x, p.y); }
	constexpr bool operator!=(const Position& p) const { return std::tie(x, y) != std::tie(p.x, p.y); }

	constexpr int32_t getX() const { return x; }
	constexpr int32_t getY() const { return y; }
};

std::ostream& operator<<(std::ostream&, const Position&);

// True when target's tile is within `tiles` tiles (Chebyshev) of center's tile.
inline bool isWithinTileArea(const Position& center, const Position& target, uint16_t tiles)
{
	const int32_t dx = tfs::abs(center.getX() / TILE_SIZE - target.getX() / TILE_SIZE);
	const int32_t dy = tfs::abs(center.getY() / TILE_SIZE - target.getY() / TILE_SIZE);
	return std::max(dx, dy) <= static_cast<int32_t>(tiles);
}

// Area effects support two shapes: `area` = N tiles around the source's tile
// (a (2N+1)x(2N+1) tile square), otherwise `radius` = circular pixel range.
//
// >= 0, not > 0: area="0" is the legal single-tile case (the emitter's own tile
// and nothing else). Absent is -1. See AreaEffect::area.
inline bool isWithinAreaEffect(const AreaEffect& effect, const Position& source, const Position& target)
{
	if (effect.area >= 0) {
		return isWithinTileArea(source, target, static_cast<uint16_t>(effect.area));
	}
	return source.getDistance(target) <= effect.radius;
}

#endif // FS_POSITION_H
