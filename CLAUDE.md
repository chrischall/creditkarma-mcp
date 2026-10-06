# creditkarma-mcp

MCP server for Credit Karma. Syncs transactions from the Credit Karma GraphQL API into a local SQLite database and exposes query tools via stdio transport.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm test               # Run tests (vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
```

Run locally (requires built dist):
```bash
CK_COOKIES=xxx node dist/index.js
```

## Tool naming

All tools are prefixed `ck_` (e.g. `ck_sync_transactions`, `ck_list_transactions`).

## Architecture

```
src/
  index.ts              # MCP server entry point — registers all tools, starts stdio transport
  auth.ts               # resolveAuth() + loadAuthIntoClient() — Pattern A three-path priority
  client.ts             # Credit Karma GraphQL client with auto-refresh
  db.ts                 # SQLite schema, migrations (v2 = balances + account-identity cleanup), upsert helpers
  balances.ts           # Pure parsers for the balance responses (credit report + net-worth UI)
  accountId.ts          # Synthesize a stable account id from provider + last-4 (CK returns empty ids)
  queryHash.ts          # Re-read CK's persisted-query hash from its web bundle when the compiled one goes stale
  transaction.graphql   # GraphQL query for transactions
  tools/
    auth.ts             # ck_set_session, ck_forget_session
    sync.ts             # ck_sync_transactions
    query.ts            # ck_list_transactions, ck_get_recent_transactions,
                        #   ck_get_spending_by_category, ck_get_spending_by_merchant,
                        #   ck_get_account_summary
    balances.ts         # ck_get_account_balances + refreshBalances() (run once by every sync)
    sql.ts              # ck_query_sql
```

Each tool file exports tool definitions (MCP schemas) and a handler. `index.ts` aggregates all tools and routes by name.

## Auth resolution (Pattern A template)

`src/auth.ts` is the canonical "browser-bootstrap + Node-direct" auth shape shared with ofw-mcp, resy-mcp, opentable-mcp, signupgenius-mcp, zola-mcp, … Sibling MCPs follow the same selector — keep it flat, the path-selection explicit, and the error messages actionable.

Three paths in priority order:

1. **`CK_COOKIES` env var** — full Cookie header. Caller parses the embedded `CKAT=<accessJWT>%3B<refreshJWT>` to extract both JWTs. Unchanged from pre-fetchproxy behavior.
2. **Saved session via `ck_set_session`** — `src/session.ts` writes the Cookie header to `~/.creditkarma-mcp/session` (0600, override with `CK_SESSION_PATH`) and `resolveLocalAuth()` reads it back with plain `fs`. It used to be a `CK_COOKIES` line in `<install>/.env`, which the shipped `.mcpb` never read back: dotenv is `--external` in the bundle and `node_modules/` is `.mcpbignore`d, so `loadDotenvSafely` silently no-ops (fleet-audit#71). Paths 1 and 2 are both local candidates — the one with the fresher refresh JWT wins (saved file on a tie). Tests isolate `CK_SESSION_PATH` via `tests/setup.ts`. `ck_forget_session` deletes the file (`deleteSavedSession`) and calls `client.clearSession()`; it cannot unset a host-supplied `CK_COOKIES` and says so (fleet-audit#1158).
3. **fetchproxy fallback** — `@fetchproxy/bootstrap` (3.4+) spins up a one-shot WebSocket bridge to the ContextMint Bridge extension (the fetchproxy extension renamed, same maintainer; public source at https://github.com/nullnet-app/contextmint-bridge, releases ship a `.sha256` beside each zip) and reads the HttpOnly `CKAT` + `CKTRKID` cookies on creditkarma.com via `chrome.cookies.get`. Returns once. Subsequent CK API calls (GraphQL + `/member/oauth2/refresh`) go direct from Node — fetchproxy is NOT in the hot path.

`CK_DISABLE_FETCHPROXY=1` opts out of path 3 (turns missing creds into a hard error — useful in headless CI).

`loadAuthIntoClient(client)` is the lazy bootstrap helper used by tool handlers (currently just `sync.ts → refreshOrThrow`): when the client has no refresh token, it calls `resolveAuth()` and applies the result. `@fetchproxy/bootstrap` is mocked at the module boundary in `tests/auth.test.ts`.

## Environment

```
CK_COOKIES=<value>          # Optional. Full Cookie header from a signed-in creditkarma.com request. The runtime parser also accepts a bare CKAT value or `CKAT=<value>` for legacy callers. Capture via `ck_set_session` or just install the ContextMint Bridge extension and skip this.
CK_DISABLE_FETCHPROXY=1|true # Optional. Skip the fetchproxy browser-extension fallback (missing creds become a hard error — useful in headless CI).
CK_DB_PATH=<path>           # Path to SQLite database. Default: ~/.creditkarma-mcp/transactions.db
CK_SESSION_PATH=<path>      # Optional. Saved-session file (ck_set_session). Default: ~/.creditkarma-mcp/session
CK_CREDIT_BUREAU=transunion|equifax # Optional. Credit report used for card/loan balances. Default transunion.
CK_SYNC_MAX_PAGES=<n>       # Optional. Pages one ck_sync_transactions call may fetch before pausing. Unset (or unparseable) = unbounded, which is what a local stdio server wants. Set it on a HOSTED deployment, where the call has to answer inside the client's request timeout.
```

## Testing

Tests live in `tests/`. Run with `npm test`. No real API calls — client is mocked.

## Plugin / Marketplace

```
.claude-plugin/
  plugin.json       # Claude Code plugin manifest (MCP server config + skill reference)
  marketplace.json  # Marketplace catalog entry
