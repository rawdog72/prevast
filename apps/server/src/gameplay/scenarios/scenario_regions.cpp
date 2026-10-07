// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/scenarios/scenario_regions.h"

#include "core/definitions.h"

#include <algorithm>
#include <cmath>
#include <fmt/color.h>
#include <fmt/format.h>
#include <map>

namespace scenario {
namespace {

constexpr int32_t CELL = 8 * TILE_SIZE;

int64_t cellKey(int32_t cx, int32_t cy)
{
	return (static_cast<int64_t>(cy) << 20) | static_cast<int64_t>(cx);
}

int32_t cellOf(int32_t units)
{
	return units < 0 ? -1 - (-1 - units) / CELL : units / CELL;
}

} // namespace

int32_t wireRate(double pointsPerMinute)
{
	return static_cast<int32_t>(std::lround(pointsPerMinute / POINTS_PER_MINUTE_PER_RATE));
}

void RegionIndex::clear()
{
	regions.clear();
	byId.clear();
	cells.clear();
	alive = nullptr;
}

void RegionIndex::build(const Project& project, AliveCheck aliveCheck)
{
	clear();
	alive = std::move(aliveCheck);
	std::unordered_map<std::string, std::pair<int32_t, int32_t>> anchors;
	for (const Entity& e : project.entities) anchors.emplace(e.id, std::make_pair(e.x, e.y));

	regions.reserve(project.regions.size());
	for (const Region& region : project.regions) {
		Resolved r;
		r.source = &region;
		r.type = region.shape.type;
		r.attach = region.attach;
		int32_t ox = 0, oy = 0;
		if (!region.attach.empty()) {
			const auto anchor = anchors.find(region.attach);
			if (anchor == anchors.end()) continue; // structural validation rejects this
			ox = anchor->second.first;
			oy = anchor->second.second;
		}
		const Shape& s = region.shape;
		switch (s.type) {
		case ShapeType::Circle:
			r.x = s.x + ox; r.y = s.y + oy; r.r = s.r;
			r.minX = r.x - r.r; r.minY = r.y - r.r; r.maxX = r.x + r.r; r.maxY = r.y + r.r;
			break;
		case ShapeType::Rect:
			r.x = s.x + ox; r.y = s.y + oy; r.w = s.w; r.h = s.h;
			r.minX = r.x; r.minY = r.y; r.maxX = r.x + r.w - 1; r.maxY = r.y + r.h - 1;
			break;
		case ShapeType::Polygon:
			r.minX = r.minY = INT32_MAX;
			r.maxX = r.maxY = INT32_MIN;
			for (const auto& [px, py] : s.points) {
				r.points.emplace_back(px + ox, py + oy);
				r.minX = std::min(r.minX, px + ox); r.minY = std::min(r.minY, py + oy);
				r.maxX = std::max(r.maxX, px + ox); r.maxY = std::max(r.maxY, py + oy);
			}
			break;
		}
		const uint32_t index = static_cast<uint32_t>(regions.size());
		byId.emplace(region.id, index);
		for (int32_t cy = cellOf(r.minY); cy <= cellOf(r.maxY); ++cy)
			for (int32_t cx = cellOf(r.minX); cx <= cellOf(r.maxX); ++cx)
				cells[cellKey(cx, cy)].push_back(index);
		regions.push_back(std::move(r));
	}
}

std::optional<size_t> RegionIndex::indexOf(const std::string& regionId) const
{
	const auto it = byId.find(regionId);
	return it == byId.end() ? std::nullopt : std::optional<size_t>(it->second);
}

void RegionIndex::bounds(size_t index, int32_t& minX, int32_t& minY, int32_t& maxX, int32_t& maxY) const
{
	const Resolved& r = regions[index];
	minX = r.minX; minY = r.minY; maxX = r.maxX; maxY = r.maxY;
}

bool RegionIndex::live(const Resolved& r) const
{
	if (r.dead) return false;
	if (!r.attach.empty() && alive && !alive(r.attach)) r.dead = true;
	return !r.dead;
}

bool RegionIndex::inside(const Resolved& r, int32_t x, int32_t y) const
{
	if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) return false;
	switch (r.type) {
	case ShapeType::Circle: {
		const int64_t dx = x - r.x, dy = y - r.y;
		return dx * dx + dy * dy <= static_cast<int64_t>(r.r) * r.r;
	}
	case ShapeType::Rect:
		return true; // the bounding box is the rectangle
	case ShapeType::Polygon: {
		// Even-odd crossing test on integers; a point on a vertex row counts once.
		bool in = false;
		const size_t n = r.points.size();
		for (size_t i = 0, j = n - 1; i < n; j = i++) {
			const auto [xi, yi] = r.points[i];
			const auto [xj, yj] = r.points[j];
			if ((yi > y) != (yj > y)) {
				// x < xi + (y - yi) * (xj - xi) / (yj - yi), without division.
				const int64_t lhs = static_cast<int64_t>(x - xi) * (yj - yi);
				const int64_t rhs = static_cast<int64_t>(y - yi) * (xj - xi);
				if (yj > yi ? lhs < rhs : lhs > rhs) in = !in;
			}
		}
		return in;
	}
	}
	return false;
}

