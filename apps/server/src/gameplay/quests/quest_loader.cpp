// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/quests/quest_loader.h"
#include "content/content_validation.h"
#include <boost/algorithm/string/trim.hpp>
#include <map>
#include <set>

namespace fs = std::filesystem;
namespace cv = content_validation;

namespace {
[[noreturn]] void fail(const std::string& quest, const std::string& what)
{
    throw std::runtime_error("quest '" + quest + "': " + what);
}

bool element(pugi::xml_node n) { return n.type() == pugi::node_element; }

OwnerFilter owner(pugi::xml_node n, const std::string& q)
{
    const std::string v = n.attribute("owner").as_string("any");
    if (v == "any") return OwnerFilter::Any;
    if (v == "self") return OwnerFilter::Self;
    if (v == "clan") return OwnerFilter::Clan;
    if (v == "other") return OwnerFilter::Other;
    if (v == "none") return OwnerFilter::None;
    fail(q, "owner= must be any, self, clan, other or none");
}

std::string keyword(pugi::xml_node n, const std::string& q)
{
    const std::string k = quest_loader::normalizeKeyword(cv::text(n, "keyword"));
    if (k.empty() || k.size() > 64) fail(q, "keyword= needs 1..64 bytes");
    if (quest_loader::reservedKeyword(k)) fail(q, "keyword '" + k + "' is reserved by the NPC system");
    return k;
}

bool parseState(const std::string& v, QuestState& out)
{
    if (v == "not_started") out = QuestState::NotStarted;
    else if (v == "active") out = QuestState::Active;
    else if (v == "completed") out = QuestState::Completed;
    else if (v == "failed") out = QuestState::Failed;
    else return false;
    return true;
}

void checkSubject(EventType type, const std::string& target, const QuestRefs& refs, const std::string& q, const std::string& where)
{
    quest_loader::checkEventSubject(type, target, refs, q, where);
}

// The <reward> and <achievement> children of an outcome.
QuestRewards rewards(pugi::xml_node parent, const QuestRefs& refs, const std::string& q, std::string& achievement)
{
    QuestRewards r;
    for (auto child : parent.children()) {
        if (!element(child)) continue;
        const std::string tag = child.name();
        if (tag == "achievement") {
            if (!achievement.empty()) fail(q, "an outcome grants at most one achievement");
            achievement = cv::key(child);
            if (!refs.achievement || !refs.achievement(achievement)) fail(q, "an outcome grants unknown achievement '" + achievement + "'");
            continue;
        }
        if (tag != "reward") fail(q, "unknown <" + tag + "> inside <outcome>");
        quest_loader::parseReward(child, refs, q, r);
    }
    if (r.items.size() > quest_loader::MAX_REWARD_ITEMS) fail(q, "an outcome pays at most 8 reward items");
    return r;
}

QuestObjective objective(pugi::xml_node n, const QuestRefs& refs, const std::string& q)
{
    QuestObjective o;
    o.key = cv::key(n);
    o.text = cv::text(n, "text");
    const std::string type = n.attribute("type").as_string();
    const std::string where = "objective '" + o.key + "'";
    const auto item = [&] {
        o.target = cv::key(n, "item");
        o.iid = refs.item(o.target);
        if (!o.iid) fail(q, where + " names unknown item '" + o.target + "'");
    };
    const auto target = [&](EventType event) {
        o.target = cv::key(n, "target");
        checkSubject(event, o.target, refs, q, where);
    };
    const auto npc = [&] {
        o.npc = cv::key(n, "npc");
        if (!refs.npc(o.npc)) fail(q, where + " names unknown npc '" + o.npc + "'");
        o.keyword = keyword(n, q);
        o.reply = cv::text(n, "reply");
    };
    if (type == "kill") {
        o.type = ObjectiveType::Kill;
        const std::string raw = n.attribute("target").as_string();
        if (!raw.empty() && raw.front() == '@') {
            // An agent a quest script spawned with that tag (spawnAgent ... tag=).
            const std::string tag = raw.substr(1);
            if (tag.empty() || tag.size() > 32 || tag.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos)
                fail(q, where + ": target=\"@tag\" needs a tag of 1..32 lower-case letters, digits, _ or -");
            o.target = raw;
        } else {
            target(EventType::Kill);
        }
    }
    else if (type == "bounty") { o.type = ObjectiveType::Bounty; o.minVictimKarma = cv::number(n, "minVictimKarma", 4, 5); }
    else if (type == "craft") { o.type = ObjectiveType::Craft; item(); }
    else if (type == "gather") { o.type = ObjectiveType::Gather; target(EventType::Gather); }
    else if (type == "destroy") { o.type = ObjectiveType::Destroy; target(EventType::Destroy); o.owner = owner(n, q); }
    else if (type == "build") { o.type = ObjectiveType::Build; target(EventType::Build); o.owner = owner(n, q); }
    else if (type == "pickup") { o.type = ObjectiveType::Pickup; item(); }
    else if (type == "use") { o.type = ObjectiveType::Use; item(); }
    else if (type == "talk") { o.type = ObjectiveType::Talk; npc(); }
    else if (type == "give") { o.type = ObjectiveType::Give; npc(); item(); }
    else if (type == "enter_area") { o.type = ObjectiveType::EnterArea; o.target = cv::key(n, "area"); } // resolved to "<quest>.<area>" in parse()
    else fail(q, where + " has unknown type '" + type + "'");
    if (n.attribute("owner") && o.type != ObjectiveType::Destroy && o.type != ObjectiveType::Build)
        fail(q, where + ": owner= applies to destroy and build only");
    if (o.type != ObjectiveType::Talk && o.type != ObjectiveType::EnterArea) {
        o.count = cv::number(n, "count", 1, economy::MAX_QUANTITY);
        if (!o.count) fail(q, where + ": count must be at least 1");
    }
    if (n.attribute("after")) o.after = cv::key(n, "after");
    return o;
}

QuestOutcome outcome(pugi::xml_node n, const QuestRefs& refs, const std::string& q)
{
    QuestOutcome o;
    const std::string when = n.attribute("when").as_string("all");
    if (when == "all") o.when = OutcomeWhen::All;
    else if (when == "any") o.when = OutcomeWhen::Any;
    else { o.when = OutcomeWhen::Objective; o.objective = when; }
    const std::string next = n.attribute("next").as_string();
    if (next == "fail") o.next = OutcomeNext::Fail;
    else if (next.rfind("end:", 0) == 0) { o.next = OutcomeNext::Ending; o.target = next.substr(4); }
    else { o.next = OutcomeNext::Stage; o.target = next; }
    if (o.next != OutcomeNext::Fail && o.target.empty()) fail(q, "an <outcome> needs next=<stage>, end:<ending> or fail");
    o.rewards = rewards(n, refs, q, o.achievement);
    return o;
}

// Structure that only makes sense once every stage and ending is known.
void checkGraph(const QuestDefinition& d)
{
    const std::string& q = d.key;
    std::set<std::string> stageKeys, endingKeys, objectiveKeys, usedEndings;
    for (const auto& e : d.endings) {
        if (!endingKeys.insert(e.key).second) fail(q, "duplicate ending '" + e.key + "'");
        if (e.journal.empty() && !d.hidden) fail(q, "ending '" + e.key + "' needs journal=");
    }
    if (d.endings.empty()) fail(q, "needs at least one <ending>");
    for (const auto& s : d.stages) {
        if (!stageKeys.insert(s.key).second) fail(q, "duplicate stage '" + s.key + "'");
        if (s.journal.empty() && !d.hidden) fail(q, "stage '" + s.key + "' needs journal=");
    }
    const size_t n = d.stages.size();
    std::map<std::string, size_t> position;
    for (size_t i = 0; i < n; ++i) position[d.stages[i].key] = i;
    std::vector<std::vector<bool>> reach(n, std::vector<bool>(n, false));
    std::vector<bool> ends(n, false);

    for (size_t i = 0; i < n; ++i) {
        const QuestStage& s = d.stages[i];
        for (const auto& o : s.objectives) {
            if (!objectiveKeys.insert(o.key).second) fail(q, "duplicate objective '" + o.key + "'");
            if (o.after.empty()) continue;
            if (o.after == o.key || !s.objective(o.after))
                fail(q, "objective '" + o.key + "' has after='" + o.after + "', which is not another objective of stage '" + s.key + "'");
            // Follow the chain; it may not come back round.
            const QuestObjective* walk = s.objective(o.after);
            for (size_t steps = 0; walk && !walk->after.empty(); ++steps) {
                if (steps > s.objectives.size() || walk->after == o.key) fail(q, "objective '" + o.key + "' is part of an after= cycle");
                walk = s.objective(walk->after);
            }
        }
        for (const auto& out : s.outcomes) {
            if (out.when == OutcomeWhen::Objective && !s.objective(out.objective))
                fail(q, "stage '" + s.key + "' has an outcome when='" + out.objective + "', which is not one of its objectives");
            if (out.next == OutcomeNext::Stage) {
                const auto found = position.find(out.target);
                if (found == position.end()) fail(q, "stage '" + s.key + "' leads to unknown stage '" + out.target + "'");
                reach[i][found->second] = true;
            } else if (out.next == OutcomeNext::Ending) {
                if (!endingKeys.count(out.target)) fail(q, "stage '" + s.key + "' leads to unknown ending '" + out.target + "'");
                usedEndings.insert(out.target);
                ends[i] = true;
            } else {
                ends[i] = true;
            }
        }
    }
    for (const auto& e : d.endings) {
        if (!usedEndings.count(e.key)) fail(q, "ending '" + e.key + "' is never reached by any outcome");
    }
    // Transitive closure; n is at most 32.
    for (size_t k = 0; k < n; ++k)
        for (size_t i = 0; i < n; ++i)
            for (size_t j = 0; j < n; ++j)
                if (reach[i][k] && reach[k][j]) reach[i][j] = true;
    bool finishes = ends[0];
    for (size_t j = 1; j < n; ++j) {
        if (!reach[0][j]) fail(q, "stage '" + d.stages[j].key + "' is unreachable from '" + d.stages[0].key + "'");
        finishes = finishes || ends[j];
    }
    if (!finishes) fail(q, "no ending can be reached from '" + d.stages[0].key + "'");
    for (size_t i = 0; i < n; ++i) {
        if (!reach[i][i]) continue;
        bool marked = false;
        for (size_t j = 0; j < n; ++j) {
            if (reach[i][j] && reach[j][i] && d.stages[j].loop) marked = true;
        }
        if (!marked) fail(q, "stage '" + d.stages[i].key + "' is on a cycle; mark a stage on it loop=\"true\" if that is intended");
    }
    for (const auto& r : d.dialogue) {
        if (!r.stage.empty() && !d.stage(r.stage)) fail(q, "a dialogue reply names unknown stage '" + r.stage + "'");
    }
}
}

