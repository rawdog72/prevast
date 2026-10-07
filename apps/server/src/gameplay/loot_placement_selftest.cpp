// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/loot_placement.h"
#include <cmath>
#include <fmt/format.h>
#include <numbers>

// Every file-local name carries a lootPlacementTest prefix: the server builds
// as unity files, where an unprefixed helper collides with another file's.
namespace {
int lootPlacementTestFailures = 0;

constexpr loot_placement::Area lootPlacementTestArea{ 9999, 9999 };
constexpr float lootPlacementTestPi = std::numbers::pi_v<float>;

void lootPlacementTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++lootPlacementTestFailures;
		fmt::print(">> loot placement self-test FAILED: {}\n", what);
	}
}

float lootPlacementTestDist(const Position& a, const Position& b)
{
	const float dx = static_cast<float>(a.getX() - b.getX());
	const float dy = static_cast<float>(a.getY() - b.getY());
	return std::sqrt(dx * dx + dy * dy);
}

bool lootPlacementTestApart(const std::vector<Position>& piles)
{
	for (size_t i = 0; i < piles.size(); ++i) {
		for (size_t j = i + 1; j < piles.size(); ++j) {
			if (lootPlacementTestDist(piles[i], piles[j]) < loot_placement::kGap) return false;
		}
	}
	return true;
}

void lootPlacementTestBurst()
{
	const Position body(1000, 1000);
	const auto five = loot_placement::burst(body, 5, 40.0f, 0.0f, {}, lootPlacementTestArea);
	lootPlacementTestCheck(five.size() == 5, "a burst of five gives five spots");
	lootPlacementTestCheck(lootPlacementTestApart(five), "a burst of five lands apart, not stacked");
	bool inReach = true;
	for (const Position& p : five) inReach = inReach && lootPlacementTestDist(p, body) <= loot_placement::reach(40.0f);
	lootPlacementTestCheck(inReach, "a burst stays within reach of the body");

	const auto three = loot_placement::burst(body, 3, 90.0f, 0.0f, {}, lootPlacementTestArea);
	bool even = three.size() == 3;
	for (size_t i = 0; even && i < 3; ++i) {
		// Evenly spread on a 90 ring, neighbours are 120 degrees apart: a chord of ~156.
		even = lootPlacementTestDist(three[i], three[(i + 1) % 3]) > 150.0f;
	}
	lootPlacementTestCheck(even, "a small burst spreads evenly round the ring");

	std::vector<Position> ground = five;
	const auto again = loot_placement::burst(body, 5, 40.0f, 0.0f, ground, lootPlacementTestArea);
	ground.insert(ground.end(), again.begin(), again.end());
	lootPlacementTestCheck(again.size() == 5 && lootPlacementTestApart(ground),
		"a second burst on the same spot avoids the first one's piles");

	std::vector<Position> singles;
	for (int i = 0; i < 4; ++i) {
		const auto one = loot_placement::burst(body, 1, 40.0f, 0.0f, singles, lootPlacementTestArea);
		singles.insert(singles.end(), one.begin(), one.end());
	}
	lootPlacementTestCheck(singles.size() == 4 && lootPlacementTestApart(singles),
		"single drops from the same angle do not stack");

	const auto flood = loot_placement::burst(body, 200, 40.0f, 0.0f, {}, lootPlacementTestArea);
	lootPlacementTestCheck(flood.size() == 200, "a burst bigger than every ring still places every item");
}

void lootPlacementTestDirected()
{
	const Position thrower(2000, 2000);
	const Position first = loot_placement::directed(thrower, lootPlacementTestPi / 2.0f, 80.0f, {}, lootPlacementTestArea);
	lootPlacementTestCheck(first == Position(2000, 2080), "the first throw lands straight ahead");

	std::vector<Position> ground;
	for (int i = 0; i < 6; ++i) {
		ground.push_back(loot_placement::directed(thrower, 0.0f, 80.0f, ground, lootPlacementTestArea));
	}
	lootPlacementTestCheck(lootPlacementTestApart(ground), "throws without turning land apart");
	bool sameRing = true;
	for (const Position& p : ground) sameRing = sameRing && std::fabs(lootPlacementTestDist(p, thrower) - 80.0f) < 2.0f;
	lootPlacementTestCheck(sameRing, "throws without turning share the thrower's ring");
	lootPlacementTestCheck(ground[1].getY() != ground[2].getY() &&
		(ground[1].getY() < thrower.getY()) != (ground[2].getY() < thrower.getY()),
		"successive throws alternate left and right of the facing");

	for (int i = 0; i < 40 && lootPlacementTestDist(ground.back(), thrower) < 100.0f; ++i) {
		ground.push_back(loot_placement::directed(thrower, 0.0f, 80.0f, ground, lootPlacementTestArea));
	}
	lootPlacementTestCheck(std::fabs(lootPlacementTestDist(ground.back(), thrower) - 130.0f) < 2.0f,
		"a full ring spills onto the next one out");
	lootPlacementTestCheck(lootPlacementTestApart(ground), "the spill keeps every pile apart");

	const std::vector<Position> blocked{ Position(2080, 2000) };
	const Position beside = loot_placement::directed(thrower, 0.0f, 80.0f, blocked, lootPlacementTestArea);
	lootPlacementTestCheck(beside != blocked[0] && lootPlacementTestDist(beside, blocked[0]) >= loot_placement::kGap &&
		std::fabs(lootPlacementTestDist(beside, thrower) - 80.0f) < 2.0f,
		"a pile already ahead pushes the throw to the next slot on the ring");
}

void lootPlacementTestEdges()
{
	const loot_placement::Area small{ 500, 500 };
	const auto corner = loot_placement::burst(Position(0, 0), 5, 40.0f, 0.0f, {}, small);
	bool inside = corner.size() == 5;
	for (const Position& p : corner) inside = inside && p.getX() <= 500 && p.getY() <= 500;
	lootPlacementTestCheck(inside, "a burst at the map corner stays on the map");
	lootPlacementTestCheck(lootPlacementTestApart(corner), "a burst at the map corner still lands apart");

	const Position edge = loot_placement::directed(Position(500, 500), 0.0f, 80.0f, {}, small);
	lootPlacementTestCheck(edge.getX() <= 500 && edge.getY() <= 500, "a throw off the map edge is clamped");
}
} // namespace

int loot_placement::runSelfTest()
{
	lootPlacementTestFailures = 0;
	lootPlacementTestBurst();
	lootPlacementTestDirected();
	lootPlacementTestEdges();
	fmt::print(">> loot placement self-test: {}\n",
		lootPlacementTestFailures == 0 ? "ok" : fmt::format("{} failure(s)", lootPlacementTestFailures));
	return lootPlacementTestFailures;
}
