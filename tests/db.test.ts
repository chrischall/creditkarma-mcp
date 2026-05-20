import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync } from 'fs'
import {
  initDb,
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState, backfillAccountIds,
  type AccountRow, type CategoryRow, type MerchantRow, type TransactionRow
} from '../src/db.js'
import { DatabaseSync } from 'node:sqlite'

describe('initDb', () => {
  let db: DatabaseSync

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

  it('handles schema_version table existing but empty (version defaults to 0)', () => {
    // Manually create schema_version with no rows to exercise the `?? 0` branch
    const bare = new DatabaseSync(dbPath)
    bare.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)')
    bare.close()

    // initDb should detect version=0 (from ??) and run all migrations
    const db = initDb(dbPath)
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number }
    expect(row.version).toBe(1)
    db.close()
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

describe('backfillAccountIds', () => {
  let db: Database.Database
  beforeEach(() => { db = initDb(':memory:') })

  const seedBrokenTx = (id: string, account: { name: string, type?: string, providerName?: string, accountTypeAndNumberDisplay?: string }, txAcctId = '') => {
    upsertAccount(db, { id: txAcctId, name: account.name, type: account.type, providerName: account.providerName, display: account.accountTypeAndNumberDisplay })
    upsertTransaction(db, {
      id, date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: txAcctId, categoryId: null, merchantId: null,
      rawJson: JSON.stringify({ id, account: { id: '', ...account } })
    })
  }

  it('returns zero counts when nothing needs backfill', () => {
    upsertAccount(db, { id: 'real-id', name: 'X' })
    upsertTransaction(db, {
      id: 'tx1', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: 'real-id', categoryId: null, merchantId: null, rawJson: null
    })
    const result = backfillAccountIds(db)
    expect(result).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })

  it('rebuilds accounts and rewrites tx.account_id from raw_json', () => {
    seedBrokenTx('tx-ally', { name: 'Spending', type: 'BANK', providerName: 'Ally   ', accountTypeAndNumberDisplay: 'Bank (..7133)' })
    seedBrokenTx('tx-citi', { name: 'AAdvantage', type: 'CREDIT', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit (..2630)' })

    const result = backfillAccountIds(db)
    expect(result).toEqual({ txsUpdated: 2, accountsCreated: 2 })

    const accounts = db.prepare('SELECT id, name, provider_name FROM accounts ORDER BY id').all() as Array<{ id: string, name: string, provider_name: string }>
    expect(accounts).toEqual([
      { id: 'Ally|7133', name: 'Spending', provider_name: 'Ally   ' },
      { id: 'Citi|2630', name: 'AAdvantage', provider_name: 'Citi' }
    ])

    const txs = db.prepare('SELECT id, account_id FROM transactions ORDER BY id').all()
    expect(txs).toEqual([
      { id: 'tx-ally', account_id: 'Ally|7133' },
      { id: 'tx-citi', account_id: 'Citi|2630' }
    ])

    expect(db.prepare("SELECT COUNT(*) as n FROM accounts WHERE id = ''").get()).toEqual({ n: 0 })
  })

  it('is idempotent — second run reports zero', () => {
    seedBrokenTx('tx1', { name: 'X', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit (..2630)' })
    const first = backfillAccountIds(db)
    expect(first.txsUpdated).toBe(1)
    const second = backfillAccountIds(db)
    expect(second).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })

  it('groups display drift ("Credit" vs "Credit Card") under one account', () => {
    seedBrokenTx('tx1', { name: 'AAdvantage', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit (..2630)' })
    seedBrokenTx('tx2', { name: 'AAdvantage', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit Card (..2630)' })

    backfillAccountIds(db)
    const accounts = db.prepare('SELECT COUNT(*) as n FROM accounts').get() as { n: number }
    expect(accounts.n).toBe(1)
    const txs = db.prepare('SELECT DISTINCT account_id FROM transactions').all()
    expect(txs).toEqual([{ account_id: 'Citi|2630' }])
  })

  it('skips transactions with null raw_json (cannot recover)', () => {
    upsertAccount(db, { id: '', name: 'unknown' })
    upsertTransaction(db, {
      id: 'tx-orphan', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: '', categoryId: null, merchantId: null, rawJson: null
    })
    const result = backfillAccountIds(db)
    expect(result).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })

  it('skips transactions with unparseable raw_json', () => {
    upsertAccount(db, { id: '', name: 'unknown' })
    upsertTransaction(db, {
      id: 'tx-bad', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: '', categoryId: null, merchantId: null, rawJson: 'not json{{'
    })
    const result = backfillAccountIds(db)
    expect(result).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })

  it('skips raw_json that parses but lacks an account field', () => {
    upsertAccount(db, { id: '', name: 'unknown' })
    upsertTransaction(db, {
      id: 'tx-noaccount', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: '', categoryId: null, merchantId: null,
      rawJson: JSON.stringify({ id: 'tx-noaccount' })
    })
    expect(backfillAccountIds(db)).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })

  it('uses fallback defaults when raw_json.account fields are missing', () => {
    upsertAccount(db, { id: '', name: 'unknown' })
    upsertTransaction(db, {
      id: 'tx-bare', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: '', categoryId: null, merchantId: null,
      rawJson: JSON.stringify({ account: {} })
    })
    backfillAccountIds(db)
    const row = db.prepare("SELECT id, name, type, provider_name, display FROM accounts WHERE id = '|'").get() as { id: string, name: string, type: null, provider_name: null, display: null }
    expect(row).toEqual({ id: '|', name: '', type: null, provider_name: null, display: null })
  })

  it('rolls back if the rebuild throws mid-transaction', () => {
    seedBrokenTx('tx1', { name: 'Spending', providerName: 'Ally', accountTypeAndNumberDisplay: 'Bank (..7133)' })

    const realPrepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('UPDATE transactions SET account_id')) throw new Error('boom')
      return realPrepare(sql)
    })

    expect(() => backfillAccountIds(db)).toThrow('boom')
    spy.mockRestore()

    // Original broken state preserved: empty account row still present, tx still points at ''
    const acctCount = db.prepare("SELECT COUNT(*) as n FROM accounts WHERE id = ''").get() as { n: number }
    expect(acctCount.n).toBe(1)
    const tx = db.prepare('SELECT account_id FROM transactions WHERE id = ?').get('tx1') as { account_id: string }
    expect(tx.account_id).toBe('')
  })

  it('leaves transactions with non-empty CK-provided account_id untouched', () => {
    upsertAccount(db, { id: 'urn:account:real', name: 'real' })
    upsertTransaction(db, {
      id: 'tx-real', date: '2024-02-10', description: 'x', status: 'posted', amount: -1,
      accountId: 'urn:account:real', categoryId: null, merchantId: null,
      rawJson: JSON.stringify({ account: { id: 'urn:account:real', name: 'real' } })
    })
    const result = backfillAccountIds(db)
    expect(result).toEqual({ txsUpdated: 0, accountsCreated: 0 })
  })
})
