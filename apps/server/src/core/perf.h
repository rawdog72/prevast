// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PERF_H
#define FS_PERF_H

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include <atomic>

#include <fmt/format.h>

/**
 * Counters for the socket layer, which TickProfiler cannot see.
 *
 * Connection::send does not write -- it queues and posts the write to the io
 * executor -- so PHASE_FLUSH measures how long the dispatcher spends QUEUEING,
 * not how long anything takes to reach a player. Perceived smoothness lives
 * here instead, and until now it was entirely uninstrumented.
 *
 * The metric that matters most is `post_ms`: the delay between a write being
 * posted and the io thread actually running it. It is pure io-thread
 * scheduling delay, so it is the direct readout of whether one io thread is
 * enough for N connections.
 *
 * Unlike TickProfiler this IS touched from multiple threads (io + dispatcher),
 * hence the atomics. All of them are relaxed counters -- they are statistics,
 * not synchronisation.
 */
class NetProfiler
{
public:
	struct Snapshot {
		uint64_t writes = 0;
		uint64_t bytes = 0;
		double postAvgMs = 0.0;   // queued -> io thread picked it up
		double postMaxMs = 0.0;
		double writeAvgMs = 0.0;  // async_write issued -> completion
		double writeMaxMs = 0.0;
		double queueAvg = 0.0;    // per-connection backlog at enqueue
		uint64_t queueMax = 0;
	};

	void setEnabled(bool value) { enabled.store(value, std::memory_order_relaxed); }
	bool isEnabled() const { return enabled.load(std::memory_order_relaxed); }

	static uint64_t nowNanos()
	{
		return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
			std::chrono::steady_clock::now().time_since_epoch()).count());
	}

	void recordEnqueue(size_t queueDepth)
	{
		if (!isEnabled()) return;
		queueDepthSum.fetch_add(queueDepth, std::memory_order_relaxed);
		queueDepthCount.fetch_add(1, std::memory_order_relaxed);
		bumpMax(queueDepthMax, queueDepth);
	}

	void recordPostDelay(uint64_t postedAtNanos)
	{
		if (!isEnabled()) return;
		const uint64_t delta = nowNanos() - postedAtNanos;
		postNanos.fetch_add(delta, std::memory_order_relaxed);
		postCount.fetch_add(1, std::memory_order_relaxed);
		bumpMax(postMaxNanos, delta);
	}

	// One count per queued frame, bucketed by its first byte (the ServerOpcode).
	// Exists because "writes/s is 30k and the entity stream only explains 750"
	// is a question the old counters could not answer: they knew how many frames
	// went out, not what they were. Cheap enough to leave on -- one relaxed
	// increment per frame, on a path that is already doing a mutex and a post.
	void recordQueuedOpcode(uint8_t opcode)
	{
		if (!isEnabled()) return;
		opcodeCounts[opcode].fetch_add(1, std::memory_order_relaxed);
	}

	std::array<uint64_t, 256> consumeOpcodes()
	{
		std::array<uint64_t, 256> out{};
		for (size_t i = 0; i < out.size(); ++i) {
			out[i] = opcodeCounts[i].exchange(0, std::memory_order_relaxed);
		}
		return out;
	}

	void recordWrite(uint64_t startedAtNanos, uint64_t byteCount)
	{
		if (!isEnabled()) return;
		const uint64_t delta = nowNanos() - startedAtNanos;
		writeNanos.fetch_add(delta, std::memory_order_relaxed);
		writeCount.fetch_add(1, std::memory_order_relaxed);
		bytes.fetch_add(byteCount, std::memory_order_relaxed);
		bumpMax(writeMaxNanos, delta);
	}

	// Reads and resets. Called from the dispatcher at report time.
	Snapshot consume()
	{
		Snapshot s;
		const uint64_t posts = postCount.exchange(0, std::memory_order_relaxed);
		const uint64_t postSum = postNanos.exchange(0, std::memory_order_relaxed);
		const uint64_t writes = writeCount.exchange(0, std::memory_order_relaxed);
		const uint64_t writeSum = writeNanos.exchange(0, std::memory_order_relaxed);
		const uint64_t depths = queueDepthCount.exchange(0, std::memory_order_relaxed);
		const uint64_t depthSum = queueDepthSum.exchange(0, std::memory_order_relaxed);

		s.writes = writes;
		s.bytes = bytes.exchange(0, std::memory_order_relaxed);
		s.postAvgMs = posts ? (static_cast<double>(postSum) / posts) / 1e6 : 0.0;
		s.postMaxMs = postMaxNanos.exchange(0, std::memory_order_relaxed) / 1e6;
		s.writeAvgMs = writes ? (static_cast<double>(writeSum) / writes) / 1e6 : 0.0;
		s.writeMaxMs = writeMaxNanos.exchange(0, std::memory_order_relaxed) / 1e6;
		s.queueAvg = depths ? static_cast<double>(depthSum) / depths : 0.0;
		s.queueMax = queueDepthMax.exchange(0, std::memory_order_relaxed);
		return s;
	}