bool RegionIndex::contains(size_t index, int32_t x, int32_t y) const
{
	return index < regions.size() && live(regions[index]) && inside(regions[index], x, y);
}

double RegionIndex::strength(const Resolved& r, int32_t x, int32_t y) const
{
	switch (r.type) {
	case ShapeType::Circle: {
		const double d = std::hypot(static_cast<double>(x - r.x), static_cast<double>(y - r.y));
		return std::clamp(1.0 - d / r.r, 0.0, 1.0);
	}
	case ShapeType::Rect: {
		const double hw = r.w / 2.0, hh = r.h / 2.0;
		const double dx = std::fabs(x - (r.x + hw)) / hw;
		const double dy = std::fabs(y - (r.y + hh)) / hh;
		return std::clamp(1.0 - std::max(dx, dy), 0.0, 1.0);
	}
	case ShapeType::Polygon:
		return 1.0; // validation allows only even effects on polygons
	}
	return 1.0;
}

const std::vector<uint32_t>* RegionIndex::candidates(int32_t x, int32_t y) const
{
	const auto it = cells.find(cellKey(cellOf(x), cellOf(y)));
	return it == cells.end() ? nullptr : &it->second;
}

std::optional<bool> RegionIndex::permissionAt(PermissionKind kind, int32_t x, int32_t y) const
{
	const std::vector<uint32_t>* list = candidates(x, y);
	if (!list) return std::nullopt;
	std::optional<int32_t> bestPriority;
	bool allowed = true;
	for (const uint32_t i : *list) {
		const Resolved& r = regions[i];
		const Region& src = *r.source;
		const Permission p = kind == PermissionKind::Build ? src.build : kind == PermissionKind::Pvp ? src.pvp : src.spawn;
		if (p == Permission::Inherit || !live(r) || !inside(r, x, y)) continue;
		const bool allow = p == Permission::Allow;
		if (!bestPriority || src.priority > *bestPriority) {
			bestPriority = src.priority;
			allowed = allow;
		} else if (src.priority == *bestPriority && !allow) {
			allowed = false;
		}
	}
	return bestPriority ? std::optional<bool>(allowed) : std::nullopt;
}

StatRates RegionIndex::ratesAt(int32_t x, int32_t y) const
{
	StatRates out{};
	const std::vector<uint32_t>* list = candidates(x, y);
	if (!list) return out;
	struct Channel
	{
		double strongestUp = 0.0;
		double strongestDown = 0.0;
		double sum = 0.0;
	};
	// Few regions overlap one point: a small ordered map keeps the sum's
	// order, and so its rounding, independent of the index's layout.
	std::array<std::map<std::string_view, Channel>, 5> channels;
	static constexpr std::array<std::string_view, 5> STAT_NAMES = { "health", "warmth", "stamina", "radiation", "food" };
	for (const uint32_t i : *list) {
		const Resolved& r = regions[i];
		if (r.source->effects.empty() || !live(r) || !inside(r, x, y)) continue;
		for (const Effect& e : r.source->effects) {
			const double value = e.perMinute * (e.linearFalloff ? strength(r, x, y) : 1.0);
			const size_t stat = static_cast<size_t>(e.stat);
			Channel& c = channels[stat][e.channel.empty() ? STAT_NAMES[stat] : std::string_view(e.channel)];
			if (e.additive) c.sum += value;
			else if (value > 0) c.strongestUp = std::max(c.strongestUp, value);
			else c.strongestDown = std::min(c.strongestDown, value);
		}
	}
	for (size_t stat = 0; stat < channels.size(); ++stat) {
		double total = 0.0;
		for (const auto& [name, c] : channels[stat]) total += c.strongestUp + c.strongestDown + c.sum;
		out[stat] = wireRate(total);
	}
	return out;
}

