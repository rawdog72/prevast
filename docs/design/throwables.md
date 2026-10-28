# Grenades

Six throwable grenades: frag, offensive, thermite, smoke, gas and flash. Builds on the cookable throw (`equipables.xml <throw cookable>`, `Projectile::setFuse`) and the blast in `Game::executeExplosion`. Everything below is decided on the server; the client only reports what the player does and draws what it is sent.

## Problem

- There is one grenade, `granade` in `projectiles.xml`: a fuse, a square blast (`area="1"`), and a `slowed` condition from the blast.
- A blast ignores walls. `executeExplosion` gathers everything in the tile box and tests range only, so a grenade on the other side of a wall hurts you at full damage.
- A thrown grenade that hits a solid thing stops on it (`updateProjectiles` → `stopProjectileAtHit`). It cannot bounce, so a grenade cannot be banked into a room.
- A blast's condition only lands if damage landed (`dealt < 0`). A purely blinding grenade has to be written as `playerDamage="1"`, which gives hit markers, kill credit and lets explosion armour block a flash.
- Objects have no material. `damageModifiers` can only tell "building", owned or enemy, so nothing can do more damage to metal than to wood.
- Nothing can hide a player from another player except distance and the view box. Smoke and flash change what a client is *allowed to know*, and drawing them on the client alone would leak positions to anyone who deletes the overlay.

## Goals

- Six grenades with distinct jobs and counters:

| Grenade | Job | Counter |
|---|---|---|
| Frag | Kills in the open; fragments stopped by cover | Cover |
| Offensive | Big blast, knockback, building damage, short lethal radius | Distance |
| Thermite | Burns through metal | Wood, layered walls |
| Smoke | Hides information | Push in, wait it out |
| Gas | Denies an area over time | Leave the cloud |
| Flash | Blinds for a few seconds | Look away, break line of sight |

- Grenades bounce off walls.
- Blasts respect walls.
- Smoke and flash are enforced by **not sending** what the player cannot see, through the same view gate the aim and scope work built (`Player::canSee` / `viewContains`, `knownCreatures`).
- One area-effect system serves smoke, gas and thermite's ground fire (and the planned molotov later).

Out of scope: counter items (gas mask, flash goggles, blast vest), molotov, sticky/remote charges, decoys, EMP, impact grenades. The resistance hooks needed for counter items already exist (`<resist conditions=>`), so adding them later is data only.

## Decisions

