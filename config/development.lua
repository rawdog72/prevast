-- Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
-- SPDX-License-Identifier: GPL-2.0-only

-- World Settings
--
-- Map size in TILES (one tile is 100 world units, so 150 = the 15000-unit map
-- this server has always shipped). Tiles rather than units because tiles are
-- what everything downstream actually counts in -- structures, resources, the
-- map editor, and the client's own tile grid -- and a size that was not a whole
-- number of tiles used to be silently truncated at each of them.
--
-- Range 10..655. The ceiling is where `Position` runs out: x/y are uint16, so
-- 65535 is the largest world coordinate that exists and tile 654 is the last
-- one addressable. Going higher needs 32-bit positions in the entity record,
-- which costs 8 bytes on every entity update.
--
-- It was 10..255 until 2026-08-09, because city and house markers reached the
-- minimap as single BYTES and anything past tile 255 wrapped to the corner.
-- That packet carries uint16 pairs now.
--
-- Entity ids are no longer the constraint they were: 24-bit ids cover a fully
-- built 655x655 map (858,050 of 16,777,215) with the pool sized automatically
-- from the map. See clientMaxEntityId below.
--
-- Measured at 655x655 with the shipped settings: boots in ~1.2s, 8 cities and
-- 88 houses, 81,365 entities, 75 MB. Resources follow the area fully while
-- buildings are damped (structureGrowthPercent), so a big map is a bigger
-- world rather than either the same world stretched thin or one endless town.
--
-- Note what that costs the CLIENT: it allocates one tile record for the whole
-- world, ~57 MB at 655x655, rebuilt on every login and every resize. That is
-- the real ceiling on map size for a browser, not anything on the server.
--
-- Changeable at runtime with !map-size=<x>:<y> (or !map=<x>:<y>), which resizes
-- and rebuilds the world in the new bounds. That does not write back here, so a
-- restart returns to whatever is set below.
mapTilesX = 150
mapTilesY = 150

-- How much of the map world generation may cover, as a percentage of its tiles.
--
-- The counts in resources.xml and modes.xml are absolute, and were authored
-- against a 150x150 map where they come to ~39% occupancy. On a smaller map
-- those same numbers pack every tile solid -- which terminates, but leaves a
-- world with nowhere to walk, spawn or build. This is the allowance they are
-- spent from: structures charge against it first, resources take what is left.
--
-- The shipped content is 4,798 tiles of structures plus 5,460 resources, i.e.
-- ~46% of a 150x150 map, so 50 reproduces the standard world exactly and only
-- ever binds on a map small enough for the absolute counts to overrun it. If the
-- boot log prints a "Resource counts scaled" or "structure(s) dropped" line at
-- 150x150, this is set too low.
worldFillPercent = 50

-- Whether those XML counts describe the 150x150 REFERENCE map (true: they scale
-- with area, so a small map is a small version of the same world and a large one
-- is not unfarmably sparse) or are absolute at every map size (false).
--
-- The mix is always preserved: every type scales by one identical factor, so the
-- tree:stone:ore ratio is the same on every map.
scaleWorldContentToMapSize = true

-- How much of the map's AREA GROWTH structures follow, as a percentage.
-- Resources always follow it fully; this damps buildings only.
--
--   100 = buildings keep their density. A 655x655 map is 19x the area of the
--         reference one and got 19 cities and 209 houses, which reads as one
--         continuous town rather than a wilderness with towns in it.
--     0 = the counts in modes.xml are absolute at every map size: one city and
--         eleven houses however big the world is (the pre-2026-08-09 behaviour).
--
-- Buildings are LANDMARKS, so somewhere in between is what you want -- the
-- point of a big map is being able to walk for a while. At the default 40 a
-- 655x655 map gets roughly a third of full density.
--
-- This has NO EFFECT at 150x150, at any value: the damping multiplies the
-- distance from the reference size, which is zero there. So changing it can
-- never alter the standard world or any seed fingerprint taken on it.
structureGrowthPercent = 40

