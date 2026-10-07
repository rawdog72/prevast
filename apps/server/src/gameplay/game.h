// Copyright (c) 2023 The Forgotten Server Authors
// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_GAME_H
#define FS_GAME_H

#include "gameplay/player.h"
#include "core/position.h"
#include "world/map.h"
#include "world/mapsize.h"
#include "world/worldclock.h"
#include "gameplay/trade.h"
#include "network/opcodes.h"
#include "gameplay/npc.h"
#include "world/scenario_world.h"

#include <span>

class ServiceManager;
class Creature;
class Projectile;
class Loot;
class Agent;
struct AgentAbility;
struct AgentData;
struct AgentTarget;
struct ProjectileData;
struct EquipableData;
struct ObjectData;
struct ObjectStage;
struct StageLootSpawn;

namespace boost {
namespace json {
	class value;
}
}

// How many tiles an object's footprint reaches from its centre tile on each
// axis, after `rotation` swaps the axes. 0/0 for anything that fits one tile.
//
// Declared here rather than kept file-local to game.cpp because the map
// importer has to clear a multi-tile object's WHOLE footprint before placing
// it; clearing only the anchor tile leaves a smelter overlapping whatever sits
// beside it, which the collision code then has no way to resolve.
void getFootprintTileReach(const ObjectData* od, uint8_t rotation, int32_t& reachX, int32_t& reachY);

struct GaugeMode {
	uint16_t max = 255;
	uint16_t speedInc = 0;
	uint16_t speedDec = 0;

	// Life Management
	uint8_t lifeDecBelowPct = 0;
	uint8_t lifeDecAbovePct = 255;
	uint8_t lifeRegenAbovePct = 255;
	uint8_t lifeRegenBelowPct = 0;
};

struct StructureSpawn {
	std::string key;
	uint32_t amount = 0;
	bool isCity = false;
};

// One agent type's deployment in a mode: how many may live and when they
// spawn. The agent's stats/brain live in agents.xml (AgentData); this is
// purely the per-mode "which and how many". Agents absent from every mode's
// table are never auto-spawned (e.g. player-built bots).
struct AgentSpawn {
	std::string key;
	uint32_t maxAlive = 0;
	uint32_t weight = 0;
	std::string time = "any"; // "night" | "day" | "any"
};

// A death waiting to be claimed as a starting kit by the next fresh login
// under the same client token (see Game::recordDeathForKit).
struct PendingKitReward {
	uint32_t level = 0;
	uint64_t deathTimeMs = 0;
};

struct Clan {
	uint8_t id = 0;
	std::string name;
	uint32_t leaderGuid = 0;
	std::set<uint32_t> members; // member GUIDs (including leader)
	bool locked = false;
	std::set<uint32_t> joinRequests; // applicant GUIDs
	std::set<uint32_t> invites; // GUIDs the leader has invited (INVITE_TEAM)
	uint64_t lastSyncTime = 0;
};

struct KarmaLevelMode {
	float xpMultiplier = 1.00f;
	uint32_t maxKills = 0;
};

// One entry of <ghoulRules>'s weighted body table: which agents.xml creature a
// player who joins after the lock is dropped into.
struct GhoulChoice {
	std::string key;
	uint32_t weight = 0;
};

// Ghoul mode. Presence of a <ghoulRules> node is what MAKES a mode a ghoul mode
// -- there is no separate on/off attribute, the same way <clans> is its own
// switch. The mode is a round: a countdown starts when the first player joins,
// and when it expires the world LOCKS and every later login arrives as a ghoul
// instead of a player. The round ends when the last living player character
// leaves the world.
//
// The mode's id in modes.xml must be 2. client.js validates the id it is sent
// and 2 is __GHOUL__, which is what selects the ghoul sprites, the frozen
// gauges, the hidden craft/team buttons and the round HUD -- all of which the
// client already implements. Any other id and the server's rules run against a
// client drawing plain survival.
struct GhoulRules {
	bool enabled = false;

	// Countdown from the FIRST player joining an empty round to the lock.
	uint32_t lockDelayMs = 480000; // 8 minutes

	// If at least this many players are online when the countdown expires, it is
	// multiplied instead -- once. A busier round gets proportionally longer to
	// gear up before the world turns on it. Measured AT expiry rather than
	// continuously so a burst of joiners who all leave again cannot extend a
	// round that is no longer busy.
	uint32_t extendPlayerCount = 60;
	float extendMultiplier = 2.0f;

	// How often the surviving players' positions are pushed to every living
	// ghoul once few enough are left. Deliberately coarse: a live feed would
	// make the endgame unwinnable, a stale ping makes it tense.
	uint32_t revealIntervalMs = 5000;

	// Flat speed a ghoul gains while holding shift, matching what a player gains
	// (230 walk -> 322 run). Not a multiplier: a fast_ghoul is already faster
	// than a player, and scaling would compound that into something unrunnable.
	uint16_t shiftSpeedBonus = 92;

	// Ghouls burn in daylight (agents.xml <daylight>) when true. Off in this
	// mode by design -- world ghouls are a night population that the sun thins
	// out, but a ghoul here is a PLAYER, and a round that kills half its
	// players at dawn ends on the clock rather than on the fight.
	bool daylightDamage = false;

	std::vector<GhoulChoice> ghouls;
};

// How few players must be left before their positions are revealed to the
// ghouls. NOT configurable, and that is a client constraint rather than a
// choice: client.js only draws the minimap arrows while `World.playerAlive < 6`
// (see _Minimap), so a server that revealed at any other threshold would either
// send positions the client refuses to draw or stop sending ones it still
// wants. Changing it means editing client.js too.
static constexpr uint32_t GHOUL_REVEAL_AT_OR_BELOW = 5;

struct GameMode {
	std::string key;
	// The mode number the CLIENT is sent, not a server identity -- `key` is
	// that. client.js branches on it (2 = World.__GHOUL__), which is why two
	// modes may legitimately share one: `benchmark` presents as survival's 0.
	uint8_t clientModeId = 0;
	uint32_t dayNightCycle = 960000;
	float craftSpeed = 1.0f;
	float respawnDelayMultiplier = 1.0f;
	float rateExperience = 1.0f;
	float rateItem = 1.0f;
	uint32_t structuresRespawnDelayMs = 0; // 0 = never
	// Explicit resource respawn delay, 0 = never. `...Set` distinguishes "the
	// mode asked for never" from "the mode said nothing", which falls back to
	// DEFAULT_RESPAWN_DELAY_MS scaled by respawnDelayMultiplier.
	uint32_t resourcesRespawnDelayMs = 0;
	bool resourcesRespawnDelaySet = false;
	std::unordered_map<std::string, GaugeMode> gauges;
	std::vector<StructureSpawn> structureSpawns;

	// Agent (monster/robot) deployment for this mode; see AgentSpawn.
	uint32_t agentsRespawnDelayMs = 0;
	uint32_t agentsMaxTotal = 0; // 0 = no mode-wide ceiling beyond per-agent maxAlive
	std::vector<AgentSpawn> agentSpawns;

	// Set by benchmark="true" in modes.xml. Marks a mode that exists only to
	// hold a stress test steady (gauges that never drain, so nothing dies) and
	// is not playable content. Purely advisory: the server still starts, but
	// prints a warning banner so an accidental deployment is visible in the log.
	bool benchmark = false;

	bool clansEnabled = false;
	bool clansCanCreate = false;
	uint32_t clansMaxMembers = 9;
	uint32_t clansMaxClans = 18;

	// Round rules, when this mode has a <ghoulRules> node. See GhoulRules.
	GhoulRules ghoul;

	std::unordered_map<uint8_t, KarmaLevelMode> karmaLevels;

	// abstract="true": a <mode base=> template holding shared blocks, never
	// playable. Excluded from mode selection, so config.lua cannot name one and
	// the "no mode matched" fallback cannot land on one either.
	bool isAbstract = false;
};

enum WorldType_t
{
	WORLD_TYPE_NO_PVP = 1,
	WORLD_TYPE_PVP = 2,
};

enum GameMode_t
{
	GAME_MODE_SURVIVAL = 0,
};

enum GameState_t
{
	GAME_STATE_STARTUP,
	GAME_STATE_INIT,
	GAME_STATE_NORMAL,
	GAME_STATE_CLOSED,
	GAME_STATE_SHUTDOWN,
	GAME_STATE_CLOSING,
	GAME_STATE_MAINTAIN,
};

static constexpr int32_t PLAYER_NAME_LENGTH = 25;

class Game
{
public:
	Game();
	~Game();

	// non-copyable
	Game(const Game&) = delete;
	Game& operator=(const Game&) = delete;

	void start(ServiceManager* manager);

	// Loads modes, structures, status effects and map definitions, and resolves
	// the active mode from them. Called by start() before the world is built,
	// and on its own by --validate, which wants the loading and the warnings
	// without a world or a socket.
	void loadContentDefinitions();

	void setWorldType(WorldType_t type);
	WorldType_t getWorldType() const { return worldType; }
	bool isPvpEnabled() const { return worldType != WORLD_TYPE_NO_PVP; }
	// isPvpEnabled, as scenario regions at both ends of the fight amend it.
	bool isPvpAllowedBetween(const Position& attacker, const Position& victim) const;

	// May `attacker`'s damage take `victim`'s health? Asked once, in
	// Player::changeHealth. Null attacker = environment, always allowed; so is
	// self-damage. Knockback and hit effects are NOT gated by this.
	bool canHarmPlayer(const Player* attacker, const Player* victim) const;

