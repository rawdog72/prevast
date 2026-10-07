// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/account_runs.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/progress/progress_loader.h"
#include "gameplay/quests/quest_engine.h"
#include "gameplay/agent.h"
#include "gameplay/game.h"
#include "gameplay/npc.h"
#include "gameplay/object.h"
#include "gameplay/player.h"
#include "gameplay/resource.h"
#include "content/configmanager.h"
#include "content/xml_utils.h"
#include "network/http_client.h"
#include "network/networkmessage.h"
#include "network/opcodes.h"
#include <boost/json.hpp>
#include <filesystem>
#include <fstream>

extern Game g_game;
ProgressSystem g_progress;

// `pr` prefixes: the project builds with unity files, where an unprefixed
// file-local name collides with another .cpp's (quest_system.cpp has its own
// eligible and nowMs).

namespace prjson = boost::json;

namespace {
constexpr uint32_t PR_FLUSH_MS = 30000;
constexpr uint32_t PR_PUSH_MS = 2000;
constexpr uint32_t PR_MINUTE_MS = 60000;
constexpr uint32_t PR_MAX_BACKOFF_MS = 300000;
constexpr uint64_t PR_FETCH_RETRY_S = 30;
constexpr size_t PR_MAX_ACCOUNTS_PER_BATCH = 200;
constexpr size_t PR_MAX_STATE_BYTES = 7900;
constexpr uint64_t PR_MAX_VALUE = 9007199254740991ULL; // 2^53 - 1: what JSON and the database both keep exactly

uint64_t prWallSeconds()
{
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
uint64_t prNowMs() { return static_cast<uint64_t>(OTSYS_TIME()); }

uint64_t prSaturatingAdd(uint64_t a, uint64_t b) { return a > PR_MAX_VALUE - std::min(b, PR_MAX_VALUE) ? PR_MAX_VALUE : a + b; }

std::filesystem::path prOutboxPath()
{
    return std::filesystem::path(getString(ConfigManager::STORAGE_PATH)) / "progress-outbox.json";
}

HttpClient::Headers prAuthHeaders()
{
    return {{"X-Account-Progress-Token", getString(ConfigManager::ACCOUNT_PROGRESS_TOKEN)}};
}

std::string prServiceUrl(const std::string& path)
{
    std::string base = getString(ConfigManager::ACCOUNT_SERVICE_URL);
    while (!base.empty() && base.back() == '/') base.pop_back();
    return base + path;
}

prjson::object prDeltaJson(uint32_t accountId, const ProgressDelta& d)
{
    prjson::object add, max;
    for (const auto& [id, n] : d.add) add[std::to_string(id)] = n;
    for (const auto& [id, n] : d.max) max[std::to_string(id)] = n;
    prjson::array unlock, revoke;
    for (const auto& [id, at] : d.unlock) unlock.push_back(prjson::object{{"id", id}, {"at", at}});
    for (const uint16_t id : d.revoke) revoke.push_back(id);
    return prjson::object{{"accountId", accountId}, {"add", std::move(add)}, {"max", std::move(max)},
        {"unlock", std::move(unlock)}, {"revoke", std::move(revoke)}};
}

uint64_t prJsonNumber(const prjson::value& v)
{
    if (v.is_uint64()) return std::min(v.get_uint64(), PR_MAX_VALUE);
    if (v.is_int64()) return v.get_int64() < 0 ? 0 : std::min<uint64_t>(v.get_int64(), PR_MAX_VALUE);
    if (v.is_double()) return v.get_double() < 0 ? 0 : static_cast<uint64_t>(std::min<double>(v.get_double(), double(PR_MAX_VALUE)));
    throw std::runtime_error("expected a number");
}

uint16_t prJsonId(std::string_view text)
{
    uint32_t id = 0;
    const auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), id);
    if (ec != std::errc() || end != text.data() + text.size() || !id || id > 65535) throw std::runtime_error("bad id");
    return static_cast<uint16_t>(id);
}

