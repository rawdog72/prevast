-- Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
-- SPDX-License-Identifier: GPL-2.0-only

-- World Settings
-- Size in TILES (100 units each); range 10..255. See the shipped config.lua
-- for the full note. This is the benchmark rig and is deliberately divergent
-- from that file -- do not overwrite it wholesale.
mapTilesX = 150
mapTilesY = 150
gameMode = "benchmark"

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
worldType = "no-pvp"

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
gameProtocolPort = 8272
statusProtocolPort = 8271
adminPassword = ""
httpPort = 8280
httpWorkers = 1

maxPlayers = 255
maxPlayersPerIp = 0
allowClones = false
allowReconnect = true
serverName = "Prevast"
statusTimeout = 5000
maxPacketsPerSecond = 400

-- Threads running socket I/O (accept, websocket read/write). 0 = auto
networkThreads = 0

-- Client entity id space
--
-- client.js keys its ENTIRE entity cache -- every entity type, one flat array
-- -- on a single index:
--     index = (pid == 0 ? 0 : localUnitsCount) + pid*unitsPerPlayer + id16
-- laid out by Entitie.init(600, maxUnitsMaster, localUnits) as
--     [0 .. maxUnitsMaster)  entities the SERVER sends with pid == 0
--     [maxUnitsMaster ..  )  entities the CLIENT creates itself (particles)
--     [localUnitsCount .. )  per-player entities
--
-- Two live entities landing on the same index alias each other. The client's
-- Entitie.get validates a cache slot by uid ALONE -- never by type -- so a
-- collision silently duplicates an entity, and Entitie.remove then deletes
-- only the first copy it finds. The survivor can never be removed again. For
-- loot that leftover copy re-aims itself at whoever picked the item up on
-- every frame, forever: the "ghost loot follows the player around" bug.
--
-- clientMaxEntityId MUST match the SECOND argument of Entitie.init() in
-- client.js.
--   too HIGH -> the server hands out ids the client uses for its own
--               particles and for players. Silent entity corruption with no
--               error anywhere. This is the dangerous direction.
--   too LOW  -> wasted id space, nothing else. Safe.
-- Current client.js ships 65536. Set this to 30000 if any of your players may
-- still be running a client from before that was raised.
--
-- This is also the ceiling on MAP SIZE. A fully built-out map costs two ids
-- per tile (one ground object, one thing standing on it), so 65536 ids run out
-- at 181x181 tiles -- the current 150x150 fits with room to spare. Going
-- bigger means widening ClientEntityId in definitions.h AND the second
-- argument of Entitie.init() in client.js, together. The startup report warns
-- when the configured map already needs more ids than exist.
clientMaxEntityId = 65536

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
seed = "random"

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
maxViewportX = 1700
maxViewportY = 1700

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
showEnvironmentDamageToOthers = false

-- Interaction slow lock
-- Flat movement speed taken away while reloading, equipping, consuming
-- or crafting in the own inventory (base walk speed is 230, run is 322).
-- Multiple interactions do not stack; running keeps its full bonus.
interactionSlowAmount = 70

-- Loot despawn
-- Untouched ground loot (including player drops) despawns after this many
-- seconds. 0 = never despawn (testing default).
lootDespawnSeconds = 5

-- MySQL
-- useDatabase = true is the full account system (accounts + this server's DB);
-- false is guests and adminPassword only, with in-memory bans. With true, the
-- server refuses to start if it cannot connect to MySQL.
useDatabase = false
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
accountProgressToken = ""
-- Account stats and achievements: never from a load-test server.
recordAccountProgress = false

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

-- Mutable NPC stock; authored content stays under data/.
storagePath = "storage"

contentPath = "../../data/XML"

-- Benchmark instances are not advertised in the public registry.
listingToken = ""
listingUrl = ""
listingId = "prevast-benchmark"
