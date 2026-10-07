# Prevast Open Server

**An unofficial, independent reimplementation for Devast.io.**

Prevast Open Server is a community-created open-source server and client implementation inspired by and designed to work with the gameplay and networking concepts of Devast.io.

> This project is not affiliated with, endorsed by, sponsored by, or officially connected to the original developers or owners of Devast.io.

One repository for the browser game, Express web host, C++ game server, authored content, and development tools.

## Start developing

Requirements: Node.js 22 or newer, npm, Visual Studio C++ tools with the v145 toolset and Windows SDK, and a user-integrated vcpkg installation. The server uses Boost, fmt, LuaJIT, pugixml, and MariaDB connector libraries. See [development](docs/development.md).

```powershell
npm ci
npm run setup
npm run server:build
npm run dev
```

In a second terminal at this repository root:

```powershell
npm run server:dev
```

Open http://localhost:3100. Development game/status ports are 8172/8171; the server HTTP port is 8180.

## Original assets

The game draws the original Devast.io images and plays its sounds, but this repository does not include them: they belong to their owners and are not covered by this project's license. If you have your own copy, put it in `original-assets/img` and `original-assets/audio` and run `npm run assets:check`. [original-assets/README.md](original-assets/README.md) has the details.

Without them everything still builds, the tests pass and the game runs, with blanks where the original sprites and sounds would be.

## Project map

| Path | Owns |
| --- | --- |
| `apps/client/src` | Browser rendering, input, UI, networking, editor |
| `apps/client/public` | HTML, CSS and the project's own art |
| `original-assets` | Your copy of the original images and sounds (ignored by Git) |
| `apps/web/src` | Static hosting and server registry |
| `apps/server/src` | Authoritative C++ game server |
| `shared/typescript` | Shared TypeScript schemas and types |
| `shared/protocol` | Protocol maintenance guidance |
| `data` | Authored XML, Lua hooks, maps, NPCs and quests |
| `config` | Tracked configuration templates without secrets |
| `tools` | Content and asset tooling, release audit, stress harness |
| `scripts` | Project setup, builds and launchers |
| `tests` | Integration runners and fixed test fixtures |
| `docs` | Current architecture and development guidance |
| `build`, `dist` | Ignored compiler intermediates and generated output |
| `runtime` | Ignored per-instance configuration, storage and logs |

Unit tests remain beside the modules they test. Run `npm run check` for TypeScript, the browser/web build, and unit tests; `npm run server:validate` for server content validation; `npm run content:parity` to compare the C++ and TypeScript content exporters; `npm run smoke` for an isolated web/game integration run; and `npm run release:audit` to check that nothing that must stay out of the repository is committed.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. [Architecture](docs/architecture.md) explains how the parts fit together.

The [World Editor guide](docs/world-editor.md) covers authoring and running scenarios. The [quest authoring guide](docs/quest-authoring.md) covers quests, scripts, areas and achievements; [docs/design](docs/design) holds the reference designs for quests and progression, aiming and scopes, and the join and disconnect flow.

The [account operations guide](docs/accounts.md) covers SMTP verification and recovery, browser sessions, progress credentials and upgrading existing installations.

## License

Prevast Open Server is free software under the [GNU General Public License v2.0](LICENSE) (`GPL-2.0-only`). Parts of the C++ server core derive from [The Forgotten Server](https://github.com/otland/forgottenserver), also GPL-2.0; those files keep its copyright line beside this project's.

Only source code is covered. Devast.io names, artwork, sounds and other assets belong to their respective owners and are not part of this license.
