// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/quests/quest_engine.h"

namespace {
bool eventFor(ObjectiveType objective, EventType& out)
{
    switch (objective) {
    case ObjectiveType::Kill: out = EventType::Kill; return true;
    case ObjectiveType::Bounty: out = EventType::Bounty; return true;
    case ObjectiveType::Craft: out = EventType::Craft; return true;
    case ObjectiveType::Gather: out = EventType::Gather; return true;
    case ObjectiveType::Destroy: out = EventType::Destroy; return true;
    case ObjectiveType::Build: out = EventType::Build; return true;
    case ObjectiveType::Pickup: out = EventType::Pickup; return true;
    case ObjectiveType::Use: out = EventType::Use; return true;
    case ObjectiveType::EnterArea: out = EventType::EnterArea; return true;
    case ObjectiveType::Talk: case ObjectiveType::Give: return false; // counted by QuestSystem::onTalk
    }
    return false;
}

std::string label(const QuestOutcome& outcome)
{
    if (outcome.when == OutcomeWhen::All) return "all";
    if (outcome.when == OutcomeWhen::Any) return "any";
    return outcome.objective;
}
}

bool quest_engine::done(const QuestProgress& p, const QuestObjective& o)
{
    const auto found = p.counts.find(o.key);
    return found != p.counts.end() && found->second >= o.count;
}

bool quest_engine::open(const QuestStage& s, const QuestProgress& p, const QuestObjective& o)
{
    if (done(p, o)) return false;
    if (o.after.empty()) return true;
    const QuestObjective* before = s.objective(o.after);
    return before && done(p, *before);
}

bool quest_engine::ownerMatches(OwnerFilter filter, ObjectOwner owner)
{
    switch (filter) {
    case OwnerFilter::Any: return true;
    case OwnerFilter::Self: return owner == ObjectOwner::Self;
    case OwnerFilter::Clan: return owner == ObjectOwner::Clan;
    case OwnerFilter::Other: return owner == ObjectOwner::Other;
    case OwnerFilter::None: return owner == ObjectOwner::None;
    }
    return false;
}

bool quest_engine::matches(const QuestObjective& o, const GameEvent& e)
{
    EventType wanted{};
    if (!eventFor(o.type, wanted) || wanted != e.type) return false;
    if (!o.target.empty()) {
        // target="@tag": an agent a quest script spawned with that tag.
        if (o.target.front() == '@') {
            if (std::string_view(o.target).substr(1) != e.tag) return false;
        } else if (o.target != e.subject) {
            return false;
        }
    }
    return ownerMatches(o.owner, e.owner);
}

bool quest_engine::startMatches(const QuestEventStart& s, const GameEvent& e)
{
    return s.type == e.type && (s.target.empty() || s.target == e.subject) && ownerMatches(s.owner, e.owner);
}

uint32_t quest_engine::add(QuestProgress& p, const QuestObjective& o, uint32_t amount)
{
    uint32_t& count = p.counts[o.key];
    const uint32_t room = o.count - std::min(count, o.count);
    const uint32_t applied = std::min(amount, room);
    count += applied;
    return applied;
}

const QuestOutcome* quest_engine::choose(const QuestStage& s, const QuestProgress& p)
{
    for (const auto& outcome : s.outcomes) {
        bool holds = false;
        if (outcome.when == OutcomeWhen::All) {
            holds = std::all_of(s.objectives.begin(), s.objectives.end(), [&](const auto& o) { return done(p, o); });
        } else if (outcome.when == OutcomeWhen::Any) {
            holds = std::any_of(s.objectives.begin(), s.objectives.end(), [&](const auto& o) { return done(p, o); });
        } else if (const QuestObjective* o = s.objective(outcome.objective)) {
            holds = done(p, *o);
        }
        if (holds) return &outcome;
    }
    return nullptr;
}

void quest_engine::enter(QuestProgress& p, const QuestStage& s)
{
    p.stage = s.key;
    p.counts.clear();
    for (const auto& o : s.objectives) p.counts[o.key] = 0;
}

void quest_engine::begin(QuestProgress& p, const QuestDefinition& d, uint64_t now)
{
    p = QuestProgress{};
    p.state = QuestState::Active;
    p.started = now;
    enter(p, d.stages.front());
}

const QuestStage* quest_engine::advance(QuestProgress& p, const QuestDefinition& d, const QuestStage& from,
                                        const QuestOutcome& outcome, uint64_t now)
{
    const std::string next = outcome.next == OutcomeNext::Fail ? "fail" :
                             outcome.next == OutcomeNext::Ending ? "end:" + outcome.target : outcome.target;
    p.history.push_back({from.key, label(outcome), next});
    if (outcome.next == OutcomeNext::Stage) {
        const QuestStage* stage = d.stage(outcome.target);
        if (stage) enter(p, *stage);
        return stage;
    }
    p.state = outcome.next == OutcomeNext::Ending ? QuestState::Completed : QuestState::Failed;
    p.ending = outcome.next == OutcomeNext::Ending ? outcome.target : "";
    p.stage.clear();
    p.counts.clear();
    p.finished = now;
    return nullptr;
}
