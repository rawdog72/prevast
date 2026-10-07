// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include "gameplay/progress/game_event.h"
#include "gameplay/progress/progress_definition.h"
#include <boost/json.hpp>
#include <deque>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

class Player;

// A batch of account progress not yet known to be stored: per account, stat
// increments, new maxima, unlocks and revokes. Deltas rather than totals, so
// one account on two servers adds up instead of overwriting.
struct ProgressDelta {
    std::map<uint16_t, uint64_t> add, max;
    std::map<uint16_t, uint64_t> unlock; // achievement id -> unix seconds
    std::set<uint16_t> revoke;
    bool empty() const { return add.empty() && max.empty() && unlock.empty() && revoke.empty(); }
    void merge(const ProgressDelta& other);
};

namespace progress_rules {
// Whether one <count> of a stat takes this event. `family` is the killed
// agent's family (kill events only).
bool counts(const StatCount& count, const GameEvent& event, const std::string& family);
// Whether every requirement holds for these stat values.
bool met(const AchievementDefinition& achievement, const std::map<uint16_t, uint64_t>& values);
// Server snapshot plus everything not yet stored on top of it.
void apply(std::map<uint16_t, uint64_t>& values, const ProgressDelta& delta);
}

// Account stats and achievements (spec phase C). Listens to the event bus for
// players with an account on a server that records progress, keeps each
// account's totals, unlocks achievements, and stores deltas on the web host in
// batches: every 30 s, on logout and at shutdown, with an outbox file for
// what could not be sent.
class ProgressSystem final : public EventListener {
public:
    bool load(const std::string& statsFile, const std::string& achievementsFile);
    // Reads the outbox left by the last run. After config, before players.
    void start();
    // Writes pending progress to the outbox file. At shutdown.
    void stop();
    bool enabled() const;

    void onGameEvent(const GameEvent& event) override;
    // Login and reconnect: fetch the account's progress if needed and tell the client.
    void attach(Player* player);
    // The character is gone (death, kick): its life records end.
    void detach(uint32_t playerId);
    // The connection dropped; the character stays in the world. What it has
    // done so far is stored on the next tick rather than at the next flush.
    void sessionLost(const Player* player);
    void update(uint32_t elapsedMs);

    // Quest outcomes and admins. False when the account cannot hold it yet.
    bool grant(Player* player, const std::string& key);
    bool hasAchievement(const Player* player, const std::string& key) const;
    // nullopt until the account's progress has loaded.
    std::optional<uint64_t> statValue(const Player* player, const std::string& key) const;
    const StatDefinition* stat(const std::string& key) const;
    // For script hooks: stats by key, unlocked achievements by key (true);
    // nullopt until the account's progress has loaded.
    std::optional<std::pair<boost::json::object, boost::json::object>> scriptView(const Player* player) const;
    const AchievementDefinition* achievement(const std::string& key) const;
    // !achievement=<grant|revoke>:<guid>:<key>
    std::string admin(Player* target, const std::string& action, const std::string& key);

private:
    struct Account {
        bool loaded = false, loading = false;
        uint64_t retryAt = 0;
        uint32_t playerId = 0;                   // the online character, 0 when none
        std::map<uint16_t, uint64_t> values;     // valid once loaded
        std::map<uint16_t, uint64_t> unlocked;   // achievement id -> unix seconds
        ProgressDelta pending;                   // not yet in a batch
        std::set<uint16_t> changed;              // stats the client has not been told about
    };
    struct Life {
        uint32_t aliveMs = 0;
        std::map<uint16_t, uint64_t> records;    // Max stats: this life's count
    };
    struct Batch {
        std::string id;
        std::map<uint32_t, ProgressDelta> accounts;
    };

    std::vector<StatDefinition> stats;
    std::vector<AchievementDefinition> achievements;
    std::map<uint16_t, std::vector<const AchievementDefinition*>> byStat;
    std::map<uint32_t, Account> accounts;  // by account id
    std::map<uint32_t, Life> lives;        // by player id
    std::deque<Batch> outbox;
    bool sending = false;
    uint64_t nextSendAt = 0, batchSeq = 0;
    uint32_t backoffMs = 0, flushMs = 0, pushMs = 0;
    std::string bootId;

    Account* accountOf(const Player* player);
    const Account* accountOf(const Player* player) const;
    Player* playerOf(const Account& account) const;
    void fetch(uint32_t accountId);
    void onFetched(uint32_t accountId, int status, const std::string& body);
    void bump(uint32_t accountId, Account& account, const StatDefinition& stat, uint64_t amount, Player* actor);
    void evaluate(uint32_t accountId, Account& account, const std::vector<const AchievementDefinition*>& candidates);
    void unlock(uint32_t accountId, Account& account, const AchievementDefinition& achievement, bool payRewards);
    void payRewards(Player* player, const AchievementDefinition& achievement);
    void flush();
    void send();
    void saveOutbox() const;
    void loadOutbox();
    ProgressDelta unstored(uint32_t accountId, const Account& account) const;
    void sendState(Player* player, const Account* account);
    void sendUpdates(Player* player, Account& account);
};

extern ProgressSystem g_progress;

int runProgressSelfTest();
