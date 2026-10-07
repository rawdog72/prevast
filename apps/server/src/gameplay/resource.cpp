// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"
#include "gameplay/resource.h"
#include "gameplay/game.h"
#include "gameplay/progress/game_event.h"
#include "core/scheduler.h"
#include "gameplay/loot.h"
#include "gameplay/player.h"
#include "content/configmanager.h"
#include "world/mapsize.h"
#include "core/tools.h"
#include "world/worldgen.h"
#include "content/xml_utils.h"
#include <fmt/format.h>
#include <fmt/color.h>

ResourceManager g_resources;
extern Game g_game;

namespace {
	constexpr uint8_t DEFAULT_RESOURCE_PROTOCOL_TYPE = 8;

	const ResourceType* getResourceTypeData(const ResourceData& resourceData, uint16_t typeId)
	{
		return (typeId < resourceData.types.size()) ? &resourceData.types[typeId] : nullptr;
	}

	const ResourceType* getResourceTypeData(uint16_t resourceId, uint16_t typeId)
	{
		const ResourceData* resourceData = g_resources.getResourceData(resourceId);
		return resourceData ? getResourceTypeData(*resourceData, typeId) : nullptr;
	}

	bool usesSmallResourceClusters(const std::string& resourceKey)
	{
		return resourceKey == "iron" || resourceKey == "orange" || resourceKey == "tomato" || resourceKey == "mushroom";
	}

	uint32_t rollClusterSize(const std::string& resourceKey, WorldRng& rng)
	{
		return usesSmallResourceClusters(resourceKey) ? rng.range(1, 2) : rng.range(1, 3);
	}
}

// --- Resource Entity ---

Resource::Resource(uint16_t id, uint16_t typeId) : resourceId(id), typeId(typeId) {}

Tile* Resource::getTile()
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

const Tile* Resource::getTile() const
{
	return g_game.map.getTile(position.x / TILE_SIZE, position.y / TILE_SIZE);
}

bool Resource::hasCollision() const
{
	if (const ResourceType* resourceType = getResourceTypeData(resourceId, typeId)) {
		return resourceType->collision != 0;
	}
	return false;
}

uint8_t Resource::getProtocolType() const
{
	if (const ResourceType* resourceType = getResourceTypeData(resourceId, typeId)) {
		return resourceType->protocolType;
	}
	return DEFAULT_RESOURCE_PROTOCOL_TYPE;
}

float Resource::getCollisionRadius() const
{
	if (const ResourceType* resourceType = getResourceTypeData(resourceId, typeId)) {
		return static_cast<float>(resourceType->radius);
	}
	return 0.0f;
}

void Resource::buildUpdate(EntityUpdate& out) const
{
	const ResourceData* rd = g_resources.getResourceData(resourceId);
	if (!rd) return;

	out.pid = 0;
	out.rotation = rotation; // Free rotation (0-255)
	
	// Set protocol type from pre-calculated ID
	if (const ResourceType* resourceType = getResourceTypeData(*rd, typeId)) {
		out.type = resourceType->protocolType;
	} else {
		out.type = DEFAULT_RESOURCE_PROTOCOL_TYPE; // Default to RESOURCES_TOP
	}
	
	out.state = 1; // 1 = Alive/Idle
	
	out.id = getId16(); 
	
	out.startX = static_cast<uint16_t>(position.x);
	out.startY = static_cast<uint16_t>(position.y);
	out.endX = static_cast<uint16_t>(position.x);
	out.endY = static_cast<uint16_t>(position.y);
	
	// Extra packing (from client.js _Resources):
	// Bits 0-4: Impact Angle (Angle / 2PI * 31)
	// Bits 5-9: Category ID (resourceId)
	// Bits 10-12: Variation ID (typeId)
	uint16_t catId = resourceId;
	out.extra = static_cast<uint16_t>((impactAngle & 0x1F) | ((catId & 0x1F) << 5) | ((typeId & 0x07) << 10));
}

