// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#include "core/otpch.h"

#include "persistence/ban.h"
#include "network/protocolgame.h"
#include "content/configmanager.h"
#include "content/contentexport.h"
#include "gameplay/game.h"
#include "network/outputmessage.h"
#include "gameplay/player.h"
#include "gameplay/weapon_mods.h"
#include "gameplay/quests/quest_system.h"
#include "gameplay/scenarios/scenario_population.h"
#include "gameplay/progress/progress_system.h"
#include "core/scheduler.h"
#include "persistence/database.h"
#include "gameplay/object.h"
#include "world/structure.h"

#include "world/mapsize.h"
#include "network/serverinfo.h"
#include "network/opcodes.h"
#include "network/disconnect_reason.h"
#include "core/perf.h"

namespace {
	// Silence from a client this long means it was not running: client.js drives
	// its sends off requestAnimationFrame, which browsers suspend on a hidden
	// tab. An actively played client sends far more often than this, and the
	// 20s AFK keepalive is the only thing a hidden one still emits, so this
	// cannot trip on an ordinary frame. See the gap check in parsePacket.
	constexpr int64_t CLIENT_RESUME_GAP_MS = 1500;

	// Everything a ghoul in ghoul mode is allowed to send. See the gate in
	// parsePacket for why this is an allowlist rather than a set of bans.
	//
	// What is deliberately absent: every inventory opcode (equip, throw, stack,
	// split, take loot, store, take), every crafting one (start manual, start at
	// a station, cancel, unlock skill, take from station, add fuel), building
	// (place object), containers (open, close), the world switches (lamp,
	// switch, timer), reload, and all eight team opcodes. A ghoul has no
	// inventory to fill, nothing to build with, and no team to join.
	//
	// The name carries a `ghoul` prefix because this project builds with unity
	// files on, where an unprefixed file-local name collides across .cpp files.
	bool ghoulMayUseOpcode(ClientOpcode opcode)
	{
		switch (opcode) {
			case ClientOpcode::PING:    // keepalive
			case ClientOpcode::CHAT_LOCAL:    // ghouls talk like anyone else
			case ClientOpcode::SEND_CHAT:
			case ClientOpcode::MOVE:
			case ClientOpcode::FACE:
			case ClientOpcode::ATTACK_START:      // the claw
			case ClientOpcode::ATTACK_STOP:
			case ClientOpcode::ROTATE:
			case ClientOpcode::SPRINT:           // running
			case ClientOpcode::AIM:             // the held state only: a ghoul never aims
			case ClientOpcode::LOOK_AT:         // read-only
			case ClientOpcode::BLOCK_PLAYER:    // whose chat reaches it
			case ClientOpcode::SET_PRIVATE_MESSAGES:
				return true;
			default:
				return false;
		}
	}

	// Is this packet's payload exactly the size its opcode declares?
	//
	// Checked once, before a single field is decoded, so every get<T>() in the
	// switch below is known to be in bounds -- one comparison per packet instead
	// of one per field, and no way for a handler to act on a value that was
	// really the end of the buffer.
	//
	// Both directions of mismatch are refused. A SHORT packet is the obvious
	// case. An OVERLONG one is refused too, and that is the deliberate part:
	// extra trailing bytes mean the sender's idea of this opcode's layout is not
	// ours, so its arguments cannot be trusted either, however well the first
	// few happen to decode.
	// `pg` prefix: this project builds with unity files on, where an unprefixed
	// file-local name collides across .cpp files.
	bool pgPayloadSizeOk(ClientOpcode opcode, size_t payloadBytes)
	{
		const int expected = clientPayloadBytes(opcode);
		if (expected == -2) {
			return false; // opcode this server does not accept
		}
		if (expected < 0) {
			return true; // variable length: bounds-checked field by field
		}
		return payloadBytes == static_cast<size_t>(expected);
	}
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

void ProtocolGame::release()
{
	// dispatcher thread. Without this removal the autosend list keeps a
	// shared_ptr to every protocol that ever logged in: the ProtocolGame and
	// its Connection leak, and the 10 ms sendAll sweep iterates dead sessions
	// forever. No-op if this protocol was never inserted (failed login).
	tfs::net::remove_protocol_from_autosend(shared_from_this());

	// A lost connection does NOT remove the character. The player stays in the
	// world exactly as if they went AFK — same position, inventory, gauges and
	// GUID — and a later login with the same token takes the session back over
	// through reconnect(). Removal is now explicit and belongs to the three
	// cases that really end a character: death (Player::changeHealth), an admin
	// kick/ban (Game::kickPlayer) and a login that failed after the player was
	// already registered (ProtocolGame::createNewPlayer).
	if (player) {
		g_game.onPlayerSessionLost(player);
		detachPlayerSession();
	}
}

// Drops this session's link to its player without removing the player from the
// game. Used both when another session takes the player over (reconnect — the
// old connection's deferred release() must not touch the player) and by
// release() itself once the world-side cleanup has run.
void ProtocolGame::detachPlayerSession()
{
	acceptPackets = false;
	if (!player) {
		return;
	}

	// Only clear the back-pointer if it still points at us: on reconnect the
	// player has already been handed to the new session by the time the old
	// one is released.
	if (player->client.get() == this) {
		player->client.reset();
	}

	player->decrementReferenceCounter();
	player = nullptr;
}

// [YOU_DIED][kills u16 BE]. The client already holds the score (SCORE); this is the
// death screen's kill count, which the old client read from exactly this field.
void ProtocolGame::sendPlayerDie(uint16_t kills)
{
	sendMessage(ServerOpcode::YOU_DIED,
		static_cast<uint8_t>((kills >> 8) & 0xFF), static_cast<uint8_t>(kills & 0xFF));
}

// Sends the nickname list + per-player info packets that are identical between
// a fresh login and a reconnect. Must be called with g_game.getPlayers() already
// reflecting the current player (i.e. after addPlayer for new logins).
void ProtocolGame::sendLoginSetup()
{
	// First, ahead of everything including the handshake. The client stores the
	// size outside its reset (Client.mapTiles) precisely so that Render.reset()
	// -- which onHandshake calls -- picks it up instead of racing it, and every
	// structure sized by the map has to exist before the first entity record
	// lands. Covers reconnects too: reconnect() comes through here as well.
	sendMapSize();

	const auto& gamePlayers = g_game.getPlayers();

	// Build a GUID→name lookup so we can fill slots 1..maxGuid without O(n²).
	uint32_t maxPlayerId = 0;
	std::unordered_map<uint32_t, std::string> guidToName;
	for (const auto& [id, p] : gamePlayers) {
		uint32_t guid = p->getGUID();
		guidToName[guid] = p->getName();
		if (guid > maxPlayerId) maxPlayerId = guid;
	}

	uint32_t maxPlayers = static_cast<uint32_t>(ServerInfo::getMaxPlayers());
	if (maxPlayers < 120) {
		maxPlayers = 120;
	}
	if (maxPlayerId > maxPlayers) {
		maxPlayers = maxPlayerId;
	}

	// The nickname roster: slot i is guid i, and an unoccupied slot is a
	// ZERO-LENGTH string.
	//
	// Slot 0 is not a player and is always empty; the loop below starts at 0
	// purely so the wire index and the guid are the same number. The JSON
	// version wrote guid g's name one slot late -- it pushed onto an array that
	// already held the opcode and a leading "" -- so every name landed at g+1.
	// For players who were online that was masked immediately by the PLAYER_INFO
	// messages that follow, which address a slot directly; for a name carried by
	// a player who had disconnected it simply showed against the wrong guid.
	//
	// The empty-slot encoding is load-bearing, not cosmetic. client.js counts
	// live players with `!== 0` (World.allocatePlayers), and in JavaScript
	// `"" !== 0` is true, so slots filled with empty STRINGS once made every
	// client believe a one-player server held 256 -- which is the number the
	// ghoul HUD shows and what gates the last-few reveal (`playerAlive < 6`), so
	// the reveal could never arm. The client turns a zero-length string back
	// into the number 0 before counting; see onNicknames in client.js.
	{
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_NAMES));
		msg.add<uint16_t>(static_cast<uint16_t>(maxPlayers + 1));
		for (uint32_t i = 0; i <= maxPlayers; ++i) {
			auto it = guidToName.find(i);
			msg.addString(it != guidToName.end() ? std::string_view{it->second} : std::string_view{});
		}
		msg.addString(player->getToken());
		writeToOutputBuffer(msg);
	}

	sendGroups();

	// One PLAYER_INFO per player currently online.
	for (const auto& [id, p] : gamePlayers) {
		sendPlayerInfo(*p);
	}

	// Every clan slot, occupied or not: the client indexes this array by clan id,
	// so a free slot has to be present as an empty string rather than skipped.
	{
		NetworkMessage msg;
		msg.addByte(static_cast<uint8_t>(ServerOpcode::TEAM_NAMES));
		msg.addByte(CLAN_SLOT_COUNT);
		for (uint8_t i = 0; i < CLAN_SLOT_COUNT; ++i) {
			auto it = g_game.clans.find(i);
			msg.addString(it != g_game.clans.end() ? std::string_view{it->second.name} : std::string_view{});
		}
		writeToOutputBuffer(msg);
	}

	for (const auto& [cid, clan] : g_game.clans) {
		sendTeamCreated(cid, clan.leaderGuid, clan.name);
		if (clan.locked) {
			NetworkMessage msg;
			buildTeamLockedMessage(cid, true, msg);
			writeToOutputBuffer(msg);
		}
	}

	sendHandshake();
	sendChatAccess();

	// The handshake roster above already carried everyone's LIVE drug timers,
	// which is the common case and costs nothing extra. This covers the one
	// thing that encoding cannot express: a player who has come off lapadone and
	// not been cured carries a marker with no timer, and a zero byte in the
	// roster reads as "clean". Idempotent for anyone the roster already
	// described -- both are read off the same Player::conditionVisual().
	for (const auto& [id, p] : gamePlayers) {
		p->sendConditionVisualTo(this);
	}

	sendGauges();

	// What time it is, in full. This used to be a bare DAY or NIGHT edge sent
	// here, and the client's handler for both zeroed its elapsed-time counter --
	// clobbering the phase the handshake had just carried, so every session
	// began at sunrise or sunset regardless of the hour. The phase is on the
	// wire now (ServerOpcode::WORLD_TIME) and this is simply the first of the
	// periodic statements of it.
	sendWorldTime();

	// A character outlives its connection, so a reconnect can land inside a
	// feeder / firepit / radiation field that this session was never told about:
	// the area signals are edge-triggered off flags the character already has
	// set, so no edge fires and the client runs those bars the wrong way for the
	// rest of the session. Restated on the next tick, once the handshake above
	// has been processed and the client actually has Gauge objects to latch on.
	player->requestFullGaugeResync();

	sendPlayerXpSkill();
	sendScore(player->getScore());
	sendKarma(player->getKarmaClientIcon());
	sendFullInventory();
	sendSelectedItem(player->getEquippedWeaponIID());
	sendCitiesLocation();

	// Explicit, because the periodic broadcast is suppressed when the standings
	// have not moved: a player who joins below the top ten changes nothing, and
	// would otherwise stare at an empty board until somebody else scored.
	g_game.sendLeaderboardTo(this);

	// The journal, the tracker and the NPC markers, from scratch: a reconnect
	// lands on a character whose quests this client has never seen.
	g_quests.sync(player);
	g_progress.attach(player);
}

