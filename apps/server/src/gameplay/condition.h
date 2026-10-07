// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#pragma once

#include "core/definitions.h" // rollChance, shared with ItemDrop
#include "network/opcodes.h"     // GaugeSlot, GAUGE_SLOT_COUNT
#include <string>
#include <vector>
#include <array>
#include <unordered_map>
#include <cstdint>
#include <cmath>
#include <algorithm>

// What a stage FORBIDS while it runs, OR-folded across the active set.
//
// A stun is not a speed of zero and cannot be written as one: Player::getSpeed
// floors at PLAYER_MIN_SPEED and Creature::getSpeed at 10, so the most a speed
// multiplier can do is a crawl -- and a stun has to stop ATTACKS too, which
// speed cannot express at all. These are separate bits rather than one "stunned"
// flag so a condition can take exactly what it means to take: a leg wound that
// stops running but not shooting, a gas that stops building but not walking.
enum ConditionControl : uint8_t {
    CONTROL_NONE      = 0,
    CONTROL_NO_MOVE   = 1 << 0, // cannot walk under their own power (paralyse)
    CONTROL_NO_RUN    = 1 << 1, // can walk, cannot sprint (leg wound, heavy load)
    CONTROL_NO_ATTACK = 1 << 2, // cannot swing or fire (stun, disarm)
    CONTROL_NO_USE    = 1 << 3, // cannot eat, drink, craft or open (nausea)
    CONTROL_NO_BUILD  = 1 << 4, // cannot place objects (suppression)
    // Cannot even turn to face somewhere. Separate from NO_MOVE on purpose: a
    // paralysed player is rooted but still a threat -- they can turn and shoot
    // -- whereas a stunned one has lost the plot entirely. Tying the two
    // together would make every root a full disable.
    CONTROL_NO_TURN   = 1 << 5,
};

// EVERY control bit forbids something the creature does OF ITS OWN ACCORD. None
// of them stops the world acting on it: a stunned player still takes damage,
// still burns, still takes conditions, and -- the one that is easy to get wrong
// -- is still KNOCKED BACK. Being shoved is done TO you. See
// Game::updateMovement, where the gate sits on the move mask and recoil is
// applied past it.

// One gauge's damage/healing over time. Indexed by GaugeSlot so every gauge gets
// one for free and the five cannot drift apart: <healthTick> is LIFE's, and
// <foodTick>, <staminaTick>, <warmthTick> and <radiationTick> are the others.
// A parasite that eats your food, a stim that burns stamina, and a hot spring
// that keeps you warm are all the same mechanism.
struct ConditionGaugeTick {
    int16_t amount = 0;      // negative drains, positive restores
    uint32_t intervalMs = 0; // 0 = no tick on this gauge

    bool active() const { return amount != 0 && intervalMs != 0; }
};

// A fraction of the damage dealt, returned to the attacker.
//
// Fractions rather than flat amounts so one spelling scales across every weapon
// -- 10% of a knife and 10% of a sniper round are both "10%" -- and a per-hit
// ceiling because a multi-pellet weapon applies this once per PELLET: a 5-pellet
// shotgun at 15% is otherwise a full heal per trigger pull.
struct LeechSpec {
    float life = 0.0f;
    float stamina = 0.0f;
    // Ceiling on ONE hit's return, in gauge points. The loader fills this in
    // with LEECH_DEFAULT_MAX_PER_HIT and says so when a source omits it.
    uint16_t maxPerHit = 0;

    bool empty() const { return life <= 0.0f && stamina <= 0.0f; }
};

// What one hit may return when a source declares <leech> without a maxPerHit.
// A quarter of a full gauge: generous enough that a single-shot weapon feels
// vampiric, small enough that a five-pellet shotgun cannot heal a whole bar in
// one trigger pull.
static constexpr uint16_t LEECH_DEFAULT_MAX_PER_HIT = 64;

// A multiplier scaled by a source's strength dial.
//
// Scaled by its DEVIATION FROM 1, never by the number itself: a x0.55 slow at
// strength 2 must become x0.10 (twice as slow), and multiplying the 0.55 would
// give x1.10 -- turning a doubled slow into a speed boost. Floored at 0 because
// a negative multiplier has no meaning for anything that uses one.
inline float scaleMultiplier(float multiplier, float strength)
{
    if (strength == 1.0f) return multiplier;
    return std::max(0.0f, 1.0f - (1.0f - multiplier) * strength);
}

