// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/aim_view.h"
#include <boost/json.hpp>
#include <cmath>
#include <fmt/format.h>
#include <fstream>
#include <numbers>
#include <sstream>

// Every file-local name carries an aimViewTest prefix: the server builds as
// unity files, where an unprefixed helper collides with another file's.
namespace {
int aimViewTestFailures = 0;

void aimViewTestCheck(bool ok, std::string_view what)
{
	if (!ok) {
		++aimViewTestFailures;
		fmt::print(">> aim view self-test FAILED: {}\n", what);
	}
}

bool aimViewTestMentions(const std::vector<std::string>& problems, std::string_view fragment)
{
	for (const std::string& p : problems) {
		if (p.find(fragment) != std::string::npos) return true;
	}
	return false;
}

std::vector<std::string> aimViewTestAim(const char* xml, AimData& out)
{
	pugi::xml_document doc;
	doc.load_string(xml);
	return aim_view::parseAim(doc.document_element(), "'gun'", 0.08f, out);
}

void aimViewTestParseAim()
{
	AimData aim;
	aimViewTestCheck(aimViewTestAim(R"(<aim spreadPercent="-35" movePercent="-20" timeMs="250"/>)", aim).empty(),
		"a valid <aim> parses");
	aimViewTestCheck(aim.enabled && aim.timeMs == 250 && aim.ms == 250, "<aim> fields");
	aimViewTestCheck(std::fabs(aim.spread - 0.052f) < 1e-6f && std::fabs(aim.move - 0.8f) < 1e-6f,
		"the aimed spread and walk factor come from the base");
	aimViewTestCheck(aimViewTestMentions(aimViewTestAim(R"(<aim movePercent="-20" timeMs="250"/>)", aim),
		"spreadPercent="), "spreadPercent is required");
	aimViewTestCheck(aimViewTestMentions(aimViewTestAim(R"(<aim spreadPercent="5" movePercent="-20" timeMs="250"/>)", aim),
		"-95 to 0"), "a spreadPercent above 0 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestAim(R"(<aim spreadPercent="-35" movePercent="-95" timeMs="250"/>)", aim),
		"-90 to 0"), "a movePercent below -90 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestAim(R"(<aim spreadPercent="-35" movePercent="-20" timeMs="-1"/>)", aim),
		"negative"), "a negative timeMs is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestAim(R"(<aim spreadPercent="nan" movePercent="-20" timeMs="250"/>)", aim),
		"-95 to 0"), "a NaN spreadPercent is rejected");
	aimViewTestCheck(!aim.enabled, "a rejected <aim> leaves the weapon unable to aim");
}

std::vector<std::string> aimViewTestView(const char* xml, ViewData& out)
{
	pugi::xml_document doc;
	doc.load_string(xml);
	return aim_view::parseView(doc.document_element(), "mod 'scope'", out);
}

void aimViewTestParseView()
{
	ViewData view;
	aimViewTestCheck(aimViewTestView(R"(<view shape="stretch" ahead="250" zoom="0.95" extend="250"/>)", view).empty(),
		"a stretch view parses");
	aimViewTestCheck(view.shape == ViewShape::Stretch && view.ahead == 250 && view.extend == 250 &&
		std::fabs(view.zoom - 0.95f) < 1e-6f && view.weak(), "stretch view fields");
	aimViewTestCheck(aimViewTestView(R"(<view shape="shift" ahead="450" zoom="0.85" extend="500"/>)", view).empty() &&
		view.shape == ViewShape::Shift, "a shift view parses");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="triangle" ahead="1" zoom="1" extend="1"/>)", view),
		"stretch, shift, cone or rect"), "an unknown shape is rejected");
	aimViewTestCheck(view.shape == ViewShape::None, "a rejected view is no view");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="shift" zoom="0.85" extend="500"/>)", view),
		"ahead="), "ahead is required");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="shift" ahead="450" zoom="0.5" extend="500"/>)", view),
		"zoom=0.5 must be from 0.6 to 1"), "a zoom below 0.6 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="shift" ahead="450" zoom="0.85" extend="1300"/>)", view),
		"extend=1300"), "an extend above 1200 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="stretch" ahead="250" zoom="0.95" extend="250" reach="900"/>)", view),
		"does not take reach="), "an attribute of another shape is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(R"(<view shape="shift" ahead="450" zoom="0.85" extend="nan"/>)", view),
		"extend="), "a NaN extend is rejected");
	aimViewTestCheck(view.shape == ViewShape::None, "a view with a NaN number is no view");
}