private:
	static void bumpMax(std::atomic<uint64_t>& target, uint64_t value)
	{
		uint64_t prev = target.load(std::memory_order_relaxed);
		while (prev < value && !target.compare_exchange_weak(prev, value, std::memory_order_relaxed)) {
			// prev is reloaded by compare_exchange_weak
		}
	}

	std::atomic<bool> enabled{false};
	std::atomic<uint64_t> postNanos{0};
	std::atomic<uint64_t> postCount{0};
	std::atomic<uint64_t> postMaxNanos{0};
	std::array<std::atomic<uint64_t>, 256> opcodeCounts{};
	std::atomic<uint64_t> writeNanos{0};
	std::atomic<uint64_t> writeCount{0};
	std::atomic<uint64_t> writeMaxNanos{0};
	std::atomic<uint64_t> bytes{0};
	std::atomic<uint64_t> queueDepthSum{0};
	std::atomic<uint64_t> queueDepthCount{0};
	std::atomic<uint64_t> queueDepthMax{0};
};

inline NetProfiler g_netperf;

namespace tfs::perf {

	// Defined in tasks.cpp so <windows.h> stays out of every translation unit
	// that wants the profiler. Returns user+kernel CPU consumed by the CALLING
	// thread, or 0 if the platform cannot report it.
	uint64_t currentThreadCpuNanos();

} // namespace tfs::perf

/**
 * Accounting for the dispatcher thread itself.
 *
 * TickProfiler measures the movement tick and nothing else, and that turned out
 * to be less than half the story: at 255 clients the achieved tick PERIOD was
 * 55.2 ms against a 24.7 ms profiled tick, so 30.5 ms per period -- more than
 * the whole tick -- was unaccounted for. Every optimisation to date has aimed
 * at the smaller half.
 *
 * The number this exists to produce is `starve`: wall time spent inside task
 * execution minus CPU time the thread actually got. It separates "the server
 * has more work than fits" from "the box will not schedule the server", which
 * lead to opposite plans. This rig is 2 physical cores running the dispatcher,
 * 3 io threads and the Python harness, so the distinction is not academic.
 *
 * Single-threaded by construction, like TickProfiler: both the accumulate
 * (Dispatcher::threadMain) and the consume (TickProfiler::report, reached from
 * Game::updateMovement) run on the dispatcher thread.
 */
class DispatcherProfiler
{
public:
	struct Snapshot {
		double busyMs = 0.0;    // wall time executing tasks, per tick period
		double otherMs = 0.0;   // busy minus the movement tick: packets + other loops
		double idleMs = 0.0;    // period minus busy: waiting for work
		double cpuMs = 0.0;     // CPU the dispatcher thread actually got, per period
		double starveMs = 0.0;  // busy minus cpu: inside a task but off-core
		double tasks = 0.0;     // tasks executed per tick period
	};

	void noteTask(uint64_t nanos)
	{
		taskNanos += nanos;
		++taskCount;
	}

