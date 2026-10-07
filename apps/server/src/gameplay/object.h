// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_OBJECT_H
#define FS_OBJECT_H

#include "world/thing.h"
#include "core/position.h"
#include "gameplay/item.h"
#include "core/definitions.h"
#include "gameplay/progress/game_event.h"
#include "gameplay/condition.h" // ConditionApplication, for <explosion><onHit>
#include <pugixml.hpp>
#include <unordered_map>
#include <vector>
#include <string>
#include <memory>

// Drops use the shared ItemDrop shape from definitions.h -- objects, furnitures,
// agents and resources all express a drop table the same way now.

struct StorageContent {
	uint16_t iid;
	uint8_t count = 1;
	float chance = 1.0f;
};

struct ObjectExplosion {
	bool enabled = false;
	uint16_t playerDamage = 0;
	uint16_t buildingDamage = 0;
	float knockback = 0.0f;
	uint16_t radius = 0;   // circular pixel range (used when area == 0)
	uint16_t area = 0;     // tiles around the explosion's tile; overrides radius when > 0
	// What the BLAST inflicts on every creature caught in it. See
	// ProjectileExplosion::onHit -- one shape, one shared parser.
	ConditionApplication onHit;
};

struct RespawnerItem {
	uint16_t iid = 0;
	uint8_t count = 1;
};

struct StageLootSpawn {
	uint16_t iid = 0;      // 0 = no loot
	uint8_t min = 1;
	uint8_t max = 1;
	uint8_t perStack = 1;  // items per loot entity (capped by the item's stack size)
};

// One growth stage of a staged object (plants, spawner seeds). The current
// stage is stored in Object::subtype, which the client already renders.
struct ObjectStage {
	uint8_t id = 0;
	uint32_t durationMs = 0;        // 0 = no timed transition
	int16_t next = -1;              // stage entered after durationMs
	bool harvestable = false;       // melee hits drop produce while in this stage
	StageLootSpawn produce;         // dropped on harvest (single-item loot entities)
	int16_t postHarvestStage = -1;  // stage entered after a harvest (-1 = stay)
	StageLootSpawn spawnLoot;       // dropped once when the stage is entered
	std::string spawnResource;      // replace the object with this resource on enter
	std::string spawnObject;        // replace the object with this object on enter

	// Agent (agents.xml key) this object HATCHES INTO, owned by whoever placed
	// the object. Like spawnResource/spawnObject it is a replacement: the object
	// is consumed and the creature takes its exact spot.
	//
	// The one difference from those two is WHEN it fires. They act on entering
	// the stage; this acts at the END of the stage's durationMs, so
	// <stage durationSeconds="20" spawnCreature="lapabot"/> reads the way it
	// looks -- twenty seconds in this stage, then it hatches. A stage with no
	// duration hatches on entry, like the other two.
	std::string spawnCreature;
	uint8_t spawnCreatureCount = 1;  // how many creatures the object hatches into
};

// Resurrection object: a player whose health reaches 0 while owning one of
// these is teleported to it instead of dying; the object is consumed.
struct RespawnerData {
	bool enabled = false;
	// Gauge percentages (0-100) applied on resurrection; radiation always resets to 0.
	uint8_t healthPercent = 30;
	uint8_t staminaPercent = 30;
	uint8_t hungerPercent = 30;
	uint8_t coldPercent = 30;
	std::vector<RespawnerItem> items; // granted after resurrection
};

struct TriggerAction {
	bool enabled = false;
	int16_t damage = 0;
	int16_t heal = 0;
	int16_t changeSpeed = 0;
	uint32_t intervalMs = 0;
	// Destroy self when triggered; the blast itself is <onDestroy>'s explosion.
	bool detonate = false;
};

enum class AlignType : uint8_t {
	NONE = 0,
	BOTTOM = 1,
	LEFT = 2,
	TOP = 3,
	RIGHT = 4
};

// <logic type=> interned from the XML string. The circuit solver tests these
// several times per object per propagation pass, so they cannot be string
// compares. Same reasoning as AgentAbilityType in agent.h.
enum class LogicType : uint8_t {
	None,
	Cable,
	Bridge,          // cable4: two independent signal lanes
	Switch,
	Timer,
	Lamp,
	Sink,
	PlatformSource,
	GateAnd,
	GateOr,
	GateNot,
	GateXor,
};

inline bool isLogicGate(LogicType type)
{
	return type == LogicType::GateAnd || type == LogicType::GateOr
	    || type == LogicType::GateNot || type == LogicType::GateXor;
}

