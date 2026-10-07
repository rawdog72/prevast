// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PLAYER_H
#define FS_PLAYER_H

#include "gameplay/creature.h"
#include "core/enums.h"
#include "network/protocolgame.h"
#include "core/tools.h"
#include "world/tile.h"
#include "gameplay/inventory.h"
#include "gameplay/condition.h"
#include "gameplay/groups.h"
#include "gameplay/aim_view.h"
#include <array>
#include <memory>
#include <set>
#include <string_view>

class NetworkMessage;
class SchedulerTask;
class Thing;
class Item;
class Object;
struct ItemData;
struct ConsumableEffect;
struct WearableData;
struct GaugeMode; // game.h
struct AgentData;  // agent.h -- the creature behind a ghoul player
struct EquipableData; // equipment.h

// The set of entity ids a client has cached, held as a sorted vector rather
// than a hash set: 4 contiguous bytes per entry instead of a ~40-byte scattered
// node. Summed over every player that is the working set the visibility diff
// touches each tick, and keeping it in L3 is what stops per-entity cost falling
// off a cliff as entity counts grow.
//
// Sorted order also lets the diff be a linear merge against the (sorted)
// visible set, so the hot path performs no insert, erase or lookup at all --
// it builds the next set in order and swaps it in. The mutators below are for
// the event-driven callers outside the tick.
// It is split into a mobile half (creatures, projectiles) and a static half
// (objects, resources, loot) because the two are rebuilt on completely
// different schedules: the mobile half every tick, the static half only when
// the player's viewport tile box shifts. Keeping them as separate sorted runs
// means the per-tick merge never has to walk past the static ids at all -- and
// the static ids outnumber the mobile ones by roughly 30:1 in a shipped world.
//
// The event-driven callers (insert/erase/contains/clear) do not care which half
// an id lives in; insert routes by id class and erase tries both.
class KnownEntitySet
{
public:
	bool contains(uint32_t id) const
	{
		const std::vector<uint32_t>& half = isMobileEntityId(id) ? mobileIds : staticIds;
		return std::binary_search(half.begin(), half.end(), id);
	}

	void insert(uint32_t id)
	{
		std::vector<uint32_t>& half = isMobileEntityId(id) ? mobileIds : staticIds;
		auto it = std::lower_bound(half.begin(), half.end(), id);
		if (it == half.end() || *it != id) {
			half.insert(it, id);
		}
	}

	void erase(uint32_t id)
	{
		std::vector<uint32_t>& half = isMobileEntityId(id) ? mobileIds : staticIds;
		auto it = std::lower_bound(half.begin(), half.end(), id);
		if (it != half.end() && *it == id) {
			half.erase(it);
		}
	}

	// Remove every id in `sortedRemovals` (ascending, unique) from the STATIC
	// half in one linear pass.
	//
	// Replaces a per-id erase(), which is a lower_bound plus a vector memmove.
	// At ~100 loot removals in a tick against a ~400-entry static half that is
	// ~40,000 element moves per player per tick, and it is paid by all 250 of
	// them: the 6.4ms `loot` phase was almost entirely this, which is why
	// indexing the loot itself (Map::loots) did not move the phase at all --
	// the scan was never the cost.
	//
	// In place, with a write cursor: no allocation, no scratch buffer, and the
	// survivors keep their order, which is what makes the set stay sorted.
	// `ri` only ever advances because both sequences are ascending.
	void eraseSortedStatic(const std::vector<uint32_t>& sortedRemovals)
	{
		size_t w = 0;
		size_t ri = 0;
		for (size_t r = 0; r < staticIds.size(); ++r) {
			const uint32_t id = staticIds[r];
			while (ri < sortedRemovals.size() && sortedRemovals[ri] < id) {
				++ri;
			}
			if (ri < sortedRemovals.size() && sortedRemovals[ri] == id) {
				continue;
			}
			staticIds[w++] = id;
		}
		staticIds.resize(w);
	}

	void clear() { mobileIds.clear(); staticIds.clear(); }
	size_t size() const { return mobileIds.size() + staticIds.size(); }

	// Hot-path accessors: the diff merges each half against its own sorted
	// visible set and swaps the result in.
	const std::vector<uint32_t>& mobile() const { return mobileIds; }
	const std::vector<uint32_t>& statics() const { return staticIds; }
	void adoptSortedMobile(std::vector<uint32_t>& sortedIds) { mobileIds.swap(sortedIds); }
	void adoptSortedStatic(std::vector<uint32_t>& sortedIds) { staticIds.swap(sortedIds); }

private:
	std::vector<uint32_t> mobileIds;
	std::vector<uint32_t> staticIds;
};

constexpr int32_t PLAYER_MAX_SPEED = 1500;
constexpr int32_t PLAYER_MIN_SPEED = 10;

// The XP curve (900 * 1.105^level) exceeds uint32 around level ~154; cap well
// past that so the level-up loop always terminates even at max experience.
constexpr uint32_t PLAYER_MAX_LEVEL = 200;

class Player final : public Creature
{
public:
	explicit Player(ProtocolGame_ptr p);
	~Player();

	// non-copyable
	Player(const Player&) = delete;
	Player& operator=(const Player&) = delete;

	Player* getPlayer() override { return this; }
	const Player* getPlayer() const override { return this; }

	void setID() final;

	const std::string& getName() const override { return name; }
	void setName(std::string_view name) { this->name = name; }

	CreatureType_t getType() const override { return CREATURETYPE_PLAYER; }
	// Ghost mode only. The `ghoul == 0` term this used to carry made ghouls
	// unshootable and unhittable rather than merely non-solid -- see the note on
	// Creature::hasCollision.
	bool hasCollision() const override { return !m_ghostMode; }

	void setGUID(uint32_t guid) { this->guid = guid; }
	uint32_t getGUID() const { return guid; }
	uint32_t getLifeGeneration() const { return lifeGeneration; }

	const std::string& getToken() const { return token; }
	void setToken(std::string_view token) { this->token = token; }

	uint8_t getAdblocker() const { return adBlocker; }
	void setAdblocker(uint8_t adBlocker) { this->adBlocker = adBlocker; }


	// Identity. accountId 0 is a guest. The group is looked up by id on every
	// call, so a !reload of groups.xml reaches everyone online at once.
	uint32_t getAccountId() const { return accountId; }
	void setAccountId(uint32_t id) { accountId = id; }
	bool isVerified() const { return accountId != 0; }
	uint8_t getGroupId() const { return groupId; }
	void setGroupId(uint8_t id) { groupId = id; }
	const Group& getGroup() const { return g_groups.getOrDefault(groupId); }
	bool hasGroupFlag(GroupFlag flag) const { return getGroup().has(flag); }
	uint8_t getGroupRank() const { return getGroup().rank; }
	// Holds its group through adminPassword rather than an account.
	bool isPasswordAdmin() const { return passwordAdmin; }
	void setPasswordAdmin(bool value) { passwordAdmin = value; }
	// Who may act on whom (kick, ban, !setgroup): the rank, plus one for the
	// adminPassword login so the emergency key outranks every account.
	uint16_t getAuthorityRank() const { return static_cast<uint16_t>(getGroupRank() + (passwordAdmin ? 1 : 0)); }