	// `windowNanos` is wall time since the last consume, `tickNanos` the summed
	// duration of the movement ticks in it. Both come from TickProfiler so the
	// two lines describe the same window.
	Snapshot consume(size_t ticks, uint64_t windowNanos, uint64_t tickNanos)
	{
		const uint64_t cpuNow = tfs::perf::currentThreadCpuNanos();
		uint64_t cpuDelta = 0;
		if (cpuBaseline != 0) {
			cpuDelta = cpuNow - cpuBaseline;
		}
		cpuBaseline = cpuNow;

		Snapshot s;
		if (ticks > 0) {
			const double perTick = 1e6 * static_cast<double>(ticks);
			s.busyMs = taskNanos / perTick;
			s.otherMs = (taskNanos > tickNanos ? taskNanos - tickNanos : 0) / perTick;
			s.idleMs = (windowNanos > taskNanos ? windowNanos - taskNanos : 0) / perTick;
			s.cpuMs = cpuDelta / perTick;
			s.starveMs = (taskNanos > cpuDelta ? taskNanos - cpuDelta : 0) / perTick;
			s.tasks = static_cast<double>(taskCount) / static_cast<double>(ticks);
		}

		taskNanos = 0;
		taskCount = 0;
		return s;
	}

private:
	uint64_t taskNanos = 0;
	uint64_t taskCount = 0;
	// 0 means "no baseline yet"; the first window would otherwise report the
	// thread's whole lifetime as if it belonged to that window.
	uint64_t cpuBaseline = 0;
};

inline DispatcherProfiler g_dispatchperf;

/**
 * Lightweight profiler for the 20 Hz game loop (Game::updateMovement).
 *
 * Why the tick RATE is the headline number, not latency: movement applies a
 * FIXED distance per tick (speed / MOVEMENT_TICKS_PER_SEC, definitions.h), so
 * a tick that overruns its 50 ms budget does not merely add lag -- every
 * player literally walks slower. "Players move slower when bots are online"
 * is therefore a direct readout of ticks/sec, which is why this reports
 * achieved rate and budget overruns alongside the per-phase breakdown that
 * says WHERE the time went.
 *
 * Cost is one steady_clock read per phase boundary (~20-30 ns each, 7 per
 * tick), i.e. far below a microsecond against a 50 ms budget -- safe to leave
 * enabled during stress tests. Disabled entirely via `perfStats` in config.lua.
 *
 * Not thread-safe by design: every call site lives on the dispatcher thread.
 */
class TickProfiler
{
public:
	// What one tick did, handed to endTick(). `clients` is the field that
	// matters for benchmark validity: a dropped connection leaves the character
	// in the world, so `players` counts AFK bodies the visibility loop skips
	// entirely. A run that looks like 255 players can be doing the work of 46 --
	// that trap invalidated a whole capture once and is documented in
	// AI_REFACTORING_NOTES.md. Cross-check `clients` against the harness's
	// live bot count; if they disagree, the run is not comparable.
	struct TickSample {
		size_t players = 0;
		size_t clients = 0;      // players with a live client (the ones that cost anything)
		size_t things = 0;
		size_t projectiles = 0;
		uint64_t visited = 0;    // entities examined by the per-player visibility sweep
		uint64_t records = 0;    // EntityUpdate records handed to the socket layer
	};

	enum Phase : size_t {
		PHASE_PROJECTILES,  // updateProjectiles only
		PHASE_LOOTSWEEP,    // removeExpiredTakenLoot
		PHASE_MOVEMENT,     // per-player: gauges, actions, collision, tile move
		PHASE_DIRTY_SCAN,   // building the moved-things list
		PHASE_SPECTATORS,   // per-player visibility diff + update push
		PHASE_FLUSH,        // ping + socket flush
		PHASE_COUNT
	};

