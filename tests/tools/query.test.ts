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

  it('treats % in filter as literal, not wildcard', async () => {
    const result = await handleListTransactions({ merchant: 'Star%ucks' }, ctx)
    expect(result.total).toBe(0) // no merchant literally named "Star%ucks"
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