struct ConditionModifiers {
    float speedMultiplier = 1.0f;
    int32_t speedAdd = 0;

    // There is no maxHealth modifier, and there cannot be one while life is a
    // gauge. <maxHealth add="50"/> was parsed here for a long time and read by
    // nothing: the gauge is a uint8_t whose ceiling modes.xml already sets to
    // 255, so there is no headroom for a bonus to occupy. Expressing one means
    // lowering the base life of every player in modes.xml first, which is a
    // balance decision and not this struct's to make.
    float healthRegenMultiplier = 1.0f;
    float staminaRegenMultiplier = 1.0f;
    float staminaDrainMultiplier = 1.0f;

    // Indexed by GaugeSlot. <healthTick> is gaugeTicks[LIFE] and keeps its old
    // spelling; the other four are new.
    std::array<ConditionGaugeTick, GAUGE_SLOT_COUNT> gaugeTicks;

    // Combat scaling. Both are multipliers on damage this creature is party to:
    // `dealt` for damage it inflicts (weakness, rage), `taken` for damage it
    // receives (vulnerability, fortify). Clamped at load -- they are the easiest
    // knobs here to make a degenerate item with.
    float damageDealtMultiplier = 1.0f;
    float damageTakenMultiplier = 1.0f;

    // Added to the wielder's crit chance, so a stim can make you crit with a
    // weapon that has no crit of its own.
    float critChanceAdd = 0.0f;

    // A fraction of incoming knockback impulse removed. Distinct from the
    // KnockbackBudget, which is a shared per-window cap: this is one creature
    // being heavier than another.
    float knockbackResist = 0.0f;

    // Leech granted by the CONDITION rather than by the weapon, added on top of
    // whatever the weapon itself does. A vampirism buff.
    LeechSpec leech;

    uint8_t controlMask = CONTROL_NONE;

    // <resist conditions="toxic_poison,stun" fraction="0.5" all="0.2"/>
    //
    // Protection FROM other conditions, which is what makes a hazmat suit's
    // effect expressible as a condition rather than as a special case. Named
    // keys and a blanket fraction are separate because "immune to poison" and
    // "everything lasts 20% less" are different statements and an item may want
    // both. Not folded into ConditionTotals: it is asked once when a condition
    // is applied, never on a hot path, so walking the active set is free.
    std::vector<std::string> resistKeys;
    float resistKeyFraction = 0.0f;
    float resistAllFraction = 0.0f;
};

// Every modifier of every active effect on one creature, folded into one value
// each.
//
// One pass, not five. getSpeed ran its own loop over the active set and each of
// the four gauge modifiers had a getter that ran another -- every one of them
// doing a string hash per active effect -- and getSpeed is called per player per
// movement step. It also means a caller cannot accidentally consume three of the
// four and silently drop the fourth, which is how the regen modifiers came to be
// parsed, stored and never read by anything at all.
struct ConditionTotals {
    float speedMultiplier = 1.0f;
    int32_t speedAdd = 0;
    float healthRegenMultiplier = 1.0f;
    float staminaRegenMultiplier = 1.0f;
    float staminaDrainMultiplier = 1.0f;

    float damageDealtMultiplier = 1.0f;
    float damageTakenMultiplier = 1.0f;
    float critChanceAdd = 0.0f;
    // Folded as a PRODUCT of what each stage lets through, so two 50% resists
    // leave 25% rather than reaching immunity. Every fraction here composes that
    // way, for the same reason: stacking sources must approach immunity and
    // never arrive at it by addition.
    float knockbackLetThrough = 1.0f;
    float leechLife = 0.0f;
    float leechStamina = 0.0f;

    uint8_t controlMask = CONTROL_NONE;