	ProtocolGame_ptr getProtocolGame() const { return client; }

	// What this player sees, from the view updateAim settled this tick: the
	// view box, or a strong scope's rear circle and outer shape.
	bool canSee(const Position& pos) const override;
	bool canSeeCreature(const Creature* creature) const override;
	// Whether scenery at `pos` is sent: inside the view box (PlayerView::box).
	// The same as canSee unless a strong scope is aimed. Its shape is narrower
	// than the box its scenery comes from, so a building placed beside the
	// shape still reaches the client. Surgical updates of statics use this;
	// everything else uses canSee.
	bool canSeeScenery(const Position& pos) const;

	// canSee with the range supplied by the caller. Same test; exists so a hot
	// loop can hoist the two ConfigManager lookups that canSee() performs on
	// every single call. The projectile paths ask it four times per player per
	// bullet, which at 250 bots was ~350,000 config hash lookups a tick.
	bool canSeeWithin(const Position& pos, int32_t rangeX, int32_t rangeY) const
	{
		return getPosition().isInRange(pos, rangeX, rangeY);
	}

	uint16_t getProtocolVersion() const
	{
		if (!client) {
			return 0;
		}

		return client->getVersion();
	}

	bool isOffline() const { return (getID() == 0); }
	void disconnect()
	{
		if (client) {
			client->disconnect();
		}
	}
	Connection::Address getIP() const;


	void sendKeepAlive();
	void sendPingBack() const
	{
		if (client) {
			client->sendPingBack();
		}
	}

	void sendNetworkMessage(const NetworkMessage& message)
	{
		if (client) {
			client->writeToOutputBuffer(message);
		}
	}

	void sendInventorySlot(uint16_t iid, uint8_t count, uint32_t uid, uint8_t ammo);
	void sendClearInventorySlot(uint32_t uid);
	void sendItemMods(const Item& item) {
		if (client) client->sendItemMods(item.getUID(), item.getMods());
	}
	void sendFullInventory() {
		if (client) client->sendFullInventory();
	}
	void sendSelectedItem(uint16_t iid) {
		if (client) client->sendSelectedItem(iid);
	}
	void sendPlayerXp(uint16_t xp) {
		if (client) client->sendPlayerXp(xp);
	}
	void sendShakeExplosionState(uint8_t shake) {
		if (client) {
			client->sendShakeExplosionState(shake);
		}
	}
	// A damaging trap's jolt, at most once per intervalMs (Object::executeTrigger).
	void sendTrapShake(uint64_t now, uint64_t intervalMs) {
		if (now - lastTrapShakeMs < intervalMs) return;
		lastTrapShakeMs = now;
		sendShakeExplosionState(10);
	}
	void sendBoughtSkill(uint16_t iid) {
		if (client) client->sendBoughtSkill(iid);
	}
	void sendStartInteraction(uint16_t delay) {
		if (client) client->sendStartInteraction(delay);
	}
	void sendInterruptInteraction() {
		if (client) client->sendInterruptInteraction();
	}
	void sendBlueprint(uint16_t iid) {
		if (client) client->sendBlueprint(iid);
	}
	void sendLostStation() {
		if (client) client->sendLostStation();
	}
	void sendFullChest(Object* obj, bool firstOpen = false) {
		if (client) client->sendFullChest(obj, firstOpen);
	}
	void sendOpenStation(uint8_t area, uint8_t isLogin) {
		if (client) client->sendOpenStation(area, isLogin);
	}
	void sendNewFuelValue(uint8_t value, uint32_t remainingMs) {
		if (client) client->sendNewFuelValue(value, remainingMs);
	}
	void sendWrongTool(uint8_t toolIid) {
		if (client) client->sendWrongTool(toolIid);
	}

	std::vector<EntityUpdate> pendingUpdates;
	bool pendingIsLogin = false;

	// When this player's hit flash was last broadcast to OTHER players, for the
	// throttle in Game::broadcastPlayerHit. Wall-clock, like every other rate
	// gate here, because the tick rate sags under exactly the load that makes
	// this matter.
	uint64_t lastHitFlashBroadcast = 0;

	// Cosmetic event frames already delivered to this client this tick; reset
	// by the movement tick. See ConfigManager::EVENT_FRAMES_PER_TICK.
	uint16_t eventFramesThisTick = 0;

	void pushUpdate(const EntityUpdate& update) {
		pendingUpdates.push_back(update);
	}

	// Wall-clock, not a tick counter: the tick rate sags under load, so a
	// tick-based idle timer would kick players hardest exactly when the server
	// is already struggling (same trap the keepalive hit).
	uint64_t getIdleMs(uint64_t now) const { return now > lastActivityAt ? now - lastActivityAt : 0; }
	void resetIdleTime() { lastActivityAt = static_cast<uint64_t>(OTSYS_TIME()); }

	uint64_t getSessionStart() const { return sessionStart; }

	// Build rate limit, from the placed object's <place delayMs> (objects.xml).
	// One cooldown per player rather than per object type: a per-type one is
	// dodged by alternating between two walls, which is exactly the spam this
	// is here to stop.
	bool canPlaceObjectNow() const { return OTSYS_TIME() >= nextPlaceAt; }
	void notePlacedObject(uint32_t delayMs) { nextPlaceAt = OTSYS_TIME() + static_cast<int64_t>(delayMs); }

	bool isGhostMode() const { return m_ghostMode; }
	void setGhostMode(bool ghost) { m_ghostMode = ghost; }
	bool isGhostVisible() const { return m_ghostVisible; }
	void setGhostVisible(bool visible) { m_ghostVisible = visible; }
	bool isInvincible() const { return m_invincible; }
	void setInvincible(bool invincible) { m_invincible = invincible; }

	void receivePing() { lastPong = OTSYS_TIME(); }

	void onThingAppear(Thing* thing, bool isLogin) override;

	uint64_t getTokenID() const { return tokenId; }
	void setTokenID(uint64_t id) { tokenId = id; }

	uint32_t getScore() const { return score; }
	void setScore(uint32_t s) { score = s; }
	
	uint8_t getKarmaLevel() const { return karmaLevel; }
	void setKarmaLevel(uint8_t newKarma);
	float getKarmaXPMultiplier() const;
	uint8_t getKarmaClientIcon() const;
	void registerAttacker(uint32_t attackerGuid);
	bool hasAttackedRecently(uint32_t attackerGuid) const;
	uint32_t getKarmaKills() const { return karmaKills; }
	void setKarmaKills(uint32_t kills);
	// Lives taken this character, players and ghouls alike. Unlike karmaKills
	// it only ever grows: it is what the death screen calls "Kills".
	uint32_t getKills() const { return kills; }
	void addKill() { ++kills; }
	void forceKarma(uint8_t level, uint32_t kills);

	uint32_t getXP() const { return experience; }
	void addXP(uint32_t amount, bool rankedEligible = true);
	void grantStartingLevel(uint32_t startLevel);

