// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/aim_view.h"
#include <algorithm>
#include <cmath>
#include <fmt/format.h>
#include <numbers>
#include <span>
#include <string_view>

namespace {
// The shape as content writes it, for messages.
const char* aimViewShapeName(ViewShape shape)
{
	switch (shape) {
	case ViewShape::Stretch: return "stretch";
	case ViewShape::Shift: return "shift";
	case ViewShape::Cone: return "cone";
	case ViewShape::Rect: return "rect";
	default: return "none";
	}
}

// A strong view toward angleRad: the inner and outer shapes in the aim's
// frame, and the bounds of the outer shape plus the rear circle.
StrongView aimViewStrongShape(const ViewData& view, double angleRad)
{
	StrongView s;
	s.shape = view.shape;
	s.dirX = std::cos(angleRad);
	s.dirY = std::sin(angleRad);
	const double rear = view.rearRadius;
	s.rear2 = rear * rear;
	// The bounds start as the rear circle, which holds the player (the cone's
	// apex), and grow to every extreme point of the outer shape.
	double minX = -rear, maxX = rear, minY = -rear, maxY = rear;
	const auto take = [&](double x, double y) {
		minX = std::min(minX, x);
		maxX = std::max(maxX, x);
		minY = std::min(minY, y);
		maxY = std::max(maxY, y);
	};
	if (view.shape == ViewShape::Cone) {
		const double toRad = std::numbers::pi / 180.0;
		const double half = view.halfAngleDeg * toRad;
		const double outerHalf = (view.halfAngleDeg + aim_view::OUTER_CONE_DEG) * toRad;
		const double reach = view.reach;
		const double outerReach = reach * aim_view::OUTER_REACH;
		s.inner.reach2 = reach * reach;
		s.inner.cos2Half = std::cos(half) * std::cos(half);
		s.outer.reach2 = outerReach * outerReach;
		s.outer.cos2Half = std::cos(outerHalf) * std::cos(outerHalf);
		// The outer sector's extremes: both edges' far ends, and wherever its arc crosses an axis.
		for (const double edge : {angleRad - outerHalf, angleRad + outerHalf}) {
			take(outerReach * std::cos(edge), outerReach * std::sin(edge));
		}
		for (int quarter = 0; quarter < 4; ++quarter) {
			const double axis = quarter * std::numbers::pi / 2.0;
			if (std::fabs(std::remainder(axis - angleRad, 2.0 * std::numbers::pi)) <= outerHalf) {
				take(outerReach * std::cos(axis), outerReach * std::sin(axis));
			}
		}
	} else {
		s.inner.back = view.back;
		s.inner.length = view.length;
		s.inner.halfWidth = view.width / 2.0;
		s.outer.back = view.back;
		s.outer.length = view.length * aim_view::OUTER_REACH;
		s.outer.halfWidth = (view.width + aim_view::OUTER_RECT_WIDTH) / 2.0;
		for (const double along : {-s.outer.back, s.outer.length}) {
			for (const double across : {-s.outer.halfWidth, s.outer.halfWidth}) {
				take(along * s.dirX - across * s.dirY, along * s.dirY + across * s.dirX);
			}
		}
	}
	s.bounds = {static_cast<int32_t>(std::floor(minX)), static_cast<int32_t>(std::ceil(maxX)),
		static_cast<int32_t>(std::floor(minY)), static_cast<int32_t>(std::ceil(maxY))};
	return s;
}
} // namespace

std::vector<std::string> aim_view::parseAim(const pugi::xml_node& node, const std::string& owner, float hipSpread, AimData& out)
{
	std::vector<std::string> problems;
	out = AimData{};
	for (const char* name : {"spreadPercent", "movePercent", "timeMs"}) {
		if (!node.attribute(name)) problems.push_back(fmt::format("{} <aim> needs {}=", owner, name));
	}
	if (!problems.empty()) return problems;

	const double spreadPercent = node.attribute("spreadPercent").as_double();
	const double movePercent = node.attribute("movePercent").as_double();
	const int timeMs = node.attribute("timeMs").as_int();
	// Written as !(in range) so that NaN, which compares false either way, is rejected.
	if (!(spreadPercent >= -95.0 && spreadPercent <= 0.0)) {
		problems.push_back(fmt::format("{} <aim> spreadPercent={} must be from -95 to 0", owner, spreadPercent));
	}
	if (!(movePercent >= -90.0 && movePercent <= 0.0)) {
		problems.push_back(fmt::format("{} <aim> movePercent={} must be from -90 to 0", owner, movePercent));
	}
	if (timeMs < 0) {
		problems.push_back(fmt::format("{} <aim> timeMs={} must not be negative", owner, timeMs));
	}
	if (!problems.empty()) return problems;

	out.enabled = true;
	out.spreadPercent = spreadPercent;
	out.movePercent = movePercent;
	out.timeMs = static_cast<uint32_t>(timeMs);
	out.spread = static_cast<float>(hipSpread * (1.0 + spreadPercent / 100.0));
	out.move = static_cast<float>(1.0 + movePercent / 100.0);
	out.ms = out.timeMs;
	return problems;
}

