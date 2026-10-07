// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// prevast_bot -- C++ load generator for the Prevast server.
//
// Usage:
//   prevast_bot --bots 250 --behavior crowd --duration 300 --password prevast
//
// Why this exists: the Python harness is single-threaded asyncio and saturated
// one core at ~173 of 250 bots on this two-core box, using ~1.7x the server's
// CPU. A saturated generator makes the server look faster than it is and the
// bot-side metrics look worse than they are, so nothing measured at 250 clients
// through it described the server. This one costs a small fraction of that and
// prints its own CPU so a run can be checked rather than assumed.

#include "behavior.h"
#include "bot.h"
#include "stats.h"

#include <boost/asio.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#endif

namespace {

using namespace bot;

struct Options {
	Config cfg;
	std::string behavior = "crowd";
	int bots = 250;
	int threads = 2;
	int durationSec = 0;         // 0 = until Ctrl+C
	double reportSec = 5.0;
	double connectIntervalMs = 0.0;
	std::string csvPath;
	BehaviorOptions behaviorOpts;
};

[[noreturn]] void usage(const char* argv0, int code)
{
	std::cout <<
		"prevast_bot -- C++ load generator for the Prevast server\n\n"
		"Usage: " << argv0 << " [options]\n\n"
		"  --bots N              bots to run (default 250)\n"
		"  --behavior NAME       " << behaviorNames() << " (default crowd)\n"
		"  --host HOST           default 127.0.0.1\n"
		"  --port PORT           default 7172\n"
		"  --password PASS       adminPassword; combat and itemchurn need it\n"
		"  --threads N           io threads (default 2)\n"
		"  --tick-hz N           bot decision rate (default 10)\n"
		"  --duration SEC        stop after SEC (0 = until Ctrl+C)\n"
		"  --report-interval SEC stats line cadence (default 5)\n"
		"  --connect-interval MS spacing between connects (default 0)\n"
		"  --crowd-radius UNITS  how far a crowd bot may leave its spawn (default 600)\n"
		"  --fire-ratio F        fraction of combat bots that shoot (default 1.0)\n"
		"  --no-track-others     do not keep a world-view (drops the relevance metrics)\n"
		"  --csv PATH            append one row per report interval\n";
	std::exit(code);
}

int argInt(int argc, char** argv, int& i, const char* name)
{
	if (++i >= argc) { std::cerr << name << " needs a value\n"; std::exit(2); }
	return std::atoi(argv[i]);
}

double argDouble(int argc, char** argv, int& i, const char* name)
{
	if (++i >= argc) { std::cerr << name << " needs a value\n"; std::exit(2); }
	return std::atof(argv[i]);
}

std::string argStr(int argc, char** argv, int& i, const char* name)
{
	if (++i >= argc) { std::cerr << name << " needs a value\n"; std::exit(2); }
	return argv[i];
}

Options parseArgs(int argc, char** argv)
{
	Options o;
	for (int i = 1; i < argc; ++i) {
		const std::string a = argv[i];
		if (a == "--bots")                  o.bots = argInt(argc, argv, i, "--bots");
		else if (a == "--behavior")         o.behavior = argStr(argc, argv, i, "--behavior");
		else if (a == "--host")             o.cfg.host = argStr(argc, argv, i, "--host");
		else if (a == "--port")             o.cfg.port = argStr(argc, argv, i, "--port");
		else if (a == "--password")         o.cfg.password = argStr(argc, argv, i, "--password");
		else if (a == "--threads")          o.threads = argInt(argc, argv, i, "--threads");
		else if (a == "--tick-hz")          o.cfg.tickHz = argInt(argc, argv, i, "--tick-hz");
		else if (a == "--duration")         o.durationSec = argInt(argc, argv, i, "--duration");
		else if (a == "--report-interval")  o.reportSec = argDouble(argc, argv, i, "--report-interval");
		else if (a == "--connect-interval") o.connectIntervalMs = argDouble(argc, argv, i, "--connect-interval");
		else if (a == "--crowd-radius")     o.behaviorOpts.crowdRadius = argDouble(argc, argv, i, "--crowd-radius");
		else if (a == "--fire-ratio")       o.behaviorOpts.fireRatio = argDouble(argc, argv, i, "--fire-ratio");
		else if (a == "--no-track-others")  o.cfg.trackOthers = false;
		else if (a == "--csv")              o.csvPath = argStr(argc, argv, i, "--csv");
		else if (a == "--help" || a == "-h") usage(argv[0], 0);
		else { std::cerr << "unknown option: " << a << "\n"; usage(argv[0], 2); }
	}

	if (!behaviorExists(o.behavior)) {
		std::cerr << "unknown behavior '" << o.behavior << "'. choices: " << behaviorNames() << "\n";
		std::exit(2);
	}
	o.threads = std::max(1, o.threads);
	o.bots = std::max(1, o.bots);
	o.behaviorOpts.tickHz = o.cfg.tickHz;
	return o;
}

// Seconds of CPU this process has burned. The methodology rule is to sample
// generator CPU before concluding anything about a ceiling: if the harness is
// saturated, the run says nothing about the server.
double processCpuSeconds()
{
#ifdef _WIN32
	FILETIME creation, exit, kernel, user;
	if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return 0.0;
	auto toSeconds = [](const FILETIME& ft) {
		ULARGE_INTEGER v;
		v.LowPart = ft.dwLowDateTime;
		v.HighPart = ft.dwHighDateTime;
		return static_cast<double>(v.QuadPart) / 1e7;   // 100ns units
	};
	return toSeconds(kernel) + toSeconds(user);
#else
	return 0.0;
#endif
}

std::atomic<bool> g_stop{false};

#ifdef _WIN32
BOOL WINAPI consoleHandler(DWORD type)
{
	if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
		g_stop.store(true);
		return TRUE;
	}
	return FALSE;
}
#endif