	GameState_t getGameState() const;
	void setGameState(GameState_t newState);

	bool loadModes(const std::string& filename);
	const GameMode* getActiveMode() const { return activeMode; }

	// --- Ghoul mode (game_ghoul.cpp) --------------------------------------
	//
	// Is the running mode a round-based ghoul mode? Every ghoul rule in the
	// server is gated on this, so survival is untouched by all of it.
	bool isGhoulMode() const { return activeMode && activeMode->ghoul.enabled; }
	// The active rules, or harmless defaults when no mode is loaded, so callers
	// never have to null-check before reading a number.
	const GhoulRules& getGhoulRules() const;

	// Where the current round is.
	//
	//   WaitingForPlayers  nobody has joined since the last reset; no clock runs
	//   Countdown          a player is in, and the world locks when it expires
	//   Locked             every fresh login now arrives as a ghoul
	//
	// It only ever moves forward, and the only way back to WaitingForPlayers is
	// a round ending (or a countdown expiring into an empty server).
	enum class GhoulPhase : uint8_t { WaitingForPlayers, Countdown, Locked };
	GhoulPhase getGhoulPhase() const { return ghoulPhase; }
	bool isGhoulRoundLocked() const { return ghoulPhase == GhoulPhase::Locked; }

	// A brand new character has entered the world. Starts the countdown if this
	// is the first one, or drops them straight into a ghoul body if the round
	// has already locked. NOT called for a reconnect: that takes over a
	// character already in the world, which neither starts a round nor changes
	// what the character is.
	void onGhoulPlayerCreated(Player* player);

	// The round clock, to one client. Must run AFTER its login setup -- the
	// client writes it into state the handshake rebuilds. See the definition.
	void sendGhoulRoundState(Player* player);

	// A character has just died. Tells every OTHER client so their copy of the
	// alive count follows -- the client maintains that number itself and has no
	// other way to learn a death happened, and it is what the ghouls' HUD shows
	// and what gates the endgame reveal.
	void onGhoulCharacterDied(Player* victim);

	// Round tick: expiry, extension, the lock, the reveal and the end check.
	void updateGhoulRound();
	// Puts the round in its opening state and starts the tick above. Called
	// once from Game::start, whatever mode is running.
	void startGhoulRoundLoop();

	// Living player characters -- humans only, ghouls excluded. This is the
	// number the round ends on and the number the reveal is gated by, and it
	// counts CHARACTERS IN THE WORLD rather than open sessions: a player whose
	// connection dropped is still alive and still has to be hunted down.
	uint32_t countLivingPlayers() const;

	// Puts the round back to WaitingForPlayers. Called at boot so the very first
	// round starts on the same path every later one does.
	void resetGhoulRound();

	// !ghoul (status) | !ghoul=lock | !ghoul=end. Skips the eight-minute wait
	// that otherwise sits in front of every test of this mode.
	void adminGhoulRound(Player* admin, const std::string& args);

	// The five gauge configurations the per-tick gauge update needs, resolved
	// once when the mode is chosen.
	//
	// Player::updateGauges used to look each one up by name in the mode's
	// unordered_map<std::string, GaugeMode> and copy it, for every player on
	// every tick -- five string constructions, five hashes and five copies per
	// player per tick, all producing the same answer for everybody. Held by
	// value so nothing dangles if the mode map is ever rebuilt.
	struct ActiveGauges {
		GaugeMode stamina;
		GaugeMode food;
		GaugeMode warmth;
		GaugeMode radiation;
		GaugeMode life;
	};
	const ActiveGauges& getActiveGauges() const { return activeGauges; }

	// --- Day/Night ---------------------------------------------------------
	//
	// WorldClock holds the whole of it; these forward rather than duplicate, so
	// "what time is it" has exactly one answer. Inline because the night test is
	// asked per agent per tick.
	const WorldClock& getWorldClock() const { return worldClock; }
	uint32_t getWorldTime() const { return worldClock.phaseMs(); }
	bool isNight() const { return worldClock.isNight(); }
	// Length of one full day/night cycle in the active mode, in ms.
	uint32_t getDayNightCycleMs() const { return worldClock.cycleMs(); }
	// True if `p` is `ownerGuid` or in their clan (this game's "team"). The one
	// definition of "same side", shared by object ownership and agent targeting.
	bool isOwnerOrClanmate(uint32_t ownerGuid, const Player* p) const;
	void updateWorldTime(uint32_t elapsedMs);
	// States the clock to every connected client. The ONLY way a phase change
	// reaches players -- boundary, periodic resync and `!set-daynight` all come
	// through here, so none of them can state it differently from the others.
	void broadcastWorldTime();

	// Crafting
	float getCraftSpeed() const { return craftSpeed; }
	void setCraftSpeed(float factor) { craftSpeed = factor; }

	Thing* getThingByID(uint32_t id);
	Player* getPlayerByID(uint32_t id);
	Player* getPlayerByGUID(uint32_t guid);
	Player* getPlayerByToken(const std::string& token);
	Player* getPlayerByAccountId(uint32_t accountId);

	// Lowest free GUID in 1..maxSlot, or 0 when there is none. maxSlot is
	// ServerInfo::getMaxPlayers() for an ordinary login and
	// PROTOCOL_MAX_PLAYER_ID for an alwaysLogin group, which may exceed the cap.
	uint32_t getFreeSlotId(uint32_t maxSlot);

	bool internalCreatureTurn(Creature* creature, uint8_t dir);

	size_t getPlayersOnline() const { return players.size(); }
	const std::unordered_map<uint32_t, Player*>& getPlayers() const { return players; }

	void addPlayer(Player* player);

    void playerRequestTrade(uint32_t playerId, uint8_t targetGuid);
    void playerReplyTrade(uint32_t playerId, uint32_t sessionId, bool accept);
    void playerOfferTrade(uint32_t playerId, uint32_t sessionId, uint32_t revision, uint16_t iid, uint8_t uid, uint8_t count);
    void playerAcceptTrade(uint32_t playerId, uint32_t sessionId, uint32_t revision);
    void playerCancelTrade(uint32_t playerId, uint32_t sessionId);
    // Right-click > Look (game_look.cpp): entityId 0 = the player with guid targetGuid.
    void playerLook(uint32_t playerId, ClientEntityId entityId, uint8_t targetGuid);
    std::string describeObject(const Player* looker, const Object& obj, bool admin);
    // One line on the player's status line, over the hotbar.
    void sendStatus(Player* player, const std::string& text, StatusKind kind = StatusKind::INFO);
    void cancelTrade(uint32_t playerId, const std::string& reason);
    void tradeInventoryChanged(uint32_t playerId, uint32_t uid, uint16_t iid, uint8_t count, uint8_t ammo);
    // An offered stack decayed into another item (newIid) or rotted away
    // (newIid 0). Rewrites the offer in place instead of cancelling the trade;
    // the caller restates the session with resendTrade once the inventory
    // messages for the new item are out.
    void tradeItemReplaced(uint32_t playerId, uint32_t oldUid, uint16_t newIid, uint32_t newUid, uint8_t count, uint8_t ammo);
    void resendTrade(uint32_t playerId);
    void updateTrades();
    void sendTradeState(const TradeSession& trade);
    bool validateTrade(const TradeSession& trade);
    void completeTrade(const TradeSession& trade);
    std::unordered_map<uint32_t, std::shared_ptr<TradeSession>> trades;
    uint32_t nextTradeId = 0;
	void removePlayer(Player* player);
	// Called when a player's connection drops but the character stays in the
	// world (AFK). Clears the input state the client can no longer release.
	void onPlayerSessionLost(Player* player);
	// Queues removePlayer on the dispatcher. Death, kicks and failed logins all
	// happen while the players map is being iterated, and removePlayer erases
	// from it; the id lookup also makes the task safe if the player is already
	// gone by the time it runs.
	void scheduleRemovePlayer(Player* player);
	void destroyObjectsOwnedBy(uint32_t ownerGuid);

	// Sends the message as a client alert, disconnects, then removes the player
	// from the world (a plain disconnect leaves the character in it).
	void kickPlayer(Player* target, DisconnectReason reason, const std::string& detail = {});
	// Bans the IP (minutes 0 = permanent) and kicks every non-admin online
	// from it. Admin ban/ban-ip commands funnel through this.
	void adminBanIp(Player* admin, const Connection::Address& ip, uint32_t minutes, const std::string& reason);

	bool placeThing(Thing* thing, const Position& pos);
	bool internalPlaceThing(Thing* thing, const Position& pos);
	void clearTile(const Position& targetPos);
	// Removes one static world entity (object, resource or loot) with the full
	// removal bookkeeping. clearTile is this in a loop over a tile; !clean and
	// the map importer call it directly. See the note on the definition.
	// broadcastRemoval=false skips the per-entity retraction. Only for a caller
	// that replaces every client's entity table wholesale afterwards; see the
	// note on the definition.
	//
	// deferTo collects the freed pointer instead of scheduling its own delete
	// event, for a caller removing thousands at once. Pass the same vector to
	// deferBulkDelete when the sweep is done.
	void removeWorldThing(Thing* t, bool broadcastRemoval = true,
	                      std::vector<Thing*>* deferTo = nullptr);
	// Frees a whole sweep on one scheduler event, after the usual 10ms grace.
	void deferBulkDelete(std::vector<Thing*>&& doomed);
	void updateRoadSubtypes();
	void updateSubtypes(const Position& pos);

