import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  refreshBalances, handleGetAccountBalances, registerBalanceTools, bureauFromEnv,
  STALE_DAYS, LINKED_ACCOUNT_TYPES,
} from '../../src/tools/balances.js'
import { CreditKarmaClient, type OperationSpec } from '../../src/client.js'
import { initDb, upsertAccount, upsertTransaction, upsertCreditReportAccount, setLinkedBalance } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import { fakeServer } from '../helpers.js'
import {
  l2Page, linkedRow, attentionRow, investmentRow, idxConnections, reportHistory, creditReport, tradeline,
} from '../fixtures/balances.js'

type Handler = (variables: Record<string, unknown>) => unknown

/** Route runOperation by operation name so tests describe CK, not call order. */
function stubCk(ctx: AppContext, handlers: Partial<Record<string, Handler>>) {
  return vi.spyOn(ctx.client, 'runOperation').mockImplementation(async (op: OperationSpec, variables) => {
    const h = handlers[op.operationName]
    if (!h) throw new Error(`unexpected operation ${op.operationName}`)
    return h(variables)
  })
}

const NOW = new Date('2024-02-15T12:00:00Z')

const happyCk = (): Partial<Record<string, Handler>> => ({
  idxConnections: () => idxConnections([{ providerName: 'Example Bank', lastRefreshTimeStamp: '2024-02-15T09:00:00Z' }]),
  getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'cash'
    ? l2Page([
        linkedRow('Everyday Checking', '$1,234.56', 'Example Bank    (...1234)\n3 hr ago'),
        attentionRow('Family HSA', 'Sample Health (...4321)', '$9,000', 'Account needs attention'),
      ])
    : l2Page([]),
  getCreditReportHistory: () => reportHistory(['2024-01-01T10:00:00Z', '2024-02-01T10:00:00Z'], ['2024-02-02T10:00:00Z']),
  getCreditReport: (v) => {
    expect(v).toEqual({ bureau: 1, date: '2024-02-01T10:00:00Z' })
    return creditReport({
      creditCards: [
        tradeline({ hash: 'card1', institution: 'Example Card Co', balance: '250.00', limit: '5000.00', dateReported: '2024-01-25' }),
        tradeline({ hash: 'closed', institution: 'Old Card', balance: '0.00', limit: '100.00', isOpen: false }),
      ],
      autoLoans: [tradeline({ hash: 'car1', institution: 'Example Auto', accountType: 'Auto Loan', balance: '8000.00', dateReported: '2024-01-20' })],
    })
  },
})