void quest_loader::checkEventSubject(EventType type, const std::string& target, const QuestRefs& refs, const std::string& q,
                                     const std::string& where)
{
    if (target.empty()) return;
    bool known = false;
    const char* what = "";
    switch (type) {
    case EventType::Kill: known = refs.agent(target); what = "agent"; break;
    case EventType::Craft: case EventType::Pickup: case EventType::Use: known = refs.item(target) != 0; what = "item"; break;
    case EventType::Gather: known = refs.resource(target); what = "resource"; break;
    case EventType::Destroy: case EventType::Build: known = refs.object(target); what = "object"; break;
    case EventType::QuestComplete: return; // quest keys are checked once the whole quest set is loaded
    case EventType::EnterArea: case EventType::LeaveArea: return; // "<quest>.<area>", checked with the quest
    case EventType::PlayerKill: case EventType::Bounty: case EventType::Death: case EventType::SurvivedMinute:
        fail(q, where + ": this event takes no target");
    }
    if (!known) fail(q, where + " names unknown " + what + " '" + target + "'");
}

void quest_loader::parseReward(pugi::xml_node child, const QuestRefs& refs, const std::string& q, QuestRewards& r)
{
    const bool caps = child.attribute("caps"), item = child.attribute("item");
    if (caps == item) fail(q, "a <reward> names exactly one of caps= or item=");
    if (caps) {
        const uint32_t amount = cv::number(child, "caps", 0, economy::MAX_MONEY);
        if (!amount || uint64_t(r.caps) + amount > economy::MAX_MONEY) fail(q, "reward caps must total 1..2000000000");
        r.caps += amount;
    } else {
        const std::string key = cv::key(child, "item");
        const uint16_t iid = refs.item(key);
        if (!iid) fail(q, "reward names unknown item '" + key + "'");
        if (refs.currency(iid)) fail(q, "currency rewards are written as caps=, not item='" + key + "'");
        const uint32_t count = cv::number(child, "count", 1, economy::MAX_QUANTITY);
        if (!count) fail(q, "reward count must be at least 1");
        r.items.emplace_back(iid, count);
    }
}

