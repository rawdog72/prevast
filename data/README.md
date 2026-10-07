# Server content

Edit content here. The Release configuration points back to this directory, so
there is one editable copy for both development and the running server.

```text
data/
  XML/                  Shared tables and ordered file indexes
    content.xml         Load-order dependencies
    npcs.xml            NPC includes and stable spawn locations
    agents.xml          Agent includes, in declaration order
    stats.xml           Account stats: what is counted, from which events
    achievements.xml    Account achievements: requirements, points, rewards
  npc/
    merchant.xml        One NPC: appearance, movement, shop, general dialogue
    banker.xml
    quartermaster.xml
    smuggler.xml
    scripts/rook.lua    Optional dialogue hook
  agents/               One creature or bot definition per XML file
  quests/               One quest per file, named after its key: starts, stages,
                        objectives, rewards, journal text and quest dialogue
```

An index `<include file="../npc/merchant.xml"/>` loads exactly one `<npc>`
definition. The agent index follows the same rule with root `<agent>`.
Quests have no index: every `quests/*.xml` loads, in file-name order. Includes are relative to the index and must
stay inside `data/`. Nested, missing, duplicate and oversized includes fail
validation. Declaration order and all existing entity/item IDs are preserved.

## NPCs and quests

NPC XML owns prices in integer caps, stock ranges, availability chances,
restock intervals, purchase limits, karma policies, appearance and ordinary
dialogue. Spawn keys in `XML/npcs.xml` identify persistent stock; changing a
spawn key creates a different shop. Keep these keys stable.

Each quest is one file, `quests/<key>.xml`; the key must match the file name.
A quest has start triggers (`<talk>`, `<event>`, `<use>`, `<requires>`),
stages with keyed objectives and outcomes, endings, and optional
`<dialogue npc=...>` lines gated by stage or state. The first stage is the
entry stage. An outcome pays rewards and leads to another stage,
`end:<ending>` or `fail`. Objective types are kill, bounty, craft, gather,
destroy, build, pickup, use, talk and give. A give objective takes what the
player carries, up to what is still owed, so hand-ins can be split. A kill
also counts when the agent dies of something else (sun, fire) after the
player dealt at least half its health within the last 30 s. An NPC keyword belongs to one
quest. Journal text is plain text; the client never renders it as HTML.
`docs/quest-authoring.md` is the practical guide to writing a quest, with
scripts, areas and achievements;
`docs/design/quest-progression.md` documents
every element and attribute.

NPC files keep general dialogue only; a reply with `quest=` or `state=` is
rejected. An NPC answers quest keywords before its own topics, and a karma
rule with `quests="false"` blocks them.

Use `!reload-quests` to validate and replace quests. A rejected reload keeps
the running definitions. A successful one keeps each player's stage when its
key still exists, and objective counts by key. `!reload-npcs` replaces NPCs
and cached Lua; it refuses to drop an NPC a quest still names. For testing,
`!quest=start|stage|reset|complete:<guid>:<quest>[:<stage or ending>]`
controls one character's quest (complete pays no rewards).

## Account stats and achievements

`XML/stats.xml` and `XML/achievements.xml` describe what is kept on a
player's account forever, across servers. Ids are stored in the accounts
database: never change or reuse one, retire it with `retired="true"`. A stat
counts events (`<count event= target= family= owner=/>`); an achievement
unlocks when its `<requires stat= atLeast=/>` all hold, or when a quest
outcome grants it (`<achievement key=.../>`). Quests may also require one
(`<requires achievement=.../>`, `<requires stat=... atLeast=.../>`). The
comment at the top of each file lists every attribute.

Only players with an account, on a server with `recordAccountProgress = true`,
`useDatabase = true`, `accountServiceUrl` and `accountProgressToken`, record
anything. The server stores deltas on the web host every 30 s and when a
connection drops; what could not be sent waits in
`storage/progress-outbox.json` and is sent after the next start. A crash can
lose up to 30 s of stats. `!achievement=grant|revoke:<guid>:<key>` is for
testing and support; `!reload=progress` reloads both files (and the quests,
which name them).

## Station fuel

In `XML/objects.xml`, `<fuel itemKey="wood" burnDurationPerUnitMs="15000" addAmount="15"/>`
sets the fuel item, burn time per item, and initial amount selected in the crafting
window. Players can choose a different amount; `addAmount` is not a required batch
size. The server limits additions to carried fuel and the station's 254-unit capacity.

## Weapon mods

`XML/mods.xml` defines each mod: `slot` (magazine, optic, muzzle, underbarrel,
side, stock, handguard), `installMs`, `capacity` for magazines, and
`<stat name= add= percent=>` changes. Every mod is also an item in `items.xml`
with the same key, `stack="1"` and `<weaponMod key="..."/>`. A weapon takes
mods by listing them in `equipables.xml`:
`<mods><slot type="optic" accepts="reflex_sight,tube_scope" default="..."/></mods>`
-- explicit keys, one slot per type, an optional default fitted when the
weapon is created. A weapon with a magazine slot has no `magazineSize`: the
fitted magazine's `capacity` is its capacity, and a magazine keeps its rounds
when it is taken out. The formula is
`(base + sum of adds) x (1 + sum of percents / 100)`, clamped; stat names are in
`apps/server/src/gameplay/weapon_mods.h` and their limits in `weapon_mods.cpp`.
`--validate` rejects unknown keys, mods of the wrong slot type, a default outside
`accepts`, `magazineSize` beside a magazine slot, a weapon with `<ammo>` that has
neither a `magazineSize` nor a magazine slot, and a moddable weapon's item that
is not `stack="1"`. The Mods window's side-view art is
`<client><modArt>` on the weapon and `<client art= box= anchorX= anchorY=>` on
each mod; `tools/assets/mp5-mod-art.mjs` regenerates the SMG parts.

