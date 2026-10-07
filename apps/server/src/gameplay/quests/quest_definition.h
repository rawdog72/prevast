// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/economy.h"
#include "gameplay/progress/game_event.h"
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

// One quest as written in data/quests/<key>.xml. Plain data: the loader fills
// it, the engine walks it, nothing here knows about players.

enum class ObjectiveType : uint8_t { Kill, Bounty, Craft, Gather, Destroy, Build, Pickup, Use, Talk, Give, EnterArea };
enum class OwnerFilter : uint8_t { Any, Self, Clan, Other, None };
enum class QuestState : uint8_t { NotStarted = 0, Active = 1, Completed = 2, Failed = 3 };
enum class OutcomeWhen : uint8_t { Objective, All, Any };
enum class OutcomeNext : uint8_t { Stage, Ending, Fail };

inline const char* objectiveTypeName(ObjectiveType type)
{
    constexpr const char* names[] = {"kill", "bounty", "craft", "gather", "destroy", "build", "pickup", "use", "talk", "give", "enter_area"};
    return names[static_cast<size_t>(type)];
}

struct QuestRewards {
    economy::Money caps = 0;
    std::vector<std::pair<uint16_t, uint32_t>> items; // iid, count
    bool empty() const { return caps == 0 && items.empty(); }
};

struct QuestObjective {
    std::string key, text;
    ObjectiveType type = ObjectiveType::Kill;
    std::string target;              // agent/object/resource key, or item key for craft/pickup/use/give
    uint16_t iid = 0;                // craft/pickup/use/give
    std::string npc, keyword, reply; // talk/give
    std::string after;               // objective key in the same stage
    uint32_t count = 1;
    uint32_t minVictimKarma = 4;          // bounty
    OwnerFilter owner = OwnerFilter::Any; // destroy/build
};

struct QuestOutcome {
    OutcomeWhen when = OutcomeWhen::All;
    std::string objective; // when == Objective
    OutcomeNext next = OutcomeNext::Ending;
    std::string target;    // stage or ending key
    QuestRewards rewards;
    std::string achievement; // granted with the rewards (achievements.xml key), or ''
};

struct QuestStage {
    std::string key, journal;
    bool loop = false;
    std::vector<QuestObjective> objectives;
    std::vector<QuestOutcome> outcomes;
    const QuestObjective* objective(std::string_view k) const
    {
        for (const auto& o : objectives) if (o.key == k) return &o;
        return nullptr;
    }
};

struct QuestEnding { std::string key, journal; };

// <area>: a place a quest can send the player. The live world is generated
// again on every restart, so an area is best tied to something that exists
// in every world: any placed copy of a structure, or an NPC's spawn spot.
struct QuestArea {
    enum class Kind : uint8_t { Structure, Npc, Point };
    std::string key, id; // id = "<quest>.<key>", the EnterArea/LeaveArea subject
    Kind kind = Kind::Point;
    std::string structure, npc;
    int32_t x = 0, y = 0;
    uint32_t radius = 0; // Npc and Point; world units
};
struct QuestTalkStart { std::string npc, keyword, text; bool confirm = false; };
struct QuestEventStart { EventType type = EventType::Kill; std::string target; uint32_t count = 1; OwnerFilter owner = OwnerFilter::Any; };
struct QuestUseStart { std::string item; };
struct QuestRequirement {
    std::string quest;
    QuestState state = QuestState::Completed;
    uint8_t karmaMin = 0, karmaMax = 5;
    std::string achievement;   // the account has unlocked it
    std::string stat;          // the account's stat is at least atLeast
    uint64_t atLeast = 0;
};
struct QuestDialogueReply { std::string npc, keyword, text, stage; std::optional<QuestState> state; };

struct QuestDefinition {
    std::string key, name, category = "side", description;
    std::string script; // data/quests/scripts/<script>, or 
    bool hidden = false, abandon = true, repeatable = false;
    uint32_t cooldownSeconds = 0;
    std::vector<QuestTalkStart> talkStarts;
    std::vector<QuestEventStart> eventStarts;
    std::vector<QuestUseStart> useStarts;
    std::vector<QuestRequirement> requirements;
    std::vector<QuestStage> stages; // stages.front() is the entry stage
    std::vector<QuestEnding> endings;
    std::vector<QuestDialogueReply> dialogue;
    std::vector<QuestArea> areas;

    const QuestStage* stage(std::string_view k) const
    {
        for (const auto& s : stages) if (s.key == k) return &s;
        return nullptr;
    }
    const QuestEnding* ending(std::string_view k) const
    {
        for (const auto& e : endings) if (e.key == k) return &e;
        return nullptr;
    }
};
