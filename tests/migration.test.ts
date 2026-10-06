import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { rmSync, mkdtempSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { initDb, MIGRATIONS } from '../src/db.js'

// Schema v1 exactly as shipped, so these tests migrate a database that looks
// like the ones users already have on disk. All data below is synthetic.
const V1_SCHEMA = `
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, provider_name TEXT, display TEXT);
  CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT);
  CREATE TABLE merchants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT NOT NULL, status TEXT,
    amount REAL NOT NULL, account_id TEXT REFERENCES accounts(id), category_id TEXT REFERENCES categories(id),
    merchant_id TEXT REFERENCES merchants(id), raw_json TEXT,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO schema_version VALUES (1);
`

interface SeedAccount { id: string; provider: string; display: string; name?: string }

function seedV1(path: string, accounts: SeedAccount[], txs: Array<{ id: string; account: string; urn?: string; date?: string }>): void {
  const db = new DatabaseSync(path)
  db.exec(V1_SCHEMA)
  for (const a of accounts) {
    db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)').run(a.id, a.name ?? 'Acct', 'credit', a.provider, a.display)
  }
  for (const t of txs) {
    const account = accounts.find(a => a.id === t.account)!
    const raw = { account: { id: '', providerName: account.provider, accountTypeAndNumberDisplay: account.display, ...(t.urn ? { accountURN: t.urn } : {}) } }
    db.prepare('INSERT INTO transactions (id, date, description, status, amount, account_id, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.date ?? '2024-01-01', 'x', 'posted', -1, t.account, JSON.stringify(raw))
  }
  db.close()
}

describe('schema v2 migration on an existing v1 database', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-migrate-'))
    path = join(dir, 'transactions.db')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const account = (db: DatabaseSync, id: string) =>
    db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined

  it('adds the balance columns and bumps the version, keeping existing rows', () => {
    seedV1(path, [{ id: 'Example Bank|1234', provider: 'Example Bank', display: 'Checking (..1234)' }], [])
    const db = initDb(path)
    const cols = (db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'account_urn', 'last4', 'current_balance', 'available_balance', 'credit_limit',
      'balance_as_of', 'balances_synced_at', 'balance_source', 'matched_account_id',
    ]))
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(3)
    expect(account(db, 'Example Bank|1234')).toMatchObject({ current_balance: null, balance_source: null })
    db.close()
  })

  it('trims padded provider names', () => {
    seedV1(path, [{ id: 'Padded Bank|1111', provider: 'Padded Bank   ', display: 'Bank (..1111)' }], [])
    const db = initDb(path)
    expect(account(db, 'Padded Bank|1111')!.provider_name).toBe('Padded Bank')
    db.close()
  })

  it('fills last4 from the display string and leaves garbage as NULL', () => {
    seedV1(path, [
      { id: 'A|2222', provider: 'A', display: 'Credit Card (..2222)' },
      { id: 'B|ount', provider: 'B', display: 'Bank (..ount)' },
    ], [])
    const db = initDb(path)
    expect(account(db, 'A|2222')!.last4).toBe('2222')
    expect(account(db, 'B|ount')!.last4).toBeNull()
    db.close()
  })

  it('backfills account_urn from transactions when the account has exactly one', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A', display: 'Card (..1111)' }], [
      { id: 't1', account: 'A|1111', urn: 'urn:account:fdp::accountid:test-1' },
      { id: 't2', account: 'A|1111', urn: 'urn:account:fdp::accountid:test-1' },
      { id: 't3', account: 'A|1111' },
    ])
    const db = initDb(path)
    expect(account(db, 'A|1111')!.account_urn).toBe('urn:account:fdp::accountid:test-1')
    db.close()
  })

  it('leaves account_urn NULL when an account carries two different URNs', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A', display: 'Card (..1111)' }], [
      { id: 't1', account: 'A|1111', urn: 'urn:account:fdp::accountid:test-1' },
      { id: 't2', account: 'A|1111', urn: 'urn:account:fdp::accountid:test-2' },
    ])
    const db = initDb(path)
    expect(account(db, 'A|1111')!.account_urn).toBeNull()
    db.close()
  })

  it('leaves account_urn NULL when one URN appears under two accounts', () => {
    seedV1(path, [
      { id: 'A|1111', provider: 'A', display: 'Card (..1111)' },
      { id: 'B|2222', provider: 'B', display: 'Card (..2222)' },
    ], [
      { id: 't1', account: 'A|1111', urn: 'urn:account:fdp::accountid:shared' },
      { id: 't2', account: 'B|2222', urn: 'urn:account:fdp::accountid:shared' },
    ])
    const db = initDb(path)
    expect(account(db, 'A|1111')!.account_urn).toBeNull()
    expect(account(db, 'B|2222')!.account_urn).toBeNull()
    db.close()
  })

  it('ignores transactions whose raw_json is not valid JSON', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A', display: 'Card (..1111)' }], [])
    const raw = new DatabaseSync(path)
    raw.prepare("INSERT INTO transactions (id, date, description, amount, account_id, raw_json) VALUES ('bad', '2024-01-01', 'x', -1, 'A|1111', '{not json')").run()
    raw.close()
    const db = initDb(path)
    expect(account(db, 'A|1111')!.account_urn).toBeNull()
    db.close()
  })

  describe('merging one card listed under two provider-name variants', () => {
    const seedVariants = () => seedV1(path, [
      { id: 'Sample Card Co|9999', provider: 'Sample Card Co', display: 'Credit (..9999)' },
      { id: 'Sample Card Co - Credit Cards|9999', provider: 'Sample Card Co - Credit Cards', display: 'Credit (..9999)' },
    ], [
      // The plain-named row has MORE transactions but the lexically LARGER id,
      // so this only passes if transaction count decides the survivor.
      { id: 't1', account: 'Sample Card Co|9999' },
      { id: 't2', account: 'Sample Card Co|9999' },
      { id: 't3', account: 'Sample Card Co - Credit Cards|9999' },
    ])

    it('folds the smaller row into the one with more transactions', () => {
      seedVariants()
      const db = initDb(path)
      expect(account(db, 'Sample Card Co - Credit Cards|9999')).toBeUndefined()
      const txAccounts = db.prepare('SELECT DISTINCT account_id FROM transactions').all() as Array<{ account_id: string }>
      expect(txAccounts).toEqual([{ account_id: 'Sample Card Co|9999' }])
      db.close()
    })

    it('records the retired id as an alias so a future sync lands on the survivor', () => {
      seedVariants()
      const db = initDb(path)
      const alias = db.prepare('SELECT account_id FROM account_aliases WHERE alias = ?').get('Sample Card Co - Credit Cards|9999') as { account_id: string }
      expect(alias.account_id).toBe('Sample Card Co|9999')
      db.close()
    })

    it('carries a URN from the retired row onto the survivor', () => {
      seedV1(path, [
        { id: 'Sample Card Co|9999', provider: 'Sample Card Co', display: 'Credit (..9999)' },
        { id: 'Sample Card Co - Credit Cards|9999', provider: 'Sample Card Co - Credit Cards', display: 'Credit (..9999)' },
      ], [
        { id: 't1', account: 'Sample Card Co|9999', urn: 'urn:account:fdp::accountid:only' },
        { id: 't2', account: 'Sample Card Co - Credit Cards|9999' },
        { id: 't3', account: 'Sample Card Co - Credit Cards|9999' },
      ])
      const db = initDb(path)
      expect(account(db, 'Sample Card Co - Credit Cards|9999')!.account_urn).toBe('urn:account:fdp::accountid:only')
      db.close()
    })

    it('breaks a transaction-count tie by keeping the lexically smaller id', () => {
      seedV1(path, [
        { id: 'Sample Card Co|9999', provider: 'Sample Card Co', display: 'Credit (..9999)' },
        { id: 'Sample Card Co - Credit Cards|9999', provider: 'Sample Card Co - Credit Cards', display: 'Credit (..9999)' },
      ], [])
      const db = initDb(path)
      expect(account(db, 'Sample Card Co - Credit Cards|9999')).toBeDefined()
      expect(account(db, 'Sample Card Co|9999')).toBeUndefined()
      db.close()
    })
  })

  it('breaks the tie the same way whichever row was inserted first', () => {
    seedV1(path, [
      { id: 'Sample Card Co - Credit Cards|9999', provider: 'Sample Card Co - Credit Cards', display: 'Credit (..9999)' },
      { id: 'Sample Card Co|9999', provider: 'Sample Card Co', display: 'Credit (..9999)' },
      { id: 'Sample Card Co - Rewards|9999', provider: 'Sample Card Co - Rewards', display: 'Credit (..9999)' },
    ], [])
    const db = initDb(path)
    const ids = (db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>).map(r => r.id)
    expect(ids).toEqual(['Sample Card Co - Credit Cards|9999'])
    db.close()
  })

  it('does NOT merge different institutions that share a last4', () => {
    seedV1(path, [
      { id: 'First Bank|5555', provider: 'First Bank', display: 'Credit (..5555)' },
      { id: 'Second Bank|5555', provider: 'Second Bank', display: 'Credit (..5555)' },
    ], [])
    const db = initDb(path)
    expect(account(db, 'First Bank|5555')).toBeDefined()
    expect(account(db, 'Second Bank|5555')).toBeDefined()
    db.close()
  })

  it('does NOT merge variants whose last4 is garbage', () => {
    seedV1(path, [
      { id: 'Sample Co|ount', provider: 'Sample Co', display: 'Bank (..ount)' },
      { id: 'Sample Co - HSA|ount', provider: 'Sample Co - HSA', display: 'Bank (..ount)' },
    ], [])
    const db = initDb(path)
    expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(2)
    db.close()
  })

  it('does NOT merge variants that carry two different URNs', () => {
    seedV1(path, [
      { id: 'Sample Card Co|9999', provider: 'Sample Card Co', display: 'Credit (..9999)' },
      { id: 'Sample Card Co - Credit Cards|9999', provider: 'Sample Card Co - Credit Cards', display: 'Credit (..9999)' },
    ], [
      { id: 't1', account: 'Sample Card Co|9999', urn: 'urn:account:fdp::accountid:one' },
      { id: 't2', account: 'Sample Card Co - Credit Cards|9999', urn: 'urn:account:fdp::accountid:two' },
    ])
    const db = initDb(path)
    expect((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(2)
    db.close()
  })

  it('rolls the whole migration back if a step fails, leaving the v1 database usable', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A  ', display: 'Card (..1111)' }], [])
    const original = MIGRATIONS[2]
    MIGRATIONS[2] = (db) => { original(db); throw new Error('boom') }
    try {
      expect(() => initDb(path)).toThrow('boom')
    } finally {
      MIGRATIONS[2] = original
    }
    const raw = new DatabaseSync(path)
    expect((raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(1)
    expect((raw.prepare("SELECT provider_name FROM accounts WHERE id = 'A|1111'").get() as { provider_name: string }).provider_name).toBe('A  ')
    raw.close()
    // And a clean retry succeeds.
    const db = initDb(path)
    expect(account(db, 'A|1111')!.provider_name).toBe('A')
    db.close()
  })

  it('upgrades a v2 database to v3 by adding matched_account_id, keeping balances', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A', display: 'Card (..1111)' }], [])
    const v2 = new DatabaseSync(path)
    v2.exec('BEGIN'); MIGRATIONS[2](v2); v2.exec('COMMIT')
    v2.prepare("UPDATE accounts SET current_balance = -5, balance_source = 'linked' WHERE id = 'A|1111'").run()
    v2.close()
    const db = initDb(path)
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(3)
    expect(account(db, 'A|1111')).toMatchObject({ current_balance: -5, balance_source: 'linked', matched_account_id: null })
    db.close()
  })

  it('is a no-op the second time', () => {
    seedV1(path, [{ id: 'A|1111', provider: 'A', display: 'Card (..1111)' }], [])
    initDb(path).close()
    const spy = vi.fn()
    const original = MIGRATIONS[2]
    MIGRATIONS[2] = spy
    try {
      initDb(path).close()
    } finally {
      MIGRATIONS[2] = original
    }
    expect(spy).not.toHaveBeenCalled()
  })
})
