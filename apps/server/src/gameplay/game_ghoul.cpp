// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "gameplay/game.h"

#include "gameplay/agent.h"
#include "content/configmanager.h"
#include "world/mapsize.h"
#include "core/scheduler.h"
#include "core/tasks.h"
#include "core/tools.h"

// --- Ghoul mode ------------------------------------------------------------
//
// A round, rather than a persistent world. It runs as three phases:
//
//   WaitingForPlayers  an empty server. Nothing is counting.
//   Countdown          started by the FIRST player to join. Until it expires
//                      the round plays as survival -- gather, craft, build, and
//                      a death respawns you as a player with the usual kit.
//   Locked             the world has turned. Every login from here arrives as a
//                      ghoul, including a player who dies and comes back. The
//                      people already alive stay people; dying is the only way
//                      to stop being one.
//
// The round ends when the last living player character leaves the world, and
// the world is rebuilt for the next one.
//
// Everything here is gated on Game::isGhoulMode(), which is false unless the
// running mode has a <ghoulRules> node -- so none of it is reachable from
// survival, and none of survival's paths had to learn about ghouls.
//
// NOTE: this project builds with unity/jumbo files on, so every file-local name
// here carries a `ghoul` prefix -- an unprefixed helper collides with another
// .cpp's anonymous namespace.

namespace {

// How often the round is examined. The phases change on human timescales
// (minutes), and the one thing that wants promptness -- noticing the last
// player died -- is better a beat late than racing the death that caused it.
constexpr uint32_t GHOUL_ROUND_PERIOD_MS = 1000;

// How often the countdown is restated to the clients that display it. The
// client runs the clock down itself frame by frame (client.js _TimerGhoul), so
// this is drift correction, not the clock: rare is fine, and the wire field has
// ten-second resolution anyway.
constexpr uint32_t GHOUL_CHRONO_RESYNC_MS = 30000;

// Schedules relative to when the run STARTED, so the period stays fixed instead
// of becoming periodMs + work. Same helper game.cpp uses for its own loops;
// duplicated rather than shared because that one is file-local there.
uint32_t ghoulNextPeriodDelay(uint64_t startedAt, uint32_t periodMs)
{
	const uint64_t workMs = static_cast<uint64_t>(OTSYS_TIME()) - startedAt;
	if (workMs >= periodMs) {
		return 1;
	}
	return static_cast<uint32_t>(periodMs - workMs);
}

// Returned when no mode is loaded, so every caller can read a number without
// first proving a mode exists.
const GhoulRules& ghoulDefaultRules()
{
	static const GhoulRules defaults{};
	return defaults;
}

} // namespace

const GhoulRules& Game::getGhoulRules() const
{
	return activeMode ? activeMode->ghoul : ghoulDefaultRules();
}

void Game::startGhoulRoundLoop()
{
	resetGhoulRound();
	g_scheduler.addEvent(createSchedulerTask(GHOUL_ROUND_PERIOD_MS,
		[this]() { this->updateGhoulRound(); }));
}

void Game::resetGhoulRound()
{
	ghoulPhase = GhoulPhase::WaitingForPlayers;
	ghoulDeadlineMs = 0;
	ghoulExtended = false;
	ghoulLastRevealMs = 0;
	ghoulLastChronoMs = 0;
	ghoulRoundEnding = false;
}

uint32_t Game::countLivingPlayers() const
{
	uint32_t alive = 0;
	for (const auto& [id, player] : players) {
		// Characters in the world, not open sessions. Someone whose connection
		// dropped is still standing there and still has to be found and killed,
		// so the round is not over just because they stopped playing -- and the
		// client counts them the same way, from the nickname table rather than
		// from anything about the socket.
		if (player && !player->isGhoul()) {
			++alive;
		}
	}
	return alive;
}

