# Credit Karma MCP Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server that authenticates with Credit Karma, syncs transactions into a local SQLite database, and exposes 10 tools for auth, sync, and querying.

**Architecture:** Stdio MCP server (mirroring ofw-mcp) with a `CreditKarmaClient` class for GraphQL/auth, a `db.ts` module for SQLite via `better-sqlite3`, and tool modules in `src/tools/`. An `AppContext` struct threads the shared client and DB instance through all tool handlers.

**Tech Stack:** TypeScript 5, Node.js 18+, `@modelcontextprotocol/sdk`, `better-sqlite3`, Vitest (100% coverage)

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | MCP server entry: register tools, create AppContext, start stdio transport |
| `src/client.ts` | `CreditKarmaClient`: GraphQL fetchPage, token lifecycle, login/MFA stubs |
| `src/db.ts` | `initDb`, schema migrations, upsert helpers, sync state accessors |
| `src/tools/auth.ts` | `ck_set_token`, `ck_login`, `ck_submit_mfa` handlers + schemas |
| `src/tools/sync.ts` | `ck_sync_transactions` handler + schema |
| `src/tools/query.ts` | 5 query tool handlers + schemas |
| `src/tools/sql.ts` | `ck_query_sql` handler + schema |
| `tests/client.test.ts` | Client unit tests (HTTP mocked) |
| `tests/db.test.ts` | DB unit tests (`:memory:`) |
| `tests/tools/auth.test.ts` | Auth tool tests |
| `tests/tools/sync.test.ts` | Sync tool tests |
| `tests/tools/query.test.ts` | Query tool tests |
| `tests/tools/sql.test.ts` | SQL tool tests |

---

## Chunk 1: Project Scaffold & Database Layer

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.mcp.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1.1: Create `package.json`**

```json
{
  "name": "creditkarma-mcp",
  "version": "1.0.0",
  "description": "MCP server for Credit Karma transactions",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "better-sqlite3": "^9.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^18.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 1.2: Create `tsconfig.json`**

Note: `rootDir` is intentionally omitted. Setting it to `"./src"` would cause `tsc` to error when type-checking test files in `tests/` that import from `src/`. Without `rootDir`, `tsc` infers it from included files.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 1.3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
})
```

Note: `src/index.ts` is excluded from coverage because it wires the MCP server together and requires an integration test harness to cover meaningfully.

- [ ] **Step 1.4: Create `.mcp.json`**

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

- [ ] **Step 1.5: Create `.env.example`**

```
CK_TOKEN=           # Bearer token (manual or auto-set by ck_set_token)
CK_USERNAME=        # Optional: used by ck_login if args not provided
CK_PASSWORD=        # Optional: used by ck_login if args not provided
CK_DB_PATH=         # Optional: defaults to ~/.creditkarma-mcp/transactions.db
```

- [ ] **Step 1.6: Create `.gitignore`**

```
node_modules/
dist/
.env
*.db
coverage/
```

- [ ] **Step 1.7: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 1.8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .mcp.json .env.example .gitignore
git commit -m "chore: project scaffold"
```

---

### Task 2: Database Schema & `initDb`

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

- [ ] **Step 2.1: Write failing test for `initDb`**

Create `tests/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import { initDb } from '../src/db.js'
import type Database from 'better-sqlite3'

describe('initDb', () => {
  let db: Database.Database

  beforeEach(() => {
    db = initDb(':memory:')
  })

  it('creates schema_version table with version 1', () => {
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number }
    expect(row.version).toBe(1)
  })

  it('creates transactions table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'"
    ).get()
    expect(row).toBeTruthy()
  })

  it('creates accounts table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'"
    ).get()
    expect(row).toBeTruthy()
  })

  it('creates categories table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='categories'"
    ).get()
    expect(row).toBeTruthy()
  })

  it('creates merchants table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='merchants'"
    ).get()
    expect(row).toBeTruthy()
  })

  it('creates sync_state table', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'"
    ).get()
    expect(row).toBeTruthy()
  })

  it('enables foreign keys', () => {
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(row.foreign_keys).toBe(1)
  })
})

// WAL mode and idempotency require a real file — :memory: ignores WAL pragma
describe('initDb — file-based tests', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = join(tmpdir(), `ck-test-${Date.now()}-${Math.random()}.db`)
  })

  afterEach(() => {
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
  })

  it('enables WAL mode', () => {
    const fileDb = initDb(dbPath)
    const row = fileDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(row.journal_mode).toBe('wal')
    fileDb.close()
  })

  it('is idempotent — calling initDb twice on same path does not throw or duplicate schema', () => {
    const db1 = initDb(dbPath)
    db1.close()
    const db2 = initDb(dbPath)
    const row = db2.prepare('SELECT COUNT(*) as n FROM schema_version').get() as { n: number }
    expect(row.n).toBe(1)
    db2.close()
  })

  it('creates parent directory if it does not exist', () => {
    const nestedPath = join(tmpdir(), `ck-newdir-${Date.now()}`, 'sub', 'transactions.db')
    const db = initDb(nestedPath)
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number }
    expect(row.version).toBe(1)
    db.close()
    rmSync(join(tmpdir(), `ck-newdir-${Date.now() - 1000}`), { recursive: true, force: true })
  })
})
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
npm test -- tests/db.test.ts
```

Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 2.3: Implement `src/db.ts` with schema**

```typescript
import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export type Database = BetterSqlite3.Database

const CURRENT_VERSION = 1

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT,
      provider_name TEXT,
      display       TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      date        TEXT NOT NULL,
      description TEXT NOT NULL,
      status      TEXT,
      amount      REAL NOT NULL,
      account_id  TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      merchant_id TEXT REFERENCES merchants(id),
      raw_json    TEXT,
      synced_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT OR IGNORE INTO schema_version VALUES (1);
  `
}

export function initDb(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  const currentVersion = tableExists
    ? ((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0)
    : 0

  for (let v = currentVersion + 1; v <= CURRENT_VERSION; v++) {
    db.exec(MIGRATIONS[v])
  }

  return db
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
npm test -- tests/db.test.ts
```

Expected: PASS (9 tests)

- [ ] **Step 2.5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: database schema and initDb"
```

---

### Task 3: Row Types & Upsert Helpers

**Files:**
- Modify: `src/db.ts`
- Modify: `tests/db.test.ts`

- [ ] **Step 3.1: Add failing tests for upsert helpers**

Append to `tests/db.test.ts`. **Important:** Add the new imports at the TOP of the file (before the first `describe` block), not at the end:

```typescript
// Add at TOP of file, merge with existing import line:
import {
  initDb,
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState,
  type AccountRow, type CategoryRow, type MerchantRow, type TransactionRow
} from '../src/db.js'
```

Then append the following `describe` blocks at the end of the file:

```typescript

describe('upsertAccount', () => {
  let db: Database.Database

  beforeEach(() => { db = initDb(':memory:') })

  it('inserts a new account', () => {
    const account: AccountRow = { id: 'a1', name: 'Chase Checking', type: 'checking', providerName: 'Chase', display: 'Chase ...1234' }
    upsertAccount(db, account)
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get('a1') as AccountRow
    expect(row.name).toBe('Chase Checking')
    expect(row.providerName).toBe('Chase')
  })

  it('updates an existing account on conflict', () => {
    upsertAccount(db, { id: 'a1', name: 'Old Name' })
    upsertAccount(db, { id: 'a1', name: 'New Name' })
    const row = db.prepare('SELECT name FROM accounts WHERE id = ?').get('a1') as { name: string }
    expect(row.name).toBe('New Name')
  })

  it('inserts with optional fields as null', () => {
    upsertAccount(db, { id: 'a2', name: 'Basic' })
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get('a2') as AccountRow
    expect(row.type).toBeNull()
    expect(row.providerName).toBeNull()
  })
})

describe('upsertCategory', () => {
  let db: Database.Database
  beforeEach(() => { db = initDb(':memory:') })

  it('inserts a category', () => {
    upsertCategory(db, { id: 'c1', name: 'Food & Dining', type: 'expense' })
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get('c1') as CategoryRow
    expect(row.name).toBe('Food & Dining')
  })

  it('updates on conflict', () => {
    upsertCategory(db, { id: 'c1', name: 'Old' })
    upsertCategory(db, { id: 'c1', name: 'New' })
    const row = db.prepare('SELECT name FROM categories WHERE id = ?').get('c1') as { name: string }
    expect(row.name).toBe('New')
  })
})

describe('upsertMerchant', () => {
  let db: Database.Database
  beforeEach(() => { db = initDb(':memory:') })

  it('inserts a merchant', () => {
    upsertMerchant(db, { id: 'm1', name: 'Whole Foods' })
    const row = db.prepare('SELECT name FROM merchants WHERE id = ?').get('m1') as { name: string }
    expect(row.name).toBe('Whole Foods')
  })

  it('updates on conflict', () => {
    upsertMerchant(db, { id: 'm1', name: 'Old' })
    upsertMerchant(db, { id: 'm1', name: 'New' })
    const row = db.prepare('SELECT name FROM merchants WHERE id = ?').get('m1') as { name: string }
    expect(row.name).toBe('New')
  })
})