-- Hard ceiling on how many world-spawned agents (ghouls) may be alive at once,
-- applied AFTER the map-size scaling above. 0 = no ceiling.
--
-- Agents scale with area like everything else, because a big map with the
-- reference map's 200 ghouls has nothing in it -- but agents are the one kind
-- of content that costs CPU every tick rather than just memory. A tree is free
-- once placed; a ghoul pathfinds and collides forever.
--
-- Measured on the dev box (2-core FX-4300) at 655x655 with NO CLIENTS
-- CONNECTED: the unbounded scaled population is ~3,796 agents, which put the
-- movement phase at 36-41 ms of the 50 ms tick budget and dropped the server
-- to 13.5-14.2 ticks/s with overruns. Roughly 10 us per agent per tick.
--
-- 500 is about 5 ms of that budget and never binds at 150x150, where the mode
-- asks for 200. Raise it if you have measured your own hardware; the number to
-- watch is `move` in the [PERF] line with the map full of ghouls at night
-- (!set-daynight=night forces it).
agentPopulationCap = 500

gameMode = "survival"

-- Directory the XML content files are read from, relative to the executable or
-- absolute. "XML" is the copy sitting beside the server.
--
-- Every build tree (root, x64/Debug, x64/Release) carries its own copy by
-- default, which is how they drift: an edit made in one is invisible to the
-- others and the difference only shows up as behaviour that will not reproduce.
-- Point this at ONE directory -- e.g. "C:/prevast_server/XML" -- and every tree
-- reads the same files.
--
-- Check an edit without starting a server: prevast_server.exe --validate loads
-- config.lua and everything below it, prints the same report a boot would, and
-- exits 1 if anything warned.
contentPath = "../../data/XML"

-- Whether players can damage each other AT ALL -- weapons, explosions, traps,
-- and their bots. Valid values: "pvp", "no-pvp". An unrecognised value warns at
-- startup and falls back to "pvp".
--
-- "no-pvp" suppresses the HEALTH LOSS only. Knockback, the hit flash and the
-- explosion screen shake all still land, deliberately: players are solid, so a
-- shove is the only way to move someone who is standing in a doorway, and
-- without it one player can block another indefinitely. Shots and swings still
-- connect normally -- they just cannot hurt.
--
-- A player's bots still RAID (see below), but they leave rival players and
-- rival bots alone entirely.
--
-- What "no-pvp" does NOT do: raiding stays legal. Damaging another player's
-- buildings is allowed in both world types, deliberately. Environment damage
-- (radiation, hunger, cold), world monsters, and your own explosives hurting
-- you are all unaffected -- this setting is only ever about one player harming
-- another.
worldType = "pvp"

-- XP for killing another player. Only reachable when worldType = "pvp".
--
-- pvpKillXpPercent is what an EVEN-level kill is worth, as a percent of one of
-- the KILLER's own levels. 0 disables PvP XP entirely.
--
-- It is deliberately NOT a cut of the victim's XP. The level curve is
-- geometric (900 * 1.105^level), so one level costs 2,435 XP at level 10 and
-- 19,413,522 at level 100 -- a flat percentage of the victim would let a
-- level-10 player collect ~800 levels of progress from a single lucky kill on
-- a high-level target. A fraction of the killer's own level means the reward
-- is worth the same amount of PROGRESS at every point on the curve.
--
-- The payout is then scaled by the victim/killer level ratio, so killing up
-- pays more and killing down pays little, and pvpKillXpMaxPercent caps that
-- scaling (200 = a kill can never be worth more than 2x the even-level value).
-- At the defaults, with a level-10 killer:
--     victim level 5   ->    121 XP   (  5% of a level)
--     victim level 10  ->    243 XP   ( 10% of a level)
--     victim level 20  ->    487 XP   ( 20% of a level)
--     victim level 50  ->    487 XP   ( 20% -- ratio capped)
-- Integers only: a fractional value here silently truncates to 0.
--
-- The mode's rateExperience and the killer's karma multiplier apply on top,
-- exactly as they do for monster kills and harvesting.
pvpKillXpPercent = 60
pvpKillXpMaxPercent = 300

