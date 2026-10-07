// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/quests/quest_loader.h"
#include "gameplay/quests/quest_journal.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/scripts/script_system.h"
#include "network/networkmessage.h"
#include "network/opcodes.h"
#include "gameplay/agent.h"
#include "gameplay/game.h"
#include "gameplay/npc.h"
#include "gameplay/object.h"
#include "gameplay/player.h"
#include "gameplay/resource.h"
#include "content/xml_utils.h"
#include "core/tools.h"
#include "content/configmanager.h"
#include "world/structure.h"
#include <filesystem>

extern Game g_game;
QuestSystem g_quests;

namespace {
uint64_t wallClock()
{
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

bool eligible(const Player* p) { return p && p->getHealth() > 0 && !p->isGhoul(); }

uint64_t nowMs() { return static_cast<uint64_t>(OTSYS_TIME()); }

uint8_t causeOf(QuestCause cause) { return static_cast<uint8_t>(cause); }

// A QUEST_STATE string also carries its u16 length; stay under the limit with
// room to spare.
constexpr size_t MAX_ENTRY_BYTES = 7900;
constexpr uint32_t MARKER_SWEEP_MS = 2000;

std::string itemName(uint16_t iid)
{
    const ItemData* data = ItemManager::getInstance().getItemData(iid);
    if (!data) return "items";
    return data->name.empty() ? data->key : data->name;
}

std::string describe(const QuestRewards& r)
{
    std::string text;
    const auto add = [&](const std::string& part) { text += (text.empty() ? "" : ", ") + part; };
    if (r.caps) add(std::to_string(r.caps) + " caps");
    for (const auto& [iid, count] : r.items) add(std::to_string(count) + " " + itemName(iid));
    return text;
}

QuestRefs liveRefs()
{
    QuestRefs refs;
    refs.item = [](const std::string& k) -> uint16_t {
        const ItemData* data = ItemManager::getInstance().getItemData(k);
        return data ? data->id : 0;
    };
    refs.currency = [](uint16_t iid) {
        const ItemData* data = ItemManager::getInstance().getItemData(iid);
        return data && data->currencyValue != 0;
    };
    refs.agent = [](const std::string& k) { return g_agents.getAgentData(k) != nullptr; };
    refs.object = [](const std::string& k) { return g_objects.getObjectData(k) != nullptr; };
    refs.resource = [](const std::string& k) { return g_resources.getResourceData(k) != nullptr; };
    refs.npc = [](const std::string& k) { return g_npcs.hasNpc(k); };
    refs.achievement = [](const std::string& k) { return g_progress.achievement(k) != nullptr; };
    refs.stat = [](const std::string& k) { return g_progress.stat(k) != nullptr; };
    refs.structure = [](const std::string& k) { return g_structures.getTemplate(k) != nullptr; };
    return refs;
}
}

std::string QuestSystem::directory()
{
    return (std::filesystem::path(contentFile("content.xml")).parent_path().parent_path() / "quests").string();
}

bool QuestSystem::load(const std::string& dir)
{
    try {
        std::vector<QuestDefinition> next = quest_loader::loadDirectory(dir, liveRefs());
        // Quest scripts and trigger scripts compile now; an error rejects the
        // whole reload, so running quests never point at a missing script.
        g_scripts.load(next);
        xml_utils::noteFileLoaded("quests", "quest");
        remap(next);
        quests = std::move(next);
        index.clear();
        for (size_t i = 0; i < quests.size(); ++i) index[quests[i].key] = i;
        fmt::print(">> Quests: {} definitions\n", quests.size());
        // A raw x/y area is only the same place from one start to the next when
        // the world is: a fixed seed and no scaling of content to the map size.
        const bool worldMoves = getNumber(ConfigManager::WORLD_SEED) == 0 || getBoolean(ConfigManager::SCALE_WORLD_CONTENT);
        for (const auto& d : quests)
            for (const auto& a : d.areas)
                if (a.kind == QuestArea::Kind::Point && worldMoves)
                    reportStartupWarning(fmt::format("quest '{}' area '{}' uses x/y coordinates, but this world is generated anew "
                        "(seed = 0 or scaleWorldContentToMapSize): the spot will not be the same place next start. "
                        "Prefer structure= or near=\"npc:...\".", d.key, a.key));
        for (auto& [playerId, pq] : players) {
            if (Player* p = g_game.getPlayerByID(playerId)) sync(p);
        }
        return true;
    } catch (const std::exception& e) {
        fmt::print(">> Quest configuration rejected: {}\n", e.what());
        return false;
    }
}

// Progress survives a reload by key: a quest whose current stage still exists
// keeps it and the counts of objectives that kept their keys.
void QuestSystem::remap(const std::vector<QuestDefinition>& next)
{
    const auto fresh = [&](const std::string& key) -> const QuestDefinition* {
        for (const auto& d : next) if (d.key == key) return &d;
        return nullptr;
    };
    for (auto& [playerId, pq] : players) {
        pq.offerNpc.clear();
        pq.offerQuest.clear();
        for (auto it = pq.quests.begin(); it != pq.quests.end();) {
            const QuestDefinition* d = fresh(it->first);
            QuestProgress& progress = it->second;
            if (!d) {
                it = pq.quests.erase(it);
                continue;
            }
            if (progress.state == QuestState::Active) {
                const QuestStage* stage = d->stage(progress.stage);
                if (!stage) {
                    fmt::print(">> Quest reload dropped '{}' for player {}: stage '{}' no longer exists\n", it->first, playerId, progress.stage);
                    it = pq.quests.erase(it);
                    continue;
                }
                std::map<std::string, uint32_t> counts;
                for (const auto& o : stage->objectives) {
                    const auto old = progress.counts.find(o.key);
                    counts[o.key] = old == progress.counts.end() ? 0 : std::min(old->second, o.count);
                }
                progress.counts = std::move(counts);
            }
            ++it;
        }
        for (auto it = pq.startCounters.begin(); it != pq.startCounters.end();) {
            it = fresh(it->first) ? std::next(it) : pq.startCounters.erase(it);
        }
    }
}

const QuestDefinition* QuestSystem::find(const std::string& key) const
{
    const auto found = index.find(key);
    return found == index.end() ? nullptr : &quests[found->second];
}

QuestState QuestSystem::stateOf(const PlayerQuests& pq, const std::string& key)
{
    const auto found = pq.quests.find(key);
    return found == pq.quests.end() ? QuestState::NotStarted : found->second.state;
}

bool QuestSystem::canStart(const Player* p, const PlayerQuests& pq, const QuestDefinition& d) const
{
    const auto found = pq.quests.find(d.key);
    if (found != pq.quests.end()) {
        const QuestProgress& q = found->second;
        if (q.state == QuestState::Active) return false;
        if (q.state != QuestState::NotStarted && (!d.repeatable || wallClock() < q.finished + d.cooldownSeconds)) return false;
    }
    for (const auto& r : d.requirements) {
        if (!r.quest.empty() && stateOf(pq, r.quest) != r.state) return false;
        if (p->getKarmaLevel() < r.karmaMin || p->getKarmaLevel() > r.karmaMax) return false;
        // Unmet until the account's progress has loaded; guests never meet these.
        if (!r.achievement.empty() && !g_progress.hasAchievement(p, r.achievement)) return false;
        if (!r.stat.empty()) {
            const auto value = g_progress.statValue(p, r.stat);
            if (!value || *value < r.atLeast) return false;
        }
    }
    return true;
}

void QuestSystem::start(Player* p, PlayerQuests& pq, const QuestDefinition& d, const GameEvent* trigger)
{
    QuestProgress& progress = pq.quests[d.key];
    quest_engine::begin(progress, d, wallClock());
    pq.startCounters.erase(d.key);
    if (!d.hidden) g_game.sendStatus(p, "New quest: " + d.name, StatusKind::INFO);
    sendState(p, d, &progress, causeOf(QuestCause::STARTED));
    g_scripts.questHook(p, d.key, "onStart", {});
    g_scripts.questHook(p, d.key, "onStageEnter", {boost::json::string(progress.stage)});
    // The event that started the quest also counts toward its first stage.
    if (trigger && progressEvent(p, progress, d, *trigger)) sendProgress(p, d, progress);
    settle(p, d, progress);
}

bool QuestSystem::progressEvent(Player* p, QuestProgress& q, const QuestDefinition& d, const GameEvent& e)
{
    const QuestStage* stage = d.stage(q.stage);
    if (!stage) return false;
    bool changed = false;
    for (const auto& o : stage->objectives) {
        if (!quest_engine::open(*stage, q, o) || !quest_engine::matches(o, e)) continue;
        if (o.type == ObjectiveType::Bounty) {
            const Player* v = e.victim;
            if (!v || v == p || v->getIP() == p->getIP() || v->getKarmaLevel() < o.minVictimKarma || q.victims.count(v->getID())) continue;
            q.victims.insert(v->getID());
            changed = quest_engine::add(q, o, 1) > 0 || changed;
        } else {
            changed = quest_engine::add(q, o, e.count) > 0 || changed;
        }
    }
    return changed;
}

void QuestSystem::settle(Player* p, const QuestDefinition& d, QuestProgress& q)
{
    for (int step = 0; q.state == QuestState::Active; ++step) {
        if (step == quest_engine::MAX_ADVANCES_PER_EVENT) {
            fmt::print(">> [Warning] quest '{}' advanced {} stages at once; stopping at '{}'\n", d.key, step, q.stage);
            return;
        }
        const QuestStage* stage = d.stage(q.stage);
        const QuestOutcome* outcome = stage ? quest_engine::choose(*stage, q) : nullptr;
        if (!outcome) return;
        if (!pay(p, outcome->rewards)) {
            g_game.sendStatus(p, "Make room in your bag to receive the reward for " + d.name + ".", StatusKind::FAILURE);
            return;
        }
        const std::string from = stage->key;
        quest_engine::advance(q, d, *stage, *outcome, wallClock());
        g_scripts.questHook(p, d.key, "onStageComplete", {boost::json::string(from), boost::json::string(q.history.back().outcome)});
        if (q.state == QuestState::Active) {
            g_scripts.questHook(p, d.key, "onStageEnter", {boost::json::string(q.stage)});
        } else {
            g_scripts.questHook(p, d.key, "onEnd", {boost::json::string(q.state == QuestState::Completed ? q.ending : "fail")});
            g_scripts.questEnded(p, d.key);
        }
        if (!outcome->achievement.empty()) g_progress.grant(p, outcome->achievement);
        if (q.state == QuestState::Completed) g_events.emit({EventType::QuestComplete, p, d.key});
        const std::string paid = describe(outcome->rewards);
        q.history.back().rewards = paid;
        sendState(p, d, &q, causeOf(q.state == QuestState::Completed ? QuestCause::COMPLETED :
                                    q.state == QuestState::Failed    ? QuestCause::FAILED : QuestCause::ADVANCED));
        std::string line;
        if (!d.hidden) {
            line = q.state == QuestState::Completed ? "Quest complete: " + d.name :
                   q.state == QuestState::Failed    ? "Quest failed: " + d.name : "Quest updated: " + d.name;
        }
        if (!paid.empty()) line += (line.empty() ? "You received " : ". You received ") + paid;
        if (!line.empty()) g_game.sendStatus(p, line + ".", StatusKind::INFO);
    }
}

bool QuestSystem::pay(Player* p, const QuestRewards& r)
{
    if (r.empty()) return true;
    Inventory::ExchangePlan exchange;
    if (!g_npcs.planExchange(p, r.caps, {}, r.items, exchange)) return false;
    p->inventory.commitExchange(std::move(exchange));
    return true;
}

void QuestSystem::onGameEvent(const GameEvent& e)
{
    Player* p = e.actor;
    if (!eligible(p) || quests.empty()) return;
    PlayerQuests& pq = players[p->getID()];
    for (auto& [key, q] : pq.quests) {
        if (q.state != QuestState::Active) continue;
        const QuestDefinition* d = find(key);
        if (d && progressEvent(p, q, *d, e)) {
            sendProgress(p, *d, q);
            settle(p, *d, q);
        }
    }
    for (const auto& d : quests) {
        if ((d.eventStarts.empty() && d.useStarts.empty()) || !canStart(p, pq, d)) continue;
        bool begin = false;
        for (const auto& s : d.eventStarts) {
            if (!quest_engine::startMatches(s, e)) continue;
            uint32_t& counter = pq.startCounters[d.key];
            counter = static_cast<uint32_t>(std::min<uint64_t>(uint64_t(counter) + e.count, economy::MAX_QUANTITY));
            if (counter >= s.count) begin = true;
        }
        if (e.type == EventType::Use) {
            for (const auto& u : d.useStarts) if (u.item == e.subject) begin = true;
        }
        if (begin) start(p, pq, d, &e);
    }
}

QuestSystem::TalkResult QuestSystem::onTalk(Player* p, const std::string& npcKey, const std::string& keyword,
                                            bool allowed, const std::string& deniedReply)
{
    if (!eligible(p) || quests.empty()) return {};
    PlayerQuests& pq = players[p->getID()];
    const TalkResult denied{true, deniedReply.empty() ? "I have no work for you." : deniedReply};

    // 1. A confirm="true" offer from this NPC waiting for yes or no.
    if ((keyword == "yes" || keyword == "no") && pq.offerNpc == npcKey && !pq.offerQuest.empty()) {
        const QuestDefinition* d = find(pq.offerQuest);
        pq.offerNpc.clear();
        pq.offerQuest.clear();
        if (!d) return {};
        if (!allowed) return denied;
        if (keyword == "no") return {true, "Another time, then."};
        if (!canStart(p, pq, *d)) return {true, "That offer is no longer open."};
        start(p, pq, *d, nullptr);
        return {true, d->stages.front().journal.empty() ? "Good." : d->stages.front().journal};
    }
    pq.offerNpc.clear();
    pq.offerQuest.clear();

    // 2. Talk and give objectives of the player's active stages.
    for (auto& [key, q] : pq.quests) {
        if (q.state != QuestState::Active) continue;
        const QuestDefinition* d = find(key);
        const QuestStage* stage = d ? d->stage(q.stage) : nullptr;
        if (!stage) continue;
        for (const auto& o : stage->objectives) {
            if ((o.type != ObjectiveType::Talk && o.type != ObjectiveType::Give) || o.npc != npcKey || o.keyword != keyword ||
                !quest_engine::open(*stage, q, o)) continue;
            if (!allowed) return denied;
            uint32_t amount = 1;
            if (o.type == ObjectiveType::Give) {
                // Partial hand-ins: whatever the player has, up to what is still owed.
                const auto have = q.counts.find(o.key);
                const uint32_t owed = o.count - std::min(o.count, have == q.counts.end() ? 0 : have->second);
                amount = std::min(owed, g_npcs.takeable(p, o.iid));
                Inventory::ExchangePlan exchange;
                if (!amount || !g_npcs.planExchange(p, 0, {{o.iid, amount}}, {}, exchange))
                    return {true, "Bring me " + std::to_string(owed) + " " + itemName(o.iid) + "."};
                p->inventory.commitExchange(std::move(exchange));
            }
            quest_engine::add(q, o, amount);
            const bool finished = quest_engine::done(q, o);
            const auto now = q.counts.find(o.key);
            const std::string reply = finished ? (o.reply.empty() ? "Thank you." : o.reply)
                : fmt::format("Thank you. Bring me {} more.", o.count - (now == q.counts.end() ? 0 : now->second));
            sendProgress(p, *d, q);
            settle(p, *d, q);
            return {true, reply};
        }
    }

    // 3. Talk starts.
    for (const auto& d : quests) {
        for (const auto& s : d.talkStarts) {
            if (s.npc != npcKey || s.keyword != keyword || !canStart(p, pq, d)) continue;
            if (!allowed) return denied;
            if (s.confirm) {
                pq.offerNpc = npcKey;
                pq.offerQuest = d.key;
                return {true, s.text + " Say {yes} or {no}."};
            }
            start(p, pq, d, nullptr);
            return {true, s.text};
        }
    }

    // 4. Lines gated by the player's stage or state.
    for (const auto& d : quests) {
        for (const auto& r : d.dialogue) {
            if (r.npc != npcKey || r.keyword != keyword) continue;
            const auto found = pq.quests.find(d.key);
            const QuestState state = found == pq.quests.end() ? QuestState::NotStarted : found->second.state;
            if (!r.stage.empty() && (state != QuestState::Active || found->second.stage != r.stage)) continue;
            if (r.stage.empty() && r.state && *r.state != state) continue;
            if (!allowed) return denied;
            return {true, r.text};
        }
    }
    return {};
}

std::string QuestSystem::offersAt(const Player* p, const std::string& npcKey) const
{
    static const PlayerQuests nobody;
    const auto found = players.find(p->getID());
    const PlayerQuests& pq = found == players.end() ? nobody : found->second;
    std::string words;
    for (const auto& d : quests) {
        if (d.hidden) continue;
        for (const auto& s : d.talkStarts) {
            if (s.npc == npcKey && canStart(p, pq, d)) words += (words.empty() ? "{" : ", {") + s.keyword + "}";
        }
    }
    return words.empty() ? "I have no new work for you." : "Ask me about " + words + ".";
}

void QuestSystem::sendState(Player* p, const QuestDefinition& d, const QuestProgress* q, uint8_t cause)
{
    dirtyMarkers.insert(p->getID());
    if (d.hidden) return;
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::QUEST_STATE));
    msg.add<uint16_t>(static_cast<uint16_t>(&d - quests.data()));
    msg.addByte(cause);
    msg.addString(q ? questJournalJson(d, *q, MAX_ENTRY_BYTES) : std::string());
    p->sendNetworkMessage(msg);
}