skills/
  creditkarma/SKILL.md      # Claude Code skill — teaches Claude when/how to use the tools
  creditkarma-fpx/SKILL.md  # fetchproxy CLI access skill
```

<!-- pr-workflow:v3 -->
## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review /
auto-merge ladder, auto-review follow-up issues, PR timing, and release PRs —
lives in `~/.claude/CLAUDE.md`. Don't restate it here; the copies drifted.

Shared technical conventions (publishing, bundling, versioning guards,
write-verification, transport archetypes, testing traps) live in
[`chrischall/workflows`](https://github.com/chrischall/workflows):
`docs/fleet-conventions.md`, plus `README.md` for the CI pipeline contract.

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → `npm install --package-lock-only` after changing package.json (or `npm version` does it automatically)
3. `src/index.ts` → `Server` constructor `version` field
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version` (two entries)
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `plugins[].version` and `metadata.version`

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a `chore(main): release X.Y.Z` PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { db } from './db.js'`).
- **CKAT auto-refresh**: the bearer-token lifecycle is owned by the shared `TokenManager` (`@chrischall/mcp-utils/session`) — proactive refresh inside its skew window, one reactive HTTP-401 replay, and a single-flight semaphore that coalesces concurrent refreshes into ONE `/member/oauth2/refresh` POST. The access token's TTL window is `TOKEN_TTL_MS` (~10 min) in `src/client.ts`; the refresh callback wraps CK's native `doRefreshAccessToken()` POST. Because CK's PRIMARY expired-token signal is a 200 body carrying an auth `errorCode` (not an HTTP 401), that GraphQL-errorCode path is mapped to `TOKEN_EXPIRED` in `parseTransactionPage` and reactively refreshed by the sync loop (`src/tools/sync.ts`) — the manager's reactive replay is HTTP-status-based and can't see GraphQL bodies. When the refresh token is expired, the server logs a startup warning and `ck_set_session` refuses to save stale credentials — sign back into creditkarma.com (fetchproxy path) or paste a fresh Cookie header.
- **Every refresh ROTATES the shared credential — so don't refresh needlessly**: CK returns a *new* refresh token from `/member/oauth2/refresh`, and the browser and this MCP share one `CKAT` cookie holding it. A refresh the MCP didn't need still invalidates the copy in the browser's cookie, and CK then signs the tab out — reported to the user as "logged you out due to inactivity", which points nowhere near the cause. Measured 2026-08-05: **two** MCP-side refreshes were enough to log out an untouched, freshly signed-in tab, and reloading the page does not repair it — only a full sign-in does. So `refreshOrThrow` (`src/tools/sync.ts`) refreshes only when the access token is genuinely spent, judged by the JWT's own `exp` (`accessTokenExpiry` in `src/client.ts`) rather than the old synthetic 10-minute window; `TOKEN_TTL_MS` is now just the fallback for an undecodable token. The reactive path passes `tokenKnownDead: true` — when CK answers `TOKEN_EXPIRED` the token is dead whatever its `exp` claims, and that check must not apply. **This is a mitigation, not a cure**: when the browser has been idle past the access token's ~15-minute life (the nightly-sync case), the MCP must refresh anyway and the tab still gets signed out. Actually closing it needs the rotated tokens written back to the `CKAT` cookie, which needs a cookie-**write** capability in fetchproxy (`chrome.cookies.set`) — `@fetchproxy/bootstrap` and `fpx cookies` are read-only today.
- **Stale refresh tokens must re-bootstrap, not just fail**: CK's refresh JWT lives ~8h but an MCP server process lives for days, so `refreshOrThrow` (`src/tools/sync.ts`) checks the cached refresh token's own `exp` and re-runs `loadAuthIntoClient()` when it has lapsed — and retries once, after a re-bootstrap, when CK rejects a token whose `exp` still looked valid (revoked session / rotated device id). Without that check a long-lived server was **permanently** broken once its cached token aged out: it kept POSTing the dead token, and signing back into creditkarma.com couldn't fix it because the process never re-read the browser's fresh cookies. Only a server restart cured it. Re-bootstrap at most once per refresh — looping would re-prompt the extension forever.
- **Rotated tokens are written back — locally**: after every successful refresh the client rebuilds the `CKAT` cookie in its own Cookie header (`withCkat` in `src/client.ts`) and `persistRotatedSessions()` (`src/auth.ts`, wired in `index.ts`) saves it to the saved-session file. Without that, the client kept sending the rotated-out CKAT, and a restart reloaded the dead refresh token from `CK_COOKIES` and failed with `session_rejected` (fleet-audit#69). When CK rejects a refresh token that still looks valid, `refreshOrThrow` re-bootstraps with `{ rejectedRefreshToken }` so resolution skips every local copy of it and reaches fetchproxy even when `CK_COOKIES` is set — env is only a seed. With fetchproxy disabled that surfaces as `session_rejected`, not `no_credentials`. (The *browser's* CKAT still can't be written — that is the #119 gap above.)
- **Auth failures are typed, not string-matched**: `src/authError.ts` exports `CkAuthError` with a `reason` of `no_credentials` (nothing readable from fetchproxy/env), `session_stale` (readable, but the refresh JWT's `exp` has passed — caught locally before any POST), or `session_rejected` (CK turned the credentials down; carries the HTTP `status`). These have different fixes, so keep the phrases `no credentials readable` / `session stale` / `session rejected` in the messages and branch on `isCkAuthError(err, reason)` rather than matching message text. A fetchproxy bridge-down error is deliberately NOT a `CkAuthError` — that's infrastructure, and tagging it would send users to re-sign-in instead of waking the extension.
- **Sync strategy**: incremental by default — fetches since last sync date with a 30-day overlap. Use `force_full: true` to walk with no date cutoff — from page 1, unless it is continuing a backfill paused by `max_pages`/`page_cap`.
- **Resume on failure**: `ck_sync_transactions` saves `last_cursor` to `sync_state` if a page fetch fails, so the next sync resumes from the same cursor. The cursor is cleared on success. Every checkpoint also records `resume_mode` (`full` = no date cutoff, `incremental` = last_sync_date − 30d) so a resume walks the way the paused sync did: a paused force_full backfill is finished by a plain call OR a repeated force_full, and is never cut short by the incremental cutoff of an older completed sync (fleet-audit#68). Only a DELIBERATE pause (`max_pages`/`page_cap`) also writes `resume_paused`; force_full resumes only a checkpoint carrying it. A checkpoint from a failed fetch or a stuck cursor may itself be the bad cursor, so force_full restarts from page 1 — it is the only escape hatch (`ck_query_sql` is read-only).
- **Bounded and resumable, for hosted deployments**: a deep backfill is hundreds of pages and minutes of work. Locally that is fine; hosted it is not — the call must answer inside the client's request timeout, and a sync that runs past it is reported as a failure however much data it actually banked. So `CK_SYNC_MAX_PAGES` (or the per-call `max_pages` argument, which beats it) bounds the pages one call may fetch; the walk then pauses, checkpoints `last_cursor`, and returns `another_run_needed: true` with a `note` naming the next call. Such a paused call also SKIPS the balance refresh (6 GraphQL calls) — `balances` is absent and the call that completes the sync refreshes them. `last_sync_date` is deliberately NOT advanced on a pause — doing so would let the next incremental run start after data it never fetched. This is the fleet's shape for the same problem (`OFW_SYNC_MAX_REQUESTS` in ofw-mcp, `max_pages` in untappd-mcp's `untappd_sync_user_beers`), and it is deliberately NOT a background job with a status to poll: on a scale-to-zero machine the child is idled out from under a background walk, whereas every bounded call is complete in itself and the SQLite file IS the resume state. Unset means unbounded, so nothing about the local behaviour moves. An empty `endCursor` is never checkpointed — it reads back as a cursor and resumes from nowhere — and that rule lives in ONE helper (`checkpoint()`) shared by all three pause paths rather than restated at each. `another_run_needed` means "more to fetch AND retrying will make progress", so it is deliberately FALSE for `cursor_stuck`: CK handed back the cursor it was given, so an immediate retry replays the same page, and a headless caller looping on the flag would hammer the endpoint — the exact behaviour the stuck-cursor guard exists to prevent. `stopped` still reports it and the note points at a later run.
- **Balances have two sources, and neither is a balance API**: CK's web app has no structured per-account balance query. (1) **Linked accounts** come from `getAccountL2Page` (`prime_web`, `{input:{accountType}}` for cash/investments/property — not loans, which the credit report covers with typed signed amounts, so fetching both could list a loan twice with an unverified sign), which returns server-driven UI cards — balances exist only as text. `parseLinkedBalances` finds rows by CONTENT (the smallest node holding exactly one `Provider (...1234)` line and one `$` amount), not layout keys, because CK reorders a row's spans ("needs attention" rows put the provider first); unpairable provider lines are counted in `unparsed`, never guessed. Exact as-of comes from `idxConnections.lastRefreshTimeStamp` via `findConnectionTime`: the net-worth rows show SHORTENED provider names (investments are truncated with "...") while connections carry full ones, so it matches exactly first, then by prefix (oldest wins on ties) — measured 2026-10-06, exact alone timed 11 of 26 live rows, prefix all 26. Falls back to the row's "2 hr ago". The same shortened names break the synthetic id too (`Example Bank|1234` vs the transactions' `Example Bank Personal|1234`), so when a row's resolved id has no account, `findAccountByProviderPrefix` (`src/db.ts`) looks for the ONE existing account with the same real last4 and a provider prefix in either direction; ambiguous or no match → its own row. CK also lists some accounts TWICE: a live record `(...6801)` and an abandoned one for the same account whose number it formats `(...8-01)` (measured 2026-10-06 on three 529 plans: updated tens of days ago, no change history, 90–95% of the live balance). `dropStaleDuplicates` skips a row with no real last4 when a same-named row has one, and `deleteStaleLinkedRow` removes any balance-only row an earlier sync stored for it (never one with transactions). The connection-level `lastRefreshTimeStamp` can't catch these — both records share it — which is why they otherwise looked fresh. Verified live the same day: the parser recovered every row (cash 11/11, investments 15/15 under `lookalikeViews`, including "needs attention" rows whose provider line sits in `rowTitle`). (2) **Cards and loans** come from the credit report: `getCreditReportHistory` → newest `reportDates` entry → `getCreditReport({bureau, date})`, which has typed `currentBalance`/`limit`/`dateReported`. The `date` must be an EXACT report timestamp — "now" or a bare day returns a generic "An error occurred.". Bureau codes: 1 = TransUnion, 2 = Equifax. Tradeline `accountId` is literally `"id"` on every row and `accountNumber` is a 70-char hash (no last 4) that is stable across reports but differs between bureaus — so rows are keyed `cr:<bureau>:<hash>`, only one bureau is used, and they can't be linked to transaction accounts. Closed tradelines are dropped and rows missing from the newest report pruned. `available_balance` is always NULL: CK exposes it nowhere. Verified live 2026-10-06.
- **Each CK web app has its own safelist**: the gateway keys persisted operations on `ck-client-name`. `getCreditReport*` are registered under `credit-health` (1.2.1) and answer "No query found" when sent as `prime_web`. So `OPERATIONS` in `src/client.ts` carries each op's client identity, and `runOperation` self-heals a rotated hash from that app's own bundle (`HashSource` in `src/queryHash.ts`), once per operation.
- **Balance sign convention**: same as transactions — assets positive, liabilities (card balances, loans) negative; `credit_limit` positive. `stale` = `balance_as_of` older than 7 days (linked) or 35 days (credit report; bureaus update ~monthly).
- **Account identity beyond provider|last4**: a transaction carrying `accountURN` resolves to the row already holding that URN (survives provider renames); otherwise an `account_aliases` entry, otherwise the synthetic id. Migration v2 backfilled URNs only where unambiguous (one URN per account and vice versa) and merged rows that are one card under two provider-name variants ("X" vs "X - Credit Cards"): same base provider before " - ", same real 4-digit last4, ≤1 distinct URN; most transactions survives and the retired id becomes an alias so a force_full can't recreate it. Different institutions sharing a last4 are never merged.
- **Read-only SQL**: `ck_query_sql` only permits SELECT (including `WITH ... SELECT` CTEs) — no writes. Validation is comment-stripped before the `^(WITH|SELECT)` regex check, and execution runs under `PRAGMA query_only = 1` (restored in `finally`) so a CTE-wrapped write (`WITH ... INSERT`) fails with SQLITE_READONLY. `node:sqlite`'s `prepare()` only compiles the first statement, so trailing statements never execute. Results are streamed with `iterate()` and capped at `max_rows` (default `DEFAULT_MAX_ROWS` = 500, ceiling `MAX_ROWS_LIMIT` = 5000); an overflow returns `truncated: true` plus a LIMIT/OFFSET hint instead of the whole table (fleet-audit#1157).
- **Amounts**: negative = expense/debit, positive = credit/income.
- **Empty `account.id` from CK**: `transactionsHub` returns `""` for every `account.id`, even across multi-account responses. `src/accountId.ts` synthesizes `<trimmed-providerName>|<last-4-from-display>` (e.g. `Citi|2630`) so each account gets a stable row. `backfillAccountIds()` runs once on server startup to repair legacy DB rows from `raw_json`. The same physical card under two `providerName` strings (e.g. `"Capital One"` vs `"Capital One - Credit Cards"`) used to become two synthetic accounts; schema v2 merges them — see *Account identity beyond provider|last4* below.
- **GraphQL is persisted-query only**: transactions come from Credit Karma's internal GraphQL API, and the gateway executes **only safelisted operations**. `fetchPage()` therefore sends no query document at all — just `{extensions:{persistedQuery:{version:1,sha256Hash}},operationName,variables}` with `TRANSACTION_QUERY_HASH` from `src/client.ts`. Two headers are mandatory alongside it: `ck-client-name: prime_web` (exact — `web`, the value the *refresh* endpoint takes, is rejected) and a non-empty `ck-client-version` (value irrelevant; it only documents which CK web build the hash came from). `src/transaction.graphql` is kept as documentation of the selection set `parseTransactionPage` reads — it is no longer sent or loaded at runtime, so nothing copies it into `dist/`.
- **`No query found` means a stale hash, not a flake**: `HTTP 400 {"message":"No query found"}` is the gateway failing to resolve the request against its operation registry — either the `ck-client-*` pair is missing or the persisted hash is no longer registered. It is never retried as-is: the gateway either resolves the hash or it never will. The one recovery worth attempting is **self-healing** (`src/queryHash.ts`) — re-read the current hash from CK's own bundle and replay once. `discoverQueryHash()` GETs the signed-in `/networth/transactions` page, extracts its `prime_web` chunk URLs, and scans them for the `usePregeneratedHashes` manifest (measured 2026-08-05: 22 chunk URLs, manifest in the 13th, ~0.68 MB, ~1s). It is attempted **at most once per client** and skipped without cookies — logged out, that URL serves the *login* bundle, which has no manifest. Discovery never throws; a failure surfaces as the original GraphQL error, so the worst case is exactly the pre-discovery behavior. If it can't heal, derive the hash by hand from the same manifest and update `TRANSACTION_QUERY_HASH`. Verified 2026-08-05 by ablating one header at a time against a live account (issue #114/#115): removing `ck-client-name` or `ck-client-version` 400s; removing cookies, `Origin`/`Referer`/`User-Agent`, `accept`, `ck-trace-id`, `ck-cookie-id`, `ck-device-type` or `ck-client-tz-id` all still return 200. **Historical trap:** this was documented for months as a ~44% upstream flake with the `ck-*` headers explicitly "falsified" — that A/B sent `ck-client-name: web`, the wrong value, so it disproved the wrong thing. The 44%→100% drift was a safelist rollout reaching full coverage.
- **Build before run**: `dist/` must exist before running the server manually. `npm run build` runs `tsc` + bundles via esbuild into `dist/bundle.js` (the MCPB/manifest entry point).
- **stdio transport**: the server logs warnings to **stderr** only — stdout is reserved for JSON-RPC. `dotenv` is loaded with `quiet: true` for the same reason.
- **Persisted credentials**: `saveSession()` (in `src/session.ts`) writes the saved-session file at mode 0600 in a 0700 directory. Anything else handling secrets in this repo should match. The fetchproxy path is NOT memory-only: `persistRotatedSessions()` (`src/auth.ts`) saves every refresh rotation's `CKAT`/`CKTRKID` Cookie header through `saveSession()` (0600, `CK_SESSION_PATH` or `~/.creditkarma-mcp/session`), fetchproxy-sourced sessions included, so a restart can recover. Don't document it as disk-free.
- **Coverage**: `vitest.config.ts` enforces 100% line/branch/function/statement coverage on `src/**` (excluding `src/index.ts`). Failing coverage fails CI.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
