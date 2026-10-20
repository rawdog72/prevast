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

	// Guarded: logins run on the dispatcher, but the lock keeps the store safe
	// for any caller.
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

	// The row(s) for one canonical address. Rows written before addresses were
	// canonicalised hold an IPv4 client as ::ffff:a.b.c.d, so both spellings
	// are matched.
	std::string banRowCondition(const Connection::Address& ip)
	{
		const Database& db = Database::getInstance();
		if (ip.is_v4()) {
			const auto mapped = boost::asio::ip::make_address_v6(boost::asio::ip::v4_mapped, ip.to_v4());
			return fmt::format("`ip` IN (INET6_ATON({:s}), INET6_ATON({:s}))",
				db.escapeString(ip.to_string()), db.escapeString(mapped.to_string()));
		}
		return fmt::format("`ip` = INET6_ATON({:s})", db.escapeString(ip.to_string()));
	}

} // namespace

namespace IOBan {

	const std::optional<BanInfo> getIpBanInfo(const Connection::Address& clientIP)
	{
		const Connection::Address ip = Connection::canonicalAddress(clientIP);
		if (ip.is_unspecified()) {
			return std::nullopt;
		}

		std::lock_guard<std::mutex> guard(banLock);
		auto it = memoryBans.find(ip);
		if (it == memoryBans.end()) {
			return std::nullopt;
		}
		if (isExpired(it->second)) {
			memoryBans.erase(it);
			if (databaseEnabled()) {
				g_databaseTasks.addTask(fmt::format("DELETE FROM `ip_bans` WHERE {:s}", banRowCondition(ip)));
			}
			return std::nullopt;
		}
		return it->second;
	}

	void addIpBan(const Connection::Address& clientIP, const BanInfo& info)
	{
		const Connection::Address ip = Connection::canonicalAddress(clientIP);
		{
			std::lock_guard<std::mutex> guard(banLock);
			memoryBans[ip] = info;
		}

		if (databaseEnabled()) {
			Database& db = Database::getInstance();
			g_databaseTasks.addTask(fmt::format(
				"INSERT INTO `ip_bans` (`ip`, `reason`, `banned_at`, `expires_at`, `banned_by`) "
				"VALUES (INET6_ATON({:s}), {:s}, {:d}, {:d}, {:s}) "
				"ON DUPLICATE KEY UPDATE `reason` = VALUES(`reason`), `banned_at` = VALUES(`banned_at`), "
				"`expires_at` = VALUES(`expires_at`), `banned_by` = VALUES(`banned_by`)",
				db.escapeString(ip.to_string()), db.escapeString(info.reason), static_cast<int64_t>(time(nullptr)),
				static_cast<int64_t>(info.expiresAt), db.escapeString(info.bannedBy)));
		}
	}

	bool removeIpBan(const Connection::Address& clientIP)
	{
		const Connection::Address ip = Connection::canonicalAddress(clientIP);
		bool found;
		{
			std::lock_guard<std::mutex> guard(banLock);
			found = memoryBans.erase(ip) > 0;
		}

		if (databaseEnabled()) {
			// Matches a row in either spelling of the address.
			g_databaseTasks.addTask(fmt::format("DELETE FROM `ip_bans` WHERE {:s}", banRowCondition(ip)));
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

	void loadIpBans()
	{
		Database& db = Database::getInstance();
		const int64_t now = static_cast<int64_t>(time(nullptr));

		db.executeQuery(fmt::format("DELETE FROM `ip_bans` WHERE `expires_at` <> 0 AND `expires_at` < {:d}", now));

		size_t loaded = 0;
		DBResult_ptr result = db.storeQuery(
			"SELECT INET6_NTOA(`ip`) AS `address`, `reason`, `expires_at`, `banned_by` FROM `ip_bans`");
		if (result) {
			std::lock_guard<std::mutex> guard(banLock);
			do {
				boost::system::error_code ec;
				const auto ip = boost::asio::ip::make_address(std::string(result->getString("address")), ec);
				if (ec) {
					continue;
				}
				BanInfo info;
				info.expiresAt = result->getNumber<time_t>("expires_at");
				info.reason = std::string(result->getString("reason"));
				if (info.reason.empty()) {
					info.reason = "(none)";
				}
				info.bannedBy = std::string(result->getString("banned_by"));
				memoryBans[Connection::canonicalAddress(ip)] = std::move(info);
				++loaded;
			} while (result->next());
		}
		fmt::print(">> {} IP ban{} in force\n", loaded, loaded == 1 ? "" : "s");
	}

} // namespace IOBan
