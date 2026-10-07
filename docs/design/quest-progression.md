# Quest and progression system

The standalone quest system, account stats and achievements, and Lua quest scripting: how they are authored, validated and run. `docs/quest-authoring.md` is the practical guide; this document is the reference for every element and rule.

## Problem

- Quests live inside `NpcSystem` (`gameplay/npc_quests.cpp`, `quest_content.cpp`, `npc.h`). Every quest needs one `giver` NPC and can only be accepted or completed through that NPC's dialogue.
- One quest is spread over four files: `data/quests/<key>.xml`, `data/quests/logs/<key>.xml`, and entries in `data/XML/quests.xml` and `data/XML/questlog.xml`.
- A quest is a flat list of at most 8 objectives with three states (not started, active, done) and one reward. There are no stages, branches or mid-quest rewards.
- Objective types are string comparisons in `NpcSystem::event`, which loops over every active quest on every event. Only kill, bounty, craft and talk/delivery are reported.
- The client sees quests only inside the NPC window, as part of the NPC session state. There is no journal or tracker.
- Lua is limited to NPC `onTalk`, and `npc_script.cpp` creates a new Lua state and recompiles the script on every chat message.
- Nothing persists beyond the living character. There are no account achievements or stats.

## Goals

- Quests are a standalone system. NPCs, events, items, scripts and admins can start and advance them.
- One file per quest, with a branching stage graph, rewards per outcome, and journal text inline.
- One typed game-event layer feeds quests, stats and scripts. A new objective type is one event plus one handler.
- Two scopes: quests belong to the living character (reset on death); stats and achievements belong to the account (global across servers).
- The client has a quest journal, a HUD tracker, NPC quest markers, and an achievements/stats tab.
- Lua can react to subscribed events and return validated intents, including world actions, without per-call compilation or lag.

Out of scope: website/public profile pages (the storage supports them), viewing other players' achievements in-game, account-scoped quests, durable character saves.

## Decisions

| Question | Decision |
|---|---|
| Persistence | Quests: living character only, as today. Account: achievements and public stats. |
| Account scope across servers | Global per account. Servers with `recordAccountProgress = false` (benchmark, tests) do not write. Guests earn nothing. |
| Stage flow | Branching graph: `all`/`any`/named-objective outcomes, each with its own `next`. Loops only when marked. |
| Lua power | Intents plus validated world actions (spawn agent, give/take item, apply condition, delayed hook). |
| Client UI | Journal (Active / Completed / Achievements), HUD tracker, NPC `!`/`?` markers. |
| Architecture | Shared event bus feeding `QuestSystem` and `ProgressSystem` (not achievements-as-quests, not Lua-first). |
| Areas | Inline in the quest, bound to structures or NPC spawns because the live world is regenerated every restart. Raw x/y allowed with a startup warning when the seed or map size is not fixed. |

## Architecture

```text
 agent.cpp  player.cpp  game.cpp  npc.cpp  (future emitters)
      \         |          |        /
       └──── EventBus::emit(GameEvent) ────┐
                 |              |          |
           QuestSystem    ProgressSystem  ScriptRuntime
           (life scope)   (account scope)  (subscribed events only)
                 |              |
        QUEST_* opcodes   PROGRESS_* opcodes ──► web host /api/servers/progress ──► MariaDB
```

- `gameplay/progress/` holds `game_event.h` (event types, `GameEvent`, `EventBus`) and `ProgressSystem`.
- `gameplay/quests/` holds definitions, loader/validator, `QuestSystem` (progress, outcomes, rewards, NPC hooks, markers) and the script runtime.
- `NpcSystem` keeps shops, banking, general dialogue, karma rules and NPC scripts. It asks `QuestSystem` about talk; it no longer stores quest definitions or progress.
- C++ remains authoritative. Lua and the client never mutate state directly.

### Events