	uint32_t getLevel() const { return level; }
	uint32_t getRequiredXP(uint32_t level) const;
	uint32_t getSkillPoints() const { return (spentSkillPoints <= level) ? level - spentSkillPoints : 0; }
	void spendSkillPoints(uint32_t amount) { spentSkillPoints += amount; }

	bool hasSkill(uint16_t iid) const { return unlockedSkills.contains(iid); }
	void unlockSkill(uint16_t iid);
	const std::set<uint16_t>& getUnlockedSkills() const { return unlockedSkills; }
	uint8_t getCraftMultiplier(uint16_t iid) const;
	// string_view, not string: the gauge path calls this every tick for every
	// player with a literal, and "radiationResistance" is 19 chars -- past
	// MSVC's 15-char small-string buffer, so a const std::string& parameter
	// heap-allocated a temporary per player per tick.
	float getWearableModifier(std::string_view modifierKey) const;

	// Status Effects. The mechanism itself lives on Creature now (ConditionSet),
	// so an agent can be poisoned and slowed by the same content; what remains
	// here is everything a PLAYER additionally has -- five gauges to tick, a
	// client to tell, and a drug skin for everyone else to draw.

	// Creature::updateConditions plus the client-facing half. Called once per
	// movement tick from updateGauges.
	void updatePlayerConditions(uint32_t elapsedMs);

	// Creature::removeConditions plus the withdrawn marker, which outlives the
	// condition that set it and so cannot be cleared by removing anything.
	// Pre-split at load (EquipableData::cureConditionKeys); "all" is the
	// cure-everything sentinel, and a name may be a condition key or a tag.
	void cureConditions(const std::vector<std::string>& keysToCure);

	// What the client should be drawing on this player right now, read off the
	// whole active set. See ConditionVisual for why it is derived rather than
	// accumulated from stage transitions.
	ConditionVisual conditionVisual() const;
	// State it to everyone who can see this player, but only when it has
	// actually changed shape or the re-state window has elapsed. Modelled on
	// syncGaugeRates, which is edge-triggered on its payload for the same
	// reason: the wire cost has to scale with events, not with ticks.
	void syncConditionVisual(uint32_t elapsedMs, bool force = false);
	// The green screen distortion, which is a separate problem from the skins:
	// self only, so there is nobody else to tell, and the client runs the
	// animation down itself with a duration that fits the byte exactly, so there
	// is nothing to re-state either. Edge-triggered on whether any active
	// condition wants it, plus forced on a dose so a refresh reaches the client.
	void syncPoisonScreen(bool force);
	// The same statement aimed at one client. Used at login, where the wire has
	// room for the live timers in the handshake roster but not for the
	// withdrawn marker.
	void sendConditionVisualTo(ProtocolGame* target) const;
	// Does an active status effect make this player invisible to an agent of
	// this family / key? See <repel> in status_effects.xml -- the ghoul drug is
	// the one that ships. Asked by Game::isAgentHostileTo, i.e. per agent per
	// nearby player per tick, so the empty case has to be free: conditions is
	// empty for almost everyone and the loop never starts.
	bool repelsAgent(const std::string& family, const std::string& key) const;

	// Every active stage modifier folded together in one pass. The fold itself is
	// cached inside ConditionSet, which invalidates it on every mutation of its
	// own -- so unlike the wearable cache below, this one cannot be forgotten.
	const ConditionTotals& conditionTotals() const { return conditions.totals(); }

	// The equipped wearable's speed penalty. Cached because getSpeed is asked
	// once per OBSERVER per entity by the visibility diff -- ~62,500 times a
	// tick at 250 clients -- and deriving it means an item lookup, a string-keyed
	// hash into EquipmentManager and a string compare per effect on the result.
	float wearableSpeedModifier() const;

	// Equipping or removing a wearable MUST call this. Over-invalidating costs
	// one cheap lookup; under-invalidating leaves a player moving at a speed they
	// no longer have.
	void markWearableCacheDirty() { wearableCacheDirty = true; }

	const std::vector<ActiveCondition>& getConditions() const { return conditions.active(); }

	// --- Surviving a conditions.xml hot reload -------------------------------
	//
	// Every ActiveCondition points into ConditionManager's table, which a reload
	// replaces wholesale, so the keys have to be read BEFORE the swap and handed
	// back after. ConditionSet::keys is the read half; this is the write half
	// plus the client statement the swap invalidates.
	std::vector<std::string> conditionKeys() const { return conditions.keys(); }
	void rebindConditions(const std::vector<std::string>& keys);

	// A player's protection from a condition: the wearable's own
	// <key>Resistance modifier on top of whatever <resist> is already running.
	// This is what makes a hazmat suit resist poison without a second mechanism.
	float conditionResistanceFor(const std::string& key) const override;

protected:
	// A repellent dose forgets every grudge this life earned. See the body.
	void onConditionApplied(const ConditionData* data) override;

	// A player has all five gauges, so every tick channel lands somewhere. Life
	// goes through changeHealth (and so can kill, and so can resurrect); the
	// other four move their gauge and mark it for the client.
	void applyConditionTick(GaugeSlot slot, int16_t amount, uint32_t inflictorGuid) override;

	// The set changed: the client's idea of the drug skin and the poison screen
	// was formed under the old set.
	void onConditionsChanged() override { syncConditionVisual(0, true); }

	void onConditionStageEnd(StageEndSkin endSkin) override
	{
		switch (endSkin) {
			case StageEndSkin::Normal:    drugWithdrawn = false; break;
			case StageEndSkin::Withdrawn: drugWithdrawn = true; break;
			case StageEndSkin::Unchanged: break;
		}
	}

	void beginConditionTicks() override { tickLifeGeneration = lifeGeneration; }

	// A resurrection mid-tick wipes the very conditions the remaining ticks came
	// from, so they must not be carried onto the new life. Health alone cannot
	// answer this -- a resurrection puts health straight back above zero, so a
	// before/after comparison reads a life ending as an ordinary heal.
	bool conditionTicksShouldContinue() const override
	{
		return lifeGeneration == tickLifeGeneration && health > 0;
	}

public:

	// Crafting
	struct CraftingState {
		uint16_t iid = 0;
		uint32_t eventId = 0;
		std::vector<std::pair<uint16_t, uint8_t>> ingredients;
	};
	CraftingState crafting;

	enum class EquipmentType {
		WEAPON,
		WEARABLE
	};

	void startEquipping(uint16_t iid, uint32_t itemUid);
	void cancelEquipping();
	void completeEquip(uint16_t iid, uint32_t itemUid, EquipmentType type);

	void equipItem(uint8_t slot);
	void useItem(uint8_t slot);

	uint16_t getEquippedWeaponIID() const { return equippedWeaponIID; }
	uint32_t getEquippedWeaponUID() const { return equippedWeaponUID; }
	uint16_t getEquippedWearableIID() const { return equippedWearableIID; }
	uint32_t getEquippedWearableUID() const { return equippedWearableUID; }

