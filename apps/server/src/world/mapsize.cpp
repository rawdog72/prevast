// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "world/mapsize.h"

#include "content/configmanager.h"

#include <algorithm>
#include <cctype>
#include <fmt/color.h>
#include <fmt/format.h>

namespace {

// Seeded by loadFromConfig before anything reads them. The defaults are the
// reference size, so a config that somehow fails to load still produces the
// world every content file is authored against rather than a degenerate one.
int32_t liveTilesX = MapSize::REFERENCE_TILES_X;
int32_t liveTilesY = MapSize::REFERENCE_TILES_Y;

bool digitsOnly(const std::string& s)
{
	return !s.empty() && s.size() <= 6 &&
		std::all_of(s.begin(), s.end(),
			[](char c) { return std::isdigit(static_cast<unsigned char>(c)) != 0; });
}

} // namespace

int32_t MapSize::tilesX() { return liveTilesX; }
int32_t MapSize::tilesY() { return liveTilesY; }

int64_t MapSize::tileCount()
{
	return static_cast<int64_t>(liveTilesX) * static_cast<int64_t>(liveTilesY);
}

bool MapSize::apply(int32_t newTilesX, int32_t newTilesY, std::string& error)
{
	if (!validate(newTilesX, newTilesY, error)) {
		return false;
	}

	liveTilesX = newTilesX;
	liveTilesY = newTilesY;
	return true;
}

bool MapSize::validate(int32_t newTilesX, int32_t newTilesY, std::string& error)
{
	if (newTilesX < MIN_TILES || newTilesY < MIN_TILES) {
		error = fmt::format("{}x{} is too small. The smallest map with anywhere legal to "
			"spawn is {}x{} tiles.", newTilesX, newTilesY, MIN_TILES, MIN_TILES);
		return false;
	}
	if (newTilesX > MAX_TILES || newTilesY > MAX_TILES) {
		error = fmt::format("{}x{} is too large. {} tiles is the ceiling: a Position is "
			"uint16, so {} units is the largest coordinate that exists and tile {} is the "
			"last one addressable.", newTilesX, newTilesY, MAX_TILES, 0xFFFF, MAX_TILES - 1);
		return false;
	}

	return true;
}

bool MapSize::parse(const std::string& text, int32_t& outTilesX, int32_t& outTilesY,
                    std::string& error)
{
	const size_t colon = text.find(':');
	if (colon == std::string::npos) {
		error = "Expected <tilesX>:<tilesY>, in TILES (150:150 is the standard map).";
		return false;
	}

	const std::string xPart = text.substr(0, colon);
	const std::string yPart = text.substr(colon + 1);

	// Digits only, rather than leaving it to stoi. stoi stops at the first
	// non-digit, so "60abc:60" would quietly resize the world to 60 -- and a
	// resize is not something anyone should get by accident.
	if (!digitsOnly(xPart) || !digitsOnly(yPart)) {
		error = fmt::format("'{}' is not a size. Expected <tilesX>:<tilesY> in tiles, "
			"digits only.", text);
		return false;
	}

	outTilesX = std::stoi(xPart);
	outTilesY = std::stoi(yPart);
	return true;
}

void MapSize::loadFromConfig()
{
	// Once per process, whoever asks first.
	//
	// Two callers need the size installed and neither can be the sole owner:
	// Game::loadContentDefinitions (which is also the --validate entry point)
	// and configureEntityIdPool, which sizes the id pool from the tile count
	// and runs BEFORE Game::start at boot. Sizing that pool against the default
	// 150x150 while config.lua asked for something else is silent and wrong, so
	// this is a no-op on the second call rather than order-dependent -- and
	// re-running it would also double-count any warning it emits, which feeds
	// the startup warning summary.
	static bool loaded = false;
	if (loaded) {
		return;
	}
	loaded = true;

	int32_t x = ConfigManager::getNumber(ConfigManager::MAP_TILES_X);
	int32_t y = ConfigManager::getNumber(ConfigManager::MAP_TILES_Y);

	// The retired keys, in world units. Accepted so an unmigrated config.lua --
	// notably the benchmark rig, which is deliberately divergent and not
	// overwritten from the shipped one -- still boots. Loud, because a stale key
	// silently doing the right thing is how it stays stale forever.
	if (x <= 0 || y <= 0) {
		const int32_t legacyW = ConfigManager::getNumber(ConfigManager::MAP_LEGACY_WIDTH);
		const int32_t legacyH = ConfigManager::getNumber(ConfigManager::MAP_LEGACY_HEIGHT);
		if (legacyW > 0 && legacyH > 0) {
			x = legacyW / TILE_SIZE;
			y = legacyH / TILE_SIZE;
			fmt::print(fg(fmt::color::orange),
				">> [config] mapWidth/mapHeight are retired. Read {}x{} units as {}x{} TILES; "
				"replace them with mapTilesX = {} / mapTilesY = {}.\n",
				legacyW, legacyH, x, y, x, y);

			if (legacyW % TILE_SIZE != 0 || legacyH % TILE_SIZE != 0) {
				fmt::print(fg(fmt::color::crimson),
					">> [config] ...and {}x{} is not a whole number of {}-unit tiles, so the "
					"remainder was dropped. This is exactly the truncation the tile-based keys "
					"exist to make impossible.\n", legacyW, legacyH, TILE_SIZE);
			}
		} else {
			x = REFERENCE_TILES_X;
			y = REFERENCE_TILES_Y;
			fmt::print(fg(fmt::color::orange),
				">> [config] no mapTilesX/mapTilesY found; defaulting to {}x{} tiles.\n", x, y);
		}
	}

	std::string error;
	if (!apply(x, y, error)) {
		fmt::print(fg(fmt::color::crimson) | fmt::emphasis::bold,
			">> [config] {} Falling back to {}x{}.\n", error, REFERENCE_TILES_X, REFERENCE_TILES_Y);
		liveTilesX = REFERENCE_TILES_X;
		liveTilesY = REFERENCE_TILES_Y;
	}
}

