// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

// The pluggable brains. A behavior reads bot.x()/y()/others() and drives the
// bot through setMove/setRotation/send.
//
// Because MOVE/ROTATE/SPRINT are state-change opcodes (client.js only sends
// them when the value actually changes), behaviors go through Bot::setMove and
// friends rather than Bot::send, so the input traffic matches a real client's.

#pragma once

#include "bot.h"

#include <string>

namespace bot {

struct BehaviorOptions {
	// Fraction of the fleet that actually shoots in `combat`, so deaths can be
	// thinned when population churn would swamp a comparison.
	double fireRatio = 1.0;
	// How far a `crowd` bot may wander from where it spawned, in world units.
	// The point of the scenario is that they stay packed into one area, so this
	// is what decides how many of them share a viewport.
	double crowdRadius = 600.0;
	// Bot tick rate, needed by behaviors whose timings are in ticks.
	int tickHz = 10;
};

// Names accepted by --behavior. Unknown names are a startup error.
BehaviorPtr makeBehavior(const std::string& name, const BehaviorOptions& opts, int botIndex);
bool behaviorExists(const std::string& name);
std::string behaviorNames();

} // namespace bot