	void addInventoryItem(uint16_t iid, uint8_t count, const ItemState& state) {
		inventory.addItem(iid, count, state);
	}

	uint32_t getOpenedInteractionId() const { return openedInteractionId; }
	void setOpenedInteractionId(uint32_t id) { openedInteractionId = id; }
	void expectClientContainerClose(uint64_t until) {
		if (expectedClientContainerCloseCount < 8) {
			++expectedClientContainerCloseCount;
		}
		expectedClientContainerCloseUntil = until;
	}
	bool consumeExpectedClientContainerClose(uint64_t now) {
		if (expectedClientContainerCloseCount == 0) {
			return false;
		}

		if (now > expectedClientContainerCloseUntil) {
			clearExpectedClientContainerClose();
			return false;
		}

		--expectedClientContainerCloseCount;
		if (expectedClientContainerCloseCount == 0) {
			expectedClientContainerCloseUntil = 0;
		}
		return true;
	}
	void clearExpectedClientContainerClose() {
		expectedClientContainerCloseCount = 0;
		expectedClientContainerCloseUntil = 0;
	}

	// Gauges
	uint8_t getHealth() const { return health; }
	uint8_t getStamina() const { return stamina; }
	uint8_t getHunger() const { return hunger; }
	uint8_t getCold() const { return cold; }
	uint8_t getRadiation() const { return radiation; }

	void setHealth(uint8_t val) { health = val; }
	void setStamina(uint8_t val) { stamina = val; }

	// Add to the stamina gauge, saturating at this mode's ceiling and telling
	// the client. Distinct from setStamina, which is an absolute write with no
	// ceiling and no sync: a caller adding to a gauge should not have to know
	// what the mode's maximum is or that the client predicts the bar.
	void restoreStamina(uint8_t amount);
	void setHunger(uint8_t val) { hunger = val; }
	void setCold(uint8_t val) { cold = val; }
	void setRadiation(uint8_t val) { radiation = val; }

	// How many of the three environmental gauges are currently in their
	// life-draining band, and whether passive regen is allowed at all.
	//
	// Resolved ONCE per tick, before the rates are sent, and then used by both
	// the rate message and the life integration -- see computeGaugeRates. The
	// two must not each derive it, because they run either side of this tick's
	// gauge updates and would disagree by one tick's worth of drain.
	struct LifeDrainProfile
	{
		uint8_t drains = 0;      // 0-3; each is one full multiple of speedDec
		bool regenAllowed = false;
	};

	// Queue an authoritative GAUGE_VALUES push instead of sending one inline.
	//
	// The client free-runs all five bars itself between packets, so the server
	// only has to correct it -- but every correction is its own WebSocket frame
	// (writeToOutputBuffer cannot coalesce, see the comment there), and the
	// callers that used to send directly fire per swing, per bite and per poison
	// tick. Marking instead collapses everything that happened since the last
	// tick into the one frame flushGaugeSync sends.
	void markGaugesDirty() { gaugesDirty = true; }

	// Stronger than markGaugesDirty: says "the CLIENT is presumed wrong",
	// not "the server value moved", so it bypasses the equal-snapshot dedupe.
	// The distinction is load-bearing — the client coming back from a hidden tab
	// with a full food bar the server has held at 255 for minutes is both the
	// case that needs a resync most and the one whose bytes have not changed.
	void forceGaugeResync() { gaugesForced = true; }

	// A session that has just attached knows nothing: it needs the real gauge
	// values AND the directions all five bars are running in. Deferred to the
	// next tick on purpose -- the client only has its Gauge objects after it
	// has processed the handshake this is queued alongside.
	//
	// Clearing the direction latch is what covers the reattach case. The latch
	// belongs to the CHARACTER, which outlives its socket (a dropped connection
	// leaves the body in the world), so a session attaching to a character
	// already standing in a radiation field produces no edge and would never be
	// told. That hole used to need a separate resendAreaSignals() with a
	// hand-ordered list of six sends; one latch closes it for all five gauges.
	void requestFullGaugeResync()
	{
		gaugesForced = true;
		gaugeDirectionsKnown = false;
		gaugeRatesKnown = false;
	}

	// The five (max, speedInc, speedDec) triples in GAUGE_RATES order --
	// life, food, warmth, stamina, radiation -- laid out exactly as ui16[1..15]
	// on the wire.
	//
	// These are PER PLAYER, not per mode. The client's own resistance handling is
	// dead code (`ENTITIES[player].clothes[]` is a sprite table with no `warm` or
	// `rad` key, so `gauge.bonus` is pinned at 0 forever), which left every
	// resistance the server applied as pure divergence. Sending the resistance as
	// an adjusted RATE is the only lever the protocol has, and the server then
	// runs on the same integers it sent, so the two sides agree by identity.
	using GaugeRates = std::array<uint16_t, GAUGE_SLOT_COUNT * GAUGE_RATE_FIELD_COUNT>;
	// Sends `rates` when they differ from what this client last got, and
	// returns them: the tick integrates exactly what was sent.
	GaugeRates syncGaugeRates(const GaugeRates& rates);

	// What GAUGE_VALUES puts on the wire for radiation. The gauge is inverted (the
	// client's bar is cleanliness) and the inversion is against the radiation
	// gauge's own ceiling, which `!gauge-rad-size` can move.
	uint8_t getRadiationWireValue() const;

	// Re-clamp every gauge to its configured ceiling (see !gauge-X-size).
	void clampGaugesToMax();

	void setShift(bool val);
	bool isShift() const { return shift; }
	// Did the player's OWN step change their position on the last movement tick?
	// Holding Shift and a direction into a wall moves nothing, so it must not
	// burn stamina (updateStaminaGauge); Game::updateMovement sets this.
	void setWalkedLastTick(bool val) { walkedLastTick = val; }

	uint16_t getSpeed() const override;
	bool hasInteractionSlowLock() const;
	// AIM: whether the aim button is held. Whether aiming is ACTIVE is derived
	// from it, once per tick, by updateAim.
	void setAimHeld(bool held) { aimHeld = held; }
	bool isAiming() const { return aimActive; }
	// Once per tick, at the top of the visibility loop, for every player:
	// derives aimActive from the held button, the weapon, life and any running
	// interaction, sends AIM_STATE when it changes, and rebuilds the view.
	void updateAim(int32_t viewX, int32_t viewY, uint64_t now);
	// What this player is sent, settled by updateAim each tick: the viewport
	// box, stretched or shifted while aiming a weak scope, or a strong scope's
	// shape with the box its scenery comes from. canSee, canSeeScenery, the
	// visibility scan, the static tile box, the spectator lookups and the
	// cosmetic radius all read it.
	const PlayerView& getView() const { return view; }

