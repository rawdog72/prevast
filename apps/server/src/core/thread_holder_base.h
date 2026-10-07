// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_THREAD_HOLDER_BASE_H
#define FS_THREAD_HOLDER_BASE_H

#include "core/enums.h"

template <typename Derived>
class ThreadHolder
{
public:
	ThreadHolder() {}
	void start()
	{
		setState(THREAD_STATE_RUNNING);
		thread = std::thread(&Derived::threadMain, static_cast<Derived*>(this));
	}

	void stop() { setState(THREAD_STATE_CLOSING); }

	void join()
	{
		if (thread.joinable()) {
			thread.join();
		}
	}

protected:
	void setState(ThreadState newState) { threadState.store(newState, std::memory_order_relaxed); }

	ThreadState getState() const { return threadState.load(std::memory_order_relaxed); }

private:
	std::atomic<ThreadState> threadState{ THREAD_STATE_TERMINATED };
	std::thread thread;
};

#endif // FS_THREAD_HOLDER_BASE_H
