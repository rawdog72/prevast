# Aim and scopes

Protocol 1415. Hold-right-click aiming, aim accuracy and walk speed set per weapon and mod, and scope views. A weak scope widens what the server sends and slides and slightly zooms the client's view toward the aim; a strong scope reshapes the view into a cone or a rectangle. Builds on weapon mods (protocol 1414): aim stats and views are weapon and mod data resolved by its resolver.

## Problem

- Right-click on the game view opens the Look / Open / Talk menu (`game/game-loop.ts`, `mouse.onDown` button 2 → `openWorldMenu`). There is no aiming.
- A weapon's accuracy is one fixed number (`spreadRadians`), and holding a weapon never changes walk speed.
- The SMG Tactical's reflex sight and tube scope are fitted, crafted and timed, but do nothing.
- The server sends each client the moving entities within ±`maxViewportX/Y` (1400 × 900 in `config/development.lua`). The client draws `1280 × 880 / zoom` world units (`core/camera.ts` `BASE_VIEW_*`), and the player's zoom goes down to 0.5 (`GameLoop.ZOOM_MIN`), where it draws ±1280 × ±880: nearly the whole box. Seeing farther in one direction needs the server to send farther in that direction, for that player only.
- Several paths decide "can this player see this position" on their own: the mobile scan in the visibility loop, the static tile box, `Player::canSee` (surgical updates, cosmetic broadcasts, chat), and `Map::getPotentialSpectatorPlayers`. A per-player view has to change all of them together.

## Goals

- Hold right-click to aim with a weapon that allows it; Ctrl+right-click opens the world menu.
- Aiming tightens spread over a short time and slows walking. Both are set per weapon and changed by mods.
- A weak scope, while aiming, adds server view toward the aim (stretching or shifting the box) and slides and zooms the client view, all set per scope.
- A strong scope reshapes the view into a cone or a rectangle with a rear circle, and the server sends only what is inside.
- One server gate decides what a player sees, so the visibility scan, scenery, surgical updates and cosmetic events never disagree.
- Players who are not aiming pay nothing and see exactly what they see today.

Out of scope: other players seeing that someone aims; line-of-sight occlusion; tightening the unscoped box; a toggle-aim option; aiming with bows, crossbows, nail gun and shotguns; the existing ~80-unit gap at the top and bottom edge at zoom 0.5 with full look-ahead.

## Decisions

| Question | Decision |
|---|---|
| Right-click | Plain right-click on the game view is aim only. Ctrl+right-click is the world menu. Right-click on HUD and window slots is unchanged. |
| Hold or toggle | Hold. |
| Who can aim | A weapon with `<aim>`. Without a `<view>`, aim changes accuracy and walk speed only. |
| Weak vs strong | Set by the view's `shape`: `stretch` / `shift` are weak, `cone` / `rect` are strong. The SMG Tactical's two optics are weak; the sniper's built-in scope is the only strong one. |
| Weak view on the server | The aimed box is the normal box stretched toward the aim (nothing lost) or shifted toward it (the strip behind is lost), chosen per scope. |
| Weak zoom | Multiplies the player's chosen zoom, never below `ZOOM_MIN` 0.5. |
| Strong zoom | Absolute while aimed: the shape is fixed in world units and has to fit on screen whatever the player's zoom. |
| What is lost is shown as lost | While aiming, the client darkens everything outside the server's aimed view. |
| Authority | The server decides when aim is active and what an aiming client is sent. The client's view follows `AIM_STATE`. |

## Content

### `<aim>` on a weapon (`equipables.xml`)

```xml
<aim spreadPercent="-35" movePercent="-20" timeMs="250"/>
```

`spreadPercent` in [−95, 0], `movePercent` in [−90, 0], `timeMs` ≥ 0. Absent means the weapon cannot aim, and right-click does nothing while it is held.

### Aim stats

Added to the weapon-mods stat whitelist, resolved with the same formula, allowed on any mod:

| Name | Meaning | Base | Clamp |
|---|---|---|---|
| `aimSpread` | Spread while fully aimed | resolved hip spread × (1 + `spreadPercent`/100) | ≥ 0 |
| `aimMove` | Walk-speed multiplier while aiming | 1 + `movePercent`/100 | [0.1, 1] |
| `aimMs` | Time from hip spread to aimed spread | `timeMs` | ≥ 0, integer |

### `<view>`

On an optic mod, or on a weapon as a built-in scope. The effective view is the fitted optic's `<view>` if it has one, otherwise the weapon's own, otherwise none.