	// --- Ghoul mode -------------------------------------------------------
	//
	// In ghoul mode a player who joins after the round locks is dropped into an
	// agents.xml creature instead of a human body: its health, speed, night
	// speed, melee, resistances and drops. `ghoul` (on Creature) is the byte the
	// client renders from -- sprite index + 1, so 0 stays "a person" -- and this
	// is the data behind it. Both are set together by becomeGhoul and are never
	// cleared: a ghoul stops being one by dying, which ends the character.
	//
	// Null for every player in every other mode, so isGhoul() is the one test
	// the rest of the server asks.
	bool isGhoul() const { return ghoulData != nullptr; }
	const AgentData* getGhoulData() const { return ghoulData; }
	void becomeGhoul(const AgentData* data);
	// Scatters this ghoul's agents.xml <onDeath> drops and fires its explosion,
	// in place of the inventory spill a human death produces.
	void dropGhoulRemains();
	// Applies the creature's <daylight> burn, if the mode has it switched on.
	// Off by default in ghoul mode; see GhoulRules::daylightDamage.
	void updateGhoulDaylight(uint64_t now);

	// Damage quoted in ordinary weapon units, converted to this character's life
	// GAUGE. 1 for a human: their 255-point bar IS their health. For a ghoul it
	// is 255/<vitals health>, because the bar is one byte and an armoured ghoul
	// has 800 hit points -- so the bar stays a percentage of a pool the creature
	// actually has, and the same shot takes a fifth as much off it as off a
	// normal ghoul. See Player::changeHealth.
	float getDamageToGaugeScale() const { return ghoulDamageScale; }

	// int32_t delta, same reason as Object::changeHealth (see definitions.h).
	// The health BAR is a uint8 and the arithmetic below saturates into it.
	//
	// RETURNS the delta actually applied to the bar, in bar points, signed the
	// same way as the request: 0 when nothing landed (ghost mode, an admin, a PvP
	// veto, a resistance that absorbed it whole), and never more than the target
	// had left to lose or room to gain. That is the number every on-hit effect
	// derived from damage must read -- leech off the REQUESTED amount would
	// ignore armour entirely and pay out in full on a 1 HP overkill.
	int32_t changeHealth(int32_t healthDelta, bool broadcast = true, bool force = false, bool isTick = false, const std::string& damageType = "", Player* attacker = nullptr);

	// Hit (damage=true) or heal flash for this player. `isTick` marks gauge
	// damage, which is the only source that fires for everyone at once and so
	// is the only one the showEnvironmentDamageToOthers gate applies to.
	void broadcastHealthAura(bool damage, bool isTick);
	void applyResurrection(const struct RespawnerData& data);

	// --- Threat profile (agent AI) ----------------------------------------
	//
	// How long this character has been alive. Each agent type only starts
	// hunting a player who has survived longer than its own `aggroAfter`
	// window (agents.xml), so someone who has just spawned is not immediately
	// swarmed. Reset on login and on resurrection -- both begin a new life.
	void resetSurvivalTimer() { survivalStart = OTSYS_TIME(); provokedAgents.clear(); }
	uint64_t getSurvivedMs() const
	{
		const int64_t now = OTSYS_TIME();
		return (survivalStart <= 0 || now <= survivalStart) ? 0 : static_cast<uint64_t>(now - survivalStart);
	}

	// Agent types this player has picked a fight with. Hitting one member makes
	// EVERY agent of that type hostile, regardless of the survival gate -- prod
	// a nest of explosive ghouls and the whole nest comes. Kept as a small
	// vector because a player provokes a handful of types at most, and a linear
	// scan over that beats a hash node every time an agent looks for a target.
	void provokeAgentType(const std::string& key)
	{
		if (!hasProvokedAgentType(key)) {
			provokedAgents.push_back(key);
		}
	}
	bool hasProvokedAgentType(const std::string& key) const
	{
		return std::find(provokedAgents.begin(), provokedAgents.end(), key) != provokedAgents.end();
	}

	// A repellent (conditions.xml <repel>) makes a whole FAMILY ignore you.
	// Hitting one member of a type inside that family is you personally starting
	// a fight with that type, and it costs you the protection -- for that type
	// only, and only until the window from agents.xml runs out. Refreshed by
	// every further hit, so the clock measures time since you last touched one.
	//
	// Separate from provokedAgents on purpose. That list answers "has this
	// player ever prodded this type" for the spawn grace and lasts the whole
	// life; this one answers "is this type still angry" and expires. Folding
	// them together would make one stray shot permanent.
	void breakRepelForAgentType(const std::string& key, uint32_t forMs);
	bool isRepelBrokenForAgentType(const std::string& key) const;
	// Drops every broken-repel record. Drinking a fresh dose is what calls this:
	// the drug resets the ghouls' hostility toward you, so grudges from before
	// it do not carry into it.
	void clearBrokenRepels() { brokenRepels.clear(); }

	void updateGauges(uint32_t elapsedMs);
	void updateActions();

	void handleMouseDown();
	void handleMouseUp();
	void cancelAction();
	void performAction();
	void performMeleeAttack(const struct EquipableData* edata);
	void spawnProjectiles(const struct EquipableData* edata, class Item* equippedItem);
	// Deferred half of a wind-up shot (<timing impactMs>): the draw finished, so
	// the projectile leaves now. iid/uid identify the weapon that was DRAWN.
	void releaseShot(uint16_t iid, uint32_t itemUid);
	// Landing half of a melee swing that has a wind-up (<ability impactMs>).
	void releaseMeleeSwing();
	void applyRecoil(const struct EquipableData& edata);
	void consumeItem(uint16_t iid, uint32_t itemUid);

	void startReload();
	void cancelReload();
	void completeReload();

	// FIT_WEAPON_MOD: plans and starts a timed fit/swap/remove. Returns the refusal
	// for the status line, or empty when it started.
	std::string startModChange(uint8_t weaponWireUid, ModSlot slot, bool fit, uint8_t modWireUid);
	void completeModChange();
	void cancelModChange();
	// An item left the inventory or went into a trade offer: cancel the change if it was the gun or the mod.
	void cancelModChangeFor(uint32_t uid);
	// True only for a weapon that takes ammo and has none loaded.
	bool isEquippedWeaponEmpty() const;

	void completeThrow(uint16_t iid, uint32_t itemUid);
	const ItemData* getItemData(uint16_t iid) const;
	const EquipableData* getEquippedWeaponData() const;
	const WearableData* getEquippedWearableData() const;
	uint8_t getCraftBonusForSkill(uint16_t skillIid, uint16_t craftedIid) const;
	bool cancelInteractionEvent(uint32_t& eventId);
	void beginConsumableAction(uint16_t iid, uint32_t itemUid, const EquipableData& edata);
	void beginThrowAction(uint16_t iid, const EquipableData& edata);
	// Detonator press. The signal goes out after <timing impactMs>, so a
	// trigger can have a delay between the plunger and the blast.
	void beginRemoteTrigger(const EquipableData& edata);
	void fireRemoteTrigger(const std::string& channel);
	bool consumeStaminaForAction(uint8_t amount, bool syncWhenZero = false);
	int8_t findInventorySlotByItemKey(const std::string& itemKey, uint8_t minCount = 1) const;
	Item* getInventoryItemByUid(uint16_t iid, uint32_t itemUid) const;
	void syncEquippedAmmo(uint16_t iid, Item& item);
	bool tryRepairObject(Object* targetObj, const EquipableData* edata, uint8_t impactAngle);
	int16_t applyConsumableEffect(const ConsumableEffect& effect);
	// swingDamage is the ONE roll this swing made (see rollMeleeDamage), passed
	// down so every target the arc catches takes the same blow.
	int32_t getMeleeObjectDamage(const Object& targetObj, const EquipableData& edata, uint16_t swingDamage) const;
	void applyMeleeHit(Thing* target, const EquipableData& edata, const Position& startPos, float hitX, float hitY, float directionX, float directionY, uint16_t swingDamage);
	void queueEquipCompletion(uint32_t delay, uint16_t targetIid, uint32_t targetUid, EquipmentType type);
	