describe('upsertTransaction', () => {
  let db: Database.Database
  beforeEach(() => {
    db = initDb(':memory:')
    upsertAccount(db, { id: 'a1', name: 'Chase' })
    upsertCategory(db, { id: 'c1', name: 'Food' })
    upsertMerchant(db, { id: 'm1', name: 'Starbucks' })
  })

  const baseTx: TransactionRow = {
    id: 'tx1', date: '2024-01-10', description: 'Starbucks', status: 'posted',
    amount: -5.50, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}'
  }

  it('inserts a transaction', () => {
    upsertTransaction(db, baseTx)
    const row = db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get('tx1') as { id: string; amount: number }
    expect(row.id).toBe('tx1')
    expect(row.amount).toBe(-5.50)
  })

  it('updates status and amount on conflict, preserving synced_at', () => {
    upsertTransaction(db, baseTx)
    const before = db.prepare('SELECT synced_at FROM transactions WHERE id = ?').get('tx1') as { synced_at: string }

    upsertTransaction(db, { ...baseTx, status: 'cancelled', amount: 0 })
    const after = db.prepare('SELECT status, amount, synced_at FROM transactions WHERE id = ?').get('tx1') as { status: string; amount: number; synced_at: string }

    expect(after.status).toBe('cancelled')
    expect(after.amount).toBe(0)
    expect(after.synced_at).toBe(before.synced_at) // preserved
  })

  it('inserts the same transaction twice without duplicating', () => {
    upsertTransaction(db, baseTx)
    upsertTransaction(db, baseTx)
    const count = db.prepare('SELECT COUNT(*) as n FROM transactions WHERE id = ?').get('tx1') as { n: number }
    expect(count.n).toBe(1)
  })
})
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
npm test -- tests/db.test.ts
```

Expected: FAIL — upsert functions not exported

- [ ] **Step 3.3: Implement row types and upsert helpers in `src/db.ts`**

Append to `src/db.ts` (after `initDb`):

```typescript
export interface AccountRow {
  id: string
  name: string
  type?: string | null
  providerName?: string | null
  display?: string | null
}

export interface CategoryRow {
  id: string
  name: string
  type?: string | null
}

export interface MerchantRow {
  id: string
  name: string
}

export interface TransactionRow {
  id: string
  date: string
  description: string
  status: string
  amount: number
  accountId: string
  categoryId: string
  merchantId: string
  rawJson: string
}

export function upsertAccount(db: Database, row: AccountRow): void {
  db.prepare(`
    INSERT INTO accounts (id, name, type, provider_name, display)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      provider_name = excluded.provider_name,
      display = excluded.display
  `).run(row.id, row.name, row.type ?? null, row.providerName ?? null, row.display ?? null)
}

export function upsertCategory(db: Database, row: CategoryRow): void {
  db.prepare(`
    INSERT INTO categories (id, name, type)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type
  `).run(row.id, row.name, row.type ?? null)
}

export function upsertMerchant(db: Database, row: MerchantRow): void {
  db.prepare(`
    INSERT INTO merchants (id, name)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `).run(row.id, row.name)
}

export function upsertTransaction(db: Database, row: TransactionRow): void {
  db.prepare(`
    INSERT INTO transactions (id, date, description, status, amount, account_id, category_id, merchant_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      date        = excluded.date,
      description = excluded.description,
      status      = excluded.status,
      amount      = excluded.amount,
      account_id  = excluded.account_id,
      category_id = excluded.category_id,
      merchant_id = excluded.merchant_id,
      raw_json    = excluded.raw_json,
      updated_at  = CURRENT_TIMESTAMP
  `).run(
    row.id, row.date, row.description, row.status, row.amount,
    row.accountId, row.categoryId, row.merchantId, row.rawJson
  )
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
npm test -- tests/db.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 3.5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: row types and upsert helpers"
```

---

### Task 4: Sync State Helpers

**Files:**
- Modify: `src/db.ts`
- Modify: `tests/db.test.ts`

- [ ] **Step 4.1: Add failing tests for sync state**

Append to `tests/db.test.ts` (imports for `getSyncState`/`setSyncState` were already added at the top in Task 3):

```typescript
describe('sync state', () => {
  let db: Database.Database
  beforeEach(() => { db = initDb(':memory:') })

  it('returns null for missing key', () => {
    expect(getSyncState(db, 'last_sync_date')).toBeNull()
  })

  it('sets and gets a value', () => {
    setSyncState(db, 'last_sync_date', '2024-01-01')
    expect(getSyncState(db, 'last_sync_date')).toBe('2024-01-01')
  })

  it('overwrites existing value', () => {
    setSyncState(db, 'last_sync_date', '2024-01-01')
    setSyncState(db, 'last_sync_date', '2024-02-01')
    expect(getSyncState(db, 'last_sync_date')).toBe('2024-02-01')
  })

  it('handles multiple keys independently', () => {
    setSyncState(db, 'last_sync_date', '2024-01-01')
    setSyncState(db, 'last_cursor', 'abc123')
    expect(getSyncState(db, 'last_sync_date')).toBe('2024-01-01')
    expect(getSyncState(db, 'last_cursor')).toBe('abc123')
  })
})
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
npm test -- tests/db.test.ts
```

Expected: FAIL — `getSyncState` and `setSyncState` not exported

- [ ] **Step 4.3: Implement sync state helpers in `src/db.ts`**

Append to `src/db.ts`:

```typescript
export function getSyncState(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSyncState(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}
```

- [ ] **Step 4.4: Run all tests to verify they pass**

```bash
npm test -- tests/db.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 4.5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: sync state helpers"
```

---

## Chunk 2: Client (GraphQL + Token Lifecycle)

### Task 5: Client Token Management

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

- [ ] **Step 5.1: Write failing tests for token management**

Create `tests/client.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { CreditKarmaClient } from '../src/client.js'

describe('CreditKarmaClient — token management', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    client = new CreditKarmaClient()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has no token by default', () => {
    expect(client.getToken()).toBeNull()
  })

  it('is expired with no token', () => {
    expect(client.isTokenExpired()).toBe(true)
  })

  it('accepts a token at construction', () => {
    const c = new CreditKarmaClient('mytoken')
    expect(c.getToken()).toBe('mytoken')
    expect(c.isTokenExpired()).toBe(false)
  })

  it('setToken updates the token', () => {
    client.setToken('tok1')
    expect(client.getToken()).toBe('tok1')
    expect(client.isTokenExpired()).toBe(false)
  })

  it('token is expired after 10 minutes', () => {
    client.setToken('tok1')
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    expect(client.isTokenExpired()).toBe(true)
  })

  it('token is not expired just before 10 minutes', () => {
    client.setToken('tok1')
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    expect(client.isTokenExpired()).toBe(false)
  })
})
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
npm test -- tests/client.test.ts
```

Expected: FAIL — `Cannot find module '../src/client.js'`

- [ ] **Step 5.3: Implement `src/client.ts` with token management**

```typescript
const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const GRAPHQL_ENDPOINT = 'https://api.creditkarma.com/graphql'

export interface TransactionPage {
  transactions: ApiTransaction[]
  pageInfo: {
    startCursor: string
    endCursor: string
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

export interface ApiTransaction {
  id: string
  date: string
  description: string
  status: string
  amount: { value: number; asCurrencyString: string }
  account: {
    id: string
    name: string
    type: string
    providerName: string
    accountTypeAndNumberDisplay: string
  }
  category: { id: string; name: string; type: string }
  merchant: { id: string; name: string }
}

export class CreditKarmaClient {
  private token: string | null = null
  private tokenSetAt: number | null = null
  /** Opaque MFA challenge state from login response — implementation TBD */
  challengeState: unknown = null

  constructor(token?: string) {
    if (token) this.setToken(token)
  }

  setToken(token: string): void {
    this.token = token
    this.tokenSetAt = Date.now()
  }

  getToken(): string | null {
    return this.token
  }

  isTokenExpired(): boolean {
    if (!this.token || this.tokenSetAt === null) return true
    return Date.now() - this.tokenSetAt > TOKEN_TTL_MS
  }

  /** Fetch a single page of transactions. Throws TOKEN_EXPIRED on 401. */
  async fetchPage(afterCursor?: string): Promise<TransactionPage> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const response = await this.post(GRAPHQL_ENDPOINT, {
      query: TRANSACTION_QUERY,
      variables: buildVariables(afterCursor)
    })

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(2000)
      const retry = await this.post(GRAPHQL_ENDPOINT, {
        query: TRANSACTION_QUERY,
        variables: buildVariables(afterCursor)
      })
      if (retry.status === 401) throw new Error('TOKEN_EXPIRED')
      if (!retry.ok) throw new Error(`HTTP ${retry.status}`)
      return parseTransactionPage(await retry.json())
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseTransactionPage(await response.json())
  }

  /**
   * Initiate login. Sends username/password to CK auth endpoint.
   * Stores MFA challenge state in memory.
   *
   * NOTE: CK login endpoints must be reverse-engineered from browser network
   * traffic before this method can be implemented. The method signature is final;
   * only the body needs implementation once endpoints are known.
   */
  async login(_username: string, _password: string): Promise<void> {
    throw new Error(
      'LOGIN_NOT_IMPLEMENTED: Capture CK auth endpoints from browser Network tab first. ' +
      'See docs/superpowers/specs/2026-03-17-creditkarma-mcp-design.md Open Question #1.'
    )
  }

  /**
   * Submit MFA code. Returns bearer token on success.
   *
   * NOTE: Depends on login() challenge state. Endpoints TBD.
   */
  async submitMfa(_code: string): Promise<string> {
    throw new Error(
      'MFA_NOT_IMPLEMENTED: Depends on login() — see Open Question #1 in design spec.'
    )
  }

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token ?? ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }
}

