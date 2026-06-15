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
  db.ts                 # SQLite schema and upsert helpers (incl. backfillAccountIds)
  accountId.ts          # Synthesize a stable account id from provider + last-4 (CK returns empty ids)
  transaction.graphql   # GraphQL query for transactions
  tools/
    auth.ts             # ck_set_session
    sync.ts             # ck_sync_transactions
    query.ts            # ck_list_transactions, ck_get_recent_transactions,
                        #   ck_get_spending_by_category, ck_get_spending_by_merchant,
                        #   ck_get_account_summary
    sql.ts              # ck_query_sql
```

Each tool file exports tool definitions (MCP schemas) and a handler. `index.ts` aggregates all tools and routes by name.

## Auth resolution (Pattern A template)

`src/auth.ts` is the canonical "browser-bootstrap + Node-direct" auth shape shared with ofw-mcp, resy-mcp, opentable-mcp, signupgenius-mcp, zola-mcp, … Sibling MCPs follow the same selector — keep it flat, the path-selection explicit, and the error messages actionable.

Three paths in priority order:

1. **`CK_COOKIES` env var** — full Cookie header. Caller parses the embedded `CKAT=<accessJWT>%3B<refreshJWT>` to extract both JWTs. Unchanged from pre-fetchproxy behavior.
2. **Cached session via `ck_set_session`** — that tool persists to `.env` as `CK_COOKIES`, so subsequent runs collapse into path 1. Stays for power users who want to paste a cookie header rather than install the extension.
3. **fetchproxy fallback** — `@fetchproxy/bootstrap` (0.3.0+) spins up a one-shot WebSocket bridge to the fetchproxy extension and reads the HttpOnly `CKAT` + `CKTRKID` cookies on creditkarma.com via `chrome.cookies.get`. Returns once. Subsequent CK API calls (GraphQL + `/member/oauth2/refresh`) go direct from Node — fetchproxy is NOT in the hot path.

`CK_DISABLE_FETCHPROXY=1` opts out of path 3 (turns missing creds into a hard error — useful in headless CI).

`loadAuthIntoClient(client)` is the lazy bootstrap helper used by tool handlers (currently just `sync.ts → refreshOrThrow`): when the client has no refresh token, it calls `resolveAuth()` and applies the result. `@fetchproxy/bootstrap` is mocked at the module boundary in `tests/auth.test.ts`.

## Environment

```
CK_COOKIES=<value>          # Optional. Full Cookie header from a signed-in creditkarma.com request. The runtime parser also accepts a bare CKAT value or `CKAT=<value>` for legacy callers. Capture via `ck_set_session` or just install the fetchproxy extension and skip this.
CK_DISABLE_FETCHPROXY=1|true # Optional. Skip the fetchproxy browser-extension fallback (missing creds become a hard error — useful in headless CI).
CK_DB_PATH=<path>           # Path to SQLite database. Default: ~/.creditkarma-mcp/transactions.db
```

## Testing

Tests live in `tests/`. Run with `npm test`. No real API calls — client is mocked.

## Plugin / Marketplace

```
.claude-plugin/
  plugin.json       # Claude Code plugin manifest (MCP server config + skill reference)
  marketplace.json  # Marketplace catalog entry
SKILL.md            # Claude Code skill — teaches Claude when/how to use the tools
```

<!-- pr-workflow:v2 -->
## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* skip auto-generated release notes — GitHub's `generate_release_notes` (configured in `.github/release.yml`) only picks up merged PRs. Push directly to `main` only when the user explicitly asks for it (e.g. emergency hotfix).

For every PR, apply exactly one label so it lands in the right release-notes section:

| Label                | Section in release notes |
|----------------------|--------------------------|
| `enhancement`        | Features                 |
| `bug`                | Bug Fixes                |
| `security`           | Security                 |
| `refactor`           | Refactor                 |
| `documentation`      | Documentation            |
| `test`               | Tests                    |
| `dependencies`       | Dependencies             |
| `ci` / `github_actions` | CI & Build            |
| *(none / unmatched)* | Other Changes            |
| `ignore-for-release` | Hidden from notes        |

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/bootstrap` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