void aimViewTestReach()
{
	ViewData reflex;
	reflex.shape = ViewShape::Stretch;
	reflex.ahead = 250;
	reflex.extend = 250;
	aimViewTestCheck(!aim_view::weakReachProblem(reflex, "mod 'reflex'", 1400, 900),
		"extend = ahead reaches past a zoomed-out client at 1400 x 900");
	reflex.extend = 200;
	const std::optional<std::string> shortReach = aim_view::weakReachProblem(reflex, "mod 'reflex'", 1400, 900);
	aimViewTestCheck(shortReach && shortReach->find("mod 'reflex'") != std::string::npos &&
		shortReach->find("230") != std::string::npos, "extend 200 is short: it names the view and the 230 it needs");
	reflex.extend = 0;
	aimViewTestCheck(!aim_view::weakReachProblem(reflex, "mod 'reflex'", 1700, 1700),
		"a bigger viewport covers the look-ahead without any extend");
	aimViewTestCheck(!aim_view::weakReachProblem(ViewData{}, "'gun'", 100, 100), "no view, no problem");

	// A shift view's box must keep the player and SHIFT_KEEP_BEHIND units behind them: extend <= min(viewX, viewY) - 200.
	ViewData tube;
	tube.shape = ViewShape::Shift;
	tube.ahead = 450;
	tube.extend = 500;
	aimViewTestCheck(!aim_view::weakReachProblem(tube, "mod 'tube'", 1400, 900), "a shift view of extend 500 at 1400 x 900 is fine");
	tube.extend = 700;
	aimViewTestCheck(!aim_view::weakReachProblem(tube, "mod 'tube'", 1400, 900), "a shift view of extend 700 (the limit) at 1400 x 900 is fine");
	tube.extend = 701;
	const std::optional<std::string> tooFar = aim_view::weakReachProblem(tube, "mod 'tube'", 1400, 900);
	aimViewTestCheck(tooFar && tooFar->find("mod 'tube'") != std::string::npos && tooFar->find("700") != std::string::npos &&
		tooFar->find("reaches too far") != std::string::npos,
		"a shift view of extend 701 at 1400 x 900 is a problem that names the view and the limit 700");
	// The smaller axis decides, whichever it is.
	ViewData blunt = tube; // ahead 0, so the lower bound (380 at 900 x 1400) stays out of the way
	blunt.ahead = 0;
	blunt.extend = 701;
	const std::optional<std::string> tallViewport = aim_view::weakReachProblem(blunt, "mod 'tube'", 900, 1400);
	aimViewTestCheck(tallViewport && tallViewport->find("700") != std::string::npos,
		"the smaller viewport axis sets the limit, X or Y");
	// config/benchmark.lua's 1700 x 1700 allows 1500.
	tube.extend = 1500;
	aimViewTestCheck(!aim_view::weakReachProblem(tube, "mod 'tube'", 1700, 1700), "extend 1500 at 1700 x 1700 is the limit and is fine");
	tube.extend = 1501;
	const std::optional<std::string> bigViewport = aim_view::weakReachProblem(tube, "mod 'tube'", 1700, 1700);
	aimViewTestCheck(bigViewport && bigViewport->find("1500") != std::string::npos, "extend 1501 at 1700 x 1700 names the limit 1500");
	ViewData wide = tube;
	wide.shape = ViewShape::Stretch;
	wide.extend = 1200;
	aimViewTestCheck(!aim_view::weakReachProblem(wide, "mod 'wide'", 1400, 900),
		"a stretch view of extend 1200 has no upper-bound problem: nothing it adds is ever lost");
}