void Resource::buildRemoval(EntityUpdate& out) const
{
	buildUpdate(out);
	// state 0 + extra = the keepInCache flag, never the look bits buildUpdate
	// packed there. See EntityUpdate::makeRemoval.
	out.makeRemoval();
}

// The fly-to-player visual of a harvest: a pile already taken, never on the ground.
static void spawnGhostLoot(uint16_t lootId, uint16_t iid, uint8_t count, const ItemState& state,
                           const Position& from, const Position& to, uint8_t attackerPid)
{
	// Ghost loot must carry its taken/fly state in the initial broadcast, so
	// the flags are set before placement.
	Loot* loot = LootManager::getInstance().createLoot(lootId, iid, count, state, from, to);
	if (!loot) return;
	loot->setGhost(true);
	loot->setAttackerPid(attackerPid);
	loot->setTaken(true); // Mark as taken so client processes it as ghost
	g_game.placeThing(loot, to);
}

void Resource::harvestDrops(Player* attacker, const ResourceData* rd, float multiplier)
{
	// 1. XP Gain (Immediate upon hit)
	uint32_t expGain = static_cast<uint32_t>(std::round(rd->experience * multiplier));
	if (expGain > 0) {
		attacker->addXP(expGain);
	}

	// 2. Harvest!
	uint32_t gathered = 0;
	for (const auto& drop : rd->drops) {
		if (drop.rollChance()) {
			uint16_t baseCount = drop.rollAmount();
			float modeItemRate = 1.0f;
			if (const GameMode* mode = g_game.getActiveMode()) {
				modeItemRate = mode->rateItem;
			}
			uint16_t totalCount = static_cast<uint16_t>(std::round(static_cast<float>(baseCount) * multiplier * modeItemRate));

			if (totalCount > 0) {
				gathered += totalCount;
				// Resolved at load, so this is a lookup by id rather than by
				// string on every swing. The key was already proved to exist.
				const ItemData* dropItemData = ItemManager::getInstance().getItemData(drop.iid);
				if (!dropItemData) {
					// Fallback: If "small_wood" not found, use resource key "wood"
					dropItemData = ItemManager::getInstance().getItemData(rd->key);
				}

				if (dropItemData) {
					uint16_t iid     = dropItemData->id;
					uint16_t lootId  = dropItemData->lootId;
					const ItemState initialState = ItemState::fresh(iid);
					uint8_t added = attacker->inventory.addItem(iid, static_cast<uint8_t>(std::min<uint16_t>(255, totalCount)));

					// A. Visual Ghost Loot (fly to player)
					//
					// Skipped for a ghoul, which can never receive any of it:
					// the ghost is the animation of an item flying into your
					// pack, and drawing it for a body with no pack tells every
					// onlooker the ghoul just picked something up. The physical
					// drop below is the whole of what happens instead.
					//
					// Only ghouls. A player with a full inventory also gets a
					// ghost of the full stack on top of the ground drop, which
					// looks the same way for the same reason -- but that is how
					// harvesting has always behaved here and is not this
					// change's business.
					if (!attacker->isGhoul()) {
						spawnGhostLoot(lootId, iid, static_cast<uint8_t>(std::min<uint16_t>(255, totalCount)), initialState, position, attacker->getPosition(),
						               static_cast<uint8_t>(attacker->getGUID()));
					}

					// B. Overflow Loot (physical drop)
					if (added < totalCount) {
						uint8_t remaining = static_cast<uint8_t>(std::min<uint16_t>(255, totalCount - added));
						g_game.dropLootScattered(lootId, iid, remaining, initialState, position);
					}
				}
			}
		}
	}
	if (gathered > 0) g_events.emit({EventType::Gather, attacker, rd->key, gathered});
}

void Resource::handleResourceDeath(const ResourceData* rd)
{
	removed = true;

	EntityUpdate removal;
	removal.isDestruction = true;
	buildRemoval(removal);
	g_game.broadcastSurgicalUpdate(removal, position);

	std::string keyCopy = rd->key;
	g_game.map.removeThing(this);
	g_scheduler.addEvent(createSchedulerTask(10, [this, keyCopy]() {
		g_dispatcher.addTask([this, keyCopy]() {
			g_resources.onResourceDestroyed(keyCopy);
			delete this;
		});
	}));
}