-- Connection Config
-- NOTE: maxPlayers set to 0 means no limit
-- NOTE: maxPlayersPerIp limits how many players can be spawned from one IP (0 = no limit)
ip = "127.0.0.1"
bindOnlyGlobalAddress = false
gameProtocolPort = 8172
statusProtocolPort = 8171
adminPassword = ""
httpPort = 8180
httpWorkers = 1

maxPlayers = 255
maxPlayersPerIp = 0
allowClones = false
allowReconnect = true
serverName = "Prevast"
statusTimeout = 5000
maxPacketsPerSecond = 400

-- Per-IP connection rate limiting (server.cpp::acceptConnection).
--
-- On, an IP that opens more than 5 connections within 500 ms is blocked for
-- 3000 ms, and every further attempt during the block extends it by 250 ms.
-- That is anti-DoS protection and it is what you want facing the internet.
--
-- It is also exactly what a stress fleet trips: every bot connects from one IP
-- as fast as it can. This used to be a hardcoded `return true` at the top of
-- acceptConnection, disabling it for every IP on the internet; it is a switch
-- so that turning it off is a decision you can see rather than a source edit
-- someone forgets. The server prints a banner at boot while it is off.
--
-- false = accept every connection at any rate. Local load testing only.
-- Unset defaults to true, so an older config.lua keeps its protection.
connectThrottle = true

-- Server list
--
-- This server POSTs what it is and how full it is to listingUrl every
-- listingIntervalSeconds; the site serves that to the client's server list and
-- drops anything that stops beating. The !server-* admin commands move the
-- live values without writing back here, so a restart is a reset.
--
-- serverType decides which tab of the client's list the server appears on.
serverType = "survival" -- survival | ghoul | br | private | community
-- Region shown next to the name. It must NOT contain BR, PRIV, GHOUL or
-- HIDDEN: the client reads those as category markers and would file the server
-- under the wrong tab. Rejected at boot and by !server-location.
location = "Local"
serverVisible = true

-- The address players should connect to, which the server cannot work out for
-- itself. publicPort = 0 means gameProtocolPort.
publicHost = "127.0.0.1"
publicPort = 0
publicTls = false

-- Empty listingUrl disables the heartbeat entirely. http:// only -- TLS is not
-- compiled in, so keep this endpoint on a plain HTTP port.
listingUrl = "http://127.0.0.1:3100/api/servers/heartbeat"
listingToken = ""
listingId = "prevast-development"
listingIntervalSeconds = 10

-- Threads running socket I/O (accept, websocket read/write). 0 = auto
networkThreads = 0

-- Pack everything one client is told in a tick into a single WebSocket frame
-- (ServerOpcode::BATCH) instead of sending one frame per message.
--
-- The server used to have no choice: client.js dispatched on the first byte of
-- the frame with no length walk, so two messages in one frame corrupted the
-- entity stream. It understands the envelope as of client 1401.
--
-- What it is worth, measured at 250 clients in combat before the change: 2.94
-- frames per client per tick, ~9,000 writes/s, of which ~60% were three-byte
-- PLAYER_HIT flashes each costing a mutex, a queue node, an asio post and a
-- websocket write. Frame COUNT, not bytes, is what that costs.
--
-- false restores one frame per message. Only useful for A/B measurement -- the
-- version gate already guarantees a client that can read the envelope.
batchOutputFrames = true

-- Client entity id space
--
-- How many entity ids exist. 0 = SIZE IT FROM THE MAP, which is what you want.
--
-- Every world entity -- resources, objects, loot, projectiles, agents -- draws
-- a unique id from one shared pool. Two live entities sharing an id alias each
-- other in the client's cache: one sprite for two things, and removing either
-- can orphan the other permanently. Uniqueness is the whole job of this pool.
--
-- Auto (0) allows four ids per tile plus the transient band. A fully built map
-- costs two per tile -- one ground object and one thing standing on it -- so
-- that leaves headroom for loot and bullets on top of a completely built world.
--
-- Setting it by hand is almost never right, and only one direction is safe:
--   too LOW  -> the world stops building / spawning once the pool is dry. The
--               startup report says so plainly. Recoverable.
--   too HIGH -> costs one byte of occupancy table per id and nothing else.
-- The ceiling is 16,777,215 (24-bit ids on the wire; see WIRE ENCODING in
-- definitions.h). It is not the binding constraint on map size -- uint16
-- world positions cap that at 655x655 first.
--
-- This value used to have to MATCH the second argument of Entitie.init() in
-- client.js, and getting it wrong was silent corruption. That coupling is gone:
-- the client no longer addresses world entities through a shared base offset.
clientMaxEntityId = 0

