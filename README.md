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
- For the no-env-var path: the [fetchproxy 0.3.0 Chrome / Safari extension](https://github.com/chrischall/fetchproxy)

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own Credit Karma account.** Every request is dispatched through your own signed-in browser tab via the fetchproxy extension. **You** are the one logged in. It does not — and cannot — access anyone else's account.

**2. [Credit Karma's Terms](https://www.creditkarma.com/about/terms) govern your use of this server**, just as they govern your direct use of creditkarma.com. The clauses most relevant here:

> You must not sell, transfer, or assign your account to anyone else… you may not allow anyone else to log into our Services as you.

CK does contemplate third-party data retrieval at the user's direction (Section 3.7). There is no explicit anti-scraping clause in the membership agreement; Section 4.1 restricts copying or distributing CK content without express prior written consent.

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server. Critically: this server runs **as you**, not as a third party logging in on your behalf. You direct the tool.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with Intuit, Credit Karma, or any financial institution. It is a personal automation tool that reads your transaction history, spending categories, and account snapshots — the same data Credit Karma already shows you in their app. Do not use it on someone else's account, do not redistribute their content, and do not use it to make trading or lending decisions on behalf of others.

**4. This server may break.** Credit Karma rotates its internal endpoints; what works today may 404 tomorrow. This is the nature of unofficial integrations.

**5. You accept full responsibility** for any consequences of using this server in connection with your Credit Karma account — rate limiting, account warnings, suspension, or any enforcement action Intuit takes. If Credit Karma objects to your use, stop using this server. **Do not commit your `.env` to git** — your CK session/auth artifacts are credentials, and the Membership Agreement holds you responsible for their confidentiality.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede Credit Karma's actual Membership Agreement.

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

`creditkarma-mcp` tries three auth paths in priority order; whichever succeeds first is used. Existing setups keep working unchanged.

1. **`CK_COOKIES` env var (legacy).** Set the full Cookie header in your Claude Desktop config or `.env`. This is the path shown in the config above.
2. **Cached session from `ck_set_session`.** Once called, the tool persists the Cookie header to `.env` as `CK_COOKIES` — so subsequent runs collapse into path 1.
3. **fetchproxy fallback (no env vars needed — easiest onboarding).** When neither is configured, the server reads `CKAT` + `CKTRKID` cookies once at startup from your already-signed-in `creditkarma.com` tab via the [fetchproxy](https://github.com/chrischall/fetchproxy) browser extension. After that one read, all CK API calls go directly from Node — the extension is **not** in the request hot path. Install the fetchproxy extension (Chrome Web Store / Safari `.dmg`), sign into [creditkarma.com](https://www.creditkarma.com), and the MCP just works.

Set `CK_DISABLE_FETCHPROXY=1` to opt out of the fallback (turns missing credentials into a hard error — useful in headless CI).

### Getting your credentials (env-var path)

#### Option A — fetchproxy extension (recommended)

1. Install the [fetchproxy 0.3.0 extension](https://github.com/chrischall/fetchproxy) (Chrome Web Store or Safari `.dmg`).
2. Sign into [creditkarma.com](https://www.creditkarma.com) in that browser.
3. Leave `CK_COOKIES` **unset** in your Claude config.

The MCP reads the HttpOnly `CKAT` + `CKTRKID` cookies via `chrome.cookies.get` on the first tool call, then operates direct-to-API from Node. To re-auth (e.g. after Credit Karma signs you out), just sign back in to creditkarma.com.

#### Option B — manual (DevTools)

1. Log in to [creditkarma.com](https://www.creditkarma.com) in Chrome
2. Open DevTools → **Network** → click any request to creditkarma.com → **Request Headers**
3. Right-click the `cookie` header → **Copy value**

Then either paste into `CK_COOKIES` in your Claude config / `.env`, or call `ck_set_session` from within Claude with the Cookie header value.

The server extracts the access and refresh JWTs from the `CKAT` cookie inside the header and refreshes the access token automatically as needed.

### Session expiry

- **Access token**: ~15 minutes (auto-refreshed transparently)
- **Refresh token**: ~8 hours
- When the refresh token expires:
  - **fetchproxy path:** sign back into creditkarma.com — the MCP re-reads fresh cookies on the next tool call.
  - **env-var path:** grab a fresh Cookie header from DevTools and update `CK_COOKIES` (or call `ck_set_session`).

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
| `CK_COOKIES` | Full Cookie header from a signed-in creditkarma.com request | *(unset — falls back to fetchproxy)* |
| `CK_DISABLE_FETCHPROXY` | Set to `1` to skip the fetchproxy fallback (headless / CI) | *(unset)* |
| `CK_DB_PATH` | Path to SQLite database file | `~/.creditkarma-mcp/transactions.db` |

## Troubleshooting

**"CK auth: set CK_COOKIES, or call the ck_set_session MCP tool, or install the fetchproxy extension…"** — neither auth path is configured. Either fill in `CK_COOKIES` in your Claude config, or install the [fetchproxy extension](https://github.com/chrischall/fetchproxy) and sign into `creditkarma.com` in your browser.

**"TOKEN_EXPIRED"** — your refresh token has expired. Sign back into creditkarma.com (fetchproxy path) or grab a fresh Cookie header from DevTools and update `CK_COOKIES` / call `ck_set_session`.

**"fetchproxy fallback failed"** — the env-var path wasn't configured and the extension couldn't be reached. Confirm the fetchproxy extension is installed, signed into Credit Karma, and that it's running (open the extension popup). To disable the fallback, set `CK_DISABLE_FETCHPROXY=1`.

**Sync returns 0 transactions** — check that your auth is fresh. The refresh token inside the CKAT cookie expires after ~8 hours.

**Tools not appearing** — fully quit and relaunch Claude Desktop. In Claude Code, run `/mcp` to check server status.

**"No such file or directory: dist/transaction.graphql"** — run `npm run build` (not just `tsc`).

## Security

- Credentials are stored only in your local `.env` file (gitignored), Claude config, or your browser's cookie jar (fetchproxy path)
- `.env` is written at mode 0600 (owner read/write only) by `ck_set_session`
- `ck_set_session` refuses to save a refresh token whose JWT `exp` is already in the past — prevents stale credentials from polluting `.env`
- The fetchproxy path doesn't persist anything to disk — cookies are read into memory once per MCP run, directly from the user's browser via `chrome.cookies.get`
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
  auth.ts               resolveAuth() — three-path priority (CK_COOKIES env / ck_set_session cache / fetchproxy), plus loadAuthIntoClient()
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
tests/
  helpers.ts            Shared test helpers (fakeServer, makeJwt)
  auth.test.ts          resolveAuth + loadAuthIntoClient (mocks @fetchproxy/bootstrap)
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
