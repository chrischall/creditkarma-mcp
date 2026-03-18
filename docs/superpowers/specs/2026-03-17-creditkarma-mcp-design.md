# Credit Karma MCP — Design Spec

**Date:** 2026-03-17
**Project:** `creditkarma-mcp`
**Repo:** `chrischall/creditkarma-mcp`
**Location:** `/Users/chris/git/creditkarma-mcp`

---

## Overview

An MCP server that authenticates with Credit Karma, exports transactions, stores them in a local SQLite database, and exposes tools for syncing and querying. Modeled after `ofw-mcp` in structure, tooling, and conventions.

---

## Architecture

### Tech Stack

- **Language:** TypeScript (strict, ES2022)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Transport:** stdio (subprocess)
- **Database:** `better-sqlite3` (synchronous, zero-config)
- **Testing:** Vitest, 100% coverage threshold
- **Runtime:** Node.js 18+
- **Build:** TypeScript compiler → `dist/`

### Project Structure

```
creditkarma-mcp/
├── src/
│   ├── index.ts            # MCP server entry point, registers all tools
│   ├── client.ts           # CreditKarma GraphQL + auth client
│   ├── db.ts               # SQLite schema, migrations, upsert helpers
│   └── tools/
│       ├── auth.ts         # ck_login, ck_submit_mfa, ck_set_token
│       ├── sync.ts         # ck_sync_transactions
│       ├── query.ts        # ck_list_transactions, ck_get_spending_by_category,
│       │                   #   ck_get_spending_by_merchant, ck_get_account_summary,
│       │                   #   ck_get_recent_transactions
│       └── sql.ts          # ck_query_sql
├── tests/
│   ├── client.test.ts
│   ├── db.test.ts
│   └── tools/
│       ├── auth.test.ts
│       ├── sync.test.ts
│       ├── query.test.ts
│       └── sql.test.ts
├── .mcp.json               # MCP server config with env vars
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Data Model

SQLite database stored at path from `CK_DB_PATH` env var, defaulting to `~/.creditkarma-mcp/transactions.db`.

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT,
  provider_name TEXT,
  display      TEXT
);

CREATE TABLE categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT
);

CREATE TABLE merchants (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE transactions (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,       -- YYYY-MM-DD
  description TEXT NOT NULL,
  status      TEXT,
  amount      REAL NOT NULL,       -- negative = debit, positive = credit
  account_id  TEXT REFERENCES accounts(id),
  category_id TEXT REFERENCES categories(id),
  merchant_id TEXT REFERENCES merchants(id),
  raw_json    TEXT,                -- full API response blob
  synced_at   TEXT DEFAULT CURRENT_TIMESTAMP,  -- when first seen
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP   -- updated on every upsert
);

CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
-- keys: last_sync_date (YYYY-MM-DD), last_cursor (pagination resume point)
);
```

**Upsert strategy:** `INSERT INTO ... ON CONFLICT(id) DO UPDATE SET ...` — handles status/amount/cancellation changes when re-fetched while preserving `synced_at` (original first-seen time). `updated_at` is set on every upsert.

---

## Authentication Flow

Credit Karma tokens expire in ~10 minutes. Three mechanisms are supported:

### 1. Env var (startup)
`CK_TOKEN` in `.mcp.json` / `.env` is read at server start. Also accepts `CK_USERNAME` and `CK_PASSWORD` for auto-login.

### 2. `ck_login` + `ck_submit_mfa` (interactive)
Two-step tool flow:
1. `ck_login(username?, password?)` — submits credentials to CK auth API, caches challenge state in memory, returns `"MFA code sent to [redacted] — call ck_submit_mfa with your code"`
2. `ck_submit_mfa(code)` — submits MFA code, receives bearer token, persists it (same as `ck_set_token`)

`username`/`password` args are optional if `CK_USERNAME`/`CK_PASSWORD` env vars are set.

### 3. `ck_set_token` (manual fallback)
Accepts a raw bearer token, updates in-memory state, and writes `CK_TOKEN` to `.mcp.json`.

### Auto-trigger
Any tool that requires API access (`ck_sync_transactions`) checks for a valid token before proceeding. If no token is present or the token is expired, it automatically initiates the login flow — prompting the user to call `ck_submit_mfa` with the challenge code.

### Token Discovery Note
The CK login/MFA API endpoints are not publicly documented. During implementation, these must be reverse-engineered from browser network traffic (Network tab on `creditkarma.com`). This is a required discovery step before `client.ts` auth methods can be implemented.