// ---------------------------------------------------------------------------
// GraphQL query (ported from Ruby script at
// /Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions)
// ---------------------------------------------------------------------------

/**
 * IMPORTANT: Extract the full GraphQL query from the Ruby script.
 * Search for the `query` variable assignment around line ~100-200 in the Ruby file.
 * It will be a multi-line string containing fragment definitions and a main query.
 * Replace the placeholder below with the actual query string.
 */
export const TRANSACTION_QUERY = `
  # TODO: Extract from Ruby script at:
  # /Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions
  # Search for: graphql_query = or similar variable holding the query string
`

function buildVariables(afterCursor?: string): Record<string, unknown> {
  return {
    input: {
      paginationInput: {
        after: afterCursor ?? null,
        first: 50
      }
    }
  }
}

function parseTransactionPage(json: unknown): TransactionPage {
  const data = json as {
    data: {
      prime: {
        transactionsHub: {
          transactionPage: TransactionPage
        }
      }
    }
  }
  return data.data.prime.transactionsHub.transactionPage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
npm test -- tests/client.test.ts
```

Expected: PASS (token management tests)

- [ ] **Step 5.5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: CreditKarmaClient token management"
```

---

### Task 6: Client `fetchPage` & Error Handling

**Files:**
- Modify: `tests/client.test.ts`

- [ ] **Step 6.1: Add failing tests for `fetchPage`**

Append to `tests/client.test.ts`. **Add** `TransactionPage` to the existing import at the top of the file — do NOT add a second `import { vi }` line, it's already imported:

```typescript
// Modify the existing import at top of file to add TransactionPage:
import { CreditKarmaClient, type TransactionPage } from '../src/client.js'
```

Then append these describe blocks at the end of the file:

```typescript
const mockPage: TransactionPage = {
  transactions: [
    {
      id: 'tx1', date: '2024-01-10', description: 'Starbucks', status: 'posted',
      amount: { value: -5.50, asCurrencyString: '-$5.50' },
      account: { id: 'a1', name: 'Chase', type: 'checking', providerName: 'Chase', accountTypeAndNumberDisplay: '...1234' },
      category: { id: 'c1', name: 'Food', type: 'expense' },
      merchant: { id: 'm1', name: 'Starbucks' }
    }
  ],
  pageInfo: { startCursor: 'start', endCursor: 'end', hasNextPage: false, hasPreviousPage: false }
}

const mockResponse = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

describe('CreditKarmaClient — fetchPage', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    client = new CreditKarmaClient('valid-token')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('throws TOKEN_EXPIRED with no token', async () => {
    const c = new CreditKarmaClient()
    await expect(c.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('calls GraphQL endpoint with Authorization header', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )

    await client.fetchPage()

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.creditkarma.com/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer valid-token' })
      })
    )
  })

  it('returns parsed TransactionPage on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )
    const result = await client.fetchPage('cursor1')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].id).toBe('tx1')
    expect(result.pageInfo.endCursor).toBe('end')
  })

  it('throws TOKEN_EXPIRED on 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse(401))
    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('retries once on 429 and succeeds', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(
        mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
      )

    // Use Promise.all to advance timers and await result concurrently — avoids ordering races
    const [result] = await Promise.all([
      client.fetchPage(),
      vi.runAllTimersAsync()
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.transactions).toHaveLength(1)
  })

  it('throws TOKEN_EXPIRED if retry after 429 returns 401', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(401))

    await expect(
      Promise.all([client.fetchPage(), vi.runAllTimersAsync()])
    ).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('throws HTTP error on non-200/401/429 status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse(500))
    await expect(client.fetchPage()).rejects.toThrow('HTTP 500')
  })

  it('passes afterCursor in request variables', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )
    await client.fetchPage('my-cursor')
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables.input.paginationInput.after).toBe('my-cursor')
  })
})

describe('CreditKarmaClient — login/mfa stubs', () => {
  it('login throws NOT_IMPLEMENTED', async () => {
    const c = new CreditKarmaClient()
    await expect(c.login('user', 'pass')).rejects.toThrow('LOGIN_NOT_IMPLEMENTED')
  })

  it('submitMfa throws NOT_IMPLEMENTED', async () => {
    const c = new CreditKarmaClient()
    await expect(c.submitMfa('123456')).rejects.toThrow('MFA_NOT_IMPLEMENTED')
  })
})
```

Also add the import at the top of the describe block (add to the existing import line):
```typescript
import type { TransactionPage } from '../src/client.js'
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
npm test -- tests/client.test.ts
```

Expected: FAIL — `TransactionPage` not imported or tests fail

- [ ] **Step 6.3: Run all client tests to verify they pass**

```bash
npm test -- tests/client.test.ts
```

Expected: PASS (all client tests)

- [ ] **Step 6.4: Commit**

```bash
git add tests/client.test.ts
git commit -m "test: CreditKarmaClient fetchPage and error handling"
```

---

## Chunk 3: Auth Tools

### Task 7: `ck_set_token` Tool

**Files:**
- Create: `src/tools/auth.ts`
- Create: `tests/tools/auth.test.ts`

- [ ] **Step 7.1: Write failing tests for `ck_set_token`**

Create `tests/tools/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSetToken } from '../../src/tools/auth.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ck-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('ck_set_token', () => {
  let ctx: AppContext
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: join(tmpDir, '.mcp.json')
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets the token on the client', async () => {
    await handleSetToken({ token: 'mytoken' }, ctx)
    expect(ctx.client.getToken()).toBe('mytoken')
  })

  it('returns success message', async () => {
    const result = await handleSetToken({ token: 'mytoken' }, ctx)
    expect(result).toContain('Token set successfully')
  })

  it('persists token to .mcp.json when file exists', async () => {
    const mcpJson = {
      mcpServers: { creditkarma: { command: 'node', args: ['dist/index.js'], env: { CK_TOKEN: '' } } }
    }
    writeFileSync(ctx.mcpJsonPath, JSON.stringify(mcpJson, null, 2))

    await handleSetToken({ token: 'saved-token' }, ctx)

    const updated = JSON.parse(readFileSync(ctx.mcpJsonPath, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_TOKEN).toBe('saved-token')
  })

  it('returns warning if .mcp.json does not exist but still sets token', async () => {
    const result = await handleSetToken({ token: 'tok' }, ctx)
    expect(ctx.client.getToken()).toBe('tok')
    expect(result).toContain('Warning')
  })

  it('returns warning if .mcp.json lacks expected key path but still sets token', async () => {
    writeFileSync(ctx.mcpJsonPath, JSON.stringify({ other: true }))
    const result = await handleSetToken({ token: 'tok' }, ctx)
    expect(ctx.client.getToken()).toBe('tok')
    expect(result).toContain('Warning')
  })
})
```

- [ ] **Step 7.2: Run tests to verify they fail**

```bash
npm test -- tests/tools/auth.test.ts
```

Expected: FAIL — modules not found

- [ ] **Step 7.3: Create `src/index.ts` stub (AppContext only — full wiring comes later)**

```typescript
import { CreditKarmaClient } from './client.js'
import type { Database } from './db.js'

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}
```

- [ ] **Step 7.4: Implement `src/tools/auth.ts` with `handleSetToken` only (login/mfa are stubs)**

```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { AppContext } from '../index.js'

export interface SetTokenArgs {
  token: string
}

export interface LoginArgs {
  username?: string
  password?: string
}

export interface SubmitMfaArgs {
  code: string
}

export async function handleSetToken(args: SetTokenArgs, ctx: AppContext): Promise<string> {
  ctx.client.setToken(args.token)

  const warning = persistToken(args.token, ctx.mcpJsonPath)
  return warning
    ? `Token set successfully. Warning: ${warning}`
    : 'Token set successfully.'
}

export async function handleLogin(_args: LoginArgs, _ctx: AppContext): Promise<string> {
  throw new Error('not implemented')
}

export async function handleSubmitMfa(_args: SubmitMfaArgs, _ctx: AppContext): Promise<string> {
  throw new Error('not implemented')
}

function persistToken(token: string, mcpJsonPath: string): string | null {
  if (!existsSync(mcpJsonPath)) {
    return '.mcp.json not found — token applied in memory only'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
  } catch {
    return '.mcp.json could not be parsed — token applied in memory only'
  }

  const env = (parsed as { mcpServers?: { creditkarma?: { env?: Record<string, string> } } })
    ?.mcpServers?.creditkarma?.env

  if (!env) {
    return '.mcp.json lacks mcpServers.creditkarma.env path — token applied in memory only'
  }

  env.CK_TOKEN = token
  writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2))
  return null
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

export const authToolDefinitions = [
  {
    name: 'ck_set_token',
    description: 'Manually set the Credit Karma bearer token. Updates in-memory state and persists to .mcp.json.',
    inputSchema: {
      type: 'object' as const,
      properties: { token: { type: 'string', description: 'Bearer token from browser Network tab' } },
      required: ['token']
    }
  },
  {
    name: 'ck_login',
    description: 'Initiate Credit Karma login with username and password. Sends an MFA challenge. Follow up with ck_submit_mfa.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'CK username (uses CK_USERNAME env var if omitted)' },
        password: { type: 'string', description: 'CK password (uses CK_PASSWORD env var if omitted)' }
      }
    }
  },
  {
    name: 'ck_submit_mfa',
    description: 'Submit MFA code after ck_login. Completes authentication and saves the token.',
    inputSchema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'MFA code from SMS/email' } },
      required: ['code']
    }
  }
]
```

- [ ] **Step 7.5: Run tests to verify they pass**

```bash
npm test -- tests/tools/auth.test.ts
```

Expected: PASS

- [ ] **Step 7.6: Write failing tests for `handleLogin` and `handleSubmitMfa`**

Append to `tests/tools/auth.test.ts`. Add `handleLogin, handleSubmitMfa` to the existing import at the top of the file.

```typescript
describe('ck_login', () => {
  let ctx: AppContext

  beforeEach(() => {
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: '/nonexistent/.mcp.json'
    }
  })

  it('throws if no username provided', async () => {
    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
    await expect(handleLogin({}, ctx)).rejects.toThrow('Username and password required')
  })

  it('throws if no password provided', async () => {
    delete process.env.CK_PASSWORD
    await expect(handleLogin({ username: 'user' }, ctx)).rejects.toThrow('Username and password required')
  })

  it('uses env vars when args not provided', async () => {
    process.env.CK_USERNAME = 'envuser'
    process.env.CK_PASSWORD = 'envpass'
    vi.spyOn(ctx.client, 'login').mockResolvedValueOnce(undefined)
    const result = await handleLogin({}, ctx)
    expect(ctx.client.login).toHaveBeenCalledWith('envuser', 'envpass')
    expect(result).toContain('MFA challenge')
    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
  })

  it('calls client.login with provided args', async () => {
    vi.spyOn(ctx.client, 'login').mockResolvedValueOnce(undefined)
    await handleLogin({ username: 'u', password: 'p' }, ctx)
    expect(ctx.client.login).toHaveBeenCalledWith('u', 'p')
  })
})

describe('ck_submit_mfa', () => {
  let ctx: AppContext
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: join(tmpDir, '.mcp.json')
    }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets token from submitMfa result', async () => {
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('new-bearer-token')
    await handleSubmitMfa({ code: '123456' }, ctx)
    expect(ctx.client.getToken()).toBe('new-bearer-token')
  })

  it('returns success message', async () => {
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('tok')
    const result = await handleSubmitMfa({ code: '000000' }, ctx)
    expect(result).toContain('Authenticated successfully')
  })

  it('persists token to .mcp.json after MFA success', async () => {
    const mcpJson = {
      mcpServers: { creditkarma: { command: 'node', args: ['dist/index.js'], env: { CK_TOKEN: '' } } }
    }
    writeFileSync(ctx.mcpJsonPath, JSON.stringify(mcpJson, null, 2))
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('mfa-token')
    await handleSubmitMfa({ code: '999999' }, ctx)
    const updated = JSON.parse(readFileSync(ctx.mcpJsonPath, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_TOKEN).toBe('mfa-token')
  })
})
```

- [ ] **Step 7.7: Run login/mfa tests to verify they fail**

```bash
npm test -- tests/tools/auth.test.ts
```

Expected: login and mfa tests FAIL (stubs throw "not implemented")

- [ ] **Step 7.8: Implement `handleLogin` and `handleSubmitMfa` in `src/tools/auth.ts`**

Replace the stub implementations:

```typescript
export async function handleLogin(args: LoginArgs, ctx: AppContext): Promise<string> {
  const username = args.username ?? process.env.CK_USERNAME
  const password = args.password ?? process.env.CK_PASSWORD

  if (!username || !password) {
    throw new Error('Username and password required. Pass as args or set CK_USERNAME / CK_PASSWORD env vars.')
  }

  await ctx.client.login(username, password)
  return 'MFA challenge initiated. Check your phone/email and call ck_submit_mfa with your code.'
}

export async function handleSubmitMfa(args: SubmitMfaArgs, ctx: AppContext): Promise<string> {
  const token = await ctx.client.submitMfa(args.code)
  ctx.client.setToken(token)

  const warning = persistToken(token, ctx.mcpJsonPath)
  return warning
    ? `Authenticated successfully. Token saved. Warning: ${warning}`
    : 'Authenticated successfully. Token saved.'
}
```

- [ ] **Step 7.9: Run all auth tests to verify they pass**

```bash
npm test -- tests/tools/auth.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 7.10: Commit**

```bash
git add src/index.ts src/tools/auth.ts tests/tools/auth.test.ts
git commit -m "feat: auth tools (ck_set_token, ck_login, ck_submit_mfa)"
```

---

## Chunk 4: Sync Tool

### Task 8: `ck_sync_transactions`

**Files:**
- Create: `src/tools/sync.ts`
- Create: `tests/tools/sync.test.ts`

- [ ] **Step 8.1: Write failing tests for sync**

Create `tests/tools/sync.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleSyncTransactions } from '../../src/tools/sync.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb, getSyncState } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import type { TransactionPage } from '../../src/client.js'

