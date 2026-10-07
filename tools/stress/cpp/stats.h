// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// Fleet-wide counters and the periodic report line.
//
// Every counter is a relaxed atomic: io threads add to them, the reporter
// thread reads them, and nothing here synchronises anything, so ordering does
// not matter. Bots accumulate per-frame in locals and fold into these once per
// frame rather than once per record -- at 250 bots x 250 records x 20Hz a
// per-record atomic would itself be a measurable cost in the harness.

#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace bot {

// Distance bands, in world units, for the relevance metrics. The client shows
// roughly 1280x720 units at 1080p (client.js: options.size 1280, scaleby =
// max(h/880, w/1280)), so band 0 is "on screen" and band 3 is only reachable
// with a viewport larger than the screen.
inline constexpr size_t BAND_COUNT = 4;
inline constexpr uint32_t BAND_EDGES[BAND_COUNT] = { 400, 900, 1700, 0xFFFFFFFF };
inline constexpr const char* BAND_NAMES[BAND_COUNT] = { "<400", "400-900", "900-1700", ">1700" };

inline size_t bandOf(uint32_t distance)
{
	for (size_t i = 0; i < BAND_COUNT; ++i) {
		if (distance < BAND_EDGES[i]) return i;
	}
	return BAND_COUNT - 1;
}

struct Stats {
	std::atomic<int64_t> live{0};
	std::atomic<int64_t> peak{0};
	std::atomic<uint64_t> connects{0};
	std::atomic<uint64_t> disconnects{0};
	std::atomic<uint64_t> errors{0};
	std::atomic<uint64_t> deaths{0};

	std::atomic<uint64_t> framesRx{0};
	std::atomic<uint64_t> bytesRx{0};
	std::atomic<uint64_t> framesTx{0};
	std::atomic<uint64_t> unitRecords{0};
	std::atomic<uint64_t> botTicks{0};

	// Scenario actions. Without these an itemchurn or combat run that is
	// silently no-oping (wrong iid, no ammo, loot out of range) is
	// indistinguishable from one that is working -- which is how a whole
	// benchmark suite once measured zero projectiles.
	std::atomic<uint64_t> throws{0};
	std::atomic<uint64_t> takes{0};
	std::atomic<uint64_t> shots{0};
	// Entities of a given type currently visible to bot 0, sampled at report
	// time. A crowd run should see ~the fleet size in players; an itemchurn run
	// should see a non-zero, churning loot count.
	std::atomic<uint64_t> seenPlayers{0};
	std::atomic<uint64_t> seenLoot{0};
	std::atomic<uint64_t> seenProjectiles{0};

	// Server-authoritative movement: summed distance between consecutive own
	// positions, and the time it covered. Their ratio is how fast the server is
	// actually walking players, independent of what the bots asked for.
	std::atomic<uint64_t> moveDistance{0};
	std::atomic<uint64_t> moveMillis{0};

	// Per-band relevance metrics, the gate for interest-management work.
	//
	// `updates` counts records received for an entity we already knew about.
	// `staleMs` sums the time since that entity's previous update, so
	// staleMs/updates is the mean interval at which a client is being told
	// about entities at that distance.
	//
	// `driftUnits` sums how far the entity's destination had moved since the
	// previous update. That is the upper bound on the client's positional
	// error, because the client dead-reckons to the last destination it was
	// given and parks there (client.js moveEntitie). driftUnits/updates is the
	// mean error a player at that distance sees.
	std::array<std::atomic<uint64_t>, BAND_COUNT> bandUpdates{};
	std::array<std::atomic<uint64_t>, BAND_COUNT> bandStaleMs{};
	std::array<std::atomic<uint64_t>, BAND_COUNT> bandDrift{};
	std::array<std::atomic<uint64_t>, BAND_COUNT> bandDriftMax{};

	void notePeak(int64_t current)
	{
		int64_t seen = peak.load(std::memory_order_relaxed);
		while (current > seen && !peak.compare_exchange_weak(seen, current, std::memory_order_relaxed)) {
		}
	}
};

// What one bot accumulates between folds. Plain ints, no atomics: this lives
// inside the bot and is only touched on its own strand.
struct FrameAccum {
	uint64_t records = 0;
	std::array<uint64_t, BAND_COUNT> updates{};
	std::array<uint64_t, BAND_COUNT> staleMs{};
	std::array<uint64_t, BAND_COUNT> drift{};
	std::array<uint64_t, BAND_COUNT> driftMax{};

	void fold(Stats& s)
	{
		if (records) s.unitRecords.fetch_add(records, std::memory_order_relaxed);
		for (size_t i = 0; i < BAND_COUNT; ++i) {
			if (!updates[i]) continue;
			s.bandUpdates[i].fetch_add(updates[i], std::memory_order_relaxed);
			s.bandStaleMs[i].fetch_add(staleMs[i], std::memory_order_relaxed);
			s.bandDrift[i].fetch_add(drift[i], std::memory_order_relaxed);
			uint64_t seen = s.bandDriftMax[i].load(std::memory_order_relaxed);
			while (driftMax[i] > seen &&
			       !s.bandDriftMax[i].compare_exchange_weak(seen, driftMax[i], std::memory_order_relaxed)) {
			}
		}
		*this = FrameAccum{};
	}
};

} // namespace bot