	void applyKnockback(float forceX, float forceY) {
		// Impulse is drawn from a per-window BUDGET, not simply accumulated. A
		// pack of ghouls landing a hit on most ticks used to refill the recoil
		// buffer faster than it decayed and shove the player across the map;
		// now they share one window's worth between them, while a lone attacker
		// on its own cooldown still gets its full impulse.
		// <knockbackResist fraction=>: how much of the shove this creature is
		// heavy enough to ignore. Distinct from the budget above, which is a cap
		// SHARED by everyone hitting them -- this is one body being harder to
		// move than another. Applied before the budget so a resisted impulse
		// also consumes less of the window.
		const float letThrough = conditionTotals().knockbackLetThrough;
		if (letThrough <= 0.0f) return;
		forceX *= letThrough;
		forceY *= letThrough;

		const float mag = std::sqrt(forceX * forceX + forceY * forceY);
		const float scale = knockback.admit(mag, OTSYS_TIME());
		if (scale <= 0.0f) return;

		recoilX += forceX * scale;
		recoilY += forceY * scale;

		// Hard ceiling on what sits in the buffer at any instant: impulses
		// admitted across two consecutive windows can still add up here.
		const float magSq = recoilX * recoilX + recoilY * recoilY;
		if (magSq > MAX_KNOCKBACK_RECOIL * MAX_KNOCKBACK_RECOIL) {
			const float clamp = MAX_KNOCKBACK_RECOIL / std::sqrt(magSq);
			recoilX *= clamp;
			recoilY *= clamp;
		}
	}

	bool isAttacking = false;
	bool isConsuming = false;
	bool attackPulse = false;

	bool isDirty() const override {
		return Creature::isDirty() || isAttacking != lastIsAttacking || 
			isConsuming != lastIsConsuming || attackPulse;
	}

	void resetDirty() override {
		Creature::resetDirty();
		lastIsAttacking = isAttacking;
		lastIsConsuming = isConsuming;
		attackPulse = false;
	}

	Inventory inventory;
	// Entity ids this client currently has in its cache.
	KnownEntitySet knownCreatures;

	// Tile box the static half of knownCreatures was last built for. The
	// visibility tick recomputes that half only when this tick's box differs,
	// which for a walking player is roughly once every 9 ticks at 100-unit
	// tiles and never at all while they stand still.
	//
	// Deliberately compared as the whole box rather than tracking "did the
	// player change tile": the box edges are (pos +/- viewport) / TILE_SIZE, so
	// with a viewport that is not a whole number of tiles the two edges shift
	// at different positions. Comparing the box is exact for any viewport.
	//
	// Initialised inverted (min > max) so it can never equal a real box, which
	// forces a full static rebuild on the first tick of a session.
	int32_t staticBoxMinX = 1, staticBoxMinY = 1;
	int32_t staticBoxMaxX = 0, staticBoxMaxY = 0;

	// Puts the box back to that inverted sentinel, so the next visibility tick
	// re-derives the WHOLE static set instead of the entering/leaving strips.
	//
	// Needed after anything that changes the world under a player who is not
	// moving: world generation places statics with internalPlaceThing, which
	// does not broadcast, and a standing player never shifts their box -- so
	// without this the new world only appears once they walk.
	void invalidateStaticViewport()
	{
		staticBoxMinX = 1;
		staticBoxMinY = 1;
		staticBoxMaxX = 0;
		staticBoxMaxY = 0;
	}

	// Throws this client's whole entity view away and has it rebuilt from
	// scratch: the next flush carries the login flag, which client.js answers
	// with Entitie.removeAll() (onUnits, client.js:1497), and the visibility
	// tick that fills that flush re-derives every half against an empty known
	// set.
	//
	// For a WHOLESALE world replacement (!seed). Surgical removals cannot
	// express that safely: entity ids are recycled the instant they are freed,
	// so a removal for something the client was never told about can land on a
	// slot the new world has already claimed, and the client's flat cache has
	// no way to tell the two apart -- the old sprite stays and the new one
	// draws over it. Wiping is correct by construction, and cheaper too: one
	// full send instead of ~800 removals followed by ~800 adds.
	//
	// All four steps are needed together. Clearing knownCreatures alone would
	// still leave the static half skipped (the box still matches), and leaving
	// pendingUpdates alone would send removals describing a world that no
	// longer exists.
	void resetClientEntityCache()
	{
		pendingUpdates.clear();
		pendingIsLogin = true;
		knownCreatures.clear();
		invalidateStaticViewport();
	}

	private:
	std::string name;
	std::string guildNick;
public:
	int16_t clanId = -1;

	// Threat profile; see resetSurvivalTimer / provokeAgentType.
	int64_t survivalStart = 0;
	std::vector<std::string> provokedAgents;
	// Agent types whose repellent this player has broken, with the expiry of
	// each. A handful of entries at most, so a linear scan beats a hash node on
	// a lookup that runs per agent per nearby player per tick.
	struct BrokenRepel {
		std::string key;
		uint64_t until = 0;
	};
	std::vector<BrokenRepel> brokenRepels;
	bool isClanLeader = false;
	uint64_t lastClanActionTime = 0;
	uint64_t lastClanCreateTime = 0;
	uint64_t lastClanJoinRequestTime = 0;
	uint64_t lastClanDeleteTime = 0;
	uint64_t lastClanManageTime = 0;
	uint64_t lastClanLeaveTime = 0;
	Position lastSentTeamPosition;
	uint64_t lastSentTeamPositionTime = 0;

	// Players whose chat this one has blocked (ClientOpcode::BLOCK_PLAYER), for
	// this session. `guid` is who they are now, or BLOCKED_OFFLINE while a
	// verified account is away; `accountId` (0 for a guest) is what finds them
	// again under their next guid. A guest entry goes when the guest does:
	// their guid is a slot the next login may be given. See Game::playerBlock.
	static constexpr uint8_t BLOCKED_OFFLINE = 255;
	struct BlockedPlayer {
		uint8_t guid = BLOCKED_OFFLINE;
		uint32_t accountId = 0;
	};
	std::vector<BlockedPlayer> blockedPlayers;
	// ClientOpcode::SET_PRIVATE_MESSAGES, sent by the client at login and on change.
	PrivateMessagePolicy privateMessages = PrivateMessagePolicy::EVERYONE;
	bool hasBlocked(uint32_t guid) const
	{
		for (const BlockedPlayer& b : blockedPlayers) {
			if (b.guid == guid) return true;
		}
		return false;
	}
private:
	std::string token;
	uint64_t tokenId = 0;
	uint8_t adBlocker = 0;
	uint32_t accountId = 0;
	uint8_t groupId = 1;
	bool passwordAdmin = false;