```cpp
enum class EventType : uint8_t { Kill, Bounty, Craft, Gather, Destroy, Build, Pickup, Use, Give, Talk,
                                 QuestComplete, Death, SurvivedMinute, EnterArea, LeaveArea };
struct GameEvent {
    EventType type;
    Player* actor;
    std::string_view subject;   // agent / item / object / resource / npc / area key
    uint32_t count = 1;
    const EventContext* ctx;    // optional: victim player, position, npc spawn, keyword, spawn tag
};
```

- Gameplay code reports events with `g_events.emit` (`EventType` in `game_event.h`): kill, player kill, bounty, gather, craft, destroy, build, pickup, use, death, quest complete, survived minute, and area enter and leave. Talk and give objectives go through the NPC dialogue hooks instead.
- Listeners keep an index keyed by `(EventType, subject)` so an event touches only the objectives, stats and scripts that declared interest.
- Emitting is synchronous and cheap. Listeners must not emit recursively except through the quest outcome path, which is bounded (see Error handling).

## Quest file format

One file per quest in `data/quests/*.xml`, discovered in sorted file-name order. No index and no separate log file. Keys stay stable identifiers.

```xml
<quest key="long_road" name="The Long Road" category="side"
       description="Rook is trying to reopen the road to the bank.">

  <start>
    <talk npc="quartermaster" keyword="road" confirm="true"
          text="The road is overrun. Clear some ghouls, or bring {bandages} for my men."/>
    <requires quest="ghouls" state="completed"/>
  </start>

  <stage key="clear" journal="Help Rook: clear ghouls from the road, or supply his men with bandages.">
    <objective key="ghouls"   type="kill" target="normal_ghoul" count="5" text="Kill normal ghouls"/>
    <objective key="bandages" type="give" npc="quartermaster" item="bandage" count="3" keyword="bandages"
               text="Give Rook 3 bandages" reply="These will keep my men alive."/>
    <outcome when="ghouls"   next="report"><reward caps="150"/></outcome>
    <outcome when="bandages" next="report"><reward caps="100"/><reward item="canned_food" count="2"/></outcome>
  </stage>

  <stage key="report" journal="Tell Elias at the bank the road is open.">
    <objective key="elias" type="talk" npc="banker" keyword="road"
               text="Speak to Elias" reply="Open again? Then I owe you. Take this."/>
    <outcome when="all" next="supplies"><reward caps="200"/></outcome>
  </stage>

  <stage key="supplies" journal="Elias needs firewood for the winter. Gather wood and bring it to him.">
    <objective key="gather"  type="gather" target="wood" count="20" text="Gather wood"/>
    <objective key="deliver" type="give" npc="banker" item="wood" count="20" keyword="firewood" after="gather"
               text="Bring 20 wood to Elias" reply="That will last the winter."/>
    <outcome when="all" next="end:done"><reward caps="300"/></outcome>
  </stage>

  <ending key="done" journal="The road is open and the bank is warm for the winter."/>

  <dialogue npc="quartermaster">
    <reply keyword="road" stage="clear"     text="Still ghouls out there. Or bring {bandages}."/>
    <reply keyword="road" stage="report"    text="Go tell Elias."/>
    <reply keyword="road" state="completed" text="The road holds. Good work."/>
  </dialogue>
</quest>
```

### Elements