    // `strength` is the source's severity dial (ConditionApplication::strength).
    // Every MAGNITUDE here scales by it; every SWITCH ignores it. That split is
    // the whole rule: "how much" is a number a weapon may tune, "whether" is a
    // property of the condition itself, so a strength of 0.4 must not turn a
    // stun into a partial stun.
    void accumulate(const ConditionModifiers& mod, float strength = 1.0f)
    {
        speedMultiplier *= scaleMultiplier(mod.speedMultiplier, strength);
        speedAdd += static_cast<int32_t>(std::lround(mod.speedAdd * strength));
        healthRegenMultiplier *= scaleMultiplier(mod.healthRegenMultiplier, strength);
        staminaRegenMultiplier *= scaleMultiplier(mod.staminaRegenMultiplier, strength);
        staminaDrainMultiplier *= scaleMultiplier(mod.staminaDrainMultiplier, strength);
        damageDealtMultiplier *= scaleMultiplier(mod.damageDealtMultiplier, strength);
        damageTakenMultiplier *= scaleMultiplier(mod.damageTakenMultiplier, strength);
        critChanceAdd += mod.critChanceAdd * strength;
        knockbackLetThrough *= (1.0f - std::clamp(mod.knockbackResist * strength, 0.0f, 1.0f));
        leechLife += mod.leech.life * strength;
        leechStamina += mod.leech.stamina * strength;
        // NOT scaled: a control bit is a yes/no, and half a stun is not a thing.
        controlMask |= mod.controlMask;
    }

    bool forbids(ConditionControl what) const { return (controlMask & what) != 0; }
};

enum class DrugTimerType {
    NONE = 0,
    REPELLENT = 1, // Opcode 68 -> day-skin1 (Ghoul drug)
    WITHDRAWAL = 2 // Opcode 69 -> day-skin2 (Lapadone)
};

// What a stage LEAVES BEHIND when its duration runs out, from
// <visuals endSkin="N"/>. Distinct from `skin`, which is what the stage looks
// like while it is still running.
//
// Only two end states exist and that is a protocol fact, not an omission: the
// other skins need a LIVE timer to be drawn at all (client.js picks its skin
// from whether PLAYER.repellent / PLAYER.withdrawal are in the future), so
// "leave the repellent look behind" is unrepresentable. What can be left behind
// is the post-lapadone marker, which is exactly the state of having a non-zero
// withdrawal timestamp that has already passed.
//
// Unchanged is the default, and it has to be a third state rather than a bool
// defaulting to Normal: if every expiring stage cleared the marker, a poison
// wearing off would wipe one that lapadone had set.
enum class StageEndSkin : uint8_t {
    Unchanged = 0, // endSkin absent: leave whatever mark is already there
    Normal,        // endSkin="0": back to the plain skin
    Withdrawn,     // endSkin="4": the used-lapadone look, until something cures it
};

// How often a live drug skin is re-stated to everyone who can see the wearer.
//
// Not a nicety -- the wire carries the remaining time in ONE BYTE, and the two
// channels scale it differently (repellent x2000 ms, withdrawal x1000 ms), so a
// repellent can say at most 510 seconds while ghoul_drug_effect runs for 600.
// A long effect therefore CANNOT be stated once and left; the client's timer
// would lapse 90 seconds early while the server was still repelling. The
// re-state also covers the two cases a one-shot send cannot: an observer who
// was not watching when the drug was taken, and a frame the network dropped.
static constexpr uint32_t CONDITION_VISUAL_RESTATE_MS = 10000;

// Everything about this player that the CLIENT draws because of an active
// effect, derived from the whole active set in one pass.
//
// The point of deriving it whole is that no single effect can then disturb
// another's appearance. The old code sent a visual per stage transition and a
// bare "reset" whenever ANY effect ended, so a poison wearing off wiped a live
// ghoul-drug skin off every screen while the repel itself kept working -- the
// look and the behaviour disagreed until the next heartbeat. A statement of the
// whole truth cannot do that.
struct ConditionVisual {
    uint32_t repellentMs = 0;  // opcode 68 while non-zero
    uint32_t withdrawalMs = 0; // opcode 69 while non-zero

    // Lapadone has run its course and has not been cured since. Deliberately
    // NOT derived from the active set -- it outlives the effect, which is the
    // whole point of it: client.js draws a distinct "used lapadone" skin
    // (skinType 4, or 5 under a repellent) for a player whose withdrawal timer
    // has expired but is non-zero, and the antidote's own description is
    // "remove the withdrawal effects (pink skin)". Sent as the second byte of
    // RESET_DRUG, which is the only thing that reads it.
    bool withdrawn = false;

