// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/quests/quest_definition.h"
#include <boost/json.hpp>
#include <map>
#include <set>
#include <string>
#include <vector>

// rewards: what the outcome paid, in words (QuestSystem fills it in).
struct QuestStageRecord { std::string stage, outcome, next, rewards; };

// One character's progress on one quest. Counts are keyed by objective key so
// reordering objectives in the file never moves progress between them.
struct QuestProgress {
    QuestState state = QuestState::NotStarted;
    std::string stage, ending;
    std::map<std::string, uint32_t> counts;
    std::vector<QuestStageRecord> history;
    std::set<uint32_t> victims; // bounty: each victim counts once
    uint64_t started = 0, finished = 0;
    // Script variables (setVar): numbers or strings of 64 bytes or less, 16 at most.
    std::map<std::string, boost::json::value> vars;
};

// The stage state machine. Pure: no players, inventories or messages, so every
// rule here is covered by --selftest.
namespace quest_engine {
inline constexpr int MAX_ADVANCES_PER_EVENT = 8;

bool done(const QuestProgress& progress, const QuestObjective& objective);
// Not yet done, and its after= objective (if any) is done.
bool open(const QuestStage& stage, const QuestProgress& progress, const QuestObjective& objective);
bool ownerMatches(OwnerFilter filter, ObjectOwner owner);
// Type, subject and owner only; bounty victim rules need a Player and live in QuestSystem.
bool matches(const QuestObjective& objective, const GameEvent& event);
bool startMatches(const QuestEventStart& start, const GameEvent& event);
// Adds up to the objective's count; returns what was applied.
uint32_t add(QuestProgress& progress, const QuestObjective& objective, uint32_t amount);
// The first outcome, in file order, whose condition holds.
const QuestOutcome* choose(const QuestStage& stage, const QuestProgress& progress);
void enter(QuestProgress& progress, const QuestStage& stage);
void begin(QuestProgress& progress, const QuestDefinition& quest, uint64_t now);
// Call after the outcome's rewards were paid. Returns the stage entered, or
// nullptr when the quest ended (completed or failed).
const QuestStage* advance(QuestProgress& progress, const QuestDefinition& quest, const QuestStage& from,
                          const QuestOutcome& outcome, uint64_t now);
}