void ProtocolGame::login(const LoginData& data)
{
	const LoginIdentity& identity = data.identity;
	fmt::print("Login for '{}'{}\n", identity.name,
	    identity.accountId ? fmt::format(" (account {})", identity.accountId) : std::string());

	// A character is taken over only by its owner: the same account, or --
	// for a guest character -- a guest presenting its token. One account never
	// has two characters on one server.
	Player* existing = g_game.getPlayerByAccountId(identity.accountId);
	Player* const tokenHolder = g_game.getPlayerByToken(data.token);
	if (!existing && tokenHolder && tokenHolder->getAccountId() == identity.accountId) {
		existing = tokenHolder;
	}

	if (existing) {
		if (existing->isPasswordAdmin() && !identity.passwordAdmin) {
			disconnectClient(DisconnectReason::ADMIN_AUTH_REQUIRED);
			return;
		}
		if (getBoolean(ConfigManager::ALLOW_RECONNECT)) {
			reconnect(existing, identity);
			return;
		}
		if (identity.accountId != 0) {
			g_game.kickPlayer(existing, DisconnectReason::LOGGED_IN_ELSEWHERE);
		}
	}

	// A token held by someone else's character is not this login's to carry:
	// the new character would share that character's kit history and death
	// reward (both keyed on the token) and make getPlayerByToken ambiguous.
	if (tokenHolder && tokenHolder != existing) {
		LoginData fresh = data;
		fresh.token = makeGuestSessionToken();
		fresh.tokenId = 0;
		createNewPlayer(fresh);
		return;
	}

	createNewPlayer(data);
}

void ProtocolGame::reconnect(Player* foundPlayer, const LoginIdentity& identity)
{
	isReconnecting = true;
	player = foundPlayer;
	player->incrementReferenceCounter();

	if (foundPlayer->client) {
		ProtocolGame_ptr oldClient = foundPlayer->client;
		oldClient->sendStoleYourSession();
		g_game.cancelTrade(foundPlayer->getID(), "Trade cancelled: session changed.");
		g_npcs.close(foundPlayer->getID(), "Session changed.");
		foundPlayer->disconnect();
		// A lost session releases the aim button. The detach below skips the old
		// release() and so onPlayerSessionLost; updateAim then tells the new
		// client AIM_STATE 0 on the next tick if aiming was active.
		foundPlayer->setAimHeld(false);
		// Detach the old session now: its deferred release() would otherwise
		// remove the player this session just took over.
		oldClient->detachPlayerSession();
	}

	player->client = getThis();
	player->lastIP = getIP();
	// The group may have changed since this character logged in (!setgroup
	// applies on the next login; this is one), and so may adminPassword.
	const bool groupChanged = player->getGroupId() != identity.groupId;
	player->setGroupId(identity.groupId);
	player->setPasswordAdmin(identity.passwordAdmin);
	if (auto conn = getConnection()) conn->setRateLimitExempt(player->hasGroupFlag(GroupFlag::NoRateLimit));
	acceptPackets = true;

	// Taking the character back over IS activity. Without this a player who
	// reconnects after a long AFK carries the old idle time in and can be swept
	// by the idle kick before they manage to press anything.
	player->resetIdleTime();

	sendLoginSetup();
	if (groupChanged) {
		NetworkMessage info;
		buildPlayerInfoMessage(*player, info);
		for (const auto& [id, p] : g_game.getPlayers()) {
			if (p != player && p->client) p->client->writeToOutputBuffer(info);
		}
	}
	if (!identity.notice.empty()) sendServerLog(ServerLogKind::SYSTEM, 0, 0, identity.notice);

	// A reconnect gets a fresh handshake, so its World.PLAYER is rebuilt and
	// the round clock has to be restated with it -- otherwise someone who
	// dropped out and came back is racing a countdown they cannot see.
	g_game.sendGhoulRoundState(player);

	// The entity view is left for the visibility tick to derive -- the only path
	// that answers "what should this client know" correctly.
	//
	// This used to snapshot map.getSpectators() here, which reads
	// Tile::getSolidThings and so cannot see a floor, road or loot pile at all.
	// A fresh login survived it (a new Player's staticBox starts inverted, so
	// the first tick rebuilds everything); a reconnect did not, because the
	// character keeps the staticBox it had before the socket dropped and the
	// tick skips the static half while the box still matches. 249 floors gone,
	// permanently, right after pendingIsLogin told the client to wipe.
	// Invalidating that box is the half resetClientEntityCache adds; clearing
	// pendingUpdates is the other half that matters here, since those describe a
	// cache that is about to be thrown away. See checkreconnectvis.py.
	player->resetClientEntityCache();

	tfs::net::insert_protocol_to_autosend(shared_from_this());
}

void ProtocolGame::createNewPlayer(const LoginData& data)
{
	// alwaysLogin groups get past maxPlayers (below), so they may also take a
	// slot above it -- up to what the protocol can address.
	const bool alwaysLogin = g_groups.getOrDefault(data.identity.groupId).has(GroupFlag::AlwaysLogin);
	uint32_t slotId = g_game.getFreeSlotId(
	    alwaysLogin ? PROTOCOL_MAX_PLAYER_ID : static_cast<uint32_t>(ServerInfo::getMaxPlayers()));
	if (slotId == 0) {
		disconnectClient(DisconnectReason::SERVER_FULL);
		return;
	}

	if (g_game.getPlayersOnline() >= static_cast<uint32_t>(ServerInfo::getMaxPlayers()) && !alwaysLogin) {
		disconnectClient(DisconnectReason::SERVER_FULL);
		return;
	}

	// Per-IP spawn cap; reconnect() is deliberately exempt (it takes over an
	// existing player instead of adding one from the IP).
	// Offline characters retain their last address and still count toward the
	// cap, so disconnecting cannot manufacture another spawn allowance.
	const int32_t maxPerIp = getNumber(ConfigManager::MAX_PLAYERS_PER_IP);
	const auto& ip = getIP();
	if (maxPerIp > 0 && !ip.is_unspecified()) {
		int32_t sameIpCount = 0;
		for (const auto& [id, p] : g_game.getPlayers()) {
			if (p->getIP() == ip && ++sameIpCount >= maxPerIp) {
				disconnectClient(DisconnectReason::TOO_MANY_FROM_IP);
				return;
			}
		}
	}

	player = new Player(getThis());
	player->lastIP = getIP();
	player->incrementReferenceCounter();
	player->setGUID(slotId);
	player->setID();

	player->name = data.identity.name;
	player->setAccountId(data.identity.accountId);
	player->setGroupId(data.identity.groupId);
	player->setPasswordAdmin(data.identity.passwordAdmin);
	player->setToken(data.token);
	player->setAdblocker(data.adBlocker);

	// Brand new characters always start bare-headed. The skin is driven by the
	// equipped wearable from here on, so it is set at creation only and never
	// taken from the login packet — a reconnect goes through reconnect() and
	// keeps the skin the character already has in the world.
	player->setSkin(0);

	// An admin command can legitimately be hundreds of frames in a burst (a
	// map paste), which the packet limiter would read as a flood.
	if (auto conn = getConnection()) {
		conn->setRateLimitExempt(player->hasGroupFlag(GroupFlag::NoRateLimit));
	}

	player->setHeldItemIID(0);

	if (data.tokenId != 0) {
		player->setTokenID(data.tokenId);
	} else {
		player->setTokenID(1000 + slotId);
	}

	// Ghoul mode: starts the round clock if this is the first arrival, or drops
	// this character into a ghoul body if the round has already locked.
	//
	// BEFORE the kit and before sendLoginSetup, and both orderings matter: a
	// ghoul has no inventory to put a kit in, and the handshake and the
	// new-player broadcast below both carry the ghoul byte the client renders
	// the sprite from.
	g_game.onGhoulPlayerCreated(player);

	// Fresh character (this is the only place brand new players are created):
	// reward starting items/level based on the level their last character (by
	// this nickname) died at, or the base kit if they've never died. Must run
	// before sendLoginSetup() below, which sends the resulting level/XP/score
	// and inventory to the client.
	//
	// Never for a ghoul: it cannot hold items, and a kit is a reward for how
	// far the last CHARACTER got, which a body handed out by the round is not.
	//
	// A scenario's spawn point is chosen here rather than at placement below,
	// because a spawn point with a loadout grants it instead of the kit.
	const std::optional<scenario::SpawnChoice> authoredSpawn = scenario::chooseSpawn(player);
	if (!player->isGhoul()) {
		if (authoredSpawn && authoredSpawn->spawn->loadout) scenario::grantLoadout(player, *authoredSpawn->spawn->loadout);
		else g_game.grantStartingKit(player);
	}

	g_game.addPlayer(player);

	// Tell everyone already online who just arrived. Built once and appended to
	// each client's batch, rather than re-serialised per recipient as the JSON
	// version was.
	{
		NetworkMessage newPlayerInfo;
		buildPlayerInfoMessage(*player, newPlayerInfo);
		for (const auto& [id, p] : g_game.getPlayers()) {
			if (p != player && p->client) {
				p->client->writeToOutputBuffer(newPlayerInfo);
			}
		}
	}
	// AFTER the identity above, in the same batch: the Server tab names the
	// newcomer as the line arrives, so the name has to be there first. The
	// newcomer itself is skipped -- "you joined" says nothing.
	g_game.broadcastServerLog(ServerLogKind::JOIN, static_cast<uint8_t>(player->getGUID()), 0, "", player);
	// A blocked account back under a new guid: its blockers' lists follow it
	// (after its PLAYER_INFO above, so their clients can name it).
	g_game.blocksOnArrival(player);

	sendLoginSetup();
	if (!data.identity.notice.empty()) sendServerLog(ServerLogKind::SYSTEM, 0, 0, data.identity.notice);

	// After the login setup, never before: client.js rebuilds World.PLAYER when
	// the handshake lands, and the round clock is written into it.
	g_game.sendGhoulRoundState(player);

	// Validated placement: rejects objects (including walkable floors and
	// roads), colliding resources, loot and other creatures. See
	// Game::isSpawnPositionValid. spawnSpread = 0 keeps the historical
	// single-point spawn, now with a fan-out when that point is occupied.
	// Starts the agent survival gate: a fresh character is left alone until it
	// has been alive longer than each agent type's aggroAfter window.
	player->resetSurvivalTimer();

	if (!g_game.placeThing(player, authoredSpawn ? authoredSpawn->at : g_game.findSpawnPosition(player))) {
		// The player is already registered at this point but never made it into
		// the world. release() no longer removes players, so unregister here or
		// the lookup maps keep a pointer to a character nothing can reach.
		g_game.removePlayer(player);
		disconnectClient(DisconnectReason::SPAWN_FAILED);
		return;
	}

	// Same single source of truth as reconnect(). A brand new Player is already
	// in this state, so it is the invariant written down rather than a change --
	// and writing it down is the point: the two login paths quietly disagreeing
	// about it is what hid the missing floors on reconnect.
	player->resetClientEntityCache();

	acceptPackets = true;
	tfs::net::insert_protocol_to_autosend(shared_from_this());
}