ProgressDelta prDeltaFrom(const prjson::object& o)
{
    ProgressDelta d;
    for (const auto& [id, n] : o.at("add").as_object()) d.add[prJsonId(id)] = prJsonNumber(n);
    for (const auto& [id, n] : o.at("max").as_object()) d.max[prJsonId(id)] = prJsonNumber(n);
    for (const auto& u : o.at("unlock").as_array()) {
        const auto& entry = u.as_object();
        d.unlock[static_cast<uint16_t>(prJsonNumber(entry.at("id")))] = prJsonNumber(entry.at("at"));
    }
    for (const auto& r : o.at("revoke").as_array()) d.revoke.insert(static_cast<uint16_t>(prJsonNumber(r)));
    return d;
}

bool prEligible(const Player* p) { return p && !p->isGhoul(); }
}

// ---------------------------------------------------------------------------
// Pure rules (covered by --selftest)
// ---------------------------------------------------------------------------

void ProgressDelta::merge(const ProgressDelta& other)
{
    for (const auto& [id, n] : other.add) add[id] = prSaturatingAdd(add[id], n);
    for (const auto& [id, n] : other.max) max[id] = std::max(max[id], n);
    for (const uint16_t id : other.revoke) {
        unlock.erase(id);
        revoke.insert(id);
    }
    for (const auto& [id, at] : other.unlock) {
        revoke.erase(id);
        unlock.emplace(id, at);
    }
}

bool progress_rules::counts(const StatCount& c, const GameEvent& e, const std::string& family)
{
    if (c.event != e.type) return false;
    if (!c.target.empty() && c.target != e.subject) return false;
    if (!c.family.empty() && c.family != family) return false;
    return quest_engine::ownerMatches(c.owner, e.owner);
}

bool progress_rules::met(const AchievementDefinition& a, const std::map<uint16_t, uint64_t>& values)
{
    if (a.requirements.empty()) return false;
    for (const auto& r : a.requirements) {
        const auto found = values.find(r.stat);
        if (found == values.end() || found->second < r.atLeast) return false;
    }
    return true;
}

