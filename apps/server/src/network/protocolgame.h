// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_PROTOCOLGAME_H
#define FS_PROTOCOLGAME_H

#include "gameplay/creature.h"
#include "gameplay/weapon_mod_types.h"
#include "network/protocol.h"
#include "network/outputmessage.h" // sendMessage writes straight into the batch buffer
#include "core/perf.h"          // g_netperf, counted per MESSAGE not per frame
#include "core/tasks.h"
#include "network/opcodes.h"
#include "core/security_budget.h"
#include "network/login_identity.h"

#include <array>
#include <type_traits>

class Game;
class NetworkMessage;
class Player;
class Object;
class ProtocolGame;

namespace contentexport {
	struct ContentPatch;
}

enum SessionEndTypes_t : uint8_t
{
	SESSION_END_LOGOUT = 0,
	SESSION_END_UNKNOWN = 1,
	SESSION_END_FORCECLOSE = 2,
	SESSION_END_UNKNOWN2 = 3,
};

using ProtocolGame_ptr = std::shared_ptr<ProtocolGame>;

extern Game g_game;

class ProtocolGame final : public Protocol
{
public:
	// static protocol information
	enum
	{
		server_sends_first = true
	};
	enum
	{
		protocol_identifier = 30
	};
	enum
	{
		use_checksum = false
	};
	static const char* protocol_name() { return "gameworld protocol"; }

	// rawMessages from the very first frame, not from login().
	//
	// It suppresses the 2-byte length header Protocol::onSendMessage would
	// otherwise prepend, and this protocol's whole wire contract is that the
	// first byte of a frame IS the opcode -- client.js dispatches on `ui8[0]`.
	// It used to be set in login(), which is only reached AFTER the version,
	// ban and server-state checks pass, so every frame disconnectClient() sends
	// on the way to rejecting someone went out with a length header and reached
	// the client as an unknown opcode. That was invisible while the rejection
	// notice was JSON (it went out through internalSendJSON, which never calls
	// onSendMessage); making it binary is what exposed it.
	explicit ProtocolGame(Connection_ptr connection) : Protocol(connection) { setRawMessages(true); }
	uint16_t getVersion() const { return version; }

	// Everything the login frame carries. See ProtocolGame::parseFirstMessage for
	// the wire layout and for the three fields that used to be here and are now
	// neither sent nor read (`protocol`, `state`, and the client-claimed skin).
	struct LoginData
	{
		uint16_t version = 0;
		std::string token;
		uint64_t tokenId = 0;
		uint8_t playerId = 0;
		std::string nickname;
		uint8_t adBlocker = 0;
		std::string password;
		std::string accountTicket; // empty = guest
		LoginIdentity identity;    // filled in by onRecvFirstMessage
	};

	void login(const LoginData& data);
	void reconnect(Player* foundPlayer, const LoginIdentity& identity);
	void createNewPlayer(const LoginData& data);

	void flushUpdates();
	
	void sendHandshake();
	void sendGauges();
	// The five (max, speedInc, speedDec) triples, in GaugeSlot order. Sized from
	// the same constant GAUGE_STATE's bit pairs are, so the two gauge messages
	// cannot disagree about how many gauges there are.
	void sendModdedGaugesValues(const std::array<uint16_t, GAUGE_SLOT_COUNT * GAUGE_RATE_FIELD_COUNT>& rates);
	// The whole world clock: cycle length and where in it we are. Sent at login,
	// at each day/night boundary and periodically in between (Game::
	// broadcastWorldTime). Replaced sendDay/sendNight, which announced an edge
	// and carried no time -- see ServerOpcode::WORLD_TIME.
	void sendWorldTime();

	// All five gauge directions at once, two bits each. Built by
	// Player::packGaugeDirections; see ServerOpcode::GAUGE_STATE for why this
	// is one message rather than the fifteen edges it replaced.
	void sendGaugeState(uint16_t packedDirections);