OutputMessage& ProtocolGame::beginMessage(uint16_t payloadBytes) const
{
	// Flush before, never truncate: OutputMessage::appendBytes drops a write
	// that does not fit, which inside an envelope would leave a length header
	// promising bytes that are not there.
	if (batch && !batch->canFit(static_cast<size_t>(BATCH_SUBHEADER_BYTES) + payloadBytes)) {
		flushOutputBatch();
	}

	if (!batch) {
		batch = tfs::net::make_output_message();
		batch->addByte(static_cast<uint8_t>(ServerOpcode::BATCH));
		batch->addByte(0); // reserved; keeps sub-headers at even offsets
		batchedMessages = 0;
	}

	batch->add<uint16_t>(payloadBytes);
	++batchedMessages;
	markSent();
	return *batch;
}

void ProtocolGame::endMessage() const
{
	if (!getBoolean(ConfigManager::BATCH_OUTPUT_FRAMES)) {
		flushOutputBatch();
	}
}

void ProtocolGame::queueMessage(const NetworkMessage& msg)
{
	const uint16_t length = msg.getLength();
	if (length == 0) {
		return;
	}

	// Counted here rather than in Connection::send so [OPS] keeps reporting
	// MESSAGES once several of them share a frame. [NET] writes/s is the frames.
	g_netperf.recordQueuedOpcode(msg.getBuffer()[NetworkMessage::INITIAL_BUFFER_POSITION]);

	// A message that cannot fit inside an envelope even in an empty buffer goes
	// out on its own, exactly as it did before batching. Wrapping it anyway
	// would write a length header and then silently drop the tail (appendBytes
	// refuses a write that does not fit), which is a corrupt frame rather than a
	// dropped message. NetworkMessage's own ceiling is a few bytes above ours,
	// so this is reachable -- just barely.
	//
	// The flush first is not optional: a direct send would overtake everything
	// already queued for this client.
	if (static_cast<size_t>(BATCH_HEADER_BYTES) + BATCH_SUBHEADER_BYTES + length >
	    static_cast<size_t>(NetworkMessage::MAX_PROTOCOL_BODY_LENGTH)) {
		flushOutputBatch();
		auto out = tfs::net::make_output_message();
		out->append(msg);
		markSent();
		send(std::move(out));
		return;
	}

	beginMessage(length).append(msg);
	endMessage();
}

void ProtocolGame::flushOutputBatch() const
{
	if (!batch) {
		return;
	}

	OutputMessage_ptr out = std::move(batch);
	batch.reset();

	const uint32_t count = batchedMessages;
	batchedMessages = 0;

	if (count == 0) {
		return; // header only, nothing was ever written into it
	}

	if (count == 1) {
		// An envelope around one message buys nothing and costs the receiver a
		// dispatch hop, so hand it over as the bare frame it would have been.
		out->skipLeadingBytes(static_cast<NetworkMessage::MsgSize_t>(BATCH_HEADER_BYTES + BATCH_SUBHEADER_BYTES));
	}

	send(std::move(out));
}

void ProtocolGame::flushUpdates()
{
	if (!player || player->pendingUpdates.empty()) {
		return;
	}

	// NetworkMessage silently drops bytes past its capacity, which used to
	// truncate busy ticks mid-record and corrupt the client's fixed-size
	// parsing (dropped removals, garbage entities). Send complete records
	// across as many messages as needed instead.
	//
	// Counted from the writes below rather than hardcoded, and it has to be
	// counted CORRECTLY: this said `5 * sizeof(uint16_t)` against six uint16
	// writes, which made a record 16 bytes instead of 18 and put 1535 records
	// in a message that only fits 1364. The surplus did not error -- canAdd
	// just stops copying -- so it was the exact mid-record truncation the
	// paragraph above claims to have fixed, waiting for one player to be sent
	// ~1365 records in a tick. A 150x150 map never got near that; a 655x655
	// one with scaled content would.
	// Four bytes, then seven 2-byte fields: state, id-low, startX, startY,
	// endX, endY, extra.
	//
	// The envelope's own bytes come off the budget too (batch header, this
	// message's length header, the ENTITY_UPDATES header): a chunk sized to the bare
	// buffer would not fit once wrapped, and beginMessage would flush and
	// restart mid-message.
	constexpr size_t updateRecordBytes = 4 * sizeof(uint8_t) + 7 * sizeof(uint16_t);
	constexpr size_t unitsHeaderBytes = 2;
	constexpr size_t maxUpdatesPerMessage =
		(NetworkMessage::MAX_PROTOCOL_BODY_LENGTH - BATCH_HEADER_BYTES - BATCH_SUBHEADER_BYTES - unitsHeaderBytes) /
		updateRecordBytes;

	// The record is 18 bytes and FOUR decoders have to agree on that: client.js
	// onUnits (stride 18, Uint16Array index stride 9), tools/stress/cpp/protocol.h
	// (UNIT_RECORD_BYTES) and tools/stress/protocol.py (struct "<BBBBHHHHHHH").
	// None of them can be reached from here, so this assert is the only thing
	// standing between a field added below and four silently misparsing readers.
	// It must also stay EVEN: client.js views the whole frame as a Uint16Array,
	// which throws outright on an odd byte length.
	static_assert(updateRecordBytes == 18,
		"entity record size changed -- update client.js onUnits and both tools/stress decoders");
	static_assert(updateRecordBytes % 2 == 0,
		"entity record must be even: client.js reads the frame as a Uint16Array");

	const auto& updates = player->pendingUpdates;
	size_t index = 0;
	bool loginFlag = player->pendingIsLogin;

	// Built straight into the outgoing buffer. The generic path (queueMessage)
	// fills a 24 KB NetworkMessage stack object and then memcpies it in; this is
	// the per-player-per-tick hot path, so it skips both. The record count is
	// known before the first byte is written, which is what lets the length
	// header go down up front instead of being patched afterwards.
	while (index < updates.size()) {
		const size_t chunkEnd = std::min(updates.size(), index + maxUpdatesPerMessage);
		const uint16_t payloadBytes =
			static_cast<uint16_t>(unitsHeaderBytes + (chunkEnd - index) * updateRecordBytes);

		g_netperf.recordQueuedOpcode(static_cast<uint8_t>(ServerOpcode::ENTITY_UPDATES));

		OutputMessage& out = beginMessage(payloadBytes);
		out.addByte(static_cast<uint8_t>(ServerOpcode::ENTITY_UPDATES));
		// Only the first chunk may carry the login flag: the client clears all
		// of its entities when it sees it.
		out.addByte(loginFlag ? 0x01 : 0x00);
		loginFlag = false;

		for (; index < chunkEnd; ++index) {
			const EntityUpdate& update = updates[index];
			out.addByte(update.pid);
			// High 8 bits of the id, in the byte that used to carry `uid`. The
			// low 16 follow below at an even offset, which is not a style
			// choice -- client.js can only read a uint16 there. See
			// WIRE ENCODING in definitions.h.
			out.addByte(static_cast<uint8_t>(update.id >> CLIENT_ENTITY_ID_WIRE_LOW_BITS));
			out.addByte(update.rotation);
			out.addByte(update.type);
			out.add<uint16_t>(update.state);
			out.add<uint16_t>(static_cast<uint16_t>(update.id & CLIENT_ENTITY_ID_WIRE_LOW_MASK));
			out.add<uint16_t>(update.startX);
			out.add<uint16_t>(update.startY);
			out.add<uint16_t>(update.endX);
			out.add<uint16_t>(update.endY);
			out.add<uint16_t>(update.extra);
		}
	}

	endMessage();

	player->pendingUpdates.clear();
	player->pendingIsLogin = false;
}

void ProtocolGame::sendHandshake()
{
	if (!player) return;

	const auto& gamePlayers = g_game.getPlayers();
	uint32_t maxPlayerId = 0;
	for (const auto& [id, p] : gamePlayers) {
		uint32_t guid = p->getGUID();
		if (guid > maxPlayerId) maxPlayerId = guid;
	}

	uint32_t maxPlayers = static_cast<uint32_t>(ServerInfo::getMaxPlayers());
	if (maxPlayers < 120) {
		maxPlayers = 120;
	}
	if (maxPlayerId > maxPlayers) {
		maxPlayers = maxPlayerId;
	}
	uint8_t handshakePlayerCount = static_cast<uint8_t>(std::min<uint32_t>(maxPlayers, 255));

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::HANDSHAKE));
	msg.addByte(static_cast<uint8_t>(player->getGUID()));
	msg.add<uint16_t>(12); // unitsPerPlayer
	msg.addByte(handshakePlayerCount);

	// Mode ID from XML
	uint8_t modeId = 0;
	if (const GameMode* mode = g_game.getActiveMode()) {
		modeId = mode->clientModeId;
	}
	msg.addByte(modeId);

	// No world time here any more. It was a u16 of `worldTime / 32` -- quantised
	// to 32 ms and unable to express a cycle past ~35 minutes, while
	// dayNightCycle is a u32 -- and it was overwritten on arrival by the DAY or
	// NIGHT edge sent moments later. ServerOpcode::WORLD_TIME states it instead,
	// at login and periodically after. Dropping the field moved the roster to
	// offset 6; it is still even, which the u16 fields in each entry need.

	for (const auto& it : gamePlayers) {
		Player* p = it.second;
		msg.addByte(static_cast<uint8_t>(p->getGUID()));
		uint8_t teamByte = 50;
		if (p->clanId != -1) {
			if (p->isClanLeader) {
				teamByte = static_cast<uint8_t>(p->clanId) + 51;
			} else {
				teamByte = static_cast<uint8_t>(p->clanId);
			}
		}
		msg.addByte(teamByte);

		// The two drug timers, which client.js reads straight out of this
		// roster into PLAYER.repellent / PLAYER.withdrawal. They were hardcoded
		// to 0, so a player logging in was told nobody was drugged -- including
		// themselves, after reconnecting to their own AFK character.
		//
		// Live timers only: a zero byte means "no timer", so the withdrawn
		// MARKER has no encoding here. sendConditionVisualTo covers that below,
		// once, for the handful of players carrying one.
		const ConditionVisual visual = p->conditionVisual();
		msg.addByte(static_cast<uint8_t>(visual.repellentMs == 0
			? 0 : std::clamp<uint32_t>(visual.repellentMs / 2000, 1, 255)));
		msg.addByte(static_cast<uint8_t>(visual.withdrawalMs == 0
			? 0 : std::clamp<uint32_t>(visual.withdrawalMs / 1000, 1, 255)));

		msg.addByte(p->getGhoul());
		msg.addByte(0);
		msg.add<uint16_t>(static_cast<uint16_t>(p->getTokenID() & 0xFFFF));
		msg.add<uint16_t>(deflateNumber(p->getScore()));
	}

	writeToOutputBuffer(msg);
}