- `<quest>`: `key`, `name` (1–64 bytes), `category` (`main`, `side`, `daily`; display only), `description`, optional `repeat="cooldown" cooldownSeconds="…"`, optional `abandon="false"`, optional `hidden="true"`, optional `script="…"`. A hidden quest is never sent to the client (no `QUEST_STATE`, tracker entry or marker); its rewards and messages still show on the status line. Hidden quests suit silent one-time rewards such as "the first workbench you destroy drops an axe".
- `<start>`: one or more triggers plus optional `<requires>`. A quest with no trigger can only be started by another quest's intent, a script or an admin.
- `<stage>`: `key`, `journal`, 1–8 objectives, 1+ outcomes. At most 32 stages per quest. The first stage in the file is the entry stage.
- `<objective>`: `key` (unique within the quest), `type`, `text`, type-specific attributes, optional `after="<objective key>"` (does not count until that objective is complete).
- `<outcome>`: `when` = objective key, `all` or `any`; `next` = stage key, `end:<ending key>` or `fail`. Children: `<reward caps=…/>`, `<reward item=… count=…/>`, `<achievement key=…/>`. The first outcome in file order whose condition holds wins.
- `<ending>`: `key`, `journal`. At least one per quest.
- `<dialogue npc=…>`: flavour replies gated by `stage=` (current stage) or `state=` (`not_started`, `active`, `completed`, `failed`).

### Objective types

| Type | Attributes | Counts when |
|---|---|---|
| `kill` | `target` (agent key, or `@tag` for quest-spawned agents) | the player kills a matching agent, or it dies of something else (sun, fire) after that player dealt at least half its health within the last 30 s |
| `bounty` | `minVictimKarma` (default 4) | the player kills a distinct player with that karma, not from the same IP (current rules) |
| `craft` | `item` | the player crafts the item; `count` is the yield |
| `gather` | `target` (resource key) | the player harvests from that resource |
| `destroy` | `target` (object key), optional `owner` | the player destroys that object |
| `build` | `target` (object key) | the player places that object |
| `pickup` | `item` | the player picks the item up |
| `use` | `item` | the player uses/consumes the item |
| `talk` | `npc`, `keyword`, optional `reply` | the player says the keyword to that NPC |
| `give` | `npc`, `item`, `count`, `keyword`, optional `reply` | the player says the keyword; whatever they carry is taken, up to what is still owed (partial hand-ins add up). The journal and tracker show the carried count |
| `enter_area` | inline `<area …/>` | the player enters the area |