int32_t Resource::changeHealth(int32_t healthDelta, uint8_t angle, Player* attacker)
{
	const ResourceData* rd = g_resources.getResourceData(resourceId);
	if (!rd) return 0;

	const uint16_t oldHealth = health;

	if (healthDelta >= 0) {
		health = static_cast<uint16_t>(std::min<int32_t>(MAX_DAMAGE_AMOUNT, health + healthDelta));
		return static_cast<int32_t>(health) - static_cast<int32_t>(oldHealth);
	} else {
		const uint32_t damage = static_cast<uint32_t>(-healthDelta);

		// 1. Tool check and harvesting yield
		if (attacker) {
			const ItemData* toolData = ItemManager::getInstance().getItemData(attacker->getEquippedWeaponIID());
			float multiplier = 0.0f;

			if (toolData) {
				auto it = rd->toolMultipliers.find(toolData->key);
				if (it != rd->toolMultipliers.end()) {
					multiplier = it->second;
				}
			} else {
				// Hand (IID 0) check
				auto it = rd->toolMultipliers.find("hand");
				if (it != rd->toolMultipliers.end()) {
					multiplier = it->second;
				}
			}

			if (multiplier > 0.0f) {
				harvestDrops(attacker, rd, multiplier);
			}
		}

		if (damage >= health) {
			health = 0;
			if (!removed) {
				handleResourceDeath(rd);
			}
			// oldHealth, not `damage`: an overkill reports what was there.
			return -static_cast<int32_t>(oldHealth);
		} else {
			health -= static_cast<uint16_t>(damage);
			impactAngle = angle;
			EntityUpdate update;
			buildUpdate(update);
			update.state |= 2; // Set Bit 1: Trigger hit effect/sound
			g_game.broadcastSurgicalUpdate(update, position);
			return -static_cast<int32_t>(damage);
		}
	}
}

// --- Resource Manager ---

bool ResourceManager::loadFromXml(const std::string& filename)
{
	pugi::xml_document doc;
	const pugi::xml_node root = xml_utils::openDataFile(doc, filename, "resources");
	if (!root) return false;

	for (pugi::xml_node resNode = root.child("resource"); resNode; resNode = resNode.next_sibling("resource")) {
		ResourceData rd;
		rd.id = static_cast<uint16_t>(resNode.attribute("id").as_uint());
		rd.key = resNode.attribute("key").as_string();
		rd.experience = resNode.attribute("experience").as_float();

		if (pugi::xml_node dropsNode = resNode.child("drops")) {
			xml_utils::parseItemDrops(dropsNode, rd.drops, filename,
				fmt::format("resource '{}'", rd.key));
		}

		pugi::xml_node toolsNode = resNode.child("tools");
		for (pugi::xml_node toolNode = toolsNode.child("tool"); toolNode; toolNode = toolNode.next_sibling("tool")) {
			rd.toolMultipliers[toolNode.attribute("key").as_string()] = toolNode.attribute("multiplier").as_float();
		}

		pugi::xml_node typesNode = resNode.child("types");
		for (pugi::xml_node typeNode = typesNode.child("type"); typeNode; typeNode = typeNode.next_sibling("type")) {
			ResourceType rt;
			rt.id = static_cast<uint16_t>(typeNode.attribute("id").as_uint());
			rt.life = static_cast<uint16_t>(typeNode.attribute("life").as_uint());
			rt.radius = static_cast<uint16_t>(typeNode.attribute("radius").as_uint());
			rt.layer = typeNode.attribute("layer").as_string();
			// as_bool, not as_uint: this file used to spell collision 1/0 while
			// objects/furnitures/agents spelled it true/false, and as_uint reads
			// "true" as 0. The data is true/false everywhere now, which is the
			// same path object.cpp and agent.cpp already take.
			rt.collision = typeNode.attribute("collision").as_bool() ? 1 : 0;
			rt.unitsMin = static_cast<uint16_t>(typeNode.attribute("unitsMin").as_uint());
			rt.unitsMax = static_cast<uint16_t>(typeNode.attribute("unitsMax").as_uint());

			if (rt.layer == "top") rt.protocolType = 8;
			else if (rt.layer == "mid") rt.protocolType = 9;
			else if (rt.layer == "low") rt.protocolType = 10;
			else if (rt.layer == "above") rt.protocolType = 11;
			else rt.protocolType = 8;

			rd.types.push_back(rt);
		}

		pugi::xml_node effectsNode = resNode.child("areaEffects");
		if (effectsNode) {
			xml_utils::appendAreaEffects(effectsNode, rd.areaEffects);
		}

		// A resource with no <type> is unspawnable and would divide-by-zero in
		// every `rand() % types.size()` spawn path; drop it so getResourceData
		// returns nullptr and the existing null checks handle it.
		if (rd.types.empty()) {
			reportDataWarning(filename, fmt::format("resource '{}' (id {}) has no <types> and was skipped", rd.key, rd.id));
			continue;
		}

		for (const ResourceType& rt : rd.types) {
			maxCollisionExtent = std::max(maxCollisionExtent, rt.radius);
		}

		resources[rd.id] = rd;
		keyToIdMap[rd.key] = rd.id;
	}

	// Drops and types alongside the count, for the same reason every other loader
	// reports its quantities: a drop table that failed to resolve leaves the
	// resource count untouched, so only these make it visible.
	size_t drops = 0, types = 0;
	for (const auto& [id, rd] : resources) {
		drops += rd.drops.size();
		types += rd.types.size();
	}
	reportDataFile(filename, fmt::format("{} resources ({} drops, {} types)",
		resources.size(), drops, types));
	return true;
}