---

## Tools (11 total)

### Auth tools (`src/tools/auth.ts`)

| Tool | Args | Returns | Description |
|---|---|---|---|
| `ck_login` | `username?`, `password?` | `"MFA code sent to [redacted] — call ck_submit_mfa with your code"` | Initiates login, caches challenge state in memory, triggers MFA challenge |
| `ck_submit_mfa` | `code` | `"Authenticated successfully. Token saved."` | Completes MFA, persists token via `ck_set_token` logic |
| `ck_set_token` | `token` | `"Token set successfully."` (+ warning if `.mcp.json` not found) | Manual token paste, applies in memory, persists to `.mcp.json` |

### Sync tools (`src/tools/sync.ts`)

| Tool | Args | Returns | Description |
|---|---|---|---|
| `ck_sync_transactions` | `force_full?: boolean` | `{ new: number, updated: number, total: number }` | Syncs transactions; if no valid token, calls `ck_login()` internally and returns a message prompting the user to call `ck_submit_mfa` |

### Query tools (`src/tools/query.ts`)

| Tool | Args | Returns | Description |
|---|---|---|---|
| `ck_list_transactions` | `start_date?`, `end_date?`, `account?`, `category?`, `merchant?`, `status?`, `min_amount?`, `max_amount?`, `limit?` (default 50), `offset?` | `{ transactions: TransactionRow[], total: number, offset: number, limit: number }` | Paginated, filtered transaction list |
| `ck_get_spending_by_category` | `start_date?`, `end_date?`, `account?` | `{ rows: Array<{ category: string, total: number, count: number }> }` | Grouped debit totals by category, descending |
| `ck_get_spending_by_merchant` | `start_date?`, `end_date?`, `category?`, `limit?` (default 25) | `{ rows: Array<{ merchant: string, total: number, count: number }> }` | Top merchants by total debit spend |
| `ck_get_account_summary` | `start_date?`, `end_date?` | `{ rows: Array<{ account: string, debits: number, credits: number, net: number, count: number }> }` | Per-account totals |
| `ck_get_recent_transactions` | `limit?` (default 25) | Same as `ck_list_transactions` | Last N transactions ordered by date desc |

Where `TransactionRow` is:
```typescript
interface TransactionRow {
  id: string; date: string; description: string; status: string
  amount: number; account: string; category: string; merchant: string
}
```

### Power user (`src/tools/sql.ts`)

| Tool | Args | Returns | Description |
|---|---|---|---|
| `ck_query_sql` | `sql` | `{ rows: Record<string, unknown>[], count: number }` | Raw SQL SELECT only; non-SELECT statements are rejected with an error |

---

## Client (`src/client.ts`)

TypeScript port of the Ruby export script's GraphQL logic.

```typescript
class CreditKarmaClient {
  setToken(token: string): void
  getToken(): string | null
  isTokenExpired(): boolean         // best-effort: tracks set time, assumes ~10min TTL
  fetchPage(afterCursor?: string): Promise<TransactionPage>
  login(username: string, password: string): Promise<void>  // stores challenge state
  submitMfa(code: string): Promise<string>                   // returns bearer token
}
```

**Error handling:**
- 401: surface `TOKEN_EXPIRED` error with instructions to call `ck_login` or `ck_set_token`
- 429: exponential backoff, one retry

**GraphQL endpoint:** `https://api.creditkarma.com/graphql`

---

## Sync Logic (`src/tools/sync.ts`)

```
1. Check token validity → auto-trigger login flow if needed
2. Read last_sync_date from sync_state
3. If force_full=true OR no prior sync: fetch all pages from beginning
4. Otherwise: fetch pages until transaction.date < (last_sync_date - 30 days)
   — the 30-day window catches status/amount/cancellation changes on recent txns
5. Upsert: accounts → categories → merchants → transactions (in dependency order)
6. Write last_sync_date = today to sync_state
7. Return { new: N, updated: N, total: N }
```

---

## Configuration

### `.mcp.json`
```json
{
  "mcpServers": {
    "creditkarma": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "CK_TOKEN": "",
        "CK_USERNAME": "",
        "CK_PASSWORD": "",
        "CK_DB_PATH": ""
      }
    }
  }
}
```

### `.env.example`
```
CK_TOKEN=           # Bearer token (manual or auto-set by ck_set_token)
CK_USERNAME=        # Optional: used by ck_login if args not provided
CK_PASSWORD=        # Optional: used by ck_login if args not provided
CK_DB_PATH=         # Optional: defaults to ~/.creditkarma-mcp/transactions.db
```

