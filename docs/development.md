# Development

Use the repository root as the working directory for npm commands. The server launcher locates Visual Studio with vswhere; `PREVAST_MSBUILD` can override the executable. C++ builds use the existing user-integrated vcpkg installation (`vcpkg integrate install`). Required ports include boost-asio, boost-beast, boost-iostreams, boost-json, fmt, luajit, nlohmann-json, pugixml, and libmariadb. The project builds with the v145 toolset.

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create missing local configs and listing token; preserve existing state |
| `npm run dev` | Watch/build browser and web host; serve on port 3100 |
| `npm run build` | Export content and build browser/web |
| `npm run build:all` | Build browser, web and C++ server |
| `npm run server:build` | Build C++ Release x64 |
| `npm run server:dev` | Run Release using the development profile |
| `npm run server:benchmark` | Run Release using the separate benchmark profile |
| `npm run check` | Typecheck, build and unit tests |
| `npm run server:validate` | Check authored content without opening ports |
| `npm run content:export` | Regenerate browser startup content |
| `npm run content:parity` | Compare the C++ and TS content exporters |
| `npm run smoke` | Start temporary isolated web/game instances and check HTTP, login and frames |

For Debug: `powershell -File scripts/server.ps1 -Action Build -Configuration Debug`. Launch the same configuration with `-Action Run -Configuration Debug`. Open `prevast.slnx` for Visual Studio editing. Launchers use the correct runtime working directory explicitly.

## Configuration and persistence

Edit local settings in `runtime/development/config.lua` or `runtime/benchmark/config.lua`. Templates in `config/` contain no admin password, database password or listing token. Setup generates credentials for a fresh checkout and never replaces existing settings. The listing token in `runtime/development/.listing-token` must match the development server's `listingToken`. `LISTING_TOKEN` overrides the web host's token; `PORT` overrides its HTTP port. Update the game server's `listingUrl` if you change that port.

The development profile uses game/status/HTTP ports 8172/8171/8180 and the benchmark profile 8272/8271/8280. Each profile owns its storage. Benchmark instances do not advertise themselves in the web registry by default.

The web registry saves a short-lived snapshot under `runtime/development/.server-registry-<PORT>.json`; `LISTING_SNAPSHOT_PATH` overrides its location for another instance. Writes are batched to at most once per second during normal operation. The snapshot contains no listing token, is signed for that token and web port, and retains the original heartbeat timestamps, so a restart cannot revive an expired server. Smoke runs use their own snapshot path. Reverse proxies must stream `/api/servers/events` without buffering and allow idle gaps longer than the 25-second keepalive; the endpoint sets `X-Accel-Buffering: no` and disables compression. Each active home screen uses one web connection, with bounded stream capacity and HTTP polling fallback.

Changes to data/ require `npm run content:export` for browser startup data, plus the server's supported reload command or restart. Watch mode rebuilds code; it does not automatically reload game content. Unit fixtures change only when a test expectation intentionally changes.

## Accounts (optional)

Accounts live on the web host; a game server accepts them only with `useDatabase = true`.

1. Start MariaDB (any local install, such as the one in XAMPP) and create the game database: `CREATE DATABASE prevast;`
2. `npm run setup` creates `runtime/development/.account-signing-key`, `.account-admin-token` and `.account-progress-tokens`, and fills `accountPublicKey`, `accountAdminToken` and `accountProgressToken` in new runtime configs. Existing configs gain only missing keys; existing values, including an explicit empty string, are preserved. Keep these files private (POSIX owner-only modes do not restrict Windows ACLs).
3. Put the accounts database URL in `runtime/development/.accounts-db`, e.g. `mysql://root@127.0.0.1:3306/prevast_accounts` (created on first start).
4. Set `useDatabase = true` in `runtime/development/config.lua`.
5. Make yourself admin: register on the start page, then `npm run account:set-group -- <name> 4`.

See [account operations](accounts.md) for SMTP, recovery, session controls and upgrade instructions. Production notes for the web host:

- Serve it over HTTPS and run it with `NODE_ENV=production`: the session cookie is then always `Secure`, even when TLS ends at a proxy.
- Behind a reverse proxy, set `TRUST_PROXY` to Express's `trust proxy` value (a hop count such as `1`, or addresses such as `loopback`). Without it every client shares the proxy's rate-limit budget and `req.secure` never sees the HTTPS. Leave it unset when clients connect directly, or they can spoof `X-Forwarded-For`.
- `!setgroup` sends the account admin token, and progress sync sends the separate progress token, to `accountServiceUrl` over plain HTTP (the game server has no TLS). Keep that URL on loopback or a private network. Game-server environment overrides use `PREVAST_ACCOUNT_ADMIN_TOKEN` / `PREVAST_ACCOUNT_PROGRESS_TOKEN`; web-host credentials use `ACCOUNT_ADMIN_TOKEN` / `ACCOUNT_PROGRESS_TOKENS`.

`useDatabase = false` is guests plus `adminPassword` only. Groups and command ranks are in `data/XML/groups.xml` and `data/XML/commands.xml`; `!reload=groups` applies edits live. `npm run server:selftest` checks ticket verification against `tests/fixtures/accounts` (regenerate with `npm run accounts:fixtures`).

## Stress tests

Reusable Python and C++ harnesses are under tools/stress. Python needs the `websockets` package. Run harnesses from a runtime directory so their output stays out of source.
