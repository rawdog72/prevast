// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include <pugixml.hpp>

// Aiming and scope views: what a weapon's <aim> and a <view> carry, and the
// pure rules they are checked by. No dependencies beyond pugixml, so
// equipment.h and weapon_mods.h can include it. Spec:
// docs/design/aim-and-scopes.md.

// <aim> on a weapon; absent = the weapon cannot aim. The last three are the
// numbers in use: set by the loader from the base, and replaced by
// weapon_mods::resolveWeapon on a moddable gun.
struct AimData {
	bool enabled = false;
	double spreadPercent = 0.0; // [-95, 0]
	double movePercent = 0.0;   // [-90, 0]
	uint32_t timeMs = 0;
	float spread = 0.0f; // aimSpread: the spread once fully aimed
	float move = 1.0f;   // aimMove: the walk-speed multiplier while aiming
	uint32_t ms = 0;     // aimMs: time from the hip spread to the aimed one
};

// What a scope shows while aimed. Weak shapes (stretch, shift) widen the box
// the server sends and slide the client's camera; strong shapes (cone, rect)
// send only what lies inside the shape or a circle around the player.
enum class ViewShape : uint8_t { None, Stretch, Shift, Cone, Rect };

struct ViewData {
	ViewShape shape = ViewShape::None;
	uint16_t ahead = 0;  // weak: client look-ahead while aimed, world units
	uint16_t extend = 0; // weak: server reach toward the aim, world units
	float zoom = 1.0f;   // weak: a factor on the player's zoom; strong: the client's zoom while aimed
	uint16_t reach = 0;        // cone: from the player to the far edge
	float halfAngleDeg = 0.0f; // cone: half the opening angle
	uint16_t length = 0;       // rect: how far ahead of the player it reaches
	uint16_t width = 0;        // rect: across the aim line, centred on it
	uint16_t back = 0;         // rect: how far behind the player it starts
	uint16_t rearRadius = 0;   // strong: the circle around the player that is always sent
	bool weak() const { return shape == ViewShape::Stretch || shape == ViewShape::Shift; }
	bool strong() const { return shape == ViewShape::Cone || shape == ViewShape::Rect; }
	bool operator==(const ViewData&) const = default;
};

// What a player is sent, as offsets from their position. The visibility scan
// keeps its strict test and canSee its inclusive one, so a player who is not
// aiming sees exactly what they saw before this existed.
struct ViewBox {
	int32_t minDX = 0, maxDX = 0, minDY = 0, maxDY = 0;
	bool containsStrict(int32_t dx, int32_t dy) const
	{
		return dx > minDX && dx < maxDX && dy > minDY && dy < maxDY;
	}
	bool containsInclusive(int32_t dx, int32_t dy) const
	{
		return dx >= minDX && dx <= maxDX && dy >= minDY && dy <= maxDY;
	}
	bool operator==(const ViewBox&) const = default;
};

// One size of a strong shape, in the aim's frame. A cone uses reach2 and
// cos2Half; a rect uses back, length and halfWidth.
struct ShapeSize {
	double reach2 = 0.0;    // reach squared
	double cos2Half = 0.0;  // cos squared of the half angle
	double back = 0.0;      // how far behind the player the rect starts
	double length = 0.0;    // how far ahead it reaches
	double halfWidth = 0.0; // half its width
	bool operator==(const ShapeSize&) const = default;
};

// A strongly scoped player's shape this tick (aimedView). `inner` decides
// whether an entity the client does not have is sent; `outer` keeps one it
// has, so an entity on the edge does not flicker while the aim wavers, and
// canSee answers with it. `bounds` holds the outer shape and the rear circle:
// the visibility scan's cheap pre-reject.
struct StrongView {
	ViewShape shape = ViewShape::None; // Cone or Rect; None for everyone else
	double dirX = 1.0, dirY = 0.0;     // the aim, a unit vector (y down)
	ShapeSize inner, outer;
	double rear2 = 0.0;                // the rear circle's radius squared
	ViewBox bounds;
	bool operator==(const StrongView&) const = default;
};

// A player's view for this tick (Player::updateAim). `box` is what is sent:
// the normal box, or a weak view's stretched or shifted one. With a strong
// view only the shape and its rear circle are sent, and `box` is where the
// player's scenery comes from: the normal box grown to the shape's bounds.
// offX/offY are a weak view's reach toward the aim, (extend cos, extend sin)
// truncated toward zero, and 0 otherwise; the cosmetic radius is moved by it
// (shift) or swept along it (stretch).
struct PlayerView {
	ViewBox box;
	int32_t offX = 0, offY = 0;
	bool stretch = false;
	StrongView strong;
	bool operator==(const PlayerView&) const = default;
};