describe('refreshBalances', () => {
  let ctx: AppContext
  let envBureau: string | undefined

  beforeEach(() => {
    ctx = { client: new CreditKarmaClient('valid-token'), db: initDb(':memory:') }
    envBureau = process.env.CK_CREDIT_BUREAU
    delete process.env.CK_CREDIT_BUREAU
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (envBureau === undefined) delete process.env.CK_CREDIT_BUREAU
    else process.env.CK_CREDIT_BUREAU = envBureau
  })

  const row = (id: string) => ctx.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined

  it('stores linked balances on the transaction account they belong to, with the exact refresh time', async () => {
    upsertAccount(ctx.db, { id: 'Example Bank|1234', name: 'Checking', providerName: 'Example Bank', display: 'Checking (..1234)' })
    stubCk(ctx, happyCk())

    const report = await refreshBalances(ctx, NOW)

    expect(report.linked).toEqual({ ok: true, updated: 2, unparsed: 0, dropped: 0 })
    expect(row('Example Bank|1234')).toMatchObject({
      name: 'Checking', current_balance: 1234.56, balance_as_of: '2024-02-15T09:00:00Z',
      balances_synced_at: NOW.toISOString(), balance_source: 'linked',
    })
  })

  it('lands on the existing transaction account when the page shows a shortened provider name', async () => {
    upsertAccount(ctx.db, { id: 'Example Bank Personal|1234', name: 'Checking', providerName: 'Example Bank Personal', display: 'Bank (..1234)' })
    stubCk(ctx, happyCk())
    await refreshBalances(ctx, NOW)
    expect(row('Example Bank Personal|1234')!.current_balance).toBe(1234.56)
    expect(row('Example Bank|1234')).toBeUndefined()
  })

  it('does not fetch the net-worth loans page — loans come from the credit report', async () => {
    const ops = stubCk(ctx, happyCk())
    await refreshBalances(ctx, NOW)
    expect(LINKED_ACCOUNT_TYPES).toEqual(['cash', 'investments', 'property'])
    const types = ops.mock.calls
      .filter(([op]) => op.operationName === 'getAccountL2Page')
      .map(([, v]) => (v.input as { accountType: string }).accountType)
    expect(types).toEqual(['cash', 'investments', 'property'])
  })

  it('creates a row for a linked account with no transactions, timing it from the relative age when no connection matches', async () => {
    stubCk(ctx, {
      ...happyCk(),
      getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'cash'
        ? l2Page([linkedRow('Savings', '$10', 'Other CU (...7777)\n2 hr ago')])
        : l2Page([]),
    })
    await refreshBalances(ctx, NOW)
    expect(row('Other CU|7777')).toMatchObject({ name: 'Savings', current_balance: 10, balance_as_of: '2024-02-15T10:00:00.000Z' })
  })

  it('lands a linked balance on the merge survivor via its alias', async () => {
    upsertAccount(ctx.db, { id: 'Survivor|1234', name: 's' })
    ctx.db.prepare("INSERT INTO account_aliases (alias, account_id) VALUES ('Example Bank|1234', 'Survivor|1234')").run()
    stubCk(ctx, happyCk())
    await refreshBalances(ctx, NOW)
    expect(row('Survivor|1234')!.current_balance).toBe(1234.56)
    expect(row('Example Bank|1234')).toBeUndefined()
  })

  it('times a truncated investment provider from its connection by prefix', async () => {
    stubCk(ctx, {
      ...happyCk(),
      idxConnections: () => idxConnections([{ providerName: 'Example Brokerage - Individual', lastRefreshTimeStamp: '2024-02-14T08:00:00Z' }]),
      getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'investments'
        ? l2Page([investmentRow('Brokerage', '$500', 'Example Brokerage - Ind... (...9876)', '▲ $5 (1.0%)')])
        : l2Page([]),
    })
    await refreshBalances(ctx, NOW)
    expect(row('Example Brokerage - Ind...|9876')).toMatchObject({ current_balance: 500, balance_as_of: '2024-02-14T08:00:00Z' })
  })

  it('skips a stale duplicate record and removes the row an earlier sync stored for it', async () => {
    // The row a previous version stored for the stale "(...8-01)" record.
    setLinkedBalance(ctx.db, {
      id: 'Example Brokerage - Ind...|8-01', name: 'College Plan', provider: 'Example Brokerage - Ind...',
      display: 'Example Brokerage - Ind... (...8-01)', last4: null, balance: 90, asOf: null, syncedAt: 'earlier',
    })
    stubCk(ctx, {
      ...happyCk(),
      getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'investments'
        ? l2Page([
            investmentRow('College Plan', '$100', 'Example Brokerage - Ind... (...6801)', '▲ $1 (1.0%)'),
            investmentRow('College Plan', '$90', 'Example Brokerage - Ind... (...8-01)', ''),
          ])
        : l2Page([]),
    })

    const report = await refreshBalances(ctx, NOW)

    expect(report.linked).toEqual({ ok: true, updated: 1, unparsed: 0, dropped: 1 })
    expect(row('Example Brokerage - Ind...|6801')!.current_balance).toBe(100)
    expect(row('Example Brokerage - Ind...|8-01')).toBeUndefined()
  })

  it('never deletes a dropped duplicate\'s row that has transactions', async () => {
    upsertAccount(ctx.db, { id: 'Example Brokerage - Ind...|8-01', name: 'College Plan' })
    upsertTransaction(ctx.db, { id: 't', date: '2024-01-01', description: 'x', status: 'posted', amount: 1, accountId: 'Example Brokerage - Ind...|8-01', categoryId: null, merchantId: null, rawJson: null })
    stubCk(ctx, {
      ...happyCk(),
      getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'investments'
        ? l2Page([
            investmentRow('College Plan', '$100', 'Example Brokerage - Ind... (...6801)', '▲ $1 (1.0%)'),
            investmentRow('College Plan', '$90', 'Example Brokerage - Ind... (...8-01)', ''),
          ])
        : l2Page([]),
    })
    await refreshBalances(ctx, NOW)
    expect(row('Example Brokerage - Ind...|8-01')).toBeDefined()
  })

  it('still records linked balances when idxConnections fails, using the relative age', async () => {
    stubCk(ctx, { ...happyCk(), idxConnections: () => { throw new Error('idx down') } })
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toMatchObject({ ok: true, updated: 2 })
    expect(row('Example Bank|1234')!.balance_as_of).toBe('2024-02-15T09:00:00.000Z')
  })

  it('reports rows it could not parse without failing the rest', async () => {
    stubCk(ctx, {
      ...happyCk(),
      getAccountL2Page: (v) => (v.input as { accountType: string }).accountType === 'cash'
        ? l2Page([
            { item: { views: [{ a: { text: 'Example Bank (...4444)' }, b: { text: '$1' }, c: { text: '+$2' } }] } },
            linkedRow('Fine', '$3', 'Example Bank (...5555)\n1 hr ago'),
          ])
        : l2Page([]),
    })
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toEqual({ ok: true, updated: 1, unparsed: 1, dropped: 0 })
  })

  it('writes NO linked balances if any account-type page fails', async () => {
    stubCk(ctx, {
      ...happyCk(),
      getAccountL2Page: (v) => {
        if ((v.input as { accountType: string }).accountType === 'investments') throw new Error('HTTP 500: boom')
        return l2Page([linkedRow('Everyday Checking', '$1', 'Example Bank (...1234)\n1 hr ago')])
      },
    })
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toEqual({ ok: false, error: 'HTTP 500: boom' })
    expect(row('Example Bank|1234')).toBeUndefined()
  })

  it('stores open credit-report accounts as negative balances and drops closed ones', async () => {
    stubCk(ctx, happyCk())
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: true, bureau: 'transunion', report_date: '2024-02-01T10:00:00Z', updated: 2, removed: 0 })
    expect(row('cr:transunion:card1')).toMatchObject({
      name: 'Example Card Co', current_balance: -250, credit_limit: 5000, balance_as_of: '2024-01-25', balance_source: 'credit_report',
    })
    expect(row('cr:transunion:car1')).toMatchObject({ current_balance: -8000, credit_limit: null })
    expect(row('cr:transunion:closed')).toBeUndefined()
  })

  it('removes a credit-report account that disappeared from the newest report', async () => {
    upsertCreditReportAccount(ctx.db, {
      key: 'cr:transunion:gone', institution: 'Gone', type: 'Credit Card', category: 'credit_card',
      currentBalance: -1, creditLimit: 1, asOf: '2023-12-01',
    }, 'earlier')
    stubCk(ctx, happyCk())
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toMatchObject({ ok: true, removed: 1 })
    expect(row('cr:transunion:gone')).toBeUndefined()
  })

  it('uses Equifax when CK_CREDIT_BUREAU says so', async () => {
    process.env.CK_CREDIT_BUREAU = 'equifax'
    const seen: unknown[] = []
    stubCk(ctx, {
      ...happyCk(),
      getCreditReportHistory: () => reportHistory(['2024-02-01T10:00:00Z'], ['2024-02-02T10:00:00Z']),
      getCreditReport: (v) => { seen.push(v); return creditReport({ creditCards: [tradeline({ hash: 'e1', balance: '1.00' })] }) },
    })
    const report = await refreshBalances(ctx, NOW)
    expect(seen).toEqual([{ bureau: 2, date: '2024-02-02T10:00:00Z' }])
    expect(row('cr:equifax:e1')).toBeDefined()
    expect(report.credit_report).toMatchObject({ bureau: 'equifax' })
  })

  it('reports a credit-report failure without touching linked balances or stored report rows', async () => {
    upsertCreditReportAccount(ctx.db, {
      key: 'cr:transunion:kept', institution: 'Kept', type: 'Credit Card', category: 'credit_card',
      currentBalance: -1, creditLimit: 1, asOf: '2024-01-01',
    }, 'earlier')
    stubCk(ctx, { ...happyCk(), getCreditReport: () => ({ errors: [{ message: 'An error occurred.' }] }) })
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: false, error: 'getCreditReport failed: An error occurred.' })
    expect(report.linked).toMatchObject({ ok: true })
    expect(row('cr:transunion:kept')).toBeDefined()
  })

  it('reports a non-Error throw as text', async () => {
    stubCk(ctx, { ...happyCk(), getCreditReportHistory: () => { throw 'plain string' } })
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: false, error: 'plain string' })
  })

  it('rolls back a source\'s writes if storing them fails part-way', async () => {
    stubCk(ctx, happyCk())
    const realPrepare = ctx.db.prepare.bind(ctx.db)
    let n = 0
    vi.spyOn(ctx.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("'credit_report')") && sql.includes('INSERT') && ++n === 2) throw new Error('disk full')
      return realPrepare(sql)
    })
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: false, error: 'disk full' })
    expect(row('cr:transunion:card1')).toBeUndefined()
  })
})

