// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only
#include "core/otpch.h"
#include "gameplay/progress/account_runs.h"
#include "gameplay/progress/progress_system.h"
#include "gameplay/game.h"
#include "gameplay/player.h"
#include "content/configmanager.h"
#include "network/http_client.h"
#include "network/networkmessage.h"
#include "network/opcodes.h"
#include <filesystem>
#include <fstream>
#include <random>

extern Game g_game;
AccountRunSystem g_accountRuns;
namespace ar {
namespace j = boost::json;
uint64_t wall() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
uint64_t number(const j::object& o, const char* key) { const auto* v=o.if_contains(key); return v?v->to_number<uint64_t>():0; }
std::filesystem::path path() { return std::filesystem::path(getString(ConfigManager::STORAGE_PATH))/"account-runs-outbox.json"; }
HttpClient::Headers headers() { return {{"X-Account-Progress-Token",getString(ConfigManager::ACCOUNT_PROGRESS_TOKEN)}}; }
std::string url(const std::string& route) {
    std::string base=getString(ConfigManager::ACCOUNT_SERVICE_URL);
    while(!base.empty() && base.back()=='/') base.pop_back();
    return base+"/api/servers/community/"+route;
}
void packet(Player* p, ServerOpcode op, const j::object& body) {
    if(!p || !p->getProtocolGame()) return;
    const std::string json=j::serialize(body);
    if(json.size()>7800) return;
    NetworkMessage msg; msg.addByte(static_cast<uint8_t>(op)); msg.addString(json); p->sendNetworkMessage(msg);
}
}
bool AccountRunSystem::enabled() const { return g_progress.enabled() && !rules.empty(); }
bool AccountRunSystem::eligible(const Player* p) const {
    if(!p || p->isGhoul() || p->getGroupId()!=g_groups.defaultGroup().id || p->isInvincible() || p->isGhostMode()) return false;
    const auto found=runs.find(p->getID());
    return approved && found!=runs.end() && found->second.state.at("eligible").as_bool();
}
void AccountRunSystem::configure(const std::string& statsFile) {
    const auto file=std::filesystem::path(statsFile).parent_path().parent_path()/"account-progression.json";
    try {
        std::ifstream in(file); if(!in) throw std::runtime_error("cannot read "+file.string());
        std::string text((std::istreambuf_iterator<char>(in)),{});
        auto next=ar::j::parse(text).as_object();
        if(!ar::number(next,"version") || !ar::number(next,"scorePerGoldenCap")) throw std::runtime_error("invalid progression rules");
        rules=std::move(next); scorePerCap=ar::number(rules,"scorePerGoldenCap");
        repeatMs=ar::number(rules,"pvpRepeatVictimCooldownSeconds")*1000;
        outlawKarma=static_cast<uint8_t>(ar::number(rules,"outlawMinKarma"));
    } catch(const std::exception& e) {
        rules.clear(); fmt::print(">> Account run rules disabled: {}\n",e.what());
    }
}
void AccountRunSystem::start() {
    if(!enabled()) return;
    std::random_device random;
    bootId=fmt::format("{:x}-{:x}{:x}",ar::wall(),random(),random());
    try {
        std::ifstream in(ar::path());
        if(in) {
            std::string text((std::istreambuf_iterator<char>(in)),{});
            const auto old=ar::j::parse(text).as_object();
            for(const auto& entry:old.at("outbox").as_array()) {
                const auto& o=entry.as_object(); outbox.push_back({std::string(o.at("route").as_string()),o.at("body").as_object()});
            }
            if(const auto* failures=old.if_contains("rejected")) rejected=failures->as_array();
            // Saved living characters do not survive a process restart. Their last
            // durable checkpoint remains available, with no fabricated death.
            for(const auto& entry:old.at("active").as_array()) {
                auto state=entry.as_object(); state["revision"]=ar::number(state,"revision")+1;
                state["end"]="interrupted";
                outbox.push_back({"report",std::move(state)});
            }
        }
    } catch(const std::exception& e) {
        // Preserve the file and disable new accounting rather than replacing unreadable money receipts.
        fmt::print(">> Account run outbox requires repair; accounting disabled: {}\n",e.what());
        rules.clear(); return;
    }
    outbox.push_back({"boot",ar::j::object{{"bootId",bootId}}});
    durable=save();
}
bool AccountRunSystem::save() {
    try {
        ar::j::array pending,active;
        for(const auto& r:outbox) pending.push_back(ar::j::object{{"route",r.route},{"body",r.body}});
        for(const auto& [id,r]:runs) {
            auto snapshot=r.state; snapshot["events"]=r.events; snapshot["awards"]=r.awards;
            snapshot["at"]=std::max(ar::wall(),ar::number(snapshot,"at"));
            snapshot["survivedSeconds"]=r.aliveMs/1000;
            if(const Player* p=g_game.getPlayerByID(id)) { snapshot["score"]=p->getScore(); snapshot["kills"]=p->getKills(); }
            active.push_back(std::move(snapshot));
        }
        const auto file=ar::path(), temporary=std::filesystem::path(file.string()+".tmp");
        std::filesystem::create_directories(file.parent_path());
        {
            std::ofstream out(temporary,std::ios::binary|std::ios::trunc);
            out<<ar::j::serialize(ar::j::object{{"version",1},{"outbox",std::move(pending)},{"active",std::move(active)},{"rejected",rejected}});
            out.flush(); if(!out) throw std::runtime_error("write failed");
        }
        std::filesystem::rename(temporary,file);
        return true;
    } catch(const std::exception& e) { fmt::print(">> Account run outbox not durable: {}\n",e.what()); return false; }
}
void AccountRunSystem::attach(Player* p) {
    if(!enabled() || !p) return;
    if(!p->getAccountId() || p->isGhoul()) { sendIdentity(p); return; }
    auto [it,created]=runs.try_emplace(p->getID());
    if(created) {
        Run& r=it->second; const uint64_t now=ar::wall(); const auto* mode=g_game.getActiveMode();
        bool modeAllowed=false;
        for(const auto& key:rules.at("rankedModes").as_array()) if(mode && key.as_string()==mode->key) modeAllowed=true;
        r.state={{"runId",bootId+":"+std::to_string(++sequence)},{"bootId",bootId},{"accountId",p->getAccountId()},
            {"revision",0},{"startedAt",now},{"at",now},{"mode",mode?mode->key:"unknown"},
            {"rulesVersion",ar::number(rules,"version")},{"score",p->getScore()},{"earnedScore",0},{"kills",0},
            {"survivedSeconds",0},{"end","alive"},{"eligible",modeAllowed && p->getGroupId()==g_groups.defaultGroup().id},
            {"events",ar::j::array{}},{"awards",ar::j::array{}}};
        r.bestScore=bests[p->getAccountId()];
        checkpoint(p,r,"alive");
    }
    stateAt=0; fetchState(); sendLive(p,it->second); sendIdentity(p);
}
void AccountRunSystem::checkpoint(Player* p, Run& r, const char* ending) {
    r.state["revision"]=ar::number(r.state,"revision")+1;
    r.state["at"]=std::max(ar::wall(),ar::number(r.state,"at"));
    r.state["score"]=p?p->getScore():ar::number(r.state,"score");
    r.state["kills"]=p?p->getKills():ar::number(r.state,"kills");
    r.state["survivedSeconds"]=r.aliveMs/1000;
    r.state["end"]=ending;
    auto report=r.state; report["events"]=std::move(r.events); report["awards"]=std::move(r.awards);
    r.events={}; r.awards={};
    outbox.push_back({"report",std::move(report)});
    durable=save();
}
void AccountRunSystem::finish(Player* p,bool death) {
    if(!p) return;
    const auto it=runs.find(p->getID()); if(it==runs.end()) return;
    sendLive(p,it->second);
    Run r=std::move(it->second); runs.erase(it);
    checkpoint(p,r,death?"death":"interrupted");
}
void AccountRunSystem::stop() {
    for(auto it=runs.begin();it!=runs.end();) {
        const uint32_t id=it->first; ++it;
        if(Player* p=g_game.getPlayerByID(id)) finish(p,false);
    }
    if(enabled()) durable=save();
}
void AccountRunSystem::earned(Player* p,uint32_t amount,bool allowed) {
    auto it=p?runs.find(p->getID()):runs.end();
    if(it==runs.end() || !allowed || !eligible(p) || !amount) return;
    Run& r=it->second;
    const uint64_t before=ar::number(r.state,"earnedScore"), after=before+amount;
    r.state["earnedScore"]=after;
    r.events.push_back(ar::j::object{{"seq",++r.seq},{"at",std::max(ar::wall(),ar::number(r.state,"at"))},{"score",amount},{"kills",0}});
    const auto clan=clans.find(p->getAccountId());
    if(clan!=clans.end() && clan->second.is_object()) r.clanContribution+=amount;
    if(before/scorePerCap!=after/scorePerCap || r.events.size()>=512) checkpoint(p,r,"alive");
}
bool AccountRunSystem::playerKill(Player* killer,Player* victim) {
    if(!eligible(killer) || !victim || !victim->getAccountId() || killer==victim ||
        killer->getAccountId()==victim->getAccountId() || killer->getIP()==victim->getIP() || victim->isGhoul()) return false;
    const auto a=clans.find(killer->getAccountId()), b=clans.find(victim->getAccountId());
    // Unknown affiliations are refreshed at login; until then PvP awards wait.
    if(a==clans.end() || b==clans.end()) return false;
    if(a->second.is_object() && b->second.is_object() &&
        ar::number(a->second.as_object(),"id")==ar::number(b->second.as_object(),"id")) return false;
    Run& r=runs.at(killer->getID()); const uint64_t now=ar::wall();
    uint64_t& last=r.victims[victim->getAccountId()];
    if(last && now-last<repeatMs) return false;
    last=now;
    r.events.push_back(ar::j::object{{"seq",++r.seq},{"at",now},{"score",0},{"kills",1}});
    return true;
}
void AccountRunSystem::disqualify(Player* p) {
    if(!p) return;
    auto it=runs.find(p->getID()); if(it==runs.end()) return;
    it->second.state["eligible"]=false;
    checkpoint(p,it->second,"alive");
}
void AccountRunSystem::achievement(Player* p,const std::string& key) {
    if(!eligible(p)) return;
    const auto& rewards=rules.at("achievementRewards").as_object();
    if(!rewards.contains(key)) return;
    Run& r=runs.at(p->getID());
    if(!r.awardKeys.insert("achievement:"+key).second) return;
    r.awards.push_back(ar::j::object{{"kind","achievement"},{"key",key},{"occurrence","once"},{"at",std::max(ar::wall(),ar::number(r.state,"at"))}});
    checkpoint(p,r,"alive");
}
bool AccountRunSystem::hasEventReward(const std::string& key) const {
    const auto* rewards=rules.if_contains("eventRewards");
    return rewards && rewards->is_object() && rewards->as_object().contains(key);
}
bool AccountRunSystem::eventReward(Player* p,const std::string& key,const std::string& occurrence) {
    if(!eligible(p) || occurrence.empty() || occurrence.size()>96 || key.size()>64) return false;
    const auto& rewards=rules.at("eventRewards").as_object();
    if(!hasEventReward(key)) return false;
    Run& r=runs.at(p->getID());
    if(!r.awardKeys.insert("event:"+key+":"+occurrence).second) return false;
    r.awards.push_back(ar::j::object{{"kind","event"},{"key",key},{"occurrence",occurrence},{"at",std::max(ar::wall(),ar::number(r.state,"at"))}});
    checkpoint(p,r,"alive"); return true;
}
void AccountRunSystem::sendLive(Player* p,const Run& r) {
    const uint64_t earned=ar::number(r.state,"earnedScore");
    uint64_t reward=0;
    for(const auto& key:r.awardKeys) {
        const bool ach=key.starts_with("achievement:"); const size_t prefix=ach?12:6;
        const auto plain=key.substr(prefix,key.find(':',prefix)-prefix);
        const auto& rewards=rules.at(ach?"achievementRewards":"eventRewards").as_object();
        if(const auto* amount=rewards.if_contains(plain)) reward+=amount->to_number<uint64_t>();
    }
    ar::packet(p,ServerOpcode::ACCOUNT_RUN,ar::j::object{{"runId",r.state.at("runId")},
        {"earnedScore",earned},{"scorePerCap",scorePerCap},{"scoreCaps",earned/scorePerCap},{"rewardCaps",reward},
        {"survivedSeconds",r.aliveMs/1000},{"bestScore",r.bestScore},{"clanContribution",r.clanContribution},{"ranked",eligible(p)}});
}
void AccountRunSystem::sendIdentity(Player* to) {
    ar::j::array values;
    const auto flush=[&]() {
        if(values.empty()) return;
        const ar::j::object body{{"players",values}};
        if(to) ar::packet(to,ServerOpcode::ACCOUNT_CLANS,body);
        else for(const auto& [id,p]:g_game.getPlayers()) ar::packet(p,ServerOpcode::ACCOUNT_CLANS,body);
        values.clear();
    };
    for(const auto& [id,p]:g_game.getPlayers()) {
        const auto found=clans.find(p->getAccountId());
        values.push_back(ar::j::object{{"pid",p->getGUID()},{"clan",found!=clans.end()?found->second:ar::j::value(nullptr)}});
        if(values.size()>=40) flush();
    }
    flush();
}
void AccountRunSystem::fetchState() {
    if(fetching || ar::wall()<stateAt || !enabled()) return;
    fetching=true; stateAt=ar::wall()+60000;
    ar::j::array ids;
    for(const auto& [id,p]:g_game.getPlayers()) if(p->getAccountId()) ids.push_back(p->getAccountId());
    HttpClient::requestAsync("POST",ar::url("state"),ar::headers(),ar::j::serialize(ar::j::object{{"accounts",ids}}),
        [this](HttpClient::Response response) {
            fetching=false;
            try {
                if(response.status!=200) throw std::runtime_error("state unavailable");
                const auto body=ar::j::parse(response.body).as_object();
                approved=body.at("ranked").as_bool() && ar::number(body.at("rules").as_object(),"version")==ar::number(rules,"version");
                clans.clear();
                for(const auto& value:body.at("identities").as_array()) {
                    const auto& row=value.as_object(); clans[static_cast<uint32_t>(ar::number(row,"id"))]=row.at("clan");
                }
                for(const auto& value:body.at("bests").as_array()) {
                    const auto& row=value.as_object(); bests[static_cast<uint32_t>(ar::number(row,"id"))]=static_cast<uint32_t>(ar::number(row,"score"));
                }
                for(auto& [id,r]:runs) if(Player* p=g_game.getPlayerByID(id)) r.bestScore=bests[p->getAccountId()];
                sendIdentity(nullptr);
            } catch(const std::exception&) {
                // Retain the last authenticated approval during a transient outage.
                // The web service still checks its allowlist before committing queued rewards.
                stateAt=ar::wall()+10000;
            }
        });
}
void AccountRunSystem::send() {
    if(sending || outbox.empty() || ar::wall()<retryAt || !enabled()) return;
    if(!durable && !(durable=save())) { retryAt=ar::wall()+5000; return; }
    sending=true;
    const auto report=outbox.front();
    HttpClient::requestAsync("POST",ar::url(report.route),ar::headers(),ar::j::serialize(report.body),
        [this](HttpClient::Response response) {
            sending=false;
            if(outbox.empty()) return;
            if(response.status>=200 && response.status<300) {
                outbox.pop_front(); backoff=0; retryAt=0; durable=save(); send(); return;
            }
            if(response.status==400 || response.status==409 || response.status==413 || response.status==422) {
                const auto bad=outbox.front(); rejected.push_back(ar::j::object{{"route",bad.route},{"body",bad.body},{"status",response.status},{"error",response.body}});
                outbox.pop_front(); durable=save();
                fmt::print(">> Account report rejected ({}); preserved in account-runs-outbox.json for repair.\n",response.status);
                retryAt=ar::wall()+1000; return;
            }
            backoff=std::min<uint32_t>(300000,backoff?backoff*2:5000); retryAt=ar::wall()+backoff;
        });
}
void AccountRunSystem::update(uint32_t elapsedMs) {
    if(!enabled()) return;
    elapsed+=elapsedMs; pushElapsed+=elapsedMs;
    for(auto& [id,r]:runs) {
        Player* p=g_game.getPlayerByID(id); if(!p) continue;
        if(p->getHealth()>0) r.aliveMs+=elapsedMs;
        if(pushElapsed>=2000) sendLive(p,r);
        if(elapsed>=30000) checkpoint(p,r,"alive");
    }
    if(pushElapsed>=2000) pushElapsed=0;
    if(elapsed>=30000) elapsed=0;
    fetchState(); send();
}