namespace aim_view {
// Parses <aim>. `hipSpread` is the weapon's <fire spreadRadians>, which the
// aimed spread is a share of. Returns the problems; `out` is usable only when
// there are none.
std::vector<std::string> parseAim(const pugi::xml_node& node, const std::string& owner, float hipSpread, AimData& out);

// The client's view: CLIENT_VIEW_* world units at zoom 1 (BASE_VIEW_WIDTH and
// BASE_VIEW_HEIGHT in apps/client/src/core/camera.ts), and CLIENT_ZOOM_MIN,
// the furthest a player can zoom out (GameLoop.ZOOM_MIN in
// apps/client/src/game/game-loop.ts). The worst case a weak view must cover.
inline constexpr int32_t CLIENT_VIEW_WIDTH = 1280;
inline constexpr int32_t CLIENT_VIEW_HEIGHT = 880;
inline constexpr double CLIENT_ZOOM_MIN = 0.5;

// Parses <view>. Returns the problems; `out` is no view unless there are none.
std::vector<std::string> parseView(const pugi::xml_node& node, const std::string& owner, ViewData& out);

// A shift view's box always keeps this many world units behind the player: the
// player's own record and what is right behind them are never shifted out.
inline constexpr int32_t SHIFT_KEEP_BEHIND = 200;

// A weak view's box must reach past what a client zoomed all the way out draws
// with the camera slid `ahead` toward the aim, or entities pop in on screen:
// extend >= ahead + max(drawn half height - viewY, drawn half width - viewX).
// A shift view must also leave SHIFT_KEEP_BEHIND units behind the player in the
// box, whichever way it aims: extend <= min(viewX, viewY) - SHIFT_KEEP_BEHIND.
// Depends on config.lua maxViewportX/Y, so it is checked at startup.
std::optional<std::string> weakReachProblem(const ViewData& view, const std::string& owner, int32_t viewX, int32_t viewY);

// The client's strong scope camera moves the view centre this share of the
// way to the screen edge along the aim (SCOPE_OFFSET in
// apps/client/src/core/camera.ts).
inline constexpr double CLIENT_SCOPE_OFFSET = 0.85;

// A strong view's area: cone halfAngle (radians) x reach^2, rect
// (length + back) x width, plus the rear circle. 0 for anything else.
double strongArea(const ViewData& view);
// A strong scope sees farther, never more: its area must fit in the
// (2 viewX) x (2 viewY) box a player who is not aiming is sent. Depends on
// config.lua maxViewportX/Y, so it is checked at startup.
std::optional<std::string> strongAreaProblem(const ViewData& view, const std::string& owner, int32_t viewX, int32_t viewY);
// Advice, not a problem: a strong shape that reaches past
// CLIENT_SCOPE_OFFSET x CLIENT_VIEW_HEIGHT / zoom has its far end off screen
// when aimed along the screen's short side. Printed, never counted as a warning.
std::optional<std::string> strongScreenNote(const ViewData& view, const std::string& owner);

// The outer shape (hysteresis): the cone opens OUTER_CONE_DEG wider on each
// side, the cone's reach and the rect's length are OUTER_REACH longer, and the
// rect is OUTER_RECT_WIDTH wider. Its back and the rear circle do not grow.
inline constexpr double OUTER_CONE_DEG = 4.0;
inline constexpr double OUTER_REACH = 1.05;
inline constexpr double OUTER_RECT_WIDTH = 40.0;

// Whether (dx, dy) is in a strong view's rear circle or its shape: the outer
// shape for an entity the client already has, the inner one for the rest.
// Does not test the bounds; the scan does that first, as the cheap reject.
bool strongContains(const StrongView& s, int32_t dx, int32_t dy, bool outer);
// canSee's test: the box, inclusive; or for a strong view the bounds, then
// the rear circle and the outer shape.
bool viewContains(const PlayerView& v, int32_t dx, int32_t dy);

// Whether ids asked in ascending order are in `ids`, which is sorted. The
// visibility scan asks for each mobile in id order, so this is a cursor that
// only moves forward, not a binary search per entity.
struct KnownCursor {
	const std::vector<uint32_t>& ids;
	size_t at = 0;
	bool has(uint32_t id)
	{
		while (at < ids.size() && ids[at] < id) ++at;
		return at < ids.size() && ids[at] == id;
	}
};

// Whether aiming is active: the button held by a living, human player whose
// weapon has <aim>, with no interaction running (reload, equip, consume,
// craft, mod change -- Player::hasInteractionSlowLock).
bool aimShouldBeActive(bool held, bool alive, bool ghoul, bool canAim, bool busy);
// The spread a shot leaves with: the hip spread, easing to the aimed one over
// aimMs from the moment aiming turned on.
float spreadAt(float hip, const AimData& aim, bool active, uint64_t elapsedMs);

// The ±viewX × ±viewY box: everyone who is not aiming with a view.
PlayerView normalView(int32_t viewX, int32_t viewY);
// The view of a player aiming `view` toward `angleRad` (radians, y down: what
// the client's atan2 facing gives). Anything but a weak or strong view gives the normal one.
PlayerView aimedView(const ViewData& view, int32_t viewX, int32_t viewY, double angleRad);
// ROTATION's byte back to radians: protocolgame.cpp stores degrees * 255 / 360.
double rotationToRadians(uint8_t rotation);
// The cosmetic broadcast test (fanOutToWatchers): within `radius` of the
// player, of the point a shift moved the view to, or of the segment a stretch
// sweeps. dx/dy are the event's offset from the player. For a strong view the
// shape replaces the radius: always true, canSee having tested the shape.
bool cosmeticReach(const PlayerView& v, int32_t dx, int32_t dy, int32_t radius);
// Map::getPotentialSpectatorPlayers' superset test: within the box plus
// `margin`, and, when radius > 0, within `radius` of the segment from the player
// to the view's offset (plus `margin`), for either shape. The radius serves two
// gathers: cosmetic events (a circle a shift moves and a stretch sweeps) and
// projectiles fired from behind a shifted view (a circle around the shooter);
// the bounds cover both, so this is only ever a superset of candidates. The
// per-player tests still decide: canSee, cosmeticReach, and for projectiles
// spawnProjectiles' canSeeWithin(projRange) around the viewer.
// For a strong view: within the scenery box plus margin, and, when radius > 0,
// within the shape's bounds (cosmetic events) or within radius of the player
// (projectiles), each plus margin.
bool mayWatch(const PlayerView& v, int32_t dx, int32_t dy, int32_t radius, int32_t margin);

int runSelfTest(const std::string& fixtureDir);
} // namespace aim_view