void aimViewTestParseStrongView()
{
	ViewData view;
	aimViewTestCheck(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" back="100" zoom="0.55" rearRadius="250"/>)", view).empty(),
		"a rect view parses");
	aimViewTestCheck(view.shape == ViewShape::Rect && view.length == 1900 && view.width == 500 && view.back == 100 &&
		view.rearRadius == 250 && std::fabs(view.zoom - 0.55f) < 1e-6f && view.strong() && !view.weak(),
		"rect view fields");
	aimViewTestCheck(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" zoom="0.55" rearRadius="250"/>)", view).empty() && view.back == 0,
		"back may be left out, and is then 0");
	aimViewTestCheck(aimViewTestView(
		R"(<view shape="cone" reach="1500" halfAngleDeg="20" zoom="0.7" rearRadius="250"/>)", view).empty() &&
		view.shape == ViewShape::Cone && view.reach == 1500 && std::fabs(view.halfAngleDeg - 20.0f) < 1e-6f &&
		view.rearRadius == 250 && view.strong(), "a cone view parses");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="cone" reach="1500" zoom="0.7" rearRadius="250"/>)", view), "needs halfAngleDeg="),
		"a cone needs halfAngleDeg");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="1900" zoom="0.55" rearRadius="250"/>)", view), "needs width="),
		"a rect needs width");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" zoom="0.55"/>)", view), "needs rearRadius="),
		"a strong view needs rearRadius");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="cone" reach="1500" halfAngleDeg="20" zoom="0.7" rearRadius="250" length="900"/>)", view),
		"does not take length="), "a rect attribute on a cone is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" zoom="0.55" rearRadius="250" extend="300"/>)", view),
		"does not take extend="), "a weak attribute on a rect is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" zoom="0.3" rearRadius="250"/>)", view),
		"zoom=0.3 must be from 0.4 to 1"), "a strong zoom below 0.4 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="cone" reach="1500" halfAngleDeg="61" zoom="0.7" rearRadius="250"/>)", view),
		"halfAngleDeg=61 must be from 1 to 60"), "a half angle over 60 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="4100" width="500" zoom="0.55" rearRadius="250"/>)", view),
		"length=4100"), "a length over 4000 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="rect" length="1900" width="500" back="600" zoom="0.55" rearRadius="250"/>)", view),
		"back=600"), "a back over 500 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="cone" reach="1500" halfAngleDeg="20" zoom="0.7" rearRadius="100"/>)", view),
		"rearRadius=100 must be from 150 to 600"), "a rear radius under 150 is rejected");
	aimViewTestCheck(aimViewTestMentions(aimViewTestView(
		R"(<view shape="cone" reach="nan" halfAngleDeg="20" zoom="0.7" rearRadius="250"/>)", view),
		"reach="), "a NaN reach is rejected");
	aimViewTestCheck(view.shape == ViewShape::None, "a rejected strong view is no view");
}