// Every objective of the current stage, in order: a handful of bytes each, and
// the client never has to guess which one moved.
void QuestSystem::sendProgress(Player* p, const QuestDefinition& d, const QuestProgress& q)
{
    dirtyMarkers.insert(p->getID());
    const QuestStage* stage = d.stage(q.stage);
    if (d.hidden || !stage) return;
    for (size_t i = 0; i < stage->objectives.size(); ++i) {
        const auto count = q.counts.find(stage->objectives[i].key);
        NetworkMessage msg;
        msg.addByte(static_cast<uint8_t>(ServerOpcode::QUEST_PROGRESS));
        msg.add<uint16_t>(static_cast<uint16_t>(&d - quests.data()));
        msg.addByte(static_cast<uint8_t>(i));
        msg.add<uint32_t>(count == q.counts.end() ? 0 : count->second);
        p->sendNetworkMessage(msg);
    }
}

// kind 2 (?) where an active stage waits on this NPC, else 1 (!) where a quest
// can be started here. An NPC whose karma rule refuses the player shows nothing.
std::string QuestSystem::markers(const Player* p, const PlayerQuests& pq) const
{
    std::map<uint16_t, uint8_t> kinds;
    const auto mark = [&](const std::string& npc, uint8_t kind) {
        const uint16_t id = g_npcs.npcId(npc);
        if (!id || !g_npcs.questsAllowed(npc, p)) return;
        uint8_t& current = kinds[id];
        current = std::max(current, kind);
    };
    for (const auto& [key, q] : pq.quests) {
        const QuestDefinition* d = q.state == QuestState::Active ? find(key) : nullptr;
        const QuestStage* stage = d && !d->hidden ? d->stage(q.stage) : nullptr;
        if (!stage) continue;
        for (const auto& o : stage->objectives) {
            if ((o.type == ObjectiveType::Talk || o.type == ObjectiveType::Give) && quest_engine::open(*stage, q, o)) mark(o.npc, 2);
        }
    }
    for (const auto& d : quests) {
        if (d.hidden || d.talkStarts.empty() || !canStart(p, pq, d)) continue;
        for (const auto& s : d.talkStarts) mark(s.npc, 1);
    }
    std::string out;
    for (const auto& [id, kind] : kinds) {
        out.push_back(static_cast<char>(id & 0xFF));
        out.push_back(static_cast<char>(id >> 8));
        out.push_back(static_cast<char>(kind));
    }
    return out;
}

