// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/area_fill.h"
#include <algorithm>
#include <array>
#include <cmath>

namespace {
// Offsets span [-kMaxRadius, kMaxRadius] on each axis, so a flat table of that
// square answers "covered?" and "blocked?" without hashing.
constexpr int areaFillSide = 2 * area_fill::kMaxRadius + 1;

int areaFillIndex(int dx, int dy)
{
	return (dy + area_fill::kMaxRadius) * areaFillSide + (dx + area_fill::kMaxRadius);
}
} // namespace

namespace {
// 0..1 per tile and seed, stable: the same cloud asks the same tile the same.
float areaFillNoise(int dx, int dy, uint32_t seed)
{
	uint32_t h = static_cast<uint32_t>(dx + 0x8000) * 0x9E3779B1u ^ static_cast<uint32_t>(dy + 0x8000) * 0x85EBCA77u ^ seed;
	h ^= h >> 15;
	h *= 0x2C1B3C6Du;
	h ^= h >> 12;
	h *= 0x297A2D39u;
	h ^= h >> 15;
	return static_cast<float>(h & 0xFFFFFF) / static_cast<float>(0x1000000);
}
} // namespace

std::vector<area_fill::Cell> area_fill::fill(int maxCells, float maxRadius,
                                              const std::function<bool(int dx, int dy)>& blocked)
{
	Shape shape;
	shape.maxCells = maxCells;
	shape.maxRadius = maxRadius;
	return fill(shape, blocked);
}

std::vector<area_fill::Cell> area_fill::fill(const Shape& shape, const std::function<bool(int dx, int dy)>& blocked)
{
	const int maxCells = std::clamp(shape.maxCells, 1, kMaxCells);
	const float maxRadius = std::clamp(shape.maxRadius, 0.0f, static_cast<float>(kMaxRadius));

	// The measured distance of every tile in the window, worked out once.
	float dirX = shape.dirX;
	float dirY = shape.dirY;
	const float dirLength = std::sqrt(dirX * dirX + dirY * dirY);
	const bool directed = dirLength > 1e-4f;
	if (directed) {
		dirX /= dirLength;
		dirY /= dirLength;
	}
	const float stretch = std::max(1.0f, shape.stretch);
	const float irregular = std::clamp(shape.irregular, 0.0f, 1.0f);
	std::array<float, areaFillSide * areaFillSide> distance{};
	for (int y = -kMaxRadius; y <= kMaxRadius; ++y) {
		for (int x = -kMaxRadius; x <= kMaxRadius; ++x) {
			float d2 = 0.0f;
			if (!directed) {
				d2 = static_cast<float>(x * x + y * y);
			} else {
				const float along = static_cast<float>(x) * dirX + static_cast<float>(y) * dirY - shape.forward;
				const float across = -static_cast<float>(x) * dirY + static_cast<float>(y) * dirX;
				d2 = shape.line ? along * along + (across / stretch) * (across / stretch)
				                : (along / stretch) * (along / stretch) + across * across;
			}
			float d = std::sqrt(d2);
			if (irregular > 0.0f && (x != 0 || y != 0)) {
				d *= 1.0f + irregular * (areaFillNoise(x, y, shape.seed) - 0.5f);
			}
			distance[areaFillIndex(x, y)] = d;
		}
	}
	const auto distanceOf = [&](int x, int y) { return distance[areaFillIndex(x, y)]; };

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
				if (x < -kMaxRadius || x > kMaxRadius || y < -kMaxRadius || y > kMaxRadius) continue;
				if (distanceOf(x, y) > maxRadius) continue;
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
		auto nearest = std::min_element(frontier.begin(), frontier.end(), [&](const Cell& a, const Cell& b) {
			const float da = distanceOf(a.dx, a.dy);
			const float db = distanceOf(b.dx, b.dy);
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
