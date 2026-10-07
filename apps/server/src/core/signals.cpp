// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "core/signals.h"

#include "content/configmanager.h"
#include "gameplay/game.h"
#include "core/scheduler.h"
#include "core/tasks.h"

#include <csignal>

extern Scheduler g_scheduler;
extern Dispatcher g_dispatcher;
extern Game g_game;

namespace {

#ifndef _WIN32
	void sigusr1Handler()
	{
		// Dispatcher thread
		std::cout << "SIGUSR1 received, saving the game state..." << std::endl;
	}

	void sighupHandler()
	{
		// Dispatcher thread
		std::cout << "SIGHUP received, reloading config files..." << std::endl;

		ConfigManager::load();
		std::cout << "Reloaded config." << std::endl;

	}
#else
	void sigbreakHandler()
	{
		// Dispatcher thread
		std::cout << "SIGBREAK received, shutting game server down..." << std::endl;
		g_game.setGameState(GAME_STATE_SHUTDOWN);
	}
#endif

	void sigtermHandler()
	{
		// Dispatcher thread
		std::cout << "SIGTERM received, shutting game server down..." << std::endl;
		g_game.setGameState(GAME_STATE_SHUTDOWN);
	}

	void sigintHandler()
	{
		// Dispatcher thread
		std::cout << "SIGINT received, shutting game server down..." << std::endl;
		g_game.setGameState(GAME_STATE_SHUTDOWN);
	}

	// On Windows this function does not need to be signal-safe,
	// as it is called in a new thread.
	// https://github.com/otland/forgottenserver/pull/2473
	void dispatchSignalHandler(int signal)
	{
		switch (signal) {
		case SIGINT: // Shuts the server down
			g_dispatcher.addTask(sigintHandler);
			break;
		case SIGTERM: // Shuts the server down
			g_dispatcher.addTask(sigtermHandler);
			break;
#ifndef _WIN32
		case SIGHUP: // Reload config/data
			g_dispatcher.addTask(sighupHandler);
			break;
		case SIGUSR1: // Saves game state
			g_dispatcher.addTask(sigusr1Handler);
			break;
#else
		case SIGBREAK: // Shuts the server down
			g_dispatcher.addTask(sigbreakHandler);
			// hold the thread until other threads end
			g_scheduler.join();
			g_dispatcher.join();
			break;
#endif
		default:
			break;
		}
	}

} // namespace

Signals::Signals(boost::asio::io_context& ioc) : set(ioc)
{
	set.add(SIGINT);
	set.add(SIGTERM);
#ifndef _WIN32
	set.add(SIGUSR1);
	set.add(SIGHUP);
#else
	// This must be a blocking call as Windows calls it in a new thread and terminates the process when the handler
	// returns (or after 5 seconds, whichever is earlier). On Windows it is called in a new thread.
	signal(SIGBREAK, dispatchSignalHandler);
#endif

	asyncWait();
}

void Signals::asyncWait()
{
	set.async_wait([this](const boost::system::error_code& err, int signal) {
		if (err) {
			std::cerr << "Signal handling error: " << err.message() << std::endl;
			return;
		}
		dispatchSignalHandler(signal);
		asyncWait();
		});
}
