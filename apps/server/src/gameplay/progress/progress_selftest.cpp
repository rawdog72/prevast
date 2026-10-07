// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/progress/progress_loader.h"

namespace {
int failed = 0;
void check(bool ok, std::string_view what)
{
    if (!ok) {
        ++failed;
        fmt::print(">> progress self-test FAILED: {}\n", what);
    }
}

QuestRefs refs()
{
    QuestRefs r;
    r.item = [](const std::string& k) -> uint16_t { return k == "medkit" ? 5 : k == "bottle_cap" ? 10 : 0; };
    r.currency = [](uint16_t iid) { return iid == 10; };
    r.agent = [](const std::string& k) { return k == "normal_ghoul"; };
    r.object = [](const std::string& k) { return k == "workbench"; };
    r.resource = [](const std::string& k) { return k == "wood"; };
    r.npc = [](const std::string&) { return false; };
    r.family = [](const std::string& f) { return f == "ghoul" || f == "bot"; };
    return r;
}

const char* STATS = R"(<stats>
  <stat id="1" key="kills_ghoul" name="Ghouls killed"><count event="kill" family="ghoul"/></stat>
  <stat id="2" key="wrecked" name="Wrecked"><count event="destroy" owner="other"/><count event="destroy" target="workbench"/></stat>
  <stat id="3" key="longest_life" name="Longest life" aggregate="max"><count event="survived_minute"/></stat>
</stats>)";

std::vector<StatDefinition> parseStats(const std::string& xml)
{
    pugi::xml_document doc;
    doc.load_string(xml.c_str());
    return progress_loader::parseStats(doc.document_element(), refs());
}

std::vector<AchievementDefinition> parseAchievements(const std::string& xml, const std::vector<StatDefinition>& stats)
{
    pugi::xml_document doc;
    doc.load_string(xml.c_str());
    return progress_loader::parseAchievements(doc.document_element(), stats, refs());
}

template <typename F>
void expectFail(std::string_view label, F&& f, std::string_view fragment)
{
    try {
        f();
        check(false, fmt::format("{}: accepted", label));
    } catch (const std::exception& e) {
        const bool matched = std::string_view(e.what()).find(fragment) != std::string_view::npos;
        if (!matched) fmt::print(">> progress self-test: {} threw '{}'\n", label, e.what());
        check(matched, fmt::format("{}: error mentions '{}'", label, fragment));
    }
}
}

int runProgressSelfTest()
{
    failed = 0;
    std::vector<StatDefinition> stats;
    try {
        stats = parseStats(STATS);
    } catch (const std::exception& e) {
        check(false, fmt::format("the stats fixture parses: {}", e.what()));
        fmt::print(">> progress self-test: FAILED\n");
        return 1;
    }
    check(stats.size() == 3 && stats[2].aggregate == StatAggregate::Max && stats[1].counts.size() == 2, "stats parse");

    expectFail("duplicate stat id", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"><count event="craft"/></stat><stat id="1" key="b" name="B"><count event="craft"/></stat></stats>)"); }, "already used");
    expectFail("unknown event", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"><count event="teleport"/></stat></stats>)"); }, "unknown event");
    expectFail("unknown family", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"><count event="kill" family="dragon"/></stat></stats>)"); }, "family");
    expectFail("family on craft", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"><count event="craft" family="ghoul"/></stat></stats>)"); }, "kill counts only");
    expectFail("target on death", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"><count event="death" target="wood"/></stat></stats>)"); }, "takes no target");
    expectFail("no counts", [] { parseStats(R"(<stats><stat id="1" key="a" name="A"/></stats>)"); }, "needs a <count>");

    const std::string ACHIEVEMENTS = R"(<achievements>
      <achievement id="1" key="hunter" name="Hunter" description="Kill 10 ghouls." points="5"><requires stat="kills_ghoul" atLeast="10"/></achievement>
      <achievement id="2" key="warden" name="Warden" description="Quest." secret="true"><reward caps="50"/><reward item="medkit" count="2"/></achievement>
      <achievement id="3" key="both" name="Both" description="Both." grade="3"><requires stat="kills_ghoul" atLeast="5"/><requires stat="longest_life" atLeast="60"/></achievement>
    </achievements>)";
    std::vector<AchievementDefinition> achievements;
    try {
        achievements = parseAchievements(ACHIEVEMENTS, stats);
    } catch (const std::exception& e) {
        check(false, fmt::format("the achievements fixture parses: {}", e.what()));
    }
    if (achievements.size() == 3) {
        check(achievements[1].secret && achievements[1].rewards.caps == 50 && achievements[1].rewards.items.size() == 1, "rewards and secret parse");
        check(achievements[2].announce && !achievements[0].announce, "grade 3 announces by default");
    }
    expectFail("unknown stat", [&] { parseAchievements(R"(<achievements><achievement id="1" key="a" name="A" description="D"><requires stat="nope" atLeast="1"/></achievement></achievements>)", stats); }, "unknown stat");
    expectFail("currency item reward", [&] { parseAchievements(R"(<achievements><achievement id="1" key="a" name="A" description="D"><reward item="bottle_cap" count="3"/></achievement></achievements>)", stats); }, "currency");
    expectFail("grade 4", [&] { parseAchievements(R"(<achievements><achievement id="1" key="a" name="A" description="D" grade="4"/></achievements>)", stats); }, "grade");

    // Counting.
    const std::string noFamily;
    check(progress_rules::counts(stats[0].counts[0], {EventType::Kill, nullptr, "normal_ghoul"}, "ghoul"), "a ghoul kill counts by family");
    check(!progress_rules::counts(stats[0].counts[0], {EventType::Kill, nullptr, "halbot"}, "bot"), "another family does not");
    GameEvent own{EventType::Destroy, nullptr, "wood_wall", 1, ObjectOwner::Self};
    GameEvent theirs{EventType::Destroy, nullptr, "wood_wall", 1, ObjectOwner::Other};
    check(!progress_rules::counts(stats[1].counts[0], own, noFamily) && progress_rules::counts(stats[1].counts[0], theirs, noFamily), "owner= filters counts");

    // Requirements.
    if (achievements.size() == 3) {
        std::map<uint16_t, uint64_t> values{{1, 9}};
        check(!progress_rules::met(achievements[0], values), "9 of 10 does not unlock");
        values[1] = 10;
        check(progress_rules::met(achievements[0], values), "10 of 10 unlocks");
        check(!progress_rules::met(achievements[1], values), "an achievement without requirements never unlocks by stats");
        check(!progress_rules::met(achievements[2], values), "every requirement must hold");
        values[3] = 60;
        check(progress_rules::met(achievements[2], values), "all requirements met unlocks");
    }

    // Deltas on top of the stored values.
    ProgressDelta a, b;
    a.add[1] = 3;
    a.max[3] = 40;
    a.unlock[7] = 100;
    b.add[1] = 2;
    b.max[3] = 25;
    b.revoke.insert(7);
    a.merge(b);
    check(a.add[1] == 5 && a.max[3] == 40, "merge adds sums and keeps the larger maximum");
    check(!a.unlock.count(7) && a.revoke.count(7), "a later revoke cancels an earlier unlock");
    std::map<uint16_t, uint64_t> stored{{1, 100}, {3, 50}};
    progress_rules::apply(stored, a);
    check(stored[1] == 105 && stored[3] == 50, "apply adds sums and never lowers a record");

    fmt::print(">> progress self-test: {}\n", failed == 0 ? "passed" : "FAILED");
    return failed == 0 ? 0 : 1;
}
