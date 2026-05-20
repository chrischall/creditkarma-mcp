import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleSyncTransactions, registerSyncTools } from '../../src/tools/sync.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb, getSyncState, setSyncState } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import type { TransactionPage } from '../../src/client.js'
import { fakeServer } from '../helpers.js'

const makeTx = (id: string, date: string, overrides = {}) => ({
  id, date, description: `Tx ${id}`, status: 'posted',
  amount: { value: -10, asCurrencyString: '-$10.00' },
  account: { id: 'a1', name: 'Chase', type: 'checking', providerName: 'Chase', accountTypeAndNumberDisplay: '...1234' },
  category: { id: 'c1', name: 'Food', type: 'expense' },
  merchant: { id: 'm1', name: 'Starbucks' },
  ...overrides
})

const makePage = (txs: ReturnType<typeof makeTx>[], hasNextPage = false, endCursor = 'end'): TransactionPage => ({
  transactions: txs as TransactionPage['transactions'],
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

    expect(typeof result).toBe('object')
    const r = result as { new: number; updated: number; total: number }
    expect(r.total).toBe(3)
    const count = ctx.db.prepare('SELECT COUNT(*) as n FROM transactions').get() as { n: number }
    expect(count.n).toBe(3)
  })

  it('returns new and updated counts', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')]))

    const first = await handleSyncTransactions({}, ctx) as { new: number; updated: number }
    expect(first.new).toBe(1)
    expect(first.updated).toBe(0)

    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(
      makePage([makeTx('tx1', '2024-02-10', { status: 'cancelled' })])
    )
    const second = await handleSyncTransactions({ force_full: true }, ctx) as { new: number; updated: number }
    expect(second.new).toBe(0)
    expect(second.updated).toBe(1)
  })

  it('saves last_sync_date after sync', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)
    expect(getSyncState(ctx.db, 'last_sync_date')).toBe('2024-02-15')
  })

  it('incremental sync stops when tx date is older than last_sync_date - 30 days', async () => {
    // Set last sync to 2024-02-01; cutoff = 2024-02-01 - 30 days = 2024-01-02
    setSyncState(ctx.db, 'last_sync_date', '2024-02-01')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      // tx2 date (2024-01-01) < cutoff (2024-01-02) — should stop after page 1
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10'), makeTx('tx2', '2024-01-01')], true, 'c1'))
      // second page should NOT be fetched

    await handleSyncTransactions({}, ctx)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('force_full fetches all pages regardless of date', async () => {
    setSyncState(ctx.db, 'last_sync_date', '2024-02-01')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2020-01-01')], true, 'c1'))
      .mockResolvedValueOnce(makePage([makeTx('tx2', '2019-01-01')]))

    await handleSyncTransactions({ force_full: true }, ctx)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('force_full ignores last_cursor and starts from beginning', async () => {
    setSyncState(ctx.db, 'last_cursor', 'some-cursor')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({ force_full: true }, ctx)

    // first call must have no cursor (start from beginning)
    expect(fetchSpy.mock.calls[0][0]).toBeUndefined()
  })

  it('saves last_cursor on TOKEN_EXPIRED mid-sync', async () => {
    vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')], true, 'cursor-checkpoint'))
      .mockRejectedValueOnce(new Error('TOKEN_EXPIRED'))

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('TOKEN_EXPIRED')
    expect(getSyncState(ctx.db, 'last_cursor')).toBe('cursor-checkpoint')
  })

  it('resumes from last_cursor if present', async () => {
    setSyncState(ctx.db, 'last_cursor', 'resume-here')

    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)

    expect(fetchSpy).toHaveBeenCalledWith('resume-here')
  })

  it('clears last_cursor on successful sync', async () => {
    setSyncState(ctx.db, 'last_cursor', 'resume-here')

    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([]))
    await handleSyncTransactions({}, ctx)

    expect(getSyncState(ctx.db, 'last_cursor')).toBeNull()
  })

  it('auto-refreshes token if expired and refresh token is available', async () => {
    vi.useRealTimers()
    const expiredClient = new CreditKarmaClient()  // no token
    expiredClient.setRefreshToken('my-refresh-token')
    ctx.client = expiredClient
    vi.spyOn(expiredClient, 'refreshAccessToken').mockResolvedValueOnce('new-access-token')
    vi.spyOn(expiredClient, 'fetchPage').mockResolvedValueOnce(makePage([]))

    await handleSyncTransactions({}, ctx)
    expect(expiredClient.refreshAccessToken).toHaveBeenCalled()
  })

  it('throws with instructions if token expired and no refresh token', async () => {
    ctx.client = new CreditKarmaClient()  // no token, no refresh token
    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('does not save last_cursor when first page fetch fails', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockRejectedValueOnce(new Error('TOKEN_EXPIRED'))
    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('TOKEN_EXPIRED')
    expect(getSyncState(ctx.db, 'last_cursor')).toBeNull()
  })

  it('refreshes mid-sync after TOKEN_EXPIRED and retries the page successfully', async () => {
    ctx.client.setRefreshToken('refresh-tok')
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValueOnce('new-access')
    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      .mockRejectedValueOnce(new Error('TOKEN_EXPIRED'))
      .mockResolvedValueOnce(makePage([makeTx('tx-after-refresh', '2024-02-10')]))

    const result = await handleSyncTransactions({}, ctx) as { total: number }
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.total).toBe(1)
  })

  it('saves last_cursor when a non-TOKEN_EXPIRED error happens mid-sync', async () => {
    vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')], true, 'cursor-mid'))
      .mockRejectedValueOnce(new Error('HTTP 500'))

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('HTTP 500')
    expect(getSyncState(ctx.db, 'last_cursor')).toBe('cursor-mid')
  })

  it('does not save last_cursor on first-page non-TOKEN_EXPIRED failure', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('HTTP 500')
    expect(getSyncState(ctx.db, 'last_cursor')).toBeNull()
  })

  it('synthesizes distinct account_id when CK returns empty ids for multiple accounts', async () => {
    const ally = makeTx('tx-ally', '2024-02-10', {
      account: { id: '', name: 'Spending', type: 'BANK', providerName: 'Ally   ', accountTypeAndNumberDisplay: 'Bank (..7133)' }
    })
    const citi = makeTx('tx-citi', '2024-02-10', {
      account: { id: '', name: 'AAdvantage', type: 'CREDIT', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit (..2630)' }
    })
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([ally, citi]))

    await handleSyncTransactions({}, ctx)

    const accounts = ctx.db.prepare('SELECT id FROM accounts ORDER BY id').all() as Array<{ id: string }>
    expect(accounts.map(a => a.id)).toEqual(['Ally|7133', 'Citi|2630'])

    const txs = ctx.db.prepare('SELECT id, account_id FROM transactions ORDER BY id').all() as Array<{ id: string, account_id: string }>
    expect(txs).toEqual([
      { id: 'tx-ally', account_id: 'Ally|7133' },
      { id: 'tx-citi', account_id: 'Citi|2630' }
    ])
  })

  it('upserts transactions whose category or merchant is null', async () => {
    const tx = makeTx('tx-orphan', '2024-02-10', { category: null, merchant: null })
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([tx]))

    await handleSyncTransactions({}, ctx)
    const row = ctx.db.prepare('SELECT category_id, merchant_id FROM transactions WHERE id = ?').get('tx-orphan') as { category_id: string | null; merchant_id: string | null }
    expect(row.category_id).toBeNull()
    expect(row.merchant_id).toBeNull()
  })

  it('continues paging when oldest tx on the page is still inside the cutoff window', async () => {
    setSyncState(ctx.db, 'last_sync_date', '2024-02-01') // cutoff = 2024-01-02
    const fetchSpy = vi.spyOn(ctx.client, 'fetchPage')
      .mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10'), makeTx('tx2', '2024-01-15')], true, 'c1'))
      .mockResolvedValueOnce(makePage([makeTx('tx3', '2024-01-10')]))

    await handleSyncTransactions({}, ctx)
    // oldest on page 1 (2024-01-15) is still > cutoff (2024-01-02), so page 2 must be fetched.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('rolls back the DB transaction if an upsert throws', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')]))
    // Force a failure inside the BEGIN/COMMIT block by replacing exec
    const realExec = ctx.db.exec.bind(ctx.db)
    let beginSeen = false
    vi.spyOn(ctx.db, 'exec').mockImplementation((sql: string) => {
      if (sql === 'BEGIN') { beginSeen = true; return realExec(sql) }
      if (sql === 'COMMIT' && beginSeen) { throw new Error('boom') }
      return realExec(sql)
    })

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow('boom')
    // After rollback, no row should be committed
    const count = ctx.db.prepare('SELECT COUNT(*) as n FROM transactions').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('registerSyncTools', () => {
  let ctx: AppContext
  beforeEach(() => {
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

  it('registers ck_sync_transactions with the expected schema', () => {
    const { server, calls } = fakeServer()
    registerSyncTools(server, ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('ck_sync_transactions')
    expect(calls[0].opts.inputSchema).toHaveProperty('force_full')
  })

  it('wraps the SyncResult as JSON-stringified MCP text content', async () => {
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValueOnce(makePage([makeTx('tx1', '2024-02-10')]))
    const { server, calls } = fakeServer()
    registerSyncTools(server, ctx)

    const result = await calls[0].handler({})
    expect(result.content[0].type).toBe('text')
    const body = JSON.parse(result.content[0].text)
    expect(body).toMatchObject({ new: 1, updated: 0, total: 1 })
  })
})