```xml
<!-- weak: the box grows toward the aim; nothing is lost -->
<view shape="stretch" ahead="250" zoom="0.95" extend="250"/>
<!-- weak: the same box moved toward the aim; the strip behind is lost -->
<view shape="shift" ahead="450" zoom="0.85" extend="500"/>
<!-- strong -->
<view shape="cone" reach="1500" halfAngleDeg="20" zoom="0.7" rearRadius="250"/>
<view shape="rect" length="1900" width="500" back="100" zoom="0.55" rearRadius="250"/>
```

| Attribute | Shapes | Range | Meaning |
|---|---|---|---|
| `ahead` | stretch, shift | 0–600 | Largest client look-ahead shift while aimed (today a fixed 100 for everyone), same dead zone and mouse-distance ramp |
| `extend` | stretch, shift | 0–1200 | How far the server box reaches toward the aim |
| `zoom` | stretch, shift | 0.6–1.0 | Multiplies the player's zoom, floored at 0.5 |
| `reach` | cone | 200–4000 | Distance from the player to the cone's far edge |
| `halfAngleDeg` | cone | 1–60 | Half the cone's opening angle |
| `length` | rect | 200–4000 | Distance the rectangle reaches ahead of the player |
| `width` | rect | 100–2000 | Rectangle width, centred on the aim line |
| `back` | rect | 0–500, default 0 | How far behind the player the rectangle starts |
| `zoom` | cone, rect | 0.4–1.0 | Absolute client world scale while aimed (× the window's base scale) |
| `rearRadius` | cone, rect | 150–600 | Circle around the player that is always visible |

### Validation

- Shape-specific attributes are required for their shape and rejected on the others.
- `<view>` is allowed only on an optic mod or on a weapon with `<aim>`. A weapon that accepts an optic with a `<view>`, or any mod with aim stats, must itself have `<aim>`.
- **Weak reach:** the aimed box must reach past what the client can draw ahead of the player, or entities pop in on screen. The worst case is the minimum zoom 0.5, where the client draws ±`W` × ±`H` = ±1280 × ±880 before the shift. So `extend ≥ ahead + max(H − maxViewportY, W − maxViewportX)` (with development config: `extend ≥ ahead − 20`). The client constants are mirrored in `aim_view.h` with a pointer to `camera.ts` and `GameLoop.ZOOM_MIN`. The strip a `shift` view loses behind is darkened on purpose, but it may not reach the player: a `shift` view's `extend` is at most `min(maxViewportX, maxViewportY) − 200`, so the player and 200 units behind them always stay sent (and the visibility scan never drops the player's own record).
- **Strong area budget:** cone `halfAngle(rad) × reach²` or rect `(length + back) × width`, plus `π × rearRadius²`, must not exceed `(2 × maxViewportX) × (2 × maxViewportY)`. A strong scope sees farther, never more.
- **Strong visibility:** the far end of a shape is off screen when aiming along the short screen axis; fully visible in every direction needs roughly `reach ≤ 0.85 × 880 / zoom`. A note printed at startup and by `--validate`, not a warning: the sniper's 1900 at zoom 0.55 leaves the screen along its short side on purpose (decided 2026-10-01).
- The reach and area rules depend on `maxViewportX/Y`, so startup re-checks them against the loaded config.

Every check except the strong visibility note goes through `reportDataWarning`, so any of them fails `npm run server:validate`.

### Export

`<aim>` and `<view>` go into the equipables and mods content tables through both exporters (`contentexport.cpp`, `tools/content/export-content.ts`) and the shared schema; `content:parity` covers them.

## Aiming and weak scopes

### Input (client)

In `game/game-loop.ts`, the button-2 handler becomes:

1. "Trade with…" targeting active: cancel it (unchanged).
2. `event.ctrlKey`: open the world menu (`openWorldMenu`, unchanged).
3. Placing a building: do nothing (unchanged).
4. Otherwise, if the held item resolves an `<aim>`: send `AIM 1`.

Releasing button 2 sends `AIM 0`, and so does losing window focus (`core/mouse.ts` already clears the buttons on blur). Right-click on hotbar, chest and trade slots are DOM events and do not reach this handler. The controls help text says Ctrl+right-click for the world menu and right-click to aim.

Facing is already computed from the player's screen position (`InputManager.updateAim`), so a shifted camera needs no change there.

### Server: aim state

`Player` gains `aimHeld` (from `AIM`), `aimActive` and `aimSince`.

