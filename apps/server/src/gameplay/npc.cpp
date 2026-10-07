// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/npc.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/game.h"
#include "world/collision.h"
#include "network/opcodes.h"
#include <cctype>

extern Game g_game;
NpcSystem g_npcs;
namespace {
uint64_t npcNow() { return static_cast<uint64_t>(OTSYS_TIME()); }
uint64_t npcWall() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
std::string normalized(std::string value) {
    boost::algorithm::trim(value);
    for (auto& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return value;
}
bool available(const Player* p) { return p && p->getProtocolGame() && p->getHealth() > 0 && !p->isGhoul(); }
}

void Npc::buildUpdate(EntityUpdate& out) const {
    out.pid = 0; out.id = getId16(); out.type = 14; out.state = 1;
    out.rotation = rotation; out.extra = definition->id;
    out.startX = previous.x; out.startY = previous.y; out.endX = position.x; out.endY = position.y;
}
void Npc::buildRemoval(EntityUpdate& out) const {
    buildUpdate(out);
    out.state = 0;
    out.extra = 0;
}
Tile* Npc::getTile() { return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE); }
const Tile* Npc::getTile() const { return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE); }

const NpcRule& NpcSystem::rule(const NpcDefinition& d, const Player* p) const {
    static const NpcRule standard{};
    for (const auto& rule : d.karma) if (p->getKarmaLevel() >= rule.min && p->getKarmaLevel() <= rule.max) return rule;
    return standard;
}
uint16_t NpcSystem::npcId(const std::string& key) const {
    const auto found = definitions.find(key);
    return found == definitions.end() ? 0 : found->second.id;
}
bool NpcSystem::questsAllowed(const std::string& key, const Player* p) const {
    const auto found = definitions.find(key);
    return found != definitions.end() && rule(found->second, p).quests;
}
bool NpcSystem::inRange(const Player* p, const Npc& npc) const {
    return p->getPosition().isInRange(npc.position, npc.definition->range, npc.definition->range);
}

bool NpcSystem::admit(Player* p) {
    // The character budget survives conversation reopen and connection takeover.
    // IP and global budgets also bound multiple characters acting together.
    if (!progress[p->getID()].actions.consume(5, 10)) return false;
    const auto now = npcNow();
    const auto address = p->getIP().to_string();
    if (ipBudgets.size() >= 2048) {
        for (auto it = ipBudgets.begin(); it != ipBudgets.end();)
            if (now - it->second.seen > 60000) it = ipBudgets.erase(it); else ++it;
        if (ipBudgets.size() >= 2048 && !ipBudgets.count(address)) return false;
    }
    auto& ip = ipBudgets[address]; ip.seen = now;
    return ip.actions.consume(40, 80) && workBudget.consume(200, 40);
}

void NpcSystem::close(uint32_t playerId, const std::string& reason) {
    const auto it = sessions.find(playerId);
    if (it == sessions.end()) return;
    if (auto* p = g_game.getPlayerByID(playerId)) {
        NetworkMessage msg; msg.addByte(static_cast<uint8_t>(ServerOpcode::NPC_CLOSED));
        msg.add<uint32_t>(it->second.id); msg.addString(reason); p->sendNetworkMessage(msg);
    }
    sessions.erase(it);
}
void NpcSystem::forget(uint32_t playerId) {
    close(playerId, "Your conversation has ended.");
    progress.erase(playerId);
}