    // Which channels are being drawn, ignoring how much time is left on them.
    // That is the only thing a change has to be reported for: the countdown is
    // the client's own job, so comparing the durations would fire an edge every
    // single tick. A dose that refreshes an already-live channel changes no
    // shape either, which is why applying an effect forces a statement outright
    // rather than relying on this.
    bool sameShapeAs(const ConditionVisual& other) const
    {
        return (repellentMs != 0) == (other.repellentMs != 0) &&
               (withdrawalMs != 0) == (other.withdrawalMs != 0) &&
               withdrawn == other.withdrawn;
    }

    bool isClean() const { return repellentMs == 0 && withdrawalMs == 0 && !withdrawn; }
};

struct ConditionVisuals {
    DrugTimerType timerType = DrugTimerType::NONE;
    // What this stage leaves on the player once it expires. Used to be a
    // hardcoded "a withdrawal stage always leaves the marker" branch in
    // Player::updateConditions, which made "go back to the normal skin when the
    // withdrawal ends" unsayable.
    StageEndSkin endSkin = StageEndSkin::Unchanged;
    bool poisonScreenEffect = false;
};

// Which agents stop seeing the wearer at all, from <repel families= keys=/>.
//
// A repellent is a property of the PERSON, not of the monster, so this is the
// natural home for it: the ghoul drug is one <repel families="ghoul"/> and
// nothing in agents.xml has to know the drug exists. Matching by FAMILY is what
// makes "ghouls ignore you but robots do not" a one-word statement -- every
// ghoul in agents.xml carries family="ghoul" and every bot family="bot" -- and
// `keys` is there for a repellent aimed at one specific agent type.
//
// Empty (the normal case) means the stage repels nothing, and the check for it
// is one bool test on the hot path.
struct ConditionRepel {
    std::vector<std::string> families;
    std::vector<std::string> keys;

    bool empty() const { return families.empty() && keys.empty(); }
    bool matches(const std::string& family, const std::string& key) const;
};

struct ConditionStage {
    std::string key;
    uint32_t durationMs = 0;
    std::string nextStage;

    ConditionModifiers modifiers;
    ConditionVisuals visuals;
    ConditionRepel repel;
};

// A condition something INFLICTS, and how often. Shared by every source that is
// not an item being eaten: <onHit> in projectiles.xml and equipables.xml,
// <ability> in agents.xml.
//
// One shape and one parser, for the same reason ItemDrop is one shape across
// four files -- two spellings of "apply a condition on a chance roll" would
// drift, and the second one written would forget the roll convention.
//
// The key stays a STRING rather than resolving to a ConditionData* at load, and
// that is forced: conditions.xml loads AFTER projectiles.xml and agents.xml
// (see content.xml), so the table does not exist yet when these are parsed.
// validateDataReferences in prevast_server.cpp is what checks them, once
// everything is loaded.
struct ConditionApplication {
    std::string key;
    float chance = 1.0f;

    // Added to `chance` per point of damage the hit actually dealt, so a big hit
    // is likelier to stun than a graze. 0 (the default) makes the chance flat,
    // which is what every existing entry means.
    float chancePerDamage = 0.0f;

    // How HARD this source's dose hits, as a multiple of what conditions.xml
    // states. 1.0 (the default) is exactly the condition as written; 2.0 is
    // twice the effect; 0.4 is a fraction of it.
    //
    // Duration alone was not enough control: "a barrel staggers you badly, a
    // grenade barely at all" is a statement about HOW MUCH, not about how long,
    // and without this every source pointing at `slowed` had to share its
    // severity -- or the file needed slowed_light / slowed_heavy / slowed_c4,
    // which is the near-duplicate-per-source problem durationMs already solved.
    //
    // Scales every MAGNITUDE in the stage and no SWITCH: speeds, ticks, damage
    // multipliers, leech, crit chance and resistances all move; the control
    // mask, the drug skin and the repel list do not. See
    // ConditionTotals::accumulate.
    float strength = 1.0f;

    // How long THIS source's dose lasts, overriding the condition's own first
    // stage. 0 (the default) means "whatever conditions.xml says".
    //
    // Here rather than only in conditions.xml because the duration is often a
    // property of the WEAPON, not of the effect: a hatchet and a sledgehammer
    // both inflict `stun`, and the whole difference between them is how long it
    // lasts. Without this every weapon pointing at one condition would be forced
    // to share its timing, or the file would need a near-duplicate condition per
    // weapon.
    //
    // Applies to the FIRST stage only. A multi-stage condition keeps its own
    // timings after that -- the stages after the first are the effect's own
    // shape (lapadone's boost handing off to withdrawal), not the dose's.
    uint32_t durationMs = 0;