const makeTx = (id: string, date: string, overrides = {}) => ({
  id, date, description: `Tx ${id}`, status: 'posted',
  amount: { value: -10, asCurrencyString: '-$10.00' },
  account: { id: 'a1', name: 'Chase', type: 'checking', providerName: 'Chase', accountTypeAndNumberDisplay: '...1234' },
  category: { id: 'c1', name: 'Food', type: 'expense' },
  merchant: { id: 'm1', name: 'Starbucks' },
  ...overrides
})

const makePage = (txs: ReturnType<typeof makeTx>[], hasNextPage = false, endCursor = 'end'): TransactionPage => ({
  transactions: txs,
  pageInfo: { startCursor: 'start', endCursor, hasNextPage, hasPreviousPage: false }
})

describe('ck_sync_transactions', () => {
  let ctx: AppContext

  beforeEach(() => {
    // Set fake time BEFORE creating client so tokenSetAt reflects the fake clock
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-02-15'))
    ctx = {
      client: new CreditKarmaClient('valid-token'),
      db: initDb(':memory:'),
      mcpJsonPath: '/tmp/.mcp.json'
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fetches all pages and upserts transactions', async () => {
    vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10'), makeTx('tx2', '2024-02-11')], true, 'c1'))
      .mockResolvedValueOnce(makePage([makeTx('tx3', '2024-01-01')]))

    const result = await handleSyncTransactions({}, ctx)

    expect(result.total).toBe(3)
    const count = ctx.db.prepare('SELECT COUNT(*) as n FROM transactions').get() as { n: number }
    expect(count.n).toBe(3)
  })

  it('returns new and updated counts', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')]))

    const first = await handleSyncTransactions({}, ctx)
    expect(first.new).toBe(1)
    expect(first.updated).toBe(0)

    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(
      makePage([makeTx('tx1', '2024-02-10', { status: 'cancelled' })])
    )
    const second = await handleSyncTransactions({ force_full: true }, ctx)
    expect(second.new).toBe(0)
    expect(second.updated).toBe(1)
  })

  it('saves last_sync_date after sync', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)
    expect(getSyncState(ctx.db, 'last_sync_date')).toBe('2024-02-15')
  })

  it('incremental sync stops when tx date is older than last_sync_date - 30 days', async () => {
    // Set last sync to 2024-02-01
    const { setSyncState } = await import('../../src/db.js')
    setSyncState(ctx.db, 'last_sync_date', '2024-02-01')

    // cutoff = 2024-02-01 - 30 days = 2024-01-02
    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10'), makeTx('tx2', '2024-01-01')], true, 'c1'))
      // second page should NOT be fetched because tx2 date < cutoff

    await handleSyncTransactions({}, ctx)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('force_full fetches all pages regardless of date', async () => {
    const { setSyncState } = await import('../../src/db.js')
    setSyncState(ctx.db, 'last_sync_date', '2024-02-01')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2020-01-01')], true, 'c1'))
      .mockResolvedValueOnce(makePage([makeTx('tx2', '2019-01-01')]))

    await handleSyncTransactions({ force_full: true }, ctx)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('saves last_cursor on TOKEN_EXPIRED mid-sync', async () => {
    vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')], true, 'cursor-checkpoint'))
      .mockRejectedValueOnce(new Error('TOKEN_EXPIRED'))

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('TOKEN_EXPIRED')
    expect(getSyncState(ctx.db, 'last_cursor')).toBe('cursor-checkpoint')
  })

  it('resumes from last_cursor if present', async () => {
    const { setSyncState } = await import('../../src/db.js')
    setSyncState(ctx.db, 'last_cursor', 'resume-here')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)

    expect(fetchSpy).toHaveBeenCalledWith('resume-here')
  })

  it('clears last_cursor on successful sync', async () => {
    const { setSyncState } = await import('../../src/db.js')
    setSyncState(ctx.db, 'last_cursor', 'resume-here')

    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)

    expect(getSyncState(ctx.db, 'last_cursor')).toBeNull()
  })

  it('auto-triggers login if token is expired', async () => {
    const expiredClient = new CreditKarmaClient()  // no token
    ctx.client = expiredClient
    vi.spyOn(expiredClient, 'login').mockResolvedValueOnce(undefined)

    process.env.CK_USERNAME = 'user'
    process.env.CK_PASSWORD = 'pass'

    const result = await handleSyncTransactions({}, ctx)
    expect(expiredClient.login).toHaveBeenCalledWith('user', 'pass')
    expect(typeof result).toBe('string')  // returns login prompt, not sync result

    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
  })

  it('throws with instructions if token expired and no credentials set', async () => {
    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
    ctx.client = new CreditKarmaClient()  // no token
    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('TOKEN_EXPIRED')
  })
})
```

- [ ] **Step 8.2: Run tests to verify they fail**

```bash
npm test -- tests/tools/sync.test.ts
```

Expected: FAIL — `handleSyncTransactions` not found

- [ ] **Step 8.3: Implement `src/tools/sync.ts`**

```typescript
import type { AppContext } from '../index.js'
import {
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState
} from '../db.js'
import type { ApiTransaction } from '../client.js'

