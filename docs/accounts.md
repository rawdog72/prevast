# Account operations

Accounts belong to the web host and use the MariaDB database configured in `runtime/development/.accounts-db` or `ACCOUNTS_DB_URL`. Basic setup is in [development](development.md). Guests can play without an account; account joins require a valid ticket and never silently become guest joins.

## Email and recovery

Configure SMTP on the web host using environment variables or a private `runtime/development/.account-mail.json` file. Environment values override the corresponding file fields. Restart the web host after changes.

```json
{
  "host": "smtp.example.com",
  "port": 587,
  "user": "accounts@example.com",
  "password": "YOUR_SMTP_PASSWORD",
  "from": "accounts@example.com",
  "publicUrl": "https://game.example.com"
}
```

| File field | Environment variable | Meaning |
| --- | --- | --- |
| `host` | `ACCOUNT_SMTP_HOST` | SMTP host; empty disables email |
| `port` | `ACCOUNT_SMTP_PORT` | Defaults to 587 with STARTTLS; 465 uses implicit TLS |
| `user` | `ACCOUNT_SMTP_USER` | SMTP username; omit for an unauthenticated local relay |
| `password` | `ACCOUNT_SMTP_PASSWORD` | SMTP password |
| `from` | `ACCOUNT_MAIL_FROM` | Single sender email address |
| `publicUrl` | `ACCOUNT_PUBLIC_URL` | Fixed HTTPS origin of the game site, without a path |

Remote SMTP requires TLS. Loopback SMTP and HTTP public origins are allowed for local testing. Recovery links use the configured origin, never a request's Host header. Keep credentials out of Git and restrict access to the runtime directory.

Players verify an email from **Your account → Recovery**, using their current password. Registration and legacy email addresses are initially unverified. Changing the recovery address leaves the previous verified address active until the new link is confirmed. Verification links expire after 30 minutes; password-reset links after 15 minutes. Both work once, and a replacement link invalidates its predecessor. Requests are limited to one email per account per minute. Anonymous reset requests return the same message for known and unknown account details; sending is asynchronous and delivery jobs are not retained through a web-host restart.

Recovery codes work without SMTP. The account page creates one random, single-use code after checking the current password and shows it only once. Store it privately. Creating another code replaces the old one. Either a verified-email link or the code plus account name can reset the password. A reset revokes all browser sessions, outstanding recovery/verification links and the old recovery code. An ordinary password change keeps the current browser session and revokes the others, links and code. Without a verified email or saved code, self-service recovery is unavailable.

## Browser sessions and progress

Remembered sign-ins last up to 30 days. Unchecking **Keep me signed in on this device** creates a session cookie with an eight-hour server limit; browser session restoration can preserve session cookies, so shared-device users should sign out explicitly. Each account keeps at most 20 sessions. The dashboard shows browser/platform labels and last activity, and allows individual or all-session sign-out. Existing sessions without device metadata remain usable and show a generic label. Expired sessions and action links are cleaned hourly.

Revocation affects browser authentication and new ticket requests. It does not immediately disconnect a running game, and a ticket already issued can be accepted for up to 90 seconds (60-second lifetime plus 30 seconds of clock tolerance). Game servers validate tickets offline. Logout failures remain visible and do not claim the session was revoked.

The private survivor profile reads saved stats and achievements. Recent progress can lag the game server's flush interval. Private/retired stats and locked secret achievement text are hidden; unlocked secret details and previously earned retired achievements remain visible. Gameplay rewards and unlocks remain authoritative on C++ servers.

## Server credentials

The web host reads `runtime/development/.account-progress-tokens`, a JSON object mapping server/listing IDs to independent random tokens of at least 32 characters. `ACCOUNT_PROGRESS_TOKENS` overrides the whole object. Each game server's `accountProgressToken` must match its entry; `PREVAST_ACCOUNT_PROGRESS_TOKEN` overrides that Lua value. `npm run setup` generates the development and benchmark entries and adds missing config keys while preserving operator settings. Rotate a progress token by updating both ends and restarting them.

Progress routes require `X-Account-Progress-Token`; they no longer accept the admin token. Each token identifies its server for batch deduplication. Account administration (`!setgroup`) still uses `accountAdminToken` / `ACCOUNT_ADMIN_TOKEN` and `X-Account-Admin-Token`. Progress credentials cannot change groups. Disable `accountAdminToken` on servers that do not need administration. The C++ HTTP client has no TLS, so keep `accountServiceUrl` on loopback or a private network.