const AgentData* Game::pickGhoulBody() const
{
	const GhoulRules& rules = getGhoulRules();
	if (rules.ghouls.empty()) {
		return nullptr;
	}

	uint64_t total = 0;
	for (const GhoulChoice& choice : rules.ghouls) {
		total += choice.weight;
	}
	if (total == 0) {
		return nullptr;
	}

	// Weighted draw, same shape as the mode's world-spawn table: mostly normal
	// ghouls, occasionally something nastier.
	uint64_t roll = static_cast<uint64_t>(uniform_random(0, static_cast<int32_t>(total - 1)));
	for (const GhoulChoice& choice : rules.ghouls) {
		if (roll < choice.weight) {
			if (const AgentData* data = g_agents.getAgentData(choice.key)) {
				return data;
			}
			// A key that names nothing in agents.xml: fall through to the next
			// entry rather than dropping the player into no body at all. Warned
			// about once here rather than at load, because agents.xml and
			// modes.xml are loaded independently and either order is legal.
			fmt::print(fg(fmt::color::yellow),
				">> [Ghoul] <ghoul key=\"{}\"> names no agent in agents.xml; skipped.\n",
				choice.key);
			roll = 0; // take the next resolvable entry
			continue;
		}
		roll -= choice.weight;
	}

	// Every entry was unresolvable.
	return nullptr;
}

void Game::onGhoulPlayerCreated(Player* player)
{
	if (!isGhoulMode() || !player) {
		return;
	}

	if (ghoulPhase == GhoulPhase::Locked) {
		if (const AgentData* body = pickGhoulBody()) {
			player->becomeGhoul(body);
			fmt::print(">> [Ghoul] {} joined a locked round as '{}'\n", player->getName(), body->key);
		} else {
			// No usable body. They join as a player rather than as a broken
			// ghoul -- which is wrong for the round but is at least playable,
			// and the mode loader has already warned about the empty table.
			fmt::print(fg(fmt::color::yellow),
				">> [Ghoul] no usable ghoul body for {}; joining as a player.\n", player->getName());
		}
		return;
	}

	if (ghoulPhase == GhoulPhase::WaitingForPlayers) {
		ghoulPhase = GhoulPhase::Countdown;
		ghoulDeadlineMs = static_cast<uint64_t>(OTSYS_TIME()) + getGhoulRules().lockDelayMs;
		ghoulExtended = false;
		fmt::print(">> [Ghoul] round started by {}; the world locks in {}s\n",
			player->getName(), getGhoulRules().lockDelayMs / 1000);
	}
}