// <object category=> interned, same reasoning as LogicType above. It was a
// std::string compared against literals at seven call sites, so a typo in the
// XML was not a category at all and nothing said so -- a "palnt" simply stopped
// being a plant. Every value objects.xml and furnitures.xml use is listed, which
// is what lets the loader reject anything else.
//
// `resurection` keeps the file's spelling deliberately: it is the established
// key, no C++ reads it, and correcting it would be a content change with a
// migration cost and no behavioural gain.
enum class ObjectCategory : uint8_t {
	Other = 0,
	Plant,
	Spawner,
	Station,
	Wall,
	Container,
	Floor,
	Road,
	Resurection,
	Trap,
	Explosives,
	Logic,
	Furniture,
};

// <interaction type=> interned. Kept as `type` in the XML on purpose: unlike
// <fuel type=> (an item key) it really does say what KIND of interaction this
// is, so the name is not misleading -- only the string compares were.
enum class InteractionKind : uint8_t {
	None = 0,
	Station,
	Door,
	Container,
	Switch,
};

// Switches, timers and platforms drive the circuit; everything else only
// carries or consumes. Seeded directly in the propagation queue.
inline bool isLogicSourceDevice(LogicType type)
{
	return type == LogicType::Switch || type == LogicType::Timer
	    || type == LogicType::PlatformSource;
}

struct LogicState {
	bool powered = false;          // receives signal
	bool prevPowered = false;      // change detection
	bool switchOn = false;         // switch flipped state
	uint8_t timerRateIndex = 0;    // timer selected rate index (0-3)
	uint64_t nextTimerFire = 0;    // next firing tick time
	uint64_t nextPulseEnd = 0;     // end time of the timer's current brief pulse
	bool timerPulseState = false;  // timer current toggled output
	uint8_t lampColorIndex = 0;    // lamp current color index (0-6)
	bool poweredTB = false;        // for cable4 bridge vertical line
	bool poweredLR = false;        // for cable4 bridge horizontal line
	bool platformActiveState = false;
	bool platformTargetState = false;
	uint64_t platformStateChangeTime = 0;
};

struct ObjectData {
	uint16_t id = 0;
	std::string key;
	ObjectCategory category = ObjectCategory::Other;
	uint16_t healthMax = 0;
	// Health percentages at which the client's damaged sprite steps up, from
	// <destruction><stage hpPercent=.../></destruction>. Three, because the
	// client reads the stage from two bits of `state` (0 = intact, 1-3 broken).
	// The defaults are what the server hardcoded before the XML was read.
	uint8_t destructionStagePct[3] = { 75, 50, 25 };
	std::string layer;
	uint8_t protocolType = 0;
	uint8_t subtype = 0;
	bool explicitSubtype = false;
	bool isFloor = false;
	// abstract="true": a <base> template, never a spawnable object. furnitures.xml
	// declares two (base_sofa, base_storage) and they inherit the furniture item
	// id like every real furniture, so anything resolving by id has to skip them
	// or a map paste can spawn a template.
	bool isAbstract = false;
	uint8_t storageSlots = 0;
	bool refrigeration = false;
	std::vector<StorageContent> initialStorage;

	// Interaction
	InteractionKind interaction = InteractionKind::None;
	uint32_t interactionDelayMs = 0;

	// Station & Fuel
	// The client's AREAS index for this station, and the same number
	// lookupStationArea() maps a crafting <station key=> onto in item.cpp.
	uint8_t stationId = 0;
	std::string fuelItemKey;
	uint32_t fuelBurnMs = 0;
	uint16_t fuelAddAmount = 1;

	// Transform
	uint16_t width = 0;
	uint16_t height = 0;
	uint16_t radius = 0; // Circular collision fallback
	bool collision = false;
	bool blocksProjectiles = false;
	AlignType alignType = AlignType::NONE;

	std::vector<AreaEffect> areaEffects;

	RespawnerData respawner;

	std::vector<ObjectStage> stages;
	const ObjectStage* getStage(uint8_t stageId) const {
		for (const auto& stage : stages) {
			if (stage.id == stageId) return &stage;
		}
		return nullptr;
	}

	std::vector<ItemDrop> drops;
	ObjectExplosion explosion;

	uint32_t lifetimeMs = 0;

	// <place delayMs="600">: how long after placing THIS object the player must
	// wait before placing anything at all. The cooldown is per PLAYER, not per
	// object type -- a per-type one would just be dodged by alternating between
	// two walls. The client has no build cooldown of its own (it sends one
	// packet per click, client.js NnnNW), so this is the only limit there is.
	uint32_t placeDelayMs = 0;
	bool startLifetimeOnTrigger = false;

