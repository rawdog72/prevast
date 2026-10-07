// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef PREVAST_GROUPS_H
#define PREVAST_GROUPS_H

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

// Staff groups (data/XML/groups.xml) and the rank each !command needs
// (data/XML/commands.xml). A Player stores only its group ID and looks the
// group up here, so !reload=groups takes effect on everyone at once.
enum class GroupFlag : uint32_t {
	StaffChat = 1u << 0,
	Immortal = 1u << 1,
	BypassInvincible = 1u << 2,
	NoRateLimit = 1u << 3,
	NoIdleKick = 1u << 4,
	AlwaysLogin = 1u << 5,
};

struct Group {
	uint8_t id = 1;
	std::string name;
	uint8_t rank = 0;
	std::string badge;
	uint32_t flags = 0;

	bool has(GroupFlag flag) const { return (flags & static_cast<uint32_t>(flag)) != 0; }
};

class Groups {
public:
	Groups();

	// Replaces the loaded set only when the whole file is valid.
	bool loadFromXml(const std::string& file);

	const Group* get(uint8_t id) const;
	// Unknown ids fall back to the rank-0 group.
	const Group& getOrDefault(uint8_t id) const;
	const Group& defaultGroup() const { return groups.front(); }
	const Group& highest() const { return groups.back(); }
	// "gamemaster", "GameMaster" or "3".
	const Group* find(std::string_view nameOrId) const;
	// Ascending rank.
	const std::vector<Group>& all() const { return groups; }

private:
	std::vector<Group> groups;
};

class CommandPermissions {
public:
	bool loadFromXml(const std::string& file, const Groups& groups);
	// A command not in commands.xml needs the highest rank; before any load,
	// nothing is allowed.
	uint8_t requiredRank(std::string_view command) const;

private:
	std::unordered_map<std::string, uint8_t> ranks;
	uint8_t unlistedRank = 255;
};

extern Groups g_groups;
extern CommandPermissions g_commandPermissions;

#endif
