// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/progress/game_event.h"

EventBus g_events;

namespace {
constexpr std::pair<EventType, std::string_view> NAMES[] = {
    {EventType::Kill, "kill"},     {EventType::Bounty, "bounty"},   {EventType::Craft, "craft"},
    {EventType::Gather, "gather"}, {EventType::Destroy, "destroy"}, {EventType::Build, "build"},
    {EventType::Pickup, "pickup"}, {EventType::Use, "use"},
    {EventType::QuestComplete, "quest_complete"}, {EventType::Death, "death"}, {EventType::SurvivedMinute, "survived_minute"},
    {EventType::PlayerKill, "player_kill"},
    {EventType::EnterArea, "enter_area"}, {EventType::LeaveArea, "leave_area"},
};
// A listener may emit while handling an event, but only this deep: a reward
// that causes an event that pays a reward is a content loop, not a feature.
constexpr uint32_t MAX_DEPTH = 4;
}

void EventBus::subscribe(EventListener* listener)
{
    if (listener && std::find(listeners.begin(), listeners.end(), listener) == listeners.end()) {
        listeners.push_back(listener);
    }
}

void EventBus::unsubscribe(EventListener* listener)
{
    listeners.erase(std::remove(listeners.begin(), listeners.end(), listener), listeners.end());
}

void EventBus::emit(const GameEvent& event)
{
    if (depth >= MAX_DEPTH) {
        fmt::print(">> [Warning] '{}' event dropped: listeners nested {} deep\n", eventTypeName(event.type), depth);
        return;
    }
    struct Depth {
        uint32_t& value;
        explicit Depth(uint32_t& v) : value(v) { ++value; }
        ~Depth() { --value; }
    } guard(depth);
    const auto snapshot = listeners; // a listener may unsubscribe while handling
    for (EventListener* listener : snapshot) listener->onGameEvent(event);
}

const char* eventTypeName(EventType type)
{
    for (const auto& [value, name] : NAMES) {
        if (value == type) return name.data();
    }
    return "unknown";
}

bool parseEventType(std::string_view name, EventType& out)
{
    for (const auto& [value, text] : NAMES) {
        if (text == name) {
            out = value;
            return true;
        }
    }
    return false;
}

int runEventBusSelfTest()
{
    int failed = 0;
    const auto check = [&](bool ok, std::string_view what) {
        if (!ok) {
            ++failed;
            fmt::print(">> event bus self-test FAILED: {}\n", what);
        }
    };

    struct Recorder final : EventListener {
        std::vector<std::string> seen;
        void onGameEvent(const GameEvent& e) override
        {
            seen.push_back(fmt::format("{}:{}:{}", eventTypeName(e.type), e.subject, e.count));
        }
    };
    EventBus bus;
    Recorder a, b;
    bus.subscribe(&a);
    bus.subscribe(&a);
    bus.subscribe(&b);
    bus.emit({EventType::Kill, nullptr, "normal_ghoul", 2});
    check(a.seen.size() == 1 && a.seen[0] == "kill:normal_ghoul:2", "a listener subscribed twice hears an event once");
    check(b.seen.size() == 1, "every listener hears the event");
    bus.unsubscribe(&a);
    bus.emit({EventType::Craft, nullptr, "bandage"});
    check(a.seen.size() == 1 && b.seen.size() == 2, "an unsubscribed listener hears nothing");

    struct Echo final : EventListener {
        EventBus* bus = nullptr;
        int heard = 0;
        void onGameEvent(const GameEvent& e) override { ++heard; bus->emit(e); }
    };
    EventBus loop;
    Echo echo;
    echo.bus = &loop;
    loop.subscribe(&echo);
    loop.emit({EventType::Use, nullptr, "x"});
    check(echo.heard == 4, "nested emits stop at depth 4");

    EventType parsed{};
    check(parseEventType("destroy", parsed) && parsed == EventType::Destroy, "event names parse");
    check(!parseEventType("teleport", parsed), "unknown event names are rejected");

    fmt::print(">> event bus self-test: {}\n", failed == 0 ? "passed" : "FAILED");
    return failed == 0 ? 0 : 1;
}