	// <conceal tiles="3">: hidden from everyone outside the owner's side (owner
	// and clan) until they are within this many tiles of it. 0 = an ordinary
	// building everyone in the viewport is sent. Enforced in the visibility
	// pass, never on the client: a stranger's client never receives the entity
	// at all, so nothing it could be modified to draw exists. Landmines and the
	// wiring declare it (the old client hid them by distance client-side, which
	// a modified client could ignore).
	uint8_t concealTiles = 0;

	// Remote channel this object listens on (<remote channel= action=>). Empty
	// = deaf, which is every object but the demolition charges. The ACTION
	// lives here rather than on the trigger so one signal can mean different
	// things to different objects: a charge detonates, a future floodlight
	// could toggle. Only "detonate" is implemented today.
	std::string remoteChannel;
	std::string remoteAction = "detonate";

	TriggerAction onStepIn;
	TriggerAction onStepOut;

	// Logic Wires & Gates
	bool isLogicObject = false;
	LogicType logicType = LogicType::None;
	uint8_t connectionMask[4] = {}; // bits: 0=T, 1=R, 2=B, 3=L
	uint8_t inputMask[4] = {};      // bits for input pins
	uint8_t lampColorCount = 7;
	std::vector<uint32_t> timerRatesMs;
	// <logic pulseType=>: true = "pulse" (one shot of pulseDurationMs),
	// false = "clock" (toggle and hold).
	bool pulseIsOneShot = true;
	uint32_t pulseDurationMs = 100;
	uint32_t platformDelayInMs = 500;
	uint32_t platformDelayOutMs = 500;
};

class Object final : public Thing
{
public:
	explicit Object(const std::string& key);
	~Object() override = default;

	// non-copyable
	Object(const Object&) = delete;
	Object& operator=(const Object&) = delete;

	// Thing overrides
	void buildUpdate(EntityUpdate& out) const override;
	void buildRemoval(EntityUpdate& out) const override;

	Object* getObject() override { return this; }
	const Object* getObject() const override { return this; }

	Tile* getTile() override;
	const Tile* getTile() const override;

	const Position& getPosition() const override { return position; }
	void setPosition(const Position& pos) override { position = pos; }

	uint16_t getHealth() const { return health; }
	void setHealth(uint16_t hp) { health = hp; }
	// The effective maximum: a scenario's per-instance override, else the
	// definition's healthMax. Every consumer (damage, repair, AI targeting, the
	// client's damage stage, look text) reads this, never od->healthMax, so a
	// fortified wall is fortified everywhere at once.
	uint16_t getMaxHealth() const;
	void setMaxHealthOverride(uint16_t value) { healthMaxOverride = value; }
	bool hasMaxHealthOverride() const { return healthMaxOverride != 0; }
	// Scenario placements may be indestructible: damage lands as nothing,
	// explicitly, rather than being encoded as zero health.
	bool isIndestructible() const { return indestructible; }
	void setIndestructible(bool value) { indestructible = value; }
	// healthDelta is int32_t so a saturated damage amount (MAX_DAMAGE_AMOUNT,
	// which is a whole uint16) survives being negated. See definitions.h.
	//
	// RETURNS the delta actually applied, signed like the request and 0 when
	// nothing landed. Trimmed to what the object had, so a shot that flattens a
	// 3 HP wall reports 3. Same contract as Player/Agent/Resource changeHealth.
	int32_t changeHealth(int32_t healthDelta, uint8_t angle = 0, class Player* attacker = nullptr);
	void removeSilently(); // destroy without explosion or destruction drops

	uint8_t getSubtype() const { return subtype; }
	bool hasFixedSubtype() const { return fixedSubtype; }
	void setSubtype(uint16_t s, bool fixed = false)
	{
		subtype = static_cast<uint8_t>(s > 63 ? 63 : s);
		if (fixed) {
			fixedSubtype = true;
		}
	}

	uint32_t getActiveUserPid() const { return activeUserPid; }
	void setActiveUserPid(uint32_t pid) { activeUserPid = pid; }

	uint8_t getRotation() const { return rotation; }
	void setRotation(uint8_t rot) { rotation = rot; }

	uint32_t getOwnerPid() const; // resolves the owning character, never a reused wire slot
	// Out of line: claiming an object also enrols it in the owner's remote-signal
	// registry when its type listens on a channel (see Game::remoteObjects).
	void setOwnerPid(uint32_t pid);

	const std::string& getKey() const { return key; }