-- Entity ids come from ONE shared pool, not a fixed band per class.
--
-- Whichever class needs ids gets them: raze a forest and the ids those
-- resources held are immediately available to whatever gets built in their
-- place. Per-class bands used to strand roughly 27% of the space in classes
-- that could never approach their ceiling -- resources are capped by
-- resources.xml, agents by the mode's maxTotal, projectiles by flight time --
-- while player building, the one genuinely elastic class, hit a wall at its
-- band edge well before the map was full.
--
-- The pool is partitioned two ways, and only two:
--
--   RESERVE -- a floor no other class may borrow into. Only projectiles have
--              one. Every other exhaustion explains itself on screen (respawn
--              stalls, dropped items are lost, building refuses); running out
--              of projectile ids just means the shot does not happen, with
--              nothing anywhere to say why.
--              0 = size it automatically from maxPlayers and the worst weapon
--              in equipables.xml, which is what you want unless you are
--              deliberately overriding it. Auto or not it is clamped to a
--              tenth of the space, so a content edit can cost a warning but
--              never starve every other class.
--
--   CAP     -- a ceiling, 0 = uncapped. A safety valve for the two elastic
--              classes, not something that should normally fire. Cap objects
--              to stop one clan converting the whole id space into walls; cap
--              loot if lootDespawnSeconds is 0, since ground loot only returns
--              its id when it despawns and at 0 the pool drains one way.
--
-- The resolved budget -- and what the loaded content and the map size actually
-- demand against it -- is printed at startup. Read it after any XML or map
-- change; that report is the whole reason these are only three knobs.
entityIdReserveProjectiles = 0
entityIdCapObjects         = 0
entityIdCapLoot            = 0

-- Performance profiling
-- Prints a [PERF] line every 5s with achieved tick rate and a per-phase
-- breakdown of the 20Hz game loop, and appends the same data to perf_log.csv
-- (written next to the executable). Used by tools/stress to compare builds.
perfStats = true

-- Deterministic world generation. 0 = seed from the clock (normal play).
-- Any non-zero value makes resource/object spawning reproducible across
-- restarts, which is REQUIRED for a meaningful before/after benchmark:
-- entity count at zero players was measured at 5805, 8722 and 9038 across
-- three unseeded restarts, and visibility cost scales with it, so an unseeded
-- A/B compares two different worlds rather than two builds.
-- BENCHMARK RIG VALUE -- do NOT propagate this line to the root config.lua.
-- This copy is the load-test rig; a fixed seed is what makes two legs of an
-- A/B compare two builds instead of two different worlds.
seed = 20260718

-- How far, in world units, a player is told about entities in each direction.
--
-- This is the single setting that decides how much the server has to think
-- about per player, and it used to be quadratic in almost everything: the
-- per-player visibility sweep, every projectile's collision search, every melee
-- swing and the per-player environment scan all asked for "everything in the
-- viewport" regardless of how local their real question was. Raising it hurt
-- far more than it should have.
--
-- That is fixed (see OPTIMIZATION_NOTES.md section 10). Measured envelope on a
-- 2-physical-core AMD FX-4300 -- a deliberately slow box -- at the full
-- protocol ceiling of 255 players, dispersed, every player dirty every tick AND
-- every player firing an automatic weapon:
--
--   maxViewport 2500  ->  18.1 ticks/s of 20, tick 24.7ms of a 50ms budget
--
-- so 2500 is comfortable and there is headroom above it. The costs that remain
-- viewport-shaped are the static visibility sweep (paid only when a player
-- crosses a tile boundary) and the number of entities a client is sent, which
-- is bandwidth rather than CPU.
--
-- Raise it only as far as the client actually renders: sending entities the
-- player cannot see costs bandwidth on every one of them.
maxViewportX = 1400
maxViewportY = 900

