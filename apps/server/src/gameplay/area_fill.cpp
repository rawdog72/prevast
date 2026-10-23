// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/area_fill.h"
#include <algorithm>
#include <array>

namespace {
// Offsets span [-kMaxRadius, kMaxRadius] on each axis, so a flat table of that
// square answers "covered?" and "blocked?" without hashing.
constexpr int areaFillSide = 2 * area_fill::kMaxRadius + 1;

int areaFillIndex(int dx, int dy)
{
	return (dy + area_fill::kMaxRadius) * areaFillSide + (dx + area_fill::kMaxRadius);
}
} // namespace

std::vector<area_fill::Cell> area_fill::fill(int maxCells, float maxRadius,
                                              const std::function<bool(int dx, int dy)>& blocked)
{
	maxCells = std::clamp(maxCells, 1, kMaxCells);
	maxRadius = std::clamp(maxRadius, 0.0f, static_cast<float>(kMaxRadius));
	const float radius2 = maxRadius * maxRadius;

	// 0 unknown, 1 open, 2 blocked: each tile is asked about once.
	std::array<uint8_t, areaFillSide * areaFillSide> state{};
	std::array<bool, areaFillSide * areaFillSide> covered{};
	const auto isBlocked = [&](int dx, int dy) {
		if (dx < -kMaxRadius || dx > kMaxRadius || dy < -kMaxRadius || dy > kMaxRadius) return true;
		uint8_t& s = state[areaFillIndex(dx, dy)];
		if (s == 0) s = blocked(dx, dy) ? 2 : 1;
		return s == 2;
	};

	std::vector<Cell> cells;
	cells.reserve(static_cast<size_t>(maxCells));
	cells.push_back({ 0, 0 });
	covered[areaFillIndex(0, 0)] = true;

	// Candidates: open, uncovered, in range, and next to a covered tile. Kept
	// as a plain list -- a cloud is at most 255 tiles, so picking the nearest
	// by a scan is cheaper than any heap would be at this size.
	std::vector<Cell> frontier;
	std::array<bool, areaFillSide * areaFillSide> queued{};
	const auto offer = [&](int fromX, int fromY) {
		for (int dy = -1; dy <= 1; ++dy) {
			for (int dx = -1; dx <= 1; ++dx) {
				if (dx == 0 && dy == 0) continue;
				const int x = fromX + dx;
				const int y = fromY + dy;
				if (static_cast<float>(x * x + y * y) > radius2) continue;
				if (x < -kMaxRadius || x > kMaxRadius || y < -kMaxRadius || y > kMaxRadius) continue;
				const int index = areaFillIndex(x, y);
				if (covered[index] || queued[index]) continue;
				if (isBlocked(x, y)) continue;
				// Diagonal: both tiles it passes between must be open, or the
				// cloud would leak through a wall corner.
				if (dx != 0 && dy != 0 && (isBlocked(fromX + dx, fromY) || isBlocked(fromX, fromY + dy))) continue;
				queued[index] = true;
				frontier.push_back({ static_cast<int8_t>(x), static_cast<int8_t>(y) });
			}
		}
	};
	offer(0, 0);

	while (static_cast<int>(cells.size()) < maxCells && !frontier.empty()) {
		// Nearest to the origin first; ties broken by position so the result
		// never depends on discovery order.
		auto nearest = std::min_element(frontier.begin(), frontier.end(), [](const Cell& a, const Cell& b) {
			const int da = a.dx * a.dx + a.dy * a.dy;
			const int db = b.dx * b.dx + b.dy * b.dy;
			if (da != db) return da < db;
			if (a.dy != b.dy) return a.dy < b.dy;
			return a.dx < b.dx;
		});
		const Cell next = *nearest;
		*nearest = frontier.back();
		frontier.pop_back();

		covered[areaFillIndex(next.dx, next.dy)] = true;
		cells.push_back(next);
		offer(next.dx, next.dy);
	}
	return cells;
}