	void sendPlayerStamina(uint8_t value);
	void sendFullInventory();
	void sendInventorySlot(uint16_t iid, uint8_t count, uint32_t uid, uint8_t ammo);
	void sendClearInventorySlot(uint32_t uid);
	// ITEM_MODS: one inventory item's complete fitted mods, keyed by the uid's low byte.
	void sendItemMods(uint32_t uid, const WeaponMods& mods);
	// AIM_STATE: aiming turned on or off, and the viewport the aimed box is built from.
	void sendAimState(bool active, uint16_t viewX, uint16_t viewY);
	void sendSelectedItem(uint16_t iid);
	
	void sendPlayerXp(uint16_t xp);
	void sendPlayerXpSkill();
	void sendScore(uint32_t score);
	static uint16_t deflateNumber(uint32_t n);
	void sendKarma(uint8_t clientIcon);
	void sendShakeExplosionState(uint8_t shake);
	void sendBoughtSkill(uint16_t iid);
	void sendStartInteraction(uint16_t delayMultiplier);
	void sendInterruptInteraction();
	void sendBlueprint(uint16_t iid);
	void sendLostStation();
	void sendOpenStation(uint8_t area, uint8_t isLogin);
	void sendNewFuelValue(uint8_t value, uint32_t remainingMs);
	void sendWrongTool(uint8_t toolIid);
	void sendFullChest(Object* obj, bool firstOpen = false);
	void sendNotification(uint8_t playerPid, uint8_t type, uint8_t level);

	// The hit/heal flash for ONE client. The flash normally reaches everyone who
	// can see the target (Game::broadcastPlayerHit/Heal); these exist for the
	// case where only the target themself is told -- see the
	// showEnvironmentDamageToOthers gate in Player::changeHealth.
	void sendPlayerHit(uint8_t playerPid, uint8_t angle);
	void sendPlayerHeal(uint8_t playerPid);
	void sendDamageIndicator(uint16_t x, uint16_t y, int16_t amount, uint8_t pct);
	void sendStoleYourSession();
	// One chat line (ServerOpcode::CHAT_CHANNEL). `from` is the speaker, or
	// CHAT_SYSTEM_PID for a line the server wrote; `peer` is the other party of
	// a PRIVATE conversation and 0 otherwise.
	void sendChatChannel(ChatChannel channel, uint8_t from, uint8_t peer, uint8_t flags, const std::string& text);
	// The reply to an admin command: a system line in the ADMIN channel, so it
	// never lands in the speech feed.
	void sendAdminReply(const std::string& message);
	// A SERVER_LOG event for this client alone (broadcasts go through
	// Game::broadcastServerLog and buildServerLogMessage).
	void sendServerLog(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text);
	// CHAT_ACCESS: which channels this player may write to, from its admin flag.
	void sendChatAccess();
	// GROUPS: badge-carrying groups. Sent at login and after !reload=groups.
	void sendGroups();
	static void buildChatChannelMessage(ChatChannel channel, uint8_t from, uint8_t peer, uint8_t flags, const std::string& text, NetworkMessage& msg);
	static void buildServerLogMessage(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text, NetworkMessage& msg);

	// One player's identity: name, skin, ghoul flag. Sent for every player
	// already online when this client logs in, and broadcast to everyone else
	// when it does.
	void sendPlayerInfo(const Player& target);
	static void buildPlayerInfoMessage(const Player& target, NetworkMessage& msg);

	// A clan came into existence. Sent for every existing clan at login, and
	// broadcast when one is created.
	void sendTeamCreated(uint8_t clanId, uint32_t leaderGuid, const std::string& name);
	static void buildTeamCreatedMessage(uint8_t clanId, uint32_t leaderGuid, const std::string& name,
	                                    NetworkMessage& msg);
	// TEAM_LOCKED: whether a clan takes join requests. Broadcast on lock and
	// unlock, and sent at login for every locked clan.
	static void buildTeamLockedMessage(uint8_t clanId, bool locked, NetworkMessage& msg);
	void sendCitiesLocation();

	// The world's size in tiles. See ServerOpcode::MAP_SIZE for the ordering
	// requirement -- this has to arrive before the client is told about anything
	// standing on the map.
	void sendMapSize();
	// The poison screen distortion, self only. Fire-once by construction:
	// client.js ignores this while its own animation is running and has no
	// handler that stops one, so it can be neither refreshed nor cancelled.
	// The three drug-skin opcodes are NOT here -- see Player::syncConditionVisual.
	void sendPoisened(uint8_t delaySec);

