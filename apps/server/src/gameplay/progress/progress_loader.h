// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/progress/progress_definition.h"
#include "gameplay/quests/quest_loader.h"
#include <pugixml.hpp>
#include <vector>

namespace progress_loader {
inline constexpr size_t MAX_STATS = 256, MAX_ACHIEVEMENTS = 512, MAX_COUNTS = 8, MAX_REQUIREMENTS = 4;

// <stats> root. Throws std::runtime_error naming the stat and the problem.
std::vector<StatDefinition> parseStats(pugi::xml_node root, const QuestRefs& refs);
// <achievements> root; requirements name stats by key.
std::vector<AchievementDefinition> parseAchievements(pugi::xml_node root, const std::vector<StatDefinition>& stats,
                                                     const QuestRefs& refs);
}