// --- Content budget ----------------------------------------------------------

MapSize::ContentBudget MapSize::makeContentBudget()
{
	int32_t percent = ConfigManager::getNumber(ConfigManager::WORLD_FILL_PERCENT);
	percent = std::clamp(percent, 1, 100);

	ContentBudget budget;
	// Multiply before dividing, in int64. The tile count reaches 65,025 and the
	// percentage is applied to it, so this overflows an int32 for large maps --
	// and doing it the other way ((tiles/100)*percent) throws away up to 99
	// tiles of budget to truncation for no reason.
	budget.totalTiles = (tileCount() * percent) / 100;
	return budget;
}

uint32_t MapSize::ContentScale::apply(uint32_t authored) const
{
	if (num == den || authored == 0) {
		return authored;
	}
	if (num <= 0 || den <= 0) {
		return 0;
	}

	const int64_t scaled = (static_cast<int64_t>(authored) * num) / den;

	// A type that was asked for at all survives at 1 rather than vanishing. A
	// small map should be a small version of the same world; a world silently
	// missing a whole resource type is a different world, and the recipes that
	// need it become uncraftable with nothing on screen to explain why.
	return static_cast<uint32_t>(std::max<int64_t>(1, scaled));
}

MapSize::ContentScale MapSize::densityScale()
{
	if (!ConfigManager::getBoolean(ConfigManager::SCALE_WORLD_CONTENT)) {
		return ContentScale{};
	}
	const int64_t referenceTiles =
		static_cast<int64_t>(REFERENCE_TILES_X) * static_cast<int64_t>(REFERENCE_TILES_Y);
	if (tileCount() == referenceTiles) {
		return ContentScale{}; // exact identity at the reference size
	}
	return ContentScale{ tileCount(), referenceTiles };
}

MapSize::ContentScale MapSize::contentScaleFor(uint32_t authoredTotal, int64_t budgetTiles,
                                               int growthPercent)
{
	if (authoredTotal == 0) {
		return ContentScale{};
	}

	const int64_t authored = static_cast<int64_t>(authoredTotal);

	// Stage 1: density, damped by growthPercent. At 100 this is exactly the
	// factor densityScale() hands out on its own, so undamped placed content
	// and live populations cannot drift apart.
	int64_t desired = authored;
	if (ConfigManager::getBoolean(ConfigManager::SCALE_WORLD_CONTENT)) {
		const int64_t referenceTiles =
			static_cast<int64_t>(REFERENCE_TILES_X) * static_cast<int64_t>(REFERENCE_TILES_Y);
		const int64_t pct = std::clamp<int64_t>(growthPercent, 0, 100);

		// factor = 1 + (tiles/reference - 1) * pct/100, as one rational:
		//   num = reference*100 + (tiles - reference)*pct
		//   den = reference*100
		// tiles == reference gives num == den for every pct, which is what
		// makes a reference-sized world independent of this setting.
		const int64_t den = referenceTiles * 100;
		const int64_t num = den + (tileCount() - referenceTiles) * pct;
		desired = (authored * std::max<int64_t>(0, num)) / den;
	}

	// Stage 2: the budget clamp, which applies whether or not stage 1 ran --
	// absolute XML counts can overrun a small map just as easily.
	const int64_t granted = std::max<int64_t>(0, std::min(desired, budgetTiles));

	// Expressed against the authored total so callers scale each individual
	// count by one identical rational. Reduced to the identity when nothing
	// changed, so a reference-sized map provably generates the authored world.
	if (granted == authored) {
		return ContentScale{};
	}
	return ContentScale{ granted, authored };
}