void aimViewTestStrongRules()
{
	ViewData sniper;
	sniper.shape = ViewShape::Rect;
	sniper.length = 1900;
	sniper.width = 500;
	sniper.back = 100;
	sniper.zoom = 0.55f;
	sniper.rearRadius = 250;
	aimViewTestCheck(std::fabs(aim_view::strongArea(sniper) - (2000.0 * 500.0 + std::numbers::pi * 250.0 * 250.0)) < 1e-6,
		"a rect's area is (length + back) x width, plus the rear circle");
	aimViewTestCheck(!aim_view::strongAreaProblem(sniper, "'sniper'", 1400, 900), "the sniper fits the 2800 x 1800 box");
	ViewData huge = sniper;
	huge.length = 4000;
	huge.back = 0;
	huge.width = 2000;
	const std::optional<std::string> tooBig = aim_view::strongAreaProblem(huge, "'huge'", 1400, 900);
	aimViewTestCheck(tooBig && tooBig->find("'huge'") != std::string::npos && tooBig->find("5040000") != std::string::npos,
		"a 4000 x 2000 rect is over the 5040000 of 1400 x 900, and the problem names it and the budget");
	aimViewTestCheck(!aim_view::strongAreaProblem(huge, "'huge'", 1700, 1700), "the same rect fits 1700 x 1700's 11560000");

	ViewData cone;
	cone.shape = ViewShape::Cone;
	cone.reach = 1500;
	cone.halfAngleDeg = 20.0f;
	cone.zoom = 0.7f;
	cone.rearRadius = 250;
	aimViewTestCheck(std::fabs(aim_view::strongArea(cone) -
		(20.0 * std::numbers::pi / 180.0 * 1500.0 * 1500.0 + std::numbers::pi * 250.0 * 250.0)) < 1e-3,
		"a cone's area is halfAngle (radians) x reach squared, plus the rear circle");
	ViewData wide = cone;
	wide.reach = 4000;
	wide.halfAngleDeg = 60.0f;
	wide.rearRadius = 600;
	aimViewTestCheck(aim_view::strongAreaProblem(wide, "'wide'", 1700, 1700).has_value(),
		"a 120-degree cone reaching 4000 is over even 1700 x 1700");
	aimViewTestCheck(!aim_view::strongAreaProblem(ViewData{}, "'gun'", 100, 100), "no view, no area problem");
	ViewData tube;
	tube.shape = ViewShape::Shift;
	tube.extend = 500;
	aimViewTestCheck(!aim_view::strongAreaProblem(tube, "mod 'tube'", 100, 100), "a weak view has no area budget");

	// Past 0.85 x 880 / zoom, the far end leaves the screen when aiming along its short side.
	const std::optional<std::string> note = aim_view::strongScreenNote(sniper, "'sniper'");
	aimViewTestCheck(note && note->find("'sniper'") != std::string::npos && note->find("1360") != std::string::npos,
		"the sniper's 1900 is past the 1360 a client shows at zoom 0.55, and the note says so");
	ViewData shortCone = cone;
	shortCone.reach = 1000;
	aimViewTestCheck(!aim_view::strongScreenNote(shortCone, "'cone'"), "a cone of 1000 at zoom 0.7 fits in 1068");
	aimViewTestCheck(!aim_view::strongScreenNote(tube, "mod 'tube'"), "a weak view gets no off-screen note");
}

void aimViewTestAimState()
{
	aimViewTestCheck(aim_view::aimShouldBeActive(true, true, false, true, false), "held, alive, a gun that aims, idle: aiming");
	aimViewTestCheck(!aim_view::aimShouldBeActive(false, true, false, true, false), "not held: not aiming");
	aimViewTestCheck(!aim_view::aimShouldBeActive(true, false, false, true, false), "dead: not aiming");
	aimViewTestCheck(!aim_view::aimShouldBeActive(true, true, true, true, false), "a ghoul: not aiming");
	aimViewTestCheck(!aim_view::aimShouldBeActive(true, true, false, false, false), "a weapon without <aim>: not aiming");
	aimViewTestCheck(!aim_view::aimShouldBeActive(true, true, false, true, true),
		"an interaction (reload, equip, consume, craft, mod change) blocks it, and it resumes once that ends");

	AimData aim;
	aim.enabled = true;
	aim.spread = 0.02f;
	aim.ms = 200;
	aimViewTestCheck(aim_view::spreadAt(0.08f, aim, false, 1000) == 0.08f, "not aiming: the hip spread");
	aimViewTestCheck(aim_view::spreadAt(0.08f, aim, true, 0) == 0.08f, "aiming starts at the hip spread");
	aimViewTestCheck(std::fabs(aim_view::spreadAt(0.08f, aim, true, 100) - 0.05f) < 1e-6f, "halfway through aimMs: halfway");
	aimViewTestCheck(aim_view::spreadAt(0.08f, aim, true, 200) == 0.02f, "after aimMs: the aimed spread");
	aim.ms = 0;
	aimViewTestCheck(aim_view::spreadAt(0.08f, aim, true, 0) == 0.02f, "aimMs 0: aimed at once");
	aim.enabled = false;
	aimViewTestCheck(aim_view::spreadAt(0.08f, aim, true, 500) == 0.08f, "a weapon that cannot aim keeps the hip spread");
}

// view-cases.json, parsed; null when it cannot be read, which is itself a failure.
boost::json::value aimViewTestFixture(const std::string& fixtureDir)
{
	std::ifstream in(fixtureDir + "/view-cases.json", std::ios::binary);
	aimViewTestCheck(static_cast<bool>(in), "view-cases.json is readable");
	if (!in) return nullptr;
	std::stringstream text;
	text << in.rdbuf();
	return boost::json::parse(text.str());
}