// --- self-test -----------------------------------------------------------------

int runRegionSelfTest()
{
	int failures = 0;
	auto check = [&](bool ok, const std::string& what) {
		if (!ok) {
			++failures;
			fmt::print(fg(fmt::color::crimson), ">> [region selftest] FAIL {}\n", what);
		}
	};
	auto circle = [](std::string id, int32_t x, int32_t y, int32_t r) {
		Region g;
		g.id = std::move(id);
		g.shape.type = ShapeType::Circle;
		g.shape.x = x; g.shape.y = y; g.shape.r = r;
		return g;
	};
	auto rect = [](std::string id, int32_t x, int32_t y, int32_t w, int32_t h) {
		Region g;
		g.id = std::move(id);
		g.shape.type = ShapeType::Rect;
		g.shape.x = x; g.shape.y = y; g.shape.w = w; g.shape.h = h;
		return g;
	};
	auto effect = [](EffectStat stat, int32_t perMinute, bool linear = false, std::string channel = {}, bool additive = false) {
		Effect e;
		e.stat = stat; e.perMinute = perMinute; e.linearFalloff = linear; e.channel = std::move(channel); e.additive = additive;
		return e;
	};
	const auto rad = static_cast<size_t>(EffectStat::Radiation);

	// Shapes.
	{
		Project p;
		p.regions.push_back(circle("c", 1000, 1000, 300));
		p.regions.push_back(rect("r", 2000, 2000, 400, 200));
		Region poly;
		poly.id = "p";
		poly.shape.type = ShapeType::Polygon;
		poly.shape.points = { { 0, 0 }, { 1000, 0 }, { 1000, 1000 }, { 500, 300 }, { 0, 1000 } }; // notch at the bottom
		p.regions.push_back(poly);
		RegionIndex idx;
		idx.build(p, nullptr);
		check(idx.contains(0, 1000, 1000) && idx.contains(0, 1300, 1000) && !idx.contains(0, 1301, 1000), "circle edge");
		check(idx.contains(1, 2000, 2000) && idx.contains(1, 2399, 2199) && !idx.contains(1, 2400, 2100), "rect is half-open");
		check(idx.contains(2, 100, 100) && idx.contains(2, 900, 800) && !idx.contains(2, 500, 800), "concave polygon notch");
		check(!idx.contains(2, 1500, 500), "outside polygon");
	}
	// Falloff and rounding.
	{
		Project p;
		Region c = circle("c", 1000, 1000, 400);
		c.effects.push_back(effect(EffectStat::Radiation, 90, true));
		p.regions.push_back(c);
		Region r = rect("r", 3000, 3000, 400, 200);
		r.effects.push_back(effect(EffectStat::Warmth, 60, true));
		p.regions.push_back(r);
		RegionIndex idx;
		idx.build(p, nullptr);
		check(idx.ratesAt(1000, 1000)[rad] == 15, "full strength at the centre");
		check(idx.ratesAt(1200, 1000)[rad] == 8, "half strength rounds 7.5 to 8");
		check(idx.ratesAt(1400, 1000)[rad] == 0, "nothing at the edge");
		const auto warm = static_cast<size_t>(EffectStat::Warmth);
		check(idx.ratesAt(3200, 3100)[warm] == 10 && idx.ratesAt(3300, 3100)[warm] == 5 && idx.ratesAt(3200, 3150)[warm] == 5,
			"rectangle falloff by the nearer edge");
		check(wireRate(-9) == -2 && wireRate(3) == 1 && wireRate(2) == 0, "wire rate rounding");
	}
	// Stacking.
	{
		Project p;
		Region a = circle("a", 1000, 1000, 500);
		a.effects.push_back(effect(EffectStat::Radiation, 60));
		Region b = circle("b", 1000, 1000, 500);
		b.effects.push_back(effect(EffectStat::Radiation, 120));
		Region neg = circle("n", 1000, 1000, 500);
		neg.effects.push_back(effect(EffectStat::Radiation, -30));
		Region other = circle("o", 1000, 1000, 500);
		other.effects.push_back(effect(EffectStat::Radiation, 30, false, "shelter"));
		Region add1 = circle("d1", 5000, 5000, 500);
		add1.effects.push_back(effect(EffectStat::Food, 60, false, {}, true));
		Region add2 = circle("d2", 5000, 5000, 500);
		add2.effects.push_back(effect(EffectStat::Food, 120, false, {}, true));
		p.regions = { a, b, neg, other, add1, add2 };
		RegionIndex idx;
		idx.build(p, nullptr);
		// channel "radiation": strongest up 120, strongest down -30 -> 90; plus channel "shelter" 30.
		check(idx.ratesAt(1000, 1000)[rad] == 20, "strongest per direction, channels add");
		check(idx.ratesAt(5000, 5000)[static_cast<size_t>(EffectStat::Food)] == 30, "additive stacking sums");
	}
	// Permissions.
	{
		Project p;
		Region low = rect("low", 0, 0, 1000, 1000);
		low.priority = 1; low.pvp = Permission::Deny; low.build = Permission::Deny;
		Region high = rect("high", 0, 0, 500, 500);
		high.priority = 5; high.pvp = Permission::Allow;
		Region tie = rect("tie", 0, 0, 500, 500);
		tie.priority = 1; tie.build = Permission::Allow;
		p.regions = { low, high, tie };
		RegionIndex idx;
		idx.build(p, nullptr);
		check(idx.permissionAt(PermissionKind::Pvp, 100, 100) == true, "higher priority wins");
		check(idx.permissionAt(PermissionKind::Pvp, 800, 800) == false, "lower region applies alone");
		check(idx.permissionAt(PermissionKind::Build, 100, 100) == false, "deny wins a tie");
		check(!idx.permissionAt(PermissionKind::Spawn, 100, 100).has_value(), "unset permission inherits");
		check(!idx.permissionAt(PermissionKind::Pvp, 5000, 5000).has_value(), "no region inherits");
	}
	// Attached regions follow their placement and die with it.
	{
		Project p;
		Entity barrel;
		barrel.id = "barrel"; barrel.x = 2050; barrel.y = 2050;
		p.entities.push_back(barrel);
		Region field = circle("f", 0, 0, 200);
		field.attach = "barrel";
		field.effects.push_back(effect(EffectStat::Radiation, 60));
		p.regions.push_back(field);
		bool present = true;
		RegionIndex idx;
		idx.build(p, [&](const std::string&) { return present; });
		check(idx.ratesAt(2100, 2050)[rad] == 10, "attached region sits on its placement");
		present = false;
		check(idx.ratesAt(2100, 2050)[rad] == 0, "gone with its placement");
		present = true;
		check(idx.ratesAt(2100, 2050)[rad] == 0, "stays gone when the id comes back");
	}
	// Tick-size independence of the rate itself: the gauge integrates rate *
	// elapsed, so a minute in 1000 ms or 50 ms steps moves the same distance.
	{
		const int32_t rate = wireRate(90);
		double a = 0, b = 0;
		for (int i = 0; i < 60; ++i) a += rate / 10000.0 * 1000;
		for (int i = 0; i < 1200; ++i) b += rate / 10000.0 * 50;
		check(std::lround(a) == 90 && std::lround(b) == 90, "a minute at 90/min is 90 points at any tick size");
	}
	if (failures == 0) fmt::print(fg(fmt::color::green), ">> [region selftest] shapes, falloff, stacking, permissions and attachments agree.\n");
	return failures;
}

} // namespace scenario