void QuestSystem::sendMarkers(Player* p, PlayerQuests& pq, bool force)
{
    std::string payload = markers(p, pq);
    if (!force && payload == pq.sentMarkers) return;
    pq.sentMarkers = std::move(payload);
    const size_t n = std::min<size_t>(pq.sentMarkers.size() / 3, 255);
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::QUEST_MARKERS));
    msg.addByte(static_cast<uint8_t>(n));
    for (size_t i = 0; i < n; ++i) {
        const auto* entry = reinterpret_cast<const uint8_t*>(pq.sentMarkers.data() + i * 3);
        msg.add<uint16_t>(static_cast<uint16_t>(entry[0] | (entry[1] << 8)));
        msg.addByte(entry[2]);
    }
    p->sendNetworkMessage(msg);
}

void QuestSystem::sync(Player* p)
{
    if (!p) return;
    PlayerQuests& pq = players[p->getID()];
    NetworkMessage reset;
    reset.addByte(static_cast<uint8_t>(ServerOpcode::QUEST_STATE));
    reset.add<uint16_t>(0xFFFF);
    reset.addByte(causeOf(QuestCause::RESET));
    reset.addString(std::string());
    p->sendNetworkMessage(reset);
    for (const auto& [key, q] : pq.quests) {
        const QuestDefinition* d = find(key);
        if (d && q.state != QuestState::NotStarted) sendState(p, *d, &q, causeOf(QuestCause::SYNC));
    }
    if (eligible(p)) sendMarkers(p, pq, true);
}

