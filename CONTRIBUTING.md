# Contributing

Thanks for helping with Prevast Open Server. Read [README.md](README.md) and
[docs/architecture.md](docs/architecture.md) first, and run every command from
the repository root.

## Where things live

- Code lives in `apps/`, `shared/`, `tools/`, `scripts/` and `tests/`; authored
  game content lives in `data/`. Unit tests sit beside the modules they test.
- The C++ game server is authoritative for game rules, inventory, economy,
  quests and networking. The client renders state and sends input; it never
  decides an outcome.
- Protocol changes touch both sides in the same change:
  `apps/server/src/network/opcodes.h` and `apps/client/src/net/`. See
  [shared/protocol/README.md](shared/protocol/README.md).
- Edit content only in `data/` ([data/README.md](data/README.md)). Keep IDs,
  include order, NPC spawn keys and quest/objective keys stable.
- `dist/content` is generated browser startup content and
  `tests/fixtures/content` is a deliberate test snapshot. Do not edit either
  as game data.
- When you add a C++ file, add it to `apps/server/prevast_server.vcxproj` and
  its `.filters` file. Internal includes are relative to `apps/server/src`.

## Original assets

The original Devast.io images and sounds are not part of this repository and
must never be committed, under any name, nor anything derived from them. Your
own copy goes in `original-assets/` (see
[original-assets/README.md](original-assets/README.md)), which Git ignores.
Build steps that transform sprites (like `tools/assets/item-icons.ts`) read
that folder at build time and write to `dist/`.

New art you made yourself goes in `apps/client/public/img`. Original game
text (descriptions, dialogue) is not copied either; write your own.

## Checks

| Change | Run |
| --- | --- |
| TypeScript, client or web host | `npm run check` |
| C++ | `npm run server:build` and `npm run server:validate` |
| Content or the exporters | `npm run content:parity` |
| Integration or paths | `npm run smoke` |
| Anything you are about to push | `npm run release:audit` |

`npm run check` already fails when an original asset is committed.

## Files

- New source files start with the project's copyright and license lines:

  ```ts
  // Copyright (c) 2026 <your name> and Prevast Open Server Contributors
  // SPDX-License-Identifier: GPL-2.0-only
  ```

  Files derived from The Forgotten Server keep its copyright line too.
- Keep generated files, secrets, logs and experiments out of Git. Use
  `runtime/` for experiments and `build/` and `dist/` for compiler output.
- Never point a test at another profile's storage or copy test storage into
  another instance.
- Keep docs short and current; describe how things work now, not how they
  got there.
