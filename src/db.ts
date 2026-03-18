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
