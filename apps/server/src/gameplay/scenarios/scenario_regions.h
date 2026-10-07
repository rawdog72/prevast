// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_REGIONS_H
#define FS_SCENARIO_REGIONS_H

// A running scenario's regions: where they are, which permissions they set and
// what their effects do to a player standing at a point. Pure: no game state,
// so the rules are self-tested (runRegionSelfTest) without a world.
//
// Rules (docs/world-editor.md):
//   * Permissions: the highest-priority region containing the point that sets
//     the permission decides; at equal priority deny wins. No region = inherit.
//   * Effects: per stat and stack channel (default: the stat's name), a
//     "strongest" effect keeps the largest positive and the most negative
//     contribution and "additive" ones sum; channels add. Linear falloff runs
//     from 1 at the centre to 0 at the edge (circles and rectangles only).
//   * The total is a gauge rate in wire units: one unit is 6 points a minute
//     (the gauge wire's rate/10000 per ms), rounded once at the end.
//   * A region attached to a placement stays where it was authored and
//     switches off for good once that placement is gone.

#include "content/scenario_project.h"

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace scenario {

enum class PermissionKind : uint8_t { Build, Pvp, Spawn };

// Signed gauge rates in wire units, indexed by EffectStat. Positive raises the
// server's stored value: health, food and warmth fill, stamina recovers,
// radiation accumulates.
using StatRates = std::array<int32_t, 5>;

// Points per minute a wire rate unit stands for.
inline constexpr int32_t POINTS_PER_MINUTE_PER_RATE = 6;

// perMinute rounded to the rate a player actually gets, as the editor shows it.
int32_t wireRate(double pointsPerMinute);

class RegionIndex
{
public:
	// Whether the placement behind an attached region still exists. Checked on
	// every query; the first "no" disables that region for good.
	using AliveCheck = std::function<bool(const std::string& entityId)>;

	void build(const Project& project, AliveCheck alive);
	void clear();
	bool empty() const { return regions.empty(); }
	size_t size() const { return regions.size(); }

	// std::nullopt when no region at the point sets it.
	std::optional<bool> permissionAt(PermissionKind kind, int32_t x, int32_t y) const;
	StatRates ratesAt(int32_t x, int32_t y) const;

	std::optional<size_t> indexOf(const std::string& regionId) const;
	const Region& region(size_t index) const { return *regions[index].source; }
	bool contains(size_t index, int32_t x, int32_t y) const;
	// Bounding box in world units, inclusive, clipped to nothing.
	void bounds(size_t index, int32_t& minX, int32_t& minY, int32_t& maxX, int32_t& maxY) const;

private:
	struct Resolved
	{
		const Region* source = nullptr;
		ShapeType type = ShapeType::Circle;
		// Absolute: circle centre, rect top-left, polygon points.
		int32_t x = 0, y = 0, r = 0, w = 0, h = 0;
		std::vector<std::pair<int32_t, int32_t>> points;
		int32_t minX = 0, minY = 0, maxX = 0, maxY = 0;
		std::string attach;
		mutable bool dead = false;
	};

	bool live(const Resolved& r) const;
	bool inside(const Resolved& r, int32_t x, int32_t y) const;
	double strength(const Resolved& r, int32_t x, int32_t y) const;
	const std::vector<uint32_t>* candidates(int32_t x, int32_t y) const;

	std::vector<Resolved> regions;
	std::unordered_map<std::string, size_t> byId;
	std::unordered_map<int64_t, std::vector<uint32_t>> cells;
	AliveCheck alive;
};

// Prints failures; returns their count.
int runRegionSelfTest();

} // namespace scenario

#endif // FS_SCENARIO_REGIONS_H
