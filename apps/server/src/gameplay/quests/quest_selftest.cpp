// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/quests/quest_selftest.h"
#include "gameplay/quests/quest_loader.h"
#include "gameplay/quests/quest_engine.h"
#include "gameplay/quests/quest_journal.h"
#include <boost/json.hpp>

namespace {
int failed = 0;
void check(bool ok, std::string_view what)
{
    if (!ok) {
        ++failed;
        fmt::print(">> quest self-test FAILED: {}\n", what);
    }
}

QuestRefs fakeRefs()
{
    QuestRefs refs;
    refs.item = [](const std::string& k) -> uint16_t {
        if (k == "wood") return 1;
        if (k == "bandage") return 2;
        if (k == "canned_food") return 3;
        if (k == "bottle_cap") return 10;
        return 0;
    };
    refs.currency = [](uint16_t iid) { return iid == 10; };
    refs.agent = [](const std::string& k) { return k == "normal_ghoul"; };
    refs.object = [](const std::string& k) { return k == "workbench" || k == "wood_wall"; };
    refs.resource = [](const std::string& k) { return k == "wood"; };
    refs.npc = [](const std::string& k) { return k == "quartermaster" || k == "banker"; };
    return refs;
}

QuestDefinition parseXml(const std::string& xml)
{
    pugi::xml_document doc;
    if (!doc.load_string(xml.c_str())) throw std::runtime_error("self-test XML does not parse");
    return quest_loader::parse(doc.document_element(), fakeRefs());
}

void expectFail(std::string_view label, const std::string& xml, std::string_view fragment)
{
    try {
        parseXml(xml);
        check(false, fmt::format("{}: accepted", label));
    } catch (const std::exception& e) {
        const bool matched = std::string_view(e.what()).find(fragment) != std::string_view::npos;
        if (!matched) fmt::print(">> quest self-test: {} threw '{}'\n", label, e.what());
        check(matched, fmt::format("{}: error mentions '{}'", label, fragment));
    }
}

// The spec's worked example.
const std::string LONG_ROAD = R"(
<quest key="long_road" name="The Long Road" description="Rook is trying to reopen the road.">
  <start><talk npc="quartermaster" keyword="Road " confirm="true" text="The road is overrun."/></start>
  <stage key="clear" journal="Clear ghouls or bring bandages.">
    <objective key="ghouls" type="kill" target="normal_ghoul" count="5" text="Kill normal ghouls"/>
    <objective key="bandages" type="give" npc="quartermaster" item="bandage" count="3" keyword="bandages" text="Give Rook 3 bandages"/>
    <outcome when="ghouls" next="report"><reward caps="150"/></outcome>
    <outcome when="bandages" next="report"><reward caps="100"/><reward item="canned_food" count="2"/></outcome>
  </stage>
  <stage key="report" journal="Tell Elias.">
    <objective key="elias" type="talk" npc="banker" keyword="road" text="Speak to Elias"/>
    <outcome when="all" next="supplies"><reward caps="200"/></outcome>
  </stage>
  <stage key="supplies" journal="Firewood for Elias.">
    <objective key="gather" type="gather" target="wood" count="20" text="Gather wood"/>
    <objective key="deliver" type="give" npc="banker" item="wood" count="20" keyword="firewood" after="gather" text="Bring wood"/>
    <outcome when="all" next="end:done"><reward caps="300"/></outcome>
  </stage>
  <ending key="done" journal="The road is open."/>
  <dialogue npc="quartermaster">
    <reply keyword="road" stage="clear" text="Still ghouls out there."/>
    <reply keyword="road" state="completed" text="The road holds."/>
  </dialogue>
</quest>)";

// A quest around `stages` (plus optional <start> etc. in `extra`) with one
// ending, "done", for the negative cases.
std::string minimal(const std::string& stages, const std::string& extra = "")
{
    return R"(<quest key="q" name="Q">)" + extra + stages + R"(<ending key="done" journal="Done."/></quest>)";
}
const std::string ONE_STAGE =
    R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome when="k" next="end:done"/></stage>)";

