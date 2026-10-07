// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/serverlisting.h"

#include "content/configmanager.h"
#include "gameplay/game.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "network/serverinfo.h"
#include "core/tasks.h"

#include <boost/beast/http.hpp>

extern Game g_game;
extern Dispatcher g_dispatcher;
extern Scheduler g_scheduler;

// NOTE: unity/jumbo builds are on, so every file-local name here carries a
// `listing` prefix to stay out of other translation units' way.
namespace {

	namespace beast = boost::beast;
	namespace listing_http = boost::beast::http;
	using listing_tcp = boost::asio::ip::tcp;

	constexpr int LISTING_REQUEST_TIMEOUT_SECONDS = 5;
	constexpr int64_t LISTING_ERROR_LOG_INTERVAL_MS = 60000;
	constexpr uint32_t LISTING_MIN_INTERVAL_SECONDS = 5;
	constexpr uint32_t LISTING_MAX_INTERVAL_SECONDS = 300;

	std::string listingHost;
	std::string listingPort;
	std::string listingTarget;
	std::string listingToken;
	std::string listingId;

	uint32_t listingIntervalMs = 10000;
	std::atomic<bool> listingEnabled{ false };
	int64_t listingStartedAt = 0;

	boost::asio::io_context listingWorkerContext;
	std::optional<boost::asio::executor_work_guard<boost::asio::io_context::executor_type>> listingWorkGuard;
	std::thread listingWorker;

	// One beat at a time. A site that accepts connections but never answers
	// would otherwise queue a beat every interval forever.
	std::atomic_flag listingBeatInFlight;
	int64_t listingLastErrorLog = 0;
	uint32_t listingEventId = 0;

	void listingReportFailure(const std::string& reason)
	{
		// Throttled: a site that is down stays down for a while, and this runs
		// every interval.
		const int64_t now = OTSYS_TIME();
		if (now - listingLastErrorLog < LISTING_ERROR_LOG_INTERVAL_MS) {
			return;
		}
		listingLastErrorLog = now;
		fmt::print(fg(fmt::color::yellow), ">> [Listing] heartbeat to {}:{} failed ({}). Retrying every {}s.\n",
			listingHost, listingPort, reason, listingIntervalMs / 1000);
	}

	// "http://host[:port][/path]". https is refused rather than silently
	// downgraded -- it would need OpenSSL linked in for one machine-to-machine
	// call, so keep the endpoint on a plain-HTTP port instead.
	bool listingParseUrl(const std::string& url, std::string& error)
	{
		constexpr std::string_view prefix = "http://";
		if (url.rfind("https://", 0) == 0) {
			error = "listingUrl must be http:// (TLS is not compiled in); expose the endpoint on a plain HTTP port.";
			return false;
		}
		if (url.compare(0, prefix.size(), prefix) != 0) {
			error = "listingUrl must start with http://";
			return false;
		}

		std::string rest = url.substr(prefix.size());
		const size_t slash = rest.find('/');
		const std::string authority = (slash == std::string::npos) ? rest : rest.substr(0, slash);
		listingTarget = (slash == std::string::npos) ? "/" : rest.substr(slash);

		const size_t colon = authority.rfind(':');
		if (colon == std::string::npos) {
			listingHost = authority;
			listingPort = "80";
		} else {
			listingHost = authority.substr(0, colon);
			listingPort = authority.substr(colon + 1);
		}

		if (listingHost.empty() || listingPort.empty()) {
			error = "listingUrl has no host or port.";
			return false;
		}
		return true;
	}

	const char* listingStateName()
	{
		switch (g_game.getGameState()) {
			case GAME_STATE_NORMAL: return "open";
			case GAME_STATE_CLOSED: return "closed";
			case GAME_STATE_MAINTAIN: return "maintenance";
			case GAME_STATE_SHUTDOWN:
			case GAME_STATE_CLOSING: return "offline";
			default: return "startup";
		}
	}

	// Dispatcher thread: reads ServerInfo and the live world.
	std::string listingBuildPayload()
	{
		boost::json::object obj;
		obj["token"] = listingToken;
		obj["id"] = listingId;
		obj["name"] = ServerInfo::getName();
		obj["type"] = ServerInfo::getTypeKey();
		obj["location"] = ServerInfo::getLocation();
		obj["host"] = ServerInfo::getPublicHost();
		obj["port"] = static_cast<int32_t>(ServerInfo::getPublicPort());
		obj["tls"] = ServerInfo::getPublicTls() ? 1 : 0;
		// The status-protocol port (protocolstatus.cpp): the site's home screen
		// pings it for a client-measured round trip and live counts.
		obj["statusPort"] = static_cast<int32_t>(getNumber(ConfigManager::STATUS_PORT));
		obj["players"] = static_cast<uint64_t>(g_game.getPlayersOnline());
		obj["max"] = ServerInfo::getMaxPlayers();
		obj["mapX"] = MapSize::tilesX();
		obj["mapY"] = MapSize::tilesY();
		obj["visible"] = ServerInfo::isVisible() ? 1 : 0;
		obj["state"] = listingStateName();
		obj["version"] = CLIENT_VERSION_MAX;
		obj["uptime"] = (OTSYS_TIME() - listingStartedAt) / 1000;
		// The site ages an entry out after a few of these.
		obj["interval"] = static_cast<int32_t>(listingIntervalMs / 1000);
		return boost::json::serialize(obj);
	}

