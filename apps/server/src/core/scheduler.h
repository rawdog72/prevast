// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCHEDULER_H
#define FS_SCHEDULER_H

#include "core/tasks.h"
#include "core/thread_holder_base.h"

static constexpr int32_t SCHEDULER_MINTICKS = 50;

class SchedulerTask : public Task
{
public:
	void setEventId(uint32_t id) { eventId = id; }
	uint32_t getEventId() const { return eventId; }

	uint32_t getDelay() const { return delay; }

private:
	SchedulerTask(uint32_t delay, TaskFunc&& f) : Task(std::move(f)), delay(delay) {}

	uint32_t eventId = 0;
	uint32_t delay = 0;

	friend SchedulerTask* createSchedulerTask(uint32_t, TaskFunc&&);
};

SchedulerTask* createSchedulerTask(uint32_t delay, TaskFunc&& f);

class Scheduler : public ThreadHolder<Scheduler>
{
public:
	uint32_t addEvent(SchedulerTask* task);
	// Once this returns, the event's task will not run -- including an event
	// whose timer has already expired and whose task is queued on the
	// dispatcher behind other work.
	void stopEvent(uint32_t eventId);

	void shutdown();

	void threadMain() { io_context.run(); }

private:
	// Claims a fired event for execution. False when it was stopped first.
	bool claimEvent(uint32_t eventId);
	void forgetEvent(uint32_t eventId);

	std::atomic<uint32_t> lastEventId{ 0 };
	// Events added and neither run nor stopped yet. Timer cancellation alone
	// cannot stop a task that already reached the dispatcher queue: callers that
	// stopped an action and started the next one used to see the old one
	// complete anyway (a cancelled craft finishing the new craft at once, a
	// cancelled meal still being eaten).
	std::mutex pendingLock;
	std::unordered_set<uint32_t> pendingEvents;
	std::unordered_map<uint32_t, boost::asio::steady_timer> eventIdTimerMap;
	boost::asio::io_context io_context;
	boost::asio::executor_work_guard<boost::asio::io_context::executor_type> work{ io_context.get_executor() };
};

extern Scheduler g_scheduler;

#endif // FS_SCHEDULER_H
