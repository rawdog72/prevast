# Join and disconnect flow

How the client joins a server, what the start screen shows while it does, and how disconnects and reconnects work.

## Problem

`connectAndPlay` in `apps/client/src/main.ts` hides the start screen and starts the game loop before `socket.connect()`. A refused login therefore shows the HUD, then tears it down and returns to the start screen ("almost in, then kicked"). In addition:

- An unreachable server reports "Connection to server lost".
- Some refusals close the socket with no reason: login during shutdown and an unparseable login frame (`ProtocolGame::onRecvFirstMessage`).
- Reasons are developer strings ("Server is full slot id.", "Server is full. error: maxPlayers.").
- All reasons travel as free text in `ALERT`, the same message used for in-game kicks, so the client cannot choose a next step (retry, pick another server, refresh).

## Goals

- The game view appears only after the server confirms the join (HANDSHAKE).
- Every join attempt ends in exactly one outcome with a clear title, explanation and next step.
- In-game disconnects keep the game on screen under a dialog. A plain connection drop reconnects automatically; a disconnect with a reason never does.

Out of scope: a server-side join queue, translations, other client polish.

## 1. Server and protocol (protocol 1409)

`CLIENT_VERSION_MIN/MAX` and the client `PROTOCOL_VERSION` move to 1409 (`CLIENT_VERSION_STR` "14.09").

New server opcode `DISCONNECT_REASON = 99`: `[u8 reason][str detail]`, sent immediately before the server closes the socket. `ProtocolGame::disconnectClient` sends it in place of `ALERT`, so both login refusals and `Game::kickPlayer` use it. It keeps the existing flush-then-send-unbatched behaviour. `reason` is a code the client acts on. `detail` carries only variable data: ban author, reason and expiry; an admin's kick message; free text for `OTHER`. The client owns all player-facing wording.

`enum class DisconnectReason : uint8_t` (values fixed once shipped):

| value | name | sent when | detail |
|---|---|---|---|
| 0 | OTHER | any other refusal | free text |
| 1 | SERVER_FULL | no free slot id, or players online >= maxPlayers | — |
| 2 | SERVER_CLOSED | `GAME_STATE_CLOSED` and the group lacks AlwaysLogin | — |
| 3 | STARTING_UP | `GAME_STATE_STARTUP` | — |
| 4 | MAINTENANCE | `GAME_STATE_MAINTAIN` | — |
| 5 | SHUTTING_DOWN | login during `GAME_STATE_SHUTDOWN` (currently silent); graceful shutdown | — |
| 6 | INVALID_LOGIN | `parseFirstMessage` fails (currently silent) | — |
| 7 | IP_BANNED | IP ban at login, or `!ban` in game | ban text (who, until, reason) |
| 8 | TOO_MANY_FROM_IP | per-IP spawn cap | — |
| 9 | ADMIN_AUTH_REQUIRED | admin reconnect without adminPassword | — |
| 10 | SPAWN_FAILED | "Could not place character in world" | — |
| 11 | KICKED | admin kick | optional admin message |
| 12 | IDLE | idle kick | — |
| 13 | LOGGED_IN_ELSEWHERE | same account logs in again | — |
| 14 | PLAYER_LIMIT_LOWERED | maxPlayers lowered below online count | — |

`disconnectClient` takes `(DisconnectReason, std::string detail = {})`. `Game::kickPlayer` takes the reason as well. Every existing call site passes the matching code.

**Version mismatch stays `ALERT`.** A client of another protocol version cannot be assumed to decode opcode 99, but every version decodes `ALERT`. The new client treats any `ALERT` that arrives before HANDSHAKE as a rejection. This also covers a new client talking to an older server.

**Graceful shutdown notice.** On graceful shutdown the server sends `SHUTTING_DOWN` to connected players before the dispatcher stops. The implementation must confirm the shutdown path can still flush sockets at that point. If it cannot, this part is dropped: clients see a plain drop and their automatic reconnect fails cleanly.

`STOLE_YOUR_SESSION` is unchanged.

Server list: no protocol change. The option label adds "(full)" when players >= max > 0, as a hint only; the server still decides.

Coordinated files: `apps/server/src/network/opcodes.h`, `apps/server/src/core/definitions.h`, `protocolgame.{h,cpp}`, `gameplay/game.cpp`, `gameplay/game_admin.cpp`, `apps/client/src/net/opcodes.ts`, a handler plus a `disconnectReason` bus event in `apps/client/src/net/`, `shared/protocol/README.md`, and `tests/fixtures/net/` where it records the version.

## 2. Client join pipeline

New module `apps/client/src/net/join-session.ts`. It owns one join attempt; `main.ts` becomes wiring only.

Stages, reported as they happen: `content` → `ticket` → `connecting` → `syncing` → `logging-in` → `in-game`.

The one way into the game: `GameLoop` is still constructed before `connect()`, because its constructor subscribes to the bus and must see HANDSHAKE. `gameLoop.start()` and `screen.hide()` run only when HANDSHAKE arrives. The implementation checks whether the constructor attaches keyboard or mouse listeners that act while the start screen is up; if so they move to `start()`. `stop()` on a loop that never started must be safe.

Outcomes, exactly one per attempt:

- `joined`: HANDSHAKE received.
- `cancelled`: the player pressed Cancel. The socket closes and nothing is shown.
- `rejected(reason, detail)`: `DISCONNECT_REASON`, or `ALERT` before HANDSHAKE (outdated client).
- `unreachable`: the socket closed before `open`.
- `timed-out`: no HANDSHAKE within 15 s of `open`.
- `dropped`: the socket closed after `open` with no reason.

Once an outcome is settled it cannot change; late socket events are ignored.