	// The type data for this object's key, resolved once in the constructor.
	//
	// Player::scanAreaEffects asks every object within reach of every player on
	// every tick what it emits, and that used to be a string-keyed hash lookup
	// into ObjectManager each time. Objects never change key, and objects.xml is
	// fully loaded before anything spawns, so the pointer is fixed for the
	// object's life.
	//
	// CAVEAT for anyone adding objects.xml to `!reload-xml` (today it only
	// reloads equipables and wearables): rebuilding ObjectManager's table
	// invalidates every cached pointer here, so a reload would have to re-resolve
	// them for all live objects.
	const ObjectData* getData() const { return data; }


	bool hasCollision() const override;
	bool getCollisionRect(CollisionRect& rect) const override;
	float getCollisionRadius() const override;

	// World units within which a stranger is sent this object; 0 = not concealed.
	int32_t concealRange() const { return data ? static_cast<int32_t>(data->concealTiles) * TILE_SIZE : 0; }
	bool isConcealed() const { return data && data->concealTiles > 0; }

	uint32_t getFuelMs() const { return fuelMs; }
	void setFuelMs(uint32_t ms) { fuelMs = ms; }
	uint8_t getFuelByte() const;

	// Instance-level area effects, on top of the type-level ObjectData ones:
	// carried by this specific object (e.g. structure-template radiation) and
	// gone with it when it is destroyed
	void addInstanceAreaEffect(const AreaEffect& effect) { instanceAreaEffects.push_back(effect); }
	const std::vector<AreaEffect>& getInstanceAreaEffects() const { return instanceAreaEffects; }

	bool isDoorOpen = false;
	mutable bool openFailedPulse = false;
	bool isDoorStateOpen() const { return isDoorOpen; }
	void toggleDoor() { isDoorOpen = !isDoorOpen; }
	void setOpenFailed() { openFailedPulse = true; }

	bool blocksProjectiles() const;
	LogicState logicState;

	// Storage/Container methods
	uint8_t getStorageSize() const { return static_cast<uint8_t>(storage.size()); }
	Item* getStorageItem(uint8_t slot) const { return (slot < storage.size()) ? storage[slot].get() : nullptr; }
	void setStorageItem(uint8_t slot, std::unique_ptr<Item> item) { if (slot < storage.size()) storage[slot] = std::move(item); }
	void swapStorageItems(uint8_t a, uint8_t b) { if (a < storage.size() && b < storage.size()) std::swap(storage[a], storage[b]); }
	void initStorage(uint8_t slots) { storage.resize(slots); }

	// Station methods
	struct QueueItem {
		uint16_t iid = 0;
		uint32_t creator = 0, creatorLife = 0;
		// Units produced when this job is collected. Fixed for a recipe, but
		// rolled per job for an extraction, so it is decided when the job is
		// queued and stored rather than re-derived at collection time.
		uint16_t yield = 1;
		uint32_t totalTimeMs = 0;
		uint32_t progressMs = 0;
		std::vector<std::pair<uint16_t, uint8_t>> ingredients;
	};
	void addToQueue(uint16_t iid, uint16_t yield, uint32_t timeMs, std::vector<std::pair<uint16_t, uint8_t>>&& ingredients);
	void removeFromQueue(uint8_t slot);
	std::vector<QueueItem>& getQueue() { return queue; }
	const std::vector<QueueItem>& getQueue() const { return queue; }

	void onCreatureEnter(Creature* c);
	void onCreatureLeave(Creature* c);
	void updateTriggers(uint64_t currentTimeMs);
	void detonate();

	bool isDestroyed = false;
	bool isTriggered = false;

	uint32_t stageElapsedMs = 0;  // time spent in the current growth stage
	uint64_t placedTime = 0;      // creation time; ordering key for respawner use

	bool isTeammateOrOwner(Creature* target) const;
	// Whose object this is, seen from `player`: theirs, a clan mate's, someone else's, or nobody's.
	ObjectOwner ownerRelationTo(const Player* player) const;
	bool canBeTriggeredBy(Creature* c) const;

private:
	void executeTrigger(const TriggerAction& trigger, Creature* target);
	void executeExplosion(const ObjectExplosion& exp, Player* attacker);
	void finishDestruction(const ObjectData* od);

	std::string key;
	// Resolved once from `key` in the constructor; see getData().
	const ObjectData* data = nullptr;
	uint16_t health = 0;
	// 0 = no override; see getMaxHealth.
	uint16_t healthMaxOverride = 0;
	bool indestructible = false;
	uint32_t ownerPid = 0;
	uint32_t ownerCharacterId = 0; // independent of reconnect credentials and future account IDs
	uint32_t activeUserPid = 0;
	uint32_t fuelMs = 0;
	uint8_t rotation = 0;
	uint8_t impactAngle = 0;
	uint8_t subtype = 0;
	bool fixedSubtype = false;
	Position position;
	
