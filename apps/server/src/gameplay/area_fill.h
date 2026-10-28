// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_AREA_FILL_H
#define FS_AREA_FILL_H

#include <cstdint>
#include <functional>
#include <vector>

// The tiles a cloud (gas, smoke, fire) spreads over, as offsets from the tile it
// started on. Pure geometry: the caller says which tiles are blocked, so this
// never touches the map and the self-test drives it directly.
//
// The cloud grows nearest-first from its origin, one tile at a time, into any
// of the eight neighbours of a tile it already covers -- except a blocked one,
// and except diagonally between two blocked tiles, so it cannot slip through
// the corner where two walls meet. A room fills and stops at its walls; a
// doorway lets it out. The order IS the growth order: a client revealing the
// first k tiles shows exactly what the server has at that moment.
namespace area_fill {

struct Cell {
	int8_t dx = 0;
	int8_t dy = 0;
	bool operator==(const Cell&) const = default;
};

// How far a cloud may reach from its origin, in tiles: the offsets are one
// signed byte each on the wire.
inline constexpr int kMaxRadius = 12;
// How many tiles one cloud may cover: the count is one byte on the wire.
inline constexpr int kMaxCells = 255;

// What "nearest" means, which is what decides the shape. Round by default:
// plain distance from the origin. With a direction (a unit-ish vector the
// thing was travelling along; (0, 0) for none) the distance is measured on an
// ellipse instead:
//   - fill: `stretch` times longer ALONG the direction than across it -- a
//     molotov's splash running on the way the bottle flew;
//   - line: `stretch` times longer ACROSS it -- a wall of smoke laid in front
//     of whoever threw it.
// `forward` moves the middle of that ellipse that many tiles along the
// direction (negative: back), so the shape lands ahead of where it went off.
// `irregular` (0..1) scales each tile's distance by up to +-irregular/2, from
// `seed`, so the edge is ragged instead of a perfect curve. `maxRadius` bounds
// that same measured distance.
struct Shape {
	int maxCells = 1;
	float maxRadius = 0.0f;
	float dirX = 0.0f;
	float dirY = 0.0f;
	float stretch = 1.0f;
	bool line = false;
	float forward = 0.0f;
	float irregular = 0.0f;
	uint32_t seed = 0;
};

// blocked(dx, dy): whether the tile at origin + (dx, dy) cannot hold the cloud.
// Asked at most once per tile. The origin is always covered, blocked or not.
std::vector<Cell> fill(const Shape& shape, const std::function<bool(int dx, int dy)>& blocked);
// A round cloud: fill({ maxCells, maxRadius }).
std::vector<Cell> fill(int maxCells, float maxRadius, const std::function<bool(int dx, int dy)>& blocked);

int runSelfTest();

} // namespace area_fill

#endif // FS_AREA_FILL_H
