// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/scenery_geometry.h"
#include <algorithm>
#include <cmath>
#include <limits>

bool scenery_geometry::containsDeep(const Shape& shape, float x, float y, float margin)
{
	if (shape.isRect) {
		const CollisionRect& r = shape.rect;
		return x > r.x - r.halfWidth + margin && x < r.x + r.halfWidth - margin &&
		       y > r.y - r.halfHeight + margin && y < r.y + r.halfHeight - margin;
	}
	const float dx = x - shape.circle.x;
	const float dy = y - shape.circle.y;
	const float inner = shape.circle.radius - margin;
	return inner > 0.0f && dx * dx + dy * dy < inner * inner;
}

bool scenery_geometry::segmentHit(const Shape& shape, float x1, float y1, float x2, float y2, float& hitX, float& hitY)
{
	if (shape.isRect) {
		return Collision::checkSegmentRect(x1, y1, x2, y2, shape.rect, hitX, hitY);
	}
	// Where the segment ENTERS the circle. Collision::checkSegmentCircle answers
	// with the point of closest approach instead, which is right for "did the
	// bullet touch it" but puts a head-on hit at the centre of a tree.
	const CollisionCircle& c = shape.circle;
	const float dx = x2 - x1;
	const float dy = y2 - y1;
	const float fx = x1 - c.x;
	const float fy = y1 - c.y;
	const float cc = fx * fx + fy * fy - c.radius * c.radius;
	if (cc <= 0.0f) { // starts inside
		hitX = x1;
		hitY = y1;
		return true;
	}
	const float a = dx * dx + dy * dy;
	if (a <= 0.0f) return false;
	const float b = 2.0f * (fx * dx + fy * dy);
	const float disc = b * b - 4.0f * a * cc;
	if (disc < 0.0f) return false;
	const float t = (-b - std::sqrt(disc)) / (2.0f * a);
	if (t < 0.0f || t > 1.0f) return false;
	hitX = x1 + t * dx;
	hitY = y1 + t * dy;
	return true;
}

void scenery_geometry::normalAt(const Shape& shape, float hitX, float hitY, float dirX, float dirY, float& nx, float& ny)
{
	if (!shape.isRect) {
		const float dx = hitX - shape.circle.x;
		const float dy = hitY - shape.circle.y;
		const float len = std::sqrt(dx * dx + dy * dy);
		if (len > 0.001f) {
			nx = dx / len;
			ny = dy / len;
		} else {
			nx = -dirX;
			ny = -dirY;
		}
		return;
	}

	const CollisionRect& r = shape.rect;
	const float dist[4] = {
		std::abs(hitX - (r.x - r.halfWidth)),  // left
		std::abs(hitX - (r.x + r.halfWidth)),  // right
		std::abs(hitY - (r.y - r.halfHeight)), // top
		std::abs(hitY - (r.y + r.halfHeight)), // bottom
	};
	static constexpr float normals[4][2] = { { -1.0f, 0.0f }, { 1.0f, 0.0f }, { 0.0f, -1.0f }, { 0.0f, 1.0f } };
	const float nearest = std::min({ dist[0], dist[1], dist[2], dist[3] });

	int best = 0;
	float bestFacing = 1e9f;
	for (int i = 0; i < 4; ++i) {
		if (dist[i] > nearest + 0.5f) continue;
		const float facing = normals[i][0] * dirX + normals[i][1] * dirY; // < 0: faces the mover
		if (facing < bestFacing) {
			bestFacing = facing;
			best = i;
		}
	}
	nx = normals[best][0];
	ny = normals[best][1];
}

bool scenery_geometry::shelters(const Shape& shape, float ox, float oy, float tx, float ty)
{
	if (containsDeep(shape, ox, oy, kBlastSurfaceMargin)) return false; // the source
	if (containsDeep(shape, tx, ty, kBlastSurfaceMargin)) return false; // standing in it
	float hitX = 0.0f, hitY = 0.0f;
	if (!segmentHit(shape, tx, ty, ox, oy, hitX, hitY)) return false;
	const float dx = hitX - ox;
	const float dy = hitY - oy;
	return dx * dx + dy * dy > kBlastSurfaceMargin * kBlastSurfaceMargin;
}

namespace {
	// How far (x, y) is outside the shape's outline; 0 on or inside it.
	float sceneryGeometryDistanceOutside(const scenery_geometry::Shape& shape, float x, float y)
	{
		if (shape.isRect) {
			const CollisionRect& r = shape.rect;
			const float dx = std::max(std::abs(x - r.x) - r.halfWidth, 0.0f);
			const float dy = std::max(std::abs(y - r.y) - r.halfHeight, 0.0f);
			return std::sqrt(dx * dx + dy * dy);
		}
		const float d = std::hypot(x - shape.circle.x, y - shape.circle.y) - shape.circle.radius;
		return std::max(d, 0.0f);
	}

