// Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
// SPDX-License-Identifier: GPL-2.0-only

#ifndef FS_MAPIMPORT_H
#define FS_MAPIMPORT_H

#include "world/placement.h"
#include "core/position.h"

#include <deque>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

struct ObjectData;
class Player;

// Importing maps drawn in the client's own map editor.
//
// --- The wire format -------------------------------------------------------
//
// client.js's Editor exports one record per building (editorBuildtoCode,
// client.js:12056):
//
//     !b=<itemId>:<j>:<i>:<rotation>                 4 fields
//     !b=<itemId>:<subtype>:<j>:<i>:<rotation>       5 fields
//
// and editorUseCode (client.js:12006) reads them back. Field counts are how the
// two forms are told apart -- there is no marker -- so a record with any other
// count is malformed rather than salvageable.
//
//  itemId    the items.xml id. The client writes INVENTORY[extra >> 7].id and
//            the server sends (od.id & 0x1FF) << 7 in `extra` (object.cpp), so
//            this is exactly the same number on both sides. It is NOT unique:
//            everything in furnitures.xml inherits the "furniture" item id
//            through its type, which is why the 5-field form exists. See
//            ObjectManager::resolveMapItem.
//  subtype   present only for items whose INVENTORY entry carries a subtype
//            ARRAY -- road and furniture (client.js:24885, 25852). For
//            furniture it selects the object; for road it selects the texture.
//  j, i      tile coordinates: j is X, i is Y, both 0..149 (the client
//            hardcodes a 150x150 world at client.js:14153).
//  rotation  0..3.
//
// A record's world position is the plain tile centre, (j*100+50, i*100+50) --
// the same point playerPlaceObject uses. The editor's xCenter[] offset must NOT
// be applied here: the client re-derives it on receipt (client.js:18531), so
// adding it server-side puts every wall 30 units off its tile.
//
// Rotation needs no special handling either. The editor forces rotation 0 for
// items with wall=1 when it imports (client.js:12027) and exports whatever it
// stored, so wall and floor records already carry 0.
//
// --- Why a paste arrives in pieces -----------------------------------------
//
// An admin cannot send a map as one chat line. client.js:10925 splits any admin
// line on '!' and sends each fragment as its own WebSocket frame, and
// Game::playerSay splits on '!' again, so "!map=!b=1:2:3:0!b=2:3:4:1" reaches
// the server as three separate commands. `!map=` therefore opens a SESSION and
// the b= fragments that follow feed it; it commits on an idle timeout or on
// `!map-end`. A code that does arrive whole (from a file, or a client that does
// not split) is parsed by the same function, so there is one parser either way.
//
// --- Why the work is sliced ------------------------------------------------
//
// A full map is thousands of objects and `!clean` is every static entity on the
// map. Doing either in one dispatcher task blocks the game tick for as long as
// it takes -- at 20 Hz that is visible to every player as a freeze. All bulk
// work is therefore a job queue drained a slice at a time from a timer.

// One parsed, validated record. Parsing resolves the object once so placement
// and every later respawn are pointer chases rather than repeated lookups.
struct MapEntry
{
	const ObjectData* od = nullptr;
	uint16_t tileX = 0;
	uint16_t tileY = 0;
	uint8_t rotation = 0;
	uint8_t subtype = 0;
	// The resolved object is a variant carrier (road): `subtype` is a texture
	// index this entry has to apply itself. False when the subtype already
	// picked the object, which is the furniture case.
	bool appliesSubtype = false;
};

// Per-record rejection tally. Counts rather than a log line each: a bad paste
// tends to be bad in one way thousands of times over.
struct MapParseReport
{
	uint32_t accepted = 0;
	uint32_t malformed = 0;    // wrong field count, non-numeric, rotation > 3
	uint32_t outOfBounds = 0;  // off the map once the origin is applied
	uint32_t unknownItem = 0;  // no object in the loaded XML carries that id
	uint32_t badSubtype = 0;   // id known, subtype is not one it can wear

	uint32_t rejected() const { return malformed + outOfBounds + unknownItem + badSubtype; }
	std::string summary() const;
};