void NpcSystem::send(Player* p, const std::string& text) {
    auto found = sessions.find(p->getID());
    if (found == sessions.end()) return;
    auto& s = found->second;
    s.needsRefresh = false;
    s.lastRefresh = npcNow();
    const auto n = npcs.find(s.spawn);
    if (n == npcs.end()) { close(p->getID(), "The NPC has left."); return; }
    const auto& npc = *n->second;
    const auto& d = *npc.definition;
    const auto& policy = rule(d, p);
    auto& player = progress[p->getID()];
    s.karma = p->getKarmaLevel();
    ++s.revision;
    boost::json::object state{{"session", s.id}, {"revision", s.revision}, {"entityId", npc.getId16()},
        {"name", d.name}, {"topic", s.topic}, {"panel", s.panel}, {"text", text},
        {"banker", d.banker}, {"balance", player.bank}, {"wallet", wallet(p)},
        {"range", d.range}, {"request", s.lastRequest}, {"tradeAllowed", policy.trade}, {"echo", s.echo}};
    s.echo.clear();
    boost::json::array offers;
    const auto stockIt = stocks.find(s.spawn);
    uint64_t restockAt = 0;
    if (stockIt != stocks.end()) restockAt = (stockIt->second.epoch + 1) * stockIt->second.interval;
    for (size_t i = 0; s.panel == "shop" && i < d.offers.size(); ++i) {
        const auto& offer = d.offers[i];
        uint32_t remaining = 0;
        if (stockIt != stocks.end()) {
            auto r = stockIt->second.remaining.find(offer.key);
            if (r != stockIt->second.remaining.end()) remaining = r->second;
        }
        if (offer.rare && !remaining) continue;
        const auto buy = economy::adjusted(offer.buy, policy.buyBps, true);
        const auto sell = economy::adjusted(offer.sell, policy.sellBps, false);
        uint32_t limit = offer.unlimited ? economy::MAX_QUANTITY : remaining;
        if (offer.limit) {
            const auto bought = player.purchases[s.spawn + "/" + offer.key];
            limit = std::min(limit, offer.limit - std::min(offer.limit, bought));
        }
        const bool canTrade = stockHealthy && stockIt != stocks.end() && policy.trade;
        offers.push_back(boost::json::object{{"index", i}, {"iid", offer.iid}, {"buy", buy}, {"sell", sell},
            {"stock", remaining}, {"unlimited", offer.unlimited}, {"rare", offer.rare},
            {"buyMax", canTrade ? maximum(p, offer, true, buy, limit) : 0},
            {"sellMax", canTrade ? maximum(p, offer, false, sell, economy::MAX_QUANTITY) : 0}});
    }
    state["offers"] = std::move(offers);
    state["restockSeconds"] = restockAt > npcWall() ? restockAt - npcWall() : 0;
    const auto encoded = boost::json::serialize(state);
    if (encoded.size() > NetworkMessage::MAX_STRING_BYTES) { close(p->getID(), "NPC response is too large."); return; }
    NetworkMessage msg; msg.addByte(static_cast<uint8_t>(ServerOpcode::NPC_STATE)); msg.addString(encoded); p->sendNetworkMessage(msg);
}

void NpcSystem::action(Player* p, uint32_t session, uint32_t revision, uint32_t request,
    uint8_t kind, uint32_t target, uint32_t amount, const std::string& text) {
    if (!available(p) || text.size() > 256 || kind > 8) return;
    // Closing remains cheap and available even when a client exhausted its budget.
    if (kind == 7) {
        const auto found = sessions.find(p->getID());
        if (found != sessions.end() && found->second.id == session) close(p->getID(), "Goodbye.");
        return;
    }
    if (!admit(p)) return;
    p->resetIdleTime();
    if (kind == 0) {
        if (session || revision || g_game.trades.count(p->getID())) return;
        Npc* npc = nullptr;
        for (const auto& [key, candidate] : npcs) if (candidate->getId16() == target) { npc = candidate.get(); break; }
        if (!npc || !inRange(p, *npc)) return;
        close(p->getID(), "");
        NpcSession s; if (++nextSession == 0) ++nextSession;
        s.id = nextSession; s.spawn = npc->spawn.key; s.expires = npcNow() + uint64_t(npc->definition->timeout) * 1000;
        sessions[p->getID()] = s;
        if (text == "trade") talk(p, "trade");
        else send(p, npc->definition->greeting);
        return;
    }
    auto it = sessions.find(p->getID());
    if (it == sessions.end() || it->second.id != session) return;
    auto& s = it->second;
    auto n = npcs.find(s.spawn);
    if (n == npcs.end() || !inRange(p, *n->second) || npcNow() >= s.expires || g_game.trades.count(p->getID())) {
        close(p->getID(), "Conversation ended."); return;
    }
    if (kind == 7) { close(p->getID(), "Goodbye."); return; }
    const auto& d = *n->second->definition;
    const auto& policy = rule(d, p);
    // Exact revision + a monotonically increasing per-session request ID.
    if (!request || request <= s.lastRequest || revision != s.revision || s.karma != p->getKarmaLevel()) { send(p, "The offer changed. Please try again."); return; }
    s.lastRequest = request; s.expires = npcNow() + uint64_t(d.timeout) * 1000;
    if (kind == 1) { s.echo = text; talk(p, text); return; }
    if (kind == 8) { send(p); return; }
    if (!policy.trade) { send(p, policy.reply); return; }
    Inventory::ExchangePlan exchange;
    auto& player = progress[p->getID()];
    if (kind == 2 || kind == 3) {
        if (s.panel != "shop" || target >= d.offers.size() || !amount || amount > economy::MAX_QUANTITY) return;
        const auto prior = stocks.find(s.spawn);
        const auto epoch = prior == stocks.end() ? UINT64_MAX : prior->second.epoch;
        if (!restock(s.spawn, d)) { send(p, "The shop is temporarily unavailable."); return; }
        auto& stock = stocks.at(s.spawn);
        if (epoch != stock.epoch) { send(p, "New stock has arrived. Please select again."); return; }
        const auto& offer = d.offers[target];
        const bool buy = kind == 2;
        const auto unit = economy::adjusted(buy ? offer.buy : offer.sell, buy ? policy.buyBps : policy.sellBps, buy);
        economy::Money total = 0;
        auto& remaining = stock.remaining[offer.key];
        const auto limitKey = s.spawn + "/" + offer.key;
        auto& purchased = player.purchases[limitKey];
        if (!unit || !economy::price(unit, amount, total) || (offer.rare && !remaining) ||
            (buy && ((!offer.unlimited && remaining < amount) || (offer.limit && uint64_t(purchased) + amount > offer.limit)))) {
            send(p, "That quantity is unavailable."); return;
        }
        if (!plan(p, buy ? -int64_t(total) : int64_t(total), offer.iid, buy ? int32_t(amount) : -int32_t(amount), &exchange)) {
            send(p, "You need enough funds, eligible items and room for the items and change."); return;
        }
        if (buy && !offer.unlimited) {
            // Bound durable disk commits across all clients as well as CPU work.
            if (!stockWriteBudget.consume(20, 2)) { send(p, "The shop is busy. Please try again."); return; }
            remaining -= amount;
            if (!saveStock(s.spawn)) { remaining += amount; send(p, "The shop could not save this sale. Nothing was exchanged."); return; }
        }
        if (buy && offer.limit) purchased += amount;
        p->inventory.commitExchange(std::move(exchange));
        const auto spawnKey = s.spawn;
        if (buy && !offer.unlimited) for (auto& [id, visitor] : sessions) {
            if (id != p->getID() && visitor.spawn == spawnKey && visitor.panel == "shop") {
                ++visitor.revision; // Old quotes become invalid immediately.
                visitor.needsRefresh = true;
            }
        }
        send(p, "Done.");
        return;
    }
    if (!d.banker || s.panel != "bank" || !amount || amount > economy::MAX_MONEY) return;
    int64_t delta = 0;
    if (kind == 4) {
        if (uint64_t(player.bank) + amount > economy::MAX_MONEY) { send(p, "Bank balance limit reached."); return; }
        delta = -int64_t(amount);
    } else if (kind == 5) {
        if (amount > player.bank) { send(p, "Insufficient bank balance."); return; }
        delta = amount;
    } else if (kind == 6) {
        if (target > 2) return;
    } else return;
    if (!plan(p, delta, 0, 0, &exchange, kind == 6 ? amount : 0, static_cast<uint8_t>(target))) {
        send(p, "Insufficient coins or room for this exchange."); return;
    }
    if (kind == 4) player.bank += amount;
    if (kind == 5) player.bank -= amount;
    p->inventory.commitExchange(std::move(exchange));
    send(p, "Done.");
}

