// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <cstdint>
#include <string_view>
#include <vector>

class Player;

// Something a player did, reported once by the system that owns the moment and
// fanned out to whoever listens: quests now, account stats and scripts later.
enum class EventType : uint8_t {
    Kill, Bounty, Craft, Gather, Destroy, Build, Pickup, Use,
    QuestComplete,  // subject: quest key
    Death,          // the actor died; subject empty
    SurvivedMinute, // the actor has been alive another minute; subject empty
    EnterArea,      // subject: "<quest>.<area>" (areas are written inside a quest)
    LeaveArea,
    PlayerKill,     // a credited terminal player kill, independent of karma
};

// Whose object a Destroy or Build event was about, seen from the actor.
enum class ObjectOwner : uint8_t { None, Self, Clan, Other };

struct GameEvent {
    EventType type = EventType::Kill;
    Player* actor = nullptr;
    std::string_view subject;              // agent, item, object or resource key
    uint32_t count = 1;
    ObjectOwner owner = ObjectOwner::None; // Destroy and Build only
    Player* victim = nullptr;              // Bounty only
    std::string_view tag;                  // Kill: the agent's quest tag (spawned by a script), else empty
};

class EventListener {
public:
    virtual ~EventListener() = default;
    virtual void onGameEvent(const GameEvent& event) = 0;
};

class EventBus {
public:
    void subscribe(EventListener* listener);
    void unsubscribe(EventListener* listener);
    void emit(const GameEvent& event);

private:
    std::vector<EventListener*> listeners;
    uint32_t depth = 0;
};

extern EventBus g_events;

const char* eventTypeName(EventType type);
bool parseEventType(std::string_view name, EventType& out);
int runEventBusSelfTest();
