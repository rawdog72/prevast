// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once

#include <algorithm>
#include <cstdint>

// The world's day/night clock.
//
// ONE number is the whole of its state: `phase`, the position in milliseconds
// inside the current full cycle. Day is [0, half), night is [half, cycle).
// Everything else -- "is it night", how far into the night, where the client
// draws the sun on its dial -- is DERIVED from it, so there is no second copy
// of the time that can drift away from the first.
//
// That is the correction this type exists to make. The clock used to be a bare
// `worldTime` counter on Game plus two edge messages, DAY and NIGHT, which
// carried no time at all. A joining session was told which HALF it was in and
// nothing more, so its clock started at sunrise however late in the day it
// arrived -- and, because the login DAY/NIGHT was sent AFTER the handshake, it
// also zeroed the one field the handshake had just set correctly. Nothing
// re-stated the time until the next boundary, so a throttled or hidden tab
// stayed wrong for up to half a cycle.
//
// A state the wire can only describe at its boundaries cannot be joined between
// them. So the phase itself goes on the wire (ServerOpcode::WORLD_TIME) and is
// re-stated periodically -- which is what `advance` reports. The boundary
// message stops being load-bearing: it only makes the visual fade prompt.
class WorldClock {
public:
	// How often the clock is re-stated to every client unprompted.
	//
	// This is what makes the wire self-healing rather than edge-triggered: a
	// client that missed a boundary, was throttled in a background tab, or
	// simply accumulated float error in its own per-frame integration is
	// corrected within this interval instead of at the next sunrise. It costs
	// nine bytes per player per interval and rides the ordinary output batch.
	static constexpr uint32_t RESYNC_INTERVAL_MS = 30000;

	// Smallest cycle with a distinguishable day and night half.
	static constexpr uint32_t MIN_CYCLE_MS = 2;

	// Sets the cycle length (GameMode::dayNightCycle) and keeps the phase inside
	// it. Owes a statement: clients believing the old length would put the
	// boundary somewhere this clock does not.
	void configure(uint32_t cycleLengthMs)
	{
		cycle = std::max(MIN_CYCLE_MS, cycleLengthMs);
		phase %= cycle;
		owedStatement = true;
	}

	// Advances the clock. Afterwards, `needsBroadcast()` reports whether the
	// clients are owed a statement -- because the half changed, or because the
	// periodic re-statement came due. Both are the same message: it states the
	// clock whole rather than announcing an edge.
	void advance(uint32_t elapsedMs)
	{
		const bool wasNight = isNight();
		phase = static_cast<uint32_t>((static_cast<uint64_t>(phase) + elapsedMs) % cycle);

		// Saturating, not wrapping: a stall long enough to overflow this must
		// still come due rather than silently rearm the timer.
		sinceBroadcast = (elapsedMs > UINT32_MAX - sinceBroadcast)
			? UINT32_MAX
			: sinceBroadcast + elapsedMs;

		if (isNight() != wasNight || sinceBroadcast >= RESYNC_INTERVAL_MS) {
			owedStatement = true;
		}
	}

	// Latched, and cleared only by markBroadcast: every way of moving this clock
	// sets it, so a phase change that nobody sends is not merely discouraged, it
	// self-corrects on the next tick. That was the original bug's shape -- the
	// server moved the time and the clients found out at the next boundary.
	bool needsBroadcast() const { return owedStatement; }

	// "The clients have just been told." The one writer of the resync timer, so
	// it measures time since the clock was last STATED rather than time since
	// the last periodic tick -- an admin jump pushes the next resync out by a
	// full interval instead of leaving a short one behind it.
	void markBroadcast()
	{
		owedStatement = false;
		sinceBroadcast = 0;
	}

	uint32_t cycleMs() const { return cycle; }
	uint32_t halfMs() const { return cycle / 2; }
	uint32_t phaseMs() const { return phase; }
	bool isNight() const { return phase >= halfMs(); }

	// How far into the current half, exact for an odd cycle too (the spare
	// millisecond falls to the night, which is what [half, cycle) means).
	uint32_t phaseInHalfMs() const { return isNight() ? phase - halfMs() : phase; }

	// Jump to a given point in the cycle. Nothing here can reach the clients, so
	// it records that they are owed a statement instead; the next tick sends one
	// even if the caller does not.
	void setPhaseMs(uint32_t newPhaseMs)
	{
		phase = newPhaseMs % cycle;
		owedStatement = true;
	}

	// Jump to the start of a half -- sunrise or sunset. `!set-daynight`.
	void setHalf(bool night) { setPhaseMs(night ? halfMs() : 0); }

private:
	uint32_t cycle = 960000;
	uint32_t phase = 0;
	uint32_t sinceBroadcast = 0;
	// Set at construction: the very first tick states the clock, so a client
	// that connects before one has run is not the only one holding a phase.
	bool owedStatement = true;
};