// One tick group per io thread: the bots in a slice share a strand, so their
// handlers never run concurrently and a bot needs no locking at all.
class TickGroup {
public:
	TickGroup(net::io_context& io, int tickHz)
		: m_strand(net::make_strand(io))
		, m_timer(m_strand)
		, m_periodMs(std::max(1, 1000 / std::max(1, tickHz)))
	{}

	net::strand<net::io_context::executor_type>& strand() { return m_strand; }
	void add(BotPtr b) { m_bots.push_back(std::move(b)); }
	const std::vector<BotPtr>& bots() const { return m_bots; }

	void start()
	{
		m_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(m_periodMs);
		arm();
	}

	void stop()
	{
		net::post(m_strand, [this]() { m_stopping = true; m_timer.cancel(); });
	}

private:
	void arm()
	{
		m_timer.expires_at(m_deadline);
		m_timer.async_wait([this](const boost::system::error_code& ec) {
			if (ec || m_stopping) return;
			for (const BotPtr& b : m_bots) b->tick();

			// Absolute grid, not "now + period": rescheduling relative to a
			// tick's own start silently eats the wake latency and accumulates
			// as a permanent rate loss. If we fall behind, skip forward rather
			// than run catch-up ticks.
			const auto now = std::chrono::steady_clock::now();
			do {
				m_deadline += std::chrono::milliseconds(m_periodMs);
			} while (m_deadline <= now);
			arm();
		});
	}

	net::strand<net::io_context::executor_type> m_strand;
	net::steady_timer m_timer;
	int m_periodMs;
	std::chrono::steady_clock::time_point m_deadline;
	std::vector<BotPtr> m_bots;
	bool m_stopping = false;
};

} // namespace

