// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/loot_placement.h"

#include <algorithm>
#include <cmath>
#include <numbers>

// File-local names carry a lootPlacement prefix: the server builds as unity
// files, where an unprefixed helper collides with another file's.
namespace {
constexpr float lootPlacementPi = std::numbers::pi_v<float>;

float lootPlacementRing(float radius, int ring)
{
	return radius + static_cast<float>(ring) * loot_placement::kSpacing;
}

// How many piles fit round a ring with neighbours kSpacing apart. Measured on
// the chord, not the arc: the chord is the real distance and is the shorter.
int lootPlacementCapacity(float ringRadius)
{
	if (ringRadius * 2.0f <= loot_placement::kSpacing) return 1;
	const float slot = 2.0f * std::asin(loot_placement::kSpacing / (2.0f * ringRadius));
	return std::max(1, static_cast<int>(std::floor(2.0f * lootPlacementPi / slot)));
}

Position lootPlacementAt(const Position& origin, float angle, float ringRadius, const loot_placement::Area& area)
{
	const int32_t x = origin.getX() + static_cast<int32_t>(std::lround(std::cos(angle) * ringRadius));
	const int32_t y = origin.getY() + static_cast<int32_t>(std::lround(std::sin(angle) * ringRadius));
	return Position(static_cast<uint16_t>(std::clamp(x, 0, area.maxX)),
	                static_cast<uint16_t>(std::clamp(y, 0, area.maxY)));
}

bool lootPlacementClear(const Position& p, std::span<const Position> piles)
{
	constexpr float gapSq = loot_placement::kGap * loot_placement::kGap;
	for (const Position& q : piles) {
		const float dx = static_cast<float>(p.getX() - q.getX());
		const float dy = static_cast<float>(p.getY() - q.getY());
		if (dx * dx + dy * dy < gapSq) return false;
	}
	return true;
}

// The i-th step of the search outward from a target slot: 0, +1, -1, +2, -2...
float lootPlacementSweep(int i)
{
	const int k = (i + 1) / 2;
	return static_cast<float>(i % 2 != 0 ? k : -k);
}
} // namespace

Position loot_placement::directed(const Position& origin, float angle, float radius,
                                  std::span<const Position> occupied, const Area& area)
{
	for (int ring = 0; ring < kMaxRings; ++ring) {
		const float r = lootPlacementRing(radius, ring);
		const int cap = lootPlacementCapacity(r);
		const float slot = 2.0f * lootPlacementPi / static_cast<float>(cap);
		for (int i = 0; i < cap; ++i) {
			const Position p = lootPlacementAt(origin, angle + lootPlacementSweep(i) * slot, r, area);
			if (lootPlacementClear(p, occupied)) return p;
		}
	}
	// Every ring is full: land straight ahead on top of whatever is there.
	return lootPlacementAt(origin, angle, radius, area);
}

std::vector<Position> loot_placement::burst(const Position& origin, size_t count, float radius, float startAngle,
                                            std::span<const Position> occupied, const Area& area)
{
	std::vector<Position> out;
	out.reserve(count);
	// What is on the ground plus what this burst has already placed.
	std::vector<Position> taken(occupied.begin(), occupied.end());

	for (int ring = 0; ring < kMaxRings && out.size() < count; ++ring) {
		const float r = lootPlacementRing(radius, ring);
		const int cap = lootPlacementCapacity(r);
		const size_t take = std::min(count - out.size(), static_cast<size_t>(cap));
		// Spread what this ring takes evenly round it; a target that is
		// already covered slides half a slot at a time to the nearest gap.
		const float step = 2.0f * lootPlacementPi / static_cast<float>(take);
		const float half = lootPlacementPi / static_cast<float>(cap);
		for (size_t m = 0; m < take; ++m) {
			const float target = startAngle + static_cast<float>(m) * step;
			for (int i = 0; i < 2 * cap; ++i) {
				const Position p = lootPlacementAt(origin, target + lootPlacementSweep(i) * half, r, area);
				if (lootPlacementClear(p, taken)) {
					out.push_back(p);
					taken.push_back(p);
					break;
				}
			}
		}
	}

	// Every ring is full: pile the rest round the first ring regardless.
	constexpr float goldenAngle = 2.39996323f;
	while (out.size() < count) {
		out.push_back(lootPlacementAt(origin, startAngle + static_cast<float>(out.size()) * goldenAngle, radius, area));
	}
	return out;
}

float loot_placement::reach(float radius)
{
	return lootPlacementRing(radius, kMaxRings - 1) + kGap;
}
