// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

// The slots a weapon can declare (<mods><slot type=>). The number is the wire
// id -- ITEM_MODS, FULL_CHEST and TRADE_STATE carry it -- so never renumber.
enum class ModSlot : uint8_t {
	Magazine = 0,
	Optic = 1,
	Muzzle = 2,
	Underbarrel = 3,
	Side = 4,
	Stock = 5,
	Handguard = 6,
	Count
};

inline constexpr size_t MOD_SLOT_COUNT = static_cast<size_t>(ModSlot::Count);

inline constexpr std::array<std::string_view, MOD_SLOT_COUNT> MOD_SLOT_NAMES = {
	"magazine", "optic", "muzzle", "underbarrel", "side", "stock", "handguard",
};

inline std::optional<ModSlot> modSlotFromName(std::string_view name)
{
	for (size_t i = 0; i < MOD_SLOT_COUNT; ++i) {
		if (MOD_SLOT_NAMES[i] == name) return static_cast<ModSlot>(i);
	}
	return std::nullopt;
}

inline std::string_view modSlotName(ModSlot slot)
{
	const size_t i = static_cast<size_t>(slot);
	return i < MOD_SLOT_COUNT ? MOD_SLOT_NAMES[i] : std::string_view("unknown");
}

// What is fitted to one weapon: the mod ITEM id in each slot, 0 = empty. Held
// by every Item (empty for anything that is not a moddable gun) and copied
// wherever the item goes -- see ItemState.
struct WeaponMods {
	std::array<uint16_t, MOD_SLOT_COUNT> iid{};

	uint16_t at(ModSlot slot) const { return iid[static_cast<size_t>(slot)]; }
	void set(ModSlot slot, uint16_t modIid) { iid[static_cast<size_t>(slot)] = modIid; }
	bool empty() const
	{
		for (uint16_t v : iid) {
			if (v != 0) return false;
		}
		return true;
	}
	bool operator==(const WeaponMods&) const = default;
};
