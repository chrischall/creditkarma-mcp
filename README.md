# Credit Karma MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to [Credit Karma](https://www.creditkarma.com), giving you natural-language access to your transactions, spending patterns, and account summaries.

> [!WARNING]
> **AI-developed project.** This codebase was entirely built and is actively maintained by [Claude Code](https://www.anthropic.com/claude). No human has audited the implementation. Review all code and tool permissions before use.

## What you can do

Ask Claude things like:

- *"Sync my latest transactions"*
- *"What did I spend on food last month?"*
- *"Show me my top merchants this year"*
- *"How much did I spend in March compared to February?"*
- *"Which accounts have the most activity?"*
- *"Run a SQL query against my transactions"*

## Requirements

- [Claude Desktop](https://claude.ai/download) or [Claude Code](https://claude.ai/code)
- [Node.js](https://nodejs.org) 18 or later
- A Credit Karma account
- [Google Chrome](https://www.google.com/chrome/) — used once for the scripted auth flow (optional; you can copy the cookie manually instead)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/chrischall/creditkarma-mcp.git
cd creditkarma-mcp
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
# See "Authentication" below to get your CK_COOKIES value
```

### 3. Add to Claude

**Claude Code** — add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "creditkarma": {
      "command": "node",
      "args": ["/absolute/path/to/creditkarma-mcp/dist/index.js"]
    }
  }
}
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "creditkarma": {
      "command": "node",
      "args": ["/absolute/path/to/creditkarma-mcp/dist/index.js"],
      "env": {
        "CK_COOKIES": "CKTRKID=...; CKAT=eyJ...%3BeyJ...; ..."
      }
    }
  }
}
```

### 4. Restart Claude

Fully quit and relaunch. Then ask: *"Sync my Credit Karma transactions"*.

## Authentication

Credit Karma uses short-lived JWTs. This server handles automatic token refresh — you only need to set up credentials once (or when your session expires).

### Getting your credentials

#### Option A — scripted (recommended)

```bash
npm run auth               # prints the Cookie header to the console
npm run auth -- .env       # writes CK_COOKIES=<header> to .env
```

Launches Chrome with a dedicated profile at `~/.creditkarma-mcp/chrome-profile`, waits for you to sign in at creditkarma.com, then captures the full session Cookie header (CKAT carries the access + refresh JWTs; CKTRKID and friends are needed by the refresh endpoint). Either prints it (for pasting into Claude Desktop / MCPB) or writes it to the env file you pass at mode 0600 (owner-only). Requires Google Chrome installed locally; on first run the script installs `puppeteer-core`, `puppeteer-extra`, and `puppeteer-extra-plugin-stealth` (a few MB, not added to `package.json`).

#### Option B — manual paste (secure prompt)

```bash
npm run auth -- --manual           # prompts for the cookie, prints CK_COOKIES
npm run auth -- --manual .env      # prompts for the cookie, writes to .env
```

Use this if the scripted flow hits Intuit/Akamai bot detection (sign-in returns "A technical issue has unexpectedly occurred"). Grab the Cookie header from your normal Chrome (Option C below), then paste it at the prompt. Input is **not echoed** — paste, press Enter.

#### Option C — manual (DevTools)

1. Log in to [creditkarma.com](https://www.creditkarma.com) in Chrome
2. Open DevTools → **Network** → click any request to creditkarma.com → **Request Headers**
3. Right-click the `cookie` header → **Copy value**

### Setting credentials

Either of these works:

- Paste the value from `npm run auth` into `CK_COOKIES` in your `.env` or Claude config
- Or call `ck_set_session` from within Claude with the Cookie header value

The server extracts the access and refresh JWTs from the `CKAT` cookie inside the header and refreshes the access token automatically as needed.

### Session expiry

- **Access token**: ~15 minutes (auto-refreshed transparently)
- **Refresh token**: ~8 hours
- When the refresh token expires, re-run `npm run auth` (or grab a fresh Cookie header from DevTools) and either update `CK_COOKIES` or call `ck_set_session`

## Available tools

| Tool | What it does |
|------|-------------|
| `ck_set_session` | Store credentials from your browser Cookie header (auto-extracts JWTs from the CKAT cookie) |
| `ck_sync_transactions` | Sync transactions into the local SQLite database |
| `ck_list_transactions` | List transactions with filters (date, account, category, merchant, amount) |
| `ck_get_recent_transactions` | Fetch the N most recent transactions |
| `ck_get_spending_by_category` | Spending totals grouped by category |
| `ck_get_spending_by_merchant` | Spending totals grouped by merchant |
| `ck_get_account_summary` | Transaction counts and totals by account |
| `ck_query_sql` | Run a read-only SQL query against the local database |

## How it works

Transactions are synced from Credit Karma's GraphQL API into a local SQLite database (default: `~/.creditkarma-mcp/transactions.db`). All query tools run against this local database — fast, offline-capable, and queryable with SQL.

**Sync strategy**: incremental by default (fetches since last sync date with a 30-day overlap for updates). Use `force_full: true` to re-fetch everything.

**Auto-refresh**: if the access token has expired, the server automatically refreshes it before syncing. If the refresh token has also expired, it throws an error asking you to re-authenticate.

## Database schema

```sql
transactions (id, date, description, status, amount, account_id, category_id, merchant_id, raw_json)
accounts     (id, name, type, provider_name, display)
categories   (id, name, type)
merchants    (id, name)
sync_state   (key, value)
```

## Configuration

| Env var | Description | Default |
|---------|-------------|---------|
| `CK_COOKIES` | Full Cookie header from a signed-in creditkarma.com request | *(required)* |
| `CK_DB_PATH` | Path to SQLite database file | `~/.creditkarma-mcp/transactions.db` |

## Troubleshooting

**"TOKEN_EXPIRED"** — your refresh token has expired. Re-run `npm run auth` (or grab a fresh Cookie header) and update `CK_COOKIES` or call `ck_set_session`.

**Sync returns 0 transactions** — check that your `CK_COOKIES` value is fresh. The refresh token inside the CKAT cookie expires after ~8 hours.

**Tools not appearing** — fully quit and relaunch Claude Desktop. In Claude Code, run `/mcp` to check server status.

**"No such file or directory: dist/transaction.graphql"** — run `npm run build` (not just `tsc`).

## Security

- Credentials are stored only in your local `.env` file (gitignored) or Claude config
- `.env` is written at mode 0600 (owner read/write only) by both `npm run auth` and `ck_set_session`
- `ck_set_session` refuses to save a refresh token whose JWT `exp` is already in the past — prevents stale credentials from polluting `.env`
- The server never logs credentials; warnings go to stderr only (stdout is reserved for the MCP JSON-RPC stream)
- Only `SELECT` queries are permitted via `ck_query_sql` — no writes to Credit Karma; the underlying `node:sqlite` `prepare()` also rejects multi-statement input

## Development

```bash
npm test               # run the test suite (vitest)
npm run build          # compile TypeScript → dist/, copy transaction.graphql, bundle for MCPB
npm run test:watch     # watch mode
npm run test:coverage  # coverage report (CI enforces 100% on src/**)
```

Versions are bumped automatically by the **Tag & Bump** GitHub Action (`.github/workflows/tag-and-bump.yml`). Do not bump manually.

### Pull requests

Changes land via PR, including for solo work — release notes are generated from merged PRs only (config in `.github/release.yml`). Apply one of these labels to every PR: `enhancement`, `bug`, `security`, `refactor`, `documentation`, `test`, `dependencies`, `ci`, or `ignore-for-release` (excludes from notes). The PR title becomes the changelog bullet, so write it like a user-facing entry.

### Project structure

```
src/
  client.ts             Credit Karma GraphQL client (auto-refresh, JWT helpers, cookie parser)
  index.ts              MCP server entry point; bootstraps tokens from CK_COOKIES
  db.ts                 SQLite schema, migrations, and upsert helpers
  transaction.graphql   GraphQL query for transactions (copied to dist/ at build time)
  tools/
    auth.ts             ck_set_session — refuses stale refresh tokens, writes .env at 0600
    sync.ts             ck_sync_transactions — incremental sync with resume-on-failure
    query.ts            ck_list_transactions, ck_get_recent_transactions,
                        ck_get_spending_by_category, ck_get_spending_by_merchant,
                        ck_get_account_summary
    sql.ts              ck_query_sql — SELECT-only escape hatch
scripts/
  setup-auth.mjs        npm run auth — Puppeteer flow + manual paste fallback
tests/
  helpers.ts            Shared test helpers (fakeServer, makeJwt)
  client.test.ts
  db.test.ts
  setup-auth.test.ts
  tools/
    auth.test.ts
    sync.test.ts
    query.test.ts
    sql.test.ts
```

## License

MIT
