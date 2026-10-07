// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/progress_loader.h"
#include "content/content_validation.h"
#include <set>

namespace cv = content_validation;

namespace {
[[noreturn]] void fail(const std::string& what, const std::string& key, const std::string& problem)
{
    throw std::runtime_error(what + " '" + key + "': " + problem);
}

bool element(pugi::xml_node n) { return n.type() == pugi::node_element; }

uint16_t id(pugi::xml_node n, const char* what, const std::string& key)
{
    const uint32_t value = cv::number(n, "id", 0, 65535);
    if (!value) fail(what, key, "id= must be 1..65535");
    return static_cast<uint16_t>(value);
}

std::string text(pugi::xml_node n, const char* attr, const char* what, const std::string& key, size_t max)
{
    std::string value = cv::text(n, attr);
    if (value.empty() || value.size() > max) fail(what, key, std::string(attr) + "= needs 1.." + std::to_string(max) + " bytes");
    return value;
}

OwnerFilter owner(pugi::xml_node n, const std::string& key)
{
    const std::string v = n.attribute("owner").as_string("any");
    if (v == "any") return OwnerFilter::Any;
    if (v == "self") return OwnerFilter::Self;
    if (v == "clan") return OwnerFilter::Clan;
    if (v == "other") return OwnerFilter::Other;
    if (v == "none") return OwnerFilter::None;
    fail("stat", key, "owner= must be any, self, clan, other or none");
}
}

std::vector<StatDefinition> progress_loader::parseStats(pugi::xml_node root, const QuestRefs& refs)
{
    std::vector<StatDefinition> stats;
    std::set<uint16_t> ids;
    std::set<std::string> keys;
    for (auto n : root.children()) {
        if (!element(n)) continue;
        if (std::string(n.name()) != "stat") throw std::runtime_error("stats.xml: unknown <" + std::string(n.name()) + ">");
        StatDefinition s;
        s.key = cv::key(n);
        s.id = id(n, "stat", s.key);
        s.name = text(n, "name", "stat", s.key, 64);
        s.isPublic = cv::flag(n, "public", true);
        s.retired = cv::flag(n, "retired", false);
        const std::string aggregate = n.attribute("aggregate").as_string("sum");
        if (aggregate == "max") s.aggregate = StatAggregate::Max;
        else if (aggregate != "sum") fail("stat", s.key, "aggregate= must be sum or max");
        for (auto c : n.children()) {
            if (!element(c)) continue;
            if (std::string(c.name()) != "count") fail("stat", s.key, "unknown <" + std::string(c.name()) + ">");
            StatCount count;
            const std::string event = c.attribute("event").as_string();
            if (!parseEventType(event, count.event)) fail("stat", s.key, "unknown event='" + event + "'");
            if (c.attribute("target")) count.target = cv::key(c, "target");
            quest_loader::checkEventSubject(count.event, count.target, refs, "stat " + s.key, "a <count>");
            if (c.attribute("family")) {
                if (count.event != EventType::Kill) fail("stat", s.key, "family= applies to kill counts only");
                count.family = cv::key(c, "family");
                if (!refs.family || !refs.family(count.family)) fail("stat", s.key, "no agent has family='" + count.family + "'");
            }
            if (c.attribute("owner")) {
                if (count.event != EventType::Destroy && count.event != EventType::Build) fail("stat", s.key, "owner= applies to destroy and build counts only");
                count.owner = owner(c, s.key);
            }
            s.counts.push_back(std::move(count));
        }
        if (s.counts.size() > MAX_COUNTS) fail("stat", s.key, "at most 8 <count> elements");
        if (s.counts.empty() && !s.retired) fail("stat", s.key, "needs a <count> (or retired=\"true\")");
        if (!ids.insert(s.id).second) fail("stat", s.key, "id " + std::to_string(s.id) + " is already used");
        if (!keys.insert(s.key).second) fail("stat", s.key, "duplicate key");
        stats.push_back(std::move(s));
    }
    if (stats.size() > MAX_STATS) throw std::runtime_error("stats.xml: at most 256 stats");
    return stats;
}

std::vector<AchievementDefinition> progress_loader::parseAchievements(pugi::xml_node root, const std::vector<StatDefinition>& stats,
                                                                      const QuestRefs& refs)
{
    std::vector<AchievementDefinition> achievements;
    std::set<uint16_t> ids;
    std::set<std::string> keys;
    for (auto n : root.children()) {
        if (!element(n)) continue;
        if (std::string(n.name()) != "achievement") throw std::runtime_error("achievements.xml: unknown <" + std::string(n.name()) + ">");
        AchievementDefinition a;
        a.key = cv::key(n);
        a.id = id(n, "achievement", a.key);
        a.name = text(n, "name", "achievement", a.key, 64);
        a.description = text(n, "description", "achievement", a.key, 256);
        a.grade = static_cast<uint8_t>(cv::number(n, "grade", 1, 3));
        if (!a.grade) fail("achievement", a.key, "grade= must be 1..3");
        a.points = static_cast<uint8_t>(cv::number(n, "points", 0, 100));
        a.secret = cv::flag(n, "secret", false);
        a.retired = cv::flag(n, "retired", false);
        a.announce = cv::flag(n, "announce", a.grade == 3);
        for (auto c : n.children()) {
            if (!element(c)) continue;
            const std::string tag = c.name();
            if (tag == "reward") {
                quest_loader::parseReward(c, refs, "achievement " + a.key, a.rewards);
            } else if (tag == "requires") {
                const std::string statKey = cv::key(c, "stat");
                const auto stat = std::find_if(stats.begin(), stats.end(), [&](const auto& s) { return s.key == statKey; });
                if (stat == stats.end()) fail("achievement", a.key, "requires unknown stat '" + statKey + "'");
                const auto atLeast = cv::number(c, "atLeast", 0, 4000000000u);
                if (!atLeast) fail("achievement", a.key, "requires atLeast= of 1 or more");
                a.requirements.push_back({stat->id, atLeast});
            } else {
                fail("achievement", a.key, "unknown <" + tag + ">");
            }
        }
        if (a.requirements.size() > MAX_REQUIREMENTS) fail("achievement", a.key, "at most 4 <requires>");
        if (a.rewards.items.size() > quest_loader::MAX_REWARD_ITEMS) fail("achievement", a.key, "at most 8 reward items");
        if (!ids.insert(a.id).second) fail("achievement", a.key, "id " + std::to_string(a.id) + " is already used");
        if (!keys.insert(a.key).second) fail("achievement", a.key, "duplicate key");
        achievements.push_back(std::move(a));
    }
    if (achievements.size() > MAX_ACHIEVEMENTS) throw std::runtime_error("achievements.xml: at most 512 achievements");
    return achievements;
}