Automatic retry applies to `STARTING_UP` and `MAINTENANCE` only: waits of 5 s, 10 s and 20 s, then the outcome is final with a Retry action. Every wait can be cancelled. Each attempt fetches a fresh account ticket (tickets live 60 s). `SERVER_FULL` is never retried automatically.

The account fallback is unchanged: a ticket failure joins as a guest with the existing notice.

## 3. Start-screen UI and messages

While joining:
- The fields lock.
- Play becomes **Cancel** (Esc also cancels).
- The status line shows the stage: "Loading game data…", "Signing in…", "Connecting to *name*…", "Syncing content…", "Joining *name*…".
- During a retry wait it shows "*name* is starting up — retrying in 7s (attempt 2/3)".
- The sprite preload note shows only while nothing more important occupies the line.

On failure, a notice box appears under the form (`role="alert"`) with a tone (error or warning), a title, a message, an optional detail and action buttons. The fields unlock and the notice stays until the player's next action. New `StartScreen.showFailure({ tone, title, message, detail, actions })`; `error(string)` remains as a thin wrapper for the editor and account paths.

Wording lives in the pure mapping `apps/client/src/ui/home/join-messages.ts`:

| outcome | title | message | actions |
|---|---|---|---|
| SERVER_FULL | Server is full | All *N* slots are taken. Try again shortly or pick another server. | Retry, Choose server |
| SERVER_CLOSED | Server is closed | It isn't accepting new players right now. | Choose server |
| STARTING_UP (retries used up) | Server is starting up | It should be back soon. | Retry |
| MAINTENANCE (retries used up) | Server is under maintenance | It should be back soon. | Retry |
| SHUTTING_DOWN | Server is shutting down | — | Choose server |
| ALERT before HANDSHAKE | Game update required | Your client is out of date. Refresh to load the latest version. (alert text as detail) | Refresh page |
| IP_BANNED | You are banned from this server | detail | — |
| TOO_MANY_FROM_IP | Too many players from your connection | Close another session and try again. | Retry |
| ADMIN_AUTH_REQUIRED | Admin password required | Enter the admin password to take over this character. | — |
| INVALID_LOGIN, SPAWN_FAILED | Couldn't join | The server rejected the login (*code name*). | Retry |
| unreachable | Can't reach server | It may be offline, or the address is wrong. | Retry, Choose server |
| timed-out | Server isn't responding | Connected, but it didn't let us in within 15 s. | Retry |
| dropped | Connection closed while joining | — | Retry |
| OTHER or unknown code | Couldn't join | detail | Retry |

Actions: **Retry** repeats the same join request; **Choose server** focuses the server dropdown; **Refresh page** calls `location.reload()`.

## 4. In-game disconnect and reconnect

New `GameLoop.freeze()` stops the render loop, input and audio. The last frame and the HUD stay visible under a dim overlay. `stop()` remains the full teardown. The disconnect dialog is `apps/client/src/ui/windows/disconnect-window.ts` in `#dv-modal`.

A plain drop (close with no reason, or watchdog timeout, while in game) reconnects automatically:
- The dialog reads "Connection lost — reconnecting… (attempt n/3)" with a **Main menu** button.
- Attempts happen immediately, then after 2 s, then after 5 s.
- While `navigator.onLine` is false, the client waits for the `online` event instead of spending attempts.
- Each attempt is a `JoinSession` with a new `GameLoop` built in the background, sending the stored session token, so the server's `reconnect()` hands back the same character.
- On HANDSHAKE the frozen loop is stopped and the new one started in the same task: no start-screen flash.
- An attempt refused with a code shows that code's message in the dialog.
- After three failures the dialog reads "Connection lost" with **Reconnect** and **Main menu**.

A disconnect with a reason never reconnects automatically:

| reason | dialog | actions |
|---|---|---|
| KICKED | You were kicked (detail) | Reconnect, Main menu |
| IDLE | Disconnected for inactivity | Reconnect, Main menu |
| PLAYER_LIMIT_LOWERED | Server capacity was reduced | Reconnect, Main menu |
| IP_BANNED | You were banned (detail) | Main menu |
| SHUTTING_DOWN | Server is shutting down | Main menu |
| LOGGED_IN_ELSEWHERE, STOLE_YOUR_SESSION | Your character was opened in another tab or device | Reconnect here, Main menu |
| OTHER / unknown | Disconnected (detail) | Reconnect, Main menu |

Death is unchanged: the death window owns the session after PLAYER_DIE. **Play again** now runs through `JoinSession`; a refusal lands on the start screen with the matching notice.

**Main menu** stops the frozen loop and shows the start screen with no error.

## 5. Testing

Client (vitest, `npm run check`):
- `join-session.test.ts` with a fake `WebSocketClass`:
  - stage order
  - no `start()` or `hide()` before HANDSHAKE
  - every outcome
  - a late close event after an outcome is ignored
  - retry backoff on fake timers, including Cancel during a wait
  - a fresh ticket per attempt
- `join-messages.test.ts`: every code maps to a message; unknown codes fall back to OTHER.
- Decoder and dispatcher tests for `DISCONNECT_REASON`.
- `start-screen.test.ts`: progress line, Cancel, notice box, actions.
- `disconnect-window.test.ts` and reconnect tests:
  - a drop auto-reconnects with 3 attempts and waits for `online`
  - a coded disconnect never auto-reconnects
  - the loop swap happens only on HANDSHAKE
  - Main menu shows no error
  - Play again goes through `JoinSession`

Server:
- `npm run server:build` and `npm run server:validate`.
- An encoder check for `DISCONNECT_REASON` alongside the existing `--selftest` checks.

Integration: `npm run smoke` gains a refused-login check against a server with a full or closed state. It asserts `SERVER_FULL` or `SERVER_CLOSED` arrives and HANDSHAKE does not.