	// `loot` was split out of `proj` on 2026-08-05. They had shared a phase, and
	// the 250-bot itemchurn run read proj=6.22ms on a server with zero
	// projectiles in flight -- all of it the loot sweep.
	static constexpr std::array<const char*, PHASE_COUNT> PHASE_NAMES = {
		"proj", "loot", "move", "dirty", "spec", "flush"
	};

	void setEnabled(bool value) { enabled = value; }
	bool isEnabled() const { return enabled; }

	// Per-tick projectile work, so the cost of the phase can be attributed
	// between "how many bullets" and "how much world each bullet had to search".
	// A bullet's scan box is sized by the distance it travelled this tick, so
	// when the tick gets slower the box gets bigger -- cand/step is the number
	// that shows whether that feedback loop is what is running.
	void addProjectileWork(uint64_t steps, uint64_t candidates, uint64_t tiles)
	{
		if (!enabled) return;
		projSteps += steps;
		projCandidates += candidates;
		projTiles += tiles;
	}

	// Where the projectile phase actually goes. Added because three successive
	// hypotheses about it (scan-box size, spectator gather, broadcast fan-out)
	// were each measured and each came back flat -- guessing was not converging.
	void addProjectileTiming(uint64_t moveNs, uint64_t gatherNs, uint64_t testNs, uint64_t hitNs)
	{
		if (!enabled) return;
		projMoveNanos += moveNs;
		projGatherNanos += gatherNs;
		projTestNanos += testNs;
		projHitNanos += hitNs;
	}

	// Where the SPECTATOR phase goes. Same reasoning as addProjectileTiming:
	// `spec` is now the largest phase in two of three scenarios (17.8ms of
	// itemchurn's 26.5ms tick) and it is four different jobs sharing one
	// number -- the flat mobile scan, the sorted merge, the batched static
	// erase, and the incremental static-viewport rebuild. Which one it is
	// changes what the fix looks like entirely, so count it.
	void addSpectatorTiming(uint64_t scanNs, uint64_t diffNs, uint64_t eraseNs, uint64_t staticNs)
	{
		if (!enabled) return;
		specScanNanos += scanNs;
		specDiffNanos += diffNs;
		specEraseNanos += eraseNs;
		specStaticNanos += staticNs;
	}

	// How many players actually paid for the incremental static rebuild this
	// tick. It is skipped entirely unless the viewport tile box shifted, so
	// "spec is expensive" means something very different at 5 shifts per tick
	// than at 250.
	void addStaticShifts(uint64_t shifts)
	{
		if (!enabled) return;
		specStaticShifts += shifts;
	}

	// Writes one CSV row per report window to `path`, for before/after
	// comparison. Empty path (the default) disables the file output.
	void setCsvPath(const std::string& path) { csvPath = path; csvHeaderWritten = false; }

	void beginTick()
	{
		if (!enabled) return;
		const auto now = Clock::now();
		tickStart = now;
		phaseMark = now;
		if (windowStart == TimePoint{}) {
			windowStart = now;
		}
	}

	// Closes the phase that began at the last mark and opens the next one.
	void markPhase(Phase phase)
	{
		if (!enabled) return;
		const auto now = Clock::now();
		phaseNanos[phase] += static_cast<uint64_t>(
			std::chrono::duration_cast<std::chrono::nanoseconds>(now - phaseMark).count());
		phaseMark = now;
	}

	void endTick(const TickSample& sample)
	{
		if (!enabled) return;
		const auto now = Clock::now();
		const uint64_t micros = static_cast<uint64_t>(
			std::chrono::duration_cast<std::chrono::microseconds>(now - tickStart).count());

		tickMicros.push_back(micros);
		if (micros > TICK_BUDGET_US) {
			++overruns;
		}
		lastPlayers = sample.players;
		lastClients = sample.clients;
		lastThings = sample.things;
		lastProjectiles = sample.projectiles;
		visitedSum += sample.visited;
		recordsSum += sample.records;

		if (std::chrono::duration_cast<std::chrono::milliseconds>(now - windowStart).count()
		    >= REPORT_INTERVAL_MS) {
			report(now);
		}
	}

private:
	using Clock = std::chrono::steady_clock;
	using TimePoint = Clock::time_point;