	// Centre of tile (tileX, tileY), clamped to the map. Public because the map
	// importer addresses everything in tile coordinates -- the editor format is
	// tile-based -- and must land on exactly the same centres the build path
	// uses, or pasted objects sit off-grid from player-built ones.
	Position tileCenterPosition(int32_t tileX, int32_t tileY) const;

	void playerReceivePingBack(uint32_t playerId);
	// A chat line on `channel`; `target` is the peer guid for PRIVATE and
	// ignored otherwise. The server decides who receives it (see the definition)
	// and always echoes the sender: a client never shows a line the server did
	// not deliver. `!commands` are recognised on every channel.
	void playerSayChannel(uint32_t playerId, ChatChannel channel, uint8_t target, const std::string& message);
	// LOCAL shorthand, kept for the older CHAT_MESSAGE opcode and the map tools.
	void playerSay(uint32_t playerId, const std::string& message) { playerSayChannel(playerId, ChatChannel::LOCAL, 0, message); }
	// A SERVER_LOG event to everyone online (`skip` excluded -- e.g. the player
	// the line is about while it is still logging in).
	void broadcastServerLog(ServerLogKind kind, uint8_t a, uint8_t b, const std::string& text, const Player* skip = nullptr);
	// Chat blocks (Player::blockedPlayers): a blocked player's lines never
	// reach the blocker on any channel, and a private one is refused to the
	// sender. Staff cannot be blocked. Arrival and departure keep the lists
	// pointing at the right guids; each change re-sends BLOCKED_PLAYERS.
	void playerBlock(uint32_t playerId, uint8_t targetGuid, bool blocked);
	void blocksOnArrival(Player* arriving);
	void blocksOnDeparture(Player* leaving);
	void sendBlockedPlayers(Player* player);
	void parseAdminCommand(Player* player, const std::string& cmdLine);
	void playerTurn(uint32_t playerId, uint8_t dir);
	void playerMove(uint32_t playerId, uint8_t moveMask);
	void playerTakeLoot(uint32_t playerId, ClientEntityId lootId);
	void updateRespawn();
	// Drains one slice of the map importer's job queue; reschedules itself.
	void updateMapJobs();

	// City/house respawn cadence, seeded from the mode and then owned here so
	// an admin can retune or disable it live. 0 = never.
	void setStructuresRespawnDelayMs(uint32_t ms)
	{
		structuresRespawnDelayMs = ms;
		lastStructureRespawnAt = OTSYS_TIME();
	}
	uint32_t getStructuresRespawnDelayMs() const { return structuresRespawnDelayMs; }

	// Does this tile hold something world generation must build around: a
	// creature, a loot pile, or anything a player built?
	//
	// Deliberately not position-exact for creatures and loot -- they stand
	// wherever they like inside the tile, so a centre-point comparison would
	// never match. Objects are always tile-centred, so they compare either way.
	bool tileHoldsPlayerContent(const Position& pos) const;

	// Just the creature half of the above: is anybody standing in this tile?
	// Generation skips those tiles regardless of what the caller asked to
	// preserve -- a rebuild must not be able to wall a player in.
	bool tileHoldsCreature(const Position& pos) const;

	// The transient half: a creature or a loot pile, i.e. everything on the
	// tile that the world seed does not describe and that will have moved by
	// the next rebuild.
	//
	// World generation asks this only AFTER the layout is decided, never
	// before. Consulting the live world while choosing where things go is what
	// made two runs of the same seed produce different maps: a wandering bot
	// changed how many times the generator had to retry, and every draw after
	// that retry shifted.
	bool tileHoldsTransientContent(const Position& pos) const;

	// What a rebuild actually produced, so the admin who asked for it is told
	// when the world came up short instead of reading "done" and finding the
	// holes later. Coming up short is not hypothetical: preserved player builds
	// and imported maps compete for the same entity id space the new world needs.
	struct WorldRebuildReport
	{
		int64_t elapsedMs = 0;
		uint32_t removed = 0;
		uint32_t structuresPlaced = 0;
		uint32_t structuresWanted = 0;
		uint32_t resourcesSpawned = 0;
		uint32_t resourcesWanted = 0;
		bool outOfIds = false;
		// The rebuild turned respawn back on because it had been off -- almost
		// always because !clean-hard switched it off. Reported rather than done
		// silently: an admin who meant to keep it off needs to know to say so
		// again.
		bool respawnRestored = false;
		// What the seed actually built, as one comparable number. Two rebuilds
		// on the same seed must report the same one.
		uint32_t fingerprint = 0;

		bool cameUpShort() const
		{
			return outOfIds || structuresPlaced < structuresWanted ||
			       resourcesSpawned < resourcesWanted;
		}
	};

	// Rebuilds cities, houses, imported maps and resources from `seed`, in the
	// same order world generation runs at startup. `preservePlayerBuilds` keeps
	// everything a player owns (and skips the tiles it stands on) instead of
	// bulldozing it.
	//
	// Synchronous, and it shows: this removes and recreates on the order of ten
	// thousand entities inside one tick. That is a visible freeze for everyone
	// online, which is the honest cost of "the world is different now" and the
	// reason the command says so before it runs.
	WorldRebuildReport regenerateWorld(uint32_t seed, bool preservePlayerBuilds);

	// Builds the world content for `seed`: structures, then imported maps, then
	// resources. THE one generation path -- startup and !seed both call it, so
	// `!seed=<n>` reproduces exactly the world a fresh boot with
	// `seed = <n>` produces. They used to be two copies of the sequence
	// running off the shared process RNG, which meant the runtime one started
	// from wherever play had left that RNG and could not match a boot.
	//
	// Fills in the structure/resource halves of `report`; the caller owns the
	// removal and publication either side of it.
	void generateWorld(uint32_t seed, bool preservePlayerBuilds, WorldRebuildReport& report);
	// Puts the resource and structure respawn cadences back to what the active
	// mode asks for. Run at startup and on every world rebuild.
	void restoreRespawnDefaults();

	// The fingerprint of the world currently standing: a digest of every
	// placement the seed decided on, accumulated as generation runs
	// (worldgen::noteLayout). Two worlds built from one seed have one number to
	// compare instead of a walk around the map, which is what makes a
	// determinism regression visible the moment it appears rather than as "the
	// cities look different this time". Reported by !seed.
	uint32_t getWorldFingerprint() const { return worldFingerprint; }

	// The World & Mode Editor project this server runs instead of a generated
	// world (config.lua scenarioFile), if any.
	const std::optional<scenario::ActiveScenario>& getActiveScenario() const { return activeScenario; }
	// Why start() refused to build a world; empty when it did not. The loader
	// checks this before opening any port.
	const std::string& getStartupFailure() const { return startupFailure; }

	// Resizes the world, in tiles, and rebuilds it inside the new bounds.
	//
	// A resize necessarily REGENERATES: structure and resource placement is
	// drawn from the map dimensions, so keeping the old content and merely
	// cropping it would leave every city bunched in one corner of the new map.
	// The seed is kept, so the result is still reproducible -- size simply joins
	// the seed as part of what defines a world.
	//
	// Runs through the same queue as !seed (queueRegeneration), so two resizes
	// cannot interleave and neither can land mid-tick.
	void queueResize(int32_t tilesX, int32_t tilesY, bool preservePlayerBuilds, uint32_t adminGuid);

	// Prints the map's demand on the entity id space -- what a fully built map
	// would cost against what exists -- and returns a one-line summary for an
	// admin chat reply.
	//
	// Not boot-only: the map can be resized at runtime, and the whole point of
	// this report is that overcommitting the id space is visible BEFORE building
	// silently stops rather than discovered mid-session.
	std::string reportMapIdBudget() const;

	// Where players appear. Seeded from spawnX / spawnY but NOT read from the
	// config after that, because a resize can invalidate the configured point:
	// shrink the map under it and clampPositionToMap pins every arrival to the
	// corner tile, which is the worst place on the map to stand and the hardest
	// spot for a clearance test to accept.
	int32_t getSpawnCenterX() const { return spawnCenterX; }
	int32_t getSpawnCenterY() const { return spawnCenterY; }

	// Moves the spawn point to the middle of the map if the current one no
	// longer sits safely inside it. Returns a sentence for the admin reply, or
	// an empty string when nothing needed moving -- a silent relocation of where
	// players appear is not something to leave anyone to discover.
	std::string recentreSpawnIfOutside();

	// Core loot spawn: create + place. All drop paths go through this.
	Loot* spawnLoot(uint16_t lootId, uint16_t iid, uint8_t count, const ItemState& state, const Position& from, const Position& to);

	// Where an item thrown from `origin` facing `angle` lands: the free slot on
	// a ring of `radius` nearest the facing, so repeated throws fan round the
	// thrower instead of stacking (see loot_placement::directed).
	Position findThrowLootPosition(const Position& origin, float angle, float radius);

	// Every drop from one event -- a death, an overflow, a reward -- spread
	// evenly round `origin` on rings starting at `radius`, clear of the piles
	// already there (see loot_placement::burst). Pass them together: dropped
	// one by one they would each pick their spot without knowing the others'.
	struct LootDrop {
		uint16_t lootId;
		uint16_t iid;
		uint8_t count;
		ItemState state;
	};
	static constexpr float LOOT_BURST_RADIUS = 40.0f;
	void dropLootBurst(const Position& origin, std::span<const LootDrop> drops, float radius = LOOT_BURST_RADIUS);
	// The landing spots alone, for a caller that places the piles itself.
	std::vector<Position> findBurstLootPositions(const Position& origin, size_t count, float radius = LOOT_BURST_RADIUS);