| Question | Decision |
|---|---|
| Authority | The client sends pin pull, release, throw target. The server owns fuse, path, bounce, detonation, who is affected, and what each client is sent. |
| Throw target | `THROW_TARGET` is the marker's offset from the thrower (`[i16 dx][i16 dy]`, protocol 1423). The server fixes direction and distance at the release, so turning during the throwing motion does not move the landing point. |
| Who sees a grenade | Everyone in range of it at any moment of its life, not only who saw the throw: `Game::introduceProjectile` tells a player who comes into range of a flying or lying grenade, from where it is now. |
| Fuse visibility | Other players are never sent a grenade's remaining fuse. Only the thrower's client knows it (cook display). |
| Frag vs offensive | Frag: small core blast plus fragments. Offensive: no fragments, large knockback and building damage. |
| Existing `granade` | Becomes the offensive grenade. Key unchanged, so equipables and saved items keep working. |
| Fragments | Real projectile entities (a `projectiles.xml` entry, like a gun's round), capped at 48 per blast for bandwidth. Each stops at the first solid thing, including the thrower. Sent to clients as ordinary entity records. |
| Blast and walls | Creatures behind a wall from the blast centre take `throughWall` × damage (default 0). Buildings are not occluded. |
| Bounce | Off solid objects and resources; a grenade hitting a player or agent stops at their feet. |
| Thermite | Sticks to the object it hits and burns it when the fuse ends; materials make metal take extra. |
| Smoke rule | An entity is visible if the line from viewer to entity is entirely clear air or entirely smoke. Inside smoke you see the inside; outside you see neither into nor through it. |
| Clanmates in smoke | **No exception.** Everyone is treated the same. |
| Who smoke affects | Players and agents alike: an agent inside or behind smoke cannot acquire a target through it. |
| Scenery in smoke | Statics are still sent. The map is not secret. |
| Explosions in smoke | Blast visuals are always sent. A flash of light in smoke reveals nothing useful. |
| Bullets fired from smoke | Sent with their visible start moved to where they leave the smoke. Direction is revealed, position is not. |
| Chat from smoke | Delivered as today. A client that does not have the speaker shows it in the log only. |
| Flash | Range + line of sight + facing decide strength. Blind shrinks the player's view to a small circle that grows back. The white screen is only cosmetic. |
| Flash facing | Uses the most-facing aim angle of the last 150 ms, so snapping away on detonation does not help. |
| Flash and damage | A `<flash>` is its own element, not an `<explosion>`; it needs no damage to land and explosion armour does not stop it. |

## Shared foundation

### Bounce

`Projectile` gains `redirect(pos, newEnd, vx, vy)`: resets start, end, travel time and velocity from the bounce point. In `updateProjectiles`, when a fused projectile's hit target is an `Object` or `Resource`:

1. Hit normal: for a box collider the side that was crossed; for a circle collider the direction from its centre to the hit point.
2. Reflect velocity about the normal, multiply by `restitution`.
3. Remaining travel distance × `restitution` gives the new end point along the reflected direction.
4. Send the new state through `sendProjectileToRecipients` (same path as the stop update), so the client re-anchors the sprite.
5. After `maxBounces`, or when speed falls under a floor, `stopProjectileAtHit` as today.

A player or agent hit still takes the projectile's impact damage (`applyProjectileHit`) and the grenade stops there.

```xml
<bounce restitution="0.45" maxBounces="3"/>   <!-- on the projectile; absent = stop on hit (today's behaviour) -->
```

### Blast occlusion

In `executeExplosion`, for each player or agent in range, test the segment from the blast to the creature against solid things (the test `findClosestObstacleHit` already does, ignoring creatures). Blocked: damage, knockback and condition chance are multiplied by `throughWall`. Objects and resources are untouched, so a grenade against a wall still damages the wall.

Cost: one segment test per creature in range; blasts reach a few tiles, so a handful per blast.

`throughWall` defaults to 0 on every `<explosion>`, including objects' and agents' (the explosive ghoul): cover now protects from all blasts. A thing the blast origin is more than 4 units inside is its source and shelters nobody, so an exploding barrel is not its own cover.

### Area effects (clouds)

One server object, `AreaEffect`, for anything that lingers on tiles.

- **Shape:** a breadth-first fill from the landing tile, `tiles` cells at most, not passing tiles that block it (a tile holding a colliding wall or closed door; objects mark it with `blocksGas`, defaulting to "colliding structure"). Computed once at detonation. Doors opened later do not let it spread.
- **Lifetime:** `growMs` (rings appear outward in fill order), `holdMs`, `fadeMs`.
- **Map grid:** `Map` keeps a per-tile `uint8` count of vision-blocking clouds covering it, plus a list of live effects with their bounding boxes. Grid lookups are O(1).
- **Ticks:** every `tickMs` the effect gathers creatures in its bounding box and applies its `<onTick>` to those standing on its tiles.
- **Wire:** one new entity type, `AREA_EFFECT`: key, origin tile, a bitmask of tiles in a box around the origin, start time, grow/hold/fade. The client animates the same shape the server uses. Clouds are sent to anyone whose view overlaps the bounding box: a cloud's shape is not secret.

`data/XML/clouds.xml`:

```xml
<cloud key="smoke"     tiles="40" growMs="1500" holdMs="15000" fadeMs="3000" blocksVision="true"/>
<cloud key="toxic_gas" tiles="30" growMs="3000" holdMs="10000" fadeMs="4000" tickMs="500">
    <onTick condition="toxic_poison" chance="1" durationMs="1500"/>
</cloud>
<cloud key="thermite_fire" tiles="3" growMs="0" holdMs="7000" fadeMs="500" tickMs="250">
    <onTick condition="burning" chance="1" durationMs="1000"/>
</cloud>
```

A projectile spawns one with `<onDestroy><cloud key="..."/></onDestroy>`.

## Grenades

### Frag

On detonation: the core `<explosion>` as today (small), then `<fragments>` (`Game::fireFragments`).

- `count` real projectiles of the `frag_fragment` entry, one somewhere in each slice of the circle, the pattern turned by a random offset. Each flies `range` less up to `rangeVariation` of it, at a speed up to `speedVariation` below the fastest, so the burst is ragged instead of an expanding ring.
- From then on each is an ordinary projectile: moved and collided by `Game::updateProjectiles`, landed by `Game::applyProjectileHit`, sent to clients as entity records. The first thing it meets takes `damage` of the fragment's `<damage type>` (piercing, so armour applies); buildings and resources take `buildingDamage` (the same as `damage` unless stated, like a gun's) with the usual hit shake, and are never harvested by it (no projectile harvests). The thrower is not immune.
- Each fragment's damage falls off with how far from the blast it lands (`falloff`: the share left at `range`, 0.4 for the frag), and fewer fragments reach a far target as well. A body or crate in front absorbs the fragments meant for whoever is behind it.
- Scenery at the blast is resolved first (`scenery_geometry::fragmentStart`): a grenade lying on a wall loses the fragments heading into it and the rest start just off its face.
- Fast: `baseSpeed="3.5"` (2100 units/s), so a 400-unit burst resolves in about four ticks.