## Upgrading and checking

1. Back up the accounts database and private runtime configuration. Run `npm ci` and `npm run setup` from the repository root. Check the progress-token map agrees with each runtime config; explicit empty keys remain disabled.
2. Deploy matching web/client and C++ builds (protocol **1418**). An older game server is intentionally incompatible with the new client because it could downgrade failed account authentication to a guest login.
3. Restart the web host. Additive, versioned migrations run automatically under a database lock and preserve existing accounts, sessions and progress. The database user needs schema-creation privileges. Existing email addresses require verification; lower-cost password hashes are upgraded after a successful login.
4. Restart game servers with their progress tokens. Preserve their progress outboxes; old acknowledged batch IDs remain recognized during the transition. Configure SMTP and verify a test mailbox you control before relying on email recovery.

`npm run check`, `npm run server:build`, `npm run server:validate` and `npm run smoke` cover the ordinary checks. Real MariaDB store tests require `ACCOUNTS_TEST_DB_URL` pointing to a disposable database named `prevast_…test` (or that name followed by an underscore and digits); the tests reset it. Account integration uses `SMOKE_ACCOUNTS_DB_URL` and a separate `prevast_smoke_game` database on the same database host. Never point either test setting at a player database or copy test storage into a live instance. SMTP unit tests use a loopback mail sink without external recipients.


## Survivor sessions, golden caps and clans

A session is one survivor life. Reconnection and successful respawner resurrection retain its identity; terminal death finalizes it once. Personal average score is the sum of final displayed scores divided by completed lives. Interruptions (shutdown, restart, reset or forced removal) retain history and earned caps but do not enter the average. No historical scores are inferred.

Set `ACCOUNT_RANKED_SERVERS=prevast-development` on the web host to approve that listing for score rewards and rankings. The comma-separated list defaults empty; each entry must also have its own progress credential. C++ also checks the authored mode list and rules version. Guests, staff/admin-assisted lives, starting kits, and repeated or same-account/IP/clan PvP farming do not earn ranked score. Ordinary factual stats remain separate. Keep hosts on synchronized clocks for season and membership timestamps.

`data/account-progression.json` defines 1 golden cap per 10,000 eligible score, 5 caps to create a clan, achievement rewards, and event reward amounts. Milestones pay while alive, and unfinished fractions reset at the end of a life. Wallet transactions and run receipts are permanent; retrying a report or creation request cannot pay or charge twice. Golden caps are account currency, separate from inventory bottle caps.

Scripted event rewards use an authored intent such as `{ accountEvent = "winter", occurrence = "2026-day1" }` after adding that key and amount to `eventRewards`. Choose a stable occurrence id: an account receives each key/occurrence once across all servers. The event list starts empty until actual events are authored. Increment the rules version when reward rates or eligibility change and deploy matching rules on both services; drain pending reports before changing rules.

Players create and manage permanent clans from Account. Membership has no capacity limit; rosters are paginated. Owners manage roles, transfer ownership or disband without a refund; officers invite and remove ordinary members. A new join (including creation) starts a 24-hour switch cooldown. Invitations expire after seven days. Temporary teams still control in-game permissions and have their existing limits.

Player and clan boards have lifetime and UTC monthly periods. Score is earned in its original month and clan membership interval, even if its report arrives later. Clan averages divide score by distinct contributors; departed contributors remain in that divisor. Average-session rankings require ten eligible completed lives. Top clans wear gold, silver, bronze, then violet (4–10) shields; others use steel. Trophies settle seven days after month-end. Later reports still pay caps and update lifetime totals, but cannot rewrite a settled season.

C++ stores run checkpoints and its ordered outbox in `storage/account-runs-outbox.json`. Preserve it across restarts. Critical milestones, awards and endings are written before transmission; ordinary play is checkpointed every 30 seconds, so a crash can lose at most that unsaved interval. Startup replays durable reports before marking the previous process's remaining lives interrupted. Rejected reports are retained in its `rejected` array with status/error for operator repair. A corrupt outbox disables accounting instead of overwriting receipts. Live UI values can lead confirmed database values while reports are queued.

Transaction tests use `COMMUNITY_TEST_DB_URL` with the same disposable-database naming safeguard as the other account tests. They cover retries after spending, role restrictions, membership history, seasonal boundaries, minimum samples and reward deduplication.