struct MapDefinition
{
	// The map's name, and how every !map-* command refers to it. Spelled `key`
	// because that is what a string identifier is called in every content file.
	std::string key;
	std::string sourceFile;  // empty for a pasted map that was never saved
	std::string modeKey;     // empty = load under every game mode
	int32_t originX = 0;     // tile offset added to every record
	int32_t originY = 0;
	uint32_t respawnMs = 0;  // 0 = never; stamped once and left alone
	bool enabled = true;
	// Is this map part of what the WORLD is made of, or merely something the
	// library can place on request?
	//
	// Only an autoPlace map is stamped by world generation, which is what a
	// !seed rebuild replays. A live paste is library-only: it went onto the map
	// because an admin asked once, and replaying it on every rebuild is how a
	// map an admin had pasted, then !cleaned away, came back at the next
	// !seed=random. Promote a paste with !map-keep.
	bool autoPlace = true;
	// Whether stamping bulldozes objects a player built. Never applies to a
	// RESPAWN, which always skips an occupied tile instead.
	bool bulldozePlayerBuilds = true;

	std::vector<MapEntry> entries;
	uint64_t nextRespawnAt = 0;
	bool stamped = false;

	// Tile bounds of `entries`, for the placement record and the admin listing.
	// Empty entries leaves this zeroed.
	PlacementRect bounds() const;
};

class MapImportManager
{
public:
	MapImportManager() = default;

	// non-copyable
	MapImportManager(const MapImportManager&) = delete;
	MapImportManager& operator=(const MapImportManager&) = delete;

	// --- Content -----------------------------------------------------------

	// Reads every <contentPath>/maps/*.map. A missing directory is not an error:
	// a server with no maps simply has none.
	//
	// One file IS one map: a small `key = value` header above the editor's own
	// record string. The record parser ignores any line without a '!' in it, so
	// such a file is simultaneously a complete asset and a raw paste from the
	// editor's copy button -- which is what lets !map-save produce something
	// that loads with no second edit anywhere.
	//
	// Load order is the sorted file name, so two maps sharing a tile land the
	// same way every time.
	bool loadAssets();

	// Legacy XML/maps.xml, kept only to migrate off it: every <map> it declares
	// is written out as a .map asset (never overwriting one) and the admin is
	// told they can delete the file. Reading it does NOT count as a content
	// load, which is why it is no longer declared in content.xml.
	uint32_t convertLegacyDefinitions(const std::string& xmlPath, const std::string& assetDir);

	// Queues a stamp for every enabled map that this mode selects. Called once
	// during world generation, after structures so a map wins over a city.
	//
	// Called again by a !seed regeneration, which rebuilds the world around the
	// players still living in it; `preservePlayerBuilds` overrides each map's own
	// bulldozePlayerBuilds so a regeneration cannot flatten a base the admin
	// asked to keep.
	void stampStartupMaps(const std::string& activeModeKey, bool preservePlayerBuilds = false);

	// Runs the whole queue to completion instead of a slice at a time.
	//
	// For world generation only. Slicing exists to keep a LIVE tick responsive;
	// during startup there is no tick to protect and no player to notice, and
	// the world has to be finished before resources populate around it --
	// otherwise trees spawn on tiles a queued map has not claimed yet.
	void drainJobs();

	// Warns when a stamped map shares tiles with a world-generated structure.
	//
	// The two respawn independently and neither knows about the other, so on its
	// next cycle the city rebuilds the parts of itself the map bulldozed --
	// StructureManager::respawnStructures treats a floor as non-blocking and
	// clears the tile to lay its own. The map then re-stamps on its cycle, and
	// the tile flips back and forth forever. Nothing crashes, which is exactly
	// why it needs saying out loud at startup rather than being discovered as
	// "my map keeps changing".
	void warnOnStructureOverlap() const;

	// --- Timers ------------------------------------------------------------

	// Drains one slice of the job queue and expires an idle paste session.
	// Registered on its own short timer; see MAP_JOB_PERIOD_MS.
	void update();

	// Queues a respawn pass for every map whose cycle is due. Driven from
	// Game::updateRespawn so maps re-stamp on the same beat as cities.
	void updateRespawn();

	// --- Paste session -----------------------------------------------------

