// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include <boost/json.hpp>
#include <deque>
#include <map>
#include <set>
#include <string>
class Player;
class AccountRunSystem {
public:
    void configure(const std::string& statsFile);
    void start();
    void stop();
    void attach(Player* p);
    void finish(Player* p, bool death);
    void earned(Player* p, uint32_t amount, bool eligible);
    bool playerKill(Player* killer, Player* victim);
    void disqualify(Player* p);
    void achievement(Player* p, const std::string& key);
    bool hasEventReward(const std::string& key) const;
    bool eventReward(Player* p, const std::string& key, const std::string& occurrence);
    void update(uint32_t elapsedMs);
    uint8_t outlawMinKarma() const { return outlawKarma; }
    void sendIdentity(Player* to);
private:
    struct Run {
        boost::json::object state;
        boost::json::array events, awards;
        uint64_t seq = 0, aliveMs = 0;
        uint32_t bestScore = 0;
        uint64_t clanContribution = 0;
        std::set<std::string> awardKeys;
        std::map<uint32_t,uint64_t> victims;
    };
    struct Report { std::string route; boost::json::object body; };
    std::map<uint32_t,Run> runs;
    std::map<uint32_t,boost::json::value> clans;
    std::map<uint32_t,uint32_t> bests;
    std::deque<Report> outbox;
    boost::json::array rejected;
    boost::json::object rules;
    std::string bootId;
    uint32_t sequence = 0, elapsed = 0, pushElapsed = 0;
    uint64_t retryAt = 0, stateAt = 0;
    uint32_t backoff = 0;
    uint8_t outlawKarma = 4;
    bool sending = false, fetching = false, approved = false, durable = false;
    uint64_t scorePerCap = 10000, repeatMs = 600000;
    bool enabled() const;
    bool eligible(const Player* p) const;
    void checkpoint(Player* p, Run& run, const char* ending);
    void sendLive(Player* p, const Run& run);
    void fetchState();
    void send();
    bool save();
};
extern AccountRunSystem g_accountRuns;