void QuestSystem::action(Player* p, uint16_t questId, uint8_t action)
{
    if (!eligible(p)) return;
    PlayerQuests& pq = players[p->getID()];
    const uint64_t now = nowMs();
    if (now < pq.lastAction + 250) return;
    pq.lastAction = now;
    if (action == static_cast<uint8_t>(QuestAction::RESYNC)) {
        sync(p);
        return;
    }
    if (action != static_cast<uint8_t>(QuestAction::ABANDON) || questId >= quests.size()) return;
    const QuestDefinition& d = quests[questId];
    const auto found = pq.quests.find(d.key);
    if (found == pq.quests.end() || found->second.state != QuestState::Active || d.hidden) return;
    if (!d.abandon) {
        g_game.sendStatus(p, d.name + " cannot be abandoned.", StatusKind::FAILURE);
        return;
    }
    pq.quests.erase(found);
    pq.startCounters.erase(d.key);
    g_scripts.questEnded(p, d.key);
    sendState(p, d, nullptr, causeOf(QuestCause::REMOVED));
    g_game.sendStatus(p, "Quest abandoned: " + d.name + ".", StatusKind::INFO);
}

// Every 500 ms: which quest areas each player is in. Crossing an edge is an
// EnterArea / LeaveArea event, like any other, for objectives, starts,
// account stats and scripts.
void QuestSystem::checkAreas()
{
    bool any = false;
    for (const auto& d : quests) any = any || !d.areas.empty();
    if (!any) {
        insideAreas.clear();
        return;
    }
    const auto& structures = g_structures.getSpawnedStructures();
    for (const auto& [id, p] : g_game.getPlayers()) {
        if (!eligible(p)) continue;
        const Position& pos = p->getPosition();
        const int32_t tx = static_cast<int32_t>(pos.x) / TILE_SIZE, ty = static_cast<int32_t>(pos.y) / TILE_SIZE;
        std::set<std::string> now;
        for (const auto& d : quests) {
            for (const auto& a : d.areas) {
                bool in = false;
                if (a.kind == QuestArea::Kind::Structure) {
                    for (const auto& s : structures) {
                        if (s.templateId == a.structure && tx >= s.rect.x1 && tx < s.rect.x2 && ty >= s.rect.y1 && ty < s.rect.y2) {
                            in = true;
                            break;
                        }
                    }
                } else {
                    const Position* centre = nullptr;
                    Position point;
                    if (a.kind == QuestArea::Kind::Npc) centre = g_npcs.spawnPosition(a.npc);
                    else { point = Position(a.x, a.y); centre = &point; }
                    if (centre) {
                        const double dx = double(pos.x) - centre->x, dy = double(pos.y) - centre->y;
                        in = dx * dx + dy * dy <= double(a.radius) * a.radius;
                    }
                }
                if (in) now.insert(a.id);
            }
        }
        std::set<std::string>& before = insideAreas[id];
        for (const auto& area : now)
            if (!before.count(area)) g_events.emit({EventType::EnterArea, p, area});
        for (const auto& area : before)
            if (!now.count(area)) g_events.emit({EventType::LeaveArea, p, area});
        before = std::move(now);
    }
}

