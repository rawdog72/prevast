// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef PREVAST_HTTP_CLIENT_H
#define PREVAST_HTTP_CLIENT_H

#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// A minimal http:// client for the rare calls the game server makes to the
// web host (!setgroup). TLS is not compiled in, as for the listing heartbeat.
namespace HttpClient {

	struct Response {
		int status = 0;      // 0 when no response arrived
		std::string body;
		std::string error;   // non-empty when the request failed before a status
	};

	using Headers = std::vector<std::pair<std::string, std::string>>;

	// Blocking. Connect, write and read are each bounded by their own ~5s
	// deadline (so a reachable but stalled or dead host returns in ~6s), but
	// DNS resolution is not bounded by this call at all -- it can take as
	// long as the OS resolver allows. Never call on the dispatcher.
	Response request(const std::string& method, const std::string& url, const Headers& headers,
	    const std::string& body);

	// Runs request() on a short-lived worker thread and hands the response to
	// the dispatcher, where onDone runs.
	void requestAsync(std::string method, std::string url, Headers headers, std::string body,
	    std::function<void(Response)> onDone);

	std::string percentEncode(std::string_view text);

} // namespace HttpClient

#endif