The **PR title MUST be a Conventional Commit**, written user-facing (`fix(scope): …`, `feat(scope): …`), not internal shorthand. Because the repo squash-merges, the PR title *becomes the squash commit's subject line* — the only thing release-please parses to pick the version bump and changelog section. Only `feat` (minor), `fix` (patch), and `!`/`BREAKING CHANGE` (major) cut a release; `perf`/`refactor`/`docs`/`revert` show in the changelog without bumping; `ci`/`test`/`build`/`chore` are recognised but hidden (see `release-please-config.json` → `changelog-sections`). A title without a conventional type is invisible to release-please — no bump, no changelog line. Prefixes in *individual commits* don't help; squash keeps only the title.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). On a `pass` **or** `warn` verdict it adds the `ready-to-merge` label; `warn` and `fail` also open/update an `auto-review-followup` issue capturing the findings. Only `fail` blocks the merge.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. `pass`/`warn` arm auto-merge for you; if Claude's verdict was `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

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

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a `chore(main): release X.Y.Z` PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR (arm `ready-to-merge`) creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { db } from './db.js'`).
- **CKAT auto-refresh**: the bearer-token lifecycle is owned by the shared `TokenManager` (`@chrischall/mcp-utils/session`) — proactive refresh inside its skew window, one reactive HTTP-401 replay, and a single-flight semaphore that coalesces concurrent refreshes into ONE `/member/oauth2/refresh` POST. The access token's TTL window is `TOKEN_TTL_MS` (~10 min) in `src/client.ts`; the refresh callback wraps CK's native `doRefreshAccessToken()` POST. Because CK's PRIMARY expired-token signal is a 200 body carrying an auth `errorCode` (not an HTTP 401), that GraphQL-errorCode path is mapped to `TOKEN_EXPIRED` in `parseTransactionPage` and reactively refreshed by the sync loop (`src/tools/sync.ts`) — the manager's reactive replay is HTTP-status-based and can't see GraphQL bodies. When the refresh token is expired, the server logs a startup warning and `ck_set_session` refuses to save stale credentials — sign back into creditkarma.com (fetchproxy path) or paste a fresh Cookie header.
- **Sync strategy**: incremental by default — fetches since last sync date with a 30-day overlap. Use `force_full: true` to re-fetch everything.
- **Resume on failure**: `ck_sync_transactions` saves `last_cursor` to `sync_state` if a page fetch fails, so the next sync resumes from the same cursor. The cursor is cleared on success.
- **Read-only SQL**: `ck_query_sql` only permits SELECT (including `WITH ... SELECT` CTEs) — no writes. Validation is comment-stripped before the `^(WITH|SELECT)` regex check, and execution runs under `PRAGMA query_only = 1` (restored in `finally`) so a CTE-wrapped write (`WITH ... INSERT`) fails with SQLITE_READONLY. `node:sqlite`'s `prepare()` only compiles the first statement, so trailing statements never execute.
- **Amounts**: negative = expense/debit, positive = credit/income.
- **Empty `account.id` from CK**: `transactionsHub` returns `""` for every `account.id`, even across multi-account responses. `src/accountId.ts` synthesizes `<trimmed-providerName>|<last-4-from-display>` (e.g. `Citi|2630`) so each account gets a stable row. `backfillAccountIds()` runs once on server startup to repair legacy DB rows from `raw_json`. Caveat: the same physical card under two `providerName` strings (e.g. `"Capital One"` vs `"Capital One - Credit Cards"`) appears as two synthetic accounts — acceptable since there's no canonical provider source.
- **GraphQL quirk**: transactions are fetched via Credit Karma's internal GraphQL API, not a public API. The query is in `src/transaction.graphql` and must be copied to `dist/` at build time (`npm run build` handles this; `tsc` alone does not).
- **Build before run**: `dist/` must exist before running the server manually. `npm run build` runs `tsc` + copies `transaction.graphql` + bundles via esbuild into `dist/bundle.js` (the MCPB/manifest entry point).
- **stdio transport**: the server logs warnings to **stderr** only — stdout is reserved for JSON-RPC. `dotenv` is loaded with `quiet: true` for the same reason.
- **Persisted credentials**: `persistSession()` (in `src/tools/auth.ts`) writes `.env` at mode 0600. Anything else handling secrets in this repo should match. The fetchproxy path doesn't persist anything — cookies are read into memory once per MCP run.
- **Coverage**: `vitest.config.ts` enforces 100% line/branch/function/statement coverage on `src/**` (excluding `src/index.ts`). Failing coverage fails CI.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
