import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import {
  initDb,
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState,
  type AccountRow, type CategoryRow, type MerchantRow, type TransactionRow
} from '../src/db.js'
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
    // cleanup the parent dir
    rmSync(join(nestedPath, '..', '..'), { recursive: true, force: true })
  })
})

describe('upsertAccount', () => {
  let db: Database.Database

  beforeEach(() => { db = initDb(':memory:') })

  it('inserts a new account', () => {
    const account: AccountRow = { id: 'a1', name: 'Chase Checking', type: 'checking', providerName: 'Chase', display: 'Chase ...1234' }
    upsertAccount(db, account)
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get('a1') as AccountRow & { provider_name: string }
    expect(row.name).toBe('Chase Checking')
    expect(row.provider_name).toBe('Chase')
  })

  it('updates an existing account on conflict', () => {
    upsertAccount(db, { id: 'a1', name: 'Old Name' })
    upsertAccount(db, { id: 'a1', name: 'New Name' })
    const row = db.prepare('SELECT name FROM accounts WHERE id = ?').get('a1') as { name: string }
    expect(row.name).toBe('New Name')
  })

  it('inserts with optional fields as null', () => {
    upsertAccount(db, { id: 'a2', name: 'Basic' })
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get('a2') as { type: null; provider_name: null }
    expect(row.type).toBeNull()
    expect(row.provider_name).toBeNull()
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
