// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_ITEM_H
#define FS_ITEM_H

#include <string>
#include <vector>
#include <unordered_map>
#include <cstdint>
#include <pugixml.hpp>
#include "gameplay/weapon_mod_types.h"

struct RecipeIngredient {
	std::string itemKey;
	uint16_t iid = 0;
	uint8_t amount = 0;
};

// Sentinel for a station key that resolved to nothing. Not 0: that is the
// player's own hand-craft area, so it is a real value.
inline constexpr uint8_t INVALID_STATION_AREA = 0xFF;

struct CraftingStation {
	std::string key;
	uint8_t id = 0; // Client Area ID
	uint32_t timeMs = 0;
	// Extraction instead of a recipe: consumes no ingredients and takes its
	// yield from ItemData::extractor rather than CraftingData::yield.
	bool isExtraction = false;
};

// <extractor> in items.xml. The extractor pulls the mineral out of the ground,
// so the only cost is the station's fuel; the output is a uniform roll in
// [outputMin, outputMax], inclusive -- the same min/max pairing objects.xml
// uses for produceMin/produceMax. Whether an item has one of these is answered
// by CraftingStation::isExtraction, not by a second flag here.
struct ExtractorData {
	uint32_t timeMs = 0;
	uint16_t outputMin = 1;
	uint16_t outputMax = 1;
};

struct CraftingData {
	std::string skillType;
	uint32_t requiredLevel = 0;
	uint32_t skillCost = 0;
	std::string prerequisite;
	uint16_t prerequisiteIid = 0;
	uint8_t yield = 1;

	std::vector<RecipeIngredient> recipe;
	std::vector<CraftingStation> stations;
};

struct ItemData {
	// The client's IID -- its index into client.js's INVENTORY table. Not a
	// server-chosen id: it is on the wire in every item packet, so it must match
	// client.js exactly. `key` is what the XML uses to refer to an item.
	uint16_t id = 0;
	std::string key;
	std::string name;
	uint8_t stack = 255;
	uint16_t lootId = 0;
	uint32_t score = 0;
	uint32_t currencyValue = 0;
	
	// Flags
	bool isEquipable = false;
	bool isWearable = false;
	std::string equipKey;
	uint32_t equipTimeMs = 0;
	uint32_t wearTimeMs = 0;
	// <weaponMod key=>: this item is the mod of that key in mods.xml. Empty for
	// everything that is not a weapon mod.
	std::string weaponModKey;

	// Crafting
	bool isCraftable = false;
	bool requiresUnlock = false;
	CraftingData crafting;
	ExtractorData extractor;

	// Inventory Expansion
	uint8_t bagSlots = 0;

	// Decay. The XML names the target by key; decayTransformTo is the iid it
	// resolves to in the second load pass, and stays 0 if the key is unknown.
	uint32_t decayTimeMs = 0;
	std::string decayTransformKey;
	uint16_t decayTransformTo = 0;

	// Crafting Multiplier Bonuses (e.g. for Skill items)
	std::unordered_map<uint16_t, uint8_t> craftBonuses;
};

// Ammo value for freshly spawned items: perishables start at full freshness
// (255); anything else starts empty. Use this instead of a literal 0 when
// spawning loot so food does not appear rotten the moment it is picked up.
inline uint8_t getFreshSpawnAmmo(const ItemData* data)
{
	return (data && data->decayTimeMs > 0) ? 255 : 0;
}

class Item;

// What travels with an item besides its type and count: the ammo byte (rounds,
// freshness or durability) and, for a moddable weapon, what is fitted. Every
// path that MOVES an item passes ItemState::of(item); every path that CREATES
// one passes ItemState::fresh(iid). There is deliberately no conversion from a
// bare ammo byte, so no call site can drop a gun's mods without saying so.
class ItemState {
public:
	ItemState(uint8_t ammo, const WeaponMods& mods) : ammo(ammo), mods(mods) {}