// The rates are computed by Player::computeGaugeRates, not here: they are per
// player (resistances, feeder state), not per mode, and the tick has to
// integrate on the same integers this puts on the wire.
void ProtocolGame::sendModdedGaugesValues(const std::array<uint16_t, GAUGE_SLOT_COUNT * GAUGE_RATE_FIELD_COUNT>& rates)
{
	NetworkMessage msg;
	// The client reads this packet as an array of 16-bit words, so the opcode is
	// written as a u16: ui16[0] is the opcode and ui16[1..15] line up after it.
	msg.add<uint16_t>(static_cast<uint16_t>(ServerOpcode::GAUGE_RATES));

	// ui16[1..15]: life, food, warmth, stamina, radiation -- (max, inc, dec) each.
	for (uint16_t value : rates) {
		msg.add<uint16_t>(value);
	}

	writeToOutputBuffer(msg);
}

// The world clock, stated whole. Reads g_game rather than taking the values as
// arguments so that login, the boundary, the periodic resync and `!set-daynight`
// cannot describe the same clock differently -- there is one formatter and it
// asks the one clock.
void ProtocolGame::sendWorldTime()
{
	const WorldClock& clock = g_game.getWorldClock();
	sendMessage(ServerOpcode::WORLD_TIME,
		static_cast<uint32_t>(clock.cycleMs()),
		static_cast<uint32_t>(clock.phaseMs()));
}

// Must stay byte-for-byte what Player::packGauges hashes, radiation inversion
// included, or the dedupe there compares the wrong thing.
void ProtocolGame::sendGauges()
{
	if (!player) return;

	sendMessage(ServerOpcode::GAUGE_VALUES,
		player->getHealth(),               // life
		player->getHunger(),               // food
		player->getCold(),                 // cold
		player->getStamina(),              // stamina
		player->getRadiationWireValue());  // rad
}

// Three bytes, and it says everything the fifteen retired edges said between
// them. No pad byte: client.js reads this with a DataView (Packet.Reader),
// which addresses odd offsets fine. See the note above ServerOpcode::CHAT.
void ProtocolGame::sendGaugeState(uint16_t packedDirections)
{
	sendMessage(ServerOpcode::GAUGE_DIRECTIONS, packedDirections);
}

void ProtocolGame::sendPlayerStamina(uint8_t value)
{
	sendMessage(ServerOpcode::STAMINA, value);
}

void ProtocolGame::sendFullInventory()
{
	if (!player) return;

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::INVENTORY));

	// Every slot, occupied or not: the record COUNT is how the client learns the
	// inventory's size, which is the only way it can know a bag skill widened it.
	// Dropping the empties would make the message shorter and the size a lie.
	uint8_t slots = player->inventory.getSlotCount();
	for (uint8_t i = 0; i < slots; ++i) {
		if (Item* item = player->inventory.getItem(i)) {
			msg.add<uint16_t>(item->getIID());
			msg.addByte(item->getCount());
			msg.addByte(static_cast<uint8_t>(item->getUID() & 0xFF));
			msg.addByte(item->getAmmo());
		} else {
			msg.add<uint16_t>(0);
			msg.addByte(0);
			msg.addByte(0);
			msg.addByte(0);
		}
	}
	writeToOutputBuffer(msg);

	// INVENTORY cleared the client's mods; restate every moddable gun's.
	for (uint8_t i = 0; i < slots; ++i) {
		const Item* item = player->inventory.getItem(i);
		if (item && weapon_mods::takesMods(item->getIID())) sendItemMods(item->getUID(), item->getMods());
	}
}

// One inventory slot's complete contents, keyed by the uid. See the wire layout
// and the reasoning on ServerOpcode::INVENTORY_SLOT.
//
// The uid is truncated to its low byte, and that byte is the whole of the item's
// wire identity. It is safe ONLY because Inventory::makeItem guarantees the byte
// is unique inside one inventory; the raw uid counter is global and aliases every
// 256 items. Anything that puts an Item into a player's inventory has to go
// through there, or two stacks become indistinguishable to both sides.
void ProtocolGame::sendInventorySlot(uint16_t iid, uint8_t count, uint32_t uid, uint8_t ammo)
{
	sendMessage(ServerOpcode::INVENTORY_SLOT,
		static_cast<uint8_t>(uid & 0xFF), iid, count, ammo);
}

// iid 0 empties the slot; count and ammo are not read in that case, and are sent
// as 0 so the frame is not carrying a stale number nobody looks at.
void ProtocolGame::sendClearInventorySlot(uint32_t uid)
{
	sendInventorySlot(0, 0, uid, 0);
}

// One inventory item's complete fitted mods, keyed by the uid's low byte like
// INVENTORY_SLOT. See ServerOpcode::ITEM_MODS.
void ProtocolGame::sendItemMods(uint32_t uid, const WeaponMods& mods)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::ITEM_MODS));
	msg.addByte(static_cast<uint8_t>(uid & 0xFF));
	appendWeaponMods(msg, mods);
	writeToOutputBuffer(msg);
}

// See ServerOpcode::AIM_STATE.
void ProtocolGame::sendAimState(bool active, uint16_t viewX, uint16_t viewY)
{
	sendMessage(ServerOpcode::AIM_STATE, static_cast<uint8_t>(active ? 1 : 0), viewX, viewY);
}

// BIG-endian, unlike everything else on this wire: the client reads these two as
// `(ui8[1] << 8) + ui8[2]` rather than through a typed view. Kept as two explicit
// bytes so that is visible instead of hidden behind a u16 that would be wrong.
void ProtocolGame::sendSelectedItem(uint16_t iid)
{
	sendMessage(ServerOpcode::SELECTED_ITEM,
		static_cast<uint8_t>(iid >> 8), static_cast<uint8_t>(iid & 0xFF));
}

void ProtocolGame::sendPlayerXp(uint16_t xp)
{
	sendMessage(ServerOpcode::XP,
		static_cast<uint8_t>(xp >> 8), static_cast<uint8_t>(xp & 0xFF));
}

void ProtocolGame::sendPlayerXpSkill()
{
	if (!player) return;

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::LEVEL_STATE));
	msg.addByte(static_cast<uint8_t>(player->getLevel() & 0xFF));

	// XP progress WITHIN the current level (32-bit big-endian): the client's
	// onPlayerXpSkill assigns this directly to PLAYER.xp and renders the bar
	// as xp / getXpFromLevel(level) — sending total experience here made the
	// bar appear ~90% full immediately after every level-up.
	const uint32_t levelBase = player->getRequiredXP(player->getLevel());
	const uint32_t total = player->getXP();
	uint32_t xp = (total > levelBase) ? total - levelBase : 0;
	msg.addByte(static_cast<uint8_t>((xp >> 24) & 0xFF));
	msg.addByte(static_cast<uint8_t>((xp >> 16) & 0xFF));
	msg.addByte(static_cast<uint8_t>((xp >> 8) & 0xFF));
	msg.addByte(static_cast<uint8_t>(xp & 0xFF));

	// Unlocked skills (only items that explicitly require unlocking)
	for (uint16_t iid : player->getUnlockedSkills()) {
		const ItemData* idata = ItemManager::getInstance().getItemData(iid);
		if (idata && idata->requiresUnlock) {
			msg.addByte(static_cast<uint8_t>(iid & 0xFF));
		}
	}
	
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendScore(uint32_t scoreValue)
{
	sendMessage(ServerOpcode::SCORE,
		static_cast<uint8_t>(0), // pad: the client reads this through a Uint16Array
		static_cast<uint16_t>((scoreValue >> 16) & 0xFFFF),
		static_cast<uint16_t>(scoreValue & 0xFFFF));
}

uint16_t ProtocolGame::deflateNumber(uint32_t n)
{
	if (n >= 1000000) { // 1 million
		return static_cast<uint16_t>((n / 1000) + 20000);
	} else if (n >= 10000) { // 10 thousand
		return static_cast<uint16_t>((n / 100) + 10000);
	}
	return static_cast<uint16_t>(n);
}

void ProtocolGame::sendKarma(uint8_t clientIcon)
{
	sendMessage(ServerOpcode::KARMA, clientIcon);
}

void ProtocolGame::sendShakeExplosionState(uint8_t shake)
{
	sendMessage(ServerOpcode::EXPLOSION_SHAKE, shake);
}

void ProtocolGame::sendBoughtSkill(uint16_t iid)
{
	sendMessage(ServerOpcode::SKILL_UNLOCKED, static_cast<uint8_t>(iid & 0xFF));
}

void ProtocolGame::sendStartInteraction(uint16_t delayMultiplier)
{
	sendMessage(ServerOpcode::INTERACTION_STARTED, static_cast<uint8_t>(delayMultiplier & 0xFF));
}

void ProtocolGame::sendInterruptInteraction()
{
	sendSimpleOpcode(ServerOpcode::INTERACTION_CANCELLED);
}

void ProtocolGame::sendBlueprint(uint16_t iid)
{
	sendMessage(ServerOpcode::BLUEPRINT, static_cast<uint8_t>(iid));
}

void ProtocolGame::sendLostStation()
{
	sendSimpleOpcode(ServerOpcode::STATION_CLOSED);
}

void ProtocolGame::sendOpenStation(uint8_t area, uint8_t isLogin)
{
	uint32_t interactionId = player->getOpenedInteractionId();
	if (interactionId == 0) return;

	// getThingByID may return null, so the slot call needs the guard that
	// dynamic_cast<Object*>(nullptr) gave for free.
	Thing* interactionThing = g_game.map.getThingByID(interactionId);
	Object* obj = interactionThing ? interactionThing->getObject() : nullptr;
	if (!obj) return;

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::STATION_OPENED));
	msg.addByte(area);

	// ui8[2]: Progress Byte (0-255)
	const auto& queue = obj->getQueue();
	uint8_t activeSlot = 0;
	uint8_t progress = 0;
	uint8_t len = 0;
	bool isCrafting = false;
	
	for (uint8_t i = 0; i < 4; i++) {
		if (queue[i].iid != 0) {
			len++;
			if (!isCrafting) {
				if (queue[i].progressMs < queue[i].totalTimeMs) {
					isCrafting = true;
					activeSlot = i;
					if (queue[i].totalTimeMs > 0) {
						progress = static_cast<uint8_t>((queue[i].progressMs * 255) / queue[i].totalTimeMs);
					}
				}
			}
		}
	}

	if (!isCrafting) {
		activeSlot = len;
		progress = 255;
	}

	// Invert the progress byte as the client expects 255 to mean 0 time elapsed, and 0 to mean fully crafted
	msg.addByte(255 - progress);
	msg.addByte(activeSlot);

	// ui8[4-7]: 4 Queue slots
	for (uint8_t i = 0; i < 4; i++) {
		msg.addByte(static_cast<uint8_t>(queue[i].iid & 0xFF));
	}

	msg.addByte(isLogin); // 0 = Open, 1 = Update Only
	msg.addByte(obj->getFuelByte());
	msg.add<uint32_t>(obj->getFuelMs());

	writeToOutputBuffer(msg);
}

