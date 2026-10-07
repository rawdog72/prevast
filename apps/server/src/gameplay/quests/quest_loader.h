// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/quests/quest_definition.h"
#include <filesystem>
#include <functional>
#include <pugixml.hpp>

// What a quest may name. Injected so the loader runs in --selftest without the
// item, agent, object, resource and NPC managers.
struct QuestRefs {
    std::function<uint16_t(const std::string&)> item; // item id, 0 when unknown
    std::function<bool(uint16_t)> currency;           // bottle caps, banknotes, gold bars
    std::function<bool(const std::string&)> agent, object, resource, npc;
    // Optional: an agents.xml family, an achievements.xml key, a stats.xml key,
    // a structures.xml template.
    std::function<bool(const std::string&)> family, achievement, stat, structure;
};

namespace quest_loader {
inline constexpr size_t MAX_QUESTS = 64, MAX_STAGES = 32, MAX_OBJECTIVES = 8, MAX_REWARD_ITEMS = 8;

std::string normalizeKeyword(std::string value);
// One <reward caps=.../> or <reward item=... count=.../>, added to `into`.
// `owner` names the quest or achievement in error messages.
void parseReward(pugi::xml_node reward, const QuestRefs& refs, const std::string& owner, QuestRewards& into);
// Checks that an event's subject names something of the right kind for it.
void checkEventSubject(EventType type, const std::string& target, const QuestRefs& refs, const std::string& owner,
                       const std::string& where);
bool reservedKeyword(const std::string& keyword);
// One <quest> element. Throws std::runtime_error naming the quest and the problem.
QuestDefinition parse(pugi::xml_node node, const QuestRefs& refs);
// Rules that span quests: count, unique keys, (npc, keyword) ownership, prerequisites.
void validateSet(const std::vector<QuestDefinition>& quests);
// Every *.xml directly in `directory`, sorted by file name. Throws with the file name.
std::vector<QuestDefinition> loadDirectory(const std::filesystem::path& directory, const QuestRefs& refs);
}