	// --- Ghoul mode round HUD ---------------------------------------------
	//
	// The countdown to the lock, in TENTHS OF A MINUTE: client.js multiplies the
	// byte by 10000ms (onDramaticChrono), so one unit is ten seconds and the
	// longest expressible countdown is 2550s -- 42.5 minutes. The client then
	// runs the clock down itself, frame by frame, so this is a correction rather
	// than a tick and does not need re-sending often.
	void sendDramaticChrono(uint32_t remainingMs);

	// One player is out of the round. The client keeps its own `playerAlive`
	// count from these and from the ghoul flags in the handshake, and that count
	// is what the ghouls' HUD displays and what gates the last-few reveal.
	void sendOtherDie(uint8_t pid);

	void parsePacket(NetworkMessage& msg) override;
	void writeToOutputBuffer(const NetworkMessage& msg);

	// --- Output batching ---------------------------------------------------
	//
	// Every binary message for this client goes through here and is packed into
	// one ServerOpcode::BATCH frame, flushed at the end of the tick. At 250
	// clients in combat this is ~2.9 WebSocket frames per client per tick
	// collapsing to ~1, and ~60% of those frames were three-byte hit flashes.
	//
	// The invariant that makes it safe: NOTHING may reach this client's socket
	// without passing through the batch, or it overtakes what is queued. Both
	// send paths honour that -- Protocol::sendJSON flushes first, and the only
	// binary sender is flushBatch itself.
	//
	// Dispatcher thread only. Packet handlers hop to the dispatcher before they
	// touch a player, so the batch needs no lock.
	void queueMessage(const NetworkMessage& msg);
	void flushOutputBatch() const override;

	// Single-byte opcode helper shared by all trivial state-signal senders.
	void sendSimpleOpcode(ServerOpcode op) { sendMessage(op); }

	// One complete fixed-size message, written STRAIGHT INTO the output batch.
	//
	// Two things this fixes over the `NetworkMessage msg; ...; writeToOutputBuffer(msg)`
	// pattern it replaces:
	//
	// 1. NetworkMessage is a 24,590-byte object (`std::array<uint8_t,
	//    NETWORKMESSAGE_MAXSIZE> buffer`). Every sender built one ON THE STACK to
	//    hold two or three bytes, which on MSVC means a __chkstk probe across
	//    seven pages per call, and then memcpy'd the handful of bytes into the
	//    batch anyway. This writes them once, in place.
	// 2. The payload size is DERIVED from the arguments rather than passed
	//    alongside them, so it cannot disagree with what is actually written.
	//    beginMessage's contract is that `payloadBytes` is a promise -- the
	//    sub-header goes down before the body, so a sender that miscounts shifts
	//    every later message in the envelope and the client silently misparses a
	//    whole tick. That mistake is now unrepresentable.
	//
	// Arguments must be exact-width integers (uint8_t / uint16_t / uint32_t):
	// each is memcpy'd at sizeof, so an `int` literal would silently put four
	// bytes on the wire. Callers cast explicitly, which also makes each field's
	// wire width visible at the call site.
	//
	// Little-endian, tightly packed, no alignment padding -- but mind the
	// Uint16Array rule for opcodes below 76: those handlers read the frame
	// through a 16-bit view and can only address EVEN offsets, so they need an
	// explicit pad byte after the opcode. Opcodes 76+ are read with a DataView
	// and need none. See the notes in opcodes.h.
	template <typename... Args>
	void sendMessage(ServerOpcode op, Args... args)
	{
		static_assert((std::is_integral_v<Args> && ...),
			"wire fields must be integers");
		static_assert(((sizeof(Args) == 1 || sizeof(Args) == 2 || sizeof(Args) == 4) && ...),
			"wire fields must be exact-width: cast to uint8_t/uint16_t/uint32_t");

		constexpr uint16_t payloadBytes = static_cast<uint16_t>(1 + (sizeof(Args) + ... + 0));

		g_netperf.recordQueuedOpcode(static_cast<uint8_t>(op));
		OutputMessage& out = beginMessage(payloadBytes);
		out.addByte(static_cast<uint8_t>(op));
		(out.add(args), ...);
		endMessage();
	}

