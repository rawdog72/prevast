// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_TOOLS_H
#define FS_TOOLS_H

#include "core/enums.h"


std::vector<std::string_view> explodeString(std::string_view inString, const std::string& separator,
    int32_t limit = -1);

std::mt19937& getRandomGenerator();

// Opaque guest bearer credential; never an account ID or a gameplay RNG value.
std::string makeGuestSessionToken();

// Pin both RNGs for reproducible world generation (config.lua `seed`).
// Benchmarking is the reason this exists: see prevast_server.cpp.
void seedRandomGenerator(uint32_t seed);

// The seed the current world was generated from. Always a real number, even
// when config.lua leaves `seed` at 0 -- startup picks one and records it,
// so !seed can report a value that actually reproduces this world.
uint32_t getWorldSeed();

// Does config.lua name a specific world, or ask for a fresh one?
//
// The distinction only matters where a world is built more than once in a
// session: a ghoul-mode round ends by regenerating the map, and a pinned seed
// means every round replays the same world while a random one means each round
// is new ground. Startup asks the same question for its own first build.
bool isWorldSeedPinned();

// The seed to build the NEXT world from: the pinned one if config.lua names it,
// otherwise a fresh draw from the clock. Never returns 0, which is the "unset"
// sentinel in config.lua and so cannot also be a real seed.
uint32_t rollWorldSeed();
int32_t uniform_random(int32_t minNumber, int32_t maxNumber);

// Truncate to at most maxLength BYTES without splitting a multi-byte UTF-8
// sequence (an invalid byte sequence inside a JSON string corrupts the
// websocket text frame for every receiving client).
std::string truncateUtf8(std::string str, size_t maxLength);

std::string formatDateShort(time_t time);

bool booleanString(std::string_view str);

int64_t OTSYS_TIME();

// --- Content files -----------------------------------------------------------
//
// Resolves "items.xml" against config.lua's contentPath. Every loader path goes
// through here so the three build trees can share one content directory instead
// of each carrying a copy that drifts from the others.
//
// Config is read on the first call and cached: the path cannot change while the
// server runs, and loaders ask for it often enough that re-reading would be
// noise. Call only after ConfigManager::load().
std::string contentFile(std::string_view name);

// --- Startup data-file reporting --------------------------------------------
//
// One aligned line per data file, so the boot log can be read at a glance.
// Per-record detail belongs in the file itself, not on the console: a loader
// reports how much it loaded and otherwise stays quiet. Anything genuinely
// wrong goes through reportDataWarning, which is what makes a problem visible
// -- it cannot stand out if every successful record also prints a line.
void reportDataFile(std::string_view fileName, std::string_view summary);
void reportDataWarning(std::string_view fileName, std::string_view message);

// A startup problem not tied to one data file (config, id pool, world gen).
// Counted alongside the data warnings so the closing summary cannot claim
// "no errors" while a yellow line is still on screen.
//
// Load-time only. Runtime warnings -- the "no entity id available" family that
// fires during play -- deliberately do NOT go through here; they would inflate
// a number that is meant to describe the boot.
void reportStartupWarning(std::string_view message);
uint32_t startupWarningCount();


#endif // FS_TOOLS_H