void ProtocolGame::sendNewFuelValue(uint8_t value, uint32_t remainingMs)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::STATION_FUEL));
	msg.addByte(value);
	msg.add<uint32_t>(remainingMs);
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendPoisened(uint8_t delaySec)
{
	sendMessage(ServerOpcode::POISONED, delaySec);
}

// The REPELLENT_ACTIVE / LAPADONE_ACTIVE / DRUG_RESET senders that used to sit here are gone.
// They were never called, and the three opcodes now travel as one statement
// driven by a single table (buildConditionVisualWire in player.cpp) that both the
// broadcast and the single-client path walk -- a named sender per opcode would
// need a switch to rebuild that order, which is a second place for the truth to
// live and drift.

void ProtocolGame::sendDramaticChrono(uint32_t remainingMs)
{
	// Ten-second units, rounded UP so the displayed clock never reads 00:00
	// while the round is still open, and clamped to the byte the field is: a
	// countdown longer than 42.5 minutes simply shows 42.5 and then corrects
	// itself on the next resync.
	const uint32_t units = std::min<uint32_t>(255, (remainingMs + 9999) / 10000);

	sendMessage(ServerOpcode::COUNTDOWN, static_cast<uint8_t>(units));
}

void ProtocolGame::sendOtherDie(uint8_t pid)
{
	sendMessage(ServerOpcode::PLAYER_DIED, pid);
}

void ProtocolGame::sendWrongTool(uint8_t toolIid)
{
	sendMessage(ServerOpcode::WRONG_TOOL, toolIid);
}

void ProtocolGame::sendFullChest(Object* obj, bool firstOpen)
{
	if (!obj) return;

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::CONTAINER_CONTENTS));
	msg.addByte(firstOpen ? 1 : 0);

	const uint8_t storageSlots = obj->getStorageSize();
	for (uint8_t i = 0; i < storageSlots; i++) {
		if (Item* item = obj->getStorageItem(i)) {
			msg.add<uint16_t>(item->getIID());
			msg.addByte(item->getCount());
			// The client hardcodes AMMO = UID for chest items: itemsinside[space][3] = itemsinside[space][2]
			// So the AMMO goes in the byte after the count -- the UID position of the original
			// record, which chest items never carry -- to show correct decay in chests.
			msg.addByte(item->getAmmo());
			appendWeaponMods(msg, item->getMods());
		} else {
			msg.add<uint16_t>(0);
			msg.addByte(0);
			msg.addByte(0);
			msg.addByte(0);
		}
	}
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendNotification(uint8_t playerPid, uint8_t type, uint8_t level)
{
	sendMessage(ServerOpcode::OVERHEAD_ALERT, playerPid,
		static_cast<uint8_t>((type << 2) | (level & 3)));
}

void ProtocolGame::sendPlayerHit(uint8_t playerPid, uint8_t angle)
{
	sendMessage(ServerOpcode::PLAYER_HIT, playerPid, angle);
}

void ProtocolGame::sendPlayerHeal(uint8_t playerPid)
{
	sendMessage(ServerOpcode::PLAYER_HEALED, playerPid);
}

void ProtocolGame::sendDamageIndicator(uint16_t x, uint16_t y, int16_t amount, uint8_t pct)
{
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::DAMAGE_INDICATOR));
	msg.add<uint16_t>(x);
	msg.add<uint16_t>(y);
	msg.add<int16_t>(amount);
	msg.addByte(pct);
	queueMessage(msg);
}

void ProtocolGame::sendStoleYourSession()
{
	sendSimpleOpcode(ServerOpcode::SESSION_TAKEN);
}

void ProtocolGame::buildChatChannelMessage(ChatChannel channel, uint8_t from, uint8_t peer, uint8_t flags, const std::string& text, NetworkMessage& msg)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::CHAT_LINE));
	msg.addByte(static_cast<uint8_t>(channel));
	msg.addByte(from);
	msg.addByte(peer);
	msg.addByte(flags);
	msg.addString(text);
}

void ProtocolGame::buildServerLogMessage(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text, NetworkMessage& msg)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::SERVER_LOG));
	msg.addByte(static_cast<uint8_t>(kind));
	msg.addByte(a);
	msg.addByte(b);
	msg.addString(text);
}

void ProtocolGame::sendChatChannel(ChatChannel channel, uint8_t from, uint8_t peer, uint8_t flags, const std::string& text)
{
	NetworkMessage msg;
	buildChatChannelMessage(channel, from, peer, flags, text, msg);
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendAdminReply(const std::string& message)
{
	sendChatChannel(ChatChannel::ADMIN, CHAT_SYSTEM_PID, 0, 0, message);
}

void ProtocolGame::sendServerLog(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text)
{
	NetworkMessage msg;
	buildServerLogMessage(kind, a, b, text, msg);
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendChatAccess()
{
	if (!player) return;
	uint8_t mask = (1 << static_cast<uint8_t>(ChatChannel::LOCAL))
		| (1 << static_cast<uint8_t>(ChatChannel::GLOBAL))
		| (1 << static_cast<uint8_t>(ChatChannel::CLAN))
		| (1 << static_cast<uint8_t>(ChatChannel::PRIVATE));
	if (player->hasGroupFlag(GroupFlag::StaffChat)) {
		mask |= (1 << static_cast<uint8_t>(ChatChannel::ADMIN));
	}
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::CHAT_ACCESS));
	msg.addByte(mask);
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendGroups()
{
	std::vector<const Group*> badged;
	for (const Group& group : g_groups.all()) {
		if (!group.badge.empty()) badged.push_back(&group);
	}
	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::GROUPS));
	msg.addByte(static_cast<uint8_t>(badged.size()));
	for (const Group* group : badged) {
		msg.addByte(group->id);
		msg.addString(group->name);
		msg.addString(group->badge);
	}
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendPlayerInfo(const Player& target)
{
	NetworkMessage msg;
	buildPlayerInfoMessage(target, msg);
	writeToOutputBuffer(msg);
}

void ProtocolGame::sendTeamCreated(uint8_t clanId, uint32_t leaderGuid, const std::string& name)
{
	NetworkMessage msg;
	buildTeamCreatedMessage(clanId, leaderGuid, name, msg);
	writeToOutputBuffer(msg);
}

void ProtocolGame::buildTeamCreatedMessage(uint8_t clanId, uint32_t leaderGuid, const std::string& name,
                                           NetworkMessage& msg)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::TEAM_CREATED));
	msg.addByte(clanId);
	msg.add<uint32_t>(leaderGuid);
	msg.addString(name);
}

void ProtocolGame::buildTeamLockedMessage(uint8_t clanId, bool locked, NetworkMessage& msg)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::TEAM_LOCKED));
	msg.addByte(clanId);
	msg.addByte(locked ? 1 : 0);
}

// Shared by the login roster and the "someone joined" broadcast so the two can
// never drift apart in layout.
void ProtocolGame::buildPlayerInfoMessage(const Player& target, NetworkMessage& msg)
{
	msg.addByte(static_cast<uint8_t>(ServerOpcode::PLAYER_INFO));
	msg.addByte(static_cast<uint8_t>(target.getGUID()));
	msg.add<uint32_t>(static_cast<uint32_t>(target.getTokenID()));
	msg.addByte(target.getSkin());
	msg.addByte(target.getGhoul());
	msg.addString(target.getName());
	msg.addByte(target.getGroupId());
	msg.addByte(target.isVerified() ? IDENTITY_FLAG_VERIFIED : 0);
}