	uint32_t score = 0;
	uint8_t karmaLevel = 0;
	uint32_t karmaKills = 0;
	uint32_t kills = 0;
	std::unordered_map<uint32_t, uint64_t> recentAttackers;
	uint32_t equipEventId = 0;
	uint16_t pendingEquipIID = 0;
	uint32_t pendingEquipUID = 0;
	uint32_t actionEventId = 0;
	uint32_t reloadEventId = 0;

	// A mod being fitted, swapped or removed; eventId 0 = none. Uids are full,
	// resolved from the wire bytes when the change starts.
	struct PendingModChange {
		uint32_t eventId = 0;
		uint32_t weaponUid = 0;
		uint32_t modUid = 0;
		ModSlot slot = ModSlot::Magazine;
		bool fit = false;
	};
	PendingModChange modChange;
	// See setAimHeld / updateAim. aimSince is when aiming last turned on (the
	// spread eases from it); aimMoveFactor is the equipped weapon's aimMove
	// while aiming and 1 otherwise, cached for getSpeed.
	bool aimHeld = false;
	bool aimActive = false;
	uint64_t aimSince = 0;
	float aimMoveFactor = 1.0f;
	PlayerView view;

	struct ModChangePlan {
		uint8_t gunSlot = 0;
		int8_t modSlot = -1;  // the incoming mod's inventory slot; -1 when removing
		int8_t freeSlot = -1; // removing: where the outgoing mod goes
		uint32_t durationMs = 0;
	};
	// Why the change cannot happen, or empty when it can. Run when it starts
	// and again when its timer fires, since anything may have moved meanwhile.
	std::string planModChange(uint32_t weaponUid, ModSlot slot, bool fit, uint32_t modUid, ModChangePlan& plan) const;

	uint64_t lastActionTime = 0;
	bool isClicking = false;
	bool lastIsAttacking = false;
	bool lastIsConsuming = false;
	uint16_t equippedWeaponIID = 0;
	uint32_t equippedWeaponUID = 0;
	uint16_t equippedWearableIID = 0;
	uint32_t equippedWearableUID = 0;

	uint32_t openedInteractionId = 0;
	uint8_t expectedClientContainerCloseCount = 0;
	uint64_t expectedClientContainerCloseUntil = 0;

	// Ghoul mode. Null for a human; see isGhoul(). ghoulMelee is a synthesised
	// EquipableData owned by this player, so getEquippedWeaponData can hand the
	// existing attack pipeline a ghoul's swing without a parallel code path.
	// Held by value rather than pointing into agents.xml because the shapes are
	// different: one is an <ability>, the other an <equipable>.
	const AgentData* ghoulData = nullptr;
	std::unique_ptr<EquipableData> ghoulMelee;
	// The equipped moddable gun's definition with its mods resolved; see
	// getEquippedWeaponData. Reused in place so the pointer it hands out stays
	// valid; rebuilt when the base, the mods or the loaded equipables change.
	mutable std::unique_ptr<EquipableData> resolvedWeapon;
	mutable const EquipableData* resolvedWeaponBase = nullptr;
	mutable uint32_t resolvedWeaponGeneration = 0;
	mutable WeaponMods resolvedWeaponMods;
	float ghoulDamageScale = 1.0f;
	uint64_t ghoulNextDaylightAt = 0;

	uint32_t experience = 0;
	uint32_t level = 0;
	uint32_t spentSkillPoints = 0;
	std::set<uint16_t> unlockedSkills;

	// Gauges
	uint8_t health = 255;
	float healthPartial = 0.0f;
	uint8_t stamina = 255;
	uint8_t hunger = 255;
	uint8_t cold = 255;
	uint8_t radiation = 0;

	bool shift = false;
	bool walkedLastTick = false;
	uint64_t lastStaminaUse = 0;
	float staminaPartial = 0.0f;
	float hungerPartial = 0.0f;
	float coldPartial = 0.0f;
	float radiationPartial = 0.0f;
	// Gauge push bookkeeping. See flushGaugeSync. Deliberately no timer here:
	// gauges are never resynced on a clock, only when something says the client
	// is wrong.
	// The five bytes GAUGE_VALUES last carried, packed, so a dirty flush that would
	// repeat itself costs nothing. Only ever written where a frame is actually
	// sent from the tick; a direct sendGauges() elsewhere can leave it stale,
	// which can only ever cost one redundant frame, never a missed one.
	uint64_t lastSentGauges = 0;
	bool gaugesDirty = false;
	bool gaugesForced = false;

	uint8_t healthNotificationLevel = 0;
	uint8_t hungerNotificationLevel = 0;
	uint8_t coldNotificationLevel = 0;
	uint8_t radiationNotificationLevel = 0;

	bool inRadiation = false;
	bool inWarmth = false;
	bool inFeeder = false;

	// The strongest radiation emitter reaching this player, cached from the area
	// scan so computeGaugeRates can fold it into the rate it sends. Meaningless
	// unless inRadiation; 1.0 is "an ordinary field".
	float radiationStrength = 1.0f;

	uint64_t lastHealthAura = 0;
	uint64_t lastDamageTime = 0;
	int32_t accumulatedTickDamage = 0;
	int32_t accumulatedTickHeal = 0;

	void applyHealthPartial(float lifeChange);

	// --- Gauge directions -------------------------------------------------
	//
	// Which way the server is running each of the five gauges this tick, packed
	// two bits per gauge in GaugeSlot order. Stated to the client outright
	// (ServerOpcode::GAUGE_DIRECTIONS) rather than left to be inferred.
	//
	// This is one field and one latch because the thing it describes is one
	// piece of state. It used to be three enums plus three area booleans, sent
	// as fifteen separate opcodes, and the client's cold direction had FOUR
	// writers -- two of which were wrong at the source (FEEDERON_WARM_OFF had no
	// day check; WARM_OFF read a `World.day` that lags the DAY opcode by the
	// fade). The server compensated by restating cold every single tick and by
	// hand-ordering the sends food-first-warmth-last, an ordering constraint
	// that was load-bearing in three places. None of that survives a field that
	// cannot be reordered against itself.
	//
	// Edge-triggered: recomputed every tick, sent only when it changes, so a
	// player standing still costs nothing.
	uint16_t lastSentGaugeDirections = 0;

	// Whether lastSentGaugeDirections describes something a live client was
	// actually told. The latch belongs to the CHARACTER, which outlives its
	// socket, so without this a reattaching session lands on a matching value,
	// sees no edge, and is never told at all.
	bool gaugeDirectionsKnown = false;

	uint16_t packGaugeDirections(GaugeDirection life, GaugeDirection food, GaugeDirection warmth,
		GaugeDirection stamina, GaugeDirection radiation) const;
	void flushGaugeDirections(uint16_t packed);

