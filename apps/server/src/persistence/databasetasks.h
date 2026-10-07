// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_DATABASETASKS_H
#define FS_DATABASETASKS_H

#include "persistence/database.h"
#include "core/thread_holder_base.h"

struct DatabaseTask
{
	DatabaseTask(std::string&& query, std::function<void(DBResult_ptr, bool)>&& callback, bool store) :
		query(std::move(query)), callback(std::move(callback)), store(store)
	{
	}

	std::string query;
	std::function<void(DBResult_ptr, bool)> callback;
	bool store;
};

class DatabaseTasks : public ThreadHolder<DatabaseTasks>
{
public:
	DatabaseTasks() = default;
	void start();
	void flush();
	void shutdown();

	void addTask(std::string query, std::function<void(DBResult_ptr, bool)> callback = nullptr, bool store = false);

	void threadMain();

private:
	void runTask(const DatabaseTask& task);

	Database db;
	std::thread thread;
	std::list<DatabaseTask> tasks;
	std::mutex taskLock;
	std::condition_variable taskSignal;
};

extern DatabaseTasks g_databaseTasks;

#endif // FS_DATABASETASKS_H