```xml
<projectile clientProjectileId="9" key="frag_grenade">
    <lifetime durationMs="3500"/>
    <bounce restitution="0.45" maxBounces="3"/>
    <onDestroy>
        <explosion radius="90" playerDamage="40" buildingDamage="30" knockback="4"/>
        <fragments projectile="frag_fragment" count="22" range="400" damage="40" buildingDamage="40"
                   spread="1" rangeVariation="0.6" speedVariation="0.4" falloff="0.4"/>
    </onDestroy>
</projectile>

<projectile clientProjectileId="13" key="frag_fragment">
    <physics baseSpeed="3.5"/>
    <damage type="piercing"/>
</projectile>
```

### Offensive

The existing `granade`, retuned: larger area, high knockback and building damage, no fragments, `throughWall="0"`. Keeps its `slowed` on-hit.

### Thermite

- **Sticks:** `<stick to="objects"/>`. When it hits an `Object` it stops there (as all grenades do today) and records the object's id. It does not bounce.
- **Ignites when the fuse ends:**
  - stuck to an object that still exists: that object takes `damagePerTick` every `tickMs` for `burnMs`, scheduled by id exactly like `scheduleExplosionDamage`, so a destroyed target simply stops burning;
  - always: a `thermite_fire` cloud on the tile, which burns creatures standing in it.
- **Materials:** objects get `material="metal|wood|stone|..."` in `objects.xml` (default none). `damageModifiers` gains a `material=` match next to `target` and `ownership`; thermite's modifier is `material="metal" multiplier="4"`. Ownership modifiers still combine with it.

```xml
<projectile clientProjectileId="10" key="thermite_grenade">
    <lifetime durationMs="1500"/>
    <stick to="objects"/>
    <onDestroy>
        <burn burnMs="7000" tickMs="250" damagePerTick="40">
            <modifier material="metal" multiplier="4"/>
            <modifier material="stone" multiplier="1.5"/>
        </burn>
        <cloud key="thermite_fire"/>
    </onDestroy>
</projectile>
```

### Smoke

A `smoke` cloud, `blocksVision="true"`. The work is in the view gate.

**The rule.** Viewer V can see entity E when the tile line from V to E is all clear air or all smoke. In addition:

- V always sees itself, and anything within `nearSight` (1 tile) of it, so a person bumping into you does not vanish.
- V inside smoke: sees whatever is inside the same continuous smoke along the line; nothing outside.
- V outside smoke: sees nothing standing in smoke and nothing behind it.

**Where it plugs in.** The test is added to the shared view gate, so every path the aim work unified gets it at once: the mobile visibility scan, `canSee` (surgical updates), `cosmeticReach` (sounds, muzzle flashes, footsteps), and projectile recipients. It only runs when the viewer's box intersects a vision-blocking cloud's bounding box, so a player with no smoke nearby pays nothing. The line walk is a tile DDA over the `uint8` grid, about 15 steps at the current viewport.