	void beginSession(uint32_t adminGuid, const std::string& name);
	// Appends one `b=...` fragment (or a whole code) to the open session.
	// Returns false when nothing is open, so the caller can say so.
	bool feedSession(const std::string& fragment);
	void commitSession();
	bool hasSession() const { return session.active; }

	// --- Commands ----------------------------------------------------------

	// Parses `code` and stamps it as `id`, replacing any map already under that
	// id. Returns the parse report so the caller can tell the admin what was
	// dropped.
	MapParseReport stampCode(const std::string& id, const std::string& code,
	                         uint32_t adminGuid, bool bulldozePlayerBuilds);

	bool queueStamp(const std::string& id, uint32_t adminGuid,
	                bool forcePreservePlayerBuilds = false);

	// Stamps a map with its corner at a chosen tile instead of where it was
	// drawn. The records keep their own coordinates and the difference is
	// applied at PLACEMENT, so one drawing can be put down in several places
	// without being re-parsed for each. `error` says why on a refusal.
	bool queueStampAt(const std::string& id, int32_t tileX, int32_t tileY,
	                  uint32_t adminGuid, std::string& error);

	// What stamping `id` would do, without doing any of it: how big it is, what
	// it would cost in entity ids, and what it would destroy.
	struct PreviewReport
	{
		bool valid = false;
		PlacementRect rect;
		uint32_t objects = 0;
		uint32_t idCost = 0;
		uint32_t idsFree = 0;
		uint32_t playerBuilds = 0;  // tiles holding something a player built
		uint32_t structureTiles = 0; // tiles inside a tracked building
		uint32_t resources = 0;
		uint32_t offMap = 0;
		std::string error;
	};
	PreviewReport preview(const std::string& id, const int32_t* atTileX = nullptr,
	                      const int32_t* atTileY = nullptr) const;

	// Removes what the most recent stamp placed. Only a stamp can be undone --
	// a !clean cannot, because the objects it removed are gone with their state.
	// Returns the map id undone, or empty.
	std::string undoLastStamp(uint32_t adminGuid);
	// Removes every object this map's live placements still own. The map stays
	// in the library, so !map-place puts it back; !map-forget drops it.
	//
	// Reads the placement record rather than the tiles. The old form matched
	// "an object with this key and no owner standing here", which deleted the
	// city underneath wherever two stamps overlapped.
	bool clearMap(const std::string& id, uint32_t adminGuid);
	// Drops a map from the library, clearing it first. A map loaded from a file
	// comes back on !map-reload; a paste is gone for good.
	bool forgetMap(const std::string& id, uint32_t adminGuid);
	// Moves a map into (or out of) the world manifest, so a !seed rebuild
	// replays it. This is what promotes a paste from "placed once" to "part of
	// the world".
	bool setAutoPlace(const std::string& id, bool autoPlace);

	// Every static entity on the map: objects (world and player built),
	// resources and ground loot. Creatures are never touched.
	//
	// `retireInstances` additionally drops every placement record, so nothing --
	// no map respawn, no city respawn -- puts the world back. That is the
	// !clean-hard behaviour; plain !clean leaves the records standing and lets
	// the respawn timers refill, which is what it has always done.
	void queueClean(uint32_t adminGuid, bool retireInstances = false);

	// A sliced removal of named entities, reported as `label`.
	//
	// Public so that anything needing to take a lot of things off the map at
	// once -- a structure being removed, not only a map -- goes through the one
	// queue. Two queues would mean two orderings, and "clean, then place" would
	// stop meaning what it reads like.
	void queueRemoval(std::vector<uint32_t>&& victims, uint32_t adminGuid,
	                  const std::string& label);
	bool saveMap(const std::string& id, std::string& outPath);

	// A map key that is safe as a file name. Rejects empty, over-long, and
	// anything outside [A-Za-z0-9._-]; in particular a key may not contain a
	// path separator or "..", which !map=<name> would otherwise let an admin
	// walk out of the maps directory with at !map-save time.
	static bool isValidKey(const std::string& key);

	// 0 = never respawn. `id` empty sets the default and every loaded map.
	bool setRespawnMs(const std::string& id, uint32_t ms);
	uint32_t getDefaultRespawnMs() const { return defaultRespawnMs; }