void aimViewTestBoxes(const boost::json::value& doc)
{
	for (const boost::json::value& c : doc.at("cases").as_array()) {
		const std::string name(c.at("name").as_string());
		ViewData view;
		if (const boost::json::value& v = c.at("view"); !v.is_null()) {
			const std::string shape(v.at("shape").as_string());
			view.shape = shape == "shift" ? ViewShape::Shift : ViewShape::Stretch;
			view.ahead = static_cast<uint16_t>(v.at("ahead").to_number<int>());
			view.extend = static_cast<uint16_t>(v.at("extend").to_number<int>());
			view.zoom = static_cast<float>(v.at("zoom").to_number<double>());
		}
		// The same expression as aim-view.test.ts, so both compute the same angle.
		const double angle = c.at("angleDeg").to_number<double>() * std::numbers::pi / 180.0;
		const PlayerView got = aim_view::aimedView(view, c.at("viewX").to_number<int>(), c.at("viewY").to_number<int>(), angle);
		const boost::json::value& e = c.at("expect");
		const auto want = [&](const char* key) { return e.at(key).to_number<int32_t>(); };
		aimViewTestCheck(got.box.minDX == want("minDX") && got.box.maxDX == want("maxDX") &&
			got.box.minDY == want("minDY") && got.box.maxDY == want("maxDY") &&
			got.offX == want("offX") && got.offY == want("offY"),
			fmt::format("{}: box {} {} {} {} off {} {}", name, got.box.minDX, got.box.maxDX, got.box.minDY,
				got.box.maxDY, got.offX, got.offY));
	}
}

void aimViewTestGate()
{
	const PlayerView normal = aim_view::normalView(1400, 900);
	aimViewTestCheck(normal.box.containsStrict(1399, -899) && !normal.box.containsStrict(1400, 0),
		"the scan's test is strict, as the old |dx| < viewX was");
	aimViewTestCheck(normal.box.containsInclusive(1400, -900) && !normal.box.containsInclusive(1401, 0),
		"canSee's test is inclusive, as isInRange was");

	// ROTATE's byte back to an angle: protocolgame.cpp sends degrees * 255 / 360.
	aimViewTestCheck(aim_view::rotationToRadians(0) == 0.0, "rotation 0 faces east");
	aimViewTestCheck(std::fabs(aim_view::rotationToRadians(191) * 180.0 / std::numbers::pi - 269.6) < 0.1,
		"rotation 191 (sent as 270 degrees) faces north");

	// Cosmetic radius 1000. Not aiming: around the player.
	aimViewTestCheck(aim_view::cosmeticReach(normal, 600, 800, 1000) && !aim_view::cosmeticReach(normal, 0, -1001, 1000),
		"not aiming: a circle around the player");
	ViewData shift;
	shift.shape = ViewShape::Shift;
	shift.extend = 500;
	const PlayerView north = aim_view::aimedView(shift, 1400, 900, 270.0 * std::numbers::pi / 180.0);
	aimViewTestCheck(aim_view::cosmeticReach(north, 0, -1450, 1000) && !aim_view::cosmeticReach(north, 0, 600, 1000),
		"shift north: the circle moves north with the box");
	ViewData stretch = shift;
	stretch.shape = ViewShape::Stretch;
	const PlayerView northStretch = aim_view::aimedView(stretch, 1400, 900, 270.0 * std::numbers::pi / 180.0);
	// The segment runs from (0, 0) to (0, -500): (0, -1450) is 950 from its far
	// end, (0, 990) is 990 from the player, (990, -250) is 990 from (0, -250).
	aimViewTestCheck(aim_view::cosmeticReach(northStretch, 0, -1450, 1000) &&
		aim_view::cosmeticReach(northStretch, 0, 990, 1000) && !aim_view::cosmeticReach(northStretch, 0, 1001, 1000) &&
		aim_view::cosmeticReach(northStretch, 990, -250, 1000),
		"stretch north: the circle sweeps from the player to the reach, and keeps the south");

	// Spectator candidates: within the box plus the margin, and within the cosmetic reach's bounds when a radius is given.
	aimViewTestCheck(aim_view::mayWatch(normal, 1500, 0, 0, 100) && !aim_view::mayWatch(normal, 1501, 0, 0, 100),
		"a candidate up to the box plus the tile margin");
	aimViewTestCheck(aim_view::mayWatch(normal, 1100, 0, 1000, 100) && !aim_view::mayWatch(normal, 1101, 0, 1000, 100),
		"with a radius, only up to the radius plus the margin");
	aimViewTestCheck(aim_view::mayWatch(north, 0, -1450, 1000, 100) && !aim_view::mayWatch(north, 0, -1550, 1000, 100) &&
		!aim_view::mayWatch(north, 0, 700, 1000, 100),
		"aiming a shift view: candidates follow the moved box (to -1400 - 100) and circle; the lost south strip is gone");
	// A projectile gather (radius 900) centres on the shooter: a shooter 700 west
	// of a viewer aiming a shift view east is inside that viewer's box (dx from
	// -900) and must be a candidate, though the shifted cosmetic circle starts at -500.
	const PlayerView shiftEast = aim_view::aimedView(shift, 1400, 900, 0.0);
	aimViewTestCheck(aim_view::mayWatch(shiftEast, -700, 0, 900, 100),
		"a shooter behind a shift view, inside its box, is still a candidate for projectiles");
}
// A strong view from a shapeCases entry, read as content writes it.
ViewData aimViewTestStrongFrom(const boost::json::object& v)
{
	const auto num = [&](const char* key) {
		const boost::json::value* x = v.if_contains(key);
		return x ? x->to_number<double>() : 0.0;
	};
	ViewData view;
	view.shape = v.at("shape").as_string() == "cone" ? ViewShape::Cone : ViewShape::Rect;
	view.reach = static_cast<uint16_t>(num("reach"));
	view.halfAngleDeg = static_cast<float>(num("halfAngleDeg"));
	view.length = static_cast<uint16_t>(num("length"));
	view.width = static_cast<uint16_t>(num("width"));
	view.back = static_cast<uint16_t>(num("back"));
	view.zoom = static_cast<float>(num("zoom"));
	view.rearRadius = static_cast<uint16_t>(num("rearRadius"));
	return view;
}

