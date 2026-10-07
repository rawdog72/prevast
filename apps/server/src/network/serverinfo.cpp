// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "network/serverinfo.h"

#include "content/configmanager.h"

// NOTE: this project builds with unity/jumbo files on, so every file-local
// name here carries an `info` prefix -- an unprefixed `name` or `location`
// collides with another .cpp's anonymous namespace.
namespace {

	struct InfoTypeEntry
	{
		ServerInfo::Type type;
		const char* key;
	};

	// First spelling of each type is the canonical one reported to the listing.
	constexpr InfoTypeEntry INFO_TYPE_TABLE[] = {
		{ServerInfo::Type::SURVIVAL, "survival"},
		{ServerInfo::Type::GHOUL, "ghoul"},
		{ServerInfo::Type::BATTLE_ROYALE, "br"},
		{ServerInfo::Type::BATTLE_ROYALE, "battle-royale"},
		{ServerInfo::Type::BATTLE_ROYALE, "battleroyale"},
		{ServerInfo::Type::PRIVATE, "private"},
		{ServerInfo::Type::PRIVATE, "priv"},
		{ServerInfo::Type::COMMUNITY, "community"},
	};

	constexpr size_t INFO_MAX_NAME_LENGTH = 24;
	constexpr size_t INFO_MAX_LOCATION_LENGTH = 16;

	std::string infoName;
	ServerInfo::Type infoType = ServerInfo::Type::SURVIVAL;
	std::string infoLocation;
	bool infoVisible = true;
	std::atomic<int32_t> infoMaxPlayers{ static_cast<int32_t>(PROTOCOL_MAX_PLAYER_ID) };

	std::string infoPublicHost;
	uint16_t infoPublicPort = 0;
	bool infoPublicTls = false;
	std::string infoListingId;