**No flicker at the edge.** Like a strong scope's inner and outer shapes, an entity the client already has is kept while the line has at most one mismatched tile, and an entity it does not have needs a clean line. Removal is through `knownCreatures` as for anything leaving view.

**Bullets.** A projectile whose spawn point fails the test for a recipient is sent with `animStart` moved to the first clear tile along its path. A viewer inside smoke is sent bullets that start inside the cloud; bullets from outside it are not sent to them until they enter the smoke.

**Agents.** Agent target acquisition uses the same test, so smoke works in PvE.

**Client.** Draws the cloud. While the player stands in smoke, it darkens everything outside the cloud, as aiming darkens what is outside the aimed view: what is lost is shown as lost.

### Gas

A `toxic_gas` cloud. No vision effect. Every `tickMs` each player and agent on its tiles gets the `<onTick>` condition, so condition resistance applies with no new code. Not occluded by anything except the fill's blocking tiles.

### Flash

`<flash>` is its own `<onDestroy>` child, handled beside `executeExplosion`, not inside it.

For each player and agent within `range`:

1. **Line of sight** from the flash to the creature (same segment test as blast occlusion). Blocked: unaffected.
2. **Facing:** angle between the creature's aim and the direction to the flash. For players the aim is the most-facing of the rotation samples in the last 150 ms (`Player` keeps a small ring buffer of `(time, rotation)`). Factor: `facingFront` within 60°, `facingSide` within 120°, `facingBack` beyond.
3. **Distance:** linear from 1 at the centre to `edge` at `range`.
4. `strength = facing × distance`. Below `minStrength`: unaffected. Otherwise apply `blinded` with `durationMs = maxMs × strength` and that strength.

**Enforcement.** While `blinded`, the view gate allows only entities within a radius that grows from `nearSight` to the full view as the condition runs out, using the same path as smoke. Cosmetic events are clamped the same way. A blinded agent drops its target and cannot acquire one inside the radius limit.

**Client.** `BLIND_STATE` (strength, remaining ms) drives the white-out and ringing. Removing it reveals nothing, because the positions were not sent.

```xml
<projectile clientProjectileId="11" key="flash_grenade">
    <lifetime durationMs="2000"/>
    <bounce restitution="0.5" maxBounces="3"/>
    <onDestroy>
        <flash range="500" maxMs="4000" edge="0.4" minStrength="0.15"
               facingFront="1.0" facingSide="0.5" facingBack="0.15"/>
    </onDestroy>
</projectile>
```

`blinded` is a new condition in `conditions.xml`. It sets no control bits by default; whether it also blocks attacking is a balance flag on the condition.

## Protocol

One bump covering:

- `AREA_EFFECT` entity (create, removal).
- `BLIND_STATE` to the affected player.
- Projectile redirect for bounces: an ordinary projectile state update with new start/end; no new message.
- New projectile ids 9–11 in client.js and `check_client_sync.py`.

## Content and validation

- `clouds.xml` loads before projectiles; an unknown `<cloud key>` and an unknown `<onTick condition>` are reported at startup, like `<onHit>` keys today.
- `material` values are validated against a fixed list.
- `count`, `range`, `tiles` and tick intervals are clamped with a warning, like `baseSpeed`.

## Testing

- **View gate selftests** (next to `aim_view_selftest.cpp`): viewer and entity combinations of clear/smoke/behind smoke, the one-tile mismatch rule, `nearSight`, the blind radius over time.
- **Leak test** in the style of the bullet `sentMask` measurement: a bot standing in smoke and an observer outside it for 60 s; the observer must receive zero creation records, cosmetic events or bullet starts that place the bot. The same with a blinded observer.
- **Blast occlusion:** a player behind a wall from a blast takes `throughWall` × damage; the wall takes full damage.
- **Fragments:** a crate between blast and player absorbs the fragments; a grenade on a wall's face sends none through it (`scenery_geometry` self-test covers the start rule).
- **Thermite:** stuck to a metal wall, the wall takes 4× per tick; destroying the wall mid-burn stops ticks without errors.
- **Bounce:** a grenade thrown at a wall at 45° leaves at 45°, ends short of the original target by the restitution, and the client sprite follows.
- **Flash facing:** a player who turns away within 150 ms of detonation is still flashed at full strength.