void QuestSystem::update(uint32_t elapsedMs)
{
    areaSweepMs += elapsedMs;
    if (areaSweepMs >= 500) {
        areaSweepMs = 0;
        checkAreas();
    }
    // Karma and cooldowns change what a player may start without any quest
    // event, so every player is looked at again now and then.
    markerSweepMs += elapsedMs;
    if (markerSweepMs >= MARKER_SWEEP_MS) {
        markerSweepMs = 0;
        for (const auto& [playerId, pq] : players) dirtyMarkers.insert(playerId);
    }
    for (const uint32_t playerId : dirtyMarkers) {
        Player* p = g_game.getPlayerByID(playerId);
        const auto found = players.find(playerId);
        if (eligible(p) && found != players.end()) sendMarkers(p, found->second, false);
    }
    dirtyMarkers.clear();
}

namespace {
const char* stateName(QuestState state)
{
    switch (state) {
    case QuestState::Active: return "active";
    case QuestState::Completed: return "completed";
    case QuestState::Failed: return "failed";
    default: return "not_started";
    }
}
}

boost::json::object QuestSystem::scriptContext(const Player* p, const std::string& questKey) const
{
    boost::json::object ctx, states;
    const auto found = players.find(p->getID());
    if (found != players.end()) {
        for (const auto& [key, q] : found->second.quests) states[key] = stateName(q.state);
        const auto q = questKey.empty() ? found->second.quests.end() : found->second.quests.find(questKey);
        if (q != found->second.quests.end()) {
            boost::json::object counts, vars;
            for (const auto& [objective, count] : q->second.counts) counts[objective] = count;
            for (const auto& [name, value] : q->second.vars) vars[name] = value;
            ctx["quest"] = boost::json::object{{"key", questKey}, {"state", stateName(q->second.state)},
                {"stage", q->second.stage}, {"counts", std::move(counts)}, {"vars", std::move(vars)}};
        }
    }
    ctx["quests"] = std::move(states);
    return ctx;
}