std::string quest_loader::normalizeKeyword(std::string value)
{
    boost::algorithm::trim(value);
    for (auto& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

bool quest_loader::reservedKeyword(const std::string& keyword)
{
    static const std::set<std::string> reserved{"bye", "hi", "hello", "hey", "help", "trade", "shop", "bank",
                                                "balance", "quests", "journal", "yes", "no"};
    return reserved.count(keyword) != 0;
}

QuestDefinition quest_loader::parse(pugi::xml_node n, const QuestRefs& refs)
{
    QuestDefinition d;
    d.key = cv::key(n);
    const std::string& q = d.key;
    d.name = cv::text(n, "name");
    if (d.name.empty() || d.name.size() > 64) fail(q, "name= needs 1..64 bytes");
    d.category = n.attribute("category").as_string("side");
    if (d.category != "main" && d.category != "side" && d.category != "daily") fail(q, "category= must be main, side or daily");
    d.description = cv::text(n, "description");
    d.hidden = cv::flag(n, "hidden", false);
    d.abandon = cv::flag(n, "abandon", true);
    const std::string repeat = n.attribute("repeat").as_string("never");
    if (repeat == "cooldown") {
        d.repeatable = true;
        d.cooldownSeconds = cv::number(n, "cooldownSeconds", 0, 31536000);
        if (!d.cooldownSeconds) fail(q, "repeat=\"cooldown\" needs cooldownSeconds=");
    } else if (repeat != "never") {
        fail(q, "repeat= must be never or cooldown");
    }
    if (n.attribute("script")) {
        d.script = n.attribute("script").as_string();
        const bool plain = d.script.size() > 4 && d.script.size() <= 64 && d.script.substr(d.script.size() - 4) == ".lua" &&
            d.script.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-.") == std::string::npos && d.script.find("..") == std::string::npos;
        if (!plain) fail(q, "script= must be a file name like my_quest.lua (in data/quests/scripts)");
    }

    for (auto child : n.children()) {
        if (!element(child)) continue;
        const std::string tag = child.name();
        if (tag == "start") {
            for (auto s : child.children()) {
                if (!element(s)) continue;
                const std::string kind = s.name();
                if (kind == "talk") {
                    QuestTalkStart t;
                    t.npc = cv::key(s, "npc");
                    if (!refs.npc(t.npc)) fail(q, "a talk start names unknown npc '" + t.npc + "'");
                    t.keyword = keyword(s, q);
                    t.text = cv::text(s, "text");
                    if (t.text.empty()) fail(q, "a talk start needs text=");
                    t.confirm = cv::flag(s, "confirm", false);
                    d.talkStarts.push_back(std::move(t));
                } else if (kind == "event") {
                    QuestEventStart e;
                    const std::string type = s.attribute("type").as_string();
                    if (!parseEventType(type, e.type)) fail(q, "an event start has unknown type='" + type + "'");
                    if (s.attribute("target")) e.target = cv::key(s, "target");
                    checkSubject(e.type, e.target, refs, q, "an event start");
                    e.count = cv::number(s, "count", 1, economy::MAX_QUANTITY);
                    if (!e.count) fail(q, "an event start needs count >= 1");
                    e.owner = owner(s, q);
                    d.eventStarts.push_back(std::move(e));
                } else if (kind == "enter") {
                    // Resolved to "<quest>.<area>" once the areas are known.
                    QuestEventStart e;
                    e.type = EventType::EnterArea;
                    e.target = cv::key(s, "area");
                    d.eventStarts.push_back(std::move(e));
                } else if (kind == "use") {
                    QuestUseStart u;
                    u.item = cv::key(s, "item");
                    if (!refs.item(u.item)) fail(q, "a use start names unknown item '" + u.item + "'");
                    d.useStarts.push_back(std::move(u));
                } else if (kind == "requires") {
                    QuestRequirement r;
                    if (s.attribute("quest")) r.quest = cv::key(s, "quest");
                    if (s.attribute("state") && !parseState(s.attribute("state").as_string(), r.state))
                        fail(q, "requires state= must be not_started, active, completed or failed");
                    if (s.attribute("achievement")) {
                        r.achievement = cv::key(s, "achievement");
                        if (!refs.achievement || !refs.achievement(r.achievement)) fail(q, "requires unknown achievement '" + r.achievement + "'");
                    }
                    if (s.attribute("stat")) {
                        r.stat = cv::key(s, "stat");
                        if (!refs.stat || !refs.stat(r.stat)) fail(q, "requires unknown stat '" + r.stat + "'");
                        r.atLeast = cv::number(s, "atLeast", 0, 4000000000u);
                        if (!r.atLeast) fail(q, "requires stat= needs atLeast= of 1 or more");
                    }
                    r.karmaMin = static_cast<uint8_t>(cv::number(s, "karmaMin", 0, 5));
                    r.karmaMax = static_cast<uint8_t>(cv::number(s, "karmaMax", 5, 5));
                    if (r.karmaMin > r.karmaMax) fail(q, "requires karmaMin= is above karmaMax=");
                    d.requirements.push_back(std::move(r));
                } else {
                    fail(q, "unknown <" + kind + "> inside <start>");
                }
            }
        } else if (tag == "stage") {
            QuestStage s;
            s.key = cv::key(child);
            s.journal = cv::text(child, "journal");
            s.loop = cv::flag(child, "loop", false);
            for (auto o : child.children()) {
                if (!element(o)) continue;
                const std::string kind = o.name();
                if (kind == "objective") s.objectives.push_back(objective(o, refs, q));
                else if (kind == "outcome") s.outcomes.push_back(outcome(o, refs, q));
                else fail(q, "unknown <" + kind + "> inside stage '" + s.key + "'");
            }
            if (s.objectives.empty() || s.objectives.size() > MAX_OBJECTIVES) fail(q, "stage '" + s.key + "' needs 1..8 objectives");
            if (s.outcomes.empty()) fail(q, "stage '" + s.key + "' needs at least one <outcome>");
            d.stages.push_back(std::move(s));
        } else if (tag == "area") {
            QuestArea a;
            a.key = cv::key(child);
            a.id = q + "." + a.key;
            const bool hasStructure = child.attribute("structure"), hasNear = child.attribute("near"), hasPoint = child.attribute("x") || child.attribute("y");
            if (int(hasStructure) + int(hasNear) + int(hasPoint) != 1) fail(q, "area '" + a.key + "' takes exactly one of structure=, near=\"npc:<key>\" or x= y=");
            if (hasStructure) {
                a.kind = QuestArea::Kind::Structure;
                a.structure = cv::key(child, "structure");
                if (refs.structure && !refs.structure(a.structure)) fail(q, "area '" + a.key + "' names unknown structure '" + a.structure + "'");
            } else {
                a.radius = cv::number(child, "radius", 0, 5000);
                if (a.radius < 50) fail(q, "area '" + a.key + "' needs radius= of 50..5000");
                if (hasNear) {
                    // Not `near`: windows.h defines it as a macro.
                    const std::string around = child.attribute("near").as_string();
                    if (around.rfind("npc:", 0) != 0) fail(q, "area '" + a.key + "': near= must be npc:<key>");
                    a.kind = QuestArea::Kind::Npc;
                    a.npc = around.substr(4);
                    if (!refs.npc(a.npc)) fail(q, "area '" + a.key + "' names unknown npc '" + a.npc + "'");
                } else {
                    a.kind = QuestArea::Kind::Point;
                    a.x = static_cast<int32_t>(cv::number(child, "x", 0, 1000000));
                    a.y = static_cast<int32_t>(cv::number(child, "y", 0, 1000000));
                }
            }
            if (d.areas.size() >= 8) fail(q, "at most 8 areas per quest");
            for (const auto& other : d.areas) if (other.key == a.key) fail(q, "duplicate area '" + a.key + "'");
            d.areas.push_back(std::move(a));
        } else if (tag == "ending") {
            d.endings.push_back({cv::key(child), cv::text(child, "journal")});
        } else if (tag == "dialogue") {
            const std::string npc = cv::key(child, "npc");
            if (!refs.npc(npc)) fail(q, "<dialogue> names unknown npc '" + npc + "'");
            for (auto r : child.children()) {
                if (!element(r)) continue;
                if (std::string(r.name()) != "reply") fail(q, "unknown <" + std::string(r.name()) + "> inside <dialogue>");
                QuestDialogueReply reply;
                reply.npc = npc;
                reply.keyword = keyword(r, q);
                reply.text = cv::text(r, "text");
                if (reply.text.empty()) fail(q, "a dialogue reply needs text=");
                if (r.attribute("stage")) reply.stage = cv::key(r, "stage");
                if (r.attribute("state")) {
                    QuestState state{};
                    if (!parseState(r.attribute("state").as_string(), state)) fail(q, "a dialogue reply has an invalid state=");
                    reply.state = state;
                }
                if (!reply.stage.empty() && reply.state) fail(q, "a dialogue reply takes stage= or state=, not both");
                d.dialogue.push_back(std::move(reply));
            }
        } else {
            fail(q, "unknown <" + tag + "> inside <quest>");
        }
    }
    if (d.stages.empty() || d.stages.size() > MAX_STAGES) fail(q, "needs 1..32 stages");
    // Area references become the "<quest>.<area>" ids the events carry.
    const auto areaId = [&](const std::string& area, const std::string& where) {
        for (const auto& a : d.areas) if (a.key == area) return a.id;
        fail(q, where + " names unknown area '" + area + "' (add <area key=\"" + area + "\" .../> to the quest)");
    };
    for (auto& s : d.stages)
        for (auto& o : s.objectives)
            if (o.type == ObjectiveType::EnterArea) o.target = areaId(o.target, "objective '" + o.key + "'");
    for (auto& e : d.eventStarts)
        if (e.type == EventType::EnterArea && e.target.find('.') == std::string::npos) e.target = areaId(e.target, "an <enter> start");
    checkGraph(d);
    return d;
}

void quest_loader::validateSet(const std::vector<QuestDefinition>& quests)
{
    if (quests.size() > MAX_QUESTS) throw std::runtime_error("at most 64 quests may be loaded");
    std::set<std::string> keys;
    std::map<std::string, std::string> owners; // "npc/keyword" -> quest
    const auto claim = [&](const std::string& npc, const std::string& word, const std::string& quest) {
        const auto [it, fresh] = owners.emplace(npc + "/" + word, quest);
        if (!fresh && it->second != quest)
            throw std::runtime_error("quests '" + it->second + "' and '" + quest + "' both use keyword '" + word + "' at npc '" + npc + "'");
    };
    for (const auto& d : quests) {
        if (!keys.insert(d.key).second) throw std::runtime_error("duplicate quest '" + d.key + "'");
        for (const auto& s : d.talkStarts) claim(s.npc, s.keyword, d.key);
        for (const auto& s : d.stages)
            for (const auto& o : s.objectives)
                if (o.type == ObjectiveType::Talk || o.type == ObjectiveType::Give) claim(o.npc, o.keyword, d.key);
        for (const auto& r : d.dialogue) claim(r.npc, r.keyword, d.key);
    }
    for (const auto& d : quests) {
        for (const auto& r : d.requirements) {
            if (r.quest.empty()) continue;
            if (r.quest == d.key || !keys.count(r.quest)) throw std::runtime_error("quest '" + d.key + "' requires unknown quest '" + r.quest + "'");
        }
    }
}

std::vector<QuestDefinition> quest_loader::loadDirectory(const fs::path& directory, const QuestRefs& refs)
{
    if (!fs::is_directory(directory)) throw std::runtime_error("quest directory not found: " + directory.string());
    std::vector<fs::path> files;
    for (const auto& entry : fs::directory_iterator(directory)) {
        if (entry.is_regular_file() && entry.path().extension() == ".xml") files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end());
    if (files.size() > MAX_QUESTS) throw std::runtime_error("at most 64 quest files may be loaded");
    std::vector<QuestDefinition> quests;
    for (const auto& path : files) {
        const std::string name = path.filename().string();
        if (fs::file_size(path) > 256 * 1024) throw std::runtime_error(name + ": larger than 256 KiB");
        pugi::xml_document doc;
        const auto parsed = doc.load_file(path.string().c_str());
        if (!parsed) throw std::runtime_error(name + ": " + parsed.description());
        const pugi::xml_node root = doc.document_element();
        if (std::string(root.name()) != "quest") throw std::runtime_error(name + ": the root element must be <quest>");
        try {
            quests.push_back(parse(root, refs));
        } catch (const std::exception& e) {
            throw std::runtime_error(name + ": " + e.what());
        }
        if (quests.back().key != path.stem().string())
            throw std::runtime_error(name + ": key=\"" + quests.back().key + "\" must match the file name");
    }
    validateSet(quests);
    return quests;
}
