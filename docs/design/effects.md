# Effects

An effect is what happens at a point: a blast, fragments, a zone left on the
ground (gas, smoke, fire), or any mix of them. `data/XML/effects.xml` names
them; its opening comment documents every element and attribute. This page is
how the pieces fit.

## Who runs them

| Source | Written as | Runs from |
|---|---|---|
| A projectile that goes off | `projectiles.xml <onDestroy>` | `Game::detonateProjectile` (landing, or cooked in the hand) |
| A destroyed object | `objects.xml` / `furnitures.xml <onDestroy>` | `Object::runDestroyEffects` |
| A dead agent, or a player ghoul | `agents/*.xml <onDeath>` | `Agent` death, `Player::dropGhoulRemains` |
| A zone that ends | `<zone><onEnd effect=>` | `Game::updateClouds` |
| A quest or trigger script | `{ effect = "key", x=, y=, angle= }` | `ScriptSystem::apply` |

Each holds an `EffectList` (`gameplay/effect.h`): its inline `<explosion>`,
`<fragments>` and `<zone>` as one unnamed effect, then each `<effect key=>`.
Everything goes through `Game::runEffect`, which runs an effect's explosion,
then its fragments, then its zone, then the effects it chains. A source that
was moving (a thrown grenade or bottle) passes its heading, which a zone's
shape follows; anything else passes none.

## Loading

`EffectManager` loads `effects.xml` before objects, projectiles and agents,
which resolve their references as they load. A reference with child elements
is the named effect with those children merged in, attribute by attribute,
so one use can change a number without copying the entry. References are
resolved fully at load (chains included, at most 8 deep), so running an effect
looks nothing up. An unknown key, a loop and a clamped number are reported at
startup; `--validate` runs the same loaders.

## Zones

`EffectZone` is the old projectile cloud with a shape and an end:

- **Shape.** `area_fill::fill(Shape, blocked)` measures distance on an ellipse
  along the source's heading (`stretch`, `line`, `forward`), roughened per
  tile by a seed (`irregular`), and spreads nearest-first through tiles
  `blockedBy` allows (`Game::isCloudBlockedTile`: walls and closed doors,
  optionally rocks and trees). The cells are decided once, on the server,
  and sent; the client never computes a shape.
- **End.** `<onEnd effect=>` runs where the zone started once it is gone,
  after the zone list has been walked.
- **Merging** (fire feeding fire) also needs the same effect and `<onEnd>`.

## Wire and look

`AREA_EFFECT` (protocol 1426) carries `[u16 effectId][u8 flags]` after the
kind: the zone's effect's `clientEffectId`, and `AREA_EFFECT_HIDES` when it
blocks vision. The `effects` content table goes to the client like any other
(both exporters, `content:parity`), and `CloudLayer` draws a zone with its
effect's `<client>` look (`cloudLook`): puffs in its colour, size and drift,
the smoke mask in its colour, or fire with its own flame, smoke and ember
colours and with or without a bottle breaking (`FireLook`, one palette per
look in `FireEffects`). A zone with no look is drawn by its kind. Which tiles
hide comes from the flag, not the look.

## Limits

255 tiles and a 12-tile reach per zone (the wire), 48 fragments per blast,
phases up to 60 s, 16 fire looks on screen with their own colours (past that,
the molotov's), 4 effects per script call within 1000 units of the player.

## Tests

- `area_fill` self-test: round fills unchanged, stretch, line, forward, a
  ragged edge that walls still stop.
- Script intent self-test: `effect` parses with and without a position.
- `clouds.test.ts`: looks, `render="none"`, a hiding gas, fire colours and
  `shatter="false"`; `throw-aim.test.ts`: a blast read through a reference.
- `tests/integration/live-effects-test.ts` (in `npm run smoke`): a thrown gas
  and smoke grenade each arrive as their effect, with the right hide flag.