-- How far a purely COSMETIC event is broadcast: the hit flash, the heal pulse,
-- the eat animation, gauge notifications. Distinct from maxViewport, which is
-- how far a client is told entities EXIST. The client only draws about
-- 1280x720 world units (client.js: options.size = 1280, and
-- scaleby = max(height/880, width/1280)), so a flash further away than this
-- cannot be seen by anyone.
--
-- This is the single setting that decides how a crowded firefight behaves.
-- These are the only messages that cost one WebSocket frame PER SPECTATOR per
-- event: measured 2026-08-05 with 250 players crowded and shooting, they were
-- 31-34k frames/s against ~750/s for the entire entity stream, and backed the
-- per-connection output queues up 3,500-5,800 messages deep.
--
-- 0 restores the old behaviour (broadcast to the whole viewport).
eventBroadcastRadius = 1000

-- Minimum gap, in milliseconds, between hit-flash broadcasts about one victim
-- to OTHER players. client.js sets `player.hurt = 300` when it receives
-- PLAYER_HIT, so a second flash inside 300ms only restarts a timer that is
-- already running -- nothing on screen changes. An automatic weapon lands ~8
-- hits a second, so most of that fan-out was invisible.
--
-- The victim's own client is never throttled: that is one frame, and it is
-- what carries their screen shake. 0 disables the throttle.
hitFlashThrottleMs = 300

-- Object push-out
-- Whether an object that lands on a player (e.g. a door swinging shut on
-- them) actively pushes the player back out. Normal wall/object collision is
-- unaffected by this setting and always works. When false, an overlapped
-- player is not shoved anywhere: they can simply walk out of the object
-- themselves. When true, the push is small per tick and can never squeeze a
-- player into or through another object.
pushPlayerOutOfObjects = true

-- Does the hit/heal flash from ENVIRONMENT damage reach other players?
--
-- Radiation, hunger, cold and poison ticks flash the same red aura a bullet
-- does, and that flash is one WebSocket frame per player who can see the
-- victim. It is the only damage source that fires for EVERYONE at once, so in
-- a crowded radioactive area it becomes the server's dominant cost: N players
-- standing together cost N^2/2 frames every two seconds. Measured with ~200
-- players in one viewport, ~5,000 of the 6,400 frames/s leaving the server
-- were these -- against ~1,000 for the entire entity-update stream -- and the
-- tick rate fell from 20/s to 5/s, which players feel directly as everyone
-- walking at a quarter speed (movement applies a fixed distance per tick).
--
-- false = the victim still sees their own flash and screen shake; nobody else
-- does. Weapons, explosions and traps are UNAFFECTED either way -- they still
-- flash for everyone, so combat stays exactly as readable.
--
-- Set this back to true if you would rather have the visual and can accept the
-- cost (it is only noticeable when many players share one viewport).
showEnvironmentDamageToOthers = true

-- Interaction slow lock
-- Flat movement speed taken away while reloading, equipping, consuming
-- or crafting in the own inventory (base walk speed is 230, run is 322).
-- Multiple interactions do not stack; running keeps its full bonus.
interactionSlowAmount = 70

-- Loot despawn
-- Untouched ground loot (including player drops) despawns after this many
-- seconds. 0 = never despawn (testing default).
lootDespawnSeconds = 15