	// How far along the unit vector (dirX, dirY) a path from (x, y), on or
	// inside the shape, leaves it. 0 for a point outside.
	float sceneryGeometryExitDistance(const scenery_geometry::Shape& shape, float x, float y, float dirX, float dirY)
	{
		if (sceneryGeometryDistanceOutside(shape, x, y) > 0.0f) return 0.0f;
		if (shape.isRect) {
			const CollisionRect& r = shape.rect;
			float t = std::numeric_limits<float>::max();
			if (dirX > 0.0f) t = std::min(t, (r.x + r.halfWidth - x) / dirX);
			if (dirX < 0.0f) t = std::min(t, (r.x - r.halfWidth - x) / dirX);
			if (dirY > 0.0f) t = std::min(t, (r.y + r.halfHeight - y) / dirY);
			if (dirY < 0.0f) t = std::min(t, (r.y - r.halfHeight - y) / dirY);
			return t == std::numeric_limits<float>::max() ? 0.0f : std::max(t, 0.0f);
		}
		const float fx = x - shape.circle.x;
		const float fy = y - shape.circle.y;
		const float b = fx * dirX + fy * dirY;
		const float c = fx * fx + fy * fy - shape.circle.radius * shape.circle.radius;
		const float disc = b * b - c;
		return disc < 0.0f ? 0.0f : std::max(-b + std::sqrt(disc), 0.0f);
	}
}

scenery_geometry::FragmentStart scenery_geometry::fragmentStart(const Shape& shape, float ox, float oy,
                                                                float dirX, float dirY, float& exitAt)
{
	exitAt = 0.0f;
	if (containsDeep(shape, ox, oy, kBlastSurfaceMargin)) {
		// The blast's own source: every fragment flies out of it.
		exitAt = sceneryGeometryExitDistance(shape, ox, oy, dirX, dirY) + kBounceSurfaceOffset;
		return FragmentStart::Exit;
	}
	if (sceneryGeometryDistanceOutside(shape, ox, oy) > kBlastSurfaceMargin) {
		return FragmentStart::Clear;
	}
	// Lying on (or a unit inside) the surface: the face's normal tells a
	// fragment heading into the wall from one leaving it.
	float nx = 0.0f, ny = 0.0f;
	normalAt(shape, ox, oy, dirX, dirY, nx, ny);
	if (dirX * nx + dirY * ny < 0.0f) {
		return FragmentStart::Stopped;
	}
	exitAt = sceneryGeometryExitDistance(shape, ox, oy, dirX, dirY) + kBounceSurfaceOffset;
	return FragmentStart::Exit;
}

bool scenery_geometry::bounce(const Shape& shape, float oldX, float oldY, float hitX, float hitY, float vx, float vy,
                              float endX, float endY, float restitution, float mapW, float mapH, BounceLeg& out)
{
	const float speed = std::sqrt(vx * vx + vy * vy);
	if (speed <= 0.0f) return false;
	// Began the step inside the thing (thrown from within a wall's outline):
	// there is no face to bounce off.
	if (containsDeep(shape, oldX, oldY, 0.0f)) return false;

	// A circle's hit as the caller found it may be the point of closest
	// approach, inside the circle; bouncing from there would start the next leg
	// inside the thing. Where the path actually enters it is the contact.
	if (!shape.isRect) {
		const float reach = std::hypot(hitX - oldX, hitY - oldY) + 2.0f * shape.circle.radius;
		float entryX = 0.0f, entryY = 0.0f;
		if (segmentHit(shape, oldX, oldY, oldX + (vx / speed) * reach, oldY + (vy / speed) * reach, entryX, entryY)) {
			hitX = entryX;
			hitY = entryY;
		}
	}

	float nx = 0.0f, ny = 0.0f;
	normalAt(shape, hitX, hitY, vx / speed, vy / speed, nx, ny);
	const float into = vx * nx + vy * ny;
	if (into >= 0.0f) return false; // already leaving the surface

	const float outVx = (vx - 2.0f * into * nx) * restitution;
	const float outVy = (vy - 2.0f * into * ny) * restitution;
	const float outSpeed = speed * restitution;

	const float leftX = endX - hitX;
	const float leftY = endY - hitY;
	const float travel = std::sqrt(leftX * leftX + leftY * leftY) * restitution;
	if (outSpeed < kBounceMinSpeed || travel < kBounceMinDistance) return false;

	const auto clampX = [&](float x) { return std::clamp(x, 0.0f, mapW - 1.0f); };
	const auto clampY = [&](float y) { return std::clamp(y, 0.0f, mapH - 1.0f); };
	out.fromX = clampX(hitX + nx * kBounceSurfaceOffset);
	out.fromY = clampY(hitY + ny * kBounceSurfaceOffset);
	out.toX = clampX(out.fromX + (outVx / outSpeed) * travel);
	out.toY = clampY(out.fromY + (outVy / outSpeed) * travel);
	out.vx = outVx;
	out.vy = outVy;
	return true;
}
