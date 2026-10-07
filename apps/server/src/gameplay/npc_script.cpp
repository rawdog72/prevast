// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/player.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/scripts/lua_script.h"
#include "gameplay/scripts/script_system.h"

// NPC dialogue scripts (data/npc/scripts) run in the same sandbox as quest
// scripts: compiled once when NPC content loads, kept loaded, capped per call.
void NpcSystem::compileScript(NpcDefinition& definition) {
    auto script = std::make_shared<LuaScript>("npc/scripts/" + definition.script);
    script->load(definition.scriptSource);
    if (!script->has("onTalk")) throw std::runtime_error("npc/scripts/" + definition.script + " has no onTalk");
    definition.compiled = std::move(script);
}

bool NpcSystem::script(Player* p, const std::string& message) {
    auto& session = sessions.at(p->getID());
    const auto& definition = *npcs.at(session.spawn)->definition;
    if (!definition.compiled) return false;
    boost::json::object quests;
    for (const auto& [key, state] : g_quests.states(p)) quests[key] = state;
    const boost::json::object context{{"message", message}, {"topic", session.topic}, {"karma", p->getKarmaLevel()},
        {"balance", progress[p->getID()].bank}, {"quests", std::move(quests)}};

    // onTalk returns { reply=, topic=, action="trade"|"bank", intents={...} }
    // or nothing (the NPC's fallback answers). Intents are the same actions a
    // quest script returns, applied on the next tick.
    std::string reply, topic, action;
    std::vector<ScriptIntent> intents;
    try {
        const boost::json::value result = definition.compiled->call("onTalk", {context});
        if (result.is_null()) return false;
        if (!result.is_object()) throw std::runtime_error("onTalk must return a table");
        const auto& o = result.get_object();
        const auto text = [&](const char* name) {
            const auto* v = o.if_contains(name);
            return v && v->is_string() && v->get_string().size() <= 512 ? std::string(v->get_string()) : std::string();
        };
        reply = text("reply");
        topic = text("topic");
        action = text("action");
        if (!topic.empty() && !definition.topics.count(topic)) throw std::runtime_error("unknown topic '" + topic + "'");
        if (!action.empty() && action != "trade" && action != "bank") throw std::runtime_error("action must be trade or bank");
        if (const auto* list = o.if_contains("intents")) intents = script_intents::parse(*list);
    } catch (const std::exception& e) {
        fmt::print(">> NPC script failed: {} ({})\n", definition.script, e.what());
        send(p, "I cannot answer that right now.");
        return true;
    }
    if (!intents.empty()) g_scripts.enqueue(p, std::move(intents), "npc/scripts/" + definition.script + " onTalk");
    if (!topic.empty()) session.topic = topic;
    if (action == "trade" || action == "bank") talk(p, action);
    else send(p, reply);
    return true;
}