const ResourceData* ResourceManager::getResourceData(uint16_t id) const
{
	auto it = resources.find(id);
	if (it != resources.end()) {
		return &it->second;
	}
	return nullptr;
}

const ResourceData* ResourceManager::getResourceData(const std::string& key) const
{
	auto it = keyToIdMap.find(key);
	if (it != keyToIdMap.end()) {
		return getResourceData(it->second);
	}
	return nullptr;
}

Resource* ResourceManager::createResource(const std::string& key, uint16_t typeId, const Position& pos, uint8_t rotation)
{
	const ResourceData* rd = getResourceData(key);
	if (!rd) return nullptr;

	// Named before it is built: on exhaustion there is nothing to clean up.
	const uint32_t uid = g_game.map.acquireEntityId(EntityClass::Resource);
	if (uid == 0) {
		if (!warnedExhausted) {
			warnedExhausted = true;
			fmt::print(fg(fmt::color::yellow),
				">> [Warning] No entity id available for a new resource ({} live). World respawn "
				"is stalled: the entity id pool is full. Removing built objects frees ids "
				"for respawn.\n", g_game.map.getEntityIdPool().liveCount(EntityClass::Resource));
		}
		return nullptr;
	}
	warnedExhausted = false;

	Resource* res = new Resource(rd->id, typeId);
	res->setPosition(pos);
	res->setRotation(rotation);
	res->setID(uid);

	if (const ResourceType* resourceType = getResourceTypeData(*rd, typeId)) {
		res->setHealth(resourceType->life);
	}

	counts[key]++;
	return res;
}

void ResourceManager::onResourceDestroyed(const std::string& key)
{
	// Always: the count is live accounting, not a respawn concern, and leaving
	// it high would make the map look permanently full to the spawner.
	if (counts[key] > 0) counts[key]--;

	const ResourceData* rd = getResourceData(key);
	if (!rd) return;

	// 0 = never. Queuing nothing is what makes it permanent -- the queue is the
	// only thing that ever brings a resource back.
	if (respawnDelayMs == 0) {
		return;
	}

	respawnQueue.push_back({ key, static_cast<uint64_t>(OTSYS_TIME()) + respawnDelayMs });
}

uint32_t ResourceManager::getCount(const std::string& key) const
{
	auto it = counts.find(key);
	return (it != counts.end()) ? it->second : 0;
}