std::vector<std::string> QuestSystem::activeQuests(const Player* p) const
{
    std::vector<std::string> out;
    const auto found = players.find(p->getID());
    if (found == players.end()) return out;
    for (const auto& [key, q] : found->second.quests)
        if (q.state == QuestState::Active) out.push_back(key);
    return out;
}

bool QuestSystem::scriptStart(Player* p, const std::string& key)
{
    const QuestDefinition* d = find(key);
    if (!d || !eligible(p)) return false;
    PlayerQuests& pq = players[p->getID()];
    if (!canStart(p, pq, *d)) return false;
    start(p, pq, *d, nullptr);
    return true;
}

bool QuestSystem::scriptStage(Player* p, const std::string& key, const std::string& stageKey)
{
    const QuestDefinition* d = find(key);
    const QuestStage* stage = d ? d->stage(stageKey) : nullptr;
    const auto found = players.find(p->getID());
    if (!stage || found == players.end()) return false;
    const auto q = found->second.quests.find(key);
    if (q == found->second.quests.end() || q->second.state != QuestState::Active) return false;
    q->second.history.push_back({q->second.stage, "script", stageKey, ""});
    quest_engine::enter(q->second, *stage);
    sendState(p, *d, &q->second, causeOf(QuestCause::ADVANCED));
    g_scripts.questHook(p, key, "onStageEnter", {boost::json::string(stageKey)});
    return true;
}