export interface SyncArgs {
  force_full?: boolean
}

export interface SyncResult {
  new: number
  updated: number
  total: number
}

export async function handleSyncTransactions(
  args: SyncArgs,
  ctx: AppContext
): Promise<SyncResult | string> {
  // Auto-trigger login if no valid token
  if (ctx.client.isTokenExpired()) {
    const username = process.env.CK_USERNAME
    const password = process.env.CK_PASSWORD
    if (!username || !password) {
      throw new Error(
        'TOKEN_EXPIRED: No valid token. Call ck_login or ck_set_token first, ' +
        'or set CK_USERNAME and CK_PASSWORD env vars for auto-login.'
      )
    }
    await ctx.client.login(username, password)
    return (
      'MFA challenge initiated. Check your phone/email and call ck_submit_mfa ' +
      'with your code, then re-run ck_sync_transactions.'
    )
  }

  const today = localDateString(new Date())
  const lastSyncDate = getSyncState(ctx.db, 'last_sync_date')
  const resumeCursor = getSyncState(ctx.db, 'last_cursor') ?? undefined

  // Cutoff: stop fetching pages when tx.date < (lastSyncDate - 30 days)
  // Unless force_full=true or no prior sync
  const cutoffDate = (!args.force_full && lastSyncDate)
    ? subtractDays(lastSyncDate, 30)
    : null

  // For force_full, always start from the beginning (ignore any saved resume cursor)
  let cursor: string | undefined = args.force_full ? undefined : resumeCursor
  let newCount = 0
  let updatedCount = 0
  let totalCount = 0
  let done = false

  while (!done) {
    let page
    try {
      page = await ctx.client.fetchPage(cursor)
    } catch (err) {
      // Save cursor so we can resume on next attempt
      if (cursor) setSyncState(ctx.db, 'last_cursor', cursor)
      throw err
    }

    for (const tx of page.transactions) {
      const exists = ctx.db
        .prepare('SELECT id FROM transactions WHERE id = ?')
        .get(tx.id)

      upsertAccount(ctx.db, {
        id: tx.account.id, name: tx.account.name, type: tx.account.type,
        providerName: tx.account.providerName, display: tx.account.accountTypeAndNumberDisplay
      })
      upsertCategory(ctx.db, { id: tx.category.id, name: tx.category.name, type: tx.category.type })
      upsertMerchant(ctx.db, { id: tx.merchant.id, name: tx.merchant.name })
      upsertTransaction(ctx.db, {
        id: tx.id, date: tx.date, description: tx.description, status: tx.status,
        amount: tx.amount.value, accountId: tx.account.id, categoryId: tx.category.id,
        merchantId: tx.merchant.id, rawJson: JSON.stringify(tx)
      })

      if (exists) { updatedCount++ } else { newCount++ }
      totalCount++
    }

    // Stop if we've reached older-than-cutoff transactions
    if (cutoffDate && page.transactions.length > 0) {
      const oldestDate = page.transactions[page.transactions.length - 1].date
      if (oldestDate < cutoffDate) done = true
    }

    if (!page.pageInfo.hasNextPage) done = true
    cursor = page.pageInfo.endCursor
  }

  setSyncState(ctx.db, 'last_sync_date', today)
  // Clear resume cursor on success
  ctx.db.prepare("DELETE FROM sync_state WHERE key = 'last_cursor'").run()

  return { new: newCount, updated: updatedCount, total: totalCount }
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() - days)
  return localDateString(d)
}

/** Returns YYYY-MM-DD in local time (avoids UTC offset shifting the date) */
function localDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const syncToolDefinitions = [
  {
    name: 'ck_sync_transactions',
    description:
      'Sync Credit Karma transactions into the local SQLite database. ' +
      'Incremental by default (fetches since last sync + 30-day overlap for updates). ' +
      'If no valid token, initiates the login/MFA flow automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force_full: {
          type: 'boolean',
          description: 'If true, re-fetch all transactions from the beginning'
        }
      }
    }
  }
]
```

- [ ] **Step 8.4: Run sync tests to verify they pass**

```bash
npm test -- tests/tools/sync.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 8.5: Commit**

```bash
git add src/tools/sync.ts tests/tools/sync.test.ts
git commit -m "feat: ck_sync_transactions with incremental sync and auto-login"
```

---

## Chunk 5: Query Tools

### Task 9: `ck_list_transactions` & `ck_get_recent_transactions`

**Files:**
- Create: `src/tools/query.ts`
- Create: `tests/tools/query.test.ts`

- [ ] **Step 9.1: Write failing tests**

