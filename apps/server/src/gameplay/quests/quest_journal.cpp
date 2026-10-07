// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/quests/quest_journal.h"
#include <boost/json.hpp>

namespace {
boost::json::object currentStage(const QuestStage& stage, const QuestProgress& progress)
{
    boost::json::array objectives;
    for (const auto& o : stage.objectives) {
        const auto count = progress.counts.find(o.key);
        const uint32_t have = count == progress.counts.end() ? 0 : std::min(count->second, o.count);
        const bool locked = !o.after.empty() && !quest_engine::done(progress, *stage.objective(o.after));
        const bool itemBased = o.type == ObjectiveType::Give || o.type == ObjectiveType::Craft ||
                               o.type == ObjectiveType::Pickup || o.type == ObjectiveType::Use;
        objectives.push_back(boost::json::object{{"key", o.key}, {"text", o.text}, {"type", objectiveTypeName(o.type)},
            {"count", have}, {"required", o.count}, {"after", o.after}, {"locked", locked},
            {"item", itemBased ? o.target : std::string()}});
    }
    return boost::json::object{{"key", stage.key}, {"journal", stage.journal}, {"current", true}, {"outcome", ""},
        {"rewards", ""}, {"objectives", std::move(objectives)}};
}
}

std::string questJournalJson(const QuestDefinition& d, const QuestProgress& p, size_t maxBytes)
{
    const char* state = p.state == QuestState::Active ? "active" : p.state == QuestState::Completed ? "completed" : "failed";
    const QuestEnding* ending = p.state == QuestState::Completed ? d.ending(p.ending) : nullptr;
    const QuestStage* current = p.state == QuestState::Active ? d.stage(p.stage) : nullptr;
    for (size_t skip = 0;; ++skip) {
        boost::json::array stages;
        for (size_t i = skip; i < p.history.size(); ++i) {
            const auto& record = p.history[i];
            const QuestStage* stage = d.stage(record.stage);
            stages.push_back(boost::json::object{{"key", record.stage}, {"journal", stage ? stage->journal : ""},
                {"current", false}, {"outcome", record.outcome}, {"rewards", record.rewards},
                {"objectives", boost::json::array{}}});
        }
        if (current) stages.push_back(currentStage(*current, p));
        const boost::json::object entry{{"key", d.key}, {"name", d.name}, {"category", d.category},
            {"description", d.description}, {"abandon", d.abandon}, {"state", state}, {"stage", current ? current->key : ""},
            {"ending", ending ? ending->journal : ""}, {"stages", std::move(stages)}};
        std::string json = boost::json::serialize(entry);
        if (json.size() <= maxBytes || skip >= p.history.size()) return json;
    }
}
