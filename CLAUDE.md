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
  client.ts             # Credit Karma GraphQL client with auto-refresh
  db.ts                 # SQLite schema and upsert helpers
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

## Environment

```
CK_COOKIES=<value>    # CKAT cookie value, CKAT=<value>, or full Cookie header. Optional — can use ck_set_session instead.
CK_DB_PATH=<path>     # Path to SQLite database. Default: ~/.creditkarma-mcp/transactions.db
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

## Versioning

Version appears in FOUR places — all must match:

1. `package.json` → `"version"`
2. `package-lock.json` → run `npm install --package-lock-only` after changing package.json
3. `src/index.ts` → `Server` constructor `version` field
4. `manifest.json` → `"version"`

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. Versioning is handled by the **Cut & Bump** GitHub Action.

### Release workflow

Main is always one version ahead of the latest tag. To release, run the **Cut & Bump** GitHub Action (`cut-and-bump.yml`) which:

1. Runs CI (build + test)
2. Tags the current commit with the current version
3. Bumps patch in all four files
4. Rebuilds, commits, and pushes main + tag
5. The tag push triggers the **Release** workflow (CI + npm publish + GitHub release)

## Gotchas

- **ESM + NodeNext**: imports must use `.js` extensions even for `.ts` source files (e.g. `import { db } from './db.js'`).
- **CKAT auto-refresh**: access token (~15 min) is refreshed automatically using the refresh token (~8 hours). When both expire, `ck_set_session` is required.
- **Sync strategy**: incremental by default — fetches since last sync date with a 30-day overlap. Use `force_full: true` to re-fetch everything.
- **Read-only SQL**: `ck_query_sql` only permits SELECT — no writes.
- **Amounts**: negative = expense/debit, positive = credit/income.
- **GraphQL quirk**: transactions are fetched via Credit Karma's internal GraphQL API, not a public API. The query is in `src/transaction.graphql` and must be copied to `dist/` at build time (`npm run build` handles this; `tsc` alone does not).
- **Build before run**: `dist/` must exist before running the server manually.
- **Plugin files**: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` are for Claude Code plugin distribution — not part of the MCP runtime.