-- MySQL
-- useDatabase = true is the full account system (accounts + this server's DB);
-- false is guests and adminPassword only, with in-memory bans. With true, the
-- server refuses to start if it cannot connect to MySQL.
useDatabase = true
mysqlHost = "127.0.0.1"
mysqlUser = "root"
mysqlPass = ""
mysqlDatabase = "prevast"
mysqlPort = 3306
mysqlSock = ""
-- Account system (only with useDatabase = true). Accounts live on the web
-- host; this server checks the login tickets it signs, offline, with its
-- public key: base64 of the raw P-256 point, from GET /api/account/public-key
-- on the web host (npm run setup fills it in for local development).
-- listingId must be set: tickets are issued for listingId@publicHost:publicPort
-- (as the web host's server list saw this server's heartbeat), so those must be
-- the address players actually reach this server on.
accountPublicKey = ""
-- false: every account joins in group 1 (still verified). Community servers
-- that do not want the network's staff as their staff set this to false.
trustAccountGroups = true
-- !setgroup changes an account's group on the web host. Empty token disables
-- the command on this server; the environment variable
-- PREVAST_ACCOUNT_ADMIN_TOKEN overrides accountAdminToken. The token travels
-- over plain HTTP (TLS is not compiled in), so keep accountServiceUrl on
-- loopback or a private network.
accountServiceUrl = "http://127.0.0.1:3100"
accountAdminToken = ""
-- Separate trusted-server credential, never accepted for changing account roles.
-- PREVAST_ACCOUNT_PROGRESS_TOKEN overrides this value.
accountProgressToken = ""
-- Account stats and achievements (kills, crafts, survival records...) are
-- saved to the account on the web host, through accountServiceUrl with
-- accountProgressToken. Guests and servers without those never record anything.
-- Off for benchmark and test profiles, which must not write to real accounts.
recordAccountProgress = true

-- Misc.
-- Remove a player who has done nothing for this many minutes. 0 = never.
--
-- Counts wall-clock time since the last sign of a human: a move, a turn (the
-- client sends one per mouse move), a chat line, or a click. Admins are exempt.
--
-- This covers two different kinds of idle, and the second is the important one:
-- a dropped connection leaves the CHARACTER in the world as AFK, and it used to
-- stay there forever, holding a GUID slot against the hard 255-player ceiling.
-- Those are now swept out on the same timer.
--
-- A kick is not a death: the character leaves with its inventory, nothing is
-- dropped on the ground, and nothing it built is destroyed.
kickIdlePlayerAfterMinutes = 30
maxMessageBuffer = 4

-- The level every new character starts at, before kits.xml grants anything on
-- top of it. 0 is the client's own starting level: client.js initialises
-- PLAYER.level = 0 with PLAYER.nextLevel = 900, and derives skill points
-- straight from the level, so a level-0 player simply has none yet. The server
-- used to hardcode 1, which handed out the first level (and its skill point)
-- for free.
--
-- Changing this does NOT stretch or compress the XP curve. A character is
-- seeded with the XP its starting level is worth, so the amount still owed for
-- the next level is the same at any setting -- the only difference is where
-- counting begins. Values above 0 are still "free" levels; capped at 200.
--
-- kits.xml startLevel only ever raises a character above this floor, never
-- below it.
startingLevel = 0

-- Clan Settings
clanActionDelay = 2000

-- Karma / Self-defense Settings (in minutes)
selfDefenseMinutes = 20

-- Player spawn point.
--
-- Placement is validated (Game::isSpawnPositionValid): a player never spawns
-- on an object, on a building floor or road, on a colliding resource, on loot,
-- on top of another player, or against the map edge.
--
-- spawnSpread = 0 means every player is placed at (spawnX, spawnY), which is
-- what the server did unconditionally before this was configurable. Occupied
-- spots now fan out instead of stacking, but it is still by far the most
-- expensive arrangement: visibility cost is O(players sharing a viewport) per
-- player, so concentrating N players on one point makes the tick quadratic in
-- N regardless of how big the map is. Measured on a 4-core FX-4300 with 500
-- players and every player dirty every tick:
--   spawnSpread = 0     -> 0.2 ticks/s (a tick takes 5 seconds)
--   spawnSpread = 6500  -> 14.1 ticks/s of a 20 target
-- Set a spread unless a single-point spawn is a deliberate gameplay decision.
spawnX = 4000
spawnY = 4000
spawnSpread = 0

maxConnections = 1024
maxConnectionsPerIp = 64

-- Mutable NPC stock; authored content stays under data/.
storagePath = "storage"