Create `tests/tools/query.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, upsertAccount, upsertCategory, upsertMerchant, upsertTransaction } from '../../src/db.js'
import {
  handleListTransactions, handleGetRecentTransactions,
  handleGetSpendingByCategory, handleGetSpendingByMerchant, handleGetAccountSummary
} from '../../src/tools/query.js'
import { CreditKarmaClient } from '../../src/client.js'
import type { AppContext } from '../../src/index.js'

function seedDb(db: ReturnType<typeof initDb>) {
  upsertAccount(db, { id: 'a1', name: 'Chase Checking' })
  upsertAccount(db, { id: 'a2', name: 'Amex Platinum' })
  upsertCategory(db, { id: 'c1', name: 'Food & Dining' })
  upsertCategory(db, { id: 'c2', name: 'Shopping' })
  upsertMerchant(db, { id: 'm1', name: 'Starbucks' })
  upsertMerchant(db, { id: 'm2', name: 'Amazon' })
  upsertMerchant(db, { id: 'm3', name: 'Target' })

  const txs = [
    { id: 'tx1', date: '2024-02-10', description: 'Starbucks', status: 'posted', amount: -5.50, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}' },
    { id: 'tx2', date: '2024-02-11', description: 'Amazon', status: 'posted', amount: -99.99, accountId: 'a2', categoryId: 'c2', merchantId: 'm2', rawJson: '{}' },
    { id: 'tx3', date: '2024-01-05', description: 'Target', status: 'posted', amount: -45.00, accountId: 'a1', categoryId: 'c2', merchantId: 'm3', rawJson: '{}' },
    { id: 'tx4', date: '2024-01-10', description: 'Refund', status: 'posted', amount: 20.00, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}' },
    { id: 'tx5', date: '2024-02-14', description: 'Starbucks 2', status: 'pending', amount: -6.00, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}' },
  ]
  txs.forEach(tx => upsertTransaction(db, tx))
}

function makeCtx(db: ReturnType<typeof initDb>): AppContext {
  return { client: new CreditKarmaClient(), db, mcpJsonPath: '/tmp/.mcp.json' }
}

describe('ck_list_transactions', () => {
  let ctx: AppContext

  beforeEach(() => {
    const db = initDb(':memory:')
    seedDb(db)
    ctx = makeCtx(db)
  })

  it('returns all transactions with default limit', async () => {
    const result = await handleListTransactions({}, ctx)
    expect(result.total).toBe(5)
    expect(result.transactions).toHaveLength(5)
  })

  it('filters by start_date', async () => {
    const result = await handleListTransactions({ start_date: '2024-02-01' }, ctx)
    expect(result.total).toBe(3)
  })

  it('filters by end_date', async () => {
    const result = await handleListTransactions({ end_date: '2024-01-31' }, ctx)
    expect(result.total).toBe(2)
  })

  it('filters by date range', async () => {
    const result = await handleListTransactions({ start_date: '2024-02-10', end_date: '2024-02-11' }, ctx)
    expect(result.total).toBe(2)
  })

  it('filters by account (partial match)', async () => {
    const result = await handleListTransactions({ account: 'Chase' }, ctx)
    expect(result.total).toBe(4)
  })

  it('filters by category (partial match)', async () => {
    const result = await handleListTransactions({ category: 'Food' }, ctx)
    expect(result.total).toBe(3)
  })

  it('filters by merchant (partial match)', async () => {
    const result = await handleListTransactions({ merchant: 'Starbucks' }, ctx)
    expect(result.total).toBe(3)
  })

  it('filters by status', async () => {
    const result = await handleListTransactions({ status: 'pending' }, ctx)
    expect(result.total).toBe(1)
  })

  it('filters by min_amount (absolute value)', async () => {
    const result = await handleListTransactions({ min_amount: 50 }, ctx)
    expect(result.total).toBe(1) // only Amazon $99.99
  })

  it('filters by max_amount (absolute value)', async () => {
    const result = await handleListTransactions({ max_amount: 10 }, ctx)
    expect(result.total).toBe(2) // tx1 ($5.50) + tx5 ($6.00); refund tx4 is $20 which fails ABS <= 10
  })

  it('paginates with limit and offset', async () => {
    const page1 = await handleListTransactions({ limit: 2, offset: 0 }, ctx)
    const page2 = await handleListTransactions({ limit: 2, offset: 2 }, ctx)
    expect(page1.transactions).toHaveLength(2)
    expect(page2.transactions).toHaveLength(2)
    expect(page1.transactions[0].id).not.toBe(page2.transactions[0].id)
  })

  it('returns results ordered by date desc', async () => {
    const result = await handleListTransactions({}, ctx)
    const dates = result.transactions.map(t => t.date)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it('includes offset and limit in result', async () => {
    const result = await handleListTransactions({ limit: 10, offset: 0 }, ctx)
    expect(result.limit).toBe(10)
    expect(result.offset).toBe(0)
  })
})

describe('ck_get_recent_transactions', () => {
  let ctx: AppContext

  beforeEach(() => {
    const db = initDb(':memory:')
    seedDb(db)
    ctx = makeCtx(db)
  })

  it('returns last 25 by default', async () => {
    const result = await handleGetRecentTransactions({}, ctx)
    expect(result.transactions).toHaveLength(5) // only 5 seeded
  })

  it('respects limit param', async () => {
    const result = await handleGetRecentTransactions({ limit: 2 }, ctx)
    expect(result.transactions).toHaveLength(2)
  })

  it('returns most recent first', async () => {
    const result = await handleGetRecentTransactions({ limit: 2 }, ctx)
    expect(result.transactions[0].date >= result.transactions[1].date).toBe(true)
  })
})
```

- [ ] **Step 9.2: Run tests to verify they fail**

```bash
npm test -- tests/tools/query.test.ts
```

Expected: FAIL — `handleListTransactions` not found

- [ ] **Step 9.3: Implement `src/tools/query.ts` with list and recent tools**

```typescript
import type { AppContext } from '../index.js'
import type { Database } from '../db.js'

// ---------------------------------------------------------------------------
// Shared query row type
// ---------------------------------------------------------------------------

export interface QueryTransactionRow {
  id: string
  date: string
  description: string
  status: string
  amount: number
  account: string
  category: string
  merchant: string
}

export interface ListResult {
  transactions: QueryTransactionRow[]
  total: number
  offset: number
  limit: number
}

// ---------------------------------------------------------------------------
// ck_list_transactions
// ---------------------------------------------------------------------------

export interface ListFilters {
  start_date?: string
  end_date?: string
  account?: string
  category?: string
  merchant?: string
  status?: string
  min_amount?: number
  max_amount?: number
  limit?: number
  offset?: number
}

export async function handleListTransactions(args: ListFilters, ctx: AppContext): Promise<ListResult> {
  return queryTransactions(ctx.db, args)
}

function queryTransactions(db: Database, filters: ListFilters): ListResult {
  const { where, params } = buildWhere(filters)
  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
  `).get(...params) as { count: number }

  const rows = db.prepare(`
    SELECT t.id, t.date, t.description, t.status, t.amount,
           COALESCE(a.name, '') as account,
           COALESCE(c.name, '') as category,
           COALESCE(m.name, '') as merchant
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
    ORDER BY t.date DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as QueryTransactionRow[]

  return { transactions: rows, total: countRow.count, offset, limit }
}

function buildWhere(filters: ListFilters): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.start_date) { conditions.push('t.date >= ?'); params.push(filters.start_date) }
  if (filters.end_date) { conditions.push('t.date <= ?'); params.push(filters.end_date) }
  if (filters.account) { conditions.push('a.name LIKE ?'); params.push(`%${filters.account}%`) }
  if (filters.category) { conditions.push('c.name LIKE ?'); params.push(`%${filters.category}%`) }
  if (filters.merchant) { conditions.push('m.name LIKE ?'); params.push(`%${filters.merchant}%`) }
  if (filters.status) { conditions.push('t.status = ?'); params.push(filters.status) }
  if (filters.min_amount != null) { conditions.push('ABS(t.amount) >= ?'); params.push(filters.min_amount) }
  if (filters.max_amount != null) { conditions.push('ABS(t.amount) <= ?'); params.push(filters.max_amount) }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

// ---------------------------------------------------------------------------
// ck_get_recent_transactions
// ---------------------------------------------------------------------------

export interface RecentArgs {
  limit?: number
}

export async function handleGetRecentTransactions(args: RecentArgs, ctx: AppContext): Promise<ListResult> {
  return queryTransactions(ctx.db, { limit: args.limit ?? 25, offset: 0 })
}
```

- [ ] **Step 9.4: Run tests to verify list + recent pass**

```bash
npm test -- tests/tools/query.test.ts
```

Expected: Partial PASS (list + recent tests pass, aggregate tests fail — that's expected, implement those next)

- [ ] **Step 9.5: Commit list + recent tools**

```bash
git add src/tools/query.ts tests/tools/query.test.ts
git commit -m "feat: ck_list_transactions and ck_get_recent_transactions"
```

---

### Task 10: Aggregate Query Tools

**Files:**
- Modify: `src/tools/query.ts`
- Tests already written in `tests/tools/query.test.ts` — append tests below

- [ ] **Step 10.1: Add failing tests for aggregate tools**

Append to `tests/tools/query.test.ts`:

```typescript
describe('ck_get_spending_by_category', () => {
  let ctx: AppContext

  beforeEach(() => {
    const db = initDb(':memory:')
    seedDb(db)
    ctx = makeCtx(db)
  })

  it('returns spending totals by category (debits only)', async () => {
    const result = await handleGetSpendingByCategory({}, ctx)
    const categories = result.rows.map(r => r.category)
    expect(categories).toContain('Shopping')
    expect(categories).toContain('Food & Dining')
    // refund (positive amount) should NOT appear or should have correct sign
    const food = result.rows.find(r => r.category === 'Food & Dining')!
    expect(food.total).toBeGreaterThan(0)
  })

  it('filters by date range', async () => {
    const result = await handleGetSpendingByCategory({ start_date: '2024-02-01', end_date: '2024-02-28' }, ctx)
    const categories = result.rows.map(r => r.category)
    // Feb has: tx1 Starbucks/Food (-$5.50), tx2 Amazon/Shopping (-$99.99), tx5 Starbucks/Food (-$6.00)
    // Target (Shopping, tx3) is Jan — should NOT appear as a Shopping entry for Feb... but Amazon IS feb
    expect(categories).toContain('Shopping')   // Amazon tx2 is 2024-02-11
    expect(categories).toContain('Food & Dining')
    // tx3 (Target, Jan) is excluded — verify Shopping total is only Amazon, not Amazon+Target
    const shopping = result.rows.find(r => r.category === 'Shopping')!
    expect(shopping.count).toBe(1)  // only Amazon (tx2), not Target (tx3 is Jan)
  })

  it('filters by account', async () => {
    const result = await handleGetSpendingByCategory({ account: 'Amex' }, ctx)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].category).toBe('Shopping')
  })

  it('returns rows sorted by total descending', async () => {
    const result = await handleGetSpendingByCategory({}, ctx)
    const totals = result.rows.map(r => r.total)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })

  it('includes count of transactions per category', async () => {
    const result = await handleGetSpendingByCategory({}, ctx)
    const food = result.rows.find(r => r.category === 'Food & Dining')!
    expect(food.count).toBe(2) // tx1 + tx5 (tx4 is credit, excluded)
  })
})

describe('ck_get_spending_by_merchant', () => {
  let ctx: AppContext

  beforeEach(() => {
    const db = initDb(':memory:')
    seedDb(db)
    ctx = makeCtx(db)
  })

  it('returns top merchants by debit spend', async () => {
    const result = await handleGetSpendingByMerchant({}, ctx)
    const names = result.rows.map(r => r.merchant)
    expect(names).toContain('Amazon')
    expect(names).toContain('Starbucks')
  })

  it('orders by total descending', async () => {
    const result = await handleGetSpendingByMerchant({}, ctx)
    const totals = result.rows.map(r => r.total)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })

  it('respects limit', async () => {
    const result = await handleGetSpendingByMerchant({ limit: 2 }, ctx)
    expect(result.rows).toHaveLength(2)
  })

  it('filters by category', async () => {
    const result = await handleGetSpendingByMerchant({ category: 'Shopping' }, ctx)
    const names = result.rows.map(r => r.merchant)
    expect(names).toContain('Amazon')
    expect(names).not.toContain('Starbucks')
  })
})

describe('ck_get_account_summary', () => {
  let ctx: AppContext

  beforeEach(() => {
    const db = initDb(':memory:')
    seedDb(db)
    ctx = makeCtx(db)
  })

  it('returns per-account debit/credit/net totals', async () => {
    const result = await handleGetAccountSummary({}, ctx)
    const chase = result.rows.find(r => r.account === 'Chase Checking')!
    expect(chase).toBeDefined()
    expect(chase.debits).toBeGreaterThan(0)
    expect(chase.credits).toBeGreaterThan(0)
  })

  it('calculates net as credits - debits', async () => {
    const result = await handleGetAccountSummary({}, ctx)
    for (const row of result.rows) {
      expect(Math.abs(row.net - (row.credits - row.debits))).toBeLessThan(0.01)
    }
  })

  it('filters by date range', async () => {
    const result = await handleGetAccountSummary({ start_date: '2024-02-01' }, ctx)
    const chase = result.rows.find(r => r.account === 'Chase Checking')!
    // Only Feb transactions for Chase: tx1 (-5.50), tx5 (-6.00) — tx4 is Jan
    expect(chase.debits).toBeCloseTo(11.50)
    expect(chase.credits).toBeCloseTo(0)
  })

  it('includes transaction count per account', async () => {
    const result = await handleGetAccountSummary({}, ctx)
    const chase = result.rows.find(r => r.account === 'Chase Checking')!
    expect(chase.count).toBe(4)  // tx1, tx3, tx4, tx5
  })
})
```

- [ ] **Step 10.2: Run tests to see aggregate tests fail**

```bash
npm test -- tests/tools/query.test.ts
```

Expected: Aggregate tests fail

- [ ] **Step 10.3: Implement aggregate tools in `src/tools/query.ts`**

Append to `src/tools/query.ts`:

```typescript
// ---------------------------------------------------------------------------
// ck_get_spending_by_category
// ---------------------------------------------------------------------------

export interface SpendingByCategoryArgs {
  start_date?: string
  end_date?: string
  account?: string
}

export interface SpendingByCategoryResult {
  rows: Array<{ category: string; total: number; count: number }>
}

export async function handleGetSpendingByCategory(
  args: SpendingByCategoryArgs,
  ctx: AppContext
): Promise<SpendingByCategoryResult> {
  const conditions: string[] = ['t.amount < 0']  // debits only
  const params: unknown[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }
  if (args.account) { conditions.push('a.name LIKE ?'); params.push(`%${args.account}%`) }

  const where = `WHERE ${conditions.join(' AND ')}`

  const rows = ctx.db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorized') as category,
           SUM(ABS(t.amount)) as total,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    ${where}
    GROUP BY c.id, c.name
    ORDER BY total DESC
  `).all(...params) as Array<{ category: string; total: number; count: number }>

  return { rows }
}