void ProtocolGame::parsePacket(NetworkMessage& msg)
{
	if (!acceptPackets || !player) {
		// Not logged in yet, so this is either another REQUEST_CONTENT or the
		// login frame itself. Connection::onRead only strips the protocol
		// identifier (30) from a connection's FIRST frame; a client that asked
		// for content tables before logging in sends its login as a later frame
		// with the identifier still attached, and decoding it from the
		// identifier read the version as 30 and dropped the login on the floor
		// -- no reply, no disconnect, the client just waited. 30 cannot be a
		// real opcode here (REQUEST_TEAM_JOIN needs a player), so consume it
		// and hand the frame to the same gate a first-frame login goes through:
		// the version, ban and closed-server checks must apply regardless of
		// which frame the login arrived in.
		if (msg.getRemainingLength() > 1 && msg.peekByte() == protocol_identifier) {
			msg.getByte();
		}
		onRecvFirstMessage(msg);
		return;
	}

	// One dispatcher turn: stale sessions cannot leave deferred player actions.
	const auto runAction = [](auto&& action) { action(); };
	if (player->client.get() != this || g_game.getGameState() == GAME_STATE_SHUTDOWN || msg.isEmpty()) {
		return;
	}

	// "The client just came back." A hidden browser tab stops requestAnimationFrame,
	// which is what drives client.js's input and keepalive sends, so it goes quiet
	// — and its own gauge integration is broken across exactly that span,
	// because client.js integrates on an unclamped `delta = timestamp -
	// previousTimestamp` and so applies the whole hidden period in one step.
	// The first packet after a gap is therefore the precise moment to re-anchor
	// its bars, and it is the ONLY periodic-ish resync there is: correcting a
	// gauge the client is predicting correctly makes the bar stutter (see the
	// resync policy note at the top of player.cpp).
	//
	// Values only, not the direction signals: a hidden tab still runs its JS
	// event loop, so every WARM_ON/FOOD_OFF/... sent meanwhile was received and
	// latched correctly. Only the integration between them went wrong.
	//
	// Hopped to the dispatcher: parsePacket runs on the network thread and the
	// gauge flags belong to the tick.
	{
		const int64_t now = OTSYS_TIME();
		const int64_t previous = lastClientPacket;
		lastClientPacket = now;
		if (previous != 0 && now - previous >= CLIENT_RESUME_GAP_MS) {
			const uint32_t resumeId = player->getID();
			runAction([resumeId]() {
				if (Player* p = g_game.getPlayerByID(resumeId)) {
					p->forceGaugeResync();
				}
			});
		}
	}

	const auto opcode = static_cast<ClientOpcode>(msg.getByte());

	// Everything the packet is allowed to contain, checked before anything in it
	// is decoded. After this, every get<T>() below is in bounds by construction.
	if (!pgPayloadSizeOk(opcode, msg.getRemainingLength())) {
		return;
	}

	// A ghoul can move, look, swing, run and talk. It cannot touch an
	// inventory, a workbench, a building site, a container, a door or a team.
	//
	// Enforced HERE, on the wire, and as an ALLOWLIST. client.js hides the craft
	// and team buttons from a ghoul and refuses the craft hotkey, but that is
	// presentation: a modified client can send any opcode it likes, and every
	// one of these has a real effect on the world. An allowlist rather than a
	// list of bans because the failure modes are not symmetric -- a new opcode
	// added later is denied to ghouls by default and someone notices, where a
	// forgotten ban is an exploit nobody sees.
	if (player->isGhoul() && !ghoulMayUseOpcode(opcode)) {
		return;
	}

	if (!player->hasGroupFlag(GroupFlag::NoRateLimit)) {
		bool allowed = true;
		if (opcode == ClientOpcode::CHAT_LOCAL || opcode == ClientOpcode::SEND_CHAT || opcode == ClientOpcode::BLOCK_PLAYER || opcode == ClientOpcode::ACCEPT_TEAM_INVITE || opcode == ClientOpcode::SET_PRIVATE_MESSAGES) allowed = chatBudget.consume(2, 4);
		else if (opcode == ClientOpcode::PING) allowed = pingBudget.consume(2, 4);
		// Look is cheap, but a script clicking it thousands of times a second is not.
		else if (opcode == ClientOpcode::LOOK_AT) allowed = lookBudget.consume(4, 8);
		else if (opcode == ClientOpcode::DROP_ITEM || opcode == ClientOpcode::STORE_ITEM || opcode == ClientOpcode::TAKE_ITEM || opcode == ClientOpcode::MOVE_CONTAINER_ITEM || opcode == ClientOpcode::PICK_UP_LOOT || opcode == ClientOpcode::SPLIT_ITEM || opcode == ClientOpcode::STACK_ITEM) allowed = inventoryBudget.consume(20, 40);
		else if (opcode == ClientOpcode::CRAFT_BY_HAND || opcode == ClientOpcode::CRAFT_AT_STATION || opcode == ClientOpcode::CANCEL_CRAFT || opcode == ClientOpcode::TAKE_FROM_STATION || opcode == ClientOpcode::UNLOCK_SKILL || opcode == ClientOpcode::ADD_FUEL) allowed = craftBudget.consume(10, 20);
		if (!allowed) return;
	}

    // Includes admins: a test/admin client must not spam another player's invitations.
    if (opcode == ClientOpcode::TRADE_REQUEST && !tradeRequestBudget.consume(0.5, 2)) return;
    if ((opcode == ClientOpcode::TRADE_REPLY || opcode == ClientOpcode::TRADE_OFFER ||
         opcode == ClientOpcode::TRADE_ACCEPT) && !tradeBudget.consume(10, 20)) return;
	if ((opcode == ClientOpcode::NPC_ACTION || opcode == ClientOpcode::QUEST_ACTION) && !npcBudget.consume(20, 30)) return;
	const uint32_t playerID = player->getID();

	switch (opcode) {
    case ClientOpcode::NPC_ACTION: {
        if (msg.getRemainingLength() < 23 || msg.getRemainingLength() > 279) break;
        const auto session = msg.get<uint32_t>(), revision = msg.get<uint32_t>(), request = msg.get<uint32_t>();
        const auto action = msg.getByte();
        const auto target = msg.get<uint32_t>(), amount = msg.get<uint32_t>();
        const auto text = msg.getString(256);
        if (msg.hasReadError() || msg.getRemainingLength() || action > 8) break;
        runAction([playerID, session, revision, request, action, target, amount, text]() {
            g_npcs.action(g_game.getPlayerByID(playerID), session, revision, request, action, target, amount, text);
        });
        break;
    }
    case ClientOpcode::TRADE_REQUEST: {
        const uint8_t target = msg.getByte();
        runAction([playerID, target]() { g_game.playerRequestTrade(playerID, target); });
        break;
    }
    case ClientOpcode::LOOK_AT: {
        const auto entityId = static_cast<ClientEntityId>(msg.get<uint32_t>());
        const uint8_t target = msg.getByte();
        runAction([playerID, entityId, target]() { g_game.playerLook(playerID, entityId, target); });
        break;
    }
    case ClientOpcode::TRADE_REPLY: {
        const uint32_t id = msg.get<uint32_t>();
        const uint8_t accept = msg.getByte();
        if (accept > 1) break;
        runAction([playerID, id, accept]() { g_game.playerReplyTrade(playerID, id, accept != 0); });
        break;
    }
    case ClientOpcode::TRADE_OFFER: {
        const uint32_t id = msg.get<uint32_t>();
        const uint32_t revision = msg.get<uint32_t>();
        const uint16_t iid = msg.get<uint16_t>();
        const uint8_t uid = msg.getByte();
        const uint8_t count = msg.getByte();
        runAction([playerID, id, revision, iid, uid, count]() { g_game.playerOfferTrade(playerID, id, revision, iid, uid, count); });
        break;
    }
    case ClientOpcode::TRADE_ACCEPT: {
        const uint32_t id = msg.get<uint32_t>();
        const uint32_t revision = msg.get<uint32_t>();
        runAction([playerID, id, revision]() { g_game.playerAcceptTrade(playerID, id, revision); });
        break;
    }
    case ClientOpcode::TRADE_CANCEL: {
        const uint32_t id = msg.get<uint32_t>();
        runAction([playerID, id]() { g_game.playerCancelTrade(playerID, id); });
        break;
    }
	case ClientOpcode::PING: {
		runAction([playerID]() { g_game.playerReceivePingBack(playerID); });
		// The client's own keepalive expects an answer. Hopped to the dispatcher
		// like every other handler here: the reply goes through the output
		// batch, and the batch is dispatcher-owned.
		runAction([thisPtr = getThis()]() { thisPtr->sendPingBack(); });
		break;
	}

	case ClientOpcode::CHAT_LOCAL: {
		// The only inbound string with no natural bound of its own. Capped at the
		// wire limit here and trimmed to the game's own limit in playerSay.
		std::string text = msg.getString(MAX_CHAT_MESSAGE_BYTES);
		if (msg.hasReadError() || msg.getRemainingLength() != 0) {
			break;
		}
		runAction([playerID, text = std::move(text)]() {
			g_game.playerSayChannel(playerID, ChatChannel::LOCAL, 0, text);
		});
		break;
	}

	case ClientOpcode::SEND_CHAT: {
		// [u8 channel][u8 target][str text]. An unknown channel is dropped here
		// rather than mapped to LOCAL: a client asking for a channel this
		// server does not have must not end up shouting in public.
		const uint8_t channelByte = msg.getByte();
		const uint8_t target = msg.getByte();
		std::string text = msg.getString(MAX_CHAT_MESSAGE_BYTES);
		if (msg.hasReadError() || msg.getRemainingLength() != 0) {
			break;
		}
		if (channelByte >= static_cast<uint8_t>(ChatChannel::COUNT)) {
			break;
		}
		const ChatChannel channel = static_cast<ChatChannel>(channelByte);
		runAction([playerID, channel, target, text = std::move(text)]() {
			g_game.playerSayChannel(playerID, channel, target, text);
		});
		break;
	}

	case ClientOpcode::MOVE: {
		const uint8_t moveMask = msg.getByte();
		runAction([playerID, moveMask]() {
			g_game.playerMove(playerID, moveMask);
		});
		break;
	}

	case ClientOpcode::ROTATE: {
		// Degrees on the wire, 0-359, quantised to the byte the entity record
		// carries. Kept as degrees rather than pre-quantised by the client so
		// the mapping stays server-owned and one implementation defines it.
		const uint16_t degrees = msg.get<uint16_t>();
		if (degrees >= 360) {
			break; // out of range: a real client cannot produce this
		}
		const uint8_t rot = static_cast<uint8_t>((degrees * 255) / 360);
		runAction([playerID, rot]() {
			g_game.playerTurn(playerID, rot);
		});
		break;
	}

	case ClientOpcode::FACE: {
		// Consumed and ignored, exactly as before: the facing the server acts on
		// comes from ROTATE. Listed so the size table stays honest about what
		// the client actually sends.
		msg.getByte();
		break;
	}

	case ClientOpcode::ATTACK_START: {
		runAction([playerID]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->handleMouseDown();
			}
		});
		break;
	}

	case ClientOpcode::ATTACK_STOP: {
		runAction([playerID]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->handleMouseUp();
			}
		});
		break;
	}

	case ClientOpcode::SPRINT: {
		const bool shiftVal = (msg.getByte() != 0);
		runAction([playerID, shiftVal]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->setShift(shiftVal);
			}
		});
		break;
	}

	case ClientOpcode::AIM: {
		const bool held = msg.getByte() != 0;
		runAction([playerID, held]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->setAimHeld(held);
			}
		});
		break;
	}

	case ClientOpcode::EQUIP_ITEM: {
		const uint16_t iid = msg.get<uint16_t>();
		msg.getByte();                              // count, unused here
		const uint32_t itemUid = msg.get<uint32_t>();
		msg.getByte();                              // ammo, unused here
		runAction([playerID, iid, itemUid]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->startEquipping(iid, itemUid);
			}
		});
		break;
	}

	case ClientOpcode::DROP_ITEM: {
		const uint16_t iid = msg.get<uint16_t>();
		const uint8_t count = msg.getByte();
		const uint32_t itemUid = msg.get<uint32_t>();
		msg.getByte();                              // ammo, unused here
		runAction([playerID, iid, count, itemUid]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				int8_t slot = p->inventory.findItemByUidSlot(itemUid, iid);
				if (slot != -1) {
					p->inventory.dropItem(slot, count);
				}
			}
		});
		break;
	}

	case ClientOpcode::STACK_ITEM: {
		const uint16_t dragIid = msg.get<uint16_t>();
		msg.getByte();                              // drag count, unused here
		const uint32_t dragUid = msg.get<uint32_t>();
		msg.getByte();                              // target count, unused here
		const uint32_t targetUid = msg.get<uint32_t>();
		runAction([playerID, dragIid, dragUid, targetUid]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->inventory.stackItem(dragUid, dragIid, targetUid);
			}
		});
		break;
	}

	case ClientOpcode::SPLIT_ITEM: {
		const uint16_t iid = msg.get<uint16_t>();
		msg.getByte();                              // count, unused here
		const uint32_t itemUid = msg.get<uint32_t>();
		runAction([playerID, iid, itemUid]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				int8_t slot = p->inventory.findItemByUidSlot(itemUid, iid);
				if (slot != -1) {
					p->inventory.splitItem(slot);
				}
			}
		});
		break;
	}

	case ClientOpcode::STORE_ITEM: {
		const uint16_t iid = msg.get<uint16_t>();
		const uint8_t count = msg.getByte();
		const uint32_t itemUid = msg.get<uint32_t>();
		const uint8_t ammo = msg.getByte();
		const uint8_t containerSlot = msg.getByte();
		runAction([playerID, iid, count, itemUid, ammo, containerSlot]() {
			g_game.playerStoreItem(playerID, iid, count, itemUid, ammo, containerSlot);
		});
		break;
	}

	case ClientOpcode::MOVE_CONTAINER_ITEM: {
		const uint8_t from = msg.getByte();
		const uint8_t to = msg.getByte();
		runAction([playerID, from, to]() {
			g_game.playerMoveContainerItem(playerID, from, to);
		});
		break;
	}

	case ClientOpcode::TAKE_ITEM: {
		const uint8_t slotIndex = msg.getByte();
		runAction([playerID, slotIndex]() {
			g_game.playerTakeItem(playerID, slotIndex);
		});
		break;
	}

	case ClientOpcode::TAKE_FROM_STATION: {
		const uint8_t slotIndex = msg.getByte();
		runAction([playerID, slotIndex]() {
			g_game.playerTakeFromStation(playerID, slotIndex);
		});
		break;
	}

	case ClientOpcode::PICK_UP_LOOT: {
		// ClientEntityId, not uint16: an id16 is 24 bits now, and truncating
		// one here would silently address a different entity (or none).
		const auto lootId = static_cast<ClientEntityId>(msg.get<uint32_t>());
		runAction([playerID, lootId]() {
			g_game.playerTakeLoot(playerID, lootId);
		});
		break;
	}

	case ClientOpcode::RELOAD: {
		runAction([playerID]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->startReload();
			}
		});
		break;
	}

	case ClientOpcode::PLACE_BUILDING: {
		const uint8_t buildRotate = msg.getByte();
		const uint16_t iBuild = msg.get<uint16_t>();
		const uint16_t jBuild = msg.get<uint16_t>();
		runAction([playerID, buildRotate, iBuild, jBuild]() {
			g_game.playerPlaceObject(playerID, buildRotate, iBuild, jBuild);
		});
		break;
	}

	case ClientOpcode::INTERACT: {
		const auto entityId = static_cast<ClientEntityId>(msg.get<uint32_t>());
		const uint8_t entityPid = msg.getByte();
		runAction([playerID, entityId, entityPid]() {
			g_game.playerOpenInteraction(playerID, entityId, entityPid);
		});
		break;
	}

	case ClientOpcode::CLOSE_CONTAINER: {
		runAction([playerID]() {
			g_game.playerCloseContainer(playerID, true);
		});
		break;
	}

	case ClientOpcode::CRAFT_AT_STATION: {
		const uint16_t iid = msg.get<uint16_t>();
		runAction([playerID, iid]() {
			g_game.playerStartCraft(playerID, iid, true); // station = true
		});
		break;
	}

	case ClientOpcode::CRAFT_BY_HAND: {
		const uint16_t iid = msg.get<uint16_t>();
		runAction([playerID, iid]() {
			g_game.playerStartCraft(playerID, iid, false); // station = false
		});
		break;
	}

	case ClientOpcode::CANCEL_CRAFT: {
		runAction([playerID]() {
			g_game.playerCancelCraft(playerID);
		});
		break;
	}

	case ClientOpcode::ADD_FUEL: {
		const uint8_t amount = msg.get<uint8_t>();
		runAction([playerID, amount]() {
			g_game.playerAddFuel(playerID, amount);
		});
		break;
	}

	case ClientOpcode::UNLOCK_SKILL: {
		const uint16_t iid = msg.get<uint16_t>();
		runAction([playerID, iid]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				const ItemData* idata = ItemManager::getInstance().getItemData(iid);
				if (!idata || !(idata->isCraftable || idata->requiresUnlock)) {
					return;
				}
				if (p->hasSkill(iid)) {
					return;
				}
				if (idata->crafting.prerequisiteIid != 0 && !p->hasSkill(idata->crafting.prerequisiteIid)) {
					return;
				}
				const uint32_t cost = idata->crafting.skillCost;
				if (p->getSkillPoints() >= cost && p->getLevel() >= idata->crafting.requiredLevel) {
					if (cost > 0) {
						p->spendSkillPoints(cost);
					}
					p->unlockSkill(iid);
					p->sendBoughtSkill(iid);
					if (idata->bagSlots > 0) {
						p->sendFullInventory();
					}
				}
			}
		});
		break;
	}

	case ClientOpcode::CREATE_TEAM: {
		std::string name = msg.getString(MAX_CLAN_NAME_BYTES);
		if (msg.hasReadError() || msg.getRemainingLength() != 0) {
			break;
		}
		runAction([playerID, name = std::move(name)]() {
			g_game.playerCreateClan(playerID, name);
		});
		break;
	}

	case ClientOpcode::DELETE_TEAM: {
		runAction([playerID]() {
			g_game.playerDeleteClan(playerID);
		});
		break;
	}

	case ClientOpcode::REQUEST_TEAM_JOIN: {
		const uint8_t clanId = msg.getByte();
		runAction([playerID, clanId]() {
			g_game.playerRequestJoinClan(playerID, clanId);
		});
		break;
	}

	case ClientOpcode::ACCEPT_TEAM_JOIN: {
		const uint32_t applicantGuid = msg.get<uint32_t>();
		runAction([playerID, applicantGuid]() {
			g_game.playerAcceptJoinClan(playerID, applicantGuid);
		});
		break;
	}

	case ClientOpcode::KICK_FROM_TEAM: {
		const uint32_t memberGuid = msg.get<uint32_t>();
		runAction([playerID, memberGuid]() {
			g_game.playerKickClanMember(playerID, memberGuid);
		});
		break;
	}

	case ClientOpcode::LOCK_TEAM: {
		runAction([playerID]() {
			g_game.playerLockClan(playerID);
		});
		break;
	}

	case ClientOpcode::UNLOCK_TEAM: {
		runAction([playerID]() {
			g_game.playerUnlockClan(playerID);
		});
		break;
	}

	case ClientOpcode::LEAVE_TEAM: {
		runAction([playerID]() {
			g_game.playerLeaveClan(playerID);
		});
		break;
	}

	case ClientOpcode::INVITE_TO_TEAM: {
		const uint8_t targetGuid = msg.getByte();
		runAction([playerID, targetGuid]() {
			g_game.playerInviteToClan(playerID, targetGuid);
		});
		break;
	}

	case ClientOpcode::ACCEPT_TEAM_INVITE: {
		const uint8_t clanId = msg.getByte();
		runAction([playerID, clanId]() {
			g_game.playerAcceptClanInvite(playerID, clanId);
		});
		break;
	}

	case ClientOpcode::SET_PRIVATE_MESSAGES: {
		const uint8_t policy = msg.getByte();
		if (policy > static_cast<uint8_t>(PrivateMessagePolicy::NOBODY)) break;
		runAction([playerID, policy]() {
			if (Player* p = g_game.getPlayerByID(playerID)) {
				p->privateMessages = static_cast<PrivateMessagePolicy>(policy);
			}
		});
		break;
	}

	case ClientOpcode::QUEST_ACTION: {
		const uint16_t questId = msg.get<uint16_t>();
		const uint8_t action = msg.getByte();
		runAction([playerID, questId, action]() {
			g_quests.action(g_game.getPlayerByID(playerID), questId, action);
		});
		break;
	}

	case ClientOpcode::FIT_WEAPON_MOD: {
		const uint8_t weaponUid = msg.getByte();
		const uint8_t slot = msg.getByte();
		const bool fit = msg.getByte() != 0;
		const uint8_t modUid = msg.getByte();
		runAction([playerID, weaponUid, slot, fit, modUid]() {
			g_game.playerWeaponMod(playerID, weaponUid, slot, fit, modUid);
		});
		break;
	}

	case ClientOpcode::BLOCK_PLAYER: {
		const uint8_t targetGuid = msg.getByte();
		const bool blocked = msg.getByte() != 0;
		runAction([playerID, targetGuid, blocked]() {
			g_game.playerBlock(playerID, targetGuid, blocked);
		});
		break;
	}

	}
}