// Within a unit of the fixture's box: bounds are rounded outward from cos and sin.
// (Not named `near`: the Windows headers define that as an empty macro.)
bool aimViewTestNear(const ViewBox& b, const boost::json::object& e)
{
	const auto within = [&](int32_t got, const char* key) { return std::abs(got - e.at(key).to_number<int32_t>()) <= 1; };
	return within(b.minDX, "minDX") && within(b.maxDX, "maxDX") && within(b.minDY, "minDY") && within(b.maxDY, "maxDY");
}

void aimViewTestShapes(const boost::json::value& doc)
{
	for (const boost::json::value& c : doc.at("shapeCases").as_array()) {
		const std::string name(c.at("name").as_string());
		const ViewData view = aimViewTestStrongFrom(c.at("view").as_object());
		// The same expression as aim-view.test.ts, so both compute the same angle.
		const double angle = c.at("angleDeg").to_number<double>() * std::numbers::pi / 180.0;
		const PlayerView got = aim_view::aimedView(view, c.at("viewX").to_number<int32_t>(),
			c.at("viewY").to_number<int32_t>(), angle);
		const StrongView& s = got.strong;
		aimViewTestCheck(s.shape == view.shape, fmt::format("{}: the view is strong", name));
		aimViewTestCheck(aimViewTestNear(s.bounds, c.at("bounds").as_object()), fmt::format("{}: bounds {} {} {} {}",
			name, s.bounds.minDX, s.bounds.maxDX, s.bounds.minDY, s.bounds.maxDY));
		aimViewTestCheck(aimViewTestNear(got.box, c.at("box").as_object()), fmt::format("{}: scenery box {} {} {} {}",
			name, got.box.minDX, got.box.maxDX, got.box.minDY, got.box.maxDY));
		for (const boost::json::value& p : c.at("points").as_array()) {
			const boost::json::array& at = p.at("at").as_array();
			const int32_t dx = at[0].to_number<int32_t>();
			const int32_t dy = at[1].to_number<int32_t>();
			const bool inner = p.at("inner").as_bool();
			const bool outer = p.at("outer").as_bool();
			const std::string what = fmt::format("{}: ({}, {}) {}", name, dx, dy, std::string(p.at("why").as_string()));
			aimViewTestCheck(aim_view::strongContains(s, dx, dy, false) == inner, what + ": the inner shape");
			aimViewTestCheck(aim_view::strongContains(s, dx, dy, true) == outer, what + ": the outer shape");
			// The pre-reject never drops what the outer shape holds; canSee answers with the outer shape.
			if (outer) aimViewTestCheck(s.bounds.containsInclusive(dx, dy), what + ": inside the bounds");
			aimViewTestCheck(aim_view::viewContains(got, dx, dy) == outer, what + ": canSee");
		}
	}
}