- `aimActive = aimHeld && alive && !ghoul && the resolved weapon has <aim> && !hasInteractionSlowLock()`. That predicate already covers reload, equip, consume, craft and mod change.
- It is derived once per tick, at the start of the player's pass in the visibility loop, so `AIM`, equipping, death, becoming a ghoul, interactions starting and ending, and mod changes all take effect within a tick without hooking each. When an interaction ends and the button is still held, aim resumes. `aimSince` resets each time `aimActive` turns on. A lost session releases the button.
- Each change is sent as `AIM_STATE`.
- Spread at fire time (`player.cpp`, where `spreadRadians` is read): `aimActive ? lerp(hip, aimSpread, clamp((now − aimSince) / aimMs, 0, 1)) : hip`; `aimMs` 0 means aimed at once.
- `Player::getSpeed()` multiplies by `aimMove` while `aimActive`, and aiming prevents running. The speed is already on the wire.

### Server: one view gate

Pure module `gameplay/aim_view.{h,cpp}`: the view box math here and the strong-scope shapes, with self-tests.

- `Player` holds a `ViewBox { minDX, maxDX, minDY, maxDY }`: offsets from its position. Not aiming, or no `<view>`: ±`maxViewportX`, ±`maxViewportY`, exactly today's box.
- Aiming with a weak view, with `θ` the player's rotation, `ex = extend·cos θ`, `ey = extend·sin θ`:
  - `stretch`: `maxDX += max(0, ex)`, `minDX += min(0, ex)`, and the same for Y. Only the edges facing the aim move out.
  - `shift`: all four edges move by `(ex, ey)`.