int main(int argc, char** argv)
{
	const Options opt = parseArgs(argc, argv);

#ifdef _WIN32
	SetConsoleCtrlHandler(consoleHandler, TRUE);
#endif

	Stats stats;
	net::io_context io;

	std::vector<std::unique_ptr<TickGroup>> groups;
	groups.reserve(opt.threads);
	for (int i = 0; i < opt.threads; ++i) {
		groups.push_back(std::make_unique<TickGroup>(io, opt.cfg.tickHz));
	}

	std::vector<BotPtr> allBots;
	allBots.reserve(opt.bots);
	for (int i = 0; i < opt.bots; ++i) {
		TickGroup& g = *groups[i % groups.size()];
		auto b = std::make_shared<Bot>(io, g.strand(), opt.cfg,
		                               makeBehavior(opt.behavior, opt.behaviorOpts, i),
		                               stats, i);
		g.add(b);
		allBots.push_back(std::move(b));
	}

	// Keep the io_context alive while bots are ramping in and between reports.
	auto work = net::make_work_guard(io);

	std::vector<std::thread> workers;
	workers.reserve(opt.threads);
	for (int i = 0; i < opt.threads; ++i) {
		workers.emplace_back([&io]() { io.run(); });
	}

	std::cout << "prevast_bot: " << opt.bots << " bots, behavior=" << opt.behavior
	          << ", threads=" << opt.threads << ", tick=" << opt.cfg.tickHz << "Hz, target="
	          << opt.cfg.host << ":" << opt.cfg.port << "\n";

	// Ramp. The server's per-IP connect throttle is off while config.lua has
	// connectThrottle = false, which is why the default spacing is zero. Raise
	// --connect-interval above 0.5s if you run against a throttled server:
	// concurrent retries against it livelock, since a blocked IP has its block
	// extended by every further attempt.
	for (BotPtr& b : allBots) {
		b->start();
		if (opt.connectIntervalMs > 0.0) {
			std::this_thread::sleep_for(std::chrono::microseconds(
				static_cast<int64_t>(opt.connectIntervalMs * 1000.0)));
		}
	}
	for (auto& g : groups) g->start();

	std::ofstream csv;
	if (!opt.csvPath.empty()) {
		const bool fresh = !std::ifstream(opt.csvPath).good();
		csv.open(opt.csvPath, std::ios::app);
		if (fresh && csv) {
			csv << "elapsed_s,live,peak,connects,disconnects,errors,deaths,"
			       "frames_rx_s,bytes_rx_s,records_s,records_per_client_s,frames_tx_s,"
			       "bot_ticks_s,observed_speed,harness_cpu_pct,"
			       "throws,takes,shots,seen_players,seen_loot,seen_proj";
			for (size_t i = 0; i < BAND_COUNT; ++i) {
				csv << ",interval_ms_" << BAND_NAMES[i]
				    << ",drift_mean_" << BAND_NAMES[i]
				    << ",drift_max_" << BAND_NAMES[i];
			}
			csv << "\n";
		}
	}

	const auto runStart = std::chrono::steady_clock::now();
	auto prevWall = runStart;
	double prevCpu = processCpuSeconds();
	uint64_t prevFramesRx = 0, prevBytesRx = 0, prevRecords = 0, prevFramesTx = 0, prevTicks = 0;
	uint64_t prevMoveDist = 0, prevMoveMs = 0;
	std::array<uint64_t, BAND_COUNT> prevUpdates{}, prevStale{}, prevDrift{};

	while (!g_stop.load()) {
		std::this_thread::sleep_for(std::chrono::milliseconds(
			static_cast<int64_t>(opt.reportSec * 1000.0)));

		const auto now = std::chrono::steady_clock::now();
		const double elapsed = std::chrono::duration<double>(now - runStart).count();
		const double window = std::chrono::duration<double>(now - prevWall).count();
		prevWall = now;
		if (window <= 0.0) continue;

		const uint64_t framesRx = stats.framesRx.load();
		const uint64_t bytesRx = stats.bytesRx.load();
		const uint64_t records = stats.unitRecords.load();
		const uint64_t framesTx = stats.framesTx.load();
		const uint64_t ticks = stats.botTicks.load();
		const uint64_t moveDist = stats.moveDistance.load();
		const uint64_t moveMs = stats.moveMillis.load();

		const double cpu = processCpuSeconds();
		const double cpuPct = (cpu - prevCpu) / window * 100.0;
		prevCpu = cpu;

		const int64_t live = stats.live.load();
		const double frameRate = (framesRx - prevFramesRx) / window;
		const double byteRate = (bytesRx - prevBytesRx) / window;
		const double recRate = (records - prevRecords) / window;
		const double txRate = (framesTx - prevFramesTx) / window;
		const double tickRate = (ticks - prevTicks) / window;
		const double perClient = live > 0 ? recRate / static_cast<double>(live) : 0.0;

		const uint64_t dDist = moveDist - prevMoveDist;
		const uint64_t dMs = moveMs - prevMoveMs;
		const double speed = dMs > 0 ? (static_cast<double>(dDist) / dMs) * 1000.0 : 0.0;

		prevFramesRx = framesRx; prevBytesRx = bytesRx; prevRecords = records;
		prevFramesTx = framesTx; prevTicks = ticks;
		prevMoveDist = moveDist; prevMoveMs = moveMs;

		std::printf("[%6.0fs] live=%-4lld peak=%-4lld disc=%-4llu err=%-4llu deaths=%-5llu "
		            "rx=%7.0f/s %6.2fMB/s rec=%9.0f/s (%5.0f/client) tx=%6.0f/s "
		            "bt=%6.0f/s spd=%5.1f cpu=%5.1f%%\n",
		            elapsed, static_cast<long long>(live),
		            static_cast<long long>(stats.peak.load()),
		            static_cast<unsigned long long>(stats.disconnects.load()),
		            static_cast<unsigned long long>(stats.errors.load()),
		            static_cast<unsigned long long>(stats.deaths.load()),
		            frameRate, byteRate / (1024.0 * 1024.0), recRate, perClient,
		            txRate, tickRate, speed, cpuPct);

		// Per-band relevance. interval is how often a client hears about an
		// entity at that distance; drift is how far that entity had actually
		// moved by the time it was told, i.e. the positional error a player
		// sees. These are the gate for interest-management work, replacing
		// "rec_per_tick must stay flat" -- which that work deliberately breaks.
		// The seen* counters are published by bot 0 from its own strand (see
		// Bot::handleUnits): reading its map from here would race the io thread
		// that is mutating it.
		const uint64_t throws = stats.throws.load();
		const uint64_t takes = stats.takes.load();
		const uint64_t shots = stats.shots.load();
		if (throws || takes || shots) {
			std::printf("          actions: throws=%llu takes=%llu shots=%llu | "
			            "bot0 sees: players=%llu loot=%llu proj=%llu\n",
			            static_cast<unsigned long long>(throws),
			            static_cast<unsigned long long>(takes),
			            static_cast<unsigned long long>(shots),
			            static_cast<unsigned long long>(stats.seenPlayers.load()),
			            static_cast<unsigned long long>(stats.seenLoot.load()),
			            static_cast<unsigned long long>(stats.seenProjectiles.load()));
		} else {
			std::printf("          bot0 sees: players=%llu loot=%llu proj=%llu\n",
			            static_cast<unsigned long long>(stats.seenPlayers.load()),
			            static_cast<unsigned long long>(stats.seenLoot.load()),
			            static_cast<unsigned long long>(stats.seenProjectiles.load()));
		}

		std::string bandLine = "          ";
		std::array<double, BAND_COUNT> intervalMs{}, driftMean{};
		for (size_t i = 0; i < BAND_COUNT; ++i) {
			const uint64_t u = stats.bandUpdates[i].load();
			const uint64_t s = stats.bandStaleMs[i].load();
			const uint64_t d = stats.bandDrift[i].load();
			const uint64_t du = u - prevUpdates[i];
			intervalMs[i] = du ? static_cast<double>(s - prevStale[i]) / du : 0.0;
			driftMean[i] = du ? static_cast<double>(d - prevDrift[i]) / du : 0.0;
			prevUpdates[i] = u; prevStale[i] = s; prevDrift[i] = d;

			char buf[96];
			std::snprintf(buf, sizeof(buf), "%s: %4.0fms/%3.0fu  ",
			              BAND_NAMES[i], intervalMs[i], driftMean[i]);
			bandLine += buf;
		}
		std::cout << bandLine << "\n";

		if (csv) {
			csv << elapsed << ',' << live << ',' << stats.peak.load() << ','
			    << stats.connects.load() << ',' << stats.disconnects.load() << ','
			    << stats.errors.load() << ',' << stats.deaths.load() << ','
			    << frameRate << ',' << byteRate << ',' << recRate << ',' << perClient << ','
			    << txRate << ',' << tickRate << ',' << speed << ',' << cpuPct << ','
			    << throws << ',' << takes << ',' << shots << ','
			    << stats.seenPlayers.load() << ',' << stats.seenLoot.load() << ','
			    << stats.seenProjectiles.load();
			for (size_t i = 0; i < BAND_COUNT; ++i) {
				csv << ',' << intervalMs[i] << ',' << driftMean[i] << ','
				    << stats.bandDriftMax[i].load();
			}
			csv << "\n";
			csv.flush();
		}

		if (opt.durationSec > 0 && elapsed >= opt.durationSec) break;
	}

	std::cout << "stopping...\n";
	for (auto& g : groups) g->stop();
	for (BotPtr& b : allBots) b->stop();
	work.reset();
	io.stop();
	for (std::thread& t : workers) t.join();

	std::cout << "done. peak=" << stats.peak.load()
	          << " connects=" << stats.connects.load()
	          << " disconnects=" << stats.disconnects.load()
	          << " errors=" << stats.errors.load()
	          << " deaths=" << stats.deaths.load() << "\n";
	return 0;
}
