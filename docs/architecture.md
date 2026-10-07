# Architecture

The browser client connects to the C++ game server over WebSockets. The Express web host serves the browser bundle, assets and generated startup content, and maintains the server-list registry from authenticated game-server heartbeats.

The home screen receives a complete server list on each SSE connection at `/api/servers/events`, followed by changed snapshots. The host batches changes for one second, suppresses unchanged heartbeats, and sends small keepalive comments every 25 seconds. A server expires after three missed heartbeat intervals even when no one polls the list. `/api/servers/list` remains the HTTP fallback. Streams and latency probes pause when the home screen or browser tab is hidden; latency probes are cached independently of list updates. Recent registry entries survive a web-host restart in a signed runtime snapshot, retaining their original expiry times.

Optional accounts are owned by the web host (MariaDB, apps/web/src/accounts). The start page logs in over HTTP and fetches a short-lived ECDSA-signed login ticket for the chosen server; game servers with useDatabase = true verify it offline with the web host's public key (network/account_ticket.cpp) and apply the account's group from data/XML/groups.xml. A ticket names its server as `listingId@host:port` from the web host's registry entry, and a game server accepts only its own `listingId@publicHost:publicPort`, so a server that heartbeats another's listing id cannot collect usable tickets for it.

## Ownership

Account passwords, browser sessions, recovery actions and lifetime progress are stored in the web host's accounts database. Recovery links and codes are single-use and stored as hashes; email addresses become recovery destinations only after verification. The private account dashboard reads persisted progress, while C++ alone awards achievements and records gameplay. Each game server has a separate progress credential, independent of account administration. Survivor runs, golden-cap receipts, permanent clans and historical contributions live in the same account database. C++ submits ordered durable run reports; the account service commits wallet and ranking changes atomically. An explicit ranked-server allowlist controls economy eligibility. Permanent clan identity is separate from temporary gameplay teams. See [account operations](accounts.md) for configuration and session limits.

The client is a view and input sender. Game rules, limits, inventory transactions, economy, NPCs, quests and world state belong to the C++ server. Weapon mods are item state: each Item carries the mod item ids fitted per slot, every item move carries them (ItemState), and Player::getEquippedWeaponData() resolves the equipped gun's stats from them. Aiming is server state: Player::updateAim derives it once per tick, and each player's PlayerView (the viewport box, stretched or shifted by an aimed weak scope, or a strong scope's shape and rear circle with the box its scenery comes from) is the one answer canSee, the visibility scan, the static tile box, spectator lookups and cosmetic broadcasts all use. TypeScript schemas are shared between the browser, web host and content tools; C++ and TypeScript do not import each other's code.

Server source groups:

- `core`: startup, common types, scheduling and low-level utilities.
- `network`: connections, protocols, packet buffers, opcodes and listing.
- `world`: map geometry, placement, structures, tiles and world generation.
- `gameplay`: players, combat, inventory, trading, NPCs and quests.
- `content`: configuration, content loading, validation and export.
- `persistence`: database work and bans.

Headers remain next to their implementations. Includes use paths such as `network/opcodes.h` relative to `apps/server/src`. These folders organize existing code; they do not introduce new libraries or change gameplay behavior.

## Data and generated output

`data/` contains the single authored content tree. `data/XML/content.xml` describes load order, and the indexes reference individual agent, NPC and quest definitions. Existing IDs and include order must remain stable.

`npm run build` exports that content to `dist/content`, builds the browser bundle, sprite manifest and frameless HUD icons (`dist/client/icons`, made from the `*-out.png` button sprites by `tools/assets/item-icons.ts`) into `dist/client`, and builds Express into `dist/web`. The web host serves `dist/content`, never the test fixture directory. Test snapshots are versioned in `tests/fixtures/content`.

The original Devast.io images and sounds are not in the repository. Each operator copies their own into `original-assets/` (see `original-assets/README.md`); `original-assets/manifest.json` lists every expected file by name, size and SHA-256. The web host serves `apps/client/public` first and `original-assets/` after it, and the sprite manifest and HUD icons are built from both folders in that order. With no originals present, everything builds and runs with blanks. `npm run release:audit` checks that no original file, local path or archive-only file is committed.

The C++ build writes its binary and DLLs to `dist/server/<Configuration>` and compiler intermediates to `build/server`. Running the server uses `runtime/<profile>` as its working directory. Each profile has its own config, storage and logs; both development and benchmark profiles read authored content from `data/`.