std::vector<std::string> aim_view::parseView(const pugi::xml_node& node, const std::string& owner, ViewData& out)
{
	std::vector<std::string> problems;
	out = ViewData{};
	const std::string shape = node.attribute("shape").as_string();
	// The attributes each shape takes; any other is a problem.
	static constexpr std::string_view weakTakes[] = {"shape", "ahead", "extend", "zoom"};
	static constexpr std::string_view coneTakes[] = {"shape", "reach", "halfAngleDeg", "zoom", "rearRadius"};
	static constexpr std::string_view rectTakes[] = {"shape", "length", "width", "back", "zoom", "rearRadius"};
	ViewShape parsed;
	std::span<const std::string_view> takes;
	if (shape == "stretch" || shape == "shift") {
		parsed = shape == "stretch" ? ViewShape::Stretch : ViewShape::Shift;
		takes = weakTakes;
	} else if (shape == "cone") {
		parsed = ViewShape::Cone;
		takes = coneTakes;
	} else if (shape == "rect") {
		parsed = ViewShape::Rect;
		takes = rectTakes;
	} else {
		problems.push_back(fmt::format(
			"{} <view shape=\"{}\"> is not a view shape: use stretch, shift, cone or rect", owner, shape));
		return problems;
	}
	for (pugi::xml_attribute a = node.first_attribute(); a; a = a.next_attribute()) {
		const std::string_view name = a.name();
		if (std::find(takes.begin(), takes.end(), name) == takes.end()) {
			problems.push_back(fmt::format("{} <view shape=\"{}\"> does not take {}=", owner, shape, name));
		}
	}
	// A number in [min, max]. Required unless `fallback` is given, which is
	// what leaving it out means.
	const auto ranged = [&](const char* name, double min, double max, std::optional<double> fallback = std::nullopt) {
		const pugi::xml_attribute a = node.attribute(name);
		if (!a) {
			if (fallback) return *fallback;
			problems.push_back(fmt::format("{} <view shape=\"{}\"> needs {}=", owner, shape, name));
			return 0.0;
		}
		const double value = a.as_double();
		// !(in range), not (out of range): NaN must be rejected, and casting it below is undefined.
		if (!(value >= min && value <= max)) {
			problems.push_back(fmt::format("{} <view> {}={} must be from {} to {}", owner, name, value, min, max));
		}
		return value;
	};
	// Every number is read and checked before any is cast: a rejected one may be NaN or huge.
	if (parsed == ViewShape::Stretch || parsed == ViewShape::Shift) {
		const double ahead = ranged("ahead", 0.0, 600.0);
		const double extend = ranged("extend", 0.0, 1200.0);
		const double zoom = ranged("zoom", 0.6, 1.0);
		if (!problems.empty()) return problems;
		out.ahead = static_cast<uint16_t>(ahead);
		out.extend = static_cast<uint16_t>(extend);
		out.zoom = static_cast<float>(zoom);
	} else if (parsed == ViewShape::Cone) {
		const double reach = ranged("reach", 200.0, 4000.0);
		const double halfAngleDeg = ranged("halfAngleDeg", 1.0, 60.0);
		const double zoom = ranged("zoom", 0.4, 1.0);
		const double rearRadius = ranged("rearRadius", 150.0, 600.0);
		if (!problems.empty()) return problems;
		out.reach = static_cast<uint16_t>(reach);
		out.halfAngleDeg = static_cast<float>(halfAngleDeg);
		out.zoom = static_cast<float>(zoom);
		out.rearRadius = static_cast<uint16_t>(rearRadius);
	} else {
		const double length = ranged("length", 200.0, 4000.0);
		const double width = ranged("width", 100.0, 2000.0);
		const double back = ranged("back", 0.0, 500.0, 0.0);
		const double zoom = ranged("zoom", 0.4, 1.0);
		const double rearRadius = ranged("rearRadius", 150.0, 600.0);
		if (!problems.empty()) return problems;
		out.length = static_cast<uint16_t>(length);
		out.width = static_cast<uint16_t>(width);
		out.back = static_cast<uint16_t>(back);
		out.zoom = static_cast<float>(zoom);
		out.rearRadius = static_cast<uint16_t>(rearRadius);
	}
	out.shape = parsed;
	return problems;
}

