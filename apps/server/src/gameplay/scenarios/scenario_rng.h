// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_RNG_H
#define FS_SCENARIO_RNG_H

// Deterministic random streams for a scenario: one per (world seed, authored
// source, purpose). A chest's loot depends on its own ID and the seed only, so
// editing some other object never rerolls it, and the same project and seed
// roll the same contents on every server.

#include <cstdint>
#include <string_view>

namespace scenario {

constexpr uint64_t fnv1a64(std::string_view text)
{
	uint64_t hash = 0xcbf29ce484222325ULL;
	for (const char c : text) {
		hash ^= static_cast<unsigned char>(c);
		hash *= 0x100000001b3ULL;
	}
	return hash;
}

constexpr uint64_t splitmix64(uint64_t x)
{
	x += 0x9e3779b97f4a7c15ULL;
	x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9ULL;
	x = (x ^ (x >> 27)) * 0x94d049bb133111ebULL;
	return x ^ (x >> 31);
}

class Stream
{
public:
	Stream() = default;
	Stream(uint32_t seed, std::string_view source, std::string_view purpose)
		: base(splitmix64(splitmix64(seed) ^ fnv1a64(source) ^ (fnv1a64(purpose) * 0x9e3779b97f4a7c15ULL)))
	{}

	uint64_t next() { return splitmix64(base + ++counter * 0xd1b54a32d192ed03ULL); }
	// 0..n-1; 0 when n is 0. The modulo bias is below 2^-32 for any n used here.
	uint32_t below(uint32_t n) { return n ? static_cast<uint32_t>(next() % n) : 0; }
	// lo..hi inclusive.
	uint32_t between(uint32_t lo, uint32_t hi) { return hi <= lo ? lo : lo + below(hi - lo + 1); }

private:
	uint64_t base = 0;
	uint64_t counter = 0;
};

} // namespace scenario

#endif // FS_SCENARIO_RNG_H