	// One item dropped round `origin`: a burst of one.
	void dropLootScattered(uint16_t lootId, uint16_t iid, uint8_t count, const ItemState& state, const Position& origin);

	// Clamp raw (possibly negative / out-of-range) coordinates into map
	// bounds. Position stores uint16_t, so computing a landing spot near the
	// map edge must clamp BEFORE the narrowing cast or it wraps to ~65k and
	// teleports the entity across the map.
	Position clampPositionToMap(int32_t x, int32_t y) const;

	// Where a BODY of `radius` may stand: the same bound walking obeys.
	//
	// clampPositionToMap answers a different question -- "is this coordinate
	// expressible" -- and for anything with a body that is half a body too
	// generous. The map edge is a wall, and the movement resolver holds a body
	// its own radius clear of it (clampToMapBounds in game.cpp), so a teleport
	// clamped the raw way parks a player half outside the world, somewhere no
	// amount of walking can reach. Any path that MOVES a creature to a computed
	// spot near the edge wants this one.
	Position clampBodyPositionToMap(int32_t x, int32_t y, float radius) const;

	// Is this TILE on the map at all?
	//
	// The bounds test that isTileClear deliberately does not do: that one asks
	// "is anything in the way", and an off-map tile is empty, so it answers yes
	// -- which is how a player standing near the edge could build past it. Any
	// path that turns client-supplied tile coordinates into a placement has to
	// ask this FIRST, in int32, before the coordinates are narrowed into a
	// Position.
	static bool isTileInsideMap(int32_t tileX, int32_t tileY)
	{
		return tileX >= 0 && tileY >= 0 &&
		       tileX < MapSize::tilesX() && tileY < MapSize::tilesY();
	}

	// The world-unit form, for the callers that already work in units.
	static bool isPositionInsideMap(int32_t x, int32_t y)
	{
		return x >= 0 && y >= 0 && x < MapSize::widthUnits() && y < MapSize::heightUnits();
	}

	// Growth stages (stages in objects.xml)
	void updateObjectStages(uint32_t elapsedMs);
	void enterObjectStage(Object* obj, const ObjectData* od, uint8_t stageId);
	bool tryHarvestObject(Object* obj);
	void spawnStageLoot(const Position& origin, const StageLootSpawn& lootSpawn);
	// Consumes the object and puts the stage's agent on the spot it just left,
	// owned by whoever placed it. The object is gone when this returns.
	void hatchStageCreatures(Object* obj, const ObjectStage& stage);
	// An object's <lifetime> running out. Hatches if it is sitting in a stage
	// that hatches, otherwise destroys it normally.
	void expireObject(Object* obj);

	// Resurrection objects (respawner in objects.xml)
	bool tryResurrectPlayer(Player* player);
	Object* findOldestRespawner(uint32_t ownerGuid);
	Position findResurrectionPosition(const Position& center, const Creature* creature);

	// Creature placement. One predicate for every "may a creature materialise
	// here" question, so login, resurrection and (later) AI spawning cannot
	// drift apart the way isSpawnPositionValid and isResurrectionSpotFree did.
	//
	//   Strict       -- a fresh login. Genuinely empty ground: floors, roads
	//                   and loot are walkable but are still refused, because
	//                   all three mean materialising in someone's base or on
	//                   their dropped items.
	//   Resurrection -- a respawner object, which by definition sits inside the
	//                   owner's base. Only colliding geometry blocks, so floors,
	//                   roads and open doors are fine to come back on.
	//
	// Takes a Creature rather than a Player: `self` is only ever used for the
	// identity skip, and the body is already creature-generic.
	enum class SpawnRule { Strict, Resurrection };
	bool isSpawnPositionValid(const Position& pos, const Creature* self,
	                          SpawnRule rule = SpawnRule::Strict) const;

	// Applies the spawnX/spawnY/spawnSpread config and guarantees a placeable
	// Position.
	Position findSpawnPosition(const Creature* creature);
	void teleportPlayer(Player* player, const Position& newPos);

	// Starting kits (XML/kits.xml): rewards a fresh login with a loadout
	// based on the level the player's last character died at, keyed by
	// client token (survives the death -> relogin gap; nicknames don't carry
	// any persistent identity here) and only within the configured expiry
	// window (KitManager::getDeathRewardExpiryMinutes). A token that has
	// never died before gets KitManager::getFreshKit() instead of the
	// level-based lookup, regardless of expiry.
	void recordDeathForKit(const std::string& token, uint32_t level);
	uint32_t consumePendingKitDeathLevel(const std::string& token);
	void grantStartingKit(Player* player);

	// `ignoreTransient` drops creatures and loot from the answer, leaving only
	// the static world. World generation is the only caller that wants it: its
	// decisions have to depend on the seed alone, and creatures and loot are
	// somewhere else by the next rebuild. Every gameplay caller must leave it
	// false or players will be built on top of.
	bool isTileClear(const Position& targetPos, bool isPlacingFloor, uint32_t ignoreOwnerPid = 0, uint32_t ignorePlayerId = 0, Object* ignoreObj = nullptr, bool isDoorSwing = false, bool isResourceSpawn = false, bool ignoreTransient = false);
	bool isDoorPanelPositionBlocked(Object* door, const Position& panelPos, uint32_t ignorePlayerId);
	void playerPlaceObject(uint32_t playerId, uint8_t rotation, uint16_t i, uint16_t j);
	
	void playerOpenInteraction(uint32_t playerId, ClientEntityId entityId, uint8_t entityPid);
	// playerOpenInteraction phases.
	Object* resolveInteractionObject(const Player* player, ClientEntityId entityId, uint32_t& targetUid);
	Object* findNextCycleContainer(const Player* player, uint32_t currentInteractionId);
	bool isObjectHeldByAnotherPlayer(const Player* player, const Object* obj);
	void applySwitchInteraction(Object* obj, const ObjectData* od, uint64_t now);
	void applyDoorInteraction(Player* player, Object* obj, const ObjectData* od);
	void playerCloseContainer(uint32_t playerId, bool fromClient = false);
	// containerSlot: the slot it was dropped on, used when free; 255 = first free.
	void playerStoreItem(uint32_t playerId, uint16_t iid, uint8_t count, uint32_t uid, uint8_t ammo, uint8_t containerSlot);
	void playerMoveContainerItem(uint32_t playerId, uint8_t from, uint8_t to);
	void playerTakeItem(uint32_t playerId, uint8_t slotIndex);
	// WEAPON_MOD: fit (or swap in) the mod with that uid, or remove what is in `slot`.
	void playerWeaponMod(uint32_t playerId, uint8_t weaponUid, uint8_t slot, bool fit, uint8_t modUid);
	// Is this inventory item (full uid) in the player's side of an open trade?
	bool isOfferedInTrade(uint32_t playerId, uint32_t uid) const;

	// One station's per-tick fuel burn, queue progress and state broadcast.
	void updateStationObject(Object* obj, const ObjectData* od, uint32_t elapsedMs);

	void playerAddFuel(uint32_t playerId, uint8_t amount);
	void playerTakeFromStation(uint32_t playerId, uint8_t slotIndex);

	void playerStartCraft(uint32_t playerId, uint16_t iid, bool isStation);
	void playerCancelCraft(uint32_t playerId);
	void completeCraft(uint32_t playerId, uint16_t iid);
	Object* getActiveInteractionObject(Player* player);
	void giveOrDropCraftYield(Player* player, const ItemData* idata, uint16_t iid, uint16_t totalYield);

	// Clans
	std::unordered_map<uint8_t, Clan> clans;

	bool playerCreateClan(uint32_t playerId, const std::string& name);
	bool playerDeleteClan(uint32_t playerId);
	bool playerRequestJoinClan(uint32_t playerId, uint8_t clanId);
	bool playerAcceptJoinClan(uint32_t playerId, uint32_t applicantGuid);
	bool playerKickClanMember(uint32_t playerId, uint32_t memberGuid);
	bool playerLeaveClan(uint32_t playerId);
	bool playerLockClan(uint32_t playerId);
	bool playerUnlockClan(uint32_t playerId);
	// The leader invites a player with no clan; the invitation stands until
	// either leaves, joins a clan or the clan is gone. It admits a player to a
	// locked clan too -- locked means "invitation only".
	bool playerInviteToClan(uint32_t playerId, uint8_t targetGuid);
	bool playerAcceptClanInvite(uint32_t playerId, uint8_t clanId);

	void disbandClan(uint8_t clanId);
	void removePlayerFromClan(Player* player);
	// Drops a player's join requests and invitations, in every clan.
	void forgetClanApplications(uint32_t guid);
	// Makes `newcomer` a member and tells everyone (an accepted request or invitation).
	void joinClan(Clan& clan, Player* newcomer, uint64_t now);
	Clan* getClanById(int16_t clanId);
	// Clan mates share object ownership.
	bool sharesClanWith(const Player* player, uint32_t otherGuid);
	void updateTeamPositions();
	void updateLeaderboard();
	// No-op when the top ten is byte-for-byte what was last sent. The board goes
	// out every 3s and again on every karma change, but it only moves when
	// somebody scores -- so on a quiet server that was 255 clients x a frame
	// every 3s carrying bytes they already had.
	void broadcastLeaderboard();
	// The board as it stands, for one client that has not seen it yet (login).
	// Needed because a suppressed broadcast is invisible to a player who joined
	// after it: a newcomer who does not crack the top ten changes nothing, so
	// without this their board would stay blank until somebody else scored.
	void sendLeaderboardTo(ProtocolGame* client);
	void handlePlayerKill(Player* killer, Player* victim);
	// XP a kill is worth, before the rate/karma multipliers addXP applies.
	uint32_t pvpKillExperience(const Player& killer, const Player& victim) const;
	void updateBadKarmaPositions();
	// kickIdlePlayerAfterMinutes sweep; 0 minutes disables it.
	void updateIdleKick();
	void broadcastPacket(const NetworkMessage& msg);

