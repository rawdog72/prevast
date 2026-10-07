// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "world/placement.h"

#include "core/tools.h"

#include <algorithm>

PlacementLedger g_placements;

uint32_t PlacementLedger::open(PlacementSource source, const std::string& assetKey,
                               const PlacementRect& rect, uint32_t placedBy, bool isCity)
{
	MapInstance instance;
	instance.id = nextInstanceId++;
	instance.source = source;
	instance.assetKey = assetKey;
	instance.rect = rect;
	instance.placedAt = static_cast<uint64_t>(OTSYS_TIME());
	instance.placedBy = placedBy;
	instance.isCity = isCity;

	instances.push_back(std::move(instance));
	return instances.back().id;
}

MapInstance* PlacementLedger::findMutable(uint32_t instanceId)
{
	if (instanceId == 0) {
		return nullptr;
	}
	for (MapInstance& instance : instances) {
		if (instance.id == instanceId) {
			return &instance;
		}
	}
	return nullptr;
}

const MapInstance* PlacementLedger::find(uint32_t instanceId) const
{
	return const_cast<PlacementLedger*>(this)->findMutable(instanceId);
}

void PlacementLedger::record(uint32_t instanceId, uint32_t entityId)
{
	if (entityId == 0) {
		return;
	}
	MapInstance* instance = findMutable(instanceId);
	if (!instance) {
		return;
	}

	// Reassignment rather than insert: the pool may have handed this id back out
	// after its previous holder died, and the newest stamp owns it.
	instance->entityIds.push_back(entityId);
	owner[entityId] = instanceId;
}

void PlacementLedger::record(uint32_t instanceId, const std::vector<uint32_t>& entityIds)
{
	MapInstance* instance = findMutable(instanceId);
	if (!instance) {
		return;
	}

	instance->entityIds.reserve(instance->entityIds.size() + entityIds.size());
	for (const uint32_t entityId : entityIds) {
		if (entityId == 0) {
			continue;
		}
		instance->entityIds.push_back(entityId);
		owner[entityId] = instanceId;
	}
}

void PlacementLedger::forget(uint32_t entityId)
{
	// The stale id stays in its instance's vector; `owner` losing the entry is
	// what makes it stop counting. See the note on `owner`.
	owner.erase(entityId);
}

const MapInstance* PlacementLedger::owning(uint32_t entityId) const
{
	const auto it = owner.find(entityId);
	if (it == owner.end()) {
		return nullptr;
	}
	return find(it->second);
}

std::vector<uint32_t> PlacementLedger::at(int32_t tileX, int32_t tileY) const
{
	std::vector<uint32_t> out;
	for (auto it = instances.rbegin(); it != instances.rend(); ++it) {
		if (it->rect.contains(tileX, tileY)) {
			out.push_back(it->id);
		}
	}
	return out;
}

std::vector<const MapInstance*> PlacementLedger::list(PlacementSource source) const
{
	std::vector<const MapInstance*> out;
	for (const MapInstance& instance : instances) {
		if (instance.source == source) {
			out.push_back(&instance);
		}
	}
	return out;
}

std::vector<uint32_t> PlacementLedger::instancesOf(PlacementSource source,
                                                   const std::string& assetKey) const
{
	std::vector<uint32_t> out;
	for (const MapInstance& instance : instances) {
		if (instance.source == source && instance.assetKey == assetKey) {
			out.push_back(instance.id);
		}
	}
	return out;
}

uint32_t PlacementLedger::liveCount(uint32_t instanceId) const
{
	const MapInstance* instance = find(instanceId);
	if (!instance) {
		return 0;
	}

	uint32_t alive = 0;
	for (const uint32_t entityId : instance->entityIds) {
		const auto it = owner.find(entityId);
		if (it != owner.end() && it->second == instanceId) {
			++alive;
		}
	}
	return alive;
}

bool PlacementLedger::retire(uint32_t instanceId, std::vector<uint32_t>& outEntityIds)
{
	const auto it = std::find_if(instances.begin(), instances.end(),
		[instanceId](const MapInstance& instance) { return instance.id == instanceId; });
	if (it == instances.end()) {
		return false;
	}

	for (const uint32_t entityId : it->entityIds) {
		// Only what is still ours: an id whose entity died is gone from `owner`,
		// and one the pool reissued to a later stamp now names that stamp.
		const auto ownerIt = owner.find(entityId);
		if (ownerIt == owner.end() || ownerIt->second != instanceId) {
			continue;
		}
		outEntityIds.push_back(entityId);
		owner.erase(ownerIt);
	}

	instances.erase(it);
	return true;
}

uint32_t PlacementLedger::retireAll(PlacementSource source, std::vector<uint32_t>& outEntityIds)
{
	// Ids collected first, records dropped after: retire() erases from the very
	// vector this would be iterating.
	std::vector<uint32_t> doomed;
	for (const MapInstance& instance : instances) {
		if (instance.source == source) {
			doomed.push_back(instance.id);
		}
	}

	uint32_t retired = 0;
	for (const uint32_t instanceId : doomed) {
		if (retire(instanceId, outEntityIds)) {
			++retired;
		}
	}
	return retired;
}

uint32_t PlacementLedger::retireAll(std::vector<uint32_t>& outEntityIds)
{
	uint32_t retired = 0;
	for (const MapInstance& instance : instances) {
		for (const uint32_t entityId : instance.entityIds) {
			const auto ownerIt = owner.find(entityId);
			if (ownerIt == owner.end() || ownerIt->second != instance.id) {
				continue;
			}
			outEntityIds.push_back(entityId);
		}
		++retired;
	}

	instances.clear();
	owner.clear();
	return retired;
}

void PlacementLedger::reset()
{
	instances.clear();
	owner.clear();
	// The counter deliberately keeps running: an instance handle an admin has
	// on screen must never come back meaning something else.
}