bool QuestSystem::scriptEnd(Player* p, const std::string& key, const std::string& endingKey)
{
    const QuestDefinition* d = find(key);
    const auto found = players.find(p->getID());
    if (!d || found == players.end() || (!endingKey.empty() && !d->ending(endingKey))) return false;
    const auto it = found->second.quests.find(key);
    if (it == found->second.quests.end() || it->second.state != QuestState::Active) return false;
    QuestProgress& q = it->second;
    q.history.push_back({q.stage, "script", endingKey.empty() ? "fail" : "end:" + endingKey, ""});
    q.state = endingKey.empty() ? QuestState::Failed : QuestState::Completed;
    q.ending = endingKey;
    q.stage.clear();
    q.counts.clear();
    q.finished = wallClock();
    sendState(p, *d, &q, causeOf(endingKey.empty() ? QuestCause::FAILED : QuestCause::COMPLETED));
    if (!d->hidden) g_game.sendStatus(p, (endingKey.empty() ? "Quest failed: " : "Quest complete: ") + d->name + ".", StatusKind::INFO);
    if (!endingKey.empty()) g_events.emit({EventType::QuestComplete, p, d->key});
    g_scripts.questHook(p, key, "onEnd", {boost::json::string(endingKey.empty() ? "fail" : endingKey)});
    g_scripts.questEnded(p, key);
    return true;
}