void aimViewTestStrongGate()
{
	ViewData sniper;
	sniper.shape = ViewShape::Rect;
	sniper.length = 1900;
	sniper.width = 500;
	sniper.back = 100;
	sniper.zoom = 0.55f;
	sniper.rearRadius = 250;
	const PlayerView east = aim_view::aimedView(sniper, 1400, 900, 0.0);

	// Cosmetic events: the shape replaces the radius (canSee has tested the shape).
	aimViewTestCheck(aim_view::cosmeticReach(east, 1900, 0, 1000),
		"a strong view takes cosmetic events from anywhere in the shape, past the radius");

	// Spectator candidates (bounds 1995 ahead, scenery box from -1400; margin 100).
	aimViewTestCheck(aim_view::mayWatch(east, 1900, 0, 1000, 100), "an event far down the rect gathers the scoped player");
	aimViewTestCheck(aim_view::mayWatch(east, -1000, 0, 1000, 100),
		"a shooter 1000 behind is still gathered: bullets are measured around the player");
	aimViewTestCheck(!aim_view::mayWatch(east, -1300, 0, 1000, 100),
		"but not one outside both the shape's bounds and the radius around the player");
	aimViewTestCheck(aim_view::mayWatch(east, -1300, 0, 0, 100),
		"with no radius, the whole scenery box gathers (surgical updates of scenery)");
	aimViewTestCheck(!aim_view::mayWatch(east, 2100, 0, 0, 100), "and nothing past the scenery box plus the margin");

	// The scan's cursor over the known set: ids asked in ascending order, some skipped.
	const std::vector<uint32_t> ids{3, 7, 9, 20};
	aim_view::KnownCursor known{ids};
	aimViewTestCheck(!known.has(1) && known.has(3) && !known.has(8) && known.has(9) && !known.has(15) &&
		known.has(20) && !known.has(30), "the known cursor answers ascending ids, skipping some");

	// Without a strong view, nothing changes.
	const PlayerView normal = aim_view::normalView(1400, 900);
	aimViewTestCheck(normal.strong.shape == ViewShape::None && aim_view::viewContains(normal, 1400, -900) &&
		!aim_view::viewContains(normal, 1401, 0), "without a strong view, canSee is the inclusive box, as before");
	ViewData shift;
	shift.shape = ViewShape::Shift;
	shift.extend = 500;
	aimViewTestCheck(aim_view::aimedView(shift, 1400, 900, 0.0).strong.shape == ViewShape::None,
		"a weak view has no strong shape");
}
} // namespace

int aim_view::runSelfTest(const std::string& fixtureDir)
{
	aimViewTestFailures = 0;
	aimViewTestParseAim();
	aimViewTestParseView();
	aimViewTestReach();
	aimViewTestParseStrongView();
	aimViewTestStrongRules();
	aimViewTestAimState();
	const boost::json::value fixture = aimViewTestFixture(fixtureDir);
	if (!fixture.is_null()) {
		aimViewTestBoxes(fixture);
		aimViewTestShapes(fixture);
	}
	aimViewTestGate();
	aimViewTestStrongGate();
	if (aimViewTestFailures == 0) fmt::print(">> aim view self-test passed\n");
	return aimViewTestFailures == 0 ? 0 : 1;
}
