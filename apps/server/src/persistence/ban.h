// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_BAN_H
#define FS_BAN_H

#include "network/connection.h"

// IP bans live in an in-memory store that always works; when the database is
// enabled (useDatabase in config.lua) every change is also written through to
// the `ip_bans` table, and loadIpBans() reads the table back at startup, so
// bans survive restarts. Without a database, bans simply reset when the server
// restarts.
//
// Lookups never touch the database: they run on the dispatcher for every
// login, where a query would hold up the game for a round trip (and for as
// long as the database is unreachable). A ban written to the table by anything
// other than this server is therefore seen on its next start.
//
// Addresses are stored canonically (Connection::canonicalAddress), so a ban on
// 1.2.3.4 matches the client the dual-stack listener reports as ::ffff:1.2.3.4.
namespace IOBan {

	struct BanInfo
	{
		std::string bannedBy;
		std::string reason;
		time_t expiresAt; // unix seconds; 0 = permanent
	};

	// Checked at login.
	const std::optional<BanInfo> getIpBanInfo(const Connection::Address& clientIP);

	void addIpBan(const Connection::Address& ip, const BanInfo& info);
	bool removeIpBan(const Connection::Address& ip);

	// Every ban currently in force.
	std::vector<std::pair<Connection::Address, BanInfo>> getMemoryBans();

	// Creates the `ip_bans` table if it does not exist, then loads the bans
	// still in force. Call once at startup, only when the database is enabled.
	void ensureIpBanTable();
	void loadIpBans();

}; // namespace IOBan

#endif // FS_BAN_H