---

## Testing Strategy

Mirrors ofw-mcp: 100% coverage via Vitest. All HTTP calls mocked. SQLite tests use an in-memory database (`:memory:`).

Key test areas:
- `client.test.ts`: token lifecycle, 401/429 handling, GraphQL request shape, MFA flow
- `db.test.ts`: schema creation, migrations, upsert idempotency (same tx twice → no duplicate)
- `tools/auth.test.ts`: all three auth paths, token persistence to `.mcp.json`
- `tools/sync.test.ts`: incremental window logic, force_full, upsert counts, auto-login trigger
- `tools/query.test.ts`: filter combinations, pagination, correct SQL generation
- `tools/sql.test.ts`: SELECT allowed, non-SELECT blocked, SQL injection via parameterization

---

## `db.ts` Public Interface

```typescript
// Schema creation + incremental migrations
export function initDb(dbPath: string): Database

// Upsert helpers (used by sync.ts)
export function upsertAccount(db: Database, account: AccountRow): void
export function upsertCategory(db: Database, category: CategoryRow): void
export function upsertMerchant(db: Database, merchant: MerchantRow): void
export function upsertTransaction(db: Database, tx: TransactionRow): void

// Sync state
export function getSyncState(db: Database, key: string): string | null
export function setSyncState(db: Database, key: string, value: string): void
```

**Migration strategy:** On `initDb()`, read current `schema_version`. For each version step from current to latest, run the corresponding migration SQL in a transaction. Safe to call on every server start.

**Upsert semantics:** Uses `INSERT INTO ... ON CONFLICT(id) DO UPDATE SET ...` (SQLite UPSERT syntax) rather than `INSERT OR REPLACE`. This preserves `synced_at` (original sync time) on subsequent upserts. `synced_at` reflects when the transaction was *first* seen; a separate `updated_at` column (set on every upsert) tracks the most recent sync.

**Startup:** `initDb()` creates the parent directory if it doesn't exist before opening the database file.

---

## Client Types

```typescript
interface TransactionPage {
  transactions: ApiTransaction[]
  pageInfo: {
    startCursor: string
    endCursor: string
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

interface ApiTransaction {
  id: string
  date: string                  // YYYY-MM-DD
  description: string
  status: string
  amount: { value: number; asCurrencyString: string }  // negative = debit, positive = credit (API convention)
  account: { id: string; name: string; type: string; providerName: string; accountTypeAndNumberDisplay: string }
  category: { id: string; name: string; type: string }
  merchant: { id: string; name: string }
}
```

**Amount sign convention:** The CK API returns negative values for debits and positive for credits. The client passes these through as-is; the `transactions.amount` column preserves the sign. Query tools display absolute values and label the sign as debit/credit where needed.

---

## Open Questions / Implementation Notes

1. **CK login API endpoints + MFA flow** must be reverse-engineered from browser network traffic before auth implementation can begin. This is equally high-risk as item 2.
2. **CK GraphQL query shape** must be extracted from the existing Ruby script (`/Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions`) and verified against a live session. The full query with fragments lives in that file.
3. **Token expiry detection** is best-effort — track the time `setToken` was last called and treat tokens as expired after 10 minutes. The CK API returns 401 on expiry regardless.
4. **`ck_set_token` persistence** reads `.mcp.json` from the working directory, patches the `mcpServers.creditkarma.env.CK_TOKEN` key using `JSON.parse` / `JSON.stringify`, and writes it back. If `.mcp.json` doesn't exist or the expected key path is absent, the token is still applied in memory and a warning is logged.
5. **Auto-login on token expiry:** When `ck_sync_transactions` detects no valid token, it must internally call the equivalent of `ck_login()` (which sends the MFA challenge) and return a message instructing the user to call `ck_submit_mfa` with the code. Simply detecting expiry and returning an error is not sufficient — the challenge must be actively initiated.
6. **`last_cursor` in sync_state** is reserved for resume-on-expiry mid-sync: if a sync fails partway through due to a 401, the cursor at the point of failure is saved. On the next sync attempt, if `last_cursor` is present, the sync resumes from that cursor rather than refetching already-processed pages. Cleared on successful sync completion.
7. **Denormalized vs. normalized lookup tables:** `categories` and `merchants` are kept as separate tables to support clean `GROUP BY` joins in the spending tools. This adds modest schema complexity but simplifies query logic.