    bool empty() const { return key.empty(); }

    // The shared roller in definitions.h, which ItemDrop uses too. It used to be
    // a second copy of the same three lines and carried the same off-by-one:
    // chance="0" fired once in a thousand.
    bool roll() const { return rollChance(chance); }

    // The damage-scaled form. Takes the amount that ACTUALLY landed, so armour
    // reduces the chance of being stunned as well as the damage.
    bool roll(int32_t damageDealt) const
    {
        if (chancePerDamage <= 0.0f) return rollChance(chance);
        const float scaled = chance +
            chancePerDamage * static_cast<float>(damageDealt < 0 ? -damageDealt : damageDealt);
        return rollChance(scaled);
    }
};

// A critical hit: a chance to multiply the swing, optionally with a condition of
// its own so a crit can mean "and now they are bleeding".
//
// The multiplier is applied to the OUTGOING damage, before resistance, so armour
// still counts against a crit. Leech then reads what actually landed. That order
// is the only one where both stats behave the way a player expects.
struct CritSpec {
    float chance = 0.0f;
    float multiplier = 2.0f;
    ConditionApplication onCrit;

    bool empty() const { return chance <= 0.0f; }
};

// Everything a damage source does BEYOND the raw damage: what it inflicts, what
// it gives back, and when it multiplies.
//
// One shape on a weapon, a round and a bite. The three damage paths each
// hand-rolled their own post-damage work before this and had already drifted --
// only two of the three applied conditions at all, and none of them scaled by
// damage. See Game::applyHitEffects, which is the only consumer.
struct HitEffects {
    ConditionApplication onHit;
    LeechSpec leech;
    CritSpec crit;

    bool empty() const { return onHit.empty() && leech.empty() && crit.empty(); }
};

// <stacking mode=> interned, same reasoning as the other interned XML enums:
// this is compared on every dose, and a free-form string silently accepted any
// spelling. It was a std::string tested against "refresh", so `mode="Refresh"`
// or a typo meant Ignore without a word of warning.
enum class ConditionStacking : uint8_t {
    // A second dose restarts the effect from its first stage. The default, and
    // what every shipped effect asks for.
    Refresh,
    // A second dose adds its first stage's duration to what is left, keeping
    // the current stage. For something you top up rather than re-take.
    Extend,
    // A second dose does nothing at all while the first is running.
    Ignore,
};

struct ConditionData {
    std::string key;
    // The human label, used wherever this effect is named to a person: the
    // load-time warnings below and the !effects admin inspector. Nothing on the
    // wire carries it -- the client has no notion of a named effect -- which is
    // why it went unread for so long.
    std::string name;
    // Cleared when a life ends. Only a RESURRECTION can observe this: an
    // ordinary death removes the character outright, so there is nothing left
    // to carry an effect. See Player::applyResurrection.
    bool removeOnDeath = true;
    ConditionStacking stacking = ConditionStacking::Refresh;

    // <condition tags="poison,disease">: what this condition IS, so a cure can
    // name a kind rather than enumerate keys. `cureCondition tags="poison"`
    // survives someone adding a sixth poison; `keys="a,b,c,d,e"` does not, and
    // has already rotted once -- lapadoine_effect was renamed to
    // lapadone_effect and the antidote silently stopped curing it.
    std::vector<std::string> tags;
    bool hasTag(const std::string& tag) const;

    std::vector<ConditionStage> stages;

    const ConditionStage* getStage(const std::string& stageKey) const;
    size_t getStageIndex(const std::string& stageKey) const;

    // Does ANY stage of this effect ask for that skin? Asked about an effect
    // that may already have ended, which is why it is a property of the data
    // rather than of the active record: see Player::removeConditions.
    bool hasStageVisual(DrugTimerType timerType) const;
};

