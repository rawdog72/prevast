# Protocol maintenance

The game protocol is binary WebSocket frames in both directions, implemented
in C++ and TypeScript. This directory documents ownership and rules; it is not
a generated schema.

- Opcodes, payload layouts and wire enums: `apps/server/src/network/opcodes.h`.
  `apps/client/src/net/opcodes.ts` mirrors it, and `opcodes.test.ts` fails if
  the two disagree on any name or number.
- C++ encoding and decoding: `apps/server/src/network/protocolgame.{h,cpp}`.
- TypeScript encoding and decoding: `apps/client/src/net/` (`outbound.ts`,
  `dispatcher.ts`, `handlers/`).
- Shared JSON payload schemas: `shared/typescript/npc-protocol.ts`,
  `quest-protocol.ts`, `progress-protocol.ts`, `account-community.ts`.
- Stress-bot copies of the tables: `tools/stress/protocol.py` and
  `tools/stress/cpp/protocol.h`.
- Packet replay fixture: `tests/fixtures/net/`.

## Rules

- Change both sides in the same change, and bump `CLIENT_VERSION_MIN/MAX` in
  `apps/server/src/core/definitions.h` together with `PROTOCOL_VERSION` in
  `opcodes.ts`. The current version is **1418**. A client of another version
  is refused with `ALERT`, which every version can decode.
- Preserve batching, integer widths, IDs and message ordering. Wire enums
  (`DisconnectReason`, `ChatChannel`, `QuestCause`, `ModSlot` and the rest)
  are never renumbered.
- Client payloads are fixed-size unless `clientPayloadBytes()` marks them
  variable; the server refuses truncated and overlong packets alike.
- Add a new opcode to its area's group in both enums, at the next free number.

## Number ranges

| Server → client | | Client → server | |
| --- | --- | --- | --- |
| 0 | Connection and session | 0 | Connection |
| 10 | Content | 10 | Movement and combat |
| 20 | World | 20 | Items |
| 40 | Players | 30 | Interaction and containers |
| 50 | Your character | 40 | Building and crafting |
| 80 | Inventory | 50 | Chat and social |
| 90 | Crafting and stations | 60 | Teams |
| 100 | Teams | 70 | Trade and NPCs |
| 110 | Chat | 80 | Quests |
| 120 | Trade and NPCs | | |
| 130 | Quests, progress and account | | |

## Behaviour notes

- **Login.** A nonempty account ticket must authenticate, or the server sends
  `DISCONNECT_REASON` with `ACCOUNT_REQUIRED` and closes before creating a
  player; an empty ticket is a guest login. The login frame ends with
  `[str accountTicket]`, and `PLAYER_INFO` ends with `[u8 groupId][u8 identityFlags]`.
- **Disconnects.** Every refused login and every kick sends
  `DISCONNECT_REASON` right before the socket closes; the client owns the
  wording.
- **Aiming.** `AIM` is held state. The server derives `AIM_STATE` once per
  tick from the button, the weapon's `<aim>`, life, ghoul state and any running
  interaction (reload, equip, consume, craft, mod change), so a reload ends
  aiming and it resumes afterwards. While a weak scope is aimed, the server
  sends that player a stretched or shifted view box and the client darkens
  what lies outside it.
- **Weapon mods.** `ITEM_MODS` follows the `INVENTORY_SLOT` or `INVENTORY`
  that states a moddable weapon. `CONTAINER_CONTENTS` and `TRADE_STATE` items
  carry their fitted mods. `FIT_WEAPON_MOD` runs as a timed interaction like a
  reload (`INTERACTION_STARTED`, then `INTERACTION_CANCELLED` if it is
  cancelled or refused); a refusal is a `STATUS_MESSAGE`. A magazine keeps its
  own rounds when it is swapped or removed.
- **Fuel.** `STATION_OPENED` and `STATION_FUEL` carry the remaining burn time
  in milliseconds; the client counts down from that snapshot. `ADD_FUEL` asks
  for 1–254 items and the server caps it by free capacity and inventory.
- **Quests and progress.** `QUEST_STATE` holds only stages the player has
  reached, and `QUEST_MARKERS` is the whole set each time. Account progress
  arrives as `PROGRESS_STATE`, then `PROGRESS_UPDATE` deltas; a secret
  achievement's text is only in `PROGRESS_STATE` and `ACHIEVEMENT_UNLOCKED`
  once unlocked.
- **Account runs and clans.** `ACCOUNT_RUN` matches `runLiveSchema` and is
  sent after the handshake, periodically and before `YOU_DIED`.
  `ACCOUNT_CLANS` updates only the players it lists; `clan` is null or
  `{id, name, tag, rank}`, where rank is the current UTC monthly score position
  (0 = unranked), refreshed about once a minute. Permanent clan ids are
  independent of in-game team slots.
- **Social.** `BLOCKED_PLAYERS` is the whole online list after each change.
  `SET_PRIVATE_MESSAGES` is sent after each handshake and on change.
  `TEAM_LOCKED` is broadcast on lock and unlock and sent at login for each
  locked clan.