namespace {

// The grid range a resource may spawn in: one tile in from each edge.
bool resourceSpawnGrid(int32_t& maxGx, int32_t& maxGy)
{
	maxGx = MapSize::tilesX() - 2;
	maxGy = MapSize::tilesY() - 2;
	return maxGx >= 1 && maxGy >= 1;
}

} // namespace

Position ResourceManager::findRandomSpawnPosition()
{
	int32_t maxGx = 0, maxGy = 0;
	if (!resourceSpawnGrid(maxGx, maxGy)) return Position(0, 0);

	for (int i = 0; i < SPAWN_ATTEMPTS; i++) {
		int32_t gx = 1 + (rand() % (maxGx));
		int32_t gy = 1 + (rand() % (maxGy));

		Position pos(gx * 100 + 50, gy * 100 + 50);

		if (g_game.isTileClear(pos, false, 0, 0, nullptr, false, true)) {
			return pos;
		}
	}
	return Position(0, 0);
}

Position ResourceManager::findGenerationSpawnPosition(WorldRng& rng)
{
	int32_t maxGx = 0, maxGy = 0;
	if (!resourceSpawnGrid(maxGx, maxGy)) return Position(0, 0);

	for (int i = 0; i < SPAWN_ATTEMPTS; i++) {
		const int32_t gx = rng.range(1, maxGx);
		const int32_t gy = rng.range(1, maxGy);

		Position pos(gx * 100 + 50, gy * 100 + 50);

		// ignoreTransient: the static world at this point is entirely what this
		// seed just built, so the answer is the same every time. Asking about
		// creatures and loot here is what made two runs of the same seed differ
		// -- each rejected tile costs two more draws, and every tree after it
		// moves.
		//
		// The claimed set covers the other half of that: a slot the layout took
		// but could not build on is still taken. See worldgen::claimTile.
		if (worldgen::tileClaimed(pos.x / TILE_SIZE, pos.y / TILE_SIZE)) {
			continue;
		}

		if (g_game.isTileClear(pos, false, 0, 0, nullptr, false, true, /*ignoreTransient=*/true)) {
			return pos;
		}
	}
	return Position(0, 0);
}