// One effect running on one creature.
//
// The effect is held as a POINTER, resolved once when it is applied. It used to
// be a std::string key that every reader hashed back through the manager --
// inside Player::getSpeed, which runs per player per movement step, and
// Player::repelsAgent, which runs per agent per nearby player per tick. The key
// is still reachable through data->key for the paths that need to name it.
//
// THIS IS WHY conditions.xml IS NOT HOT-RELOADABLE in place: loadFromXml clears
// the effect map, so a reload would dangle every one of these. ConditionSet::keys
// and ConditionSet::rebind are what make a reload survivable, and they work
// precisely because the key is still there to re-bind from.
struct ActiveCondition {
    const ConditionData* data = nullptr;
    // Always a valid index into data->stages; the loader rejects an effect with
    // more stages than this can address, so no reader needs a bounds test.
    uint8_t stageIndex = 0;
    uint32_t remainingDurationMs = 0;
    // One timer per gauge, so a condition that drains life and food on different
    // cadences keeps them independent.
    std::array<uint32_t, GAUGE_SLOT_COUNT> tickTimers{};

    // Who inflicted this, as a player GUID; 0 for the environment, an agent, or
    // something the wearer did to themselves. A GUID rather than a Player* on
    // purpose: an effect outlives its applier -- they can log out or die while
    // their poison is still running -- and a stale pointer would be read on the
    // tick that kills the victim, which is the worst possible moment.
    //
    // Without this a damage-over-time kill credited nobody (no XP, no score, no
    // attacker registered) AND bypassed PvP entirely: changeHealth's
    // canHarmPlayer gate treats a null attacker as environment damage, so on a
    // no-PvP world you could not shoot someone but you could poison them to
    // death. Naming the inflictor closes both.
    uint32_t inflictorGuid = 0;

    // The severity this dose was applied at, from the source's
    // ConditionApplication::strength. 1.0 is the condition exactly as
    // conditions.xml writes it. Carried per ACTIVE record rather than looked up,
    // because two sources of the same condition differ only in this.
    float strength = 1.0f;

    const ConditionStage& stage() const { return data->stages[stageIndex]; }

    // A gauge tick's amount at this dose's severity. Rounded away from zero so a
    // weak dose of a real poison still bites -- rounding 0.4 down to 0 would
    // make a low-strength DoT silently inert.
    int16_t scaledTick(int16_t amount) const
    {
        if (strength == 1.0f || amount == 0) return amount;
        const float scaled = static_cast<float>(amount) * strength;
        const int32_t rounded = static_cast<int32_t>(std::lround(scaled));
        if (rounded == 0) return amount < 0 ? -1 : 1;
        return static_cast<int16_t>(std::clamp(rounded, -32768, 32767));
    }
};

// The set of conditions running on one creature, and everything that can be
// asked of it.
//
// Lives on Creature rather than on Player, which is the whole point: an agent
// that cannot be poisoned makes a poison weapon useless against the things the
// world is actually full of. What differs between a player and an agent is not
// the bookkeeping -- it is what a tick DOES, which is why update() collects
// ticks and applies none of them.
//
// The fold cache is INSIDE the set and every mutation goes through a method
// here, so it cannot be forgotten. That is strictly better than the owner
// holding a dirty flag it has to remember to set.
class ConditionSet {
public:
    // One gauge tick this creature owes, collected during update().
    struct Tick {
        GaugeSlot slot;
        int16_t amount;
        uint32_t inflictorGuid;
    };

    // What one update() did, for an owner that has to react to it.
    struct UpdateResult {
        // The set's membership or any stage changed: re-derive anything cached
        // off it (the owner's own caches, the client-facing visuals).
        bool changed = false;
        // Gauge deltas owed, in order. Applied by the OWNER after update()
        // returns, never inside the walk: a lethal one can resurrect the
        // creature, and a resurrection rewrites this very container.
        std::vector<Tick> ticks;
        // The last non-Unchanged endSkin among the stages that expired this
        // tick. Last wins, which is exactly what the old per-stage switch did
        // when several expired together.
        StageEndSkin endSkin = StageEndSkin::Unchanged;
    };

    // `resistance` is a 0..1 fraction that SHRINKS THE DURATION, and >= 1 blocks
    // the condition outright. Duration rather than a chance to block, so an
    // armour stat reads the same way every time it is applied instead of being
    // a lottery -- "50% poison resistance" means "poison lasts half as long".
    //
    // `durationOverrideMs` replaces the first stage's own duration (0 = keep
    // it), for a source that wants its own timing. Resistance applies AFTER the
    // override, so armour shortens a long stun and a short one alike.
    //
    // `strength` is the source's severity dial, stored on the active record and
    // applied to every magnitude the stage carries. It is deliberately NOT
    // reduced by resistance: resistance already shortens the duration, and
    // taking the magnitude as well would apply the same protection twice.
    bool add(const ConditionData* data, uint32_t inflictorGuid, float resistance = 0.0f,
             uint32_t durationOverrideMs = 0, float strength = 1.0f);