	static constexpr uint64_t TICK_BUDGET_US = 50000;  // the 50 ms scheduler period
	static constexpr int64_t REPORT_INTERVAL_MS = 5000;

	static uint64_t percentile(std::vector<uint64_t>& sorted, double p)
	{
		if (sorted.empty()) return 0;
		const size_t idx = std::min(sorted.size() - 1,
			static_cast<size_t>(p * static_cast<double>(sorted.size())));
		return sorted[idx];
	}

	void report(TimePoint now)
	{
		const double windowSec = std::chrono::duration<double>(now - windowStart).count();
		const size_t ticks = tickMicros.size();

		std::sort(tickMicros.begin(), tickMicros.end());
		uint64_t totalMicros = 0;
		for (uint64_t v : tickMicros) {
			totalMicros += v;
		}
		const double avgMs = ticks ? (totalMicros / 1000.0) / ticks : 0.0;
		const double p50 = percentile(tickMicros, 0.50) / 1000.0;
		const double p95 = percentile(tickMicros, 0.95) / 1000.0;
		const double maxMs = ticks ? tickMicros.back() / 1000.0 : 0.0;
		const double rate = windowSec > 0.0 ? ticks / windowSec : 0.0;

		std::string phases;
		for (size_t i = 0; i < PHASE_COUNT; ++i) {
			const double ms = ticks ? (phaseNanos[i] / 1e6) / ticks : 0.0;
			phases += fmt::format(" {}={:.2f}", PHASE_NAMES[i], ms);
		}

		const NetProfiler::Snapshot net = g_netperf.consume();
		const uint64_t windowNanos = static_cast<uint64_t>(
			std::chrono::duration_cast<std::chrono::nanoseconds>(now - windowStart).count());
		const DispatcherProfiler::Snapshot disp =
			g_dispatchperf.consume(ticks, windowNanos, totalMicros * 1000);
		const double visitedPerTick = ticks ? static_cast<double>(visitedSum) / ticks : 0.0;
		const double recordsPerTick = ticks ? static_cast<double>(recordsSum) / ticks : 0.0;
		const double stepsPerTick = ticks ? static_cast<double>(projSteps) / ticks : 0.0;
		const double candPerStep = projSteps ? static_cast<double>(projCandidates) / projSteps : 0.0;
		const double tilesPerStep = projSteps ? static_cast<double>(projTiles) / projSteps : 0.0;

		fmt::print("[PERF] {:.1f}s | ticks={} ({:.1f}/s of 20.0) | players={} clients={} things={} proj={} | "
		           "tick ms avg={:.2f} p50={:.2f} p95={:.2f} max={:.2f} | over50ms={} |{} | "
		           "seen/tick={:.0f} rec/tick={:.0f}\n",
		           windowSec, ticks, rate, lastPlayers, lastClients, lastThings, lastProjectiles,
		           avgMs, p50, p95, maxMs, overruns, phases,
		           visitedPerTick, recordsPerTick);
		if (projSteps > 0) {
			const auto perTickMs = [ticks](uint64_t nanos) {
				return ticks ? (nanos / 1e6) / ticks : 0.0;
			};
			fmt::print("[PROJ] {:.1f}s | steps/tick={:.0f} | tiles/step={:.1f} cand/step={:.1f} | "
			           "candidates/tick={:.0f} | ms: move={:.2f} gather={:.2f} test={:.2f} hit={:.2f}\n",
			           windowSec, stepsPerTick, tilesPerStep, candPerStep,
			           stepsPerTick * candPerStep,
			           perTickMs(projMoveNanos), perTickMs(projGatherNanos),
			           perTickMs(projTestNanos), perTickMs(projHitNanos));
		}
		if (specScanNanos + specDiffNanos + specEraseNanos + specStaticNanos > 0) {
			const auto perTickMs = [ticks](uint64_t nanos) {
				return ticks ? (nanos / 1e6) / ticks : 0.0;
			};
			fmt::print("[SPEC] {:.1f}s | ms: scan={:.2f} diff={:.2f} erase={:.2f} static={:.2f} | "
			           "static rebuilds/tick={:.1f}\n",
			           windowSec,
			           perTickMs(specScanNanos), perTickMs(specDiffNanos),
			           perTickMs(specEraseNanos), perTickMs(specStaticNanos),
			           ticks ? static_cast<double>(specStaticShifts) / ticks : 0.0);
		}
		fmt::print("[NET]  {:.1f}s | writes={} ({:.0f}/s) {:.2f} MB/s | post ms avg={:.3f} max={:.2f} | "
		           "write ms avg={:.3f} max={:.2f} | queue avg={:.2f} max={}\n",
		           windowSec, net.writes,
		           windowSec > 0.0 ? net.writes / windowSec : 0.0,
		           windowSec > 0.0 ? (net.bytes / 1048576.0) / windowSec : 0.0,
		           net.postAvgMs, net.postMaxMs, net.writeAvgMs, net.writeMaxMs,
		           net.queueAvg, net.queueMax);

		// Which opcodes those frames actually were. Frames, not bytes: the cost
		// being tracked is per-frame (a mutex, a post, a write), so a flood of
		// 3-byte packets is far more expensive than its bandwidth suggests.
		{
			const std::array<uint64_t, 256> ops = g_netperf.consumeOpcodes();
			std::array<uint8_t, 256> order{};
			for (size_t i = 0; i < 256; ++i) order[i] = static_cast<uint8_t>(i);
			std::sort(order.begin(), order.end(),
			          [&ops](uint8_t a, uint8_t b) { return ops[a] > ops[b]; });
			std::string top;
			for (size_t i = 0; i < 6 && ops[order[i]] > 0; ++i) {
				top += fmt::format(" op{}={:.0f}/s", order[i],
				                   windowSec > 0.0 ? ops[order[i]] / windowSec : 0.0);
			}
			if (!top.empty()) {
				fmt::print("[OPS] {:.1f}s |{}\n", windowSec, top);
			}
		}
		// Everything here is per tick PERIOD, so it lines up column-for-column
		// with the [PERF] tick numbers above. busy+idle should reconstruct the
		// period; starve is the read on whether this box is scheduling us.
		fmt::print("[DISP] {:.1f}s | period={:.2f} | busy={:.2f} (tick={:.2f} other={:.2f}) idle={:.2f} | "
		           "cpu={:.2f} starve={:.2f} | tasks/tick={:.1f}\n",
		           windowSec, rate > 0.0 ? 1000.0 / rate : 0.0,
		           disp.busyMs, avgMs, disp.otherMs, disp.idleMs,
		           disp.cpuMs, disp.starveMs, disp.tasks);
		std::fflush(stdout);

		writeCsvRow(windowSec, ticks, rate, avgMs, p50, p95, maxMs, net,
		            visitedPerTick, recordsPerTick, disp,
		            stepsPerTick, tilesPerStep, candPerStep);

		tickMicros.clear();
		phaseNanos.fill(0);
		overruns = 0;
		visitedSum = 0;
		recordsSum = 0;
		specScanNanos = 0;
		specDiffNanos = 0;
		specEraseNanos = 0;
		specStaticNanos = 0;
		specStaticShifts = 0;
		projSteps = 0;
		projCandidates = 0;
		projTiles = 0;
		projMoveNanos = 0;
		projGatherNanos = 0;
		projTestNanos = 0;
		projHitNanos = 0;
		windowStart = now;
	}

