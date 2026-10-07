// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/http_client.h"

#include "core/tasks.h"

#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>

#include <cctype>
#include <thread>

extern Dispatcher g_dispatcher;

namespace {

	namespace beast = boost::beast;
	namespace http = boost::beast::http;
	using tcp = boost::asio::ip::tcp;

	constexpr auto TIMEOUT = std::chrono::seconds(5);

	struct Url {
		std::string host;
		std::string port = "80";
		std::string target = "/";
	};

	bool parseUrl(const std::string& url, Url& out, std::string& error)
	{
		constexpr std::string_view scheme = "http://";
		if (url.rfind(scheme, 0) != 0) {
			error = "accountServiceUrl must start with http:// (TLS is not compiled in)";
			return false;
		}
		const std::string rest = url.substr(scheme.size());
		const size_t slash = rest.find('/');
		const std::string authority = rest.substr(0, slash);
		if (slash != std::string::npos) out.target = rest.substr(slash);
		const size_t colon = authority.rfind(':');
		out.host = colon == std::string::npos ? authority : authority.substr(0, colon);
		if (colon != std::string::npos) out.port = authority.substr(colon + 1);
		if (out.host.empty() || out.port.empty()) {
			error = "accountServiceUrl has no host or port";
			return false;
		}
		return true;
	}

} // namespace

namespace HttpClient {

	// Async on purpose, even though this function's own contract is blocking:
	// Beast's stream.expires_after() deadline only cancels an *asynchronous*
	// operation (basic_stream.hpp: "Timeouts are not available when performing
	// blocking calls"). The synchronous resolver::resolve/stream::connect/
	// http::write/http::read overloads used previously ignored TIMEOUT
	// entirely, so an unresponsive web host hung the calling thread forever.
	// Chaining async_resolve -> async_connect -> async_write -> async_read
	// (the same shape as serverlisting.cpp's listingDoPost) puts a fresh
	// stream.expires_after(TIMEOUT) ahead of each of the connect/write/read
	// steps, so each of those three is cancelled on its own ~5s deadline, and
	// ioc.run_for() below caps that part of the exchange at TIMEOUT + 1s.
	//
	// Name resolution is NOT covered by that cap. async_resolve hands the
	// actual getaddrinfo() call to a background thread
	// (resolver_thread_pool), and there is no portable way to cancel a
	// getaddrinfo() already running there. `ioc`'s destructor, reached when
	// this function returns, calls resolver_thread_pool::shutdown()
	// (boost/asio/detail/impl/resolver_thread_pool.ipp), which JOINS that
	// thread rather than abandoning it -- so request() itself blocks until
	// the OS resolver call returns, however long that takes, even after
	// run_for()'s hard cap below has already elapsed. In practice that means
	// requestAsync()'s detached worker (and only that worker -- the
	// dispatcher and everything else keep running) can be held open for as
	// long as the OS resolver takes on a dead or very slow DNS server. The
	// response it eventually delivers still correctly reports "timed out"
	// (see `completed` below); it just may arrive later than TIMEOUT + 1s.
	Response request(const std::string& method, const std::string& url, const Headers& headers,
	    const std::string& body)
	{
		Response response;
		Url target;
		if (!parseUrl(url, target, response.error)) return response;
		try {
			boost::asio::io_context ioc;
			tcp::resolver resolver{ ioc };
			beast::tcp_stream stream{ ioc };
			beast::flat_buffer buffer;
			http::response<http::string_body> res;
			std::string failure;
			// Only async_read's success path sets this. A default-constructed
			// http::response already reports status::ok (200), so `res` alone
			// cannot tell a real 200 from a run that never got a response --
			// this is what does.
			bool completed = false;

			http::request<http::string_body> req{ http::string_to_verb(method), target.target, 11 };
			req.set(http::field::host, target.host);
			req.set(http::field::user_agent, STATUS_SERVER_NAME);
			for (const auto& [name, value] : headers) req.set(name, value);
			if (!body.empty()) {
				req.set(http::field::content_type, "application/json");
				req.body() = body;
			}
			req.prepare_payload();

			resolver.async_resolve(target.host, target.port,
			    [&](beast::error_code ec, tcp::resolver::results_type results) {
				    if (ec) {
					    failure = "resolve: " + ec.message();
					    return;
				    }
				    stream.expires_after(TIMEOUT);
				    stream.async_connect(results, [&](beast::error_code ec, const tcp::endpoint&) {
					    if (ec) {
						    failure = "connect: " + ec.message();
						    return;
					    }
					    stream.expires_after(TIMEOUT);
					    http::async_write(stream, req, [&](beast::error_code ec, std::size_t) {
						    if (ec) {
							    failure = "write: " + ec.message();
							    return;
						    }
						    stream.expires_after(TIMEOUT);
						    http::async_read(stream, buffer, res, [&](beast::error_code ec, std::size_t) {
							    if (ec) {
								    failure = "read: " + ec.message();
							    } else {
								    completed = true;
							    }
						    });
					    });
				    });
			    });

			// Caps the connect/write/read chain at TIMEOUT + 1s on top of each
			// step's own deadline above. Does NOT cap DNS resolution: if
			// async_resolve's handler has not run by the time this returns, no
			// later step ran either, so `completed` stays false below -- but
			// `ioc`'s destructor (see the note above request()) still blocks
			// this function until the background resolver thread actually
			// finishes, however long that takes.
			ioc.run_for(TIMEOUT + std::chrono::seconds(1));

			beast::error_code ignored;
			stream.socket().shutdown(tcp::socket::shutdown_both, ignored);

			if (!failure.empty()) {
				response.error = failure;
			} else if (!completed) {
				// Neither a failure nor a genuine response: the chain never
				// reached async_read's success handler before run_for()
				// returned. (A default-constructed http::response already
				// reports status::ok, so res.result_int() alone cannot tell
				// this apart from a real 200 -- `completed` is what does.)
				response.error = "timed out";
			} else {
				response.status = static_cast<int>(res.result_int());
				response.body = std::move(res.body());
			}
		} catch (const std::exception& e) {
			response.error = e.what();
		}
		return response;
	}

	void requestAsync(std::string method, std::string url, Headers headers, std::string body,
	    std::function<void(Response)> onDone)
	{
		// Detached: admin commands are rare, and connect/write/read are each
		// bounded by TIMEOUT -- but name resolution is not (see the note
		// above request()), so a dead or very slow DNS server can hold this
		// worker thread open well past TIMEOUT while everything else on the
		// server, including the dispatcher, keeps running. onDone() fires
		// exactly once, whenever this thread's request() call eventually
		// returns.
		std::thread([method = std::move(method), url = std::move(url), headers = std::move(headers),
		                body = std::move(body), onDone = std::move(onDone)]() mutable {
			Response response = request(method, url, headers, body);
			g_dispatcher.addTask([onDone = std::move(onDone), response = std::move(response)]() mutable {
				onDone(std::move(response));
			});
		}).detach();
	}

	std::string percentEncode(std::string_view text)
	{
		std::string out;
		for (const unsigned char c : text) {
			if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
				out.push_back(static_cast<char>(c));
			} else {
				out += fmt::format("%{:02X}", c);
			}
		}
		return out;
	}

} // namespace HttpClient