bool NpcSystem::localSay(Player* p, const std::string& raw) {
    auto text = normalized(raw);
    // "Hi!" and "hello." are the same greeting as "hi".
    while (!text.empty() && std::ispunct(static_cast<unsigned char>(text.back()))) text.pop_back();
    if (text == "hi" || text == "hello" || text == "hey") {
        Npc* nearest = nullptr; int32_t distance = INT32_MAX;
        for (const auto& [key, npc] : npcs) {
            const auto dist = p->getPosition().getDistance(npc->position);
            if (inRange(p, *npc) && dist < distance) { nearest = npc.get(); distance = dist; }
        }
        if (!nearest) return false;
        action(p, 0, 0, 0, 0, nearest->getId16(), 0, ""); return true;
    }
    if (text == "bye" && sessions.count(p->getID())) { close(p->getID(), "Goodbye."); return true; }
    return false;
}

void NpcSystem::talk(Player* p, const std::string& raw) {
    auto& s = sessions.at(p->getID());
    const auto& d = *npcs.at(s.spawn)->definition;
    const auto& policy = rule(d, p);
    const auto text = normalized(raw);
    if (text == "bye") { close(p->getID(), "Goodbye."); return; }
    if (text == "hi" || text == "hello" || text == "help") { s.topic = "root"; send(p, d.greeting); return; }
    if (text == "trade" || text == "shop") {
        if (!policy.trade) { send(p, policy.reply); return; }
        if (d.offers.empty()) { send(p, "I have nothing to trade."); return; }
        if (!restock(s.spawn, d)) { send(p, "The shop is temporarily unavailable."); return; }
        s.panel = "shop"; send(p, "Here is my current stock."); return;
    }
    if (text == "quests" || text == "journal") { send(p, g_quests.offersAt(p, d.key)); return; }
    if (text == "bank" || text == "balance") {
        if (!d.banker || !policy.trade) { send(p, policy.reply.empty() ? "I do not offer banking." : policy.reply); return; }
        s.panel = "bank"; send(p, "Your bank balance is " + std::to_string(progress[p->getID()].bank) + " caps."); return;
    }
    if (const auto quest = g_quests.onTalk(p, d.key, text, policy.quests, policy.reply); quest.handled) {
        s.topic = "root"; send(p, quest.reply); return;
    }
    for (const auto& reply : d.topics.at(s.topic)) {
        if (normalized(reply.keyword) != text) continue;
        if (reply.action == "trade" || reply.action == "bank") { talk(p, reply.action); return; }
        s.topic = reply.next;
        send(p, reply.reply); return;
    }
    if (script(p, text)) return;
    send(p, d.fallback);
}