    // Cures by key or by tag; "all" is the cure-everything sentinel. Returns
    // whether anything was actually removed.
    bool remove(const std::vector<std::string>& keysOrTags);

    // The removeOnDeath sweep, for a resurrection.
    bool removeOnDeath();

    void update(uint32_t elapsedMs, UpdateResult& out);

    const ConditionTotals& totals() const
    {
        if (totalsDirty) refresh();
        return cachedTotals;
    }

    // This creature's protection from a NAMED condition, as a 0..1 fraction,
    // from whatever it already has running. Walked rather than folded: it is
    // asked once per application, never on a hot path, and folding it would
    // need a map.
    float resistanceTo(const std::string& key) const;

    bool repels(const std::string& family, const std::string& agentKey) const;

    // Is any stage asking for the poison screen / a drug skin, and for how much
    // longer? Longest remaining wins: the client keeps ONE timer per channel, so
    // the longest is the only answer that cannot end a skin while something is
    // still asking for it.
    uint32_t longestRemainingWith(DrugTimerType timerType) const;
    uint32_t longestRemainingPoisonScreen() const;

    bool empty() const { return conditions.empty(); }
    size_t size() const { return conditions.size(); }
    const std::vector<ActiveCondition>& active() const { return conditions; }

    // --- Surviving a conditions.xml hot reload -------------------------------
    //
    // Every ActiveCondition points into ConditionManager's table, which a reload
    // replaces wholesale. The keys therefore have to be read BEFORE the swap,
    // while those pointers are still good, and handed back afterwards. The
    // timers are plain values and survive on their own; only `data` dangles.
    std::vector<std::string> keys() const;
    // `keys` pairs with the active set by index. Anything the new file no longer
    // defines is dropped, and a stage index the new file made unreachable falls
    // back to the first stage.
    void rebind(const std::vector<std::string>& keys);
    void clear()
    {
        conditions.clear();
        totalsDirty = true;
    }

private:
    void refresh() const;

    std::vector<ActiveCondition> conditions;
    mutable ConditionTotals cachedTotals;
    mutable bool totalsDirty = true;
};

class ConditionManager {
public:
    static ConditionManager& getInstance();

    bool loadFromXml(const std::string& filename);

    // Re-read the file into a STAGING table and swap only if it parsed, so a
    // typo cannot empty the game's condition set. Returns false with the live
    // table untouched otherwise.
    //
    // Every ActiveCondition holds a pointer into the table this replaces, so a
    // caller MUST re-bind them: capture each creature's keys with
    // ConditionSet::keys() BEFORE calling this, then hand them back to
    // ConditionSet::rebind() after. Game::adminReloadXml is the one caller
    // and does exactly that.
    bool reloadFromXml(const std::string& filename);

    const ConditionData* getEffectData(const std::string& key) const;

    // Warn about any <repel> naming an agent family or key that agents.xml does
    // not define. Separate from loadFromXml because status effects load before
    // agents do, and a repellent against a family that no longer exists is
    // exactly the failure this catches: it costs nothing, breaks nothing, and
    // silently protects the player from nobody.
    void validateRepelTargets(const std::string& filename) const;

    // Does any loaded condition carry this tag? A <cureCondition tags="..."> that
    // matches nothing cures nothing, which is worth a startup warning for the
    // same reason a bad key is.
    bool hasTag(const std::string& tag) const;

    // Every loaded effect, for the !effects admin inspector. Sorted by key so
    // two runs print the same order -- the map's own order is a hash order and
    // would shuffle between boots.
    std::vector<const ConditionData*> allEffects() const;

private:
    // Node-based on purpose: ActiveCondition holds a pointer to an element, and
    // a rehash must not move it. See the note there.
    using ConditionTable = std::unordered_map<std::string, ConditionData>;

    // The parser, writing into whichever table the caller nominates. Everything
    // that reports a data warning happens in here, so a failed reload still
    // tells the admin what is wrong with the file.
    bool parseInto(ConditionTable& out, const std::string& filename) const;

    ConditionTable effects;
};
