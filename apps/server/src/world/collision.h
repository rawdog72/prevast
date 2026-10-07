// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_COLLISION_H
#define FS_COLLISION_H

#include "core/position.h"
#include <algorithm>

struct CollisionRect {
	float x, y;
	float halfWidth, halfHeight;
};

struct CollisionCircle {
	float x, y;
	float radius;
};

class Collision
{
public:
	static bool checkCircleCircle(const CollisionCircle& c1, const CollisionCircle& c2, float& overlap, float& nx, float& ny) {
		float dx = c1.x - c2.x;
		float dy = c1.y - c2.y;
		float distSq = dx * dx + dy * dy;
		float radiusSum = c1.radius + c2.radius;

		if (distSq >= radiusSum * radiusSum) {
			return false;
		}

		if (distSq <= 0.0001f) {
			// Exact same position, push apart in a default direction
			overlap = radiusSum;
			nx = 0; ny = 1; // Push Down (away from obstacle)
			return true;
		}

		float dist = std::sqrt(distSq);
		overlap = radiusSum - dist;
		nx = dx / dist;
		ny = dy / dist;
		return true;
	}

	static bool checkCircleRect(const CollisionCircle& circle, const CollisionRect& rect, float& overlap, float& nx, float& ny) {
		// Find closest point on rectangle to circle center
		float closestX = std::max(rect.x - rect.halfWidth, std::min(circle.x, rect.x + rect.halfWidth));
		float closestY = std::max(rect.y - rect.halfHeight, std::min(circle.y, rect.y + rect.halfHeight));

		float dx = circle.x - closestX;
		float dy = circle.y - closestY;
		float distSq = dx * dx + dy * dy;

		if (distSq >= circle.radius * circle.radius) {
			return false;
		}

		// If circle center is inside the rectangle or very close to it
		if (distSq < 0.01f) {
			// Find distance to all 4 edges and pick the smallest
			float dl = circle.x - (rect.x - rect.halfWidth);
			float dr = (rect.x + rect.halfWidth) - circle.x;
			float dt = circle.y - (rect.y - rect.halfHeight);
			float db = (rect.y + rect.halfHeight) - circle.y;

			if (dl < dr && dl < dt && dl < db) { nx = -1; ny = 0; overlap = dl + circle.radius; }
			else if (dr < dt && dr < db) { nx = 1; ny = 0; overlap = dr + circle.radius; }
			else if (dt < db) { nx = 0; ny = -1; overlap = dt + circle.radius; }
			else { nx = 0; ny = 1; overlap = db + circle.radius; }
		} else {
			float dist = std::sqrt(distSq);
			overlap = circle.radius - dist;
			nx = dx / dist;
			ny = dy / dist;
		}

		return true;
	}

	static bool checkSegmentCircle(float x1, float y1, float x2, float y2, const CollisionCircle& circle, float& hitX, float& hitY) {
		float dx = x2 - x1;
		float dy = y2 - y1;
		float lenSq = dx * dx + dy * dy;

		if (lenSq < 0.0001f) {
			float d2cx = circle.x - x1;
			float d2cy = circle.y - y1;
			if (d2cx * d2cx + d2cy * d2cy <= circle.radius * circle.radius) {
				hitX = x1; hitY = y1;
				return true;
			}
			return false;
		}

		// Projection of circle center onto segment: t = [(C - P1) . (P2 - P1)] / |P2 - P1|^2
		float t = ((circle.x - x1) * dx + (circle.y - y1) * dy) / lenSq;
		t = std::max(0.0f, std::min(1.0f, t));

		float closestX = x1 + t * dx;
		float closestY = y1 + t * dy;

		float distSq = (circle.x - closestX) * (circle.x - closestX) + (circle.y - closestY) * (circle.y - closestY);
		if (distSq <= circle.radius * circle.radius) {
			hitX = closestX;
			hitY = closestY;
			return true;
		}
		return false;
	}

	static bool checkSegmentRect(float x1, float y1, float x2, float y2, const CollisionRect& rect, float& hitX, float& hitY) {
		float left = rect.x - rect.halfWidth;
		float right = rect.x + rect.halfWidth;
		float top = rect.y - rect.halfHeight;
		float bottom = rect.y + rect.halfHeight;

		// Check if either endpoint is inside
		auto isInside = [&](float x, float y) {
			return x >= left && x <= right && y >= top && y <= bottom;
		};

		if (isInside(x1, y1)) { hitX = x1; hitY = y1; return true; }

		// Standard line segment intersection against 4 edges
		auto intersect = [&](float sx1, float sy1, float sx2, float sy2, float& ix, float& iy) {
			float r_dx = x2 - x1;
			float r_dy = y2 - y1;
			float s_dx = sx2 - sx1;
			float s_dy = sy2 - sy1;

			float denom = r_dx * s_dy - r_dy * s_dx;
			if (std::abs(denom) < 0.0001f) return false;

			float t = ((sx1 - x1) * s_dy - (sy1 - y1) * s_dx) / denom;
			float u = ((sx1 - x1) * r_dy - (sy1 - y1) * r_dx) / denom;

			if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
				ix = x1 + t * r_dx;
				iy = y1 + t * r_dy;
				return true;
			}
			return false;
		};

		float ix, iy;
		float minDistSq = 1e18f;
		bool hit = false;

		// Test all 4 edges and find the closest hit to (x1, y1)
		float edges[4][4] = {
			{left, top, right, top},      // Top
			{right, top, right, bottom},  // Right
			{right, bottom, left, bottom},// Bottom
			{left, bottom, left, top}     // Left
		};

		for (int i = 0; i < 4; ++i) {
			if (intersect(edges[i][0], edges[i][1], edges[i][2], edges[i][3], ix, iy)) {
				float dSq = (ix - x1) * (ix - x1) + (iy - y1) * (iy - y1);
				if (dSq < minDistSq) {
					minDistSq = dSq;
					hitX = ix; hitY = iy;
					hit = true;
				}
			}
		}

		return hit;
	}
};

#endif // FS_COLLISION_H