	GaugeRates computeGaugeRates(const LifeDrainProfile& drain) const;

	// --- Scenario region effects ------------------------------------------
	//
	// A scenario region adds a signed rate to a gauge (scenario_regions.h),
	// server-value sense, wire units, GaugeSlot order. All zero outside a
	// scenario region, and then every gauge runs its ordinary branch untouched.
	//
	// When a gauge has one, the region sets its direction: the ordinary
	// branch's rate still adds when it runs the same way and pauses when it runs
	// against it. The result is one direction and one rate, folded into the
	// rates message like everything else here, so the client integrates the
	// same integer the server does.
	std::array<int32_t, GAUGE_SLOT_COUNT> scenarioRates{};
	using ScenarioNets = std::array<std::optional<int32_t>, GAUGE_SLOT_COUNT>;
	ScenarioNets scenarioNets(const GaugeRates& legacy, const LifeDrainProfile& drain, uint64_t now) const;
	static void foldScenarioNets(GaugeRates& rates, const ScenarioNets& nets);
	// Stamina's ordinary branch, shared by updateStaminaGauge and scenarioNets.
	bool isRunningThisTick() const;
	GaugeRates lastSentGaugeRates{};
	bool gaugeRatesKnown = false; // same latch-vs-session rule as gaugeDirectionsKnown

	// updateGauges phases; each is the only writer of its value/partial pair.
	void pinGaugesToMax();
	void syncImmuneGauges(uint32_t elapsedMs);
	void flushGaugeSync();

	// Must stay byte-for-byte what ProtocolGame::sendGauges puts on the wire,
	// radiation inversion included, or the dedupe compares the wrong thing.
	uint64_t packGauges() const
	{
		return (static_cast<uint64_t>(health) << 32)
		     | (static_cast<uint64_t>(hunger) << 24)
		     | (static_cast<uint64_t>(cold) << 16)
		     | (static_cast<uint64_t>(stamina) << 8)
		     | static_cast<uint64_t>(getRadiationWireValue());
	}
	// A wearable's resistance, rounded into the same /10000 integer domain the
	// rate packet uses -- rounded here and nowhere else, so the value the client
	// was told and the value the server integrates are the same number.
	int32_t resistanceRate(std::string_view modifierKey) const;

	// Each of these returns the direction the client should be running that
	// gauge in, derived from the same branch the server just integrated -- so
	// the two cannot disagree about which way a bar is going.
	GaugeDirection updateStaminaGauge(uint32_t elapsedMs, const GaugeMode& sMode, uint64_t now);
	GaugeDirection updateHungerGauge(uint32_t elapsedMs, const GaugeMode& fMode);
	GaugeDirection updateColdGauge(uint32_t elapsedMs, const GaugeMode& cMode);
	GaugeDirection updateRadiationGauge(uint32_t elapsedMs, const GaugeMode& rMode, bool inRadiationArea);

	// Which gauges are dragging life down, from the values as they stand at the
	// START of the tick. Read the LifeDrainProfile comment for why it is
	// resolved once and passed around rather than derived twice.
	LifeDrainProfile lifeDrainProfile() const;
	float computeLifeChange(uint32_t elapsedMs, const GaugeMode& lMode, const LifeDrainProfile& drain,
		uint64_t now) const;

	int64_t lastPing = 0;
	int64_t lastPong = 0;
	uint64_t lastInteractionTime = 0;

	time_t lastLoginSaved = 0;
	time_t lastLogout = 0;
	time_t premiumEndsAt = 0;

	ProtocolGame_ptr client;
	Connection::Address lastIP = {};

	uint32_t inventoryWeight = 0;
	uint32_t capacity = 8;
	uint32_t messageBufferTicks = 0;
	uint32_t guid = 0;
	uint32_t editListId = 0;

	float recoilX = 0.0f;
	float recoilY = 0.0f;
	// When a damaging trap last shook this player's screen (Object::executeTrigger).
	uint64_t lastTrapShakeMs = 0;
	// What is left of this window's knockback allowance. See applyKnockback.
	KnockbackBudget knockback;

	int32_t MessageBufferCount = 0;
	uint64_t lastActivityAt = static_cast<uint64_t>(OTSYS_TIME());
	int64_t nextPlaceAt = 0; // build cooldown; see canPlaceObjectNow
	// When this character joined. Survives respawn (survivalStart does not),
	// which is what makes "kick the newest" mean what it says.
	uint64_t sessionStart = static_cast<uint64_t>(OTSYS_TIME());
	uint16_t maxWriteLen = 0;
	uint8_t levelPercent = 0;
	bool isConnecting = false;
	bool m_ghostMode = false;
	bool m_ghostVisible = false;
	bool m_invincible = false;

	// --- Wearable speed cache -------------------------------------------------
	//
	// getSpeed() is asked once per OBSERVER per entity by the visibility diff --
	// roughly 62,500 times a tick at 250 clients -- and the armour's speed
	// penalty costs an item lookup, a string-keyed hash into EquipmentManager and
	// a string compare per effect on the result to derive. Deriving it per call
	// is the same mistake `scaledResistance` was already fixed for, one function
	// over.
	//
	// Only the WEARABLE needs a flag here. The condition fold has its own cache
	// inside ConditionSet, invalidated by the set's own mutators, so it cannot be
	// forgotten -- which is strictly better and is why the two are not merged.
	mutable float cachedWearableSpeed = 0.0f;
	mutable bool wearableCacheDirty = true;

	// Snapshot of lifeGeneration taken when a tick batch starts applying, so
	// conditionTicksShouldContinue can tell "this life ended mid-batch" from
	// "this character has been resurrected at some point in the past".
	uint32_t tickLifeGeneration = 0;

	// Bumped every time a resurrection starts a new life. Nothing reads the
	// value, only whether it CHANGED across a call that could have ended the
	// life -- which is the one question a caller holding state about the old
	// life needs answered, and which health alone cannot answer (a resurrection
	// puts health straight back above zero, so a before/after health test sees
	// a life end as an ordinary heal). See Player::updateConditions.
	uint32_t lifeGeneration = 0;

	// The last ConditionVisual put on the wire, and whether anything has been put
	// there at all. `conditionVisualKnown` is false for a fresh character, which is
	// what makes the first statement unconditional -- an == against a
	// default-constructed ConditionVisual would swallow it, since "nothing active"
	// is also the resting value.
	ConditionVisual lastSentConditionVisual;
	bool conditionVisualKnown = false;
	uint32_t conditionVisualRestateMs = 0;

	// Whether this client has been told its poison screen is running. See
	// syncPoisonScreen.
	bool poisonScreenSent = false;

	// Survives the effect that caused it; cleared by a cure. See
	// ConditionVisual::withdrawn.
	bool drugWithdrawn = false;

	static uint32_t playerAutoID;
	static uint32_t playerIDLimit;

	friend class Game;
	friend class ProtocolGame;
};

#endif // FS_PLAYER_H
