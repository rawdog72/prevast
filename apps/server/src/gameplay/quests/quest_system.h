// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/progress/game_event.h"
#include "gameplay/quests/quest_engine.h"
#include <boost/json.hpp>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

class Player;

class QuestSystem final : public EventListener {
public:
    // data/quests next to data/XML.
    static std::string directory();
    // Loads and validates every quest. On failure the running definitions and
    // all progress are untouched and false is returned.
    bool load(const std::string& directory);
    void onGameEvent(const GameEvent& event) override;

    struct TalkResult {
        bool handled = false;
        std::string reply;
    };
    // NpcSystem calls this for any word its built-ins did not claim. `allowed`
    // is the NPC's karma rule; when false a matching quest line answers
    // `deniedReply` instead.
    TalkResult onTalk(Player* player, const std::string& npcKey, const std::string& keyword, bool allowed,
                      const std::string& deniedReply);
    // The reply to "quests" at an NPC.
    std::string offersAt(const Player* player, const std::string& npcKey) const;
    // Everything the client should know, from scratch: a reset, every visible
    // quest and the NPC markers. At login, on reconnect and after a reload.
    void sync(Player* player);
    // QUEST_ACTION from the client.
    void action(Player* player, uint16_t questId, uint8_t action);
    // Game tick: sends NPC markers that changed.
    void update(uint32_t elapsedMs);
    // quest key -> QuestState as an int, for NPC Lua's context.quests.
    std::map<std::string, int> states(const Player* player) const;
    // Every NPC a loaded quest names, with the quest, so an NPC reload can refuse
    // to drop one.
    std::vector<std::pair<std::string, std::string>> npcReferences() const;
    void forget(uint32_t playerId);
    // !quest=<action>:<guid>:<quest>[:<stage or ending>]
    std::string admin(Player* target, const std::string& action, const std::string& quest, const std::string& argument);
    size_t size() const { return quests.size(); }
    const QuestDefinition* definition(const std::string& key) const { return find(key); }

    // ---- Lua scripts (ScriptSystem) ----
    // What a hook may read: quest states, and this quest's stage, counts and vars.
    boost::json::object scriptContext(const Player* player, const std::string& questKey) const;
    std::vector<std::string> activeQuests(const Player* player) const;
    // Actions a script's intents turn into. False when the quest is not in a
    // state that allows it (not startable, not active); nothing changes then.
    bool scriptStart(Player* player, const std::string& quest);
    bool scriptStage(Player* player, const std::string& quest, const std::string& stage);
    // ending '' fails the quest.
    bool scriptEnd(Player* player, const std::string& quest, const std::string& ending);
    bool scriptVar(Player* player, const std::string& quest, const std::string& name, const boost::json::value& value, bool add);

private:
    struct PlayerQuests {
        std::map<std::string, QuestProgress> quests;
        std::map<std::string, uint32_t> startCounters;
        std::string offerNpc, offerQuest; // a confirm="true" offer awaiting yes/no
        std::string sentMarkers;          // the last QUEST_MARKERS payload, to send only changes
        uint64_t lastAction = 0;          // QUEST_ACTION rate limit
    };
    std::vector<QuestDefinition> quests;
    std::map<std::string, size_t> index;
    std::map<uint32_t, PlayerQuests> players;
    std::set<uint32_t> dirtyMarkers;
    uint32_t markerSweepMs = 0;
    // Quest areas each player is standing in, by "<quest>.<area>" id.
    std::map<uint32_t, std::set<std::string>> insideAreas;
    uint32_t areaSweepMs = 0;
    void checkAreas();

    const QuestDefinition* find(const std::string& key) const;
    static QuestState stateOf(const PlayerQuests& pq, const std::string& key);
    bool canStart(const Player* player, const PlayerQuests& pq, const QuestDefinition& quest) const;
    void start(Player* player, PlayerQuests& pq, const QuestDefinition& quest, const GameEvent* trigger);
    bool progressEvent(Player* player, QuestProgress& progress, const QuestDefinition& quest, const GameEvent& event);
    void settle(Player* player, const QuestDefinition& quest, QuestProgress& progress);
    bool pay(Player* player, const QuestRewards& rewards);
    void remap(const std::vector<QuestDefinition>& next);
    void sendState(Player* player, const QuestDefinition& quest, const QuestProgress* progress, uint8_t cause);
    void sendProgress(Player* player, const QuestDefinition& quest, const QuestProgress& progress);
    void sendMarkers(Player* player, PlayerQuests& pq, bool force);
    std::string markers(const Player* player, const PlayerQuests& pq) const;
};

extern QuestSystem g_quests;