	void release() override;
	void detachPlayerSession(); // drop the player pointer without removing the player from the game
	void sendPlayerDie(uint16_t kills);

	// Sends DISCONNECT_REASON, then disconnects: every refused login, and every
	// kick through Game::kickPlayer. detail is only variable data (ban text).
	void disconnectClient(DisconnectReason reason, const std::string& detail = {}) const;
	// DISCONNECT_REASON without closing: the shutdown notice, sent right
	// before the process stops and takes every socket with it.
	void sendDisconnectReason(DisconnectReason reason, const std::string& detail = {}) const;
	// ALERT text, then disconnect. Only for a protocol-version mismatch: a
	// client of another version cannot be trusted to decode DISCONNECT_REASON.
	void sendAlertAndDisconnect(const std::string& text) const;

	void sendContentManifest();
	void sendContentTable(const std::string& name);
	void sendContentPatch(const contentexport::ContentPatch& patch);

private:
	ProtocolGame_ptr getThis() { return std::static_pointer_cast<ProtocolGame>(shared_from_this()); }

	// Reserves `payloadBytes` in the batch, writes the sub-header and returns
	// the buffer to write the body into. Flushes first if the message would not
	// fit, so the caller's write can never be truncated mid-message.
	//
	// `payloadBytes` is a PROMISE, not a hint: the sub-header goes down before
	// the body, so writing a different number of bytes than declared shifts
	// every later message in the envelope. Pair every call with endMessage().
	OutputMessage& beginMessage(uint16_t payloadBytes) const;

	// The tail every beginMessage() caller owes. `batchOutputFrames = false` is
	// the A/B lever and has to reproduce the pre-batching wire byte for byte,
	// which means one frame per message -- so a sender that skips this leaves
	// its message sitting in an envelope the lever was supposed to have
	// disabled. It was open-coded in queueMessage and flushUpdates; it is here
	// so a new direct-write sender cannot quietly omit it.
	void endMessage() const;

	// Envelope opcode + reserved byte, then a u16 length per message.
	static constexpr uint16_t BATCH_HEADER_BYTES = 2;
	static constexpr uint16_t BATCH_SUBHEADER_BYTES = 2;

	mutable OutputMessage_ptr batch;
	mutable uint32_t batchedMessages = 0;


	// Shared login/reconnect setup: sends nickname list, per-player info, and initial state packets.
	void sendLoginSetup();

	void onRecvFirstMessage(NetworkMessage& msg) override;
	void onConnect() override;
	bool parseFirstMessage(NetworkMessage& msg, LoginData& out);
	void handleContentRequest(NetworkMessage& msg);

	void sendKeepAlive();
	void sendPingBack();


	friend class Player;
	Player* player = nullptr;

	uint32_t eventConnect = 0;
	uint16_t version = CLIENT_VERSION_MIN;

	bool debugAssertSent = false;
	bool acceptPackets = false;
	bool isReconnecting = false;
	ActionBudget chatBudget, inventoryBudget, craftBudget, pingBudget, tradeBudget, tradeRequestBudget, npcBudget, lookBudget;

	int64_t lastKeepAlive = 0; // last time anything reached this client

	// Last time anything arrived FROM this client. Touched only in parsePacket,
	// i.e. only on the game dispatcher, so it needs no synchronisation — which is
	// why it lives here and not on Player. See the gap check there.
	int64_t lastClientPacket = 0;
};

// [u8 n]([u8 slot][u16 modIid])*n -- the fitted-mods list ITEM_MODS, FULL_CHEST
// and TRADE_STATE share. Empty slots are left out.
inline void appendWeaponMods(NetworkMessage& msg, const WeaponMods& mods)
{
	uint8_t n = 0;
	for (uint16_t iid : mods.iid) n += iid != 0 ? 1 : 0;
	msg.addByte(n);
	for (size_t i = 0; i < MOD_SLOT_COUNT; ++i) {
		if (mods.iid[i] == 0) continue;
		msg.addByte(static_cast<uint8_t>(i));
		msg.add<uint16_t>(mods.iid[i]);
	}
}

#endif // FS_PROTOCOLGAME_H