`owner` filters events on owned world objects (`destroy`, and `build` for `self`): `any` (default), `self` (the player's own), `clan` (the player's clan mates'), `other` (neither the player's nor their clan's), `none` (objects with no owner). The same attribute works on `<event>` start triggers and on stat `<count>` elements, and scripts see it as `ev.owner`. It exists so repeatable rewards cannot be farmed by building and destroying one's own objects. Ownership comes from the object's `ownerPid`/clan at the moment it is destroyed.

The old types map as: `bring` → `give` to the giver, `delivery` → `give` to the target NPC, `kill`/`bounty`/`craft`/`talk` unchanged.

### Starts and prerequisites

- `<talk npc keyword [confirm="true"] text>`: saying the keyword starts the quest. With `confirm`, the NPC shows `text` and waits for `{yes}` / `{no}` in the same session.
- `<event type target count [owner]/>`: the quest starts automatically when the player has produced `count` matching events in this life. Pre-start counters are stored with the player's quest progress. The event that starts the quest is then also applied to the entry stage, so "start on destroying a workbench" plus a stage objective "destroy a workbench" completes in the same moment.
- `<use item/>`: using the item starts the quest.
- `<requires quest state/>`, `<requires karmaMin karmaMax/>`, `<requires achievement/>` and `<requires stat atLeast/>`. All must hold.
- Admin: `!quest start|stage|reset|complete <player> <quest> [stage]`.

### Load validation (fails the load)

- Unique quest keys, objective keys per quest, stage keys, ending keys.
- Every `next` resolves; every stage is reachable from the entry stage; at least one ending is reachable.
- A cycle between stages is an error unless one stage on it has `loop="true"`.
- Every referenced agent, item, object, resource and NPC exists; keywords are 1–64 bytes.
- The same `(npc, keyword)` pair may be used by only one quest. Within a quest it may repeat across stages.
- `after` names an objective in the same stage and does not form a cycle.
- Limits: 32 stages, 8 objectives per stage, 8 reward entries per outcome, 64 quests total.

## Quest runtime

```cpp
struct QuestProgress {
    QuestState state;                       // Active, Completed, Failed
    std::string stage, ending;
    std::map<std::string, uint32_t> counts; // by objective key
    std::vector<StageRecord> history;       // stage key, outcome key, rewards paid
    std::map<std::string, QuestVar> vars;
    uint64_t started = 0, finished = 0;
    std::set<uint32_t> victims;             // bounty de-duplication
};
```

- Progress is keyed by player ID and lives as long as the character: reconnect keeps it, death clears it (as today). `QuestSystem::forget` runs where `NpcSystem::forget` runs now.
- When a counter reaches its target, `QuestSystem` checks the stage's outcomes. A matched outcome pays rewards through the existing inventory exchange planner (`Inventory::ExchangePlan`). If the exchange cannot be planned (full bag), the stage does not advance and the player is told to make room; the next relevant event or talk retries.
- On advance: record history, reset counts for the new stage, emit `QuestComplete` on an ending, send `QUEST_STATE`.
- Abandon: allowed unless `abandon="false"`; removes the progress.
- Repeat: unchanged rule. A completed quest can restart only with `repeat="cooldown"` after `cooldownSeconds`.

### NPC dialogue order

`NpcSystem::talk` resolves a message in this order:

1. Built-in words: `bye`, `hi`/`hello`/`help`, `trade`/`shop`, `bank`/`balance`.
2. `QuestSystem::onTalk(player, npcKey, keyword)`:
   1. an active `talk` or `give` objective for this NPC and keyword;
   2. a pending `confirm` offer (`yes`/`no`);
   3. a start trigger the player may use;
   4. quest `<dialogue>` replies matching the player's stage or state.
3. The NPC's own topics.
4. The NPC's Lua `onTalk`, then its fallback.

The NPC karma rule `quests="false"` blocks step 2 for that NPC and answers with the rule's reply. The `quests`/`journal` keywords no longer open an NPC panel; they list the quest keywords this NPC can start for the player.

### Reload

`!reload-quests` loads and validates the new files first and keeps the old definitions on failure. On success each player keeps their stage if its key still exists and objective counts by key. If the current stage was removed, that quest's progress is dropped and logged. `!reload-npcs` keeps working for NPC files and re-validates quest NPC references.

### Content layout and load order

- `content.xml` removes `quests.xml` and `questlog.xml` and declares the `quests/` directory as discovered content, loading after `npcs.xml` (quests reference NPCs; NPCs no longer reference quests).
- Quest content is not exported to `dist/content`. Quest text reaches the client only through `QUEST_STATE`, so unvisited stages are never revealed.

## Protocol, journal, tracker and markers

Protocol 1411 (`CLIENT_VERSION_MIN/MAX`, client `PROTOCOL_VERSION`, `shared/protocol/README.md`).

| Opcode | Direction | Layout | Sent |
|---|---|---|---|
| `QUEST_STATE` | S→C | `[u16 questId][u8 cause][str json]` | on start, advance, complete, fail, abandon; on login/reconnect and after a reload (one per quest) |
| `QUEST_PROGRESS` | S→C | `[u16 questId][u8 objectiveIndex][u32 count]` | when a counter changes |
| `QUEST_MARKERS` | S→C | `[u8 n]([u16 npcId][u8 kind])*n` (npcs.xml id, the NPC entity's extra, so markers survive an NPC reload) | when the player's set of marked NPCs changes; kind 1 = can start (`!`), 2 = can advance (`?`) |
| `QUEST_ACTION` | C→S | `[u16 questId][u8 action]` | 1 = abandon, 2 = resync |

- `questId` is the quest's index in the loaded set. After a reload the server sends cause 6 (reset, questId 0xFFFF) and then every quest again. `objectiveIndex` indexes the current stage's objectives as sent in the last `QUEST_STATE`.
- `cause`: 0 sync, 1 started, 2 advanced, 3 completed, 4 failed, 5 removed (abandoned or reset by an admin; empty string), 6 reset (drop every entry).
- The JSON is validated by a zod schema in `shared/typescript/quest-protocol.ts`: name, category, description, state, the stages the player has reached (key, journal, objectives with key/text/type/count/required/after/locked, outcome taken, rewards paid), whether it may be abandoned,, and the ending journal when finished. Future stages and unused branches are never sent.
- `QUEST_ACTION` shares the NPC per-character action budget.
- Markers are computed server-side per player only when that player's quest state or karma changes, and only for NPCs within view.
- The NPC `quests` panel and the `quests` array in `npc-protocol.ts` are removed.

### Client

- `ui/windows/quest-window.ts`: hotkey J plus a HUD button. Tabs Active | Completed | Achievements. List on the left; on the right the current stage journal and objective rows (`Kill normal ghouls 3/5`, done rows ticked, `after`-locked rows dimmed), then "Story so far" with completed stages and rewards. Track/Untrack and Abandon (with confirmation).
- `ui/hud/hud-quest-tracker.ts`: right edge below the minimap, up to 3 tracked quests with live objective rows, collapsible. New quests are auto-tracked while a slot is free. Tracked quest keys are a per-viewer preference in `localStorage`, wrapped in try/catch.
- Notifications through the existing status line and alerts: new quest, stage complete with rewards, quest complete, quest failed. A completed objective row flashes in the tracker.
- Entity renderer draws `!` / `?` above NPCs from `QUEST_MARKERS`.
- On an unknown `questId` or a zod failure the client sends `QUEST_ACTION` resync instead of throwing.

## Account stats and achievements

### Content

`data/XML/stats.xml` and `data/XML/achievements.xml`, declared in `content.xml` after `agents.xml`/`items.xml`. IDs are numeric, unique and never reused; removal is `retired="true"`.

```xml
<stat id="1" key="kills.ghoul"  name="Ghouls killed" public="true"><count event="kill" family="ghoul"/></stat>
<stat id="4" key="quests.done"  name="Quests completed" public="true"><count event="quest_complete"/></stat>
<stat id="5" key="life.longest" name="Longest survival (min)" public="true" aggregate="max"><count event="survived_minute"/></stat>

<achievement id="1" key="ghoul_slayer" name="Ghoul Slayer" description="Kill 500 ghouls." grade="2" points="10">
  <requires stat="kills.ghoul" atLeast="500"/>
</achievement>
<achievement id="2" key="road_warden" name="Road Warden" description="…" grade="1" points="3" secret="true"/>
```

- `<count>` filters by `event`, and optionally `target` (key), `family` or `tag`. A stat may have several `<count>` children.
- `aggregate="sum"` (default) adds; `aggregate="max"` keeps the highest value, measured per life for survival records.
- An achievement with `<requires>` unlocks when all hold. One without is granted only by a quest outcome `<achievement key/>`, a Lua intent or an admin. `grade` 1–3, `points` 0–100, `announce` defaults to true for grade 3.
- An achievement may carry `<reward caps=…/>` and `<reward item=… count=…/>` (at most 8). They are paid once, to the character that unlocks it, at the moment of unlock (including admin grants). An unlock is never delayed by a full bag: items that do not fit are dropped at the player's feet. Revoking does not take rewards back. This is the "first time ever on this account" reward; the per-life equivalent is a non-repeatable (optionally hidden) quest.

### Server

- `ProgressSystem` subscribes to the event bus. It records only for players with `accountId != 0` on servers with `recordAccountProgress = true` (production configs true; benchmark and test profiles false).
- On login it loads the account's stats and unlocks from the web host asynchronously. Events before the load completes are buffered (bounded) and applied after it.
- Each stat has an index of dependent achievements; an increment evaluates only those. An unlock is immediate in memory, notifies the player, and may announce server-wide.
- Writes are batched deltas: every 30 s, on logout and on shutdown, via `HttpClient::requestAsync`. Sums use `value = value + n`; maxima use `GREATEST`. Each batch has an ID `<listingId>:<boot>:<seq>`; retries reuse it. Unsent batches are written to `storage/progress-outbox.json` on shutdown and sent on the next start. A crash can lose at most 30 s of stats.
- Admin: `!achievement grant|revoke <player> <key>`, logged.

### Web host

Tables created by `MysqlStore.init()` alongside the existing ones:

```sql
account_stats        (account_id, stat_id SMALLINT UNSIGNED, value BIGINT UNSIGNED, updated_at BIGINT, PK (account_id, stat_id))
account_achievements (account_id, achievement_id SMALLINT UNSIGNED, unlocked_at BIGINT, PK (account_id, achievement_id))
progress_batches     (batch_id VARCHAR(96) PK, received_at BIGINT)   -- pruned after 7 days
```

Routes, authenticated like the existing `/api/servers/accounts/*` routes:

- `GET /api/servers/progress/:accountId` → `{ stats: {id: value}, achievements: [{id, unlockedAt}] }`
- `POST /api/servers/progress` with `{ batchId, accounts: [{ accountId, add: {id: n}, max: {id: v}, unlock: [{id, at}] }] }`; a known `batchId` is acknowledged without applying.

The memory store implements the same methods, covered by the store contract tests.

### Client

- Stats and achievements are exported as content tables. Secret achievements are exported without name and description.
- Protocol 1411: `PROGRESS_STATE` `[str json]` full snapshot once loaded; `PROGRESS_UPDATE` `[u8 n]([u16 statId][u32 value])*n`, at most every 2 s, value saturating; `ACHIEVEMENT_UNLOCKED` `[u16 id][u32 at][str json]` with text for secret achievements.
- The journal's Achievements tab shows total points, a grid (unlocked with date, locked with `312/500` progress when single-stat, secret as `???`) and the public stats list. Guests see "Log in to earn achievements."
- Quest `<requires achievement/>` and `<requires stat atLeast/>` are unmet until the account progress has loaded.

## Lua scripting, world actions and areas

### Scripts

- Quest scripts: `data/quests/scripts/<name>.lua`, named by `<quest script="…">`. Trigger scripts: `data/scripts/triggers/*.lua`, discovered in sorted order. NPC scripts stay in `data/npc/scripts/`.
- A script returns a table:

```lua
return {
  on = { "destroy:car", "kill:radioactive_ghoul" },
  onEvent = function(ctx, ev)
    if ev.subject == "car" and (ctx.quest.vars.cars or 0) >= 9 then
      return { { start = "scrapyard" }, { say = "Something stirs in the wreckage..." } }
    end
    return { { setVar = "cars", add = 1 } }
  end,
  onStageEnter = function(ctx, stage)
    if stage == "ambush" then
      return { { spawnAgent = "armored_ghoul", count = 3, near = "player", radius = 300, tag = "ambush" },
               { status = "An ambush!" } }
    end
  end,
}
```

- Hooks: quest scripts `onStart`, `onStageEnter(stage)`, `onStageComplete(stage, outcome)`, `onEvent`, `onEnd(ending)`; trigger scripts `onEvent`; NPC scripts `onTalk` (existing contract, may now also return quest intents).
- `ctx` is a read-only snapshot: player (id, name, karma, health, position, verified), quest (key, stage, counts, vars), account stats and unlocked achievement keys if loaded (`ctx.account.loaded`, `ctx.account.stats`, `ctx.account.achievements`), and the states of the player's quests (`ctx.quests[key]`); `ev` is type, subject, count, position and `owner` (`self`, `clan`, `other`, `none`).

### Intents

| Group | Intent | Limits |
|---|---|---|
| Quest | `start`, `advance` (outcome key), `complete` (ending key), `fail`, `setVar` (`value` or `add`), `grantAchievement` | vars: 16 per quest, number or string ≤ 64 bytes |
| Messages | `say`, `status` | ≤ 256 bytes |
| World | `spawnAgent` (key, count ≤ 5, `near="player"`, radius ≤ 1000, tag), `giveItem`, `takeItem`, `applyCondition` (key, durationMs, strength) | spawned: 10 alive per player, 200 per server |
| Timing | `after = { seconds, hook }` | ≤ 4 pending per player, 1–3600 s |

- All intents from one call are validated before any is applied. One invalid intent drops the whole result and logs the script name.
- `giveItem` uses the inventory exchange; if the bag is full the item is dropped at the player's feet. `takeItem` fails the call's result if the items are missing.
- Quest-spawned agents are tagged with quest, tag and player. `kill` objectives can target `@tag`. They despawn when the quest ends, the player dies or disconnects.

### Runtime

- Scripts are compiled once at load and on reload; `--validate` compiles them. Each script keeps one sandboxed LuaJIT state (JIT off, the current library removals). After the load chunk runs, globals are frozen; per-player state lives in quest vars.
- Per call: 1 MiB memory, 10,000 instructions. Per player 20 calls/s, server-wide 500 calls/s. Over budget: the call is skipped, C++ still counts the event, the skip is logged at most once per minute per script.
- Three consecutive failures disable a script until the next reload and warn online admins.
- Only events matching a script's `on` list reach it. Scripts run on the game thread after the triggering event has been fully applied.
- Each script's time is recorded by name in `core/perf.h`.
- NPC scripts move onto this runtime; `rook.lua` needs no change.

### Areas

Inline in the objective, start trigger or script subscription:

```xml
<area structure="house3"/>                        <!-- any placed copy of that structure -->
<area near="npc:quartermaster" radius="400"/>     <!-- around an NPC spawn -->
<area x="4200" y="3100" radius="300"/>            <!-- raw coordinates -->
```

- World generation records the bounds of each placed structure. `near="npc:…"` uses the spawn position from `npcs.xml`.
- Raw coordinates produce a startup warning when `seed` is 0/random or `scaleWorldContentToMapSize` is on, because the live world is regenerated every restart.
- Player positions are checked every 500 ms against a spatial grid of active areas and emit `EnterArea`/`LeaveArea` for subscribers only.

## Error handling

- Content: quests, stats, achievements, areas and scripts are validated (scripts compiled) at startup, by `prevast_server --validate`, and on every reload. Any error fails the load; a failed reload keeps the running content.
- Rewards: paid all at once or not at all; a stage never advances with a partial payout.
- Outcome chains: an advance may immediately satisfy the next stage's outcome; at most 8 advances are processed per event to stop runaway loops, with a log line if the limit is hit.
- Web host unavailable: deltas stay in memory and the outbox with exponential backoff (max 5 min). Achievements still unlock in-game.
- Client: unknown IDs or schema failures trigger a resync instead of an exception.

## Testing

What covers each part:

- Quests: `npm run server:build`, `npm run server:validate` with negative fixtures for each validation rule (under `runtime/`, never `data/`); `npm run content:parity`; `live-npc-test.ts` covering start, branch outcomes, `give` with a full bag, `after`, abandon, death reset, reload mapping.
- Protocol and client: zod schema tests; encoder/decoder tests and a replay fixture in `tests/fixtures/net/`; unit tests for `quest-window`, `hud-quest-tracker` and markers; live test asserting the `QUEST_STATE`/`QUEST_PROGRESS` sequence; `npm run check`.
- Stats and achievements: store contract tests (memory and MySQL) for delta merge, max aggregation and duplicate batch IDs; route tests; live test killing agents and checking stat, unlock and outbox replay.
- Scripts and areas: validation of script compile errors and bad subscriptions; live test with test-only content in a runtime profile covering subscriptions, intent validation, budget cut-off, disable-after-failures and cleanup of spawned agents.