// The staging path, for messages whose length is not known before they are
// written.
//
// Most senders no longer come through here: sendMessage() derives its payload
// size from its arguments and writes the bytes straight into the batch, which
// avoids building a 24 KB NetworkMessage on the stack to hold three bytes and
// then memcpying them. What is left are the messages that genuinely cannot do
// that -- the ones that loop over an inventory, a craft queue, a roster or a
// city list, or that end in a string. beginMessage() needs the length UP FRONT
// because the sub-header goes down before the body, so for those a staging
// buffer is the right tool rather than a leftover: count first, then write, is
// how flushUpdates does it, and it is only worth the arithmetic on a path that
// runs every tick.
void ProtocolGame::writeToOutputBuffer(const NetworkMessage& msg)
{
	// Coalescing used to be illegal here: client.js dispatched on ui8[0] with no
	// length walk, so a second message in the same frame parsed as entity-record
	// bytes. It now understands ServerOpcode::BATCH, which is a length-prefixed
	// envelope, so this is simply the batched path -- see queueMessage.
	queueMessage(msg);
}

// An empty ENTITY_UPDATES frame is a no-op to the client (len = 0, no records); its only
// job is resetting the client's disconnect watchdog. Any real frame does that
// too, so a client receiving updates needs none of these at all.
void ProtocolGame::sendKeepAlive()
{
	const int64_t now = OTSYS_TIME();

	if (consumeSentFlag()) {
		lastKeepAlive = now;
		return;
	}
	if (now - lastKeepAlive < KEEPALIVE_IDLE_MS) {
		return;
	}
	lastKeepAlive = now;

	sendMessage(ServerOpcode::ENTITY_UPDATES, static_cast<uint8_t>(0x00));
}

// The answer to a client keepalive.
//
// This used to send the literal byte 0x1E, which is 30 -- and 30 is
// ServerOpcode::LIFE_INCREASE, which client.js dispatches to onLifeIncrease().
// The client simulates its own gauges from direction opcodes, so every
// keepalive round-trip was telling it to start filling the player's life bar,
// and it stopped only when some later message happened to correct it. It has
// its own opcode now; the collision was invisible because both ends "worked".
void ProtocolGame::sendPingBack()
{
	sendSimpleOpcode(ServerOpcode::PONG);
}

void ProtocolGame::sendMapSize()
{
	if (!player) return;

	// The second field is a PAD byte, not a spare field. client.js reads this
	// through `new Uint16Array(data)`, which can only address EVEN byte offsets
	// -- so a uint16 immediately after a one-byte opcode is unreachable from the
	// client's own parser. The other older layouts that carry 16-bit values
	// (the handshake, the leaderboard) are laid out the same way.
	//
	// Tiles rather than world units: it is what the client actually allocates
	// with, and 255 tiles is the ceiling anyway (MapSize::MAX_TILES), so 16 bits
	// is room to spare rather than a constraint.
	sendMessage(ServerOpcode::MAP_SIZE,
		static_cast<uint8_t>(0),
		static_cast<uint16_t>(MapSize::tilesX()),
		static_cast<uint16_t>(MapSize::tilesY()));
}