// ---------------------------------------------------------------------------
// ck_get_spending_by_merchant
// ---------------------------------------------------------------------------

export interface SpendingByMerchantArgs {
  start_date?: string
  end_date?: string
  category?: string
  limit?: number
}

export interface SpendingByMerchantResult {
  rows: Array<{ merchant: string; total: number; count: number }>
}

export async function handleGetSpendingByMerchant(
  args: SpendingByMerchantArgs,
  ctx: AppContext
): Promise<SpendingByMerchantResult> {
  const conditions: string[] = ['t.amount < 0']
  const params: unknown[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }
  if (args.category) { conditions.push('c.name LIKE ?'); params.push(`%${args.category}%`) }

  const where = `WHERE ${conditions.join(' AND ')}`
  const limit = args.limit ?? 25

  const rows = ctx.db.prepare(`
    SELECT COALESCE(m.name, 'Unknown') as merchant,
           SUM(ABS(t.amount)) as total,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
    GROUP BY m.id, m.name
    ORDER BY total DESC
    LIMIT ?
  `).all(...params, limit) as Array<{ merchant: string; total: number; count: number }>

  return { rows }
}

// ---------------------------------------------------------------------------
// ck_get_account_summary
// ---------------------------------------------------------------------------

export interface AccountSummaryArgs {
  start_date?: string
  end_date?: string
}

export interface AccountSummaryResult {
  rows: Array<{ account: string; debits: number; credits: number; net: number; count: number }>
}

export async function handleGetAccountSummary(
  args: AccountSummaryArgs,
  ctx: AppContext
): Promise<AccountSummaryResult> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = ctx.db.prepare(`
    SELECT COALESCE(a.name, 'Unknown') as account,
           SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as debits,
           SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as credits,
           SUM(t.amount) as net,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    ${where}
    GROUP BY a.id, a.name
    ORDER BY debits DESC
  `).all(...params) as Array<{ account: string; debits: number; credits: number; net: number; count: number }>

  return { rows }
}
```

Also append tool definitions:

```typescript
export const queryToolDefinitions = [
  {
    name: 'ck_list_transactions',
    description: 'List transactions with optional filters. Paginated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string', description: 'Partial account name match' },
        category: { type: 'string', description: 'Partial category name match' },
        merchant: { type: 'string', description: 'Partial merchant name match' },
        status: { type: 'string', description: 'e.g. posted, pending, cancelled' },
        min_amount: { type: 'number', description: 'Minimum absolute amount' },
        max_amount: { type: 'number', description: 'Maximum absolute amount' },
        limit: { type: 'number', description: 'Default 50' },
        offset: { type: 'number', description: 'Default 0' }
      }
    }
  },
  {
    name: 'ck_get_recent_transactions',
    description: 'Return the N most recent transactions. Convenience shortcut for ck_list_transactions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Number of transactions to return (default 25)' }
      }
    }
  },
  {
    name: 'ck_get_spending_by_category',
    description: 'Group debit transactions by category and return totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string', description: 'Partial account name filter' }
      }
    }
  },
  {
    name: 'ck_get_spending_by_merchant',
    description: 'Return top merchants by total debit spend.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        category: { type: 'string', description: 'Partial category name filter' },
        limit: { type: 'number', description: 'Default 25' }
      }
    }
  },
  {
    name: 'ck_get_account_summary',
    description: 'Return per-account debit, credit, and net totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' }
      }
    }
  }
]
```

- [ ] **Step 10.4: Run all query tests**

```bash
npm test -- tests/tools/query.test.ts
```

Expected: PASS (all query tests)

- [ ] **Step 10.5: Commit**

```bash
git add src/tools/query.ts tests/tools/query.test.ts
git commit -m "feat: query tools (list, recent, by-category, by-merchant, account-summary)"
```

---

## Chunk 6: SQL Tool & MCP Wiring

### Task 11: `ck_query_sql`

**Files:**
- Create: `src/tools/sql.ts`
- Create: `tests/tools/sql.test.ts`

- [ ] **Step 11.1: Write failing tests**

Create `tests/tools/sql.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { handleQuerySql } from '../../src/tools/sql.js'
import { initDb, upsertAccount, upsertCategory, upsertMerchant, upsertTransaction } from '../../src/db.js'
import { CreditKarmaClient } from '../../src/client.js'
import type { AppContext } from '../../src/index.js'

