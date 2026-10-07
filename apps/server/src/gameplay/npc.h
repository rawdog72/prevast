// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "world/thing.h"
#include "gameplay/economy.h"
#include "core/security_budget.h"
#include <pugixml.hpp>
#include "gameplay/inventory.h"
#include <boost/json.hpp>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

class Player;
class LuaScript;
struct NpcOffer {
    std::string key;
    uint16_t iid = 0;
    economy::Money buy = 0, sell = 0;
    uint32_t chance = 10000, minStock = 0, maxStock = 0, limit = 0;
    bool rare = false, unlimited = false;
};
struct NpcRule {
    uint8_t min = 0, max = 5;
    bool trade = true, quests = true;
    uint32_t buyBps = 10000, sellBps = 10000;
    std::string reply;
};
struct NpcReply {
    std::string keyword, reply, next = "root", action;
};
struct NpcDefinition {
    uint16_t id = 0;
    std::string key, name, greeting, fallback, script, scriptSource;
    std::shared_ptr<LuaScript> compiled; // the loaded script, when there is one
    bool solid = false, banker = false;
    uint32_t walkRadius = 0, speed = 60, range = 200, timeout = 300, restock = 3600;
    std::vector<NpcOffer> offers;
    std::vector<NpcRule> karma;
    std::map<std::string, std::vector<NpcReply>> topics;
};
struct NpcSpawn {
    std::string key, npc; Position home;
    std::optional<uint32_t> walkRadius; // scenario placements: overrides the definition's
    uint8_t rotation = 0;
};
class Npc final : public Thing {
public:
    NpcSpawn spawn;
    const NpcDefinition* definition = nullptr;
    Position position, previous, goal;
    uint64_t nextWalk = 0;
    uint8_t rotation = 0;
    bool dirty = true;
    Npc* getNpc() override { return this; }
    const Npc* getNpc() const override { return this; }
    bool hasCollision() const override { return definition->solid; }
    float getCollisionRadius() const override { return 28; }
    bool isMobile() const override { return true; }
    bool isRemoved() const override { return false; }
    bool isDirty() const override { return dirty; }
    void resetDirty() override { dirty = false; previous = position; }
    const Position& getPosition() const override { return position; }
    void setPosition(const Position& p) override { previous = position; position = p; dirty = true; }
    void buildUpdate(EntityUpdate& out) const override;
    void buildRemoval(EntityUpdate& out) const override;
    Tile* getTile() override;
    const Tile* getTile() const override;
};
struct NpcStock {
    uint64_t epoch = 0;
    uint32_t interval = 3600;
    std::map<std::string, uint32_t> remaining;
};
struct NpcSession {
    uint32_t id = 0, revision = 0, lastRequest = 0;
    uint64_t expires = 0;
    std::string spawn, topic = "root", panel, text, echo;
    uint8_t karma = 255;
    bool needsRefresh = false;
    uint64_t lastRefresh = 0;
};
struct NpcProgress {
    ActionBudget actions;
    economy::Money bank = 0;
    std::map<std::string, uint32_t> purchases;
};
class NpcSystem {
public:
    bool load(const std::string& file);
    void start();
    void update(uint32_t elapsed);
    void action(Player* player, uint32_t session, uint32_t revision, uint32_t request,
                uint8_t action, uint32_t target, uint32_t amount, const std::string& text);
    bool localSay(Player* player, const std::string& text);
    void close(uint32_t playerId, const std::string& reason);
    void forget(uint32_t playerId);
    bool active(uint32_t playerId) const { return sessions.count(playerId) != 0; }
    void send(Player* player, const std::string& text = "");
    // The exchange planner, for other systems that pay in caps and items.
    bool planExchange(Player* player, int64_t moneyDelta,
                      const std::vector<std::pair<uint16_t, uint32_t>>& take,
                      const std::vector<std::pair<uint16_t, uint32_t>>& give,
                      Inventory::ExchangePlan& out);
    bool hasNpc(const std::string& key) const { return definitions.count(key) != 0; }
    // A running scenario's placements replace npcs.xml's spawns, and keep doing
    // so across content reloads. Before start(); NPCs already standing stay.
    void useScenarioSpawns(std::vector<NpcSpawn> placed);
    // Where the NPC stands (its first spawn), for quest areas near="npc:key".
    const Position* spawnPosition(const std::string& key) const {
        for (const auto& s : spawns) if (s.npc == key) return &s.home;
        return nullptr;
    }
    // How many of an item the player could hand over: what the exchange planner
    // would take (not the equipped weapon or wearable, not a used magazine).
    uint32_t takeable(const Player* player, uint16_t iid) const;
    // The npcs.xml id (the client entity's extra), 0 when unknown.
    uint16_t npcId(const std::string& key) const;
    // Whether this NPC's karma rule lets the player do quest business with it.
    bool questsAllowed(const std::string& key, const Player* player) const;
private:
    std::map<std::string, NpcDefinition> definitions;
    std::vector<NpcSpawn> spawns;
    std::optional<std::vector<NpcSpawn>> scenarioSpawns;
    std::map<std::string, std::unique_ptr<Npc>> npcs;
    std::map<std::string, NpcStock> stocks;
    std::map<uint32_t, NpcSession> sessions;
    std::map<uint32_t, NpcProgress> progress;
    std::array<uint16_t, 3> coins{};
    uint32_t nextSession = 0;
    uint64_t lastSecond = 0;
    bool stockHealthy = true, stockLoaded = false;
    std::string contentDirectory;
    struct IpBudget { ActionBudget actions; uint64_t seen = 0; };
    std::map<std::string, IpBudget> ipBudgets;
    ActionBudget workBudget, stockWriteBudget;
    bool admit(Player*);
    const NpcRule& rule(const NpcDefinition&, const Player*) const;
    bool inRange(const Player*, const Npc&) const;
    bool saveStock(const std::string& key);
    void loadStock();
    bool restock(const std::string&, const NpcDefinition&);
    economy::Money wallet(const Player*) const;
    bool plan(Player*, int64_t moneyDelta, uint16_t item, int32_t quantity,
              Inventory::ExchangePlan*, uint32_t convertAmount = 0, uint8_t denomination = 0,
              const std::vector<std::pair<uint16_t, uint32_t>>& take = {},
              const std::vector<std::pair<uint16_t, uint32_t>>& give = {});
    uint32_t maximum(Player*, const NpcOffer&, bool buy, economy::Money price, uint32_t limit);
    void talk(Player*, const std::string&);
    bool script(Player*, const std::string&);
    static void compileScript(NpcDefinition&);
};
extern NpcSystem g_npcs;
