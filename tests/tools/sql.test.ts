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

  it('allows SELECT preceded by a block comment', async () => {
    const result = await handleQuerySql({ sql: '/* find all */ SELECT * FROM transactions' }, ctx)
    expect(result.rows).toHaveLength(1)
  })

  it('blocks non-SELECT preceded by a block comment', async () => {
    await expect(handleQuerySql({ sql: '/* oops */ DROP TABLE transactions' }, ctx))
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
