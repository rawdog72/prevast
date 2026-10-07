// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "persistence/ban.h"

#include "content/configmanager.h"
#include "network/connection.h"
#include "persistence/database.h"
#include "persistence/databasetasks.h"

#include <mutex>

extern DatabaseTasks g_databaseTasks;

namespace {

	// Guarded: connection checks run on io threads, admin commands on the
	// dispatcher thread.
	std::mutex banLock;
	std::map<Connection::Address, IOBan::BanInfo> memoryBans;

	bool databaseEnabled()
	{
		return ConfigManager::getBoolean(ConfigManager::USE_DATABASE);
	}

	bool isExpired(const IOBan::BanInfo& info)
	{
		return info.expiresAt != 0 && time(nullptr) > info.expiresAt;
	}

} // namespace

namespace IOBan {

	const std::optional<BanInfo> getIpBanInfo(const Connection::Address& clientIP)
	{
		if (clientIP.is_unspecified()) {
			return std::nullopt;
		}

		{
			std::lock_guard<std::mutex> guard(banLock);
			auto it = memoryBans.find(clientIP);
			if (it != memoryBans.end()) {
				if (isExpired(it->second)) {
					memoryBans.erase(it);
					// fall through: an unexpired database row would be stale
					// too, and the query below deletes it
				} else {
					return it->second;
				}
			}
		}

		if (!databaseEnabled()) {
			return std::nullopt;
		}

		Database& db = Database::getInstance();

		DBResult_ptr result = db.storeQuery(fmt::format(
			"SELECT `reason`, `expires_at`, `banned_by` FROM `ip_bans` WHERE `ip` = INET6_ATON('{:s}')",
			clientIP.to_string()));
		if (!result) {
			return std::nullopt;
		}

		time_t expiresAt = result->getNumber<time_t>("expires_at");
		if (expiresAt != 0 && std::chrono::system_clock::now() > std::chrono::system_clock::from_time_t(expiresAt)) {
			g_databaseTasks.addTask(
				fmt::format("DELETE FROM `ip_bans` WHERE `ip` = INET6_ATON('{:s}')", clientIP.to_string()));
			return std::nullopt;
		}

		auto banInfo = std::make_optional<BanInfo>();
		banInfo->expiresAt = expiresAt;

		banInfo->reason = result->getString("reason");
		if (banInfo->reason.empty()) {
			banInfo->reason = "(none)";
		}

		banInfo->bannedBy = result->getString("banned_by");

		// Cache in memory so !banlist shows it and repeat checks skip the query
		{
			std::lock_guard<std::mutex> guard(banLock);
			memoryBans[clientIP] = *banInfo;
		}
		return banInfo;
	}

	void addIpBan(const Connection::Address& ip, const BanInfo& info)
	{
		{
			std::lock_guard<std::mutex> guard(banLock);
			memoryBans[ip] = info;
		}

		if (databaseEnabled()) {
			Database& db = Database::getInstance();
			g_databaseTasks.addTask(fmt::format(
				"INSERT INTO `ip_bans` (`ip`, `reason`, `banned_at`, `expires_at`, `banned_by`) "
				"VALUES (INET6_ATON('{:s}'), {:s}, {:d}, {:d}, {:s}) "
				"ON DUPLICATE KEY UPDATE `reason` = VALUES(`reason`), `banned_at` = VALUES(`banned_at`), "
				"`expires_at` = VALUES(`expires_at`), `banned_by` = VALUES(`banned_by`)",
				ip.to_string(), db.escapeString(info.reason), static_cast<int64_t>(time(nullptr)),
				static_cast<int64_t>(info.expiresAt), db.escapeString(info.bannedBy)));
		}
	}

	bool removeIpBan(const Connection::Address& ip)
	{
		bool found;
		{
			std::lock_guard<std::mutex> guard(banLock);
			found = memoryBans.erase(ip) > 0;
		}

		if (databaseEnabled()) {
			// The ban may exist only in the database (placed before a restart)
			g_databaseTasks.addTask(
				fmt::format("DELETE FROM `ip_bans` WHERE `ip` = INET6_ATON('{:s}')", ip.to_string()));
			found = true;
		}
		return found;
	}

	std::vector<std::pair<Connection::Address, BanInfo>> getMemoryBans()
	{
		std::lock_guard<std::mutex> guard(banLock);

		std::vector<std::pair<Connection::Address, BanInfo>> bans;
		for (auto it = memoryBans.begin(); it != memoryBans.end();) {
			if (isExpired(it->second)) {
				it = memoryBans.erase(it);
			} else {
				bans.emplace_back(it->first, it->second);
				++it;
			}
		}
		return bans;
	}

	void ensureIpBanTable()
	{
		// Standalone schema (no foreign keys): matches the columns and the
		// INET6_ATON storage format the queries above use. A pre-existing
		// TFS-schema table with the same layout is left untouched.
		Database::getInstance().executeQuery(
			"CREATE TABLE IF NOT EXISTS `ip_bans` ("
			"`ip` VARBINARY(16) NOT NULL, "
			"`reason` VARCHAR(255) NOT NULL DEFAULT '', "
			"`banned_at` BIGINT NOT NULL DEFAULT 0, "
			"`expires_at` BIGINT NOT NULL DEFAULT 0, "
			"`banned_by` VARCHAR(64) NOT NULL DEFAULT '', "
			"PRIMARY KEY (`ip`)"
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
	}

} // namespace IOBan
