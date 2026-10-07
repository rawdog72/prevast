// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_LOOT_PLACEMENT_H
#define FS_LOOT_PLACEMENT_H

#include "core/position.h"

#include <span>
#include <vector>

// Where dropped loot lands. Pure geometry: the caller passes the piles already
// on the ground near the drop, so this never touches the map or the game and
// the self-test drives it directly.
//
// Piles sit on rings around the drop origin, at least kGap apart from each
// other and from what is already there. Obstacles are deliberately ignored:
// throwing loot under a wall to hide it is part of the game.
namespace loot_placement {

// Centre-to-centre spacing between piles. Ground sprites draw about 55-90
// units wide, so neighbours overlap at the edges but each stays readable.
inline constexpr float kSpacing = 50.0f;
// Two piles closer than this are on top of each other. Below kSpacing so the
// integer rounding of positions on one ring never rejects its own neighbour.
inline constexpr float kGap = kSpacing * 0.9f;
inline constexpr int kMaxRings = 5;

// Inclusive map bounds every landing spot is clamped to.
struct Area {
	int32_t maxX;
	int32_t maxY;
};

// One item thrown by someone facing `angle` (radians): the slot on the first
// ring nearest the facing direction, alternating left and right, so repeated
// drops without turning fan around the thrower. A full ring spills outward.
Position directed(const Position& origin, float angle, float radius,
                  std::span<const Position> occupied, const Area& area);

// `count` items from one event (a death, an overflow, a reward), spread evenly
// around origin from `startAngle`. What does not fit the first ring goes on the
// next, and slots already holding a pile are skipped.
std::vector<Position> burst(const Position& origin, size_t count, float radius, float startAngle,
                            std::span<const Position> occupied, const Area& area);

// The outermost ring's radius plus the gap: how far around origin the caller
// has to look for piles that could be in the way.
float reach(float radius);

int runSelfTest();

} // namespace loot_placement

#endif // FS_LOOT_PLACEMENT_H