describe('bureauFromEnv', () => {
  afterEach(() => { delete process.env.CK_CREDIT_BUREAU })
  it.each([
    [undefined, 'transunion'], ['', 'transunion'], ['TransUnion', 'transunion'],
    ['equifax', 'equifax'], [' EQUIFAX ', 'equifax'], ['experian', 'transunion'],
  ])('%s → %s', (value, expected) => {
    if (value === undefined) delete process.env.CK_CREDIT_BUREAU
    else process.env.CK_CREDIT_BUREAU = value
    expect(bureauFromEnv()).toBe(expected)
  })
})

describe('ck_get_account_balances', () => {
  let ctx: AppContext
  beforeEach(() => { ctx = { client: new CreditKarmaClient('valid-token'), db: initDb(':memory:') } })
  afterEach(() => vi.restoreAllMocks())

  const seed = () => {
    setLinkedBalance(ctx.db, {
      id: 'Example Bank|1234', name: 'Checking', provider: 'Example Bank', display: 'Example Bank (...1234)',
      last4: '1234', balance: 100, asOf: '2024-02-10T00:00:00Z', syncedAt: '2024-02-15T00:00:00Z',
    })
    setLinkedBalance(ctx.db, {
      id: 'Old CU|5555', name: 'Old Savings', provider: 'Old CU', display: 'Old CU (...5555)',
      last4: '5555', balance: 5, asOf: '2024-02-01T00:00:00Z', syncedAt: '2024-02-15T00:00:00Z',
    })
    setLinkedBalance(ctx.db, {
      id: 'Unknown|6666', name: 'No Date', provider: 'Unknown', display: 'Unknown (...6666)',
      last4: '6666', balance: 1, asOf: null, syncedAt: '2024-02-15T00:00:00Z',
    })
    upsertCreditReportAccount(ctx.db, {
      key: 'cr:transunion:a', institution: 'Example Card Co', type: 'Credit Card', category: 'credit_card',
      currentBalance: -250, creditLimit: 5000, asOf: '2024-01-20',
    }, '2024-02-15T00:00:00Z')
    upsertCreditReportAccount(ctx.db, {
      key: 'cr:transunion:b', institution: 'Old Lender', type: 'Auto Loan', category: 'auto_loan',
      currentBalance: -8000, creditLimit: null, asOf: '2023-12-01',
    }, '2024-02-15T00:00:00Z')
  }

  it('reads balances from the DB with a per-source stale flag', async () => {
    seed()
    const result = await handleGetAccountBalances({}, ctx, NOW)
    expect(result.refresh).toBeUndefined()
    expect(result.accounts.map(a => [a.id, a.stale])).toEqual([
      ['Example Bank|1234', false],   // linked, 5 days old
      ['Old CU|5555', true],          // linked, 14 days > 7
      ['Unknown|6666', true],         // no as-of at all
      ['cr:transunion:a', false],     // credit report, 26 days < 35
      ['cr:transunion:b', true],      // credit report, 76 days > 35
    ])
    expect(result.accounts[3]).toEqual({
      id: 'cr:transunion:a', institution: 'Example Card Co', name: 'Example Card Co', type: 'Credit Card', last4: null,
      current_balance: -250, available_balance: null, credit_limit: 5000,
      balance_as_of: '2024-01-20', balances_synced_at: '2024-02-15T00:00:00Z', source: 'credit_report', stale: false,
    })
  })

  it('pins the stale thresholds', () => {
    expect(STALE_DAYS).toEqual({ linked: 7, credit_report: 35 })
  })

  it('refreshes live first when asked, and reports how that went', async () => {
    stubCk(ctx, happyCk())
    const result = await handleGetAccountBalances({ refresh: true }, ctx, NOW)
    expect(result.refresh).toMatchObject({ linked: { ok: true }, credit_report: { ok: true } })
    expect(result.accounts.map(a => a.id)).toContain('cr:transunion:card1')
  })

  it('still returns stored balances when the refresh fails', async () => {
    seed()
    stubCk(ctx, {})
    const result = await handleGetAccountBalances({ refresh: true }, ctx, NOW)
    expect(result.refresh).toMatchObject({ linked: { ok: false }, credit_report: { ok: false } })
    expect(result.accounts).toHaveLength(5)
  })

  it('authenticates before refreshing when the client has no token', async () => {
    const anon: AppContext = { client: new CreditKarmaClient(), db: ctx.db }
    const prev = process.env.CK_DISABLE_FETCHPROXY
    process.env.CK_DISABLE_FETCHPROXY = '1'
    try {
      await expect(handleGetAccountBalances({ refresh: true }, anon, NOW)).rejects.toThrow()
    } finally {
      if (prev === undefined) delete process.env.CK_DISABLE_FETCHPROXY
      else process.env.CK_DISABLE_FETCHPROXY = prev
    }
  })

  it('registers the tool — not read-only, since refresh writes the local DB — and wraps the result', async () => {
    seed()
    const { server, calls } = fakeServer()
    registerBalanceTools(server, ctx)
    expect(calls.map(c => c.name)).toEqual(['ck_get_account_balances'])
    expect(calls[0].opts.inputSchema.shape).toHaveProperty('refresh')
    expect(calls[0].opts.annotations).toEqual({ readOnlyHint: false, idempotentHint: true })
    const body = JSON.parse((await calls[0].handler({})).content[0].text)
    expect(body.accounts).toHaveLength(5)
  })
})