	void setPasteOrigin(int32_t tileX, int32_t tileY) { pasteOriginX = tileX; pasteOriginY = tileY; }
	void getPasteOrigin(int32_t& tileX, int32_t& tileY) const { tileX = pasteOriginX; tileY = pasteOriginY; }

	const std::unordered_map<std::string, MapDefinition>& getMaps() const { return maps; }
	// Most recently stamped map, so !map-save and !map-clear can default to
	// "the one I just pasted" rather than making the admin retype its name.
	const std::string& getLastStampedId() const { return lastStampedId; }
	bool busy() const { return !jobs.empty(); }

	// Parses a code into entries. Public so a definition file and a paste share
	// one implementation, and so it can be exercised directly.
	static std::vector<MapEntry> parseCode(const std::string& code, int32_t originX, int32_t originY,
	                                       MapParseReport& report);

private:
	enum class JobType : uint8_t
	{
		Stamp,
		Respawn,
		Clean,
	};

	struct Job
	{
		JobType type = JobType::Stamp;
		std::string mapId;
		uint32_t adminGuid = 0;
		bool bulldozePlayerBuilds = true;
		// Placement being filled (Stamp) or topped up (Respawn). Opened at the
		// first slice, so a job that is refused up front never leaves a record.
		uint32_t instanceId = 0;
		// Tile offset added to every record as it is placed. Non-zero only for
		// a !map-place that named a destination; the records themselves keep
		// the coordinates they were drawn at.
		int32_t offsetX = 0;
		int32_t offsetY = 0;
		// A Clean job that is bookkeeping rather than something the admin asked
		// for -- retiring the previous placement before a re-stamp -- reports
		// nothing on completion.
		bool quiet = false;

		size_t cursor = 0;
		uint32_t placed = 0;
		uint32_t skipped = 0;
		uint32_t failed = 0;
		uint32_t removed = 0;
		uint32_t refilled = 0;
		bool outOfIds = false;

		// Tiles this job has already bulldozed. A tile legitimately receives
		// several records -- the editor exports four layer passes, so a floor
		// and the wall standing on it are separate entries -- and clearing per
		// record would delete the floor while placing the wall.
		std::unordered_set<uint32_t> clearedTiles;

		// !clean only: ids rather than pointers. The job spans many ticks and
		// anything can die in between, so every slice re-resolves through the
		// map's id index instead of holding raw pointers across a tick.
		std::vector<uint32_t> victims;
	};

	struct Session
	{
		bool active = false;
		uint32_t adminGuid = 0;
		std::string name;
		std::string code;
		uint64_t lastFragmentAt = 0;
		uint32_t fragments = 0;
		bool truncated = false;
	};

	// Dispatches one slice of `job`, which may pop it off the queue.
	void runSlice(Job& job);
	void runStampSlice(Job& job);
	void runRespawnSlice(Job& job);
	void runCleanSlice(Job& job);
	void finishJob(const Job& job);

	// Places one record. `isRespawn` switches from "bulldoze and place" to
	// "only fill a gap nothing else has claimed".
	void placeEntry(const MapEntry& entry, Job& job, bool isRespawn);

	// One .map file into the library. Returns false and says why on the console.
	bool loadAssetFile(const std::string& path);
	// Serialises a definition in the .map format: header, then records.
	std::string composeAsset(const MapDefinition& def) const;

	std::string nextPasteName();
	void report(uint32_t adminGuid, const std::string& message) const;

	// Retires every live placement of `id` and queues the removal of what they
	// still own. Returns how many entities were queued. `quiet` suppresses the
	// completion line for an internal retire.
	uint32_t queueRetire(const std::string& id, uint32_t adminGuid, bool quiet);

	std::unordered_map<std::string, MapDefinition> maps;
	std::deque<Job> jobs;
	Session session;
	std::string lastStampedId;

	uint32_t defaultRespawnMs = 0;
	uint32_t pasteCounter = 0;
	int32_t pasteOriginX = 0;
	int32_t pasteOriginY = 0;
};

extern MapImportManager g_maps;

#endif // FS_MAPIMPORT_H