ResourceManager::PopulateReport ResourceManager::populateMap(uint32_t worldSeed,
                                                             MapSize::ContentBudget& budget)
{
	PopulateReport report;

	const int32_t limitX = MapSize::widthUnits() - TILE_SIZE;
	const int32_t limitY = MapSize::heightUnits() - TILE_SIZE;

	// Resources spend what the structures left. They go last deliberately: a
	// city is a landmark and a hand-placed piece of content, a tree is
	// interchangeable with the tree next to it, so if something has to give on a
	// cramped map it should be the trees.
	//
	// One resource occupies one tile, so the unit count and the tile cost are
	// the same number and the budget needs no conversion.
	const MapSize::ContentScale scale =
		MapSize::contentScaleFor(totalUnitsMax(), budget.remaining());

	if (!scale.isIdentity()) {
		// As a percentage, not as the two numbers behind it. Those are derived
		// from unitsMax while what actually gets placed is drawn between
		// unitsMin and unitsMax -- so printing them invites comparing them
		// against the "resources N/M" line below, which counts something else
		// and will never match. The ratio is the part that is true of both.
		fmt::print(">> Resource counts scaled to {}% for this map size ({}x{} tiles against "
			"the {}x{} the content is authored for)\n",
			(scale.num * 100) / scale.den, MapSize::tilesX(), MapSize::tilesY(),
			MapSize::REFERENCE_TILES_X, MapSize::REFERENCE_TILES_Y);
	}

	// A pass that places nothing is normal -- the cluster offsets can all land
	// on blocked tiles -- so it takes a run of them to mean "stop". Without this
	// bound the loop below HANGS THE SERVER: createResource returns nullptr once
	// the entity id pool is out, `claimed` then never advances, and the seed
	// search keeps succeeding because the map is empty of resources. Startup
	// rarely reaches that state; !seed on a world full of preserved player
	// builds can, which is what made this reachable at runtime.
	static constexpr uint32_t BARREN_PASS_LIMIT = 32;

	// Sorted by id rather than in hash order. The layout must not depend on
	// where an unordered_map happened to put a bucket, and the id is what
	// resources.xml actually spells -- so it is also the stream index below,
	// which keeps every other resource still when one is retuned or removed.
	std::vector<uint16_t> orderedIds;
	orderedIds.reserve(resources.size());
	for (const auto& [id, rd] : resources) {
		orderedIds.push_back(id);
	}
	std::sort(orderedIds.begin(), orderedIds.end());

	uint32_t occupiedSlots = 0;

	fmt::print(">> Populating map with resources...\n");
	for (const uint16_t id : orderedIds) {
		ResourceData& rd = resources[id];
		WorldRng rng = worldStream(worldSeed, "resources", id);

		uint32_t totalMin = 0;
		uint32_t totalMax = 0;
		for (const auto& t : rd.types) {
			totalMin += t.unitsMin;
			totalMax += t.unitsMax;
		}

		uint32_t maxUnits = totalMax;
		if (totalMax > totalMin) {
			maxUnits = static_cast<uint32_t>(rng.range(static_cast<int32_t>(totalMin),
			                                           static_cast<int32_t>(totalMax)));
		}

		// Scaled AFTER the draw, never by scaling the range it draws from. The
		// number of times this stream is advanced has to be the same at every
		// map size, or the scale would reach into the layout and move things
		// that have nothing to do with it.
		maxUnits = scale.apply(maxUnits);

		// The live cap as well as the generation target: the respawn queue reads
		// resourceLimits, so without this a shrunken map would regrow to the
		// unscaled count one tree at a time and quietly undo the budget.
		resourceLimits[rd.key] = maxUnits;
		report.wanted += maxUnits;
		budget.spend(maxUnits);

		// Two counters, deliberately. `claimed` is what the LAYOUT decided --
		// it drives the loop and must depend on nothing but the seed. `placed`
		// is what actually exists, which is one lower for every slot a player
		// or a bot happened to be standing on. Merging them would put the live
		// world back into the layout by the back door.
		uint32_t claimed = 0;
		uint32_t placed = 0;
		uint32_t barrenPasses = 0;

		// Once the id pool is dry nothing can spawn, so the remaining types only
		// need their limits recorded above -- searching for spots would be pure
		// waste, and `wanted` stays truthful for the shortfall report.
		while (claimed < maxUnits && !report.outOfIds) {
			const Position clusterSeed = findGenerationSpawnPosition(rng);
			if (clusterSeed.x == 0) break;

			const uint32_t claimedBefore = claimed;
			const uint32_t clusterSize = rollClusterSize(rd.key, rng);

			for (uint32_t c = 0; c < clusterSize && claimed < maxUnits; c++) {
				// Try tiles near the seed (in grid units)
				const int32_t dx = rng.range(-2, 2);
				const int32_t dy = rng.range(-2, 2);

				Position p(clusterSeed.x + dx * 100, clusterSeed.y + dy * 100);

				// Strict Boundary Check: Must be within [100, Width-100] and [100, Height-100]
				if (p.x < 100 || p.x > limitX || p.y < 100 || p.y > limitY) {
					continue;
				}

				if (worldgen::tileClaimed(p.x / TILE_SIZE, p.y / TILE_SIZE)) {
					continue;
				}

				if (!g_game.isTileClear(p, false, 0, 0, nullptr, false, true, /*ignoreTransient=*/true)) {
					continue;
				}

				// The slot is settled here -- type, angle, tile taken, layout
				// recorded -- all of it before the occupancy test below, and
				// none of it conditional on that test. What grows on this tile
				// is part of the map the seed describes.
				const uint16_t typeId = static_cast<uint16_t>(rng.below(static_cast<uint32_t>(rd.types.size())));
				const uint8_t rotation = static_cast<uint8_t>(rng.below(256));
				++claimed;

				worldgen::noteLayout(0x8000u | (static_cast<uint64_t>(rd.id) << 16) | typeId,
					p.x, p.y, rotation);
				worldgen::claimTile(p.x / TILE_SIZE, p.y / TILE_SIZE);

				// The one place the live world gets a say, and it is the last
				// word rather than the first: this tile is simply left empty.
				// Nothing else in the world moves because of it.
				if (g_game.tileHoldsTransientContent(p)) {
					++occupiedSlots;
					continue;
				}

				Resource* res = createResource(rd.key, typeId, p, rotation);
				if (res) {
					g_game.internalPlaceThing(res, p);
					++placed;
				} else {
					// The only failure createResource has here: the key came
					// from `resources`, so the data lookup cannot miss.
					report.outOfIds = true;
					break;
				}
			}

			if (claimed == claimedBefore) {
				if (++barrenPasses >= BARREN_PASS_LIMIT) {
					break;
				}
			} else {
				barrenPasses = 0;
			}
		}

		report.spawned += placed;
	}

	if (occupiedSlots != 0) {
		fmt::print(">> {} resource spot(s) left empty: somebody was standing there\n", occupiedSlots);
	}

	return report;
}

