// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/progress/game_event.h"
#include "gameplay/scripts/lua_script.h"
#include "core/security_budget.h"
#include <boost/json.hpp>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <vector>

class Player;
struct QuestDefinition;

// What a hook asked for. Checked as a whole before anything is applied.
struct ScriptIntent {
    enum class Kind : uint8_t {
        Start, Advance, Complete, Fail, SetVar, GrantAchievement, AccountEvent,
        Say, Status, SpawnAgent, GiveItem, TakeItem, ApplyCondition, After,
    };
    Kind kind = Kind::Say;
    std::string key;    // quest / stage / ending / var / achievement / agent / item / condition / hook
    std::string quest;  // quest= for quest actions ('' = the calling quest)
    std::string text;   // say / status
    std::string tag;    // spawnAgent
    boost::json::value value; // setVar value, or the amount with add
    bool add = false;
    uint32_t count = 1, radius = 300, durationMs = 0, seconds = 0;
    float strength = 1.0f;
};

namespace script_intents {
inline constexpr size_t MAX_INTENTS = 16;
// A hook's result: nothing, or a list of one-verb tables. Throws naming the problem.
std::vector<ScriptIntent> parse(const boost::json::value& result);
}

// Quest scripts (<quest script=...>, data/quests/scripts) and trigger scripts
// (data/scripts/triggers/*.lua). Hooks run on the game thread; what they
// return is checked at once and applied on the next tick, so a script never
// changes game state in the middle of a quest update.
class ScriptSystem final : public EventListener {
public:
    static std::string questScriptDirectory();
    static std::string triggerDirectory();

    // Compiles every script the quests name, and every trigger script. Throws
    // (keeping the running scripts) when one does not compile.
    void load(const std::vector<QuestDefinition>& quests);
    void onGameEvent(const GameEvent& event) override;
    // A quest's own hook: onStart, onStageEnter, onStageComplete, onEnd.
    void questHook(Player* player, const std::string& quest, const char* hook, std::vector<boost::json::value> args);
    // The quest ended for this player: its spawned agents go, its timers stop.
    void questEnded(Player* player, const std::string& quest);
    void forget(uint32_t playerId);
    void update(uint32_t elapsedMs);
    // Actions from elsewhere (an NPC's onTalk), applied on the next tick like any hook's.
    void enqueue(Player* player, std::vector<ScriptIntent> intents, std::string source);
    size_t scriptCount() const { return questModules.size() + triggers.size(); }

private:
    struct Module {
        std::unique_ptr<LuaScript> script;
        std::string quest;                                    // '' for a trigger script
        std::vector<std::pair<EventType, std::string>> on;    // (event, subject or '')
        uint32_t failures = 0;
        bool disabled = false;
    };
    struct Pending {
        uint32_t playerId = 0;
        std::string quest, source;
        std::vector<ScriptIntent> intents;
    };
    struct Timer {
        uint32_t playerId = 0;
        std::string quest, trigger, hook;
        uint64_t dueMs = 0;
    };
    struct Spawned {
        uint32_t agentId = 0;
        std::string quest;
    };

    std::map<std::string, Module> questModules; // by quest key
    std::vector<Module> triggers;
    std::deque<Pending> pending;
    std::vector<Timer> timers;
    std::map<uint32_t, std::vector<Spawned>> spawned; // by player id
    std::map<uint32_t, ActionBudget> budgets;
    ActionBudget globalBudget;

    static Module compile(const std::string& path, const std::string& name, const std::string& quest);
    boost::json::value context(Player* player, const std::string& quest) const;
    static boost::json::value eventJson(const GameEvent& event);
    void run(Module& module, Player* player, const char* hook, std::vector<boost::json::value> args);
    bool check(const Pending& p, Player* player, std::string& problem) const;
    void apply(Pending& p);
    void spawnAgents(Player* player, const ScriptIntent& intent, const std::string& quest);
    void despawn(uint32_t playerId, const std::string& quest);
    size_t spawnedAlive() const;
};

extern ScriptSystem g_scripts;

int runScriptIntentSelfTest();
