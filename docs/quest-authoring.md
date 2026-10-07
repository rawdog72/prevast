# Writing quests, achievements and scripts

The practical reference. Design and reasoning are in
`docs/design/quest-progression.md`.

## Where things live

| What | Where |
|---|---|
| One quest | `data/quests/<key>.xml` (the file name is the quest key) |
| A quest's Lua script | `data/quests/scripts/<name>.lua`, named by `<quest script="name.lua">` |
| Scripts that react to anything, for anyone | `data/scripts/triggers/*.lua` |
| Account stats | `data/XML/stats.xml` |
| Achievements | `data/XML/achievements.xml` |
| NPC dialogue scripts | `data/npc/scripts/*.lua` |

Reload while the server runs: `!reload-quests` (quests and their scripts),
`!reload=progress` (stats, achievements and quests). A file with a mistake is
rejected with its name and the problem, and the running content stays.

Test on yourself: `!quest=start|stage|reset|complete:<guid>:<quest>[:<stage or ending>]`
and `!achievement=grant|revoke:<guid>:<key>`.

## A quest

```xml
<quest key="long_road" name="The Long Road" category="side"
       description="Rook is trying to reopen the road to the bank.">
  <area key="bank" near="npc:banker" radius="300"/>

  <start>
    <talk npc="quartermaster" keyword="road" confirm="true" text="The road is overrun. Help?"/>
    <requires quest="ghouls" state="completed"/>
  </start>

  <stage key="clear" journal="Clear ghouls from the road, or bring Rook {bandages}.">
    <objective key="ghouls"   type="kill" target="normal_ghoul" count="5" text="Kill normal ghouls"/>
    <objective key="bandages" type="give" npc="quartermaster" item="bandage" count="3" keyword="bandages" text="Give Rook bandages"/>
    <outcome when="ghouls"   next="report"><reward caps="150"/></outcome>
    <outcome when="bandages" next="report"><reward caps="100"/><reward item="medkit" count="1"/></outcome>
  </stage>

  <stage key="report" journal="Tell Elias at the bank the road is open.">
    <objective key="arrive" type="enter_area" area="bank" text="Reach the bank"/>
    <objective key="elias" type="talk" npc="banker" keyword="road" after="arrive" text="Speak to Elias"/>
    <outcome when="all" next="end:done"><reward caps="200"/><achievement key="road_warden"/></outcome>
  </stage>

  <ending key="done" journal="The road is open."/>

  <dialogue npc="quartermaster">
    <reply keyword="road" stage="clear" text="Still ghouls out there."/>
    <reply keyword="road" state="completed" text="The road holds."/>
  </dialogue>
</quest>
```

- **Stages** run from the first one. An **outcome** fires when its `when`
  holds (an objective key, `all` or `any`), pays its rewards and goes to
  `next`: a stage, `end:<ending>` or `fail`. The first matching outcome wins,
  so branches are just two outcomes.
- **Objectives**: `kill` (`target=` agent key, or `@tag` for agents a script
  spawned), `bounty`, `craft`/`pickup`/`use` (`item=`), `gather` (resource),
  `destroy`/`build` (object, optional `owner="self|clan|other|none"`), `talk`
  and `give` (`npc=`, `keyword=`, `give` also `item=`, `count=`), `enter_area`
  (`area=`). `after="<objective>"` makes one wait for another.
- A **give** takes what the player carries, up to what is still owed; the
  journal shows how many are in the bag.
- A **kill** also counts when the sun or fire finishes an agent the player did
  at least half the damage to in the last 30 s.
- **Starts**: `<talk>` (with `confirm="true"` the NPC waits for yes/no),
  `<event type= target= count= owner=/>` (e.g. destroy 10 walls), `<use item=/>`,
  `<enter area=/>`. `<requires quest= state=/>`, `karmaMin/karmaMax`,
  `achievement=`, `stat= atLeast=` gate them.
- `hidden="true"`: never in the journal (a silent one-time reward).
  `repeat="cooldown" cooldownSeconds="…"`, `abandon="false"`.
- An NPC keyword belongs to one quest. Journal text may mark keywords `{like this}`.

### Areas

Inside the quest. The live world is generated again every start, so tie an
area to something that is in every world:

```xml
<area key="old_house" structure="house3"/>              <!-- any placed copy -->
<area key="post" near="npc:quartermaster" radius="400"/> <!-- around an NPC -->
<area key="bunker" x="4200" y="3100" radius="300"/>      <!-- warns unless the world is fixed -->
```

## Scripts

A script returns a table of hooks. Hooks read `ctx` and return a list of
actions; nothing else they do survives the call (globals are frozen, 1 MiB,
10,000 instructions per call).

```lua
return {
  on = { "destroy:car", "kill:radioactive_ghoul" },   -- only these reach onEvent

  onStart = function(ctx) return { { say = "Good luck, " .. ctx.player.name } } end,
  onStageEnter = function(ctx, stage)
    if stage == "ambush" then
      return {
        { spawnAgent = "armored_ghoul", count = 3, radius = 300, tag = "ambush" },
        { after = { seconds = 30, hook = "reinforce" } },
      }
    end
  end,
  reinforce = function(ctx) return { { spawnAgent = "fast_ghoul", count = 2, tag = "ambush" } } end,
  onEvent = function(ctx, ev) return { { setVar = "cars", add = 1 } } end,
}
```

- Quest script hooks: `onStart`, `onStageEnter(stage)`, `onStageComplete(stage, outcome)`,
  `onEnd(ending or "fail")`, `onEvent(ev)` while the quest is active, and any
  hook named by `after`. Trigger scripts: `onEvent(ev)` for anyone.
- `ctx`: `player` (id, name, karma, health, x, y, verified), `quest` (key,
  stage, counts, vars), `quests` (key -> state), `account` (loaded, stats,
  achievements). `ev`: type, subject, count, owner, tag, x, y.
- Actions: `start`, `advance` (a stage), `complete` (an ending), `fail`,
  `setVar` (`value=` or `add=`), `grantAchievement`, `say`, `status`,
  `spawnAgent` (≤ 5, `radius=`, `tag=`), `giveItem`, `takeItem`,
  `applyCondition` (`durationMs=`, `strength=`), `after`. Quest actions from
  a trigger script name `quest=`.
- All actions from one call are checked first; one bad action (unknown key,
  a limit, items the player does not carry) drops them all and logs why.
  They are applied on the next tick.
- Spawned agents leave when the quest ends or the player dies or leaves
  (10 per player, 200 per server). Three script errors in a row switch a
  script off until the next reload.
- NPC scripts: `onTalk(context)` returns `{ reply=, topic=, action="trade"|"bank", intents={...} }`.

## Stats and achievements

```xml
<stat id="12" key="cars_wrecked" name="Cars wrecked"><count event="destroy" target="car" owner="other"/></stat>

<achievement id="13" key="scrapper" name="Scrapper" description="Wreck 50 cars." grade="2" points="10">
  <requires stat="cars_wrecked" atLeast="50"/>
  <reward item="medkit" count="1"/>
</achievement>
```

Ids are stored on accounts: never change or reuse one; retire with
`retired="true"`. Only accounts on servers with `recordAccountProgress = true`
record anything.
