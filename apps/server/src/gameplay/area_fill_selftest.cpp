// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/area_fill.h"
#include <algorithm>
#include <fmt/format.h>
#include <set>

// Every file-local name carries an areaFillTest prefix: the server builds as
// unity files, where an unprefixed helper collides with another file's.
namespace {
int areaFillTestFailures = 0;

void areaFillTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++areaFillTestFailures;
		fmt::print(">> area fill self-test FAILED: {}\n", what);
	}
}

bool areaFillTestHas(const std::vector<area_fill::Cell>& cells, int dx, int dy)
{
	return std::find(cells.begin(), cells.end(), area_fill::Cell{ static_cast<int8_t>(dx), static_cast<int8_t>(dy) }) != cells.end();
}

void areaFillTestOpen()
{
	const auto open = [](int, int) { return false; };
	const auto cells = area_fill::fill(13, 5.0f, open);
	areaFillTestCheck(cells.size() == 13, "an open field takes the whole budget");
	areaFillTestCheck(cells.front() == area_fill::Cell{ 0, 0 }, "the origin comes first");

	// Nearest-first: no tile is ever further out than one revealed after it.
	bool ordered = true;
	for (size_t i = 1; i < cells.size(); ++i) {
		const int before = cells[i - 1].dx * cells[i - 1].dx + cells[i - 1].dy * cells[i - 1].dy;
		const int now = cells[i].dx * cells[i].dx + cells[i].dy * cells[i].dy;
		if (now < before) ordered = false;
	}
	areaFillTestCheck(ordered, "tiles come nearest-first");
	// 1 + 4 orthogonal + 4 diagonal + 4 at distance 2 = 13: a round blob.
	areaFillTestCheck(areaFillTestHas(cells, 2, 0) && areaFillTestHas(cells, 1, 1) && !areaFillTestHas(cells, 2, 1),
		"an open field grows round");

	std::set<std::pair<int, int>> unique;
	for (const auto& c : cells) unique.insert({ c.dx, c.dy });
	areaFillTestCheck(unique.size() == cells.size(), "no tile twice");

	const auto big = area_fill::fill(255, 3.0f, open);
	for (const auto& c : big) {
		if (c.dx * c.dx + c.dy * c.dy > 9) {
			areaFillTestCheck(false, "the radius caps the spread");
			break;
		}
	}
	areaFillTestCheck(area_fill::fill(1000, 100.0f, open).size() <= static_cast<size_t>(area_fill::kMaxCells),
		"the budget is capped at what the wire can carry");
}

void areaFillTestWalls()
{
	// A wall along dx = 2, as long as the cloud can reach.
	const auto wall = [](int dx, int) { return dx == 2; };
	const auto cells = area_fill::fill(60, 6.0f, wall);
	bool through = false;
	for (const auto& c : cells) if (c.dx >= 2) through = true;
	areaFillTestCheck(!through, "a wall stops the cloud");

	// The same wall with a doorway at dy = 0.
	const auto door = [](int dx, int dy) { return dx == 2 && dy != 0; };
	const auto out = area_fill::fill(60, 6.0f, door);
	areaFillTestCheck(areaFillTestHas(out, 2, 0) && areaFillTestHas(out, 3, 0), "a doorway lets it out");

	// A closed 3x3 room around the origin (walls at |d| = 2): it fills the room
	// and stops, however much budget is left.
	const auto room = [](int dx, int dy) { return std::abs(dx) == 2 || std::abs(dy) == 2; };
	const auto inRoom = area_fill::fill(100, 10.0f, room);
	areaFillTestCheck(inRoom.size() == 9, "a closed room holds the cloud");

	// Two walls meeting at a corner: one along dx = 1 for dy <= 0, one along
	// dy = 1 for dx <= 0. The quadrant beyond (dx >= 1, dy >= 1) is reachable
	// only diagonally across the corner, which must not happen.
	const auto corner = [](int dx, int dy) { return (dx == 1 && dy <= 0) || (dy == 1 && dx <= 0); };
	const auto cornered = area_fill::fill(200, 8.0f, corner);
	bool leaked = false;
	for (const auto& c : cornered) if (c.dx >= 1 && c.dy >= 1) leaked = true;
	areaFillTestCheck(!leaked, "the cloud does not slip through a wall corner");

	// The origin is covered even when it is itself blocked (a grenade lying on
	// a wall's tile), and spreads from there.
	const auto selfBlocked = [](int dx, int dy) { return dx == 0 && dy == 0; };
	const auto fromWall = area_fill::fill(5, 3.0f, selfBlocked);
	areaFillTestCheck(fromWall.size() == 5 && fromWall.front() == area_fill::Cell{ 0, 0 },
		"a blocked origin still seeds the cloud");
}

void areaFillTestAsksOnce()
{
	int asked = 0;
	std::set<std::pair<int, int>> seen;
	bool repeated = false;
	area_fill::fill(80, 8.0f, [&](int dx, int dy) {
		++asked;
		if (!seen.insert({ dx, dy }).second) repeated = true;
		return dx == 3;
	});
	areaFillTestCheck(!repeated && asked > 0, "each tile is asked about once");
}
} // namespace

int area_fill::runSelfTest()
{
	areaFillTestFailures = 0;
	areaFillTestOpen();
	areaFillTestWalls();
	areaFillTestAsksOnce();
	fmt::print(">> area fill self-test: {}\n",
		areaFillTestFailures == 0 ? "ok" : fmt::format("{} failure(s)", areaFillTestFailures));
	return areaFillTestFailures;
}
