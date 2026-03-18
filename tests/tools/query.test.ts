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