std::optional<std::string> aim_view::weakReachProblem(const ViewData& view, const std::string& owner, int32_t viewX, int32_t viewY)
{
	if (!view.weak()) return std::nullopt;
	// What a client zoomed all the way out draws on each side of its camera.
	const int32_t drawnX = static_cast<int32_t>(CLIENT_VIEW_WIDTH / 2 / CLIENT_ZOOM_MIN);
	const int32_t drawnY = static_cast<int32_t>(CLIENT_VIEW_HEIGHT / 2 / CLIENT_ZOOM_MIN);
	const int32_t needed = static_cast<int32_t>(view.ahead) + std::max(drawnY - viewY, drawnX - viewX);
	if (static_cast<int32_t>(view.extend) < needed) {
		return fmt::format("{} <view> extend={} falls short of the screen: with maxViewportX {} and maxViewportY {} "
			"it needs at least {} (ahead {} plus what a client zoomed out to {} draws past the box), or entities "
			"pop in at the edge", owner, view.extend, viewX, viewY, needed, view.ahead, CLIENT_ZOOM_MIN);
	}
	// A shift moves the whole box: past this it would take the player's own
	// record, or the SHIFT_KEEP_BEHIND units behind them, out of what they are sent.
	const int32_t most = std::min(viewX, viewY) - SHIFT_KEEP_BEHIND;
	if (view.shape == ViewShape::Shift && static_cast<int32_t>(view.extend) > most) {
		return fmt::format("{} <view shape=\"shift\"> extend={} reaches too far: with maxViewportX {} and maxViewportY {} "
			"it may be at most {} so the player and {} units behind them stay in view",
			owner, view.extend, viewX, viewY, most, SHIFT_KEEP_BEHIND);
	}
	return std::nullopt;
}

double aim_view::strongArea(const ViewData& view)
{
	const double rear = std::numbers::pi * view.rearRadius * view.rearRadius;
	if (view.shape == ViewShape::Cone) {
		const double reach = view.reach;
		return view.halfAngleDeg * std::numbers::pi / 180.0 * reach * reach + rear;
	}
	if (view.shape == ViewShape::Rect) {
		return (static_cast<double>(view.length) + view.back) * view.width + rear;
	}
	return 0.0;
}

std::optional<std::string> aim_view::strongAreaProblem(const ViewData& view, const std::string& owner, int32_t viewX, int32_t viewY)
{
	if (!view.strong()) return std::nullopt;
	const double area = strongArea(view);
	const double budget = 4.0 * viewX * viewY;
	if (area <= budget) return std::nullopt;
	return fmt::format("{} <view shape=\"{}\"> covers {:.0f} square units, more than the {:.0f} of the {} x {} box "
		"a player who is not aiming is sent (maxViewportX {}, maxViewportY {}): a strong scope may see farther, "
		"never more", owner, aimViewShapeName(view.shape), area, budget, 2 * viewX, 2 * viewY, viewX, viewY);
}

std::optional<std::string> aim_view::strongScreenNote(const ViewData& view, const std::string& owner)
{
	if (!view.strong()) return std::nullopt;
	const int32_t reach = view.shape == ViewShape::Cone ? view.reach : view.length;
	const double shown = CLIENT_SCOPE_OFFSET * CLIENT_VIEW_HEIGHT / view.zoom;
	if (reach <= shown) return std::nullopt;
	return fmt::format("note: {} <view shape=\"{}\"> reaches {}, past the {:.0f} a client shows ahead at zoom {} "
		"when aiming along the screen's short side; its far end is off screen there",
		owner, aimViewShapeName(view.shape), reach, shown, view.zoom);
}

bool aim_view::aimShouldBeActive(bool held, bool alive, bool ghoul, bool canAim, bool busy)
{
	return held && alive && !ghoul && canAim && !busy;
}

float aim_view::spreadAt(float hip, const AimData& aim, bool active, uint64_t elapsedMs)
{
	if (!active || !aim.enabled) return hip;
	if (aim.ms == 0 || elapsedMs >= aim.ms) return aim.spread;
	const float t = static_cast<float>(elapsedMs) / static_cast<float>(aim.ms);
	return hip + (aim.spread - hip) * t;
}

PlayerView aim_view::normalView(int32_t viewX, int32_t viewY)
{
	PlayerView v;
	v.box = {-viewX, viewX, -viewY, viewY};
	return v;
}