void progress_rules::apply(std::map<uint16_t, uint64_t>& values, const ProgressDelta& d)
{
    for (const auto& [id, n] : d.add) values[id] = prSaturatingAdd(values[id], n);
    for (const auto& [id, n] : d.max) values[id] = std::max(values[id], n);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

bool ProgressSystem::load(const std::string& statsFile, const std::string& achievementsFile)
{
    g_accountRuns.configure(statsFile);
    try {
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
        refs.family = [](const std::string& f) { return g_agents.hasFamily(f); };

        pugi::xml_document statsDoc, achievementsDoc;
        const pugi::xml_node statsRoot = xml_utils::openDataFile(statsDoc, statsFile, "stats");
        if (!statsRoot) return false;
        std::vector<StatDefinition> nextStats = progress_loader::parseStats(statsRoot, refs);
        const pugi::xml_node achievementsRoot = xml_utils::openDataFile(achievementsDoc, achievementsFile, "achievements");
        if (!achievementsRoot) return false;
        std::vector<AchievementDefinition> nextAchievements = progress_loader::parseAchievements(achievementsRoot, nextStats, refs);

        stats = std::move(nextStats);
        achievements = std::move(nextAchievements);
        byStat.clear();
        for (const auto& a : achievements)
            for (const auto& r : a.requirements) byStat[r.stat].push_back(&a);
        fmt::print(">> Progress: {} stats, {} achievements{}\n", stats.size(), achievements.size(),
            enabled() ? "" : " (not recorded on this server)");
        return true;
    } catch (const std::exception& e) {
        fmt::print(">> Progress configuration rejected: {}\n", e.what());
        return false;
    }
}

bool ProgressSystem::enabled() const
{
    return getBoolean(ConfigManager::RECORD_ACCOUNT_PROGRESS) && getBoolean(ConfigManager::USE_DATABASE)
        && !getString(ConfigManager::ACCOUNT_SERVICE_URL).empty() && !getString(ConfigManager::ACCOUNT_PROGRESS_TOKEN).empty();
}

const StatDefinition* ProgressSystem::stat(const std::string& key) const
{
    for (const auto& s : stats) if (s.key == key) return &s;
    return nullptr;
}

const AchievementDefinition* ProgressSystem::achievement(const std::string& key) const
{
    for (const auto& a : achievements) if (a.key == key) return &a;
    return nullptr;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

ProgressSystem::Account* ProgressSystem::accountOf(const Player* p)
{
    if (!p || !p->getAccountId() || !enabled()) return nullptr;
    return &accounts[p->getAccountId()];
}

const ProgressSystem::Account* ProgressSystem::accountOf(const Player* p) const
{
    if (!p || !p->getAccountId()) return nullptr;
    const auto found = accounts.find(p->getAccountId());
    return found == accounts.end() ? nullptr : &found->second;
}

Player* ProgressSystem::playerOf(const Account& account) const
{
    return account.playerId ? g_game.getPlayerByID(account.playerId) : nullptr;
}

void ProgressSystem::attach(Player* p)
{
    g_accountRuns.attach(p);
    if (!p) return;
    Account* account = accountOf(p);
    if (!account) {
        sendState(p, nullptr);
        return;
    }
    account->playerId = p->getID();
    lives.try_emplace(p->getID());
    if (!account->loaded && !account->loading) fetch(p->getAccountId());
    sendState(p, account);
}

void ProgressSystem::detach(uint32_t playerId)
{
    g_accountRuns.finish(g_game.getPlayerByID(playerId), false);
    lives.erase(playerId);
    for (auto& [accountId, account] : accounts) {
        if (account.playerId != playerId) continue;
        account.playerId = 0;
        // Leaving is a good moment to store what this character did.
        if (!account.pending.empty()) flushMs = PR_FLUSH_MS;
    }
}

void ProgressSystem::sessionLost(const Player* p)
{
    const Account* account = accountOf(p);
    if (account && !account->pending.empty()) flushMs = PR_FLUSH_MS;
}

void ProgressSystem::fetch(uint32_t accountId)
{
    Account& account = accounts[accountId];
    account.loading = true;
    HttpClient::requestAsync("GET", prServiceUrl("/api/servers/progress/" + std::to_string(accountId)), prAuthHeaders(), "",
        [this, accountId](HttpClient::Response r) { onFetched(accountId, r.status, r.body); });
}

ProgressDelta ProgressSystem::unstored(uint32_t accountId, const Account& account) const
{
    ProgressDelta d;
    for (const auto& batch : outbox) {
        const auto found = batch.accounts.find(accountId);
        if (found != batch.accounts.end()) d.merge(found->second);
    }
    d.merge(account.pending);
    return d;
}

void ProgressSystem::onFetched(uint32_t accountId, int status, const std::string& body)
{
    const auto found = accounts.find(accountId);
    if (found == accounts.end()) return;
    Account& account = found->second;
    account.loading = false;
    std::map<uint16_t, uint64_t> values, unlocked;
    try {
        if (status != 200) throw std::runtime_error("HTTP " + std::to_string(status));
        const prjson::object o = prjson::parse(body).as_object();
        for (const auto& [id, n] : o.at("stats").as_object()) values[prJsonId(id)] = prJsonNumber(n);
        for (const auto& a : o.at("achievements").as_array()) {
            const auto& entry = a.as_object();
            unlocked[static_cast<uint16_t>(prJsonNumber(entry.at("id")))] = prJsonNumber(entry.at("unlockedAt"));
        }
    } catch (const std::exception& e) {
        fmt::print(">> [Warning] account progress for account {} could not be loaded ({}); retrying in {} s\n",
            accountId, e.what(), PR_FETCH_RETRY_S);
        account.retryAt = prWallSeconds() + PR_FETCH_RETRY_S;
        return;
    }
    // What this server has not stored yet goes on top of what the web host has.
    const ProgressDelta mine = unstored(accountId, account);
    progress_rules::apply(values, mine);
    for (const uint16_t id : mine.revoke) unlocked.erase(id);
    for (const auto& [id, at] : mine.unlock) unlocked.emplace(id, at);
    account.values = std::move(values);
    account.unlocked = std::move(unlocked);
    account.loaded = true;
    account.changed.clear();

    std::vector<const AchievementDefinition*> all;
    for (const auto& a : achievements) all.push_back(&a);
    evaluate(accountId, account, all);
    if (Player* p = playerOf(account)) sendState(p, &account);
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

void ProgressSystem::onGameEvent(const GameEvent& e)
{
    Player* p = e.actor;
    if (!prEligible(p) || stats.empty()) return;
    if (e.type == EventType::Bounty && (!e.victim || e.victim->isGhoul() || e.victim->getKarmaLevel() < g_accountRuns.outlawMinKarma())) return;
    const uint32_t accountId = p->getAccountId();
    Account* account = accountOf(p);
    if (account) {
        std::string family;
        if (e.type == EventType::Kill) {
            if (const AgentData* agent = g_agents.getAgentData(std::string(e.subject))) family = agent->family;
        }
        for (const auto& s : stats) {
            if (s.retired) continue;
            for (const auto& c : s.counts) {
                if (!progress_rules::counts(c, e, family)) continue;
                bump(accountId, *account, s, e.count, p);
                break; // one event adds to a stat once, however many of its counts match
            }
        }
    }
    // A death ends the life that per-life records are counted over.
    if (e.type == EventType::Death) lives.erase(p->getID());
}

void ProgressSystem::bump(uint32_t accountId, Account& account, const StatDefinition& s, uint64_t amount, Player* actor)
{
    const uint64_t before = account.loaded ? account.values[s.id] : 0;
    if (s.aggregate == StatAggregate::Sum) {
        account.pending.add[s.id] = prSaturatingAdd(account.pending.add[s.id], amount);
        if (account.loaded) account.values[s.id] = prSaturatingAdd(account.values[s.id], amount);
    } else {
        uint64_t& record = lives[actor->getID()].records[s.id];
        record = prSaturatingAdd(record, amount);
        account.pending.max[s.id] = std::max(account.pending.max[s.id], record);
        if (account.loaded) account.values[s.id] = std::max(account.values[s.id], record);
    }
    if (!account.loaded || account.values[s.id] == before) return;
    account.changed.insert(s.id);
    const auto dependents = byStat.find(s.id);
    if (dependents != byStat.end()) evaluate(accountId, account, dependents->second);
}

void ProgressSystem::evaluate(uint32_t accountId, Account& account, const std::vector<const AchievementDefinition*>& candidates)
{
    for (const AchievementDefinition* a : candidates) {
        if (!a->retired && !account.unlocked.count(a->id) && progress_rules::met(*a, account.values))
            unlock(accountId, account, *a, true);
    }
}

void ProgressSystem::unlock(uint32_t, Account& account, const AchievementDefinition& a, bool rewards)
{
    if (a.retired || account.unlocked.count(a.id)) return;
    const uint64_t at = prWallSeconds();
    account.unlocked[a.id] = at;
    account.pending.revoke.erase(a.id);
    account.pending.unlock[a.id] = at;
    Player* p = playerOf(account);
    if (!p) return;

    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::ACHIEVEMENT_UNLOCKED));
    msg.add<uint16_t>(a.id);
    msg.add<uint32_t>(static_cast<uint32_t>(std::min<uint64_t>(at, UINT32_MAX)));
    msg.addString(prjson::serialize(prjson::object{{"name", a.name}, {"description", a.description}}));
    p->sendNetworkMessage(msg);
    g_game.sendStatus(p, "Achievement unlocked: " + a.name + (a.points ? fmt::format(" (+{} points)", a.points) : std::string()) + ".",
        StatusKind::INFO);
    if (rewards) { payRewards(p, a); g_accountRuns.achievement(p, a.key); }
    if (a.announce) {
        g_game.broadcastServerLog(ServerLogKind::SYSTEM, SERVER_LOG_NO_PLAYER, SERVER_LOG_NO_PLAYER,
            p->getName() + " earned the achievement " + a.name + ".");
    }
}

// Paid at once when it fits. An unlock is never held back by a full bag:
// items that do not fit are dropped at the player's feet.
void ProgressSystem::payRewards(Player* p, const AchievementDefinition& a)
{
    if (a.rewards.empty()) return;
    Inventory::ExchangePlan exchange;
    if (g_npcs.planExchange(p, a.rewards.caps, {}, a.rewards.items, exchange)) {
        p->inventory.commitExchange(std::move(exchange));
        return;
    }
    if (a.rewards.caps) {
        Inventory::ExchangePlan caps;
        if (g_npcs.planExchange(p, a.rewards.caps, {}, {}, caps)) p->inventory.commitExchange(std::move(caps));
        else g_game.sendStatus(p, "Your purse is full; the caps for " + a.name + " were lost.", StatusKind::FAILURE);
    }
    std::vector<Game::LootDrop> drops;
    for (const auto& [iid, count] : a.rewards.items) {
        const ItemData* data = ItemManager::getInstance().getItemData(iid);
        if (!data) continue;
        for (uint32_t left = count; left;) {
            const auto n = static_cast<uint8_t>(std::min<uint32_t>(left, std::max<uint32_t>(1, std::min<uint32_t>(data->stack, 255))));
            drops.push_back({ data->lootId, iid, n, ItemState::fresh(iid) });
            left -= n;
        }
    }
    g_game.dropLootBurst(p->getPosition(), drops);
    g_game.sendStatus(p, "Your bag was full; the reward for " + a.name + " is on the ground.", StatusKind::INFO);
}

bool ProgressSystem::grant(Player* p, const std::string& key)
{
    const AchievementDefinition* a = achievement(key);
    Account* account = accountOf(p);
    if (!a || !account || !account->loaded) return false;
    unlock(p->getAccountId(), *account, *a, true);
    return true;
}

bool ProgressSystem::hasAchievement(const Player* p, const std::string& key) const
{
    const AchievementDefinition* a = achievement(key);
    const Account* account = accountOf(p);
    return a && account && account->loaded && account->unlocked.count(a->id);
}

std::optional<uint64_t> ProgressSystem::statValue(const Player* p, const std::string& key) const
{
    const StatDefinition* s = stat(key);
    const Account* account = accountOf(p);
    if (!s || !account || !account->loaded) return std::nullopt;
    const auto found = account->values.find(s->id);
    return found == account->values.end() ? 0 : found->second;
}

std::optional<std::pair<prjson::object, prjson::object>> ProgressSystem::scriptView(const Player* p) const
{
    const Account* account = accountOf(p);
    if (!account || !account->loaded) return std::nullopt;
    prjson::object values, unlocked;
    for (const auto& s : stats) {
        const auto found = account->values.find(s.id);
        values[s.key] = found == account->values.end() ? 0 : found->second;
    }
    for (const auto& a : achievements)
        if (account->unlocked.count(a.id)) unlocked[a.key] = true;
    return std::make_pair(std::move(values), std::move(unlocked));
}

std::string ProgressSystem::admin(Player* p, const std::string& action, const std::string& key)
{
    const AchievementDefinition* a = achievement(key);
    if (!a) return "Unknown achievement '" + key + "'.";
    Account* account = accountOf(p);
    if (!account) return p->getName() + " has no account progress on this server.";
    if (!account->loaded) return p->getName() + "'s progress is still loading; try again in a moment.";
    if (action == "grant") {
        g_accountRuns.disqualify(p);
        if (account->unlocked.count(a->id)) return p->getName() + " already has " + a->name + ".";
        unlock(p->getAccountId(), *account, *a, true);
        return "Granted " + a->name + " to " + p->getName() + ".";
    }
    if (action == "revoke") {
        if (!account->unlocked.erase(a->id)) return p->getName() + " does not have " + a->name + ".";
        account->pending.unlock.erase(a->id);
        account->pending.revoke.insert(a->id);
        sendState(p, account);
        return "Revoked " + a->name + " from " + p->getName() + " (rewards are not taken back).";
    }
    return "Usage: !achievement=grant|revoke:<guid>:<key>";
}

// ---------------------------------------------------------------------------
// The tick: survival minutes, client pushes, batches
// ---------------------------------------------------------------------------

void ProgressSystem::update(uint32_t elapsedMs)
{
    g_accountRuns.update(elapsedMs);
    std::vector<uint32_t> minutes;
    for (auto& [playerId, life] : lives) {
        const Player* p = g_game.getPlayerByID(playerId);
        if (!p || p->getHealth() == 0 || p->isGhoul()) continue;
        life.aliveMs += elapsedMs;
        while (life.aliveMs >= PR_MINUTE_MS) {
            life.aliveMs -= PR_MINUTE_MS;
            minutes.push_back(playerId);
        }
    }
    for (const uint32_t playerId : minutes) {
        if (Player* p = g_game.getPlayerByID(playerId)) g_events.emit({EventType::SurvivedMinute, p, ""});
    }

    pushMs += elapsedMs;
    if (pushMs >= PR_PUSH_MS) {
        pushMs = 0;
        const uint64_t now = prWallSeconds();
        for (auto& [accountId, account] : accounts) {
            if (!account.loaded && !account.loading && account.playerId && account.retryAt && now >= account.retryAt) {
                account.retryAt = 0;
                fetch(accountId);
            }
            if (Player* p = playerOf(account); p && !account.changed.empty()) sendUpdates(p, account);
        }
    }

    flushMs += elapsedMs;
    if (flushMs >= PR_FLUSH_MS) {
        flushMs = 0;
        flush();
    }
    send();
}

void ProgressSystem::flush()
{
    Batch batch;
    for (auto it = accounts.begin(); it != accounts.end();) {
        Account& account = it->second;
        if (!account.pending.empty()) {
            if (batch.accounts.size() >= PR_MAX_ACCOUNTS_PER_BATCH) {
                batch.id = fmt::format("{}:{}", bootId, ++batchSeq);
                outbox.push_back(std::move(batch));
                batch = Batch{};
            }
            batch.accounts[it->first] = std::move(account.pending);
            account.pending = ProgressDelta{};
        }
        // Nobody online and nothing left to store: the next login fetches afresh.
        const bool referenced = std::any_of(outbox.begin(), outbox.end(), [&](const Batch& b) { return b.accounts.count(it->first); })
            || batch.accounts.count(it->first);
        if (!account.playerId && !account.loading && !referenced) it = accounts.erase(it);
        else ++it;
    }
    if (!batch.accounts.empty()) {
        batch.id = fmt::format("{}:{}", bootId, ++batchSeq);
        outbox.push_back(std::move(batch));
        saveOutbox();
    }
}

void ProgressSystem::send()
{
    if (sending || outbox.empty() || prNowMs() < nextSendAt || !enabled()) return;
    sending = true;
    const Batch& batch = outbox.front();
    prjson::array list;
    for (const auto& [accountId, delta] : batch.accounts) list.push_back(prDeltaJson(accountId, delta));
    const std::string body = prjson::serialize(prjson::object{{"batchId", batch.id}, {"accounts", std::move(list)}});
    const std::string id = batch.id;
    HttpClient::requestAsync("POST", prServiceUrl("/api/servers/progress"), prAuthHeaders(), body,
        [this, id](HttpClient::Response r) {
            sending = false;
            if (outbox.empty() || outbox.front().id != id) return;
            const bool stored = r.status >= 200 && r.status < 300;
            // A batch the web host refuses as malformed can never succeed; keeping it would block every later one.
            const bool hopeless = r.status == 400 || r.status == 413 || r.status == 422;
            if (stored || hopeless) {
                if (hopeless) fmt::print(">> [Warning] account progress batch {} refused (HTTP {}); dropped\n", id, r.status);
                outbox.pop_front();
                backoffMs = 0;
                nextSendAt = 0;
                saveOutbox();
                send();
                return;
            }
            backoffMs = std::min(PR_MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : 5000u);
            nextSendAt = prNowMs() + backoffMs;
            fmt::print(">> [Warning] account progress not stored ({}); retrying in {} s\n",
                r.status ? "HTTP " + std::to_string(r.status) : r.error, backoffMs / 1000);
        });
}

// ---------------------------------------------------------------------------
// Outbox: what could not be sent survives a restart
// ---------------------------------------------------------------------------

void ProgressSystem::start()
{
    bootId = fmt::format("{}-{:x}", getString(ConfigManager::LISTING_ID).empty() ? "server" : getString(ConfigManager::LISTING_ID),
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    loadOutbox();
    g_accountRuns.start();
}

void ProgressSystem::stop()
{
    g_accountRuns.stop();
    flush();
    saveOutbox();
}

void ProgressSystem::saveOutbox() const
{
    try {
        const auto path = prOutboxPath();
        if (outbox.empty()) {
            std::error_code ignored;
            std::filesystem::remove(path, ignored);
            return;
        }
        std::filesystem::create_directories(path.parent_path());
        prjson::array batches;
        for (const auto& batch : outbox) {
            prjson::array list;
            for (const auto& [accountId, delta] : batch.accounts) list.push_back(prDeltaJson(accountId, delta));
            batches.push_back(prjson::object{{"batchId", batch.id}, {"accounts", std::move(list)}});
        }
        const auto temporary = std::filesystem::path(path).concat(".tmp");
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            out << prjson::serialize(prjson::object{{"version", 1}, {"batches", std::move(batches)}});
            if (!out) throw std::runtime_error("cannot write " + temporary.string());
        }
        std::filesystem::rename(temporary, path);
    } catch (const std::exception& e) {
        fmt::print(">> [Warning] account progress outbox not saved: {}\n", e.what());
    }
}

void ProgressSystem::loadOutbox()
{
    const auto path = prOutboxPath();
    if (!std::filesystem::exists(path)) return;
    try {
        std::ifstream in(path, std::ios::binary);
        std::stringstream text;
        text << in.rdbuf();
        const prjson::object o = prjson::parse(text.str()).as_object();
        for (const auto& b : o.at("batches").as_array()) {
            Batch batch;
            batch.id = std::string(b.at("batchId").as_string());
            for (const auto& a : b.at("accounts").as_array()) {
                const auto& entry = a.as_object();
                batch.accounts[static_cast<uint32_t>(prJsonNumber(entry.at("accountId")))] = prDeltaFrom(entry);
            }
            outbox.push_back(std::move(batch));
        }
        fmt::print(">> Account progress: {} unsent batch(es) from the last run\n", outbox.size());
    } catch (const std::exception& e) {
        // Kept aside rather than lost: someone can look at it.
        const auto aside = std::filesystem::path(path).concat(".bad");
        std::error_code ignored;
        std::filesystem::rename(path, aside, ignored);
        fmt::print(">> [Warning] account progress outbox unreadable ({}); moved to {}\n", e.what(), aside.string());
    }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

void ProgressSystem::sendState(Player* p, const Account* account)
{
    prjson::array values, unlocked, secrets;
    if (account && account->loaded) {
        for (const auto& [id, value] : account->values)
            if (value) values.push_back(prjson::array{id, value});
        for (const auto& [id, at] : account->unlocked) {
            unlocked.push_back(prjson::array{id, at});
            const auto a = std::find_if(achievements.begin(), achievements.end(), [&](const auto& x) { return x.id == id; });
            if (a != achievements.end() && a->secret)
                secrets.push_back(prjson::object{{"id", id}, {"name", a->name}, {"description", a->description}});
        }
    }
    std::string body = prjson::serialize(prjson::object{{"enabled", account != nullptr}, {"guest", !p->getAccountId()},
        {"loaded", account && account->loaded},
        {"stats", std::move(values)}, {"achievements", std::move(unlocked)}, {"secrets", std::move(secrets)}});
    if (body.size() > PR_MAX_STATE_BYTES) {
        fmt::print(">> [Warning] account progress state is {} bytes; the client gets it without stats\n", body.size());
        prjson::object trimmed = prjson::parse(body).as_object();
        trimmed["stats"] = prjson::array{};
        body = prjson::serialize(trimmed);
    }
    NetworkMessage msg;
    msg.addByte(static_cast<uint8_t>(ServerOpcode::PROGRESS_STATE));
    msg.addString(body);
    p->sendNetworkMessage(msg);
}

void ProgressSystem::sendUpdates(Player* p, Account& account)
{
    std::vector<uint16_t> ids(account.changed.begin(), account.changed.end());
    account.changed.clear();
    for (size_t start = 0; start < ids.size(); start += 255) {
        const size_t n = std::min<size_t>(255, ids.size() - start);
        NetworkMessage msg;
        msg.addByte(static_cast<uint8_t>(ServerOpcode::PROGRESS_UPDATE));
        msg.addByte(static_cast<uint8_t>(n));
        for (size_t i = start; i < start + n; ++i) {
            msg.add<uint16_t>(ids[i]);
            msg.add<uint32_t>(static_cast<uint32_t>(std::min<uint64_t>(account.values[ids[i]], UINT32_MAX)));
        }
        p->sendNetworkMessage(msg);
    }
}