	std::vector<std::unique_ptr<Item>> storage;
	std::vector<QueueItem> queue;
	std::vector<AreaEffect> instanceAreaEffects;

	std::unordered_map<uint32_t, uint64_t> activeTriggers;
};

class ObjectManager
{
public:
	ObjectManager() = default;

	static ObjectManager& getInstance() {
		static ObjectManager instance;
		return instance;
	}

	// non-copyable
	ObjectManager(const ObjectManager&) = delete;
	ObjectManager& operator=(const ObjectManager&) = delete;

	bool loadFromXml(const std::string& filename);
	bool loadItemsFromXml(const std::string& filename);

	// Warns about <stage spawnCreature="..."> keys that no agents.xml entry
	// matches. Separate from loadFromXml because objects load before agents do,
	// and a bad key would otherwise fail silently -- the stage fires, spawns
	// nothing, and the spawner looks broken with no explanation.
	void validateStageCreatures() const;
	const ObjectData* getObjectData(const std::string& key) const;
	const ObjectData* getObjectData(uint16_t id) const;

	// The object a map-editor record names, from the item id it carries and the
	// optional subtype beside it (see the format notes in mapimport.h).
	//
	// getObjectData(uint16_t) cannot answer this. It returns the first match in
	// an unordered_map, and the item id is NOT unique: every entry in
	// furnitures.xml resolves through its type to the single "furniture" item
	// (id 71), so ~60 objects share it and only `subtype` tells them apart. The
	// iteration order of an unordered_map is also not the file order, so the
	// first match is not even stable between runs.
	//
	// Resolution, in order:
	//   with a subtype    -- an object declaring exactly that subtype; failing
	//                        that, the type's single VARIANT CARRIER (an object
	//                        with no declared subtype, i.e. road), where the
	//                        subtype is a texture index rather than a different
	//                        object and the caller applies it.
	//   without a subtype -- the variant carrier, else the object declaring
	//                        subtype 0.
	// Returns nullptr when nothing matches; callers must skip the record rather
	// than substitute anything, since a wrong object is a wrong world.
	const ObjectData* resolveMapItem(uint16_t iid, uint8_t subtype, bool hasSubtype) const;

	// Rebuilds the resolveMapItem index. Must run after the LAST loadFromXml:
	// objects.xml and furnitures.xml both feed it and the second load adds the
	// ids that collide.
	void buildMapItemIndex();

	// Crafting station key -> the client Area id its menu opens under, built
	// from the <station key= areaId=> pairs in objects.xml.
	//
	// It lives here because objects.xml is where a station IS defined; item.cpp
	// used to carry a second copy as a C++ literal, which meant adding a station
	// was a code change and the two could disagree in silence. Returns false for
	// a key no object declares, leaving areaId untouched.
	bool getStationAreaId(const std::string& key, uint8_t& areaId) const;

	Object* createObject(const std::string& key, const Position& pos, uint8_t rotation = 0);

	// Furthest any loaded object's collision shape reaches from its own
	// position, in world units. Spatial searches that must not miss a big
	// object derive their tile margin from this (see PROJECTILE_SCAN in
	// game.cpp), so adding wider content automatically widens the search
	// instead of silently letting projectiles pass through it.
	uint16_t getMaxCollisionExtent() const { return maxCollisionExtent; }

private:
	void noteCollisionExtent(const ObjectData& od);

	uint16_t maxCollisionExtent = 0;
	std::unordered_map<std::string, ObjectData> objects;
	std::unordered_map<std::string, uint16_t> mapKeyToId;
	std::unordered_map<std::string, uint8_t> stationAreaByKey;

	// Keys in the order the XML declared them, so resolveMapItem breaks ties the
	// way a content author would read the file. `objects` is an unordered_map
	// and cannot answer this.
	std::vector<std::string> declarationOrder;

	// item id -> every object carrying it, in declaration order. Pointers into
	// `objects`: std::unordered_map never invalidates references on insert, so
	// these survive furnitures.xml loading after objects.xml (Object::data
	// relies on the same guarantee).
	std::unordered_map<uint16_t, std::vector<const ObjectData*>> mapItemIndex;

	bool warnedExhausted = false;
};

extern ObjectManager g_objects;

#endif // FS_OBJECT_H