void ResourceManager::updateRespawn()
{
	uint64_t now = OTSYS_TIME();

	// 1. Dynamic Resource Relocation/Rotation every 20 seconds
	//
	// Gated on respawn being on, because this REMOVES a live resource and
	// depends on the queue below to put it back. With respawn off it would be a
	// slow shredder: every 20s another tree disappears for good.
	static uint64_t lastRotationTime = 0;
	if (lastRotationTime == 0) {
		lastRotationTime = now;
	}

	if (isRespawnEnabled() && now - lastRotationTime >= 20000) {
		lastRotationTime = now;
		for (auto& [id, rd] : resources) {
			uint32_t limit = resourceLimits[rd.key];
			if (limit == 0) continue;

			// Rarity-based probability (higher limit = more common = higher chance to rotate)
			uint32_t chance = 5;
			if (limit >= 100) chance = 40;
			else if (limit >= 50) chance = 20;
			else if (limit >= 10) chance = 10;

			if (static_cast<uint32_t>(rand() % 100) < chance) {
				std::vector<Resource*> candidates;
				// getResource(), not dynamic_cast: this scans EVERY entity on
				// the map, once per resource type that passes the roll above,
				// every 20 seconds. RTTI over ~10k things a dozen times is a
				// periodic stall; Thing's virtual downcast is the same answer
				// without it.
				for (Thing* thing : g_game.map.getThings()) {
					if (Resource* res = thing->getResource()) {
						if (res->getResourceId() == rd.id && !res->isRemoved()) {
							candidates.push_back(res);
						}
					}
				}

				if (!candidates.empty()) {
					Resource* target = candidates[rand() % candidates.size()];

					EntityUpdate removal;
					removal.isDestruction = false;
					target->buildRemoval(removal);
					g_game.broadcastSurgicalUpdate(removal, target->getPosition());

					std::string keyCopy = rd.key;
					g_game.map.removeThing(target);

					g_scheduler.addEvent(createSchedulerTask(10, [target, keyCopy]() {
						g_dispatcher.addTask([target, keyCopy]() {
							g_resources.onResourceDestroyed(keyCopy);
							delete target;
						});
					}));
				}
			}
		}
	}

	// 2. Existing respawn queue processing
	for (auto it = respawnQueue.begin(); it != respawnQueue.end(); ) {
		if (now >= it->respawnTime) {
			const ResourceData* rd = getResourceData(it->key);
			if (rd) {
				uint32_t limit = resourceLimits[it->key];
				if (limit == 0) {
					for (const auto& t : rd->types) limit += t.unitsMax;
				}

				if (getCount(it->key) < limit) {
					Position pos = findRandomSpawnPosition();
					if (pos.x != 0) {
						uint16_t typeId = static_cast<uint16_t>(rand() % rd->types.size());
						Resource* res = createResource(it->key, typeId, pos, static_cast<uint8_t>(rand() % 256));
						if (res) g_game.placeThing(res, pos);
					}
				}
			}
			it = respawnQueue.erase(it);
		} else {
			++it;
		}
	}
}
