// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_BAN_H
#define FS_BAN_H

#include "network/connection.h"

// IP bans live in an in-memory store that always works; when the database is
// enabled (useDatabase in config.lua) every change is also written through to
// the `ip_bans` table so bans survive restarts. Without a database, bans
// simply reset when the server restarts.
namespace IOBan {

	struct BanInfo
	{
		std::string bannedBy;
		std::string reason;
		time_t expiresAt; // unix seconds; 0 = permanent
	};

	// Checked at connection time (memory first, then database if enabled).
	const std::optional<BanInfo> getIpBanInfo(const Connection::Address& clientIP);

	void addIpBan(const Connection::Address& ip, const BanInfo& info);
	bool removeIpBan(const Connection::Address& ip);

	// All bans currently known in memory (bans loaded lazily from the
	// database on connection checks are included once seen).
	std::vector<std::pair<Connection::Address, BanInfo>> getMemoryBans();

	// Creates the `ip_bans` table if it does not exist. Call once at startup,
	// only when the database is enabled.
	void ensureIpBanTable();

}; // namespace IOBan

#endif // FS_BAN_H
