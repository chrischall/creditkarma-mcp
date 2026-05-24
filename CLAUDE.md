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

The **PR title** becomes the bullet — write it like a user-facing changelog entry (`ck_set_session: refuse stale refresh tokens`), not internal shorthand (`auth tweaks`). Conventional-commit prefixes (`feat:`, `fix:`, `chore:`) are still fine in commit messages, but the PR title should read clean.

### How PRs merge

**Do not manually merge PRs — including the release-please release PR.** Open with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line). That is the whole job. Do **not** run `gh pr merge --auto --squash` yourself.

The automation handles the rest:

1. `pr-auto-review.yml` runs a Claude review on every PR. On a `pass` verdict it adds the `ready-to-merge` label.
2. `release-please.yml` adds the `ready-to-merge` label to its own release PR automatically.
3. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash` for you. The moment CI is green the PR squash-merges itself.

If Claude's review verdict was `warn` or `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`. The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

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
7. `.claude-plugin/marketplace.json` → `plugins[].version` (and outer `version`)

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Tag & Bump** GitHub Action (`.github/workflows/tag-and-bump.yml`).

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Tag & Bump** GitHub Action which:

1. Runs CI (build + test)
2. Tags the current commit with the current version
3. Bumps patch via `npm version patch` + a node script that walks every JSON version field
4. Rebuilds, commits, and pushes main + tag
5. The tag push triggers the **Release** workflow (CI + npm publish + GitHub release)

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { db } from './db.js'`).
- **CKAT auto-refresh**: access token (~15 min, `TOKEN_TTL_MS` in `src/client.ts`) is refreshed automatically using the refresh token (~8 hours). When the refresh token is expired, the server logs a startup warning and `ck_set_session` refuses to save stale credentials — sign back into creditkarma.com (fetchproxy path) or paste a fresh Cookie header.
- **Sync strategy**: incremental by default — fetches since last sync date with a 30-day overlap. Use `force_full: true` to re-fetch everything.
- **Resume on failure**: `ck_sync_transactions` saves `last_cursor` to `sync_state` if a page fetch fails, so the next sync resumes from the same cursor. The cursor is cleared on success.
- **Read-only SQL**: `ck_query_sql` only permits SELECT — no writes. Validation is comment-stripped before the SELECT regex check; `node:sqlite`'s `prepare()` itself rejects multi-statement input.
- **Amounts**: negative = expense/debit, positive = credit/income.
- **Empty `account.id` from CK**: `transactionsHub` returns `""` for every `account.id`, even across multi-account responses. `src/accountId.ts` synthesizes `<trimmed-providerName>|<last-4-from-display>` (e.g. `Citi|2630`) so each account gets a stable row. `backfillAccountIds()` runs once on server startup to repair legacy DB rows from `raw_json`. Caveat: the same physical card under two `providerName` strings (e.g. `"Capital One"` vs `"Capital One - Credit Cards"`) appears as two synthetic accounts — acceptable since there's no canonical provider source.
- **GraphQL quirk**: transactions are fetched via Credit Karma's internal GraphQL API, not a public API. The query is in `src/transaction.graphql` and must be copied to `dist/` at build time (`npm run build` handles this; `tsc` alone does not).
- **Build before run**: `dist/` must exist before running the server manually. `npm run build` runs `tsc` + copies `transaction.graphql` + bundles via esbuild into `dist/bundle.js` (the MCPB/manifest entry point).
- **stdio transport**: the server logs warnings to **stderr** only — stdout is reserved for JSON-RPC. `dotenv` is loaded with `quiet: true` for the same reason.
- **Persisted credentials**: `persistSession()` (in `src/tools/auth.ts`) writes `.env` at mode 0600. Anything else handling secrets in this repo should match. The fetchproxy path doesn't persist anything — cookies are read into memory once per MCP run.
- **Coverage**: `vitest.config.ts` enforces 100% line/branch/function/statement coverage on `src/**` (excluding `src/index.ts`). Failing coverage fails CI.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