void ProtocolGame::sendCitiesLocation()
{
	if (!player) return;

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::CITY_LOCATIONS));

	// Pad byte. Every coordinate below is a uint16 and client.js reads them
	// through `new Uint16Array(data)`, which can only address EVEN offsets --
	// so a uint16 immediately after a one-byte opcode is unreachable from the
	// client's own parser. Same layout rule as the handshake and MAP_SIZE.
	//
	// These were single BYTES until 2026-08-09, which is what capped the map at
	// 255 tiles: tile 256 wrapped to 0 and pinned its marker to the corner.
	msg.addByte(0);

	const auto& cities = g_structures.getCityLocations();
	const auto& houses = g_structures.getHouseLocations();

	// How many of the pairs that follow are CITIES. The rest are houses.
	//
	// There used to be exactly one city slot, always sent even when no city was
	// built -- with a 65535 sentinel meaning "none", because the houses after it
	// are positional and dropping the pair would shift every one of them and
	// draw the first house with the city icon. A count says the same thing
	// without a magic value (no cities is simply 0) and lifts the limit of one:
	// structure counts scale with map size now, so a 655x655 world has around
	// nineteen cities, and eighteen of them used to be invisible on the minimap.
	//
	// Cities are written FIRST so the split is a single number rather than a
	// per-pair flag.
	//
	// The cap is real, not defensive theatre: NetworkMessage::add silently drops
	// anything past capacity, so an overlong list would truncate mid-pair and
	// the client would read a house's Y as an X. At 4 bytes a pair this leaves
	// generous room inside MAX_PROTOCOL_BODY_LENGTH.
	static constexpr size_t MAX_MARKERS = 4000;
	size_t cityCount = cities.size();
	size_t houseCount = houses.size();
	if (cityCount + houseCount > MAX_MARKERS) {
		// Cities first: they are the landmarks worth keeping if anything has to
		// go, and dropping from the tail keeps the count field honest.
		cityCount = std::min(cityCount, MAX_MARKERS);
		houseCount = MAX_MARKERS - cityCount;
		fmt::print(fg(fmt::color::orange),
			">> [minimap] {} structures is more than the {} markers CITY_LOCATIONS can "
			"carry; the surplus houses are not drawn.\n",
			cities.size() + houses.size(), MAX_MARKERS);
	}

	msg.add<uint16_t>(static_cast<uint16_t>(cityCount));

	// Y first, then X, as the client expects.
	for (size_t i = 0; i < cityCount; ++i) {
		msg.add<uint16_t>(static_cast<uint16_t>(cities[i].y / TILE_SIZE));
		msg.add<uint16_t>(static_cast<uint16_t>(cities[i].x / TILE_SIZE));
	}
	for (size_t i = 0; i < houseCount; ++i) {
		msg.add<uint16_t>(static_cast<uint16_t>(houses[i].y / TILE_SIZE));
		msg.add<uint16_t>(static_cast<uint16_t>(houses[i].x / TILE_SIZE));
	}

	writeToOutputBuffer(msg);
}

void ProtocolGame::onRecvFirstMessage(NetworkMessage& msg)
{
	if (g_game.getGameState() == GAME_STATE_SHUTDOWN) {
		disconnectClient(DisconnectReason::SHUTTING_DOWN);
		return;
	}

	if (msg.getRemainingLength() > 0 &&
	    static_cast<ClientOpcode>(msg.peekByte()) == ClientOpcode::REQUEST_CONTENT) {
		msg.getByte();
		handleContentRequest(msg);
		return;
	}

	LoginData data;
	if (!parseFirstMessage(msg, data)) {
		disconnectClient(DisconnectReason::INVALID_LOGIN);
		return;
	}

	auto ip = getIP();
	if (const auto& banInfo = IOBan::getIpBanInfo(ip)) {
		const std::string until = banInfo->expiresAt == 0
			? std::string("Permanent")
			: fmt::format("Until {:s}", formatDateShort(banInfo->expiresAt));
		disconnectClient(DisconnectReason::IP_BANNED,
			fmt::format("{:s}. Banned by {:s}.\nReason: {:s}", until, banInfo->bannedBy, banInfo->reason));
		return;
	}

	if (data.version != 0 && (data.version < CLIENT_VERSION_MIN || data.version > CLIENT_VERSION_MAX)) {
		sendAlertAndDisconnect(fmt::format("Only clients with protocol {:s} allowed!", CLIENT_VERSION_STR));
		return;
	}

	if (g_game.getGameState() == GAME_STATE_STARTUP) {
		disconnectClient(DisconnectReason::STARTING_UP);
		return;
	}

	if (g_game.getGameState() == GAME_STATE_MAINTAIN) {
		disconnectClient(DisconnectReason::MAINTENANCE);
		return;
	}

	data.identity = resolveLoginIdentity(data.nickname, data.password, data.accountTicket, std::time(nullptr));
	// A player who requested account play must explicitly choose guest play
	// if the ticket is refused. Never create an untracked guest on their behalf.
	if (!data.accountTicket.empty() && data.identity.accountId == 0) {
		disconnectClient(DisconnectReason::ACCOUNT_REQUIRED, data.identity.notice);
		return;
	}

	// !close. Checked here rather than in login() so a rejected player never
	// reaches character creation. alwaysLogin groups (and adminPassword, which
	// gets the top group) are let through -- otherwise closing the server would
	// lock out the people who can reopen it.
	if (g_game.getGameState() == GAME_STATE_CLOSED &&
	    !g_groups.getOrDefault(data.identity.groupId).has(GroupFlag::AlwaysLogin)) {
		disconnectClient(DisconnectReason::SERVER_CLOSED);
		return;
	}

	login(data); // Connection dispatches this entire callback on the game thread.
}

// The login frame:
//
//     [u8 protocolIdentifier = 30][u16 protocolVersion][str token][u32 tokenId]
//     [u32 playerId][str nickname][u8 adBlocker][str password][str accountTicket]
//
// The leading byte is NOT a ClientOpcode. It selects which protocol this socket
// speaks and is consumed by ServicePort::make_protocol before this runs, so
// decoding starts at the version -- see the note at the end of ClientOpcode.
//
// The version comes FIRST of the fields we read, so a client from the
// wrong build is diagnosed before any of its remaining fields are trusted --
// the layout after this point is exactly what a version bump is free to change.
//
// Three fields the JSON array carried are simply gone rather than reserved:
// the leading `dat` build number (never read), `state` (never read), and the
// skin at index 6. The skin is server state, owned by the equipped wearable
// (Player::equipItem), so a client must not be able to pick its own appearance
// at login; it was already ignored, and now it is not on the wire to be
// tempting. New characters start at skin 0 and a reconnecting player keeps
// whatever skin they had in the world.
bool ProtocolGame::parseFirstMessage(NetworkMessage& msg, LoginData& out)
{
	// Read before anything else so a mismatched build is refused on the version
	// rather than on whatever its differently-shaped payload happens to decode
	// to. The caller compares it against CLIENT_VERSION_MIN/MAX.
	out.version = msg.get<uint16_t>();

	// The caps are the point of reading these through getString: the real client
	// never exceeds them, so a longer one is a modified client trying to bloat
	// state the server keeps (tokens live in the kit-reward maps permanently)
	// or the login broadcast every player receives. Over-length is REFUSED here
	// rather than truncated -- a truncated token is still a token, and would be
	// stored as if the client had sent it.
	out.token = msg.getString(MAX_LOGIN_TOKEN_LENGTH);
	// u32, not u64: the server only ever mints `1000 + slotId` and the client
	// echoes it back, and the handshake already narrows it to 16 bits on the way
	// out. Four bytes is room to spare either way.
	out.tokenId = msg.get<uint32_t>();
	out.playerId = static_cast<uint8_t>(msg.get<uint32_t>());
	out.nickname = msg.getString(MAX_NICKNAME_LENGTH);
	out.adBlocker = msg.getByte();
	out.password = msg.getString(MAX_LOGIN_PASSWORD_LENGTH);
	out.accountTicket = msg.getString(MAX_ACCOUNT_TICKET_LENGTH);

	if (msg.hasReadError() || msg.getRemainingLength() != 0) {
		return false;
	}

	// Empty is legal on the wire and means "the client has no stored token yet";
	// the server mints one so every session has an identity.
	if (out.token.empty()) {
		out.token = makeGuestSessionToken();
	}
	// An empty nickname is a guest who chose not to have one: it stays empty,
	// and the client draws no name over them.
	return true;
}

void ProtocolGame::sendDisconnectReason(DisconnectReason reason, const std::string& detail) const
{
	// Straight out rather than through the batch: a disconnect() may follow
	// immediately, and a batched message would still be sitting in the buffer
	// when it did. flushOutputBatch first so anything already queued keeps its
	// order ahead of this.
	flushOutputBatch();

	NetworkMessage msg;
	writeDisconnectReason(msg, reason, detail);

	auto out = tfs::net::make_output_message();
	out->append(msg);
	send(out);
}

void ProtocolGame::disconnectClient(DisconnectReason reason, const std::string& detail) const
{
	sendDisconnectReason(reason, detail);
	disconnect();
}

void ProtocolGame::sendAlertAndDisconnect(const std::string& text) const
{
	flushOutputBatch();

	NetworkMessage msg;
	msg.addByte(static_cast<uint8_t>(ServerOpcode::ALERT));
	msg.addString(text);

	auto out = tfs::net::make_output_message();
	out->append(msg);
	send(out);

	disconnect();
}

void ProtocolGame::onConnect()
{
	sendContentManifest();
}

void ProtocolGame::sendContentManifest()
{
	const std::string manifest = contentexport::ContentManager::getInstance().getManifestJson();
	if (manifest.empty()) return;
	std::vector<uint8_t> frame(1 + manifest.size());
	frame[0] = static_cast<uint8_t>(ServerOpcode::CONTENT_MANIFEST);
	std::memcpy(frame.data() + 1, manifest.data(), manifest.size());
	if (auto conn = getConnection()) {
		conn->sendBinary(std::move(frame));
	}
}

void ProtocolGame::sendContentTable(const std::string& name)
{
	const std::string tableJson = contentexport::ContentManager::getInstance().getTableJson(name);
	if (tableJson.empty()) return;
	std::vector<uint8_t> frame(1 + tableJson.size());
	frame[0] = static_cast<uint8_t>(ServerOpcode::CONTENT_TABLE);
	std::memcpy(frame.data() + 1, tableJson.data(), tableJson.size());
	if (auto conn = getConnection()) {
		conn->sendBinary(std::move(frame));
	}
}

void ProtocolGame::handleContentRequest(NetworkMessage& msg)
{
	std::string jsonStr = msg.getString();
	if (jsonStr.empty()) return;
	try {
		boost::json::value val = boost::json::parse(jsonStr);
		if (!val.is_array()) return;
		for (const auto& item : val.as_array()) {
			if (item.is_string()) {
				sendContentTable(std::string(item.as_string()));
			}
		}
	} catch (const std::exception& e) {
		fmt::print(">> [ProtocolGame] Invalid REQUEST_CONTENT payload: {}\n", e.what());
	}
}

void ProtocolGame::sendContentPatch(const contentexport::ContentPatch& patch)
{
	boost::json::object obj;
	obj["name"] = patch.name;
	obj["fromVersion"] = patch.fromVersion;
	obj["toVersion"] = patch.toVersion;
	obj["hash"] = patch.hash;
	obj["patch"] = patch.patch;
	std::string jsonStr = boost::json::serialize(obj);
	std::vector<uint8_t> frame(1 + jsonStr.size());
	frame[0] = static_cast<uint8_t>(ServerOpcode::CONTENT_PATCH);
	std::memcpy(frame.data() + 1, jsonStr.data(), jsonStr.size());
	if (auto conn = getConnection()) {
		conn->sendBinary(std::move(frame));
	}
}