## Aiming and scope views

A weapon aims when it has `<aim spreadPercent= movePercent= timeMs=>` in
`equipables.xml`: while the right button is held, its spread eases from the hip
value to `spreadPercent` less over `timeMs`, and the player walks at
`movePercent` less and cannot run. Mods change this with the stats
`aimSpread`, `aimMove` and `aimMs`, resolved after the others; only a weapon
with `<aim>` may accept such a mod. An optic (or an aiming weapon, as a
built-in scope) may carry `<view shape="stretch|shift" ahead= zoom= extend=>`:
while aimed, the server sends that player the viewport box stretched (nothing
lost) or shifted (the strip behind is lost) `extend` toward the aim, and the
client slides its view up to `ahead` toward the cursor and multiplies its zoom
by `zoom`. `extend` must cover `ahead` for a client zoomed all the way out;
`--validate` checks it against `config.lua` maxViewportX/Y. A shift view's
`extend` may be at most the smaller of maxViewportX/Y minus 200, so the player
and 200 units behind them stay sent; the strip that is lost behind also drops
shots fired from there.

A strong shape replaces the box instead: `<view shape="cone" reach=
halfAngleDeg= zoom= rearRadius=>` or `<view shape="rect" length= width= back=
zoom= rearRadius=>`. While aimed, only what lies inside the shape or within
`rearRadius` of the player is sent, the client's zoom is `zoom` whatever the
player chose, and everything else is darkened. A strong scope sees farther,
never more: the shape plus the rear circle may cover no more than the
2·maxViewportX × 2·maxViewportY box, and `--validate` checks that against
`config.lua`. `--validate` also prints a note (not a warning) when the far
end passes 0.85 × 880 / `zoom`, where it leaves the screen when aiming up or
down.

## Runtime storage

`storagePath` in `config.lua` defaults to `storage`, relative to the server's
working directory. Each server instance needs its own storage directory.
Shared shop state is stored in one `storage/npc-stock.xml`: schema version,
and each merchant spawn's restock epoch, interval and remaining quantities. Do not place this state in
the authored NPC XML or copy test storage to production.

Finite purchases save an atomic snapshot before exchanging items. Write errors
disable shops for that process; nothing is charged for a failed sale. Correct
the storage problem and restart to restore the last committed snapshot. Loading
the same definitions, reopening a shop, and reconnecting do not refill it.
Restock changes take effect at the existing deadline. A clock rollback does not
reroll an earlier epoch. A legacy `npc-stock.json` is migrated automatically and
retained as `storage/legacy-stock.json.bak`; corrupt state fails closed.

Currency uses 255 units per tier: 255 bottle caps = 1 banknote; 255 banknotes =
1 gold bar (65,025 caps). Prices, quest rewards and bank balances remain in caps.

Bank and quest progress belong to the living character, matching the existing
server lifetime model: reconnecting retains them; death and server restart
clear them. This change does not add durable player saves. Shared stock survives
restart. A crash after a stock save and before the in-memory inventory exchange
can consume stock without granting the item; inventory and stock are not a
durable database transaction. Durable characters would require that wider save
system, not just a separate bank balance file.

## Action budgets and Lua

NPC work is limited before inventory planning, Lua or persistence: 5 actions/s
per living character with an initial burst of 10; 40/s per IP with a burst of
80; 200/s globally with a burst of 40. The character budget survives connection
takeover. Transport also has a separate NPC admission budget and existing
bounded packet/output queues. Finite-stock disk commits have a global 20/s
budget with a burst of 2. Closing a conversation remains available.

Normal clicks are immediate. Excess actions are dropped; the client requests a
fresh snapshot after 2.5 seconds rather than repeating a purchase. Session IDs,
monotonic request IDs, quote revisions, range and karma are checked server-side.
All exchanges reject overflow and commit inventory changes together. Other shop
visitors' stale quotes are invalidated immediately and refreshes are coalesced.

Inventory, prices, banking, quest checks and AI remain in C++. XML loads once
into C++ structures. Lua is optional dialogue logic, loaded from `npc/scripts/`
when content loads; there is no script-file read per chat message. A fresh
sandbox has a 1 MiB allocation budget and a 10,000-instruction hook with JIT
disabled. Hooks return intentions; only the C++ transaction paths can mutate
economic state. They cannot open files, use the network, or select arbitrary
server APIs. Use XML for ordinary dialogue and Lua for branching that needs it.

## Validation

From the configured server working directory, run `prevast_server.exe --validate`.
This uses the real loaders without opening ports or generating a world. Build
the Release x64 target after changing C++ and update the client at the same time.
The client repository provides `npm run check`, `npm run content:export`,
`npm run content:parity`, and `tools/live-npc-test.ts` for an isolated test server.


Account progression rules live in `account-progression.json`. These are consumed directly by C++ and the account service; they are not inventory currency or a browser content table. Use existing achievement keys. Script event caps require a configured event key and a stable occurrence id (`{ accountEvent = "key", occurrence = "event-edition" }`); repeats for an account are deduplicated permanently. Bump the rules version for economy changes and deploy both services together. See [account operations](../docs/accounts.md).
