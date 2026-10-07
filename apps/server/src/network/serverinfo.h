// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SERVERINFO_H
#define FS_SERVERINFO_H

#include <atomic>
#include <string>

// This server's identity as the client's server list sees it: name, type,
// location, whether it is listed at all, and the live player cap.
//
// config.lua seeds these at boot and ServerInfo owns them from then on -- the
// same split as MapSize, for the same reason: an admin command that moved the
// value would leave the config file lying about it. Changes are in-memory
// only; a restart is a reset, deliberately.
//
// Dispatcher thread only, except maxPlayers().
namespace ServerInfo {

	enum class Type : uint8_t
	{
		SURVIVAL,
		GHOUL,
		BATTLE_ROYALE,
		PRIVATE,
		COMMUNITY,
	};

	void init();

	const std::string& getName();
	Type getType();
	const char* getTypeKey(); // "survival", "ghoul", "br", "private", "community"
	const std::string& getLocation();
	bool isVisible();

	// Live player cap. Every maxPlayers decision reads this, not config.lua.
	int32_t getMaxPlayers();

	// Each returns false and fills `error` on a rejected value.
	bool setName(const std::string& value, std::string& error);
	bool setType(const std::string& key, std::string& error);
	bool setLocation(const std::string& value, std::string& error);
	void setVisible(bool value);
	bool setMaxPlayers(int32_t value, std::string& error);

	bool parseType(const std::string& key, Type& out);

	// What this server advertises as its address, which it cannot infer.
	const std::string& getPublicHost();
	uint16_t getPublicPort();
	bool getPublicTls();

	// Stable identity across restarts, so a returning server replaces its own
	// listing entry instead of adding a second one.
	const std::string& getListingId();

} // namespace ServerInfo

#endif // FS_SERVERINFO_H