void NpcSystem::update(uint32_t elapsed) {
    const auto now = npcNow();
    for (auto& [key, owned] : npcs) {
        auto& npc = *owned; const auto& d = *npc.definition;
        const uint32_t walkRadius = npc.spawn.walkRadius.value_or(d.walkRadius);
        if (!walkRadius || !d.speed) continue;
        if (now >= npc.nextWalk) {
            npc.nextWalk = now + 4000 + rand() % 4000;
            if ((rand() % 3) == 0) npc.goal = npc.spawn.home;
            else {
                const double angle = (rand() % 6283) / 1000.0;
                const uint32_t radius = rand() % (walkRadius + 1);
                npc.goal = g_game.clampPositionToMap(int(npc.spawn.home.x + cos(angle) * radius), int(npc.spawn.home.y + sin(angle) * radius));
            }
        }
        const float dx = float(npc.goal.x) - npc.position.x, dy = float(npc.goal.y) - npc.position.y;
        const float distance = std::sqrt(dx * dx + dy * dy);
        if (distance < 2) continue;
        const float step = std::min(distance, d.speed * std::min(elapsed, 100u) / 1000.0f);
        const Position candidate = g_game.clampPositionToMap(int(std::round(npc.position.x + dx / distance * step)), int(std::round(npc.position.y + dy / distance * step)));
        if (candidate.getDistance(npc.spawn.home) > static_cast<int32_t>(walkRadius)) { npc.goal = npc.spawn.home; continue; }
        std::vector<Thing*> nearby;
        const int tx = candidate.x / TILE_SIZE, ty = candidate.y / TILE_SIZE;
        const int margin = Map::collisionScanTileMargin() + 1;
        g_game.map.getThingsInTileBox(tx - margin, ty - margin, tx + margin, ty + margin, nearby);
        bool blocked = false;
        for (auto* other : nearby) {
            if (other == &npc || !other->hasCollision() || (!d.solid && (other->getCreature() || other->getNpc()))) continue;
            CollisionRect rect; float overlap = 0, nx = 0, ny = 0;
            const CollisionCircle circle{float(candidate.x), float(candidate.y), 28};
            if (other->getCollisionRect(rect)) blocked = Collision::checkCircleRect(circle, rect, overlap, nx, ny);
            else blocked = Collision::checkCircleCircle(circle, {float(other->getPosition().x), float(other->getPosition().y), other->getCollisionRadius()}, overlap, nx, ny);
            if (blocked) break;
        }
        if (!blocked) {
            npc.rotation = static_cast<uint8_t>(int(std::atan2(dy, dx) * 255 / (2 * 3.141592653589793) + 255) % 255);
            g_game.map.placeThing(candidate, &npc);
        } else { npc.goal = npc.spawn.home; npc.nextWalk = std::min(npc.nextWalk, now + 1000); }
    }
    std::vector<uint32_t> ended, refreshed;
    const bool second = now / 1000 != lastSecond;
    for (auto& [id, s] : sessions) {
        auto* p = g_game.getPlayerByID(id); const auto n = npcs.find(s.spawn);
        if (!available(p) || n == npcs.end() || !inRange(p, *n->second) || now >= s.expires) ended.push_back(id);
        else if ((second && s.karma != p->getKarmaLevel()) || (s.needsRefresh && now - s.lastRefresh >= 200)) refreshed.push_back(id);
    }
    for (auto id : ended) close(id, "Conversation ended.");
    if (second) {
        lastSecond = now / 1000;
        for (const auto& [key, npc] : npcs) {
            const auto stock = stocks.find(key);
            const auto epoch = stock == stocks.end() ? UINT64_MAX : stock->second.epoch;
            if (restock(key, *npc->definition) && stocks.at(key).epoch != epoch)
                for (auto& [id, s] : sessions) if (s.spawn == key) refreshed.push_back(id);
        }
    }
    std::sort(refreshed.begin(), refreshed.end());
    refreshed.erase(std::unique(refreshed.begin(), refreshed.end()), refreshed.end());
    for (auto id : refreshed) if (auto* p = g_game.getPlayerByID(id)) {
        if (workBudget.consume(200, 40)) send(p);
        else if (auto it = sessions.find(id); it != sessions.end()) it->second.needsRefresh = true;
    }
}