// The round's state, to one client, AFTER its login setup.
//
// Split from onGhoulPlayerCreated deliberately, because the two want opposite
// sides of the handshake. Assigning the body has to happen BEFORE it (the
// handshake carries the ghoul byte the sprite is chosen from), while telling
// the client about the clock has to happen AFTER: client.js builds its World
// and PLAYER objects when the handshake lands, and onDramaticChrono writes into
// one of them. A chrono that arrives first is written into state the handshake
// is about to replace.
void Game::sendGhoulRoundState(Player* player)
{
	if (!isGhoulMode() || !player || !player->client) {
		return;
	}

	// Ghouls read the same HUD field as a player count, not a clock; see
	// broadcastGhoulChrono.
	if (player->isGhoul()) {
		return;
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	player->client->sendDramaticChrono(
		(ghoulPhase == GhoulPhase::Countdown && ghoulDeadlineMs > now)
			? static_cast<uint32_t>(ghoulDeadlineMs - now)
			: 0);
}

// The client owns its own alive count: allocatePlayers seeds it from the
// nickname table, onNewPlayer increments it for each non-ghoul arrival, and
// OTHER_DIE is the only thing that ever decrements it. Without this the number
// in the ghouls' HUD would only ever go up, and the reveal -- which the client
// gates on `playerAlive < 6` -- would never arm.
//
// Sent for a ghoul's death too. The client tests the victim's own ghoul flag
// before decrementing (onOtherDie), so it discards those itself; sending them
// keeps the rule "a death is announced" whole rather than splitting the
// decision across both sides of the wire.
void Game::onGhoulCharacterDied(Player* victim)
{
	if (!isGhoulMode() || !victim) {
		return;
	}

	const uint8_t pid = static_cast<uint8_t>(victim->getGUID());
	for (const auto& [id, player] : players) {
		if (player && player->client && player != victim) {
			player->client->sendOtherDie(pid);
		}
	}
}

void Game::broadcastGhoulChrono()
{
	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	const uint32_t remaining = ghoulDeadlineMs > now
		? static_cast<uint32_t>(ghoulDeadlineMs - now)
		: 0;

	for (const auto& [id, player] : players) {
		// Ghouls do not have this clock: their corner of the HUD shows how many
		// players are left instead (client.js _AliveGhoul), and the two share
		// the same field, so sending it to a ghoul would be writing to a
		// display nobody is reading.
		if (player && player->client && !player->isGhoul()) {
			player->client->sendDramaticChrono(remaining);
		}
	}
	ghoulLastChronoMs = now;
}

// Positions of everyone still alive, to everyone still hunting.
//
// Reuses TEAM_POSITION, which is what the client already draws minimap arrows
// from -- for teammates normally, and for exactly this once `playerAlive < 6`
// (client.js _Minimap). So there is no new packet and no new client code: the
// endgame reveal is the team tracker pointed at the other side.
//
// Deliberately coarse. The cadence is revealIntervalMs, not the tick: a live
// feed would make the last few minutes unwinnable, while a ping every few
// seconds tells the horde roughly where to go and still lets someone break line
// of sight and move.
void Game::updateGhoulReveal()
{
	const uint32_t alive = countLivingPlayers();
	if (alive == 0 || alive > GHOUL_REVEAL_AT_OR_BELOW) {
		return;
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());
	if (ghoulLastRevealMs != 0 && now - ghoulLastRevealMs < getGhoulRules().revealIntervalMs) {
		return;
	}
	ghoulLastRevealMs = now;

	const float mapWidth = static_cast<float>(MapSize::widthUnits());
	const float mapHeight = static_cast<float>(MapSize::heightUnits());

	// Built once and sent to every ghoul: the packet does not depend on who is
	// receiving it, and a crowd of ghouls is the normal case by this point.
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::TEAM_POSITION));
	for (const auto& [id, player] : players) {
		if (!player || player->isGhoul()) {
			continue;
		}
		const Position pos = player->getPosition();
		msg.addByte(static_cast<uint8_t>(std::clamp(pos.x * 255.0f / mapWidth, 0.0f, 255.0f)));
		msg.addByte(static_cast<uint8_t>(std::clamp(pos.y * 255.0f / mapHeight, 0.0f, 255.0f)));
		msg.addByte(static_cast<uint8_t>(player->getGUID()));
	}

	for (const auto& [id, player] : players) {
		if (player && player->client && player->isGhoul()) {
			player->client->writeToOutputBuffer(msg);
		}
	}
}

void Game::updateGhoulRound()
{
	const uint64_t startedAt = static_cast<uint64_t>(OTSYS_TIME());

	if (isGhoulMode() && !ghoulRoundEnding) {
		const uint64_t now = startedAt;

		switch (ghoulPhase) {
			case GhoulPhase::WaitingForPlayers:
				break;

			case GhoulPhase::Countdown: {
				if (now < ghoulDeadlineMs) {
					if (now - ghoulLastChronoMs >= GHOUL_CHRONO_RESYNC_MS) {
						broadcastGhoulChrono();
					}
					break;
				}

				const GhoulRules& rules = getGhoulRules();
				const uint32_t online = static_cast<uint32_t>(players.size());

				if (online == 0) {
					// The round emptied out before it ever locked. Locking now
					// would strand the next person to connect as a lone ghoul
					// with nothing to hunt, so the clock goes back in the box
					// and the next arrival starts a fresh one.
					fmt::print(">> [Ghoul] countdown expired with nobody online; waiting for a new round.\n");
					resetGhoulRound();
					break;
				}

				if (!ghoulExtended && online >= rules.extendPlayerCount) {
					// Busy round: everyone gets longer to gear up. Once only,
					// and measured HERE rather than continuously, so a rush
					// that has since gone home cannot extend anything.
					ghoulExtended = true;
					const uint32_t extra = static_cast<uint32_t>(
						rules.lockDelayMs * rules.extendMultiplier) - rules.lockDelayMs;
					ghoulDeadlineMs = now + extra;
					fmt::print(">> [Ghoul] {} players online at expiry (>= {}); countdown extended by {}s\n",
						online, rules.extendPlayerCount, extra / 1000);
					broadcastGhoulChrono();
					break;
				}

				ghoulPhase = GhoulPhase::Locked;
				fmt::print(">> [Ghoul] world LOCKED with {} online; new arrivals are ghouls.\n", online);
				// Zero the clock on every surviving player's HUD: it is not
				// counting to anything any more.
				broadcastGhoulChrono();
				break;
			}

			case GhoulPhase::Locked: {
				if (countLivingPlayers() == 0) {
					endGhoulRound();
					break;
				}
				updateGhoulReveal();
				break;
			}
		}
	}

	g_scheduler.addEvent(createSchedulerTask(ghoulNextPeriodDelay(startedAt, GHOUL_ROUND_PERIOD_MS),
		[this]() { this->updateGhoulRound(); }));
}

