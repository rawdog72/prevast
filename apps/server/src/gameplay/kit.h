// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_KIT_H
#define FS_KIT_H

#include <cstdint>
#include <map>
#include <string>
#include <vector>

struct KitItem {
	uint16_t iid = 0;
	uint8_t count = 1;
	// Loaded rounds for a firearm / freshness for a perishable; -1 keeps
	// ItemState::fresh's ammo (255 for perishables, 0 otherwise).
	int16_t ammo = -1;
};

// A tiered starting-item loadout (kits.xml).
//   level      - the death-level threshold this kit is matched against, and
//                the kit's identity: it is the lookup key for getKitForLevel,
//                so two kits at one level are one tier. Ignored on the
//                firstSession kit, which is not in that lookup.
//   startLevel - the player level granted alongside the items (0 = do not
//                change the player's level)
//   firstSession - reserved for a token that has never died before (see
//                KitManager::getFreshKit). This used to be spelled as a
//                NEGATIVE id, which is why the id attribute is gone: it was
//                also a duplicate of level on every other kit, so it could
//                disagree with the value actually used.
struct KitData {
	uint32_t level = 0;
	uint32_t startLevel = 0;
	std::vector<KitItem> items;
};

// What a death resolves to: the kit whose items are granted, plus the level to
// grant with them. startLevel is normally the kit's own, but above the highest
// defined tier it keeps scaling with the death level (see
// KitManager::getOverflowStartLevelPercent).
struct KitAward {
	const KitData* kit = nullptr;
	uint32_t startLevel = 0;
};

class KitManager
{
public:
	static KitManager& getInstance()
	{
		static KitManager instance;
		return instance;
	}

	// non-copyable
	KitManager(const KitManager&) = delete;
	KitManager& operator=(const KitManager&) = delete;

	bool loadFromXml(const std::string& filename);

	// The defined kit with the largest `level` <= targetLevel (sparse tiers
	// are fine: e.g. only level 0, 5, and 10 defined resolves targetLevel=7
	// to the level=5 kit). Automatically saturates at the highest defined
	// kit — e.g. targetLevel=100 with levels only up to 32 defined resolves
	// to the level=32 kit. Returns nullptr only if no kit at or below
	// level=0 exists.
	const KitData* getKitForLevel(uint32_t targetLevel) const;

	// getKitForLevel(deathLevel) plus the level to grant with it. Identical to
	// the kit's own startLevel except above the highest defined tier, where the
	// top kit's items are still granted but the level keeps scaling.
	KitAward getAwardForDeathLevel(uint32_t deathLevel) const;

	// The kit reserved for a token that has never died before (<kit
	// firstSession="true"> in kits.xml). If several are marked, the last one
	// parsed wins. Returns nullptr if none is defined.
	const KitData* getFreshKit() const { return hasFreshKit ? &freshKit : nullptr; }

	// How long a death's reward stays claimable (XML/kits.xml root attribute
	// deathRewardExpiryMinutes); 0 means it never expires.
	uint32_t getDeathRewardExpiryMinutes() const { return deathRewardExpiryMinutes; }

	// Percent of the death level granted back once the death level is past the
	// highest defined tier (root attribute overflowStartLevelPercent); 0 pins
	// the reward to the top kit's own startLevel instead.
	uint32_t getOverflowStartLevelPercent() const { return overflowStartLevelPercent; }

private:
	KitManager() = default;

	std::map<uint32_t, KitData> kits; // keyed and sorted by KitData::level (id >= 0 only)
	KitData freshKit;
	bool hasFreshKit = false;
	uint32_t deathRewardExpiryMinutes = 180;
	uint32_t overflowStartLevelPercent = 50;
};

#endif // FS_KIT_H
