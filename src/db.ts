import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { deriveAccountId } from './accountId.js'

export type Database = DatabaseSync

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

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

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
  accountId: string | null
  categoryId: string | null
  merchantId: string | null
  rawJson: string | null
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

export function getSyncState(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSyncState(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/**
 * Repair transactions whose `account_id` is `''` (or NULL) by re-deriving the
 * id from each transaction's `raw_json.account` and rebuilding the accounts
 * table. Idempotent — returns zero counts if there's nothing to fix.
 *
 * Needed because CK's `transactionsHub` historically returned empty
 * `account.id` strings, collapsing every account into a single row.
 */
export function backfillAccountIds(db: Database): { txsUpdated: number, accountsCreated: number } {
  const rows = db
    .prepare("SELECT id, raw_json FROM transactions WHERE account_id IS NULL OR account_id = ''")
    .all() as Array<{ id: string, raw_json: string | null }>

  if (rows.length === 0) return { txsUpdated: 0, accountsCreated: 0 }

  const accounts = new Map<string, AccountRow>()
  const updates: Array<{ txId: string, accountId: string }> = []

  for (const row of rows) {
    if (!row.raw_json) continue
    let parsed: { account?: { id?: string, name?: string, type?: string, providerName?: string, accountTypeAndNumberDisplay?: string } }
    try {
      parsed = JSON.parse(row.raw_json)
    } catch {
      continue
    }
    if (!parsed.account) continue
    const accountId = deriveAccountId(parsed.account)
    accounts.set(accountId, {
      id: accountId,
      name: parsed.account.name ?? '',
      type: parsed.account.type ?? null,
      providerName: parsed.account.providerName ?? null,
      display: parsed.account.accountTypeAndNumberDisplay ?? null,
    })
    updates.push({ txId: row.id, accountId })
  }

  if (updates.length === 0) return { txsUpdated: 0, accountsCreated: 0 }

  db.exec('BEGIN')
  try {
    for (const acct of accounts.values()) upsertAccount(db, acct)
    const stmt = db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?')
    for (const u of updates) stmt.run(u.accountId, u.txId)
    db.prepare("DELETE FROM accounts WHERE id = ''").run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { txsUpdated: updates.length, accountsCreated: accounts.size }
}
