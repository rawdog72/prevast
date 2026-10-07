// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_WORLDGEN_H
#define FS_WORLDGEN_H

#include <cstdint>
#include <string_view>
#include <unordered_set>

// Deterministic randomness for world generation.
//
// Everything the world is built from draws from here instead of from the
// process RNG in tools.h. Two reasons, both of which surfaced as "I gave it the
// same seed twice and the cities moved":
//
//  - ONE stream threaded through every phase makes the phases depend on each
//    other. A phase that draws a different NUMBER of times -- because a bot was
//    standing where a chest wanted to go, so that chest's contents were never
//    rolled -- shifts every draw after it, and the next city lands somewhere
//    else. Here each phase takes its own stream, derived from the seed and a
//    NAME, so a phase can only ever move itself.
//  - Generation used rand(), which on MSVC is a 15-bit LCG: 32768 distinct
//    values, biased under `% n` for every n that is not a power of two, and
//    shared with every gameplay roll in the server.
//
// Streams are named rather than numbered so that adding a phase later does not
// renumber the existing ones and silently change every seed's world.
class WorldRng
{
public:
	explicit WorldRng(uint64_t seed = 0) : state(seed) {}

	// splitmix64. Chosen over mt19937 because the state is one word (a stream
	// costs nothing to create, which is what makes per-phase streams practical)
	// and because it is defined by arithmetic rather than by the standard
	// library, so a world does not depend on which compiler built the server.
	uint64_t next64()
	{
		uint64_t z = (state += 0x9E3779B97F4A7C15ull);
		z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
		z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
		return z ^ (z >> 31);
	}

	uint32_t next32() { return static_cast<uint32_t>(next64() >> 32); }

	// Unbiased [0, bound). Lemire's multiply-shift, with the rejection branch
	// that makes it exact. `rand() % 181` favours the low tiles of a 181-wide
	// map by ~0.5%; over thousands of placements that is a visible drift of the
	// whole world towards one corner.
	uint32_t below(uint32_t bound)
	{
		if (bound <= 1) {
			return 0;
		}
		uint64_t product = static_cast<uint64_t>(next32()) * bound;
		uint32_t low = static_cast<uint32_t>(product);
		if (low < bound) {
			const uint32_t threshold = (0u - bound) % bound;
			while (low < threshold) {
				product = static_cast<uint64_t>(next32()) * bound;
				low = static_cast<uint32_t>(product);
			}
		}
		return static_cast<uint32_t>(product >> 32);
	}

	// Inclusive on both ends, matching how the callers phrase their ranges.
	int32_t range(int32_t lo, int32_t hi)
	{
		if (hi <= lo) {
			return lo;
		}
		return lo + static_cast<int32_t>(below(static_cast<uint32_t>(hi - lo) + 1));
	}

	// [0, 1) with 24 bits of resolution -- the drop/fill tables are authored to
	// three decimals, so this is more than the data can express.
	float unit() { return static_cast<float>(next64() >> 40) * (1.0f / 16777216.0f); }

	bool chance(float probability) { return unit() < probability; }

private:
	uint64_t state = 0;
};

// The seed for one named sub-stream of `worldSeed`. `index` separates repeated
// uses of the same name (per resource type, per structure slot) so that adding
// or removing one does not reshuffle the rest.
inline uint64_t worldStreamSeed(uint32_t worldSeed, std::string_view name, uint64_t index = 0)
{
	uint64_t h = 0xCBF29CE484222325ull; // FNV-1a over the stream name
	for (const char c : name) {
		h ^= static_cast<unsigned char>(c);
		h *= 0x100000001B3ull;
	}
	h ^= (static_cast<uint64_t>(worldSeed) << 32) ^ worldSeed;
	h += index * 0x9E3779B97F4A7C15ull;

	// One mixing round, so adjacent indices do not start adjacent streams.
	h = (h ^ (h >> 30)) * 0xBF58476D1CE4E5B9ull;
	h = (h ^ (h >> 27)) * 0x94D049BB133111EBull;
	return h ^ (h >> 31);
}

inline WorldRng worldStream(uint32_t worldSeed, std::string_view name, uint64_t index = 0)
{
	return WorldRng(worldStreamSeed(worldSeed, name, index));
}

// --- Fingerprint -------------------------------------------------------------

// A digest of what the seed decided the world looks like, so "did that seed
// build the same map?" is one number to compare instead of a walk around it.
//
// Order-INDEPENDENT on purpose. Entity ids, and the order things land in the
// map's thing list, depend on what the previous world left behind; what the
// seed actually promises is that the same things are in the same places. So the
// digest must change when a tree moves and must not change when a tree is
// merely created earlier.
class WorldFingerprint
{
public:
	void add(uint64_t kind, int32_t x, int32_t y, uint32_t extra)
	{
		uint64_t h = kind * 0x9E3779B97F4A7C15ull;
		h ^= static_cast<uint64_t>(static_cast<uint32_t>(x)) << 32;
		h ^= static_cast<uint64_t>(static_cast<uint32_t>(y)) << 8;
		h ^= extra;
		h = (h ^ (h >> 30)) * 0xBF58476D1CE4E5B9ull;
		h = (h ^ (h >> 27)) * 0x94D049BB133111EBull;
		h ^= h >> 31;

		// Sum and xor together: the sum alone cannot see two entities swapping
		// hashes, the xor alone cancels an accidental duplicate pair to zero.
		sum += h;
		mixed ^= h;
		++entries;
	}

