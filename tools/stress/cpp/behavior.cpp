// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "behavior.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace bot {

namespace {

// All eight directional bit combos that represent actual movement.
constexpr std::array<int, 8> MOVE_CHOICES = {
	proto::MOVE_LEFT, proto::MOVE_RIGHT, proto::MOVE_UP, proto::MOVE_DOWN,
	proto::MOVE_LEFT | proto::MOVE_UP, proto::MOVE_LEFT | proto::MOVE_DOWN,
	proto::MOVE_RIGHT | proto::MOVE_UP, proto::MOVE_RIGHT | proto::MOVE_DOWN,
};

int randInt(std::mt19937& rng, int lo, int hi)
{
	return lo + static_cast<int>(rng() % static_cast<uint32_t>(hi - lo + 1));
}

double randDouble(std::mt19937& rng)
{
	return static_cast<double>(rng() % 1000000u) / 1000000.0;
}

// Direction mask pointing from (x,y) toward (tx,ty). Diagonals are included so
// a bot steering home moves at the same speed as one walking freely.
int maskToward(int32_t x, int32_t y, int32_t tx, int32_t ty)
{
	// A deadband, so a bot sitting almost exactly on the target does not
	// oscillate between two opposite masks every tick and stand still.
	constexpr int32_t DEADBAND = 40;
	int mask = 0;
	if (tx - x > DEADBAND) mask |= proto::MOVE_RIGHT;
	else if (x - tx > DEADBAND) mask |= proto::MOVE_LEFT;
	// Server y grows downward for MOVE_DOWN (mask bit 4 is dy += 1 in
	// Game::updateMovement), so "toward a larger y" is MOVE_DOWN.
	if (ty - y > DEADBAND) mask |= proto::MOVE_DOWN;
	else if (y - ty > DEADBAND) mask |= proto::MOVE_UP;
	return mask;
}

class IdleBehavior : public Behavior {
public:
	void onSpawn(Bot& b) override { b.setRotation(randInt(b.rng(), 0, 359)); }
};

// The movement/visibility benchmark: every player dirty every tick, and a bot
// that fails to cover ground picks a genuinely new direction rather than the
// opposite one (which stays wedged in a concave corner).
class BenchBehavior : public Behavior {
public:
	explicit BenchBehavior(int index) : m_dirIndex(index % MOVE_CHOICES.size()) {}

	void onSpawn(Bot& b) override
	{
		m_aim = randInt(b.rng(), 0, 359);
		b.setRotation(m_aim);
		b.setShift(false);
		b.setMove(MOVE_CHOICES[m_dirIndex]);
		m_hold = HOLD_TICKS;
		armStallCheck(b);
	}

	void onTick(Bot& b) override
	{
		if (!b.alive()) return;

		// Unconditional, every tick: keeps this player dirty so the server has
		// to rebroadcast it to every spectator. Rotation is rescaled to a uint8
		// server-side (360deg -> 256 steps), so the step must be big enough to
		// land on a different stored value every tick; 7deg is ~5 steps.
		m_aim = (m_aim + AIM_STEP) % 360;
		b.setRotation(m_aim);

		if (--m_stallCountdown <= 0) {
			const double moved = std::hypot(static_cast<double>(b.x()) - m_stallX,
			                                static_cast<double>(b.y()) - m_stallY);
			if (moved < STALL_DISTANCE) pickNewDirection(b);
			armStallCheck(b);
		}

		if (--m_hold <= 0) pickNewDirection(b);
	}

protected:
	void pickNewDirection(Bot& b)
	{
		size_t next = m_dirIndex;
		while (next == m_dirIndex) next = randInt(b.rng(), 0, static_cast<int>(MOVE_CHOICES.size()) - 1);
		m_dirIndex = next;
		b.setMove(MOVE_CHOICES[m_dirIndex]);
		m_hold = HOLD_TICKS;
	}

	void armStallCheck(Bot& b)
	{
		m_stallX = b.x();
		m_stallY = b.y();
		m_stallCountdown = STALL_WINDOW;
	}

	static constexpr int HOLD_TICKS = 100;
	static constexpr int AIM_STEP = 7;
	static constexpr int STALL_WINDOW = 8;
	static constexpr double STALL_DISTANCE = 40.0;

