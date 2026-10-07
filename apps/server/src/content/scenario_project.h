// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_SCENARIO_PROJECT_H
#define FS_SCENARIO_PROJECT_H

// World & Mode Editor projects (`*.prevast.json`), parsed and structurally
// validated on the server's own terms. The browser also validates, but the
// server never trusts that: this is an independent implementation of the rules
// in shared/typescript/scenario-schema.ts, held to the same diagnostic codes by
// the shared corpus in tests/fixtures/scenarios (runScenarioSelfTest).
//
// Structural only: whether `ref` names real content is the compile step
// (scenario_compile.h), which needs the content managers loaded.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scenario {

enum class EntityKind : uint8_t { Object, Resource, Agent, Npc, Spawn };
enum class GroupKind : uint8_t { Group, House, City };
enum class ShapeType : uint8_t { Circle, Rect, Polygon };
enum class Permission : uint8_t { Inherit, Allow, Deny };
enum class EffectStat : uint8_t { Health, Warmth, Stamina, Radiation, Food };
enum class TimeOfDay : uint8_t { Cycle, Day, Night };

struct Overrides
{
	std::optional<uint16_t> healthMax;
	std::optional<uint16_t> health;
	std::optional<bool> destructible;
	std::optional<bool> doorOpen;

	bool any() const { return healthMax || health || destructible || doorOpen; }
};

// An item by content key (items.xml) and a stack count.
struct ItemStack
{
	std::string item;
	uint8_t count = 1;
};

// A container's authored contents; absent on an Entity = the type's defaults.
struct ContainerContents
{
	std::vector<ItemStack> fixed;
	std::string loot; // loot table id, empty = none
	uint32_t refillSeconds = 0; // 0 = never
};

struct Entity
{
	std::string id;
	EntityKind kind = EntityKind::Object;
	std::string ref;
	std::optional<uint8_t> variant;
	int32_t x = 0;
	int32_t y = 0;
	std::optional<uint8_t> rotation;
	std::optional<uint8_t> angle;
	std::string parent;
	std::string name;
	std::vector<std::string> tags;
	Overrides overrides;
	std::string team;
	std::optional<uint16_t> weight;
	std::optional<uint8_t> wander; // NPCs: tiles
	std::optional<std::vector<ItemStack>> loadout; // spawns: present (even empty) replaces the kit
	std::optional<ContainerContents> container; // objects with storage
};

struct TemplateLink
{
	std::string id;
	uint32_t revision = 0;
	bool linked = false;
};

struct Group
{
	std::string id;
	std::string name;
	GroupKind kind = GroupKind::Group;
	std::string parent;
	int32_t pivotX = 0;
	int32_t pivotY = 0;
	bool marker = false;
	std::vector<std::string> tags;
	std::optional<TemplateLink> templateLink;
};

struct Shape
{
	ShapeType type = ShapeType::Circle;
	int32_t x = 0, y = 0, r = 0, w = 0, h = 0;
	std::vector<std::pair<int32_t, int32_t>> points;
};

struct Effect
{
	EffectStat stat = EffectStat::Radiation;
	// Signed gauge points per minute at full strength.
	int32_t perMinute = 0;
	bool linearFalloff = false;
	std::string channel;
	bool additive = false;
};

struct Spawner
{
	std::string agent;
	uint16_t maxAlive = 1;
	uint16_t batch = 1;
	uint32_t everySeconds = 60;
	uint32_t total = 0; // 0 = unlimited
	uint32_t startDelay = 0;
};

struct Region
{
	std::string id;
	std::string name;
	Shape shape;
	std::string parent;
	std::string attach;
	int32_t priority = 0;
	Permission build = Permission::Inherit;
	Permission pvp = Permission::Inherit;
	Permission spawn = Permission::Inherit;
	std::vector<Effect> effects;
	std::optional<Spawner> spawner;
};

struct LootEntry
{
	std::string item;
	uint8_t min = 1;
	uint8_t max = 1;
	// Weighted tables: relative weight. Independent tables: chance in basis points.
	uint16_t weight = 1;
};

struct LootTable
{
	std::string id;
	std::string name;
	bool weighted = true;
	uint8_t rolls = 1; // weighted only
	uint16_t empty = 0; // weighted only: weight of "nothing"
	std::vector<LootEntry> entries;
};

struct Template
{
	std::string id;
	std::string name;
	uint32_t revision = 0;
	int32_t tilesW = 0;
	int32_t tilesH = 0;
	std::vector<Entity> entities;
	std::vector<Group> groups;
	std::vector<Region> regions;
};

struct World
{
	int32_t tilesX = 0;
	int32_t tilesY = 0;
	uint32_t seed = 0;
	TimeOfDay time = TimeOfDay::Day;
	bool generateResources = false;
	bool generateStructures = false;
	bool generateAgents = false;
};

struct Project
{
	std::string id;
	std::string title;
	uint32_t revision = 0;
	std::vector<std::string> requiredFeatures;
	World world;
	std::vector<Entity> entities;
	std::vector<Group> groups;
	std::vector<Region> regions;
	std::vector<Template> templates;
	std::vector<LootTable> lootTables;
};

enum class Severity : uint8_t { Error, Warning, Info };

struct Diagnostic
{
	Severity severity = Severity::Error;
	std::string code;
	std::string path;
	std::string message;
	std::string target;
};

struct ParseResult
{
	// Present only when there are no errors.
	std::optional<Project> project;
	std::vector<Diagnostic> diagnostics;
	// SHA-256 (lowercase hex) of the canonical gameplay view; empty on error.
	std::string gameplayHash;
	std::string gameplayCanonical;

	bool hasErrors() const;
};

// Parses and validates a project document. Byte and element budgets are checked
// before the expensive parts, so an oversized upload costs almost nothing.
ParseResult parseProject(std::string_view text);

std::string_view severityName(Severity severity);

// Runs tests/fixtures/scenarios/corpus.json and the canonical fixtures in
// `corpusDir`; prints failures, returns their count.
int runScenarioSelfTest(const std::string& corpusDir);

} // namespace scenario

#endif // FS_SCENARIO_PROJECT_H
