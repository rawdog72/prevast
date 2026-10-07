// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/groups.h"

#include "content/xml_utils.h"
#include "core/tools.h"

#include <algorithm>
#include <charconv>
#include <sstream>
#include <unordered_set>

Groups g_groups;
CommandPermissions g_commandPermissions;

namespace {

	struct FlagName {
		const char* name;
		GroupFlag flag;
	};

	constexpr FlagName FLAG_NAMES[] = {
		{ "staffChat", GroupFlag::StaffChat },
		{ "immortal", GroupFlag::Immortal },
		{ "bypassInvincible", GroupFlag::BypassInvincible },
		{ "noRateLimit", GroupFlag::NoRateLimit },
		{ "noIdleKick", GroupFlag::NoIdleKick },
		{ "alwaysLogin", GroupFlag::AlwaysLogin },
	};

	bool parseByte(std::string_view text, uint8_t& out)
	{
		unsigned value = 0;
		const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
		if (text.empty() || error != std::errc() || end != text.data() + text.size() || value > 255) return false;
		out = static_cast<uint8_t>(value);
		return true;
	}

	std::vector<std::string> words(std::string_view text)
	{
		std::vector<std::string> out;
		std::istringstream in{ std::string(text) };
		for (std::string word; in >> word;) out.push_back(std::move(word));
		return out;
	}

	bool sameIgnoringCase(std::string_view a, std::string_view b)
	{
		return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) {
			return std::tolower(static_cast<unsigned char>(x)) == std::tolower(static_cast<unsigned char>(y));
		});
	}

} // namespace

// Before groups.xml loads there is exactly the guest group, so nothing that
// asks for a player's group can ever find an empty list.
Groups::Groups() : groups{ Group{ 1, "player", 0, "", 0 } } {}

bool Groups::loadFromXml(const std::string& file)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, file, "groups");
	if (!root) return false;

	std::vector<Group> loaded;
	std::unordered_set<uint8_t> ids, ranks;
	bool ok = true;
	const auto problem = [&ok](const std::string& message) {
		reportDataWarning("groups.xml", message);
		ok = false;
	};

	for (pugi::xml_node node = root.child("group"); node; node = node.next_sibling("group")) {
		Group group;
		if (!parseByte(node.attribute("id").as_string(), group.id) || group.id == 0) {
			problem(fmt::format("a group has id=\"{}\"; ids are 1-255", node.attribute("id").as_string()));
			continue;
		}
		if (!parseByte(node.attribute("rank").as_string(), group.rank)) {
			problem(fmt::format("group {} has rank=\"{}\"; ranks are 0-255", group.id, node.attribute("rank").as_string()));
			continue;
		}
		group.name = node.attribute("name").as_string();
		group.badge = node.attribute("badge").as_string();
		if (group.name.empty()) problem(fmt::format("group {} has no name", group.id));
		if (!ids.insert(group.id).second) problem(fmt::format("group id {} is used twice", group.id));
		if (!ranks.insert(group.rank).second) problem(fmt::format("rank {} is used twice", group.rank));
		for (const std::string& word : words(node.attribute("flags").as_string())) {
			const auto it = std::find_if(std::begin(FLAG_NAMES), std::end(FLAG_NAMES),
			    [&word](const FlagName& f) { return word == f.name; });
			if (it == std::end(FLAG_NAMES)) {
				problem(fmt::format("group '{}' has unknown flag '{}'", group.name, word));
			} else {
				group.flags |= static_cast<uint32_t>(it->flag);
			}
		}
		loaded.push_back(std::move(group));
	}

	const auto guest = std::find_if(loaded.begin(), loaded.end(), [](const Group& g) { return g.rank == 0; });
	if (guest == loaded.end() || guest->id != 1) {
		problem("one group must have rank=\"0\" and id=\"1\": guests and new accounts are in it");
	}
	if (!ok) return false;

	std::sort(loaded.begin(), loaded.end(), [](const Group& a, const Group& b) { return a.rank < b.rank; });
	groups = std::move(loaded);
	reportDataFile("groups.xml", fmt::format("{} groups", groups.size()));
	return true;
}

const Group* Groups::get(uint8_t id) const
{
	for (const Group& group : groups) {
		if (group.id == id) return &group;
	}
	return nullptr;
}

const Group& Groups::getOrDefault(uint8_t id) const
{
	const Group* group = get(id);
	return group ? *group : defaultGroup();
}

const Group* Groups::find(std::string_view nameOrId) const
{
	uint8_t id = 0;
	if (parseByte(nameOrId, id)) return get(id);
	for (const Group& group : groups) {
		if (sameIgnoringCase(group.name, nameOrId)) return &group;
	}
	return nullptr;
}

bool CommandPermissions::loadFromXml(const std::string& file, const Groups& groups)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, file, "commands");
	if (!root) return false;

	std::unordered_map<std::string, uint8_t> loaded;
	const uint8_t top = groups.highest().rank;
	bool ok = true;
	const auto problem = [&ok](const std::string& message) {
		reportDataWarning("commands.xml", message);
		ok = false;
	};

	for (pugi::xml_node node = root.child("command"); node; node = node.next_sibling("command")) {
		const std::string name = node.attribute("name").as_string();
		uint8_t rank = 0;
		if (name.empty()) {
			problem("a <command> has no name");
			continue;
		}
		if (!parseByte(node.attribute("rank").as_string(), rank) || rank > top) {
			problem(fmt::format("!{} has rank=\"{}\"; ranks go up to {} (groups.xml)", name,
			    node.attribute("rank").as_string(), top));
			continue;
		}
		std::vector<std::string> names = words(node.attribute("aliases").as_string());
		names.insert(names.begin(), name);
		for (const std::string& each : names) {
			if (!loaded.emplace(each, rank).second) problem(fmt::format("!{} is listed twice", each));
		}
	}
	if (!ok) return false;

	ranks = std::move(loaded);
	unlistedRank = top;
	reportDataFile("commands.xml", fmt::format("{} commands and aliases", ranks.size()));
	return true;
}

uint8_t CommandPermissions::requiredRank(std::string_view command) const
{
	const auto it = ranks.find(std::string(command));
	return it == ranks.end() ? unlistedRank : it->second;
}