// !ghoul, !ghoul=lock, !ghoul=end
//
// A round is eight minutes of countdown followed by however long the last
// player survives, which makes every question about it -- does the lock work?
// does a ghoul get the right body? does the restart leave a clean world? -- an
// eight-minute question. These make it a one-second one, for a play-test and
// for the automated check alike.
void Game::adminGhoulRound(Player* admin, const std::string& args)
{
	if (!isGhoulMode()) {
		adminReply(admin, fmt::format("Not a ghoul mode (gameMode = \"{}\").",
			activeMode ? activeMode->key : std::string("none")));
		return;
	}

	const uint64_t now = static_cast<uint64_t>(OTSYS_TIME());

	if (args == "lock") {
		if (ghoulPhase != GhoulPhase::Countdown) {
			adminReply(admin, "Nothing to lock: the countdown is not running.");
			return;
		}
		// Expire the clock rather than setting the phase directly, so the lock
		// runs through the same tick the real one does -- extension check
		// included. Testing a shortcut would not be testing the feature.
		ghoulDeadlineMs = now;
		adminReply(admin, "Countdown expired; the world locks on the next round tick.");
		return;
	}

	if (args == "end") {
		if (ghoulPhase != GhoulPhase::Locked) {
			adminReply(admin, "The round has not locked yet; nothing to end.");
			return;
		}
		adminReply(admin, "Ending the round: everyone out, world rebuilt.");
		endGhoulRound();
		return;
	}

	if (!args.empty()) {
		adminReply(admin, "Usage: !ghoul (status) | !ghoul=lock | !ghoul=end");
		return;
	}

	const char* phaseName =
		ghoulPhase == GhoulPhase::WaitingForPlayers ? "waiting for the first player" :
		ghoulPhase == GhoulPhase::Countdown ? "counting down" : "LOCKED";

	std::string detail;
	if (ghoulPhase == GhoulPhase::Countdown) {
		const uint64_t left = ghoulDeadlineMs > now ? ghoulDeadlineMs - now : 0;
		detail = fmt::format(", {}s to the lock{}", left / 1000,
			ghoulExtended ? " (already extended)" : "");
	}

	uint32_t ghouls = 0;
	for (const auto& [id, p] : players) {
		if (p && p->isGhoul()) ++ghouls;
	}

	adminReply(admin, fmt::format("Ghoul round: {}{} -- {} player(s) alive, {} ghoul(s).",
		phaseName, detail, countLivingPlayers(), ghouls));
}

