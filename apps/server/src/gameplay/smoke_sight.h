// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SMOKE_SIGHT_H
#define FS_SMOKE_SIGHT_H

#include <algorithm>
#include <cmath>
#include <cstdint>

// Who smoke hides from whom. Pure geometry over a tile query, so it never
// touches the map and the self-test drives it directly; Game answers the query
// from its smoke grid (Game::smokeHides).
//
// THE RULE: a viewer sees a target when the straight line between them is all
// clear air or all smoke. So from outside a cloud you see neither into it nor
// past it, and from inside you see the inside and nothing beyond. Whoever is
// within kNearSight of the viewer is always seen -- someone bumping into you in
// the smoke does not vanish -- and so is the viewer.
//
// The line is sampled every kSampleStep units rather than walked tile by tile:
// a line that only clips the corner of a smoke tile does not flip, which keeps
// people near the edge of a cloud from flickering as the line brushes it.
namespace smoke_sight {

inline constexpr int32_t kNearSight = 100;
inline constexpr int32_t kSampleStep = 25;

// isSmoke(tileX, tileY): whether that tile holds vision-blocking smoke.
template <typename IsSmoke>
bool hides(int32_t viewerX, int32_t viewerY, int32_t targetX, int32_t targetY, int32_t tileSize, const IsSmoke& isSmoke)
{
	const int64_t dx = static_cast<int64_t>(targetX) - viewerX;
	const int64_t dy = static_cast<int64_t>(targetY) - viewerY;
	if (dx * dx + dy * dy <= static_cast<int64_t>(kNearSight) * kNearSight) return false;

	int32_t tileX = viewerX / tileSize;
	int32_t tileY = viewerY / tileSize;
	const bool viewerInSmoke = isSmoke(tileX, tileY);

	const double length = std::sqrt(static_cast<double>(dx * dx + dy * dy));
	const int32_t steps = static_cast<int32_t>(std::ceil(length / kSampleStep));
	for (int32_t i = 1; i <= steps; ++i) {
		const double t = static_cast<double>(i) / steps;
		const int32_t x = viewerX + static_cast<int32_t>(std::lround(dx * t));
		const int32_t y = viewerY + static_cast<int32_t>(std::lround(dy * t));
		const int32_t tx = x / tileSize;
		const int32_t ty = y / tileSize;
		if (tx == tileX && ty == tileY) continue; // same tile as the last sample
		tileX = tx;
		tileY = ty;
		if (isSmoke(tx, ty) != viewerInSmoke) return true;
	}
	return false;
}

// The first point on the path (fromX, fromY) -> (toX, toY) the viewer can see,
// sampled every kSampleStep units: where a bullet fired out of smoke first comes
// into this viewer's sight. False when no point on the path is visible.
template <typename IsSmoke>
bool firstVisible(int32_t viewerX, int32_t viewerY, int32_t fromX, int32_t fromY, int32_t toX, int32_t toY,
                  int32_t tileSize, const IsSmoke& isSmoke, int32_t& outX, int32_t& outY)
{
	const double dx = static_cast<double>(toX) - fromX;
	const double dy = static_cast<double>(toY) - fromY;
	const double length = std::sqrt(dx * dx + dy * dy);
	const int32_t steps = std::max<int32_t>(1, static_cast<int32_t>(std::ceil(length / kSampleStep)));
	for (int32_t i = 0; i <= steps; ++i) {
		const double t = static_cast<double>(i) / steps;
		const int32_t x = fromX + static_cast<int32_t>(std::lround(dx * t));
		const int32_t y = fromY + static_cast<int32_t>(std::lround(dy * t));
		if (!hides(viewerX, viewerY, x, y, tileSize, isSmoke)) {
			outX = x;
			outY = y;
			return true;
		}
	}
	return false;
}

int runSelfTest();

} // namespace smoke_sight

#endif // FS_SMOKE_SIGHT_H
