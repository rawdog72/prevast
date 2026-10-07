// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/protocolstatus.h"

#include "content/configmanager.h"
#include "gameplay/game.h"
#include "network/serverinfo.h"
#include "network/outputmessage.h"
#include "content/contentexport.h"

#include <ranges>
#include "core/tasks.h"
#include <iostream>

extern Game g_game;

std::map<Connection::Address, int64_t> ProtocolStatus::ipConnectMap;
const uint64_t ProtocolStatus::start = OTSYS_TIME();

enum RequestedInfo_t : uint16_t
{
	REQUEST_BASIC_SERVER_INFO = 1 << 0,
	REQUEST_OWNER_SERVER_INFO = 1 << 1,
	REQUEST_MISC_SERVER_INFO = 1 << 2,
	REQUEST_PLAYERS_INFO = 1 << 3,
	REQUEST_MAP_INFO = 1 << 4,
	REQUEST_EXT_PLAYERS_INFO = 1 << 5,
	REQUEST_PLAYER_STATUS_INFO = 1 << 6,
	REQUEST_SERVER_SOFTWARE_INFO = 1 << 7,
};

void ProtocolStatus::onRecvFirstMessage(NetworkMessage& msg)
{
	// make_address THROWS on anything that is not a literal IP (hostname,
	// empty string); an uncaught exception here runs on an io thread and
	// terminates the whole server on the first status query. Parse once with
	// an error code and fall back to the unspecified address.
	const static auto acceptorAddress = [] {
		boost::system::error_code ec;
		auto addr = boost::asio::ip::make_address(getString(ConfigManager::IP), ec);
		return ec ? boost::asio::ip::address{} : addr;
	}();

	const auto& ip = getIP();
	const int64_t now = OTSYS_TIME();
	const int64_t timeout = getNumber(ConfigManager::STATUSQUERY_TIMEOUT);

	if (!ip.is_loopback() && ip != acceptorAddress) {
		if (auto it = ipConnectMap.find(ip); it != ipConnectMap.end() && now < it->second + timeout) {
			disconnect();
			return;
		}
	}

	// Amortized cleanup: without it the map grows by one entry per unique
	// IP for the life of the server.
	// All calls run on the dispatcher.
	if (ipConnectMap.size() >= 1000) {
		std::erase_if(ipConnectMap, [now, timeout](const auto& entry) { return now >= entry.second + timeout; });
	}

	if (!ipConnectMap.contains(ip) && ipConnectMap.size() >= 4096) { disconnect(); return; }
	ipConnectMap[ip] = now;

	std::string jsonData = msg.getString();
	boost::system::error_code ec;
	auto jv = boost::json::parse(jsonData, ec);
	if (msg.hasReadError() || msg.getRemainingLength() != 0 || ec || !jv.is_array()) {
		disconnect();
		return;
	}

	auto& arr = jv.as_array();
	if (arr.size() != 1 || !arr[0].is_int64() || arr[0].as_int64() != 255) {
		disconnect();
		return;
	}

	uint8_t opcode = static_cast<uint8_t>(arr[0].as_int64());
	if (opcode == 0xFF) {
		sendStatusJSON();
	}
	else {
		disconnect();
	}
}

void ProtocolStatus::sendStatusJSON()
{
	uint64_t uptime = (OTSYS_TIME() - ProtocolStatus::start) / 1000;

	boost::json::object obj;
	obj["uptime"] = uptime;
	obj["players"] = g_game.getPlayersOnline(); // dispatcher thread: safe to read
	obj["playersMax"] = ServerInfo::getMaxPlayers();
	obj["mapName"] = getString(ConfigManager::MAP_NAME);
	obj["mapAuthor"] = getString(ConfigManager::MAP_AUTHOR);
	obj["version"] = STATUS_SERVER_VERSION;
	obj["client"] = CLIENT_VERSION_STR;
	obj["mode"] = getString(ConfigManager::GAME_MODE);
	obj["protocolVersion"] = 1;
	obj["contentHash"] = contentexport::ContentManager::getInstance().getCombinedHash();

	if (auto connection = getConnection()) {
		connection->sendJSON(obj);
	}
	disconnect();
}
