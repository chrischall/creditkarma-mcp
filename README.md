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
        "CK_COOKIES": "your-ckat-value-here"
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

Launches Chrome with a dedicated profile at `~/.creditkarma-mcp/chrome-profile`, waits for you to sign in at creditkarma.com, then captures the full Cookie header (including the `CKAT` cookie that holds the access + refresh JWTs). Either prints it (for pasting into Claude Desktop / MCPB) or writes it to the env file you pass. Requires Google Chrome installed locally; the script installs `puppeteer-core` on first run (~1 MB).

#### Option B — manual (DevTools)

1. Log in to [creditkarma.com](https://www.creditkarma.com) in Chrome
2. Open DevTools → **Application** → **Cookies** → `https://www.creditkarma.com`
3. Find the `CKAT` cookie and copy its value

### Setting credentials

Either of these works:

- Paste the value from `npm run auth` (or your CKAT cookie) into `CK_COOKIES` in your `.env` or Claude config
- Or call `ck_set_session` from within Claude with the cookie value — it accepts any of:

| Format | Example |
|--------|---------|
| Raw CKAT value | `eyJraWQ...%3BeyJraWQ...` |
| `CKAT=<value>` | `CKAT=eyJraWQ...%3BeyJraWQ...` |
| Full Cookie header | *(what `npm run auth` prints)* |

The server automatically extracts both the access token and refresh token from the CKAT cookie, and refreshes the access token as needed.

### Session expiry

- **Access token**: ~15 minutes (auto-refreshed transparently)
- **Refresh token**: ~8 hours
- When the refresh token expires, re-run `npm run auth` (or grab the new CKAT cookie from DevTools) and either update `CK_COOKIES` or call `ck_set_session`

## Available tools

| Tool | What it does |
|------|-------------|
| `ck_set_session` | Store credentials from your browser cookies (auto-extracts tokens from CKAT) |
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
| `CK_COOKIES` | CKAT value, `CKAT=<value>`, or full Cookie header | *(required)* |
| `CK_DB_PATH` | Path to SQLite database file | `~/.creditkarma-mcp/transactions.db` |

## Troubleshooting

**"TOKEN_EXPIRED"** — your refresh token has expired. Re-run `npm run auth` (or grab a new CKAT cookie) and update `CK_COOKIES` or call `ck_set_session`.

**Sync returns 0 transactions** — check that your `CK_COOKIES` value is fresh. CKAT cookies expire after ~8 hours.

**Tools not appearing** — fully quit and relaunch Claude Desktop. In Claude Code, run `/mcp` to check server status.

**"No such file or directory: dist/transaction.graphql"** — run `npm run build` (not just `tsc`).

## Security

- Credentials are stored only in your local `.env` file (gitignored) or Claude config
- The server never logs credentials
- Only SELECT queries are permitted via `ck_query_sql` — no writes to Credit Karma

## Development

```bash
npm test            # run the test suite
npm run build       # compile TypeScript → dist/
npm run test:watch  # watch mode
```

### Project structure

```
src/
  client.ts             Credit Karma GraphQL client with auto-refresh
  index.ts              MCP server entry point
  db.ts                 SQLite schema and upsert helpers
  transaction.graphql   GraphQL query for transactions
  tools/
    auth.ts             ck_set_session
    sync.ts             ck_sync_transactions
    query.ts            ck_list_transactions, ck_get_recent_transactions, etc.
    sql.ts              ck_query_sql
tests/
  client.test.ts
  db.test.ts
  tools/
    auth.test.ts
    sync.test.ts
    query.test.ts
    sql.test.ts
```

## License

MIT
