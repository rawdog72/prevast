// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/scenery_geometry.h"
#include <cmath>
#include <fmt/format.h>

// Every file-local name carries a sceneryGeometryTest prefix: the server builds
// as unity files, where an unprefixed helper collides with another file's.
namespace {
int sceneryGeometryTestFailures = 0;

using scenery_geometry::Shape;

// A wall 40 wide and 200 tall, centred on (500, 500): faces at x = 480 and 520.
const Shape sceneryGeometryTestWall = Shape::ofRect({ 500.0f, 500.0f, 20.0f, 100.0f });
// A tree of radius 30 at (500, 500).
const Shape sceneryGeometryTestTree = Shape::ofCircle({ 500.0f, 500.0f, 30.0f });

void sceneryGeometryTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++sceneryGeometryTestFailures;
		fmt::print(">> scenery geometry self-test FAILED: {}\n", what);
	}
}

bool sceneryGeometryTestNear(float a, float b, float tolerance = 0.5f)
{
	return std::abs(a - b) <= tolerance;
}

void sceneryGeometryTestShelter()
{
	using scenery_geometry::shelters;
	const Shape& wall = sceneryGeometryTestWall;

	// Open ground: nothing in between.
	sceneryGeometryTestCheck(!shelters(wall, 300.0f, 300.0f, 350.0f, 300.0f), "a wall off to the side shelters nobody");
	// Straight through the wall.
	sceneryGeometryTestCheck(shelters(wall, 400.0f, 500.0f, 600.0f, 500.0f), "a wall between blast and creature shelters it");
	sceneryGeometryTestCheck(shelters(wall, 600.0f, 500.0f, 400.0f, 500.0f), "it shelters from either side");

	// A grenade parked on the west face (x = 480), and rounded a unit into it.
	for (const float parkedX : { 480.0f, 481.0f, 479.0f }) {
		sceneryGeometryTestCheck(!shelters(wall, parkedX, 500.0f, 400.0f, 500.0f),
			fmt::format("a grenade parked at x={} on the face hurts its own side", parkedX));
		sceneryGeometryTestCheck(!shelters(wall, parkedX, 500.0f, 420.0f, 440.0f),
			fmt::format("a grenade parked at x={} hurts its own side at an angle", parkedX));
		sceneryGeometryTestCheck(shelters(wall, parkedX, 500.0f, 600.0f, 500.0f),
			fmt::format("a grenade parked at x={} does not reach through the wall", parkedX));
	}

	// The wall itself exploding (a barrel, a charge on its own object).
	sceneryGeometryTestCheck(!shelters(wall, 500.0f, 500.0f, 600.0f, 500.0f), "a thing never shelters from its own blast");

	// Trees and rocks are cover too.
	sceneryGeometryTestCheck(shelters(sceneryGeometryTestTree, 400.0f, 500.0f, 600.0f, 500.0f), "a tree in between shelters");
	sceneryGeometryTestCheck(!shelters(sceneryGeometryTestTree, 400.0f, 400.0f, 600.0f, 400.0f), "a tree off the line does not");
	sceneryGeometryTestCheck(!shelters(sceneryGeometryTestTree, 470.0f, 500.0f, 400.0f, 500.0f),
		"a grenade against a tree hurts its own side");
}

void sceneryGeometryTestNormals()
{
	using scenery_geometry::normalAt;
	const Shape& wall = sceneryGeometryTestWall;
	float nx = 0.0f, ny = 0.0f;

	normalAt(wall, 480.0f, 500.0f, 1.0f, 0.0f, nx, ny);
	sceneryGeometryTestCheck(nx == -1.0f && ny == 0.0f, "west face points west");
	normalAt(wall, 500.0f, 400.0f, 0.0f, 1.0f, nx, ny);
	sceneryGeometryTestCheck(nx == 0.0f && ny == -1.0f, "north face points north");

	// The north-west corner, met heading mostly east: the west face faces it.
	const float d = 1.0f / std::sqrt(1.0f + 0.04f);
	normalAt(wall, 480.0f, 400.0f, d, 0.2f * d, nx, ny);
	sceneryGeometryTestCheck(nx == -1.0f && ny == 0.0f, "a corner met heading east takes the west face");
	normalAt(wall, 480.0f, 400.0f, 0.2f * d, d, nx, ny);
	sceneryGeometryTestCheck(nx == 0.0f && ny == -1.0f, "a corner met heading south takes the north face");

	normalAt(sceneryGeometryTestTree, 470.0f, 500.0f, 1.0f, 0.0f, nx, ny);
	sceneryGeometryTestCheck(sceneryGeometryTestNear(nx, -1.0f, 0.001f) && sceneryGeometryTestNear(ny, 0.0f, 0.001f),
		"a circle's normal points from its centre");
}