bool QuestSystem::scriptVar(Player* p, const std::string& key, const std::string& name, const boost::json::value& value, bool add)
{
    const auto found = players.find(p->getID());
    if (found == players.end()) return false;
    const auto q = found->second.quests.find(key);
    if (q == found->second.quests.end() || q->second.state != QuestState::Active) return false;
    auto& vars = q->second.vars;
    if (!vars.count(name) && vars.size() >= 16) return false;
    if (add) {
        const auto old = vars.find(name);
        const double base = old != vars.end() && old->second.is_double() ? old->second.get_double() : 0.0;
        vars[name] = base + value.to_number<double>();
    } else {
        vars[name] = value;
    }
    return true;
}

std::map<std::string, int> QuestSystem::states(const Player* p) const
{
    std::map<std::string, int> out;
    const auto found = players.find(p->getID());
    if (found == players.end()) return out;
    for (const auto& [key, q] : found->second.quests) out[key] = static_cast<int>(q.state);
    return out;
}

std::vector<std::pair<std::string, std::string>> QuestSystem::npcReferences() const
{
    std::vector<std::pair<std::string, std::string>> out;
    for (const auto& d : quests) {
        for (const auto& s : d.talkStarts) out.emplace_back(s.npc, d.key);
        for (const auto& s : d.stages)
            for (const auto& o : s.objectives)
                if (!o.npc.empty()) out.emplace_back(o.npc, d.key);
        for (const auto& r : d.dialogue) out.emplace_back(r.npc, d.key);
    }
    return out;
}

void QuestSystem::forget(uint32_t playerId)
{
    g_scripts.forget(playerId);
    insideAreas.erase(playerId);
    players.erase(playerId);
    dirtyMarkers.erase(playerId);
}

std::string QuestSystem::admin(Player* p, const std::string& action, const std::string& key, const std::string& argument)
{
    const QuestDefinition* d = find(key);
    if (!d) return "Unknown quest '" + key + "'.";
    PlayerQuests& pq = players[p->getID()];
    if (action == "start") {
        pq.quests.erase(key);
        start(p, pq, *d, nullptr);
        return "Started " + key + " for " + p->getName() + ".";
    }
    if (action == "reset") {
        pq.quests.erase(key);
        pq.startCounters.erase(key);
        g_scripts.questEnded(p, key);
        sendState(p, *d, nullptr, causeOf(QuestCause::REMOVED));
        return "Reset " + key + " for " + p->getName() + ".";
    }
    if (action == "stage") {
        const QuestStage* stage = d->stage(argument);
        if (!stage) return "Quest " + key + " has no stage '" + argument + "'.";
        QuestProgress& q = pq.quests[key];
        if (q.state != QuestState::Active) quest_engine::begin(q, *d, wallClock());
        quest_engine::enter(q, *stage);
        sendState(p, *d, &q, causeOf(QuestCause::SYNC));
        return "Moved " + p->getName() + " to " + key + ":" + argument + ".";
    }
    if (action == "complete") {
        const QuestEnding* ending = argument.empty() ? &d->endings.front() : d->ending(argument);
        if (!ending) return "Quest " + key + " has no ending '" + argument + "'.";
        QuestProgress& q = pq.quests[key];
        if (q.state == QuestState::NotStarted) quest_engine::begin(q, *d, wallClock());
        q.state = QuestState::Completed;
        q.ending = ending->key;
        q.stage.clear();
        q.counts.clear();
        q.finished = wallClock();
        g_scripts.questEnded(p, key);
        sendState(p, *d, &q, causeOf(QuestCause::COMPLETED));
        return "Completed " + key + " (" + ending->key + ") for " + p->getName() + " without rewards.";
    }
    return "Usage: !quest=start|stage|reset|complete:<guid>:<quest>[:<stage or ending>]";
}