// Everything a finished round leaves lying around that a world rebuild does not
// take with it.
//
// Game::regenerateWorld spares two classes deliberately, and both exemptions are
// right for what that function is FOR -- an admin reseeding a live world with
// players standing in it. Dropped loot is somebody's property, and creatures
// (including player-built bots) belong to the session, not the map. A round
// ending is the opposite situation: the session is over, nobody owns anything,
// and the next round is supposed to look like a server that just booted. A
// corpse's rifle still lying where it fell, or a dead player's turret still
// guarding an empty field, is last round's world bleeding into this one.
//
// Runs BEFORE the rebuild so the ids come back to the pool in time for
// generation to use them, and after every player has already been removed, so
// there is nobody left to broadcast a retraction to.
void Game::clearRoundEntities()
{
	// Ids, not pointers: both removals below mutate `things` while we walk it,
	// and an agent's removal can delete the agent outright.
	std::vector<uint32_t> lootIds;
	std::vector<uint32_t> agentIds;
	for (Thing* thing : map.getThings()) {
		if (thing->getLoot()) {
			lootIds.push_back(thing->getID());
		} else if (thing->getAgent()) {
			agentIds.push_back(thing->getID());
		}
	}

	std::vector<Thing*> doomed;
	doomed.reserve(lootIds.size());
	for (const uint32_t id : lootIds) {
		if (Thing* thing = map.getThingByID(id)) {
			removeWorldThing(thing, /*broadcastRemoval=*/false, &doomed);
		}
	}
	deferBulkDelete(std::move(doomed));

	// Agents do NOT go through removeWorldThing. That path calls
	// map.removeThing and then schedules a delete of the pointer, which is a
	// double free for a Creature: map.removeThing drops the world's reference,
	// and for an agent nothing else holds one, so the object is already gone by
	// the time the deferred delete runs. Reference counting is the whole
	// mechanism here -- see the note on Agent::die.
	//
	// Not Agent::die() either: that scatters the creature's loot and detonates
	// an explosive one. This is a world being erased, not a hundred deaths.
	for (const uint32_t id : agentIds) {
		if (Thing* thing = map.getThingByID(id)) {
			if (Agent* agent = thing->getAgent()) {
				map.removeThing(agent);
			}
		}
	}

	if (!lootIds.empty() || !agentIds.empty()) {
		fmt::print(">> [Ghoul] cleared {} ground loot and {} agent(s) left by the last round.\n",
			lootIds.size(), agentIds.size());
	}
}

// The horde won. Everyone out, world rebuilt, next round open for business.
//
// PLAYER_DIE rather than a kick alert, for everyone still connected including
// the ghouls: it is the one path client.js has that ends a session cleanly and
// drops straight to the score screen with a play-again button (Client.close ->
// the death overlay). A kick puts up an error box instead, which reads as a
// fault rather than the end of a round.
void Game::endGhoulRound()
{
	ghoulRoundEnding = true;

	// Collected first: kicking mutates the players map.
	std::vector<Player*> everyone;
	everyone.reserve(players.size());
	for (const auto& [id, player] : players) {
		if (player) {
			everyone.push_back(player);
		}
	}

	fmt::print(">> [Ghoul] round over -- no players left alive. Closing out {} session(s).\n",
		everyone.size());

	for (Player* p : everyone) {
		if (p->client) {
			// What killed the round may still be queued behind this.
			p->client->flushUpdates();
			p->client->sendPlayerDie(static_cast<uint16_t>(std::min<uint32_t>(p->getKills(), 0xFFFF)));
			p->client->flushOutputBatch(); // see Player death: a late flush is dropped after close()
			p->disconnect();
		}
		// A closed connection leaves the character standing, so the removal is
		// explicit -- and deferred, because it erases from the map being walked.
		scheduleRemovePlayer(p);
	}

	// After the removals above, which are dispatcher tasks queued in order: this
	// one runs once the world is actually empty, so the rebuild has no players
	// to resync and no characters to step around.
	//
	// A pinned `seed` in config.lua replays the same map every round; the
	// default random one gives each round fresh ground. That choice is the
	// config's, not the mode's, which is why it is asked here rather than
	// carried in <ghoulRules>.
	g_dispatcher.addTask([this]() {
		// Before the rebuild: it spares loot and creatures, which is correct for
		// a live reseed and wrong for a round boundary. See clearRoundEntities.
		clearRoundEntities();

		const uint32_t seed = rollWorldSeed();
		regenerateWorld(seed, /*preservePlayerBuilds=*/false);

		// A round is a clean slate, so nothing a previous one earned may cross
		// into this one.
		//
		// The kit tables are the reason this is not optional. They are keyed by
		// client token and outlive any character: a player who died at level 20
		// last round would otherwise walk into the new one holding a level-20
		// kit, having earned it in a world that no longer exists. Clearing both
		// makes every token "never died" again, which is exactly what a first
		// round looks like.
		pendingKitRewardByToken.clear();
		tokensWithPriorDeath.clear();

		// Clans go too. Their members are all disconnected by now, so what is
		// left is a table of empty teams holding the ids and names the next
		// round wants to hand out.
		clans.clear();

		resetGhoulRound();
		fmt::print(">> [Ghoul] new round ready on seed {}; waiting for the first player.\n", seed);
	});
}