void sceneryGeometryTestBounce()
{
	using scenery_geometry::bounce;
	using scenery_geometry::BounceLeg;
	const Shape& wall = sceneryGeometryTestWall;
	BounceLeg leg;

	// Head-on into the west face at 200 u/s, 100 units short of the target.
	sceneryGeometryTestCheck(bounce(wall, 470.0f, 500.0f, 480.0f, 500.0f, 200.0f, 0.0f, 580.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"head-on bounce happens");
	sceneryGeometryTestCheck(sceneryGeometryTestNear(leg.vx, -100.0f) && sceneryGeometryTestNear(leg.vy, 0.0f),
		"head-on comes straight back at half speed");
	sceneryGeometryTestCheck(sceneryGeometryTestNear(leg.fromX, 480.0f - scenery_geometry::kBounceSurfaceOffset),
		"the new leg starts off the surface");
	sceneryGeometryTestCheck(sceneryGeometryTestNear(leg.toX, leg.fromX - 50.0f) && sceneryGeometryTestNear(leg.toY, 500.0f),
		"it goes half the distance it had left");

	// 45 degrees into the west face leaves at 45 degrees.
	const float v = 200.0f / std::sqrt(2.0f);
	sceneryGeometryTestCheck(bounce(wall, 470.0f, 490.0f, 480.0f, 500.0f, v, v, 580.0f, 600.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"glancing bounce happens");
	sceneryGeometryTestCheck(leg.vx < 0.0f && leg.vy > 0.0f && sceneryGeometryTestNear(-leg.vx, leg.vy, 0.01f),
		"45 degrees in, 45 degrees out");
	sceneryGeometryTestCheck(leg.toX < 480.0f, "a bounced grenade never ends inside the wall it hit");

	// Off a tree, head-on through its centre: straight back.
	sceneryGeometryTestCheck(bounce(sceneryGeometryTestTree, 460.0f, 500.0f, 470.0f, 500.0f, 200.0f, 0.0f, 600.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg)
		&& leg.vx < 0.0f && sceneryGeometryTestNear(leg.vy, 0.0f, 0.01f), "a tree throws it straight back");

	// Handed the point of closest approach inside a rock (what the bullet test
	// reports), it still bounces from where the path entered the rock.
	sceneryGeometryTestCheck(bounce(sceneryGeometryTestTree, 400.0f, 500.0f, 490.0f, 500.0f, 200.0f, 0.0f, 600.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg)
		&& sceneryGeometryTestNear(leg.fromX, 470.0f - scenery_geometry::kBounceSurfaceOffset)
		&& !scenery_geometry::containsDeep(sceneryGeometryTestTree, leg.fromX, leg.fromY, 0.0f),
		"a bounce off a circle starts outside it");

	// Entry points.
	float hx = 0.0f, hy = 0.0f;
	sceneryGeometryTestCheck(scenery_geometry::segmentHit(sceneryGeometryTestTree, 400.0f, 500.0f, 600.0f, 500.0f, hx, hy)
		&& sceneryGeometryTestNear(hx, 470.0f), "a segment enters a circle on its rim");
	sceneryGeometryTestCheck(!scenery_geometry::segmentHit(sceneryGeometryTestTree, 400.0f, 500.0f, 460.0f, 500.0f, hx, hy),
		"a segment that stops short of a circle misses it");
	sceneryGeometryTestCheck(!scenery_geometry::segmentHit(sceneryGeometryTestTree, 400.0f, 600.0f, 600.0f, 600.0f, hx, hy),
		"a segment past a circle misses it");

	// Nothing to bounce.
	sceneryGeometryTestCheck(!bounce(wall, 485.0f, 500.0f, 485.0f, 500.0f, 200.0f, 0.0f, 580.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"a step that began inside the wall does not bounce");
	sceneryGeometryTestCheck(!bounce(wall, 470.0f, 500.0f, 480.0f, 500.0f, 30.0f, 0.0f, 580.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"too slow to bounce");
	sceneryGeometryTestCheck(!bounce(wall, 470.0f, 500.0f, 480.0f, 500.0f, 200.0f, 0.0f, 490.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"too little left to bounce");

	// Moving away from a face is not a bounce.
	sceneryGeometryTestCheck(!bounce(wall, 600.0f, 500.0f, 520.0f, 500.0f, 200.0f, 0.0f, 900.0f, 500.0f, 0.5f, 9999.0f, 9999.0f, leg),
		"moving away from a face is not a bounce");

	// Near the map edge the leg is kept on the map: a wall whose west face is at
	// x = 40, hit heading east with 200 units to go, sends it back past x = 0.
	const Shape edgeWall = Shape::ofRect({ 60.0f, 500.0f, 20.0f, 100.0f });
	sceneryGeometryTestCheck(bounce(edgeWall, 30.0f, 500.0f, 40.0f, 500.0f, 400.0f, 0.0f, 240.0f, 500.0f, 1.0f, 9999.0f, 9999.0f, leg)
		&& leg.toX == 0.0f && leg.fromX > 0.0f, "a leg is clamped to the map");
}

void sceneryGeometryTestFragments()
{
	using scenery_geometry::fragmentStart;
	using scenery_geometry::FragmentStart;
	const Shape& wall = sceneryGeometryTestWall;
	float at = 0.0f;

	// Open ground: the wall is somewhere else, whatever the direction.
	sceneryGeometryTestCheck(fragmentStart(wall, 400.0f, 500.0f, 1.0f, 0.0f, at) == FragmentStart::Clear,
		"a blast in the open is clear of a wall 80 away");
	sceneryGeometryTestCheck(fragmentStart(wall, 400.0f, 500.0f, -1.0f, 0.0f, at) == FragmentStart::Clear,
		"and so is a fragment flying away from it");

	// A grenade on the west face (x = 480): on it exactly, a unit inside and a
	// unit out. Into the wall it is stopped; away from it, it starts just
	// outside the face, never inside it.
	const float d = 1.0f / std::sqrt(2.0f);
	for (const float x : { 480.0f, 481.0f, 478.0f }) {
		sceneryGeometryTestCheck(fragmentStart(wall, x, 500.0f, 1.0f, 0.0f, at) == FragmentStart::Stopped,
			fmt::format("from x={} a fragment into the wall is stopped", x));
		sceneryGeometryTestCheck(fragmentStart(wall, x, 500.0f, d, d, at) == FragmentStart::Stopped,
			fmt::format("from x={} a fragment into the wall at an angle is stopped", x));
		for (const auto& dir : { std::pair{ -1.0f, 0.0f }, std::pair{ -d, d }, std::pair{ -d, -d } }) {
			const bool exits = fragmentStart(wall, x, 500.0f, dir.first, dir.second, at) == FragmentStart::Exit;
			const float startX = x + dir.first * at;
			sceneryGeometryTestCheck(exits && startX < 480.0f && !scenery_geometry::containsDeep(wall, startX, 500.0f + dir.second * at, 0.0f),
				fmt::format("from x={} a fragment leaving at ({:.2f}, {:.2f}) starts outside the face", x, dir.first, dir.second));
		}
	}

	// The wall's own blast: every fragment flies out of it, from its far side.
	for (const auto& dir : { std::pair{ 1.0f, 0.0f }, std::pair{ -1.0f, 0.0f }, std::pair{ 0.0f, 1.0f } }) {
		const bool exits = fragmentStart(wall, 500.0f, 500.0f, dir.first, dir.second, at) == FragmentStart::Exit;
		const float sx = 500.0f + dir.first * at;
		const float sy = 500.0f + dir.second * at;
		sceneryGeometryTestCheck(exits && !scenery_geometry::containsDeep(wall, sx, sy, 0.0f),
			fmt::format("a fragment of the wall's own blast heading ({}, {}) starts outside it", dir.first, dir.second));
	}

	// A tree: a fragment from its bark flies away, one heading in is stopped.
	const Shape& tree = sceneryGeometryTestTree;
	sceneryGeometryTestCheck(fragmentStart(tree, 470.0f, 500.0f, -1.0f, 0.0f, at) == FragmentStart::Exit && at > 0.0f &&
		                         at <= scenery_geometry::kBounceSurfaceOffset + 0.5f,
		"from a tree's bark, a fragment away from it starts just off the bark");
	sceneryGeometryTestCheck(fragmentStart(tree, 470.0f, 500.0f, 1.0f, 0.0f, at) == FragmentStart::Stopped,
		"from a tree's bark, a fragment into it is stopped");
	sceneryGeometryTestCheck(fragmentStart(tree, 400.0f, 500.0f, 1.0f, 0.0f, at) == FragmentStart::Clear,
		"a tree 70 away is no business of the fragment's start");
}
} // namespace

int scenery_geometry::runSelfTest()
{
	sceneryGeometryTestFailures = 0;
	sceneryGeometryTestShelter();
	sceneryGeometryTestNormals();
	sceneryGeometryTestBounce();
	sceneryGeometryTestFragments();
	fmt::print(">> scenery geometry self-test: {}\n",
		sceneryGeometryTestFailures == 0 ? "ok" : fmt::format("{} failure(s)", sceneryGeometryTestFailures));
	return sceneryGeometryTestFailures;
}
