// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/smoke_sight.h"
#include <fmt/format.h>

// Every file-local name carries a smokeSightTest prefix: the server builds as
// unity files, where an unprefixed helper collides with another file's.
namespace {
int smokeSightTestFailures = 0;
constexpr int32_t smokeSightTestTile = 100;

void smokeSightTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++smokeSightTestFailures;
		fmt::print(">> smoke sight self-test FAILED: {}\n", what);
	}
}

// A 3x3-tile cloud on tiles 10..12 x 10..12: units 1000..1299 on both axes.
bool smokeSightTestCloud(int32_t tx, int32_t ty)
{
	return tx >= 10 && tx <= 12 && ty >= 10 && ty <= 12;
}

bool smokeSightTestHides(int32_t vx, int32_t vy, int32_t tx, int32_t ty)
{
	return smoke_sight::hides(vx, vy, tx, ty, smokeSightTestTile, smokeSightTestCloud);
}

void smokeSightTestRule()
{
	// Both in the open, the cloud nowhere near the line.
	smokeSightTestCheck(!smokeSightTestHides(500, 500, 900, 500), "open ground: seen");
	// Outside looking at someone inside.
	smokeSightTestCheck(smokeSightTestHides(700, 1150, 1150, 1150), "outside cannot see into smoke");
	// Outside looking at someone behind it.
	smokeSightTestCheck(smokeSightTestHides(700, 1150, 1600, 1150), "outside cannot see past smoke");
	// Outside, the line passing beside the cloud.
	smokeSightTestCheck(!smokeSightTestHides(700, 900, 1600, 900), "a line beside the cloud is clear");
	// Inside looking at someone else inside, across the cloud.
	smokeSightTestCheck(!smokeSightTestHides(1020, 1150, 1280, 1150), "inside sees the inside");
	// Inside looking out.
	smokeSightTestCheck(smokeSightTestHides(1150, 1150, 1600, 1150), "inside cannot see out");
	// Symmetric: the one outside cannot see the one inside either.
	smokeSightTestCheck(smokeSightTestHides(1600, 1150, 1150, 1150), "and the one outside cannot see in");
	// Someone right next to you is always there, in or out of the smoke.
	smokeSightTestCheck(!smokeSightTestHides(1290, 1150, 1360, 1150), "within reach across the edge: seen");
	smokeSightTestCheck(!smokeSightTestHides(1150, 1150, 1150, 1150), "yourself: seen");
	// Both outside, on opposite sides of the cloud.
	smokeSightTestCheck(smokeSightTestHides(900, 1150, 1400, 1150), "the cloud stands between two outside");
	// No smoke at all.
	const auto none = [](int32_t, int32_t) { return false; };
	smokeSightTestCheck(!smoke_sight::hides(0, 0, 5000, 5000, smokeSightTestTile, none), "no smoke, nothing hidden");
}

void smokeSightTestFirstVisible()
{
	int32_t x = 0, y = 0;
	// A bullet fired from inside the cloud eastward, watched from far east in
	// the open: it comes into sight where it leaves the smoke (x = 1300).
	const bool seen = smoke_sight::firstVisible(2000, 1150, 1150, 1150, 1900, 1150, smokeSightTestTile,
		smokeSightTestCloud, x, y);
	smokeSightTestCheck(seen && x >= 1300 && x < 1300 + smoke_sight::kSampleStep && y == 1150,
		fmt::format("a shot out of the smoke appears at its edge (got {}, {})", x, y));

	// Fired from the open, watched from the open: seen from the muzzle.
	smokeSightTestCheck(smoke_sight::firstVisible(500, 500, 600, 500, 900, 500, smokeSightTestTile,
		smokeSightTestCloud, x, y) && x == 600, "a shot in the open is seen from the muzzle");

	// Fired inside and staying inside, watched from outside: never seen.
	smokeSightTestCheck(!smoke_sight::firstVisible(2000, 1150, 1050, 1150, 1250, 1150, smokeSightTestTile,
		smokeSightTestCloud, x, y), "a shot that never leaves the smoke is not shown outside");

	// Watched from inside: a shot from outside appears where it enters.
	smokeSightTestCheck(smoke_sight::firstVisible(1150, 1150, 600, 1150, 1150, 1150, smokeSightTestTile,
		smokeSightTestCloud, x, y) && x >= 1000 && x < 1000 + smoke_sight::kSampleStep,
		fmt::format("a shot into the smoke appears to those inside where it enters (got {})", x));
}
} // namespace

int smoke_sight::runSelfTest()
{
	smokeSightTestFailures = 0;
	smokeSightTestRule();
	smokeSightTestFirstVisible();
	fmt::print(">> smoke sight self-test: {}\n",
		smokeSightTestFailures == 0 ? "ok" : fmt::format("{} failure(s)", smokeSightTestFailures));
	return smokeSightTestFailures;
}
