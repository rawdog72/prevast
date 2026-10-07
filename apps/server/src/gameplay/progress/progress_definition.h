// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/quests/quest_definition.h"
#include <cstdint>
#include <string>
#include <vector>

// data/XML/stats.xml and achievements.xml. Plain data: ids are what the
// account database stores, so they never change and are never reused (a
// definition that is no longer wanted is marked retired="true" instead).

enum class StatAggregate : uint8_t { Sum, Max };

// One <count> of a stat: which events add to it.
struct StatCount {
    EventType event = EventType::Kill;
    std::string target;  // the event's subject key, or '' for any
    std::string family;  // kill only: an agents.xml family, or ''
    OwnerFilter owner = OwnerFilter::Any;
};

struct StatDefinition {
    uint16_t id = 0;
    std::string key, name;
    bool isPublic = true, retired = false;
    // Max: the stat is a record for one life (the longest life, the most in a
    // life), kept as the best ever.
    StatAggregate aggregate = StatAggregate::Sum;
    std::vector<StatCount> counts;
};

struct AchievementRequirement {
    uint16_t stat = 0;
    uint64_t atLeast = 1;
};

struct AchievementDefinition {
    uint16_t id = 0;
    std::string key, name, description;
    uint8_t grade = 1, points = 0;
    bool secret = false, retired = false, announce = false;
    // All must hold. Empty: granted only by a quest outcome, a script or an admin.
    std::vector<AchievementRequirement> requirements;
    // Paid once, to the character that unlocks it.
    QuestRewards rewards;
};
