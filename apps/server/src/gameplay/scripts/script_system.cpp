// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/scripts/script_system.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/progress/account_runs.h"
#include "gameplay/agent.h"
#include "gameplay/condition.h"
#include "gameplay/game.h"
#include "gameplay/npc.h"
#include "gameplay/player.h"
#include "core/tools.h"
#include "network/opcodes.h"
#include "network/protocolgame.h"
#include <filesystem>
#include <fstream>

extern Game g_game;
ScriptSystem g_scripts;

// `ss` prefixes: unity builds merge .cpp files, and file-local names collide.
namespace ssjson = boost::json;
namespace fs = std::filesystem;

namespace {
constexpr size_t SS_MAX_SCRIPT_BYTES = 64 * 1024;
constexpr size_t SS_MAX_TRIGGERS = 64;
constexpr uint32_t SS_MAX_SPAWN_PER_INTENT = 5, SS_MAX_SPAWNED_PER_PLAYER = 10, SS_MAX_SPAWNED = 200;
constexpr uint32_t SS_MAX_RADIUS = 1000, SS_MAX_TIMERS_PER_PLAYER = 4, SS_MAX_TIMER_S = 3600;
constexpr uint32_t SS_FAILURES_TO_DISABLE = 3;

uint64_t ssNow() { return static_cast<uint64_t>(OTSYS_TIME()); }

std::string ssDataDirectory()
{
    return fs::path(contentFile("content.xml")).parent_path().parent_path().string();
}

std::string ssString(const ssjson::object& o, const char* field, size_t max, bool required)
{
    const auto* v = o.if_contains(field);
    if (!v) {
        if (required) throw std::runtime_error(std::string("needs ") + field + "=");
        return {};
    }
    if (!v->is_string()) throw std::runtime_error(std::string(field) + "= must be text");
    const auto& s = v->get_string();
    if (s.empty() || s.size() > max) throw std::runtime_error(std::string(field) + "= must be 1.." + std::to_string(max) + " characters");
    return std::string(s);
}

uint32_t ssNumber(const ssjson::object& o, const char* field, uint32_t fallback, uint32_t min, uint32_t max)
{
    const auto* v = o.if_contains(field);
    if (!v) return fallback;
    if (!v->is_number()) throw std::runtime_error(std::string(field) + "= must be a number");
    const double d = v->to_number<double>();
    if (d < min || d > max || d != std::floor(d)) throw std::runtime_error(std::string(field) + "= must be a whole number " + std::to_string(min) + ".." + std::to_string(max));
    return static_cast<uint32_t>(d);
}
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

std::vector<ScriptIntent> script_intents::parse(const ssjson::value& result)
{
    std::vector<ScriptIntent> out;
    if (result.is_null()) return out;
    if (!result.is_array()) throw std::runtime_error("a hook returns nothing or a list of actions, e.g. { { start = \"quest\" } }");
    const auto& list = result.get_array();
    if (list.size() > MAX_INTENTS) throw std::runtime_error("at most 16 actions per call");
    for (size_t i = 0; i < list.size(); ++i) {
        try {
            if (!list[i].is_object()) throw std::runtime_error("must be a table");
            const auto& o = list[i].get_object();
            ScriptIntent in;
            in.quest = o.contains("quest") ? ssString(o, "quest", 48, true) : std::string();
            using K = ScriptIntent::Kind;
            if (o.contains("start")) { in.kind = K::Start; in.key = ssString(o, "start", 48, true); }
            else if (o.contains("advance")) { in.kind = K::Advance; in.key = ssString(o, "advance", 48, true); }
            else if (o.contains("complete")) { in.kind = K::Complete; in.key = ssString(o, "complete", 48, true); }
            else if (o.contains("fail")) { in.kind = K::Fail; }
            else if (o.contains("setVar")) {
                in.kind = K::SetVar;
                in.key = ssString(o, "setVar", 32, true);
                if (const auto* add = o.if_contains("add")) {
                    if (!add->is_number()) throw std::runtime_error("add= must be a number");
                    in.add = true;
                    in.value = add->to_number<double>();
                } else if (const auto* value = o.if_contains("value")) {
                    if (value->is_string() && value->get_string().size() > 64) throw std::runtime_error("value= text is 64 bytes at most");
                    if (!value->is_string() && !value->is_number() && !value->is_bool()) throw std::runtime_error("value= must be a number, text or boolean");
                    in.value = *value;
                } else {
                    throw std::runtime_error("setVar needs value= or add=");
                }
            }
            else if (o.contains("grantAchievement")) { in.kind = K::GrantAchievement; in.key = ssString(o, "grantAchievement", 48, true); }
            else if (o.contains("accountEvent")) {
                in.kind = K::AccountEvent;
                in.key = ssString(o, "accountEvent", 64, true);
                in.text = ssString(o, "occurrence", 96, true);
                const auto valid = [](const std::string& value) {
                    return value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:._-") == std::string::npos;
                };
                if (!valid(in.key) || in.key.find(':') != std::string::npos || !valid(in.text))
                    throw std::runtime_error("accountEvent and occurrence need stable alphanumeric keys");
            }
            else if (o.contains("say")) { in.kind = K::Say; in.text = ssString(o, "say", 256, true); }
            else if (o.contains("status")) { in.kind = K::Status; in.text = ssString(o, "status", 256, true); }
            else if (o.contains("spawnAgent")) {
                in.kind = K::SpawnAgent;
                in.key = ssString(o, "spawnAgent", 48, true);
                in.count = ssNumber(o, "count", 1, 1, SS_MAX_SPAWN_PER_INTENT);
                in.radius = ssNumber(o, "radius", 300, 50, SS_MAX_RADIUS);
                in.tag = o.contains("tag") ? ssString(o, "tag", 32, true) : std::string();
            }
            else if (o.contains("giveItem")) { in.kind = K::GiveItem; in.key = ssString(o, "giveItem", 48, true); in.count = ssNumber(o, "count", 1, 1, 4096); }
            else if (o.contains("takeItem")) { in.kind = K::TakeItem; in.key = ssString(o, "takeItem", 48, true); in.count = ssNumber(o, "count", 1, 1, 4096); }
            else if (o.contains("applyCondition")) {
                in.kind = K::ApplyCondition;
                in.key = ssString(o, "applyCondition", 48, true);
                in.durationMs = ssNumber(o, "durationMs", 0, 0, 3600000);
                if (const auto* s = o.if_contains("strength")) {
                    if (!s->is_number() || s->to_number<double>() <= 0 || s->to_number<double>() > 5) throw std::runtime_error("strength= must be above 0 and at most 5");
                    in.strength = static_cast<float>(s->to_number<double>());
                }
            }
            else if (o.contains("after")) {
                in.kind = K::After;
                const auto& after = o.at("after");
                if (!after.is_object()) throw std::runtime_error("after= must be { seconds = n, hook = \"name\" }");
                in.seconds = ssNumber(after.get_object(), "seconds", 0, 1, SS_MAX_TIMER_S);
                in.key = ssString(after.get_object(), "hook", 32, true);
            }
            else throw std::runtime_error("has no known action (start, advance, complete, fail, setVar, grantAchievement, accountEvent, say, status, spawnAgent, giveItem, takeItem, applyCondition, after)");
            out.push_back(std::move(in));
        } catch (const std::exception& e) {
            throw std::runtime_error("action " + std::to_string(i + 1) + ": " + e.what());
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

std::string ScriptSystem::questScriptDirectory() { return (fs::path(ssDataDirectory()) / "quests" / "scripts").string(); }
std::string ScriptSystem::triggerDirectory() { return (fs::path(ssDataDirectory()) / "scripts" / "triggers").string(); }

ScriptSystem::Module ScriptSystem::compile(const std::string& path, const std::string& name, const std::string& quest)
{
    if (!fs::is_regular_file(path)) throw std::runtime_error(name + ": file not found");
    if (fs::file_size(path) > SS_MAX_SCRIPT_BYTES) throw std::runtime_error(name + ": larger than 64 KiB");
    std::ifstream in(path, std::ios::binary);
    std::stringstream source;
    source << in.rdbuf();
    Module m;
    m.quest = quest;
    m.script = std::make_unique<LuaScript>(name);
    m.script->load(source.str());
    for (const std::string& s : m.script->subscriptions()) {
        const auto colon = s.find(':');
        EventType type{};
        if (!parseEventType(s.substr(0, colon), type)) throw std::runtime_error(name + ": `on` names unknown event '" + s + "'");
        m.on.emplace_back(type, colon == std::string::npos ? std::string() : s.substr(colon + 1));
    }
    if (!m.on.empty() && !m.script->has("onEvent")) throw std::runtime_error(name + ": `on` lists events but there is no onEvent");
    return m;
}

void ScriptSystem::load(const std::vector<QuestDefinition>& quests)
{
    std::map<std::string, Module> nextQuests;
    std::vector<Module> nextTriggers;
    for (const auto& d : quests) {
        if (d.script.empty()) continue;
        nextQuests.emplace(d.key, compile((fs::path(questScriptDirectory()) / d.script).string(), "quests/scripts/" + d.script, d.key));
    }
    if (fs::is_directory(triggerDirectory())) {
        std::vector<fs::path> files;
        for (const auto& entry : fs::directory_iterator(triggerDirectory()))
            if (entry.is_regular_file() && entry.path().extension() == ".lua") files.push_back(entry.path());
        std::sort(files.begin(), files.end());
        if (files.size() > SS_MAX_TRIGGERS) throw std::runtime_error("at most 64 trigger scripts");
        for (const auto& file : files) {
            Module m = compile(file.string(), "scripts/triggers/" + file.filename().string(), "");
            if (!m.script->has("onEvent")) throw std::runtime_error("scripts/triggers/" + file.filename().string() + ": a trigger script needs onEvent");
            nextTriggers.push_back(std::move(m));
        }
    }
    questModules = std::move(nextQuests);
    triggers = std::move(nextTriggers);
    pending.clear();
    timers.clear();
    if (!questModules.empty() || !triggers.empty())
        fmt::print(">> Scripts: {} quest script(s), {} trigger script(s)\n", questModules.size(), triggers.size());
}

// ---------------------------------------------------------------------------
// Running hooks
// ---------------------------------------------------------------------------

ssjson::value ScriptSystem::context(Player* p, const std::string& quest) const
{
    ssjson::object ctx = g_quests.scriptContext(p, quest);
    const Position& pos = p->getPosition();
    ctx["player"] = ssjson::object{{"id", p->getID()}, {"name", p->getName()}, {"karma", p->getKarmaLevel()},
        {"health", p->getHealth()}, {"x", pos.x}, {"y", pos.y}, {"verified", p->getAccountId() != 0}};
    // Account progress, when loaded: stats by key, unlocked achievements by key.
    ssjson::object stats, achievements;
    bool loaded = false;
    if (const auto snapshot = g_progress.scriptView(p)) {
        loaded = true;
        stats = snapshot->first;
        achievements = snapshot->second;
    }
    ctx["account"] = ssjson::object{{"loaded", loaded}, {"stats", std::move(stats)}, {"achievements", std::move(achievements)}};
    return ctx;
}

ssjson::value ScriptSystem::eventJson(const GameEvent& e)
{
    const char* owners[] = {"none", "self", "clan", "other"};
    ssjson::object o{{"type", eventTypeName(e.type)}, {"subject", std::string(e.subject)}, {"count", e.count},
        {"owner", owners[static_cast<size_t>(e.owner)]}, {"tag", std::string(e.tag)}};
    if (e.actor) {
        o["x"] = e.actor->getPosition().x;
        o["y"] = e.actor->getPosition().y;
    }
    return o;
}

void ScriptSystem::run(Module& m, Player* p, const char* hook, std::vector<ssjson::value> args)
{
    if (m.disabled || !p || !m.script->has(hook)) return;
    const std::string& name = m.script->name();
    // Budgets: 20 calls/s per player, 500/s for the whole server. A skipped
    // call loses only the script's reaction; the event itself was counted.
    if (!budgets[p->getID()].consume(20, 40) || !globalBudget.consume(500, 500)) {
        static uint64_t lastWarning = 0;
        if (ssNow() > lastWarning + 60000) {
            lastWarning = ssNow();
            fmt::print(">> [Warning] script calls over budget; skipped {} {}\n", name, hook);
        }
        return;
    }
    args.insert(args.begin(), context(p, m.quest));
    try {
        std::vector<ScriptIntent> intents = script_intents::parse(m.script->call(hook, args));
        m.failures = 0;
        if (!intents.empty()) pending.push_back({p->getID(), m.quest, name + " " + hook, std::move(intents)});
    } catch (const std::exception& e) {
        fmt::print(">> [Warning] script error: {}\n", e.what());
        if (++m.failures >= SS_FAILURES_TO_DISABLE) {
            m.disabled = true;
            fmt::print(">> [Warning] {} failed {} times in a row and is off until the next reload\n", name, m.failures);
        }
    }
}

void ScriptSystem::onGameEvent(const GameEvent& e)
{
    Player* p = e.actor;
    if (!p || (triggers.empty() && questModules.empty())) return;
    const auto wants = [&](const Module& m) {
        for (const auto& [type, subject] : m.on)
            if (type == e.type && (subject.empty() || subject == e.subject)) return true;
        return false;
    };
    for (auto& m : triggers)
        if (wants(m)) run(m, p, "onEvent", {eventJson(e)});
    if (questModules.empty()) return;
    for (const std::string& quest : g_quests.activeQuests(p)) {
        const auto found = questModules.find(quest);
        if (found != questModules.end() && wants(found->second)) run(found->second, p, "onEvent", {eventJson(e)});
    }
}

void ScriptSystem::enqueue(Player* p, std::vector<ScriptIntent> intents, std::string source)
{
    if (p && !intents.empty()) pending.push_back({p->getID(), "", std::move(source), std::move(intents)});
}

void ScriptSystem::questHook(Player* p, const std::string& quest, const char* hook, std::vector<ssjson::value> args)
{
    const auto found = questModules.find(quest);
    if (found != questModules.end()) run(found->second, p, hook, std::move(args));
}

// ---------------------------------------------------------------------------
// Applying intents (next tick)
// ---------------------------------------------------------------------------

bool ScriptSystem::check(const Pending& pd, Player* p, std::string& problem) const
{
    using K = ScriptIntent::Kind;
    uint32_t spawning = 0, timersAdded = 0;
    for (const auto& in : pd.intents) {
        const std::string quest = in.quest.empty() ? pd.quest : in.quest;
        const QuestDefinition* d = quest.empty() ? nullptr : g_quests.definition(quest);
        switch (in.kind) {
        case K::Start:
            if (!g_quests.definition(in.key)) { problem = "start names unknown quest '" + in.key + "'"; return false; }
            break;
        case K::Advance:
            if (!d || !d->stage(in.key)) { problem = "advance names unknown stage '" + in.key + "' of quest '" + quest + "'"; return false; }
            break;
        case K::Complete:
            if (!d || !d->ending(in.key)) { problem = "complete names unknown ending '" + in.key + "' of quest '" + quest + "'"; return false; }
            break;
        case K::Fail: case K::SetVar:
            if (!d) { problem = "a quest action from a trigger script needs quest="; return false; }
            break;
        case K::GrantAchievement:
            if (!g_progress.achievement(in.key)) { problem = "unknown achievement '" + in.key + "'"; return false; }
            break;
        case K::AccountEvent:
            if (!g_accountRuns.hasEventReward(in.key)) { problem = "unknown account event '" + in.key + "'"; return false; }
            break;
        case K::SpawnAgent:
            if (!g_agents.getAgentData(in.key)) { problem = "unknown agent '" + in.key + "'"; return false; }
            spawning += in.count;
            break;
        case K::GiveItem: case K::TakeItem: {
            const ItemData* item = ItemManager::getInstance().getItemData(in.key);
            if (!item || item->currencyValue) { problem = "unknown (or currency) item '" + in.key + "'"; return false; }
            if (in.kind == K::TakeItem && g_npcs.takeable(p, item->id) < in.count) { problem = "takeItem: the player does not carry " + std::to_string(in.count) + " " + in.key; return false; }
            break;
        }
        case K::ApplyCondition:
            if (!ConditionManager::getInstance().getEffectData(in.key)) { problem = "unknown condition '" + in.key + "'"; return false; }
            break;
        case K::After:
            ++timersAdded;
            if (pd.quest.empty() && triggers.end() == std::find_if(triggers.begin(), triggers.end(), [&](const Module& m) { return pd.source.rfind(m.script->name(), 0) == 0; })) {
                problem = "after= from an unknown script"; return false;
            }
            break;
        case K::Say: case K::Status: break;
        }
    }
    const auto mine = spawned.find(pd.playerId);
    const size_t alive = mine == spawned.end() ? 0 : mine->second.size();
    if (spawning && (alive + spawning > SS_MAX_SPAWNED_PER_PLAYER || spawnedAlive() + spawning > SS_MAX_SPAWNED)) {
        problem = "spawnAgent: at most 10 script agents per player and 200 on the server"; return false;
    }
    const size_t waiting = std::count_if(timers.begin(), timers.end(), [&](const Timer& t) { return t.playerId == pd.playerId; });
    if (waiting + timersAdded > SS_MAX_TIMERS_PER_PLAYER) { problem = "after=: at most 4 waiting per player"; return false; }
    return true;
}

void ScriptSystem::apply(Pending& pd)
{
    Player* p = g_game.getPlayerByID(pd.playerId);
    if (!p || p->getHealth() == 0) return;
    std::string problem;
    if (!check(pd, p, problem)) {
        fmt::print(">> [Warning] {}: nothing applied, {}\n", pd.source, problem);
        return;
    }
    using K = ScriptIntent::Kind;
    for (const auto& in : pd.intents) {
        const std::string quest = in.quest.empty() ? pd.quest : in.quest;
        switch (in.kind) {
        case K::Start: g_quests.scriptStart(p, in.key); break;
        case K::Advance: g_quests.scriptStage(p, quest, in.key); break;
        case K::Complete: g_quests.scriptEnd(p, quest, in.key); break;
        case K::Fail: g_quests.scriptEnd(p, quest, ""); break;
        case K::SetVar: g_quests.scriptVar(p, quest, in.key, in.value, in.add); break;
        case K::GrantAchievement: g_progress.grant(p, in.key); break;
        case K::AccountEvent: g_accountRuns.eventReward(p, in.key, in.text); break;
        case K::Say:
            if (auto client = p->getProtocolGame()) client->sendChatChannel(ChatChannel::LOCAL, CHAT_SYSTEM_PID, 0, 0, in.text);
            break;
        case K::Status: g_game.sendStatus(p, in.text, StatusKind::INFO); break;
        case K::SpawnAgent: spawnAgents(p, in, quest); break;
        case K::GiveItem: {
            const ItemData* item = ItemManager::getInstance().getItemData(in.key);
            Inventory::ExchangePlan exchange;
            if (g_npcs.planExchange(p, 0, {}, {{item->id, in.count}}, exchange)) {
                p->inventory.commitExchange(std::move(exchange));
            } else {
                std::vector<Game::LootDrop> drops;
                for (uint32_t left = in.count; left;) {
                    const auto n = static_cast<uint8_t>(std::min<uint32_t>(left, std::max<uint32_t>(1, std::min<uint32_t>(item->stack, 255))));
                    drops.push_back({ item->lootId, item->id, n, ItemState::fresh(item->id) });
                    left -= n;
                }
                g_game.dropLootBurst(p->getPosition(), drops);
            }
            break;
        }
        case K::TakeItem: {
            const ItemData* item = ItemManager::getInstance().getItemData(in.key);
            Inventory::ExchangePlan exchange;
            if (g_npcs.planExchange(p, 0, {{item->id, in.count}}, {}, exchange)) p->inventory.commitExchange(std::move(exchange));
            break;
        }
        case K::ApplyCondition: p->addCondition(in.key, 0, in.durationMs, in.strength); break;
        case K::After: {
            Timer t;
            t.playerId = pd.playerId;
            t.quest = pd.quest;
            if (pd.quest.empty()) t.trigger = pd.source.substr(0, pd.source.find(' '));
            t.hook = in.key;
            t.dueMs = ssNow() + uint64_t(in.seconds) * 1000;
            timers.push_back(std::move(t));
            break;
        }
        }
    }
}

void ScriptSystem::spawnAgents(Player* p, const ScriptIntent& in, const std::string& quest)
{
    const Position& at = p->getPosition();
    for (uint32_t i = 0; i < in.count; ++i) {
        Position pos = at;
        bool found = false;
        for (int attempt = 0; attempt < 8 && !found; ++attempt) {
            const double angle = (rand() % 6283) / 1000.0;
            const double distance = in.radius * (0.5 + (rand() % 500) / 1000.0);
            pos = g_game.clampPositionToMap(static_cast<int32_t>(at.x + std::cos(angle) * distance),
                                            static_cast<int32_t>(at.y + std::sin(angle) * distance));
            found = g_game.isSpawnPositionValid(pos, nullptr);
        }
        if (!found) continue;
        Agent* agent = g_agents.createAgent(in.key, pos, 0);
        if (!agent) continue;
        agent->questTag = in.tag;
        agent->questKey = quest;
        agent->questOwner = p->getID();
        if (!g_game.placeThing(agent, pos)) {
            delete agent;
            continue;
        }
        spawned[p->getID()].push_back({agent->getID(), quest});
    }
}

size_t ScriptSystem::spawnedAlive() const
{
    size_t n = 0;
    for (const auto& [playerId, list] : spawned) n += list.size();
    return n;
}

// Quest agents go quietly: no loot, no explosion, no kill.
void ScriptSystem::despawn(uint32_t playerId, const std::string& quest)
{
    const auto found = spawned.find(playerId);
    if (found == spawned.end()) return;
    auto& list = found->second;
    for (auto it = list.begin(); it != list.end();) {
        if (!quest.empty() && it->quest != quest) {
            ++it;
            continue;
        }
        if (Thing* thing = g_game.map.getThingByID(it->agentId)) {
            if (Agent* agent = thing->getAgent(); agent && agent->questOwner == playerId && agent->getHealth() > 0) {
                EntityUpdate removal;
                agent->buildRemoval(removal);
                g_game.broadcastSurgicalUpdate(removal, agent->getPosition());
                g_game.map.removeThing(agent);
            }
        }
        it = list.erase(it);
    }
    if (list.empty()) spawned.erase(found);
}

void ScriptSystem::questEnded(Player* p, const std::string& quest)
{
    if (!p) return;
    despawn(p->getID(), quest);
    timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer& t) { return t.playerId == p->getID() && t.quest == quest; }), timers.end());
}

void ScriptSystem::forget(uint32_t playerId)
{
    despawn(playerId, "");
    timers.erase(std::remove_if(timers.begin(), timers.end(), [&](const Timer& t) { return t.playerId == playerId; }), timers.end());
    budgets.erase(playerId);
}

void ScriptSystem::update(uint32_t)
{
    // Timers first: their hooks' results join this tick's pending work.
    if (!timers.empty()) {
        const uint64_t now = ssNow();
        std::vector<Timer> due;
        for (auto it = timers.begin(); it != timers.end();) {
            if (it->dueMs <= now) {
                due.push_back(std::move(*it));
                it = timers.erase(it);
            } else {
                ++it;
            }
        }
        for (const Timer& t : due) {
            Player* p = g_game.getPlayerByID(t.playerId);
            if (!p || p->getHealth() == 0) continue;
            if (!t.quest.empty()) {
                const auto active = g_quests.activeQuests(p);
                if (std::find(active.begin(), active.end(), t.quest) == active.end()) continue;
                questHook(p, t.quest, t.hook.c_str(), {});
            } else {
                for (auto& m : triggers)
                    if (m.script->name() == t.trigger) run(m, p, t.hook.c_str(), {});
            }
        }
    }
    // Agents that died on their own leave the list.
    for (auto it = spawned.begin(); it != spawned.end();) {
        auto& list = it->second;
        list.erase(std::remove_if(list.begin(), list.end(), [](const Spawned& s) {
            Thing* thing = g_game.map.getThingByID(s.agentId);
            return !thing || !thing->getAgent() || thing->getAgent()->getHealth() == 0;
        }), list.end());
        it = list.empty() ? spawned.erase(it) : std::next(it);
    }
    while (!pending.empty()) {
        Pending pd = std::move(pending.front());
        pending.pop_front();
        apply(pd);
    }
}

// ---------------------------------------------------------------------------

int runScriptIntentSelfTest()
{
    int failed = 0;
    const auto check = [&](bool ok, std::string_view what) {
        if (!ok) {
            ++failed;
            fmt::print(">> script intent self-test FAILED: {}\n", what);
        }
    };
    const auto bad = [&](const ssjson::value& v, std::string_view fragment, std::string_view what) {
        try {
            script_intents::parse(v);
            check(false, fmt::format("{}: accepted", what));
        } catch (const std::exception& e) {
            const bool ok = std::string_view(e.what()).find(fragment) != std::string_view::npos;
            if (!ok) fmt::print(">> script intent self-test: {} threw '{}'\n", what, e.what());
            check(ok, what);
        }
    };
    try {
        const auto intents = script_intents::parse(ssjson::parse(R"([
            {"start": "scrapyard"}, {"setVar": "cars", "add": 1}, {"say": "Hi"},
            {"spawnAgent": "armored_ghoul", "count": 3, "radius": 300, "tag": "ambush"},
            {"after": {"seconds": 10, "hook": "wave2"}}, {"applyCondition": "slowed", "durationMs": 2000, "strength": 0.5}
        ])"));
        check(intents.size() == 6, "six intents parse");
        if (intents.size() == 6) {
            check(intents[1].kind == ScriptIntent::Kind::SetVar && intents[1].add && intents[1].value.as_double() == 1, "setVar add");
            check(intents[3].count == 3 && intents[3].tag == "ambush", "spawnAgent fields");
            check(intents[4].seconds == 10 && intents[4].key == "wave2", "after fields");
            check(intents[5].strength == 0.5f && intents[5].durationMs == 2000, "applyCondition fields");
        }
        const auto event = script_intents::parse(ssjson::parse(R"([{"accountEvent":"winter","occurrence":"2026-day1"}])"));
        check(event.size() == 1 && event[0].kind == ScriptIntent::Kind::AccountEvent && event[0].text == "2026-day1", "account events retain their receipt identity");
        bad(ssjson::parse(R"([{"accountEvent":"winter"}])"), "occurrence", "event rewards require an occurrence");
        bad(ssjson::parse(R"([{"accountEvent":"winter","occurrence":"bad key"}])"), "stable", "event receipt keys reject spaces");
        check(script_intents::parse(nullptr).empty(), "nothing returned is no actions");
    } catch (const std::exception& e) {
        check(false, fmt::format("valid intents parse: {}", e.what()));
    }
    bad(ssjson::parse(R"({"start": "x"})"), "list of actions", "a bare table is refused");
    bad(ssjson::parse(R"([{"teleport": "x"}])"), "no known action", "unknown verbs are refused");
    bad(ssjson::parse(R"([{"spawnAgent": "ghoul", "count": 6}])"), "count=", "at most 5 agents per action");
    bad(ssjson::parse(R"([{"after": {"seconds": 0, "hook": "x"}}])"), "seconds=", "timers need 1..3600 s");
    bad(ssjson::parse(R"([{"setVar": "x"}])"), "value= or add=", "setVar needs a value");
    ssjson::array many;
    for (int i = 0; i < 17; ++i) many.push_back(ssjson::object{{"say", "x"}});
    bad(many, "at most 16", "16 actions per call at most");
    fmt::print(">> script intent self-test: {}\n", failed == 0 ? "passed" : "FAILED");
    return failed == 0 ? 0 : 1;
}