	int m_aim = 0;
	int m_hold = 0;
	size_t m_dirIndex = 0;
	int m_stallCountdown = STALL_WINDOW;
	double m_stallX = 0, m_stallY = 0;
};

// Scenario 1: everybody spawns in one area and rotates constantly.
//
// The difference from `bench` is that a bot never leaves its spawn
// neighbourhood -- it walks freely inside `crowdRadius` and steers home past
// it -- so the whole fleet stays inside a viewport or two of each other. That
// is the case that makes per-observer update fanout quadratic, and it is the
// one users report as lag. `bench` disperses over a run and stops measuring it.
class CrowdBehavior : public BenchBehavior {
public:
	CrowdBehavior(int index, double radius) : BenchBehavior(index), m_radius(radius) {}

	void onSpawn(Bot& b) override
	{
		BenchBehavior::onSpawn(b);
		m_haveHome = false;
	}

	void onTick(Bot& b) override
	{
		if (!b.alive()) return;

		// The spawn point is not known until the server has told us where we
		// are; the first position we get is the anchor for the whole session.
		if (!m_haveHome && (b.x() != 0 || b.y() != 0)) {
			m_homeX = b.x();
			m_homeY = b.y();
			m_haveHome = true;
		}

		m_aim = (m_aim + AIM_STEP) % 360;
		b.setRotation(m_aim);

		if (!m_haveHome) return;

		const double dist = std::hypot(static_cast<double>(b.x()) - m_homeX,
		                               static_cast<double>(b.y()) - m_homeY);
		if (dist > m_radius) {
			// Outside the area: steer straight home and hold that until we are
			// well back inside, so bots do not skate along the boundary.
			b.setMove(maskToward(b.x(), b.y(), static_cast<int32_t>(m_homeX), static_cast<int32_t>(m_homeY)));
			m_returning = true;
			return;
		}
		if (m_returning && dist > m_radius * 0.5) return;
		m_returning = false;

		if (--m_stallCountdown <= 0) {
			const double moved = std::hypot(static_cast<double>(b.x()) - m_stallX,
			                                static_cast<double>(b.y()) - m_stallY);
			if (moved < STALL_DISTANCE) pickNewDirection(b);
			armStallCheck(b);
		}
		if (--m_hold <= 0) pickNewDirection(b);
	}

private:
	double m_radius;
	double m_homeX = 0, m_homeY = 0;
	bool m_haveHome = false;
	bool m_returning = false;
};

// Scenario 3: the crowd, plus sustained automatic fire.
//
// Arming goes through the admin command path because no starting kit contains
// a ranged weapon. Two things to know before reading numbers from a combat run:
// bots kill each other so the population churns (thin them with --fire-ratio),
// and Player::updateGauges returns early for admins, so a combat run never
// executes the gauge or area-effect code at all.
class CombatBehavior : public CrowdBehavior {
public:
	CombatBehavior(int index, double radius, double fireRatio, std::mt19937& seedRng)
		: CrowdBehavior(index, radius)
		, m_shooter(randDouble(seedRng) < fireRatio)
	{}

	void onSpawn(Bot& b) override
	{
		CrowdBehavior::onSpawn(b);
		m_armed = false;
		m_requested = false;
		m_firing = true;   // first transition is mouse_up + reload
		m_countdown = ARM_DELAY_TICKS;
	}