PlayerView aim_view::aimedView(const ViewData& view, int32_t viewX, int32_t viewY, double angleRad)
{
	PlayerView v = normalView(viewX, viewY);
	if (view.strong()) {
		// Only the shape and the rear circle are sent, but scenery keeps coming
		// from the normal box grown to the shape's bounds, so the terrain and
		// buildings all along the shape are there under the mask.
		v.strong = aimViewStrongShape(view, angleRad);
		const ViewBox& b = v.strong.bounds;
		v.box.minDX = std::min(v.box.minDX, b.minDX);
		v.box.maxDX = std::max(v.box.maxDX, b.maxDX);
		v.box.minDY = std::min(v.box.minDY, b.minDY);
		v.box.maxDY = std::max(v.box.maxDY, b.maxDY);
		return v;
	}
	if (!view.weak()) return v;
	// Truncated toward zero, as apps/client/src/world/aim-view.ts does: both run view-cases.json.
	const int32_t ex = static_cast<int32_t>(view.extend * std::cos(angleRad));
	const int32_t ey = static_cast<int32_t>(view.extend * std::sin(angleRad));
	if (view.shape == ViewShape::Shift) {
		v.box.minDX += ex;
		v.box.maxDX += ex;
		v.box.minDY += ey;
		v.box.maxDY += ey;
	} else {
		(ex > 0 ? v.box.maxDX : v.box.minDX) += ex;
		(ey > 0 ? v.box.maxDY : v.box.minDY) += ey;
	}
	v.offX = ex;
	v.offY = ey;
	v.stretch = view.shape == ViewShape::Stretch;
	return v;
}

double aim_view::rotationToRadians(uint8_t rotation)
{
	return static_cast<double>(rotation) * 2.0 * std::numbers::pi / 255.0;
}

bool aim_view::cosmeticReach(const PlayerView& v, int32_t dx, int32_t dy, int32_t radius)
{
	// A strong view: the shape replaces the radius, and canSee has tested it.
	if (v.strong.shape != ViewShape::None) return true;
	double cx = 0.0, cy = 0.0;
	if (v.offX != 0 || v.offY != 0) {
		double t = 1.0;
		if (v.stretch) {
			const double len2 = static_cast<double>(v.offX) * v.offX + static_cast<double>(v.offY) * v.offY;
			t = std::clamp((static_cast<double>(dx) * v.offX + static_cast<double>(dy) * v.offY) / len2, 0.0, 1.0);
		}
		cx = t * v.offX;
		cy = t * v.offY;
	}
	const double ex = dx - cx;
	const double ey = dy - cy;
	return ex * ex + ey * ey <= static_cast<double>(radius) * radius;
}

bool aim_view::mayWatch(const PlayerView& v, int32_t dx, int32_t dy, int32_t radius, int32_t margin)
{
	if (dx < v.box.minDX - margin || dx > v.box.maxDX + margin ||
	    dy < v.box.minDY - margin || dy > v.box.maxDY + margin) {
		return false;
	}
	if (radius <= 0) return true;
	if (v.strong.shape != ViewShape::None) {
		// Cosmetic events come from anywhere in the shape; projectiles from
		// around the player, as for anyone (spawnProjectiles' canSeeWithin).
		const ViewBox& b = v.strong.bounds;
		if (dx >= b.minDX - margin && dx <= b.maxDX + margin && dy >= b.minDY - margin && dy <= b.maxDY + margin) {
			return true;
		}
		const int32_t around = radius + margin;
		return dx >= -around && dx <= around && dy >= -around && dy <= around;
	}
	// The whole segment from the player to the offset, for either shape: the
	// radius serves the cosmetic gather (a circle that a shift moves and a
	// stretch sweeps) and the projectile gather (a circle around the shooter
	// that the viewer's own box then filters), and this bound covers both.
	const int32_t loX = std::min(0, v.offX);
	const int32_t hiX = std::max(0, v.offX);
	const int32_t loY = std::min(0, v.offY);
	const int32_t hiY = std::max(0, v.offY);
	const int32_t reach = radius + margin;
	return dx >= loX - reach && dx <= hiX + reach && dy >= loY - reach && dy <= hiY + reach;
}

bool aim_view::strongContains(const StrongView& s, int32_t dx, int32_t dy, bool outer)
{
	const double x = dx;
	const double y = dy;
	const double dist2 = x * x + y * y;
	if (dist2 <= s.rear2) return true;
	const ShapeSize& size = outer ? s.outer : s.inner;
	const double along = x * s.dirX + y * s.dirY;
	if (s.shape == ViewShape::Cone) {
		return along > 0.0 && dist2 <= size.reach2 && along * along >= dist2 * size.cos2Half;
	}
	if (s.shape == ViewShape::Rect) {
		const double across = y * s.dirX - x * s.dirY;
		return along >= -size.back && along <= size.length && std::fabs(across) <= size.halfWidth;
	}
	return false;
}

bool aim_view::viewContains(const PlayerView& v, int32_t dx, int32_t dy)
{
	if (v.strong.shape == ViewShape::None) return v.box.containsInclusive(dx, dy);
	return v.strong.bounds.containsInclusive(dx, dy) && strongContains(v.strong, dx, dy, true);
}
