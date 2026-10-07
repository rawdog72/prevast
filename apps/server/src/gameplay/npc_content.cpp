// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/game.h"
#include "gameplay/agent.h"
#include "content/xml_utils.h"
#include <fstream>
#include "content/content_validation.h"
#include "contract/editor_limits.h"
#include "gameplay/quests/quest_system.h"

extern Game g_game;
using namespace content_validation;

bool NpcSystem::load(const std::string& file) {
    try {
        pugi::xml_document doc;
        std::map<std::string, NpcDefinition> next;
        std::vector<NpcSpawn> nextSpawns;
        std::set<uint16_t> ids;
        const std::array<std::string, 3> coinKeys{"bottle_cap", "banknote", "gold_bar"};
        for (size_t i = 0; i < coins.size(); ++i) {
            const auto* currency = ItemManager::getInstance().getItemData(coinKeys[i]);
            coins[i] = currency ? currency->id : 0;
            const auto* data = ItemManager::getInstance().getItemData(coins[i]);
            if (!data || data->stack != 255 || data->currencyValue != economy::VALUES[i])
                throw std::runtime_error("NPC currency metadata must define values 1, 255, 65025 with stack 255");
        }
        const auto root = xml_utils::openDataFile(doc, file, "npcs");
        if (!root) return false;
        for (auto n : root.children("npc")) {
            NpcDefinition d;
            d.key = key(n); d.name = text(n, "name");
            d.id = static_cast<uint16_t>(number(n, "id", 0, 65535));
            if (!d.id || !ids.insert(d.id).second || d.name.empty() || d.name.size() > 64 || !flag(n, "invulnerable", true)) throw std::runtime_error("invalid NPC identity/immunity");
            const auto body = n.child("body");
            d.solid = flag(body, "solid", !flag(body, "walkThrough", true));
            if (body.attribute("solid") && body.attribute("walkThrough") && d.solid == flag(body, "walkThrough", true)) throw std::runtime_error("contradictory NPC collision");
            auto movement = n.child("movement");
            d.walkRadius = number(movement, "walkRadius", 0, 20) * TILE_SIZE;
            d.speed = number(movement, "speed", 60, 200);
            d.range = number(n, "rangeTiles", 2, 5) * TILE_SIZE;
            d.timeout = number(n, "timeoutSeconds", 300, 3600);
            if (!d.range || !d.timeout) throw std::runtime_error("zero NPC range/timeout");
            d.banker = flag(n.child("banker"), "enabled", false);
            auto shop = n.child("shop");
            d.restock = number(shop, "restockSeconds", 3600, 604800);
            if (!d.restock || text(shop, "stockScope", "shared") != "shared") throw std::runtime_error("NPC stock must be timed and shared");
            std::set<std::string> offers;
            for (auto o : shop.children()) {
                const std::string tag = o.name();
                if (tag != "offer" && tag != "rareOffer") throw std::runtime_error("unknown shop element");
                NpcOffer offer;
                offer.key = key(o); offer.iid = item(o);
                offer.buy = number(o, "buyPrice", 0, economy::MAX_MONEY);
                offer.sell = number(o, "sellPrice", 0, economy::MAX_MONEY);
                offer.rare = tag == "rareOffer";
                offer.chance = number(o, "chanceBps", 10000, 10000);
                offer.unlimited = flag(o, "unlimited", false);
                offer.minStock = number(o, "stockMin", 1, economy::MAX_QUANTITY);
                offer.maxStock = number(o, "stockMax", offer.minStock, economy::MAX_QUANTITY);
                offer.limit = number(o, "perLifeLimit", 0, economy::MAX_QUANTITY);
                if ((!offer.buy && !offer.sell) || offer.minStock > offer.maxStock || (offer.rare && offer.unlimited) || !offers.insert(offer.key).second ||
                    std::find(coins.begin(), coins.end(), offer.iid) != coins.end()) throw std::runtime_error("invalid NPC offer");
                d.offers.push_back(offer);
            }
            if (d.offers.size() > 16) throw std::runtime_error("NPC offer limit is 16");
            std::set<uint32_t> levels;
            for (auto r : n.child("karma").children("rule")) {
                NpcRule rule;
                rule.min = static_cast<uint8_t>(number(r, "min", 0, 5)); rule.max = static_cast<uint8_t>(number(r, "max", 5, 5));
                rule.trade = flag(r, "trade", true); rule.quests = flag(r, "quests", true);
                rule.buyBps = number(r, "buyBps", 10000, 100000); rule.sellBps = number(r, "sellBps", 10000, 100000);
                rule.reply = text(r, "reply", "I cannot help you with that.");
                if (rule.min > rule.max || !rule.buyBps) throw std::runtime_error("invalid karma rule");
                for (uint32_t level = rule.min; level <= rule.max; ++level) if (!levels.insert(level).second) throw std::runtime_error("overlapping karma rules");
                d.karma.push_back(rule);
            }
            auto dialogue = n.child("dialogue");
            d.greeting = text(dialogue, "greeting", "Hello. Ask me about {trade}, {bank} or {quests}.");
            d.fallback = text(dialogue, "fallback", "I do not know about that. Try {help}.");
            d.script = text(n, "script");
            if (!d.script.empty() && (std::filesystem::path(d.script).is_absolute() || d.script.find("..") != std::string::npos || std::filesystem::path(d.script).extension() != ".lua"))
                throw std::runtime_error("NPC script must be a relative .lua file");
            if (!d.script.empty()) {
                const auto directory = std::filesystem::canonical(std::filesystem::path(file).parent_path().parent_path() / "npc" / "scripts");
                const auto path = std::filesystem::canonical(directory / d.script);
                const auto relative = path.lexically_relative(directory);
                if (relative.empty() || *relative.begin() == ".." || std::filesystem::file_size(path) > 65536)
                    throw std::runtime_error("NPC script is outside scripts directory or too large");
                std::ifstream input(path, std::ios::binary);
                if (!input) throw std::runtime_error("cannot read NPC script: " + d.script);
                std::stringstream source; source << input.rdbuf(); d.scriptSource = source.str();
                if (!d.scriptSource.empty() && d.scriptSource.front() == '\x1b') throw std::runtime_error("NPC scripts must be Lua source");
                compileScript(d);
            }
            for (auto t : dialogue.children("topic")) {
                const auto topic = key(t);
                if (d.topics.count(topic)) throw std::runtime_error("duplicate NPC topic");
                auto& replies = d.topics[topic];
                for (auto r : t.children("reply")) {
                    if (r.attribute("quest") || r.attribute("state"))
                        throw std::runtime_error("NPC replies no longer carry quest= or state=; quest dialogue lives in data/quests");
                    NpcReply reply;
                    reply.keyword = text(r, "keyword"); reply.reply = text(r, "text"); reply.next = text(r, "next", "root");
                    reply.action = text(r, "action");
                    if (reply.keyword.empty() || reply.keyword.size() > 64) throw std::runtime_error("invalid NPC reply");
                    if (!reply.action.empty() && reply.action != "trade" && reply.action != "bank") throw std::runtime_error("invalid dialogue action");
                    replies.push_back(reply);
                }
                if (replies.size() > 32) throw std::runtime_error("too many topic replies");
            }
            d.topics.try_emplace("root");
            if (d.topics.size() > 32 || !next.emplace(d.key, d).second) throw std::runtime_error("duplicate/oversize NPC");
        }
        for (const auto& [k, npc] : next) {
            if (npc.topics.size() > 32) throw std::runtime_error("too many NPC topics: " + k);
            for (const auto& [topic, replies] : npc.topics) {
                if (replies.size() > 32) throw std::runtime_error("too many NPC replies: " + k);
                std::set<std::string> triggers;
                for (const auto& r : replies) {
                    if (!npc.topics.count(r.next)) throw std::runtime_error("unknown dialogue topic: " + r.next);
                    if (!triggers.insert(r.keyword).second) throw std::runtime_error("ambiguous dialogue reply: " + k);
                }
            }
        }
        std::set<std::string> spawnKeys;
        for (auto s : root.children("spawn")) {
            NpcSpawn spawn; spawn.key = key(s); spawn.npc = key(s, "npc");
            const auto x = number(s, "tileX", 0, MapSize::tilesX() - 1);
            const auto y = number(s, "tileY", 0, MapSize::tilesY() - 1);
            spawn.home = Position(x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2);
            if (!next.count(spawn.npc) || !spawnKeys.insert(spawn.key).second) throw std::runtime_error("invalid NPC spawn");
            nextSpawns.push_back(spawn);
        }
        if (scenarioSpawns) {
            for (const auto& s : *scenarioSpawns)
                if (!next.count(s.npc)) throw std::runtime_error("NPC '" + s.npc + "' is placed by the running scenario");
            nextSpawns = *scenarioSpawns;
        }
        if (next.size() > 32 || nextSpawns.size() > static_cast<size_t>(EditorContract::Project::maxNpcs)) throw std::runtime_error("NPC content limits exceeded");
        // A quest that names an NPC keeps it: dropping one would strand every
        // player on that quest.
        for (const auto& [npcKey, questKey] : g_quests.npcReferences())
            if (!next.count(npcKey)) throw std::runtime_error("NPC '" + npcKey + "' is still used by quest '" + questKey + "'");
        // Validation finished before any runtime mutation. Close sessions before
        // changing definitions, retaining character progress and shared stock.
        std::vector<uint32_t> visitors;
        for (auto& [id, s] : sessions) visitors.push_back(id);
        for (auto id : visitors) close(id, "NPC content changed.");
        const bool running = !npcs.empty();
        for (auto& [k, npc] : npcs) {
            EntityUpdate removal; npc->buildRemoval(removal);
            g_game.broadcastSurgicalUpdate(removal, npc->position);
            g_game.map.removeThing(npc.get());
        }
        npcs.clear();
        definitions.swap(next); spawns.swap(nextSpawns);
        contentDirectory = (std::filesystem::path(file).parent_path().parent_path() / "npc" / "scripts").string();
        if (running) start();
        fmt::print(">> NPCs: {} definitions, {} spawns\n", definitions.size(), spawns.size());
        return true;
    } catch (const std::exception& e) {
        fmt::print(">> NPC configuration rejected: {}\n", e.what()); return false;
    }
}