void loaderTests()
{
    try {
        const QuestDefinition d = parseXml(LONG_ROAD);
        check(d.key == "long_road" && d.stages.size() == 3 && d.endings.size() == 1, "the worked example parses");
        check(d.talkStarts.size() == 1 && d.talkStarts[0].keyword == "road" && d.talkStarts[0].confirm, "keywords are trimmed and lower-cased");
        check(d.stages[0].outcomes[1].rewards.caps == 100 && d.stages[0].outcomes[1].rewards.items.size() == 1, "outcome rewards parse");
        check(d.stages[2].objectives[1].after == "gather" && d.stages[2].objectives[1].iid == 1, "give objectives resolve items and after=");
        check(d.dialogue.size() == 2 && d.dialogue[1].state == QuestState::Completed, "dialogue replies parse");
    } catch (const std::exception& e) {
        check(false, fmt::format("the worked example parses: {}", e.what()));
    }

    expectFail("unknown objective type", minimal(R"(<stage key="a" journal="A."><objective key="k" type="teleport" text="K"/><outcome next="end:done"/></stage>)"), "unknown type");
    expectFail("unknown agent", minimal(R"(<stage key="a" journal="A."><objective key="k" type="kill" target="dragon" text="K"/><outcome next="end:done"/></stage>)"), "unknown agent");
    expectFail("missing next stage", minimal(R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome next="nowhere"/></stage>)"), "unknown stage");
    expectFail("unreachable stage", minimal(ONE_STAGE + R"(<stage key="b" journal="B."><objective key="j" type="kill" target="normal_ghoul" text="J"/><outcome next="end:done"/></stage>)"), "unreachable");
    expectFail("cycle without loop", minimal(
        R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome when="k" next="b"/></stage>)"
        R"(<stage key="b" journal="B."><objective key="j" type="kill" target="normal_ghoul" text="J"/><outcome when="j" next="a"/><outcome next="end:done"/></stage>)"), "cycle");
    try {
        parseXml(minimal(
            R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome when="k" next="b"/></stage>)"
            R"(<stage key="b" journal="B." loop="true"><objective key="j" type="kill" target="normal_ghoul" text="J"/><outcome when="j" next="a"/><outcome next="end:done"/></stage>)"));
    } catch (const std::exception& e) {
        check(false, fmt::format("a cycle through a loop stage is accepted: {}", e.what()));
    }
    expectFail("no ending reachable", R"(<quest key="q" name="Q"><stage key="a" journal="A." loop="true"><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome next="a"/></stage><ending key="done" journal="D."/></quest>)", "ending");
    expectFail("reserved keyword", minimal(ONE_STAGE, R"(<start><talk npc="banker" keyword="trade" text="T"/></start>)"), "reserved");
    expectFail("currency reward", minimal(R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome next="end:done"><reward item="bottle_cap" count="5"/></outcome></stage>)"), "currency");
    expectFail("after names nothing", minimal(R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" text="K" after="x"/><outcome next="end:done"/></stage>)"), "after");
    expectFail("owner on kill", minimal(R"(<stage key="a" journal="A."><objective key="k" type="kill" target="normal_ghoul" owner="other" text="K"/><outcome next="end:done"/></stage>)"), "owner=");
    expectFail("unknown npc", minimal(R"(<stage key="a" journal="A."><objective key="k" type="talk" npc="ghost" keyword="boo" text="K"/><outcome next="end:done"/></stage>)"), "unknown npc");
    expectFail("unused ending", R"(<quest key="q" name="Q">)" + ONE_STAGE + R"(<ending key="done" journal="D."/><ending key="spare" journal="S."/></quest>)", "never reached");
    try {
        const QuestDefinition areas = parseXml(R"(<quest key="scout" name="Scout">
          <area key="post" near="npc:quartermaster" radius="400"/>
          <area key="spot" x="4200" y="3100" radius="300"/>
          <start><enter area="spot"/></start>
          <stage key="a" journal="Go."><objective key="go" type="enter_area" area="post" text="Go to Rook"/><outcome next="end:done"/></stage>
          <ending key="done" journal="D."/></quest>)");
        check(areas.areas.size() == 2 && areas.areas[0].id == "scout.post" && areas.areas[0].kind == QuestArea::Kind::Npc, "areas parse with quest-qualified ids");
        check(areas.stages[0].objectives[0].target == "scout.post" && areas.eventStarts[0].target == "scout.spot", "area references resolve to ids");
        check(quest_engine::matches(areas.stages[0].objectives[0], {EventType::EnterArea, nullptr, "scout.post"}), "an enter_area objective matches its area's event");
    } catch (const std::exception& e) {
        check(false, fmt::format("areas parse: {}", e.what()));
    }
    expectFail("unknown area", minimal(R"(<stage key="a" journal="A."><objective key="k" type="enter_area" area="nowhere" text="K"/><outcome next="end:done"/></stage>)"), "unknown area");
    expectFail("area with two shapes", minimal(ONE_STAGE, R"(<area key="x" near="npc:banker" x="1" y="1" radius="100"/>)"), "exactly one of");
    expectFail("empty journal on a visible quest", minimal(R"(<stage key="a"><objective key="k" type="kill" target="normal_ghoul" text="K"/><outcome next="end:done"/></stage>)"), "journal");

    // Rules across quests.
    try {
        const auto a = parseXml(R"(<quest key="a" name="A"><start><talk npc="banker" keyword="job" text="T"/></start>)" + ONE_STAGE + R"(<ending key="done" journal="D."/></quest>)");
        auto b = parseXml(R"(<quest key="b" name="B"><start><talk npc="banker" keyword="job" text="T"/></start>)" + ONE_STAGE + R"(<ending key="done" journal="D."/></quest>)");
        try {
            quest_loader::validateSet({a, b});
            check(false, "two quests sharing an NPC keyword are rejected");
        } catch (const std::exception& e) {
            check(std::string_view(e.what()).find("both use") != std::string_view::npos, "the keyword clash names both quests");
        }
        b.talkStarts.clear();
        b.requirements.push_back({"missing"});
        try {
            quest_loader::validateSet({a, b});
            check(false, "a prerequisite on a missing quest is rejected");
        } catch (const std::exception& e) {
            check(std::string_view(e.what()).find("requires unknown quest") != std::string_view::npos, "the prerequisite error names the problem");
        }
    } catch (const std::exception& e) {
        check(false, fmt::format("the set fixtures parse: {}", e.what()));
    }
}
// Every engine check stops early when a precondition fails, so a broken
// engine reports failures rather than crashing the self-test.
void engineTests()
{
    using namespace quest_engine;
    const QuestDefinition d = parseXml(LONG_ROAD);
    QuestProgress p;
    begin(p, d, 100);
    check(p.state == QuestState::Active && p.stage == "clear" && p.started == 100, "begin enters the first stage");
    check(p.counts.size() == 2 && p.counts.count("ghouls") && p.counts.count("bandages"), "begin zeroes the stage's counts");

    const QuestStage& clear = d.stages[0];
    const QuestObjective& ghouls = clear.objectives[0];
    check(matches(ghouls, {EventType::Kill, nullptr, "normal_ghoul", 1}), "a kill of the target matches");
    check(!matches(ghouls, {EventType::Kill, nullptr, "fast_ghoul", 1}), "a kill of another agent does not");
    check(!matches(ghouls, {EventType::Craft, nullptr, "normal_ghoul", 1}), "another event type does not");
    check(add(p, ghouls, 3) == 3 && choose(clear, p) == nullptr, "3 of 5 kills choose no outcome");
    check(add(p, ghouls, 10) == 2 && p.counts["ghouls"] == 5, "counts clamp at the objective's count");
    const QuestOutcome* out = choose(clear, p);
    check(out && out->objective == "ghouls" && out->next == OutcomeNext::Stage && out->target == "report", "the named objective's outcome is chosen");
    if (!out) return;

    const QuestStage* report = advance(p, d, clear, *out, 200);
    check(report && report->key == "report" && p.stage == "report", "advance enters the next stage");
    check(p.history.size() == 1 && p.history[0].stage == "clear" && p.history[0].outcome == "ghouls" && p.history[0].next == "report", "advance records history");
    check(p.counts.size() == 1 && p.counts.count("elias"), "the new stage's counts replace the old ones");
    if (!report) return;

    add(p, report->objectives[0], 1);
    const QuestOutcome* toSupplies = choose(*report, p);
    check(toSupplies != nullptr, "an all-outcome holds when every objective is done");
    if (!toSupplies) return;
    const QuestStage* supplies = advance(p, d, *report, *toSupplies, 300);
    check(supplies && supplies->key == "supplies", "an all-outcome advances");
    if (!supplies) return;
    const QuestObjective& gather = supplies->objectives[0];
    const QuestObjective& deliver = supplies->objectives[1];
    check(!open(*supplies, p, deliver), "an after= objective is closed until its predecessor is done");
    add(p, gather, 20);
    check(open(*supplies, p, deliver) && !open(*supplies, p, gather), "it opens once the predecessor is done, and the done one closes");
    add(p, deliver, 20);
    const QuestOutcome* finish = choose(*supplies, p);
    check(finish != nullptr, "the last stage's outcome holds");
    if (!finish) return;
    check(advance(p, d, *supplies, *finish, 400) == nullptr, "an ending returns no stage");
    check(p.state == QuestState::Completed && p.ending == "done" && p.finished == 400 && p.counts.empty(), "an ending completes the quest");

    const QuestDefinition branch = parseXml(
        R"(<quest key="b" name="B"><stage key="a" journal="A.">)"
        R"(<objective key="x" type="destroy" target="workbench" owner="other" text="X"/>)"
        R"(<objective key="y" type="use" item="bandage" text="Y"/>)"
        R"(<outcome when="any" next="end:done"/></stage><ending key="done" journal="D."/></quest>)");
    QuestProgress b;
    begin(b, branch, 0);
    const QuestObjective& x = branch.stages[0].objectives[0];
    GameEvent own{EventType::Destroy, nullptr, "workbench", 1, ObjectOwner::Self};
    GameEvent theirs{EventType::Destroy, nullptr, "workbench", 1, ObjectOwner::Other};
    check(!matches(x, own) && matches(x, theirs), "owner=\"other\" ignores the actor's own objects");
    check(matches(branch.stages[0].objectives[1], {EventType::Use, nullptr, "bandage", 1}), "use objectives match the item key");
    add(b, branch.stages[0].objectives[1], 1);
    const QuestOutcome* first = choose(branch.stages[0], b);
    check(first && first->when == OutcomeWhen::Any, "an any-outcome fires on one objective");

    QuestEventStart start{EventType::Destroy, "workbench", 1, OwnerFilter::Other};
    check(startMatches(start, theirs) && !startMatches(start, own), "event starts honour owner=");
    check(ownerMatches(OwnerFilter::Any, ObjectOwner::None) && !ownerMatches(OwnerFilter::Clan, ObjectOwner::Other), "owner filters");
}