	uint32_t value() const
	{
		uint64_t h = sum ^ (mixed * 0xBF58476D1CE4E5B9ull) ^ (static_cast<uint64_t>(entries) << 32);
		h = (h ^ (h >> 33)) * 0xFF51AFD7ED558CCDull;
		h ^= h >> 33;
		return static_cast<uint32_t>(h ^ (h >> 32));
	}

	uint32_t count() const { return entries; }

	// The name a key hashes to, for `add`'s first argument.
	static uint64_t kindOf(std::string_view key)
	{
		uint64_t h = 0xCBF29CE484222325ull;
		for (const char c : key) {
			h ^= static_cast<unsigned char>(c);
			h *= 0x100000001B3ull;
		}
		return h;
	}

private:
	uint64_t sum = 0;
	uint64_t mixed = 0;
	uint32_t entries = 0;
};

// --- Generation scope --------------------------------------------------------
//
// Set for exactly as long as the world is being built. Two things consult it:
// object creation (for what a spawned chest holds) and the map importer, both
// of which are also used at runtime by players and must keep drawing from the
// normal RNG then.
namespace worldgen {

inline uint32_t activeSeed = 0;
inline bool active = false;
inline WorldFingerprint layout;
inline std::unordered_set<uint32_t> claimed;

// RAII rather than a pair of calls: generation has early returns, and a scope
// left open would silently pin every later player-built chest to one roll.
class Scope
{
public:
	explicit Scope(uint32_t seed)
	{
		activeSeed = seed;
		layout = WorldFingerprint{};
		claimed.clear();
		active = true;
	}
	~Scope()
	{
		active = false;
		activeSeed = 0;
		claimed.clear(); // ~150k tiles on a full map; not worth holding onto
	}
	Scope(const Scope&) = delete;
	Scope& operator=(const Scope&) = delete;
};

inline bool isActive() { return active; }

// Records one LAYOUT decision -- what the seed put where -- as distinct from
// what ended up existing.
//
// The two differ by whatever happened to be standing in the way, and it is the
// DECISION the seed promises to reproduce: a tree missing because a player was
// on the spot is not the world having changed its mind, and a fingerprint that
// moved for it would be useless for the one question it exists to answer.
inline void noteLayout(uint64_t kind, int32_t x, int32_t y, uint32_t extra)
{
	if (active) {
		layout.add(kind, x, y, extra);
	}
}

// --- Claimed tiles -----------------------------------------------------------
//
// Every tile the layout decided to use, WHETHER OR NOT anything was built on
// it. Generation tests against this as well as against the map.
//
// Without it the live world leaks back into the layout by a side door that
// survives every other precaution: a tree skipped because a player was standing
// there leaves the tile genuinely empty, so the next candidate the generator
// draws is accepted on ground that should have been taken -- and from there the
// two worlds diverge for real, not just by the one missing tree. That was the
// last remaining source of "same seed, different map", and it only shows up
// when somebody is actually standing in the way, which is why it survived the
// obvious fixes.
//
// Tile granularity is the right resolution and not an approximation: everything
// generation places sits on a tile centre, and the clearance test's own
// thresholds (60 units for a resource, 95 for a floor) are all below the 100
// between two neighbouring centres. Same tile or no conflict.
inline void claimTile(int32_t tileX, int32_t tileY)
{
	if (active) {
		claimed.insert((static_cast<uint32_t>(tileX) << 16) | static_cast<uint16_t>(tileY));
	}
}

inline bool tileClaimed(int32_t tileX, int32_t tileY)
{
	return active &&
		claimed.count((static_cast<uint32_t>(tileX) << 16) | static_cast<uint16_t>(tileY)) != 0;
}

// A [0, 1) roll for a piece of generated CONTENT, keyed by WHERE it is rather
// than by when it was rolled.
//
// This is what lets a tile be skipped -- a player is standing on it, a base is
// already there -- without moving anything else in the world. Under a single
// ordered stream, one skipped chest shifted every later draw in the phase,
// including the coordinates of the next city.
inline float contentRoll(int32_t x, int32_t y, std::string_view key, uint32_t index)
{
	WorldRng rng(worldStreamSeed(activeSeed, key,
		(static_cast<uint64_t>(static_cast<uint32_t>(x)) << 40) ^
		(static_cast<uint64_t>(static_cast<uint32_t>(y)) << 16) ^ index));
	return rng.unit();
}

} // namespace worldgen

#endif // FS_WORLDGEN_H