	void onTick(Bot& b) override
	{
		CrowdBehavior::onTick(b);
		if (!m_shooter || !b.alive()) return;

		if (!m_armed) { tryArm(b); return; }

		if (--m_countdown > 0) return;

		if (m_firing) {
			b.send(proto::mouseUp());
			b.send(proto::reload());
			// Top up exactly one magazine per cycle. Without this the run
			// silently stops being a combat run: the opening grant lasts about
			// six magazines, which is spent during the connect ramp, so every
			// steady-state window measures zero projectiles.
			b.send(proto::chat("!item=" + std::string(AMMO) + "*" + std::to_string(MAGAZINE)));
			m_firing = false;
			m_countdown = RELOAD_TICKS;
		} else {
			b.send(proto::mouseDown());
			// One mouse_down is one magazine: the server owns the repeat loop,
			// the client sends ATTACK_START once per press and never auto-reloads.
			b.stats().shots.fetch_add(MAGAZINE, std::memory_order_relaxed);
			m_firing = true;
			m_countdown = FIRE_TICKS;
		}
	}

private:
	void tryArm(Bot& b)
	{
		if (!m_requested) {
			if (--m_countdown > 0) return;
			// Drained only now: everything the starting kit granted has landed,
			// so the next arrival is unambiguously the weapon we ask for. The
			// kit's packets arrive after login is answered, so a bot that asks
			// immediately equips a kit item and never fires.
			b.newItems().clear();
			b.send(proto::chat("!item=" + std::string(WEAPON)));
			m_requested = true;
			m_countdown = ARM_DELAY_TICKS;   // retry if the reply is lost
			return;
		}

		if (b.newItems().empty()) {
			if (--m_countdown <= 0) m_requested = false;
			return;
		}

		const proto::ItemSlot weapon = b.newItems().front();
		b.newItems().erase(b.newItems().begin());
		b.send(proto::equipItem(weapon.iid, weapon.uid));
		b.send(proto::chat("!item=" + std::string(AMMO) + "*" + std::to_string(AMMO_COUNT)));
		m_armed = true;
		m_firing = true;
		m_countdown = EQUIP_TICKS;
	}

	// Bot ticks at 10 Hz, sized against ak47's XML timings: 30 rounds at
	// 120ms shotDelay is 3.6s of fire against a 2500ms reload.
	static constexpr int ARM_DELAY_TICKS = 20;
	static constexpr int EQUIP_TICKS = 15;
	static constexpr int FIRE_TICKS = 38;
	static constexpr int RELOAD_TICKS = 30;
	static constexpr int MAGAZINE = 30;
	static constexpr int AMMO_COUNT = 200;
	static constexpr const char* WEAPON = "ak47";
	static constexpr const char* AMMO = "762_round";

	bool m_shooter;
	bool m_armed = false;
	bool m_requested = false;
	bool m_firing = true;
	int m_countdown = 0;
};

// Scenario 2: throwing items on the ground and picking them back up.
//
// Exercises a path no other behavior touches: loot entity creation and
// destruction, the entity id pool, tile membership churn, and the surgical
// broadcast that tells every spectator about each drop and each pickup. Unlike
// players, loot is a STATIC entity, so it reaches clients through
// broadcastSurgicalUpdate and the incremental static viewport rather than the
// per-tick mobile diff -- a different half of the visibility system.
class ItemChurnBehavior : public CrowdBehavior {
public:
	ItemChurnBehavior(int index, double radius) : CrowdBehavior(index, radius) {}

	void onSpawn(Bot& b) override
	{
		CrowdBehavior::onSpawn(b);
		m_spentInitial = false;
		m_requested = false;
		m_countdown = ARM_DELAY_TICKS;
		m_held = 0;
	}