	std::string infoToLower(const std::string& text)
	{
		std::string out = text;
		std::transform(out.begin(), out.end(), out.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		return out;
	}

	// client.js routes a server to a tab by searching its list label for these
	// markers, so one of them inside a name or location silently moves the
	// server to the wrong tab -- or, for HIDDEN, off the list entirely.
	bool infoContainsCategoryMarker(const std::string& text, std::string& marker)
	{
		const std::string lowered = infoToLower(text);
		for (const char* candidate : { "hidden", "priv", "ghoul", "br" }) {
			if (lowered.find(candidate) != std::string::npos) {
				marker = candidate;
				return true;
			}
		}
		return false;
	}

	bool infoValidateLabel(const std::string& value, size_t maxLength, bool allowEmpty,
		const char* what, std::string& error)
	{
		if (value.empty()) {
			if (allowEmpty) {
				return true;
			}
			error = fmt::format("{} cannot be empty.", what);
			return false;
		}
		if (value.size() > maxLength) {
			error = fmt::format("{} is limited to {} characters.", what, maxLength);
			return false;
		}
		for (const unsigned char c : value) {
			if (c < 0x20 || c == 0x7F) {
				error = fmt::format("{} cannot contain control characters.", what);
				return false;
			}
			// client.js splits an admin chat line on '!', so the rest of the
			// name would arrive as its own command.
			if (c == '!') {
				error = fmt::format("{} cannot contain '!'.", what);
				return false;
			}
		}
		return true;
	}

} // namespace

void ServerInfo::init()
{
	infoName = getString(ConfigManager::SERVER_NAME);
	if (infoName.empty()) {
		infoName = "Prevast Open Server";
	}
	if (infoName.size() > INFO_MAX_NAME_LENGTH) {
		infoName = infoName.substr(0, INFO_MAX_NAME_LENGTH);
	}

	// gameMode names a rule set (modes.xml), serverType names a list category.
	// They usually agree; when both are set, serverType wins.
	const std::string& modeKey = getString(ConfigManager::GAME_MODE);
	bool modeNamesAType = parseType(modeKey, infoType);
	if (!modeNamesAType) {
		infoType = Type::SURVIVAL;
	}
	if (const std::string& configured = getString(ConfigManager::SERVER_TYPE); !configured.empty()) {
		if (Type parsed; parseType(configured, parsed)) {
			// Disagreeing is legal and occasionally deliberate (a ghoul-rules
			// server deliberately listed as private, say), but the usual cause
			// is one of the two being changed and the other forgotten -- and
			// the result is a server nobody looking for it can find, because
			// the client picks a tab from this and never from the rules.
			if (modeNamesAType && parsed != infoType) {
				fmt::print(fg(fmt::color::yellow),
					">> [Warning] gameMode = \"{}\" but serverType = \"{}\"; the server will be listed\n"
					"   under \"{}\" and players browsing for \"{}\" will not see it. serverType wins.\n",
					modeKey, configured, configured, modeKey);
			}
			infoType = parsed;
		} else {
			fmt::print(fg(fmt::color::yellow),
				">> [Warning] serverType = \"{}\" is not a known type; using \"{}\".\n",
				configured, getTypeKey());
		}
	}

	infoLocation = getString(ConfigManager::LOCATION);
	if (std::string marker; infoContainsCategoryMarker(infoLocation, marker)) {
		fmt::print(fg(fmt::color::yellow),
			">> [Warning] location = \"{}\" contains \"{}\", which the client reads as a category\n"
			"   marker and would file this server under the wrong tab. Clearing it.\n",
			infoLocation, marker);
		infoLocation.clear();
	}

	infoVisible = getBoolean(ConfigManager::SERVER_VISIBLE);

	// 0 means "no limit" in config.lua, but the protocol addresses players with
	// one byte, so the real ceiling is 255 either way. Normalising here also
	// keeps 0 from reading as "full" at the login gate.
	const int32_t configuredMax = getNumber(ConfigManager::MAX_PLAYERS);
	infoMaxPlayers.store((configuredMax <= 0 || configuredMax > static_cast<int32_t>(PROTOCOL_MAX_PLAYER_ID))
		? static_cast<int32_t>(PROTOCOL_MAX_PLAYER_ID)
		: configuredMax, std::memory_order_relaxed);

	infoPublicHost = getString(ConfigManager::PUBLIC_HOST);
	if (infoPublicHost.empty()) {
		infoPublicHost = getString(ConfigManager::IP);
	}
	infoPublicPort = static_cast<uint16_t>(getNumber(ConfigManager::PUBLIC_PORT));
	if (infoPublicPort == 0) {
		infoPublicPort = static_cast<uint16_t>(getNumber(ConfigManager::GAME_PORT));
	}
	infoPublicTls = getBoolean(ConfigManager::PUBLIC_TLS);

	infoListingId = getString(ConfigManager::LISTING_ID);
	if (infoListingId.empty()) {
		infoListingId = fmt::format("{}:{}", infoPublicHost, infoPublicPort);
	}
}

const std::string& ServerInfo::getName() { return infoName; }

ServerInfo::Type ServerInfo::getType() { return infoType; }

const char* ServerInfo::getTypeKey()
{
	for (const auto& entry : INFO_TYPE_TABLE) {
		if (entry.type == infoType) {
			return entry.key;
		}
	}
	return "survival";
}

const std::string& ServerInfo::getLocation() { return infoLocation; }

bool ServerInfo::isVisible() { return infoVisible; }

int32_t ServerInfo::getMaxPlayers() { return infoMaxPlayers.load(std::memory_order_relaxed); }

bool ServerInfo::setName(const std::string& value, std::string& error)
{
	if (!infoValidateLabel(value, INFO_MAX_NAME_LENGTH, false, "Server name", error)) {
		return false;
	}
	// Only HIDDEN matters here: a name reaches the client's label behind a
	// PRIV/GHOUL prefix that is tested first, so "BR" in a name is harmless.
	if (infoToLower(value).find("hidden") != std::string::npos) {
		error = "Server name cannot contain \"hidden\" -- the client would drop it from the list.";
		return false;
	}
	infoName = value;
	return true;
}

bool ServerInfo::setType(const std::string& key, std::string& error)
{
	Type parsed;
	if (!parseType(key, parsed)) {
		error = "Unknown type. Use survival, ghoul, br, private or community.";
		return false;
	}
	infoType = parsed;
	return true;
}

bool ServerInfo::setLocation(const std::string& value, std::string& error)
{
	if (!infoValidateLabel(value, INFO_MAX_LOCATION_LENGTH, true, "Location", error)) {
		return false;
	}
	if (std::string marker; infoContainsCategoryMarker(value, marker)) {
		error = fmt::format(
			"Location cannot contain \"{}\" -- the client reads it as a category marker.", marker);
		return false;
	}
	infoLocation = value;
	return true;
}

void ServerInfo::setVisible(bool value) { infoVisible = value; }

bool ServerInfo::setMaxPlayers(int32_t value, std::string& error)
{
	if (value < 1 || value > static_cast<int32_t>(PROTOCOL_MAX_PLAYER_ID)) {
		error = fmt::format("Player cap must be between 1 and {} (the protocol's one-byte player id).",
			PROTOCOL_MAX_PLAYER_ID);
		return false;
	}
	infoMaxPlayers.store(value, std::memory_order_relaxed);
	return true;
}

bool ServerInfo::parseType(const std::string& key, Type& out)
{
	const std::string lowered = infoToLower(key);
	for (const auto& entry : INFO_TYPE_TABLE) {
		if (lowered == entry.key) {
			out = entry.type;
			return true;
		}
	}
	return false;
}

const std::string& ServerInfo::getPublicHost() { return infoPublicHost; }

uint16_t ServerInfo::getPublicPort() { return infoPublicPort; }

bool ServerInfo::getPublicTls() { return infoPublicTls; }

const std::string& ServerInfo::getListingId() { return infoListingId; }