	void writeCsvRow(double windowSec, size_t ticks, double rate,
	                 double avgMs, double p50, double p95, double maxMs,
	                 const NetProfiler::Snapshot& net,
	                 double visitedPerTick, double recordsPerTick,
	                 const DispatcherProfiler::Snapshot& disp,
	                 double stepsPerTick, double tilesPerStep, double candPerStep)
	{
		if (csvPath.empty()) return;

		std::FILE* f = std::fopen(csvPath.c_str(), csvHeaderWritten ? "a" : "w");
		if (!f) return;

		if (!csvHeaderWritten) {
			std::string header = "window_s,ticks,ticks_per_s,players,things,"
			                     "avg_ms,p50_ms,p95_ms,max_ms,overruns";
			for (const char* name : PHASE_NAMES) {
				header += fmt::format(",{}_ms", name);
			}
			header += ",writes,write_mb_s,post_avg_ms,post_max_ms,"
			          "write_avg_ms,write_max_ms,queue_avg,queue_max";
			// Appended, not inserted: existing captures are read positionally by
			// anything other than compare.py, and old files must stay loadable.
			header += ",clients,projectiles,seen_per_tick,rec_per_tick";
			header += ",disp_busy_ms,disp_other_ms,disp_idle_ms,disp_cpu_ms,disp_starve_ms,disp_tasks";
			header += ",proj_steps_per_tick,proj_tiles_per_step,proj_cand_per_step";
			fmt::print(f, "{}\n", header);
			csvHeaderWritten = true;
		}

		std::string row = fmt::format("{:.2f},{},{:.2f},{},{},{:.3f},{:.3f},{:.3f},{:.3f},{}",
		                              windowSec, ticks, rate, lastPlayers, lastThings,
		                              avgMs, p50, p95, maxMs, overruns);
		for (size_t i = 0; i < PHASE_COUNT; ++i) {
			row += fmt::format(",{:.3f}", ticks ? (phaseNanos[i] / 1e6) / ticks : 0.0);
		}
		row += fmt::format(",{},{:.3f},{:.4f},{:.3f},{:.4f},{:.3f},{:.2f},{}",
		                   net.writes,
		                   windowSec > 0.0 ? (net.bytes / 1048576.0) / windowSec : 0.0,
		                   net.postAvgMs, net.postMaxMs,
		                   net.writeAvgMs, net.writeMaxMs,
		                   net.queueAvg, net.queueMax);
		row += fmt::format(",{},{},{:.1f},{:.1f}",
		                   lastClients, lastProjectiles, visitedPerTick, recordsPerTick);
		row += fmt::format(",{:.3f},{:.3f},{:.3f},{:.3f},{:.3f},{:.2f}",
		                   disp.busyMs, disp.otherMs, disp.idleMs,
		                   disp.cpuMs, disp.starveMs, disp.tasks);
		row += fmt::format(",{:.1f},{:.2f},{:.2f}", stepsPerTick, tilesPerStep, candPerStep);
		fmt::print(f, "{}\n", row);
		std::fclose(f);
	}

	bool enabled = false;

	TimePoint tickStart{};
	TimePoint phaseMark{};
	TimePoint windowStart{};

	std::array<uint64_t, PHASE_COUNT> phaseNanos{};
	std::vector<uint64_t> tickMicros;
	size_t overruns = 0;
	size_t lastPlayers = 0;
	size_t lastClients = 0;
	size_t lastThings = 0;
	size_t lastProjectiles = 0;
	uint64_t visitedSum = 0;
	uint64_t recordsSum = 0;
	uint64_t projSteps = 0;
	uint64_t projCandidates = 0;
	uint64_t projTiles = 0;
	uint64_t projMoveNanos = 0;
	uint64_t projGatherNanos = 0;
	uint64_t projTestNanos = 0;
	uint64_t projHitNanos = 0;
	uint64_t specScanNanos = 0;
	uint64_t specDiffNanos = 0;
	uint64_t specEraseNanos = 0;
	uint64_t specStaticNanos = 0;
	uint64_t specStaticShifts = 0;

	std::string csvPath;
	bool csvHeaderWritten = false;
};

// Inline variable (C++17+): keeps the profiler header-only, so no new
// translation unit has to be threaded into the .vcxproj.
inline TickProfiler g_perf;

#endif // FS_PERF_H