	void onTick(Bot& b) override
	{
		CrowdBehavior::onTick(b);
		if (!b.alive()) return;

		if (m_held == 0) { restock(b); return; }
		if (--m_countdown > 0) return;

		if (m_throwing) {
			b.send(proto::throwItem(STONE_IID, 1, m_uid));
			b.stats().throws.fetch_add(1, std::memory_order_relaxed);
			--m_held;
			m_throwing = false;
			m_countdown = TAKE_DELAY_TICKS;
		} else {
			// Take the nearest loot we can see. Any loot will do -- the point
			// is the pickup path, not owning the item we personally dropped --
			// and competing for the same pile is what a real crowd does.
			int bestId = -1;
			uint64_t bestDist = UINT64_MAX;
			for (const auto& [key, tracked] : b.others()) {
				if (tracked.type != proto::TYPE_LOOT) continue;
				const int64_t dx = static_cast<int64_t>(tracked.endX) - b.x();
				const int64_t dy = static_cast<int64_t>(tracked.endY) - b.y();
				const uint64_t d2 = static_cast<uint64_t>(dx * dx + dy * dy);
				// PICK_UP_LOOT wants the entity's own id, not our composite map
				// key. Fits an int: ids are 24-bit.
				if (d2 < bestDist) { bestDist = d2; bestId = static_cast<int>(tracked.id); }
			}
			if (bestId >= 0) {
				b.send(proto::takeLoot(static_cast<uint32_t>(bestId)));
				b.stats().takes.fetch_add(1, std::memory_order_relaxed);
			}
			m_throwing = true;
			m_countdown = THROW_DELAY_TICKS;
		}
	}

private:
	// Acquire a stack of stone to throw.
	//
	// The uid comes from INVENTORY, not a slot arrival: the starting kit already
	// grants stone, so `!item=stone*N` stacks into that existing slot and sends
	// no arrival at all. Waiting for one is why the first version of this
	// behavior threw seven stones in twenty seconds across six bots instead of
	// two hundred.
	void restock(Bot& b)
	{
		if (!m_requested) {
			// The kit's own stone is enough to start; only ask the server for
			// more once it has actually run out.
			if (const proto::ItemSlot* stone = b.findInventoryItem(STONE_IID);
			    stone && !m_spentInitial) {
				m_uid = stone->uid;
				m_held = stone->count;
				m_spentInitial = true;
				m_throwing = true;
				m_countdown = THROW_DELAY_TICKS;
				return;
			}
			if (--m_countdown > 0) return;
			b.newItems().clear();
			b.send(proto::chat("!item=stone*" + std::to_string(RESTOCK_COUNT)));
			m_requested = true;
			m_countdown = RESTOCK_WAIT_TICKS;
			return;
		}

		if (--m_countdown > 0) return;

		// Prefer an arrival if one came (the slot was empty, so the grant
		// occupied a fresh one with a new uid). Otherwise the grant stacked
		// into the slot we already know, which keeps its uid.
		for (const proto::ItemSlot& item : b.newItems()) {
			if (item.iid != STONE_IID) continue;
			m_uid = item.uid;
			m_held = item.count;
			b.newItems().clear();
			m_requested = false;
			m_throwing = true;
			m_countdown = THROW_DELAY_TICKS;
			return;
		}
		m_held = RESTOCK_COUNT;
		m_requested = false;
		m_throwing = true;
		m_countdown = THROW_DELAY_TICKS;
	}

	// items.xml: stone is clientItemId 2, and clientItemId is the iid the
	// DROP_ITEM opcode matches against.
	static constexpr int STONE_IID = 2;
	static constexpr int RESTOCK_COUNT = 20;
	static constexpr int ARM_DELAY_TICKS = 20;
	static constexpr int RESTOCK_WAIT_TICKS = 8;
	static constexpr int THROW_DELAY_TICKS = 3;
	static constexpr int TAKE_DELAY_TICKS = 3;

	bool m_spentInitial = false;
	bool m_requested = false;
	bool m_throwing = true;
	int m_uid = 0;
	int m_held = 0;
	int m_countdown = 0;
};

} // namespace

bool behaviorExists(const std::string& name)
{
	return name == "idle" || name == "bench" || name == "crowd"
	    || name == "combat" || name == "itemchurn";
}

std::string behaviorNames() { return "idle, bench, crowd, combat, itemchurn"; }

BehaviorPtr makeBehavior(const std::string& name, const BehaviorOptions& opts, int botIndex)
{
	// Seeded per bot so a fleet is reproducible run to run: the only thing that
	// should differ between two legs of an A/B is the binary under test.
	std::mt19937 seedRng(static_cast<uint32_t>(botIndex) * 2246822519u + 7u);

	if (name == "idle")      return std::make_unique<IdleBehavior>();
	if (name == "bench")     return std::make_unique<BenchBehavior>(botIndex);
	if (name == "crowd")     return std::make_unique<CrowdBehavior>(botIndex, opts.crowdRadius);
	if (name == "combat")    return std::make_unique<CombatBehavior>(botIndex, opts.crowdRadius, opts.fireRatio, seedRng);
	if (name == "itemchurn") return std::make_unique<ItemChurnBehavior>(botIndex, opts.crowdRadius);

	throw std::runtime_error("unknown behavior '" + name + "'. choices: " + behaviorNames());
}

} // namespace bot