	void broadcastSurgicalUpdate(const EntityUpdate& update, const Position& pos);

	void broadcastNotification(uint8_t playerPid, uint8_t type, uint8_t level, const Position& pos);
	void broadcastPlayerEat(uint8_t playerPid, const Position& pos);
	void broadcastPlayerHeal(uint8_t playerPid, const Position& pos, Player* subject = nullptr);
	void broadcastPlayerHit(uint8_t playerPid, uint8_t angle, const Position& pos, Player* subject = nullptr);
	void broadcastDamageIndicator(const Position& pos, int16_t amount, uint8_t pct, Player* subject = nullptr);

	// One event, one serialised frame, many recipients: every client that can
	// see `pos` is handed the SAME OutputMessage instead of building one each.
	// Use this for any "something happened HERE, show it" opcode -- these are
	// the frames that multiply with crowd size (see the comment on the
	// implementation).
	//
	// `subject` is the player the event is ABOUT, and is guaranteed to receive
	// the frame exactly once even if the tile sweep cannot find them. That is
	// not paranoia: a mover is in NO tile bucket while the tile-leave hooks run
	// (Game::updateMovement removes them from the old tile before calling
	// onCreatureLeave), so a trap firing on leave would otherwise deny the
	// victim their own hit flash -- the same gap that produced the landmine bug.
	void broadcastToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject = nullptr);

	// Same recipients, same sharing, but never dropped: for a message that says
	// what something IS rather than what happened to it. See the implementation
	// for why the event frame budget is wrong for those.
	void broadcastStateToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject = nullptr);

	// `onHit` is what the blast inflicts on every CREATURE it catches (players
	// and agents alike), from <explosion><onHit/></explosion>. Passed by pointer
	// so the many existing call sites that have nothing to inflict stay as they
	// are; nullptr means damage and knockback only.
	void executeExplosion(const Position& pos, uint16_t radius, uint16_t area, uint32_t playerDamage, uint32_t buildingDamage, float knockback, uint32_t attackerId,
	                      const ConditionApplication* onHit = nullptr);
	// Splash damage applied later and resolved by ID, so a target destroyed by
	// an earlier blast in the same chain is simply not found. `impactAngle` is
	// the 0..31 hit direction the non-player damage paths use.
	void scheduleExplosionDamage(uint32_t targetId, uint32_t damage, uint32_t attackerId, uint32_t delayMs, uint8_t impactAngle = 0);

	// --- On-hit effects ------------------------------------------------------
	//
	// Everything a landed hit does BEYOND the damage: the condition it inflicts,
	// the life and stamina it returns to the attacker. One resolver for melee,
	// projectiles and agent bites, because the three had already drifted -- only
	// two of them applied conditions at all, and none scaled by damage.
	//
	// `damageDealt` MUST be what actually landed (the value changeHealth now
	// returns), not what was requested: leech off the request would ignore
	// armour entirely and pay out in full on a 1 HP overkill, and a
	// chancePerDamage stun would ignore armour too.
	//
	// Call it AFTER the damage, so a lethal hit does not bother poisoning a
	// corpse, and only when damage actually landed -- a shot absorbed to nothing
	// by ghost mode or invincibility must not deliver a condition either.
	// `didCrit` is what rollOutgoingDamage reported for THIS source, and gates
	// the crit's own condition -- so a crit that was absorbed to nothing lands
	// no bleed either.
	void applyHitEffects(Player* attacker, Creature* victim, int32_t damageDealt,
	                     const HitEffects& effects, bool didCrit = false);

	// How much a swing does after the attacker's own crit roll and any
	// damage-dealt modifier. Returns the damage to use and reports whether it
	// crit, so the caller can apply the crit's condition to whatever it hits.
	//
	// Applied to the OUTGOING damage, before resistance, so armour still counts
	// against a crit -- and leech then reads what actually landed. That order is
	// the only one where both stats behave the way a player expects.
	int32_t rollOutgoingDamage(const Player* attacker, int32_t damage,
	                           const HitEffects& effects, bool& outCrit) const;

	// Projectiles
	void applyProjectilePlayerHit(Projectile& projectile, Player& targetPlayer, Player* attacker, const EquipableData* edata, int32_t damage, float angleRad);
	bool tryApplyProjectileRepair(Object& targetObj, Player* attacker, const EquipableData& edata, uint8_t impactAngle);
	int32_t getProjectileObjectDamage(const Object& targetObj, const EquipableData* edata, Player* attacker, int32_t defaultDamage) const;
	void applyProjectileHit(Projectile& projectile, Thing* hitTarget, const Position& oldPos, float hitX, float hitY);
	void stopProjectileAtHit(Projectile& projectile, const Position& hitPos);
	void removeProjectile(Projectile* projectile, const Position& removalPos);

	// The ONE way any projectile record reaches clients after creation. All of
	// them must go to the same set or the difference leaks into a client's draw
	// list permanently; see the definition.
	void sendProjectileToRecipients(const Projectile& projectile, const EntityUpdate& update);

	// How far a projectile is visible; see the definition. Player::spawnProjectiles
	// is the other half of the create/retract pair that has to agree on it.
	int32_t projectileViewRange() const;

	void applyProjectilePayload(Projectile* projectile, const ProjectileData* pdata, const Position& pos);
	void destroyProjectileAfterHit(Projectile* projectile, const ProjectileData* pdata, const Position& hitPos);
	bool parkProjectileOnImpact(Projectile* projectile, const ProjectileData* pdata, const Position& hitPos);

	void updateMovement();
	void updateAgents();

	// An agent has been attacked by `attacker`. It turns on them if it had
	// nothing else to fight, and shouts so the agents around it do too. Called
	// from Agent::changeHealth, which is why this is public while the rest of the
	// targeting machinery is not.
	void agentProvoked(Agent* agent, Thing* attacker);
	void updateProjectiles(uint32_t elapsedMs);
	void addProjectile(std::unique_ptr<Projectile> p);
	bool findClosestObstacleHit(const Creature* shooter, const Position& startPos, const Position& endPos, Position& hitPos);
	void updateStations();

	// World spawning of agents: fills the mode's population during the night and
	// does nothing during the day. Reschedules itself like the other loops.
	void updateAgentSpawns();
	// Random map position an agent of this type can legally stand, honouring
	// isSpawnPositionValid, its own body, and the minimum distance from players.
	// Returns false when no candidate was found this tick.
	bool findAgentSpawnPosition(const AgentData* data, Position& out);
	// Nearest spot to `origin` where an agent of this type physically fits, for
	// a hatching object whose own spot is blocked. Body fit only -- no spawn
	// rule, since the object was already standing there. False = walled in.
	bool findAgentBodyFitNear(const AgentData* data, const Position& origin, Position& out);
	// Whether an agent of this type physically fits at `at` (its own body
	// against the map, not isSpawnPositionValid's fixed clearances).
	bool agentBodyFitsAt(const AgentData* data, const Position& at);
	void updateLogicCircuits();

	Map map;

	// Structure respawn state. Was a function-static inside updateRespawn,
	// which made it unreachable from anywhere else and so impossible to retune
	// or reset from a command.
	uint32_t structuresRespawnDelayMs = 0; // 0 = never
	int64_t lastStructureRespawnAt = 0;

	std::set<Object*> activeTriggerObjects;

	// Every live object with a <logic> tag, maintained by internalPlaceThing and
	// the two removal paths.
	//
	// Same reasoning as damagedObjects: updateLogicCircuits used to find its work
	// by walking map.getThings() at 10Hz and asking ObjectManager for each one's
	// type by string key -- ~10k hash lookups a second on a populated world to
	// discover, almost always, that nobody has built a circuit. With the registry
	// an empty world costs one empty() check.
	std::unordered_set<Object*> activeLogicObjects;
	void noteLogicObjectPlaced(Object* obj) { activeLogicObjects.insert(obj); }
	void noteLogicObjectGone(Object* obj) { activeLogicObjects.erase(obj); }

	// Objects currently below their healthMax, by runtime id. Maintained by
	// Object::changeHealth and Object::finishDestruction.
	//
	// This exists so a repair bot never has to sweep tiles looking for work. Its
	// `vision` is a 15x15 tile box; a hundred bots asking that question every
	// tick is ~22k tile visits a tick for an answer that is almost always "no".
	// A damaged object is a rare, event-driven thing, so the set is normally
	// EMPTY and an idle repair brain costs one empty() check.
	std::unordered_set<uint32_t> damagedObjects;
	void noteObjectDamaged(uint32_t objId) { damagedObjects.insert(objId); }
	void noteObjectRepaired(uint32_t objId) { damagedObjects.erase(objId); }

	// Objects that listen on a remote channel (<remote> in objects.xml), indexed
	// by the owner who placed them. Maintained by Object::setOwnerPid and
	// Object::finishDestruction.
	//
	// Same reasoning as damagedObjects, only more so: a detonator reaches every
	// charge its owner has planted ANYWHERE on the map, so there is no local box
	// to sweep -- a viewport query would be both wrong (it would miss the charge
	// under the enemy wall you are hiding from) and expensive. Almost nothing is
	// remotely triggerable, so this stays a handful of ids per player.
	std::unordered_map<uint32_t, std::vector<uint32_t>> remoteObjects;
	void noteRemoteObjectPlaced(uint32_t ownerPid, uint32_t objId);
	void noteRemoteObjectGone(uint32_t ownerPid, uint32_t objId);
	// Signals every object `player` owns that listens on `channel`. Returns how
	// many acted, so the caller can stay quiet when nothing was planted.
	uint32_t fireRemoteTrigger(Player* player, const std::string& channel);

	// Do two owner GUIDs belong to the same side? The Player-taking
	// isOwnerOrClanmate cannot answer this: matching a bot's owner against an
	// OBJECT's owner has no Player on either end, and the owner may well be
	// offline while their base is being repaired.
	bool isSameOwnerSide(uint32_t guidA, uint32_t guidB) const;

	// Is this player sent a concealed object (ObjectData::concealTiles)? Its
	// owner's side always is; anyone else only within the reveal range. True
	// for an ordinary object. The one rule behind every path that hands a
	// static to a client, so a modified client has nothing to un-hide.
	bool perceivesConcealed(const Player* p, const Object* obj) const;