function makeCtx(): AppContext {
  const db = initDb(':memory:')
  upsertAccount(db, { id: 'a1', name: 'Chase' })
  upsertCategory(db, { id: 'c1', name: 'Food' })
  upsertMerchant(db, { id: 'm1', name: 'Starbucks' })
  upsertTransaction(db, {
    id: 'tx1', date: '2024-01-10', description: 'Coffee', status: 'posted',
    amount: -5.00, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}'
  })
  return { client: new CreditKarmaClient(), db, mcpJsonPath: '/tmp/.mcp.json' }
}

describe('ck_query_sql', () => {
  let ctx: AppContext
  beforeEach(() => { ctx = makeCtx() })

  it('executes a SELECT query', async () => {
    const result = await handleQuerySql({ sql: 'SELECT * FROM transactions' }, ctx)
    expect(result.rows).toHaveLength(1)
    expect(result.count).toBe(1)
    expect((result.rows[0] as { id: string }).id).toBe('tx1')
  })

  it('rejects non-SELECT statements', async () => {
    await expect(handleQuerySql({ sql: 'DROP TABLE transactions' }, ctx))
      .rejects.toThrow('Only SELECT statements are allowed')
  })

  it('rejects INSERT statements', async () => {
    await expect(handleQuerySql({ sql: "INSERT INTO transactions VALUES ('x','2024-01-01','d','s',0,'a','c','m','{}')" }, ctx))
      .rejects.toThrow('Only SELECT statements are allowed')
  })

  it('rejects UPDATE statements', async () => {
    await expect(handleQuerySql({ sql: "UPDATE transactions SET status = 'x'" }, ctx))
      .rejects.toThrow('Only SELECT statements are allowed')
  })

  it('rejects DELETE statements', async () => {
    await expect(handleQuerySql({ sql: 'DELETE FROM transactions' }, ctx))
      .rejects.toThrow('Only SELECT statements are allowed')
  })

  it('blocks non-SELECT even with leading whitespace/comments', async () => {
    await expect(handleQuerySql({ sql: '  -- comment\nDROP TABLE transactions' }, ctx))
      .rejects.toThrow('Only SELECT statements are allowed')
  })

  it('allows SELECT with JOINs', async () => {
    const result = await handleQuerySql({
      sql: `
        SELECT t.id, a.name as account FROM transactions t
        LEFT JOIN accounts a ON t.account_id = a.id
      `
    }, ctx)
    expect(result.rows).toHaveLength(1)
    expect((result.rows[0] as { account: string }).account).toBe('Chase')
  })

  it('returns empty rows array for SELECT with no results', async () => {
    const result = await handleQuerySql({ sql: "SELECT * FROM transactions WHERE id = 'nope'" }, ctx)
    expect(result.rows).toHaveLength(0)
    expect(result.count).toBe(0)
  })

  it('surfaces SQL errors with a clear message', async () => {
    await expect(handleQuerySql({ sql: 'SELECT * FROM nonexistent_table' }, ctx))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 11.2: Run tests to verify they fail**

```bash
npm test -- tests/tools/sql.test.ts
```

Expected: FAIL — `handleQuerySql` not found

- [ ] **Step 11.3: Implement `src/tools/sql.ts`**

```typescript
import type { AppContext } from '../index.js'

export interface QuerySqlArgs {
  sql: string
}

export interface QuerySqlResult {
  rows: Record<string, unknown>[]
  count: number
}

export async function handleQuerySql(args: QuerySqlArgs, ctx: AppContext): Promise<QuerySqlResult> {
  const trimmed = args.sql.replace(/--[^\n]*/g, '').trim()

  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed.')
  }

  const rows = ctx.db.prepare(args.sql).all() as Record<string, unknown>[]
  return { rows, count: rows.length }
}

export const sqlToolDefinitions = [
  {
    name: 'ck_query_sql',
    description:
      'Execute a raw SQL SELECT query against the transactions database. ' +
      'Non-SELECT statements (INSERT, UPDATE, DELETE, DROP, etc.) are rejected. ' +
      'Tables: transactions, accounts, categories, merchants, sync_state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A SELECT SQL statement' }
      },
      required: ['sql']
    }
  }
]
```

- [ ] **Step 11.4: Run tests to verify they pass**

```bash
npm test -- tests/tools/sql.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 11.5: Commit**

```bash
git add src/tools/sql.ts tests/tools/sql.test.ts
git commit -m "feat: ck_query_sql with SELECT-only guard"
```

---

### Task 12: MCP Server Wiring (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 12.1: Implement full `src/index.ts`**

Replace the stub with the full server:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'
import { join } from 'path'

import { CreditKarmaClient } from './client.js'
import { initDb } from './db.js'
import type { Database } from './db.js'

import { authToolDefinitions, handleSetToken, handleLogin, handleSubmitMfa } from './tools/auth.js'
import { syncToolDefinitions, handleSyncTransactions } from './tools/sync.js'
import {
  queryToolDefinitions,
  handleListTransactions, handleGetRecentTransactions,
  handleGetSpendingByCategory, handleGetSpendingByMerchant, handleGetAccountSummary
} from './tools/query.js'
import { sqlToolDefinitions, handleQuerySql } from './tools/sql.js'

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}

const allTools = [
  ...authToolDefinitions,
  ...syncToolDefinitions,
  ...queryToolDefinitions,
  ...sqlToolDefinitions
]

async function main() {
  const dbPath = process.env.CK_DB_PATH || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(process.cwd(), '.mcp.json')

  const ctx: AppContext = {
    client: new CreditKarmaClient(process.env.CK_TOKEN || undefined),
    db: initDb(dbPath),
    mcpJsonPath
  }

  const server = new Server(
    { name: 'creditkarma-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params

    const result = await dispatch(name, args as Record<string, unknown>, ctx)

    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function dispatch(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  switch (name) {
    // Auth
    case 'ck_set_token': return handleSetToken(args as { token: string }, ctx)
    case 'ck_login': return handleLogin(args as { username?: string; password?: string }, ctx)
    case 'ck_submit_mfa': return handleSubmitMfa(args as { code: string }, ctx)

    // Sync
    case 'ck_sync_transactions': return handleSyncTransactions(args as { force_full?: boolean }, ctx)

    // Query
    case 'ck_list_transactions': return handleListTransactions(args, ctx)
    case 'ck_get_recent_transactions': return handleGetRecentTransactions(args as { limit?: number }, ctx)
    case 'ck_get_spending_by_category': return handleGetSpendingByCategory(args, ctx)
    case 'ck_get_spending_by_merchant': return handleGetSpendingByMerchant(args, ctx)
    case 'ck_get_account_summary': return handleGetAccountSummary(args, ctx)

    // SQL
    case 'ck_query_sql': return handleQuerySql(args as { sql: string }, ctx)

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

main().catch(console.error)
```

- [ ] **Step 12.2: Run the full test suite**

```bash
npm test
```

Expected: PASS (all tests across all files)

- [ ] **Step 12.3: Build the project**

```bash
npm run build
```

Expected: No TypeScript errors, `dist/` directory created.

- [ ] **Step 12.4: Commit**

```bash
git add src/index.ts
git commit -m "feat: MCP server wiring — all 10 tools registered"
```

---

### Task 13: Coverage & Final Checks

- [ ] **Step 13.1: Run coverage report**

```bash
npm run test:coverage
```

Expected: 100% lines/functions/branches/statements on all `src/` files except `src/index.ts` (excluded).

If any coverage gaps are found, add the missing test cases before proceeding.

- [ ] **Step 13.2: Extract GraphQL query from Ruby script**

Open `/Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions` and find the GraphQL query string. Replace the `TRANSACTION_QUERY` placeholder in `src/client.ts` with the actual query.

Search the Ruby file for `graphql` or `query =` to locate it.

- [ ] **Step 13.3: Verify `.mcp.json` config path is correct for local usage**

The `mcpJsonPath` in `index.ts` uses `process.cwd()`. When running via `npx` or a global install, this may not point to the project directory. Confirm the path resolves correctly by running:

```bash
node -e "const {join} = require('path'); console.log(join(process.cwd(), '.mcp.json'))"
```

- [ ] **Step 13.4: Final commit**

```bash
git add -A
git commit -m "feat: complete creditkarma-mcp implementation"
```

---

## Implementation Notes

1. **CK auth endpoints (login/MFA):** The `login()` and `submitMfa()` methods in `src/client.ts` are stubs. To implement them, open Chrome DevTools on `creditkarma.com`, go to Network tab, filter by XHR/Fetch, and log in. Capture the auth POST requests and MFA submission. Fill in the endpoints, headers, and response parsing.

2. **GraphQL query:** Port the full query string from the Ruby script (Task 13.2). The Ruby file has the complete query with all fragments.

3. **`buildVariables` shape:** The Ruby script reveals the exact variable structure CK expects. Verify the `paginationInput` field names match what the Ruby script sends.

4. **Token persistence:** `ck_set_token` writes back to `.mcp.json` using `JSON.parse`/`JSON.stringify`. This reformats the file. If you have custom formatting, consider using a JSON library that preserves formatting, or accept the reformat.
