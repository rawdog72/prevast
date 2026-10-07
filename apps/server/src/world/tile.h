// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_TILE_H
#define FS_TILE_H

#include "core/position.h"
#include "world/thing.h"
#include <algorithm>
#include <vector>

class Tile
{
public:
	Tile(uint16_t x, uint16_t y) : position(x, y) {}
	~Tile() = default;

	// non-copyable
	Tile(const Tile&) = delete;
	Tile& operator=(const Tile&) = delete;

	const Position& getPosition() const { return position; }

	void addThing(Thing* thing) {
		things.push_back(thing);
		if (thing->hasCollision() || thing->getAgent()) {
			solidThings.push_back(thing);
		}
	}

	void removeThing(Thing* thing) {
		auto it = std::find(things.begin(), things.end(), thing);
		if (it != things.end()) {
			*it = things.back();
			things.pop_back();
		}
		auto sit = std::find(solidThings.begin(), solidThings.end(), thing);
		if (sit != solidThings.end()) {
			*sit = solidThings.back();
			solidThings.pop_back();
		}
	}

	const std::vector<Thing*>& getThings() const { return things; }
	const std::vector<Thing*>& getSolidThings() const { return solidThings; }

private:
	Position position; // Grid coordinates (x/100, y/100)
	std::vector<Thing*> things;
	std::vector<Thing*> solidThings;
};

#endif // FS_TILE_H