private:
	// Per player, every tick: adds a concealed object that just became
	// perceivable (walked into range, joined the owner's clan) and retracts
	// one that stopped being so, against the player's static known set.
	void updateConcealedVisibility(Player* p, const Map::TileBox& box, uint32_t visibilityTick);

	std::unordered_map<uint32_t, Player*> players;
	std::unordered_map<std::string, Player*> mappedPlayerNames;
	std::unordered_map<uint32_t, Player*> mappedPlayerGuids;

	// --- Ghoul mode round state (game_ghoul.cpp) --------------------------
	GhoulPhase ghoulPhase = GhoulPhase::WaitingForPlayers;
	// Absolute OTSYS_TIME the countdown expires at, not a remaining duration:
	// the tick is periodic rather than exact, so counting down by the elapsed
	// slice would accumulate the scheduler's drift into the round length.
	uint64_t ghoulDeadlineMs = 0;
	// The one extension has been spent. Per ROUND, cleared by resetGhoulRound.
	bool ghoulExtended = false;
	uint64_t ghoulLastRevealMs = 0;
	uint64_t ghoulLastChronoMs = 0;
	// A round end is already under way. The kicks it issues are deferred, so
	// without this the next tick would see the same empty world and start a
	// second teardown on top of the first.
	bool ghoulRoundEnding = false;

	// Chooses a body from <ghoulRules>'s weighted table.
	const AgentData* pickGhoulBody() const;
	// Ends the round: everyone out, world rebuilt, back to WaitingForPlayers.
	void endGhoulRound();
	// Ground loot and leftover agents, which a world rebuild deliberately
	// spares. A round boundary is not a reseed; see the definition.
	void clearRoundEntities();
	// Pushes the surviving players' map positions to every living ghoul.
	void updateGhoulReveal();
	// Restates the countdown to the players who can see it.
	void broadcastGhoulChrono();

	// client token -> pending death reward, consumed (or discarded if
	// expired) by the next fresh login under that token (see grantStartingKit)
	std::unordered_map<std::string, PendingKitReward> pendingKitRewardByToken;

	// client tokens that have died at least once, ever (never erased/expired
	// — distinguishes "never died" from "died, but reward already claimed or
	// expired" so the fresh-session kit is granted at most once per token)
	std::unordered_set<std::string> tokensWithPriorDeath;
	static constexpr size_t MAX_GUEST_DEATH_HISTORY = 100000;
	static constexpr size_t MAX_PENDING_GUEST_REWARDS = 10000;
	void pruneGuestRewards();

	std::vector<std::unique_ptr<Projectile>> projectiles;
	std::vector<std::unique_ptr<Projectile>> freeProjectiles;
	
	// Scratch space for findClosestObstacleHit
	std::vector<Thing*> projectileCandidates;

	// Scratch for broadcastSurgicalUpdate's candidate list. A member rather
	// than a local so the allocation is reused: the hot callers fire several
	// times per tick. Safe to share because pushUpdate only queues bytes and
	// never re-enters this function.
	std::vector<Player*> surgicalSpectators;

	// The shared body of broadcastToWatchers and broadcastStateToWatchers; a
	// frameBudget of 0 means every recipient gets it.
	void fanOutToWatchers(const NetworkMessage& msg, const Position& pos, Player* subject, int32_t frameBudget);

	// Separate scratch for broadcastToWatchers. Deliberately NOT shared with
	// surgicalSpectators: the two are leaf calls today, but one growing a call
	// into the other would silently corrupt the outer loop's candidate list.
	std::vector<Player*> watcherSpectators;

	// Static-half entity ids destroyed during THIS tick, applied to every
	// player's known set in ONE merge pass by the visibility loop rather than
	// with a per-player, per-id erase. See broadcastSurgicalUpdate and
	// KnownEntitySet::eraseSortedStatic. Sorted into staticRemovalScratch once
	// per tick, then consumed by every client; both cleared at end of tick.
	std::unordered_set<uint32_t> pendingStaticRemovals;
	std::vector<uint32_t> staticRemovalScratch;

	// Same idea for the per-projectile collision candidate list, which is
	// rebuilt for every live projectile on every tick.
	

	// Reused obstacle scratch for the per-agent movement pass (updateAgents).
	std::vector<Thing*> agentObstacleScratch;
	// Agents near one that is shouting for help (alertNearbyAgents).
	std::vector<Thing*> agentAlertScratch;
	// Candidate targets from the throttled non-player sweep
	// (scanAgentSecondaryTargets).
	std::vector<Thing*> agentTargetScratch;
	// Obstacles around whatever the pathfinder is currently testing. Separate
	// from the movement scratch: findAgentPath runs before stepAgent within the
	// same agent's tick, and sharing one buffer between planning and moving is
	// the kind of coupling that breaks silently.
	std::vector<Thing*> agentPlanScratch;
	// Reused scratch for string-pulling a freshly found A* route.
	std::vector<Position> agentPathSmoothScratch;
	// Obstacles an agent was already overlapping at the start of its movement
	// tick; excluded from the push-out so it can walk out of them.
	std::vector<Thing*> agentPreExistingScratch;
	// Things in the corridor ahead of one live projectile (updateAgentDodges).
	std::vector<Thing*> agentDodgeScratch;
	// Snapshot of the agents to tick, taken (with a reference held on each)
	// before any brain runs -- see updateAgents for why the mobile index cannot
	// be walked directly.
	std::vector<Agent*> agentTickScratch;
	// A* searches left in the current movement tick; refilled by updateAgents
	// and spent by agentChase.
	int32_t agentPathBudget = 0;
	// How many live agents hold each thing as their target, rebuilt once per
	// movement tick in updateAgents. Read by target selection so an agent can
	// rank a crowded wall as further away than an empty one -- see
	// AGENT_CROWD_DISTANCE_PENALTY. Counted centrally because the alternative is
	// every agent sweeping its neighbours for their targets, which is the
	// per-agent-per-tick spatial query this AI keeps removing; one pass over the
	// agents it is already walking costs nothing.
	std::unordered_map<uint32_t, uint16_t> agentTargetCensus;

	// Agent AI (updateAgents drives these once per movement tick).
	// May this agent hunt this player? The single home of the targeting rules --
	// ghost/ghoul-player exclusions, owner-and-clan protection for player-built
	// agents, and the survival grace period for world-spawned ones. Shared by
	// sight and by alerts so that being shouted about can never do what being
	// seen would not.
	// Owner GUID of anything an agent can engage: a player is their own owner,
	// an object and an agent both carry their builder's. 0 = the world owns it.
	// One accessor so hostility is a comparison of sides and nothing else.
	uint32_t ownerOfThing(const Thing* thing) const;
	// Is this thing on a side this agent fights? Generalises what used to be
	// isAgentPrey(Player*): a player, their bots and their buildings are all the
	// same question asked of different entity types.
	bool isAgentHostileTo(const Agent* agent, const Thing* thing);
	// Is this agent currently engaged against `side` -- that player, one of their
	// bots, or one of their buildings? What makes a wandering monster a player's
	// bots' business, as opposed to something they pick a fight with.
	bool isAgentTargeting(const Agent* agent, uint32_t side);
	// The <target> rule governing this thing's KIND, or nullptr if the agent
	// does not engage that kind at all.
	static const AgentTarget* agentTargetRuleFor(const AgentData* data, const Thing* thing);
	// How close a body must get to touch this thing. Objects are rectangles as
	// often as circles, so getCollisionRadius alone is not the answer.
	static float agentTargetExtent(const Thing* thing);
	// Non-const: it maintains the agent's sticky target.
	//
	// Targets are TIERED by <target priority>, highest first, nearest within a
	// tier -- a player outranks their bots, which outrank their buildings. The
	// player pass runs every tick over the (small) player table exactly as it
	// always did, so nothing about noticing a player got slower or later; the
	// lower tiers need a spatial sweep, so they are throttled and only consulted
	// when no player is in sight. Tiering falls out of that order for free.
	Thing* findAgentTarget(Agent* agent);
	// The throttled half: nearest hostile agent, then nearest hostile object,
	// inside `vision`. `scanDue` is the caller's one throttle decision for this
	// tick; `current` is what the agent already holds, which anything returned
	// must strictly outrank. Returns nullptr when there is nothing better.
	Thing* scanAgentSecondaryTargets(Agent* agent, bool scanDue, const Thing* current);
	// How many agents already hold `thingId`, from this tick's census.
	uint16_t agentsTargeting(uint32_t thingId) const;
	// `distSq` re-ranked for how crowded `thing` already is: unchanged up to
	// what its geometry can hold, inflated past that. See
	// AGENT_CROWD_DISTANCE_PENALTY -- this is what spreads a pack across the
	// walls of a base instead of queueing it up at one of them.
	int64_t agentCrowdedDistSq(int64_t distSq, const Thing* thing, float bodyRadius) const;
	// "It just stands there": drops the target when a chasing agent has neither
	// left the spot nor landed a hit for AGENT_STALL_MS. Returns true if it did.
	// Called after the move, so it sees this tick's position. Takes the target's
	// id rather than the pointer -- the caller has already swung, and a lethal
	// swing begins the victim's removal.
	bool noteAgentStall(Agent* agent, uint32_t targetId, uint64_t now);
	// Hand `target` to nearby agents of the same family that have nothing to
	// chase. Called when an agent spots a target first-hand or takes a hit --
	// never by an agent that was itself alerted, so it cannot cascade.
	void alertNearbyAgents(Agent* source, Thing* target);
	void agentMeleeAttack(Agent* agent, Thing* target, const AgentAbility& melee);
	// One cooldown-gated melee swing: at `preferred` if the caller already knows
	// it is in reach, else at whatever hostile findHostileInReach turns up.
	// Returns the victim hit, or nullptr. `face` turns the agent toward the
	// victim -- wanted by the brains that do not already face their target every
	// tick. The single home of the swing rhythm; both brains route through it.
	Thing* agentTrySwing(Agent* agent, const AgentAbility& melee, uint64_t now, Thing* preferred, bool face);
	void stepAgent(Agent* agent, const Position& goal, uint16_t speed);
	// A* over the tile grid. A tile is blocked if the agent's body (agentRadius),
	// placed at the tile centre, would overlap any non-creature obstacle in the
	// tile or a neighbour -- so the path keeps a body-width clear of obstacles.
	// Fills `outPath` with tile-centre waypoints (excluding the start tile).
	// Returns false if same tile, unreachable, or the node budget is hit.
	bool findAgentPath(const Position& start, const Position& goal, float agentRadius, std::vector<Position>& outPath);
	// How far a body of `radius` can travel from `from` along the unit vector
	// (dirX, dirY) before it would hit world geometry or the unreachable band at
	// the map edge, capped at maxDist. A strict test with no glide allowance, so
	// a roam leg is somewhere the agent walks cleanly rather than scrapes to.
	float agentClearRun(const Position& from, float dirX, float dirY, float radius, float maxDist);
	// Walk one movement tick toward `targetPos`: straight, or along a cached A*
	// route once going straight is seen not to work -- either because it has
	// stalled, or because the way ahead is visibly blocked before it gets there.
	//
	// Returns false when this goal has stopped working: no progress and no way
	// round, or the route it was committed to stalled. A chase ignores that and
	// keeps pressing (the player moves, and the situation resolves itself); a
	// wander leg is abandoned for a fresh bearing on the spot, which is what
	// stops a roaming agent leaning on an obstacle until its leg deadline.
	//
	// `allowPathfinding` false means the caller navigates for itself and just
	// wants to be told when this goal is not working. Roaming uses that: picking
	// a new bearing is far cheaper than an A* search, and a wanderer does not
	// care which point it walks to.
	bool agentChase(Agent* agent, const Position& targetPos, uint16_t speed, bool allowPathfinding = true);

	// --- Repair brain (agents.xml <brain type="repair">) --------------------
	void runRepairBrain(Agent* agent);
	// Stand still. Skips the movement pass entirely when there is genuinely
	// nothing to spend, which is what makes a pile of idle bots free.
	void agentIdle(Agent* agent, const Position& apos);
	// Is this object damaged, repairable, and on this agent's owner's side?
	bool isRepairableBy(const Agent* agent, const Object* obj) const;
	// The agent's current repair job, re-validated; nullptr (and cleared) if it
	// finished, died or drifted out of range.
	Object* resolveRepairTarget(Agent* agent);
	// Can this agent actually TRAVEL to within `reach` of `goal`? The exact
	// question, answered exactly: already in reach, or a clear straight run, or
	// an A* route, or no. Reachability is part of being a target at all -- see
	// the comment block above AGENT_JOB_SCAN_MS in agent.h.
	//
	// Unknown is not the same as No: when the shared A* budget is spent this
	// returns Unknown, and the caller must neither select the target nor record
	// it as unreachable. Treating a budget miss as "no" would blacklist a
	// perfectly reachable object for half a minute.
	enum class Reachable { Yes, No, Unknown };
	Reachable canAgentReach(Agent* agent, const Position& goal, float reach, bool keepRoute);
	// Nearest eligible damaged object inside `vision`, from the damagedObjects
	// registry. Skips anything the agent cannot reach; latches what it picks.
	Object* findRepairJob(Agent* agent);
	void agentRepairObject(Agent* agent, Object* obj, const AgentAbility& ability);
	// Nearest hostile THING already within `ability` reach -- player, rival bot
	// or building alike. Tile-local: melee reach is well under a tile, so this
	// never walks the player table.
	Thing* findHostileInReach(Agent* agent, const AgentAbility& ability);
	// Picks the next wander LEG for a world-spawned agent with nothing to chase:
	// a bearing aimed at its journey destination, fanned aside as far as it must
	// be to clear whatever is in the way, and a distance inside the clear run
	// agentClearRun measures along it -- so the leg is straight-line walkable by
	// construction. Picks a fresh journey first if the current one is finished,
	// expired or absent. Player-built agents return to their post instead and
	// never call this; see runAgentBrain.
	void pickAgentRoamGoal(Agent* agent);
	// Picks the far point of the map a roaming agent crosses to next. Random,
	// but validated clear and at least AGENT_ROAM_DEST_MIN_DIST away, so it is
	// a real journey and not somewhere the agent can never stand.
	void pickAgentRoamDestination(Agent* agent);
	void runAgentBrain(Agent* agent);
	// Arms a sidestep on every dodge-capable agent a live bullet is about to
	// hit. Driven from the PROJECTILES, once per movement tick: an agent-side
	// sweep for incoming fire would be a spatial query per agent per tick paid
	// whether or not anybody is shooting, whereas this pass returns immediately
	// when nothing is in flight (or when no loaded agent type dodges at all).
	// Runs at the head of updateAgents, so a dodge armed here is spent by the
	// same tick's movement rather than one tick late.
	void updateAgentDodges();

	// Stamps Thing::getCachedUpdate. Starts at 1 so the default 0 on a fresh
	// Thing is always a miss.
	uint32_t visibilityTick = 1;

	// Absolute deadline for the next movement tick, advanced by exactly
	// MOVEMENT_TICK_MS per tick. See nextGridDelay in game.cpp: the tick rate
	// is the player's walking speed, so this loop cannot be scheduled relative
	// to when the previous one happened to run.
	int64_t nextMovementTickAt = 0;

	std::unordered_map<std::string, GameMode> modes;
	const GameMode* activeMode = nullptr;
	ActiveGauges activeGauges; // resolved from activeMode in Game::start


	WorldClock worldClock;
	float craftSpeed = 1.0f;

	GameState_t gameState = GAME_STATE_NORMAL;
	WorldType_t worldType = WORLD_TYPE_PVP;

	ServiceManager* serviceManager = nullptr;
	uint32_t checkUpdatesEvent = 0;

	void removeExpiredTakenLoot(uint64_t now);

	void dropProjectileItem(Projectile* p, const Position& pos);

	// parseAdminCommand handlers for the larger commands; parseAdminCommand
	// itself stays a thin parse-and-dispatch chain.
	// One handler per !command; parseAdminCommand only parses and dispatches.
	// Returns how many items could NOT be delivered -- the inventory was full
	// and the ground loot id pool had no room left to spend.
	uint32_t adminGiveItem(Player* target, const std::string& itemArg);
	void adminGiveItemToPlayer(const std::string& args);
	void adminSpawnNatural(Player* player, const std::string& args);
	void adminSpawnAgent(Player* player, const std::string& args);
	void adminToggleAgentDebug();
	void adminToggleGhost(Player* player);
	void adminAddLevel(Player* player, const std::string& args);
	void adminPrintBanList();
	// Puts a player on tile (tileX, tileY). Every admin teleport lands a BODY, so
	// they all share this: tileCenterPosition alone clamps the coordinate, not the
	// body, and an off-map tile argument clamps to a centre that is half a body
	// outside the world. See Game::clampBodyPositionToMap.
	void adminPlacePlayerOnTile(Player* target, int32_t tileX, int32_t tileY);

	void adminTeleport(Player* player, const std::string& args);
	void adminTeleportToPlayer(Player* player, const std::string& args);
	void adminTeleportPlayerTo(const std::string& args);
	void adminTeleportAll(Player* player, const std::string& args);
	void adminAdvance(Player* player, const std::string& args);
	void adminKick(Player* admin, const std::string& args);
	void adminKickAll(Player* admin);
	// !open / !close — blocks new logins only; nobody already in is removed.
	void adminSetServerOpen(Player* admin, bool open);
	void adminSetServerName(Player* admin, const std::string& args);
	void adminSetServerType(Player* admin, const std::string& args);
	void adminSetServerLocation(Player* admin, const std::string& args);
	// forced != nullptr for the !hide / !show shorthands, which take no argument.
	void adminSetServerVisible(Player* admin, const std::string& args, bool* forced);
	void adminSetMaxPlayers(Player* admin, const std::string& args);
	void adminPrintServerInfo(Player* admin);
	uint32_t enforcePlayerCap();
	void adminBanPlayer(Player* admin, const std::string& args);
	void adminBanAddress(Player* admin, const std::string& args);
	void adminUnban(Player* admin, const std::string& args);
	void adminSetKarma(const std::string& args);
	void adminQuest(Player* admin, const std::string& args);
	void adminAchievement(Player* admin, const std::string& args);
	void adminSetDayNight(const std::string& args);
	void adminSetCraftSpeed(const std::string& args);
	void adminSetGauge(Player* player, const std::string& spec, const std::string& args);
	void adminReloadXml(Player* admin, const std::string& args);

	// Map import. !map opens a paste session because a map cannot arrive as one
	// command -- see the note on adminMapPaste.
	void adminMapPaste(Player* player, const std::string& args);
	void adminMapRecord(Player* player, const std::string& args);
	void adminMapPlace(Player* player, const std::string& args);
	// !map-preview: what a stamp would do, without doing any of it.
	void adminMapPreview(Player* player, const std::string& args);
	void adminMapUndo(Player* player);
	void adminMapEnd(Player* player);
	void adminMapOrigin(Player* player, const std::string& args);
	void adminMapList(Player* player);
	void adminMapSave(Player* player, const std::string& args);
	void adminMapClear(Player* player, const std::string& args);
	void adminMapForget(Player* player, const std::string& args);
	// !map-keep / !map-drop: move a map into or out of the world manifest, which
	// is what decides whether a !seed rebuild replays it.
	void adminMapKeep(Player* player, const std::string& args, bool keep);
	void adminMapReload(Player* player);
	void adminMapRespawn(Player* player, const std::string& args);
	// `hard` additionally retires every placement, so nothing respawns.
	void adminCleanWorld(Player* player, const std::string& args, bool hard = false);
	void adminSetResourceRespawn(Player* player, const std::string& args);
	void adminSetStructureRespawn(Player* player, const std::string& args);

	// !structure-place / !structure-list: stamp a structures.xml template into
	// the live world, tracked and respawning like a generated one.
	void adminStructurePlace(Player* player, const std::string& args);
	// !effects / !effects-player: the only window onto the condition subsystem,
	// whose entire observable surface is otherwise a skin somebody else draws.
	void adminConditions(Player* player, const std::string& args);
	void adminConditionsPlayer(Player* player, const std::string& args);
	// The cure half of !effects=<key>. Without it a long condition could only be
	// ended by dying, which makes it untestable.
	void adminConditionsCure(Player* player, const std::string& args);
	// The only window onto conditions on an AGENT: it has no client to tell and
	// no skin to draw, so a poison eating one is otherwise invisible.
	void adminConditionsAgent(Player* player, const std::string& args);
	std::string describeConditions(const Player* subject, const std::string& who) const;
	void adminStructureList(Player* player);
	// The live buildings, as opposed to the templates: what is standing, where,
	// and how much of it is left. Everything below addresses one by the id this
	// prints.
	void adminStructureListPlaced(Player* player);
	void adminStructureRemove(Player* player, const std::string& args);
	void adminStructureMove(Player* player, const std::string& args);
	void adminStructureRespawnOne(Player* player, const std::string& args);
	// Names one standing building, by any of the three things an admin would
	// reasonably type: its id, its template key, or "here". 0 on failure, with
	// `error` set to something that says what to type instead.
	uint32_t resolveStructureInstance(Player* player, const std::string& text,
	                                  std::string& error) const;
	// !seed reports; !seed=<n>[:keep|:wipe] rebuilds the world from <n>.
	void adminSeed(Player* player, const std::string& args);
	// !setgroup=<player id or account name>:<group name or id>. The account
	// lives on the web host; this makes two HTTP calls to it (see http_client.h).
	void adminSetGroup(Player* admin, const std::string& args);
	// !map-size reports; !map-size=<x>:<y>[:keep|:wipe] resizes and rebuilds.
	// Also reachable as !map=<x>:<y>, which adminMapPaste can never claim.
	void adminMapSize(Player* player, const std::string& args);

	// Regenerations run ONE AT A TIME, and never back to back.
	//
	// This is pacing, not correctness -- what makes a rebuild safe is that it
	// ends by replacing every client's entity table outright
	// (Player::resetClientEntityCache), so no two rebuilds can leave a client
	// holding a mix of both worlds however they interleave.
	//
	// The queue exists because a rebuild freezes the tick for as long as it
	// takes, and stacked commands arrive with nothing between them: client.js
	// splits an admin line on '!', so "!seed=random!seed=random!seed=random" is
	// three frames the dispatcher runs in ONE batch. Run inline that is three
	// multi-second freezes end to end with no tick in between -- players time
	// out of a server that never gets to breathe. Spacing them lets the world
	// settle and reach every client between rebuilds.
	struct PendingRegen
	{
		uint32_t seed = 0;
		bool preservePlayerBuilds = true;
		uint32_t adminGuid = 0;

		// A resize rides this same queue, because a resize IS a regeneration
		// with the bounds moved first -- and it needs the identical pacing and
		// the identical entity-table replacement at the end. 0 = leave the size
		// alone, i.e. a plain !seed.
		int32_t resizeTilesX = 0;
		int32_t resizeTilesY = 0;
	};
	std::deque<PendingRegen> regenQueue;

	// Moves everything that the new, smaller bounds have left outside the map
	// back inside (creatures) or deletes it (everything else). Runs after the
	// size changes and before the world is rebuilt.
	//
	// Returns how many things were deleted, for the admin reply.
	uint32_t evictOutOfBounds();
	bool regenRunning = false;
	// Recomputed at the end of every generation; see computeWorldFingerprint.
	uint32_t worldFingerprint = 0;
	std::optional<scenario::ActiveScenario> activeScenario;
	std::string startupFailure;

	// Seeded from config in Game::start; see getSpawnCenterX.
	int32_t spawnCenterX = 0;
	int32_t spawnCenterY = 0;
	// A spammed chat line must not be able to queue an hour of rebuilds.
	static constexpr size_t REGEN_QUEUE_MAX = 4;
	// Covers several movement ticks (visibility diff + flushUpdates publish the
	// new world) and the +10ms deferred deletes, with room to spare. The command
	// is rare; correctness is worth far more here than the wait.
	static constexpr uint32_t REGEN_SETTLE_MS = 250;

	void queueRegeneration(uint32_t seed, bool preservePlayerBuilds, uint32_t adminGuid);
	void runNextRegeneration();

	// Sends one line to the admin who issued a command.
	void adminReply(Player* player, const std::string& message) const;

	// Ceiling on !i=<key>*<count>. A work bound only -- what actually keeps the
	// command from draining the ground-loot id pool is adminGiveItem spending at
	// most half the ids currently free, because a count cap cannot: one item of
	// a stack-1 type is one loot entity, so any cap high enough to be useful is
	// also high enough to empty the pool.
	static constexpr uint32_t ADMIN_GIVE_ITEM_MAX = 10000;

	// !clean is irreversible and world-wide, so it has to be issued twice
	// within this window (or as !clean=confirm) before anything is removed.
	static constexpr int64_t CLEAN_CONFIRM_WINDOW_MS = 10000;
	uint32_t cleanArmedBy = 0;
	int64_t cleanArmedAt = 0;
	// Rate-limits the "no paste is open" warning: an orphaned burst would
	// otherwise produce one chat line per record.
	int64_t orphanRecordWarnedAt = 0;

	// Admin commands accept either a GUID or an internal player id.
	Player* resolveAdminTarget(uint32_t id);

	// The last top ten put on the wire, so an unchanged board is not resent.
	// Kept as the values rather than the encoded frame: the comparison is what
	// matters and 40 bytes of struct compare cheaper than a message rebuild.
	static constexpr size_t LEADERBOARD_SLOTS = 10;
	struct LeaderboardSlot
	{
		uint8_t guid = 0;
		uint8_t karma = 0;
		uint16_t score = 0;

		bool operator==(const LeaderboardSlot& other) const
		{
			return guid == other.guid && karma == other.karma && score == other.score;
		}
	};
	std::array<LeaderboardSlot, LEADERBOARD_SLOTS> lastLeaderboard{};
	// Distinguishes "an all-zero board was sent" from "nothing sent yet", so the
	// very first broadcast on an empty server is not suppressed.
	bool leaderboardSent = false;

	// Current standings, sorted and truncated to the ten wire slots.
	std::array<LeaderboardSlot, LEADERBOARD_SLOTS> collectLeaderboard() const;
	// Encodes ten slots as a LEADERBOARD frame.
	static void buildLeaderboardMessage(const std::array<LeaderboardSlot, LEADERBOARD_SLOTS>& slots,
	                                    NetworkMessage& out);
};

#endif // FS_GAME_H
