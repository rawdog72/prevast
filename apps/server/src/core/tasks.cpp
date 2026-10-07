// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "core/tasks.h"

#include "core/enums.h"
#include "core/perf.h"
// #include "gameplay/game.h"

// extern Game g_game;

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX // perf.h calls std::min/std::max, which the macros would eat
#endif
#include <windows.h>
#endif

// Kept out of perf.h so <windows.h> is not dragged into every TU that profiles.
uint64_t tfs::perf::currentThreadCpuNanos()
{
#ifdef _WIN32
	FILETIME creation, exit, kernel, user;
	if (!GetThreadTimes(GetCurrentThread(), &creation, &exit, &kernel, &user)) {
		return 0;
	}
	const auto toNanos = [](const FILETIME& ft) {
		// FILETIME counts 100 ns intervals. Resolution is the scheduler quantum
		// (~15.6 ms here), which is why this is only ever read per 5 s window.
		return ((static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime) * 100ULL;
	};
	return toNanos(kernel) + toNanos(user);
#else
	return 0;
#endif
}

Task* createTask(TaskFunc&& f) { return new Task(std::move(f)); }

Task* createTask(uint32_t expiration, TaskFunc&& f) { return new Task(expiration, std::move(f)); }

void Dispatcher::threadMain()
{
	std::vector<Task*> tmpTaskList;
	// NOTE: second argument defer_lock is to prevent from immediate locking
	std::unique_lock<std::mutex> taskLockUnique(taskLock, std::defer_lock);

	while (getState() != THREAD_STATE_TERMINATED) {
		// check if there are tasks waiting
		taskLockUnique.lock();
		if (taskList.empty()) {
			// if the list is empty wait for signal
			taskSignal.wait(taskLockUnique);
		}
		tmpTaskList.swap(taskList);
		taskLockUnique.unlock();

		// Timed as a whole rather than per task type: the question this answers
		// is how much of the 50 ms tick period the dispatcher spends working at
		// all. TickProfiler already knows the movement tick's share, so the
		// remainder is packet handlers plus the other scheduled loops.
		const bool profiling = g_perf.isEnabled();
		for (Task* task : tmpTaskList) {
			if (!task->hasExpired()) {
				++dispatcherCycle;
				// execute it
				if (profiling) {
					const auto started = std::chrono::steady_clock::now();
					(*task)();
					g_dispatchperf.noteTask(static_cast<uint64_t>(
						std::chrono::duration_cast<std::chrono::nanoseconds>(
							std::chrono::steady_clock::now() - started).count()));
				} else {
					(*task)();
				}
			}
			delete task;
		}
		tmpTaskList.clear();
	}
}

void Dispatcher::addTask(Task* task)
{
	bool do_signal = false;

	taskLock.lock();

	if (getState() == THREAD_STATE_RUNNING) {
		do_signal = taskList.empty();
		taskList.push_back(task);
	}
	else {
		delete task;
	}

	taskLock.unlock();

	// send a signal if the list was empty
	if (do_signal) {
		taskSignal.notify_one();
	}
}

void Dispatcher::shutdown()
{
	Task* task = createTask([this]() {
		setState(THREAD_STATE_TERMINATED);
		taskSignal.notify_one();
		});

	std::lock_guard<std::mutex> lockClass(taskLock);
	taskList.push_back(task);

	taskSignal.notify_one();
}