- The box is rebuilt only at the start of the player's pass in the visibility loop, together with the static tile box. `canSee` and the static set therefore never disagree within a tick, and an `AIM` that arrives mid-tick takes effect at the next pass.
- `Player::viewContains(pos)` tests the box. Every view question goes through it:
  - the mobile scan in the visibility loop (four compares against the uneven bounds; unscoped players keep today's exact test);
  - `Player::canSee`, and so `broadcastSurgicalUpdate`, the cosmetic broadcasts (hit flashes, damage numbers, gauge notifications) and chat bubbles;
  - `Map::getPotentialSpectatorPlayers`, which already scans the flat player index and now tests each player's own reach (box plus the existing `TILE_SIZE` margin), so a far scoped player is never dropped as a candidate.
- Cosmetic events keep their `eventBroadcastRadius` limit; for an aiming player that radius box is stretched or shifted by the same `(ex, ey)`.
- Projectiles keep `projectileViewRadius` around the player, as today.
- Scenery: the static tile box is the aimed box rounded out to tiles. `updateStaticViewport` already diffs any old box against any new one, so entering or leaving aim, or turning while aimed, sends only the strips that changed, as walking does. Concealed objects keep their own rules.
- Weak views have no hysteresis, as with the normal box: the reach rule keeps the edge off screen.

### Client view

- `core/camera.ts`: the fixed `LOOK_MAX` becomes a parameter. While aiming with a weak view it eases from 100 to the scope's `ahead`; the dead zone and ramp are unchanged.
- `applyZoom` (`game-loop.ts`) gains an aim-zoom factor: `base × max(ZOOM_MIN, zoomShown × aimZoom) × poison`, eased like the player's zoom.
- On press the client starts the transition at once when its own content says the held weapon can aim and no progress bar is running; `AIM_STATE` corrects it either way. On leaving, both ease back over about 150 ms.
- `render/scope-view.ts` (new): while aiming with a view, everything outside the server's aimed box is darkened with a soft edge, with the HUD untouched. The box is computed from `AIM_STATE`'s `viewX/viewY`, the view's `shape` and `extend`, and the local mouse angle, so the mask never lags the cursor. For `shift` this shows the lost strip behind; for `stretch` it only shows at the edges at low zoom.
- `world/aim-view.ts` (new, pure): the client mirror of the box math, checked against the same fixture as the server.

### Protocol 1415

- `ClientOpcode AIM = 55`: `[u8 held]`, payload 1.
- `ServerOpcode AIM_STATE = 110`: `[u8 active][u16 viewX][u16 viewY]`, sent only on change. `viewX/viewY` are the server's `maxViewportX/Y`, which the client does not otherwise know.

Update `opcodes.h`, `core/definitions.h` (client version 1415), `apps/client/src/net/opcodes.ts`, `shared/protocol/README.md` and the replay fixtures in `tests/fixtures/net/`.

### Content

- `mp5_tactical`: `<aim spreadPercent="-35" movePercent="-20" timeMs="250"/>`.
- `reflex_sight`: `aimSpread` −15%, `aimMs` −60, `<view shape="stretch" ahead="250" zoom="0.95" extend="250"/>`.
- `tube_scope`: `aimSpread` −30%, `aimMove` −10%, `aimMs` +100, `<view shape="shift" ahead="450" zoom="0.85" extend="500"/>`.
- `grip_vertical`: `aimSpread` −10%. `grip_angled`: `aimMs` −80. `stock_solid`: `aimSpread` −10%, `aimMove` −5%. `stock_open`: `aimMs` −40.
- `<aim>` (accuracy and walk speed only) on `pistol`, `desert_eagle`, `ak47`, `mp5`, `laser_sniper` and `sniper`.
- Shotguns, `sawed_off`, bows, crossbow and nail gun get nothing.
- All numbers are starting values to tune in play.

## Strong scopes

### Server

- `aim_view` gains the shape: origin, direction from the player's rotation, inner and outer dimensions, and a bounding box of shape plus rear circle at the outer dimensions, built once per tick for a strongly scoped player.
- The mobile scan for that player tests the bounding box, then the rear circle, then the shape:
  - Cone: `along > 0`, `dist² ≤ reach²` and `along² ≥ dist² × cos²(halfAngle)`.
  - Rect: `−back ≤ along ≤ length` and `|across| ≤ width / 2`.
  - `along` and `across` are the offset projected on the aim direction and its perpendicular. The ghost, visual-suppression and projectile-radius filters still apply.
- Hysteresis: an entity the client already has is tested against the outer shape (+4° cone angle, +5% reach or length, +40 rect width), a new entity against the inner shape. The known mobile set is sorted and `visible` is built in id order, so this is a two-pointer walk inside the same loop.
- `viewContains` answers with the shape and rear circle. Cosmetic events inside them reach the player; the shape replaces the cosmetic radius for that player.
- Scenery: the static box is the normal box extended to the shape's bounding box, so terrain and buildings along the shape are drawn. Surgical updates of scenery test that static box, not the shape, so a building placed inside the box but outside the shape still reaches the client.
- Rotation arrives at `ROTATION`'s existing rate (on a 2° change or every 200 ms). The +4° outer margin absorbs that lag; if play shows pop-in when turning fast, `ROTATION` is sent more often while scoped.

Trade-off, intended: a player outside the shape and the rear circle is not sent while you are scoped, so it is neither seen nor heard.

### Client

- `core/camera.ts`: while strongly scoped, the look-ahead is replaced by a scope offset along the aim direction: `0.85 × t`, where `t` is the distance from the view centre to the screen edge along that direction at the scope's zoom, from the real viewport. The player sits near the edge the shape points away from, for any aim angle and window shape. The zoom is the view's absolute `zoom` × the window's base scale. Offset and zoom ease in, and back over about 150 ms.
- `render/scope-view.ts` draws the cone or rectangle plus the rear circle as the lit area, with the local mouse angle. The fade-out on leaving covers entities the server stopped sending coming back.

### Content

- `sniper`: `<view shape="rect" length="1900" width="500" back="100" zoom="0.55" rearRadius="250"/>`.

## Testing

Aiming and weak scopes:

- **C++ `--selftest`**: stretch and shift boxes against `tests/fixtures/weapon-mods/view-cases.json`; `aimActive` derivation (interactions block and resume it, weapon and mod changes update it); spread easing and the aim speed multiplier; `viewContains` gating a cosmetic broadcast; every validation rule including weak reach.
- **vitest**: right-click aims, Ctrl+right-click opens the menu, trade targeting and placement keep their behaviour, blur releases aim; look-ahead and zoom easing including the 0.5 floor; the mask box against the same `view-cases.json`, so the drawn box and the sent box cannot drift; aim stats in the shared resolver fixture; `AIM` and `AIM_STATE` on the wire.
- **Live integration test**: `AIM` gives `AIM_STATE 1`; a reload ends it and it resumes after; with a tube scope, an entity ahead beyond the normal box becomes visible and one behind within the lost strip is removed.
- `npm run check`, `npm run server:build`, `npm run server:validate`, `npm run server:selftest`, `npm run content:parity`, `npm run smoke`.

Strong scopes:

- **C++ `--selftest`**: cone, rect and circle membership, inner and outer, and the bounding-box pre-reject, against `view-cases.json`; the area budget.
- **vitest**: the scope camera offset for eight directions and three aspect ratios; the mask shape against `view-cases.json`.
- **Benchmark**: the stress harness (`tools/stress`) gains an option for bots to hold aim with a given weapon. Run `npm run server:benchmark` with no bots aiming, 50% aiming with the tube scope, and 50% aiming with the sniper, in the same session, and record tick p99. If it regresses beyond noise, fix it before shipping.
  Recorded 2026-10-01, 64 bots (the local server's cap) on `bench` movement, maxViewport 1700 × 1700, medians of 22–23 windows (avg / p95 / p99≈ ms): nobody aiming 2.28 / 5.02 / 9.27; tube scope 2.73 / 5.63 / 8.40; sniper 2.77 / 5.93 / 9.88; nobody aiming again 2.90 / 6.73 / 9.86. The aiming runs sit between the two baselines: no regression beyond noise.
- The same commands.