	// Worker thread. Every step is bounded, so an unreachable site costs one
	// timeout and nothing else.
	void listingDoPost(const std::string& body, bool logFailures)
	{
		boost::asio::io_context ioc;
		listing_tcp::resolver resolver{ ioc };
		beast::tcp_stream stream{ ioc };
		beast::flat_buffer buffer;
		listing_http::response<listing_http::string_body> res;
		std::string failure;

		listing_http::request<listing_http::string_body> req{ listing_http::verb::post, listingTarget, 11 };
		req.set(listing_http::field::host, listingHost);
		req.set(listing_http::field::user_agent, STATUS_SERVER_NAME);
		req.set(listing_http::field::content_type, "application/json");
		req.body() = body;
		req.prepare_payload();

		resolver.async_resolve(listingHost, listingPort,
			[&](beast::error_code ec, listing_tcp::resolver::results_type results) {
				if (ec) {
					failure = "resolve: " + ec.message();
					return;
				}
				stream.expires_after(std::chrono::seconds(LISTING_REQUEST_TIMEOUT_SECONDS));
				stream.async_connect(results, [&](beast::error_code ec, const listing_tcp::endpoint&) {
					if (ec) {
						failure = "connect: " + ec.message();
						return;
					}
					listing_http::async_write(stream, req, [&](beast::error_code ec, std::size_t) {
						if (ec) {
							failure = "write: " + ec.message();
							return;
						}
						listing_http::async_read(stream, buffer, res, [&](beast::error_code ec, std::size_t) {
							if (ec) {
								failure = "read: " + ec.message();
							} else if (res.result() != listing_http::status::ok) {
								failure = fmt::format("HTTP {}", res.result_int());
							}
							});
						});
					});
			});

		// Hard bound on top of the per-operation deadline: nothing here may
		// outlive one interval. Handlers still pending when this returns are
		// destroyed with the io_context, never run.
		ioc.run_for(std::chrono::seconds(LISTING_REQUEST_TIMEOUT_SECONDS + 1));

		beast::error_code ignored;
		stream.socket().shutdown(listing_tcp::socket::shutdown_both, ignored);

		if (!failure.empty() && logFailures) {
			listingReportFailure(failure);
		}
	}

	void listingPostToWorker(std::string body, bool logFailures)
	{
		if (listingBeatInFlight.test_and_set(std::memory_order_acquire)) {
			return; // previous beat still going; the next interval covers it
		}
		boost::asio::post(listingWorkerContext, [body = std::move(body), logFailures]() {
			listingDoPost(body, logFailures);
			listingBeatInFlight.clear(std::memory_order_release);
			});
	}

	void listingBeat()
	{
		if (!listingEnabled.load(std::memory_order_relaxed)) {
			return;
		}
		listingPostToWorker(listingBuildPayload(), true);
	}

	void listingScheduleNext()
	{
		if (!listingEnabled.load(std::memory_order_relaxed)) {
			return;
		}
		listingEventId = g_scheduler.addEvent(createSchedulerTask(listingIntervalMs, []() {
			g_dispatcher.addTask([]() {
				listingBeat();
				listingScheduleNext();
				});
			}));
	}

} // namespace

void ServerListing::start()
{
	const std::string& url = getString(ConfigManager::LISTING_URL);
	if (url.empty()) {
		fmt::print(">> Server listing disabled (no listingUrl in config.lua).\n");
		return;
	}

	if (std::string error; !listingParseUrl(url, error)) {
		fmt::print(fg(fmt::color::yellow), ">> [Warning] Server listing disabled: {}\n", error);
		return;
	}

	listingToken = getString(ConfigManager::LISTING_TOKEN);
	listingId = ServerInfo::getListingId();
	listingStartedAt = OTSYS_TIME();

	const int32_t configured = getNumber(ConfigManager::LISTING_INTERVAL_SECONDS);
	const uint32_t seconds = std::clamp(static_cast<uint32_t>(std::max(0, configured)),
		LISTING_MIN_INTERVAL_SECONDS, LISTING_MAX_INTERVAL_SECONDS);
	listingIntervalMs = seconds * 1000;

	listingEnabled.store(true, std::memory_order_relaxed);
	listingWorkGuard.emplace(boost::asio::make_work_guard(listingWorkerContext));
	listingWorker = std::thread([]() { listingWorkerContext.run(); });

	fmt::print(">> Server listing: \"{}\" ({}) at {}:{} -> {}:{}{} every {}s\n",
		ServerInfo::getName(), ServerInfo::getTypeKey(), ServerInfo::getPublicHost(),
		ServerInfo::getPublicPort(), listingHost, listingPort, listingTarget, seconds);

	listingBeat();
	listingScheduleNext();
}

void ServerListing::stop()
{
	if (!listingEnabled.exchange(false, std::memory_order_relaxed)) {
		return;
	}

	if (listingEventId != 0) {
		g_scheduler.stopEvent(listingEventId);
		listingEventId = 0;
	}

	// Built from the two fields that never change after start(), so the
	// shutdown path does not have to read game state on the wrong thread.
	boost::json::object obj;
	obj["token"] = listingToken;
	obj["id"] = listingId;
	obj["offline"] = 1;

	listingBeatInFlight.clear(std::memory_order_release); // a stuck beat must not eat the farewell
	listingPostToWorker(boost::json::serialize(obj), false);

	listingWorkGuard.reset();
	if (listingWorker.joinable()) {
		listingWorker.join();
	}
}

void ServerListing::notifyChanged() { listingBeat(); }