void journalTests()
{
    using namespace quest_engine;
    const QuestDefinition d = parseXml(LONG_ROAD);
    QuestProgress p;
    begin(p, d, 0);
    std::string json = questJournalJson(d, p, 8000);
    check(json.find("\"report\"") == std::string::npos && json.find("Firewood for Elias") == std::string::npos,
          "a journal entry never names stages the player has not reached");
    const auto first = boost::json::parse(json).as_object();
    check(first.at("state").as_string() == "active" && first.at("stage").as_string() == "clear", "the entry states the current stage");
    const auto& firstStages = first.at("stages").as_array();
    check(firstStages.size() == 1 && firstStages[0].as_object().at("objectives").as_array().size() == 2, "the current stage lists its objectives");

    add(p, d.stages[0].objectives[0], 5);
    advance(p, d, d.stages[0], *choose(d.stages[0], p), 1);
    p.history.back().rewards = "150 caps";
    const auto second = boost::json::parse(questJournalJson(d, p, 8000)).as_object();
    const auto& stages = second.at("stages").as_array();
    check(stages.size() == 2, "history comes before the current stage");
    if (stages.size() == 2) {
        const auto& done = stages[0].as_object();
        check(done.at("key").as_string() == "clear" && !done.at("current").as_bool() && done.at("outcome").as_string() == "ghouls"
              && done.at("rewards").as_string() == "150 caps", "a finished stage records how it ended and what it paid");
        check(stages[1].as_object().at("current").as_bool(), "the last stage is the current one");
    }

    const auto supplies = d.stage("supplies");
    enter(p, *supplies);
    const auto locked = boost::json::parse(questJournalJson(d, p, 8000)).as_object().at("stages").as_array().back().as_object();
    const auto& objectives = locked.at("objectives").as_array();
    check(objectives.size() == 2 && !objectives[0].as_object().at("locked").as_bool() && objectives[1].as_object().at("locked").as_bool(),
          "an after= objective is marked locked until its predecessor is done");

    const std::string trimmed = questJournalJson(d, p, 300);
    check(boost::json::parse(trimmed).as_object().at("stages").as_array().size() == 1, "an oversized entry drops old history first");
}
}

int runQuestSelfTest()
{
    failed = 0;
    loaderTests();
    engineTests();
    journalTests();
    fmt::print(">> quest self-test: {}\n", failed == 0 ? "passed" : "FAILED");
    return failed == 0 ? 0 : 1;
}