## Build order

1. Bounce and blast occlusion. **Built:** `<bounce>` and `<explosion throughWall>` in `projectiles.xml`, geometry in `gameplay/scenery_geometry.*` (self-tested), the existing grenade bounces.
2. Frag and offensive (retune). **Built:** the `frag_grenade` item (requires the grenade, level 12), and the old grenade renamed Offensive Grenade with knockback 20. A grenade cooked until it goes off in the hand runs the same detonation (`Game::detonateProjectile`), fragments included. The fragments were first instant rays with a cosmetic `SHRAPNEL_BURST` (protocol 1420); since 1422 they are real projectiles: `<fragments>` and the `frag_fragment` entry in `projectiles.xml`, `Game::fireFragments`, `scenery_geometry::fragmentStart`, and opcode 32 is free.
3. Area effects, then gas. **Built:** `<cloud>` inside `<onDestroy>` in `projectiles.xml` instead of a separate `clouds.xml` (one less file and content table; the same fields), the fill in `gameplay/area_fill.*` (self-tested: walls, doorways, wall corners), `Game::spawnCloud`/`updateClouds`, `AREA_EFFECT` = 33 in protocol 1421 (sent at spawn and every 2 s), `render/clouds.ts`, the `choking` condition and the `gas_grenade` item (requires the grenade, level 14). The cloud deals its damage itself (`damage`, `damageType="gas"`, so `gasResistance` on a wearable counters it) because a condition refresh restarts its `<healthTick>` timers.
4. Smoke: view-gate test, bullets, agents, leak test. **Built:** `<cloud kind="smoke">` (`blocksVision`, default for smoke), the rule in `gameplay/smoke_sight.h` (self-tested), a per-tile smoke grid in `Game` (`syncCloudSmoke`, `smokeHides`) gating the mobile visibility scan, surgical updates of moving entities, cosmetic events (`throughSmoke` exempts clouds; fragments are tracers like bullets), bullet and grenade tracers (each watcher's tracer starts where they first see it, or is not sent), and agents acquiring or keeping a target. Client: thick from outside, thin from inside, everything outside darkened while standing in it. Smoke hides until half faded. The bot leak test (an observer receiving zero records about a player in smoke) is **not yet written**. Not gated, by choice: local chat (delivered as before) and the clan minimap feed (`PLAYER_POSITIONS`, positions rounded to 1/255 of the map).
5. Flash, reusing smoke's view clamp.
6. Materials, then thermite. **Materials built** with the molotov: `ObjectData::material` (wood, cloth, metal, stone), stated with `material=` in objects.xml or read off `<client particles=>`, so every existing object has one.

Effects (after the molotov): **built.** Every grenade's payload is now a named entry in `data/XML/effects.xml` (`<onDestroy><effect key="toxic_gas"/></onDestroy>`), shared with placed explosives, exploding agents and Lua scripts; `<cloud>` is now `<zone>` (the old name still loads), zones take a shape (`shape="line"`, `stretch`, `forward`, `irregular`, `blockedBy`) and an `<onEnd>` effect, and each effect's `<client>` sets how its zone is drawn. See [effects.md](effects.md), which replaces the cloud details above.

Molotov (added after the plan, before flash): **built.** `<shatter/>` on a projectile breaks it on the first thing it hits or where it lands (never parks or bounces; `<lifetime>` is only how long it can be held lit). Its `<cloud kind="fire">` damages whoever stands in it (`damageType="fire"`), applies `burning` (an afterburn: the re-application restarts its `<healthTick>`, so it only ticks once you step out), and burns buildings on or next to it whose material is in `burns` (default wood, cloth) for `buildingDamage` a tick. Item `molotov`: gasoline, junk, 2 string at a workbench, level 8.

## Tunables

Every number above is a starting point for playtesting, not a decision: blast sizes, fragment count, speed and damage, cloud sizes and durations, flash range, facing factors and duration, thermite tick damage and metal multiplier.
