// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENERY_GEOMETRY_H
#define FS_SCENERY_GEOMETRY_H

#include "world/collision.h"

// What scenery -- walls, doors, rocks, trees -- does to a grenade and its
// blast. Pure geometry on the same rect or circle a bullet collides with
// (checkProjectileTargetHit), so this never touches the map and the self-test
// drives it directly. Game resolves a Thing to a Shape and calls in here.
namespace scenery_geometry {

struct Shape {
	bool isRect = false;
	CollisionRect rect{};
	CollisionCircle circle{};

	static Shape ofRect(const CollisionRect& r)
	{
		Shape s;
		s.isRect = true;
		s.rect = r;
		return s;
	}
	static Shape ofCircle(const CollisionCircle& c)
	{
		Shape s;
		s.circle = c;
		return s;
	}
};

// How far inside a thing a blast origin must be before that thing counts as
// the blast's source (an exploding barrel) rather than as cover. Positions are
// whole units, so a grenade parked on a wall can round a unit or two into it.
inline constexpr float kBlastSurfaceMargin = 4.0f;
// How far off the surface a bounced grenade starts its next leg, so the next
// step does not meet the same face again.
inline constexpr float kBounceSurfaceOffset = 3.0f;
// A bounce that would leave the grenade less than this far to go, or this
// slow, just drops it where it hit.
inline constexpr float kBounceMinDistance = 12.0f;
inline constexpr float kBounceMinSpeed = 20.0f; // units per second

// Whether (x, y) lies inside the shape by more than `margin`.
bool containsDeep(const Shape& shape, float x, float y, float margin);

// The first point of the segment (x1, y1) -> (x2, y2) on the shape, if any:
// where it enters, or (x1, y1) itself when it starts inside.
bool segmentHit(const Shape& shape, float x1, float y1, float x2, float y2, float& hitX, float& hitY);

// The outward surface normal at a hit point, for something that arrived
// travelling along the unit vector (dirX, dirY). A rect takes the side the
// point is on; at a corner the side facing the incoming direction wins, so a
// grenade clipping a corner comes back out the way it went in.
void normalAt(const Shape& shape, float hitX, float hitY, float dirX, float dirY, float& nx, float& ny);

// Whether this shape shelters a creature at (tx, ty) from a blast at (ox, oy).
// Walked FROM the creature TO the blast, so the first surface met is the near
// side of whatever is in the way; a hit further than kBlastSurfaceMargin from
// the origin is cover. A grenade parked on the face of a wall therefore
// shelters nobody on its own side and everybody on the far side. A shape the
// origin is deep inside is the blast's source and shelters nobody; neither
// does one the creature is standing inside.
bool shelters(const Shape& shape, float ox, float oy, float tx, float ty);

// How a fragment fired from a blast at (ox, oy) along the unit vector
// (dirX, dirY) gets clear of this shape. The same source rule as shelters():
// a shape the blast is deep inside is its own and stops nothing, and a grenade
// lying on a surface (within kBlastSurfaceMargin of it, or rounded a unit into
// it) loses only the fragments heading into that surface.
//   Clear    the blast is not at this shape; nothing to do.
//   Stopped  the blast lies on its surface and this fragment heads into it:
//            the shape takes it, right there.
//   Exit     the blast is inside it (its own source, or rounded a unit into
//            a wall it lies on) and this fragment heads out: it starts flying
//            `exitAt` along its path, just outside the shape -- otherwise the
//            first collision test would find it inside and stop it there.
enum class FragmentStart { Clear, Stopped, Exit };
FragmentStart fragmentStart(const Shape& shape, float ox, float oy, float dirX, float dirY, float& exitAt);

// A new flight leg after glancing off a surface.
struct BounceLeg {
	float fromX = 0.0f, fromY = 0.0f;
	float toX = 0.0f, toY = 0.0f;
	float vx = 0.0f, vy = 0.0f;
};

// Something moving at (vx, vy) from (oldX, oldY) met `shape` at (hitX, hitY)
// on its way to (endX, endY); for a circle the contact is taken where the
// path enters it, whatever point the caller found. The velocity is mirrored about the surface and
// both speed and the distance still to go are multiplied by `restitution`; the
// leg starts kBounceSurfaceOffset off the surface and stays inside
// [0, mapW) x [0, mapH). False when there is nothing to bounce: the step began
// inside the shape, it is already moving away from the surface, or what would
// be left is under kBounceMinSpeed / kBounceMinDistance.
bool bounce(const Shape& shape, float oldX, float oldY, float hitX, float hitY, float vx, float vy,
            float endX, float endY, float restitution, float mapW, float mapH, BounceLeg& out);

int runSelfTest();

} // namespace scenery_geometry

#endif // FS_SCENERY_GEOMETRY_H