	// A new item: fresh ammo (full freshness for a perishable, else 0) and the
	// weapon's default mods fitted. Defined in weapon_mods.cpp.
	static ItemState fresh(uint16_t iid);
	// What an existing item carries. Defined below Item.
	static ItemState of(const Item& item);
	// A chosen ammo byte and nothing fitted, for items that take no mods.
	static ItemState withAmmo(uint8_t ammo) { return ItemState(ammo, WeaponMods{}); }

	uint8_t ammo;
	WeaponMods mods;
};

class Item {
public:
	Item(uint16_t iid, uint8_t count, const ItemState& state);
	// Explicit-uid form. Only Inventory uses it, to keep the LOW BYTE of the uid
	// -- the whole of an item's wire identity -- unique inside one inventory.
	Item(uint16_t iid, uint8_t count, const ItemState& state, uint16_t uid);

	uint16_t getIID() const { return iid; }
	uint32_t getUID() const { return uid; }

	// The type data for this item's iid, resolved once in the constructor.
	//
	// Inventory::update runs for every player on every tick and asked
	// ItemManager "does this iid decay?" once per occupied slot -- a hash lookup
	// per item per tick whose answer is fixed for the item's life. Same shape,
	// and same fix, as Object::getData().
	//
	// CAVEAT for anyone adding items.xml to `!reload-xml` (today it only reloads
	// equipables and wearables): rebuilding ItemManager's table invalidates every
	// cached pointer here, so a reload would have to re-resolve them for all live
	// items -- including the ones sitting in object storage.
	const ItemData* getData() const { return data; }

	// Next instance uid; skips 0 on wrap (0 means "nothing equipped" in the
	// player's equip tracking).
	static uint16_t allocUid();

	uint8_t getCount() const { return count; }
	void setCount(uint8_t c) { count = c; }
	
	uint8_t getAmmo() const { return ammo; }
	void setAmmo(uint8_t a);

	// What is fitted, for a moddable gun; empty for everything else.
	const WeaponMods& getMods() const { return mods; }
	void setMods(const WeaponMods& fitted) { mods = fitted; }

	uint8_t getLastSyncedAmmo() const { return lastSyncedAmmo; }
	void setLastSyncedAmmo(uint8_t a) { lastSyncedAmmo = a; }

	uint32_t getDecayProgress() const { return decayProgressMs; }
	void setDecayProgress(uint32_t ms) { decayProgressMs = ms; }

	private:
	uint16_t uid; // Unique instance ID (protocol sends low byte only)
	uint16_t iid; // Item IID (from XML)
	uint8_t count;
	uint8_t ammo; // Durability or Ammo
	uint8_t lastSyncedAmmo; // What the client currently thinks the ammo is
	uint32_t decayProgressMs = 0;
	WeaponMods mods;
	// Resolved once from `iid` in the constructor; see getData().
	const ItemData* data = nullptr;

	static uint16_t autoItemUid;

};

inline ItemState ItemState::of(const Item& item)
{
	return ItemState(item.getAmmo(), item.getMods());
}

class ItemManager {
public:
	static ItemManager& getInstance() {
		static ItemManager instance;
		return instance;
	}

	bool loadFromXml(const std::string& filename);

	// Resolves <station key=> against objects.xml. Separate from loadFromXml
	// because items load BEFORE objects and the station areas live in that file;
	// call once, after the last object load.
	void resolveStationAreas(const std::string& filename);

	const ItemData* getItemData(uint16_t id) const;
	const ItemData* getItemData(const std::string& key) const;
	uint16_t getIIDByLootID(uint16_t lootId) const;
	// Whole-table access, for loaders that check the other direction of a link.
	const std::unordered_map<uint16_t, ItemData>& all() const { return itemDataMap; }

private:
	std::unordered_map<uint16_t, ItemData> itemDataMap;
	std::unordered_map<std::string, uint16_t> keyToIdMap;
};

#endif // FS_ITEM_H
