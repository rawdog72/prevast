// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SERVERLISTING_H
#define FS_SERVERLISTING_H

// Heartbeat to the site that serves the client's server list: this server
// POSTs what it is and how full it is every listingIntervalSeconds, and the
// site drops anything that stops beating. That is what lets a server appear
// and disappear from the list without anyone editing a file, and what makes
// the !server-* commands show up for players.
//
// The POST runs on a worker thread of its own, so an unreachable site cannot
// stall the game.
namespace ServerListing {

	// No-op when listingUrl is unset. Call once, after the world is up.
	void start();

	// Sends a final "offline" beat so the server leaves the list immediately
	// instead of aging out, then stops the worker.
	void stop();

	// An admin changed something players can see. Beats now rather than
	// waiting out the interval.
	void notifyChanged();

} // namespace ServerListing

#endif // FS_SERVERLISTING_H
