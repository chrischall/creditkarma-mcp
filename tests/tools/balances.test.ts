import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  refreshBalances, handleGetAccountBalances, registerBalanceTools, bureauFromEnv, STALE_DAYS,
} from '../../src/tools/balances.js'
import { CreditKarmaClient, type OperationSpec } from '../../src/client.js'
import { initDb, upsertAccount, upsertTransaction, attachUrn, upsertCreditReportAccount, setLinkedBalance } from '../../src/db.js'
import { VAULT_SEARCH_URL } from '../../src/vault.js'
import type { AppContext } from '../../src/index.js'
import { fakeServer } from '../helpers.js'
import {
  reportHistory, creditReport, tradeline, vaultAccount, vaultConnection, idxAuthResponse,
} from '../fixtures/balances.js'

type Handler = (variables: Record<string, unknown>) => unknown

const NOW = new Date('2024-02-15T12:00:00Z')
const URN = (s: string) => `urn:account:fdp::accountid:${s}`

/** Route CK GraphQL by operation name so tests describe CK, not call order. */
function stubCk(ctx: AppContext, handlers: Partial<Record<string, Handler>>) {
  return vi.spyOn(ctx.client, 'runOperation').mockImplementation(async (op: OperationSpec, variables) => {
    const h = handlers[op.operationName]
    if (!h) throw new Error(`unexpected operation ${op.operationName}`)
    return h(variables)
  })
}

/** Intuit's vault answers `connections`; any other URL is a test bug. */
function stubVault(connections: unknown, status = 200) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    if (!String(input).startsWith(VAULT_SEARCH_URL)) throw new Error(`unexpected fetch ${String(input)}`)
    return new Response(JSON.stringify(connections), { status })
  })
}

const card = vaultAccount({
  urn: URN('card'), masked: 'XXXXXXXXXXXX4321', nickName: 'Rewards Card', accountType: 'CREDITCARD',
  accountCategory: 'LINEOFCREDIT', balance: '1250.50', creditMaximumAmount: 10000, refreshedAt: '2024-02-15T09:00:00Z',
})
const checking = vaultAccount({ urn: URN('chk'), masked: 'XXXX1234', nickName: 'Everyday Checking', balance: '500.00' })
const mortgage = vaultAccount({ urn: URN('mtg'), masked: '7777', nickName: 'Mortgage', accountType: 'MORTGAGE', accountCategory: 'LOAN', balance: '' })

const ck = (over: Partial<Record<string, Handler>> = {}): Partial<Record<string, Handler>> => ({
  idxAuth: (v) => {
    expect(v).toEqual({ source: 'NETWORTH', origin: 'MANAGE_ACCOUNTS' })
    return idxAuthResponse('idx-token')
  },
  getCreditReportHistory: () => reportHistory(['2024-01-01T10:00:00Z', '2024-02-01T10:00:00Z'], ['2024-02-02T10:00:00Z']),
  getCreditReport: () => creditReport({
    creditCards: [
      tradeline({ hash: 'card1', institution: 'EXAMPLE CARD CO', balance: '900.00', limit: '10000.00', dateReported: '2024-01-25' }),
      tradeline({ hash: 'other', institution: 'Unlinked Bank', balance: '40.00', limit: '500.00', dateReported: '2024-01-20' }),
      tradeline({ hash: 'closed', institution: 'Old Card', balance: '0.00', limit: '100.00', isOpen: false }),
    ],
  }),
  ...over,
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

  it('stores linked cards from the vault with their limit, available credit and own refresh time', async () => {
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co', [card]), vaultConnection('Example Bank', [checking, mortgage])])

    const report = await refreshBalances(ctx, NOW)

    expect(report.linked).toEqual({ ok: true, updated: 2, no_balance: 1, removed: 0 })
    expect(row(URN('card'))).toMatchObject({
      name: 'Rewards Card', type: 'CREDITCARD', provider_name: 'Example Card Co', last4: '4321', account_urn: URN('card'),
      current_balance: -1250.5, credit_limit: 10000, available_balance: 8749.5,
      balance_as_of: '2024-02-15T09:00:00Z', balances_synced_at: NOW.toISOString(), balance_source: 'linked',
    })
    expect(row(URN('chk'))).toMatchObject({ current_balance: 500, credit_limit: null })
    expect(row(URN('mtg'))).toBeUndefined()
  })

  it('lands on the transaction account already holding the URN', async () => {
    upsertAccount(ctx.db, { id: 'Example Card Co|4321', name: 'Card', providerName: 'Example Card Co', display: 'Credit (..4321)' })
    attachUrn(ctx.db, 'Example Card Co|4321', URN('card'))
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co', [card])])
    await refreshBalances(ctx, NOW)
    expect(row('Example Card Co|4321')).toMatchObject({ name: 'Card', current_balance: -1250.5 })
    expect(row(URN('card'))).toBeUndefined()
  })

  it('keeps updating the row an earlier refresh created, even when a URN-less look-alike now exists', async () => {
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co', [card])])
    await refreshBalances(ctx, NOW)                       // creates the URN-keyed row
    upsertAccount(ctx.db, { id: 'Example Card Co|4321', name: 'Look-alike', providerName: 'Example Card Co', display: 'Credit (..4321)' })
    await refreshBalances(ctx, NOW)
    expect(row(URN('card'))).toMatchObject({ current_balance: -1250.5, balance_source: 'linked' })
    expect(row('Example Card Co|4321')).toMatchObject({ current_balance: null, account_urn: null })
  })

  it('finds a URN-less transaction account by institution and last4, and tags it with the URN', async () => {
    upsertAccount(ctx.db, { id: 'Example Card Co|4321', name: 'Card', providerName: 'Example Card Co', display: 'Credit (..4321)' })
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co   ', [card])])
    await refreshBalances(ctx, NOW)
    expect(row('Example Card Co|4321')).toMatchObject({ account_urn: URN('card'), current_balance: -1250.5 })
  })

  it('retires linked balances the vault no longer returns', async () => {
    setLinkedBalance(ctx.db, {
      id: 'Old|1', urn: URN('old'), name: 'Old', provider: 'Old', last4: null, type: 'SAVINGS',
      balance: 5, creditLimit: null, availableCredit: null, asOf: null, syncedAt: 'earlier',
    })
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Bank', [checking])])
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toMatchObject({ ok: true, removed: 1 })
    expect(row('Old|1')).toBeUndefined()
  })

  it('keeps the last known balance — going stale, not vanishing — when the vault returns that account with no balance', async () => {
    setLinkedBalance(ctx.db, {
      id: URN('chk'), urn: URN('chk'), name: 'Everyday Checking', provider: 'Example Bank', last4: '1234', type: 'CHECKING',
      balance: 480, creditLimit: null, availableCredit: null, asOf: '2024-02-01T00:00:00Z', syncedAt: 'earlier',
    })
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Bank', [vaultAccount({ urn: URN('chk'), masked: 'XXXX1234', balance: '' })])])

    const report = await refreshBalances(ctx, NOW)

    expect(report.linked).toEqual({ ok: true, updated: 0, no_balance: 1, removed: 0 })
    expect(row(URN('chk'))).toMatchObject({ current_balance: 480, balance_as_of: '2024-02-01T00:00:00Z', balance_source: 'linked' })
  })

  it('keeps a balance stored on a transaction account when the vault returns it blank', async () => {
    upsertAccount(ctx.db, { id: 'Example Bank|1234', name: 'Checking', providerName: 'Example Bank', display: 'Bank (..1234)' })
    attachUrn(ctx.db, 'Example Bank|1234', URN('chk'))
    setLinkedBalance(ctx.db, {
      id: 'Example Bank|1234', urn: URN('chk'), name: 'Checking', provider: 'Example Bank', last4: '1234', type: 'CHECKING',
      balance: 480, creditLimit: null, availableCredit: null, asOf: '2024-02-01T00:00:00Z', syncedAt: 'earlier',
    })
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Bank', [vaultAccount({ urn: URN('chk'), balance: '' })])])
    await refreshBalances(ctx, NOW)
    expect(row('Example Bank|1234')).toMatchObject({ current_balance: 480, balance_source: 'linked' })
  })

  it('reports — not throws — when idxAuth refuses, leaving stored linked balances alone', async () => {
    setLinkedBalance(ctx.db, {
      id: 'Kept|1', urn: URN('kept'), name: 'K', provider: 'K', last4: null, type: 'SAVINGS',
      balance: 5, creditLimit: null, availableCredit: null, asOf: null, syncedAt: 'earlier',
    })
    stubCk(ctx, ck({ idxAuth: () => idxAuthResponse(null, 'User not on trusted device') }))
    const fetchSpy = stubVault([])
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toEqual({ ok: false, error: 'idxAuth failed: User not on trusted device' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(row('Kept|1')).toBeDefined()
  })

  it('reports a vault HTTP failure', async () => {
    stubCk(ctx, ck())
    stubVault({ error: 'unauthorized' }, 401)
    const report = await refreshBalances(ctx, NOW)
    expect(report.linked).toMatchObject({ ok: false, error: expect.stringMatching(/Intuit vault search failed: HTTP 401/) })
  })

  it('stores open credit-report accounts as negative balances and drops closed ones', async () => {
    stubCk(ctx, ck())
    stubVault([])
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: true, bureau: 'transunion', report_date: '2024-02-01T10:00:00Z', updated: 2, removed: 0 })
    expect(row('cr:transunion:card1')).toMatchObject({ current_balance: -900, credit_limit: 10000, balance_as_of: '2024-01-25', balance_source: 'credit_report' })
    expect(row('cr:transunion:closed')).toBeUndefined()
  })

  it('removes a credit-report account that disappeared from the newest report', async () => {
    upsertCreditReportAccount(ctx.db, { key: 'cr:transunion:gone', institution: 'Gone', type: 'Credit Card', category: 'credit_card', currentBalance: -1, creditLimit: 1, asOf: '2023-12-01' }, 'earlier')
    stubCk(ctx, ck())
    stubVault([])
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toMatchObject({ ok: true, removed: 1 })
  })

  it('uses Equifax when CK_CREDIT_BUREAU says so', async () => {
    process.env.CK_CREDIT_BUREAU = 'equifax'
    const seen: unknown[] = []
    stubCk(ctx, ck({ getCreditReport: (v) => { seen.push(v); return creditReport({ creditCards: [tradeline({ hash: 'e1', balance: '1.00' })] }) } }))
    stubVault([])
    const report = await refreshBalances(ctx, NOW)
    expect(seen).toEqual([{ bureau: 2, date: '2024-02-02T10:00:00Z' }])
    expect(report.credit_report).toMatchObject({ bureau: 'equifax' })
    expect(row('cr:equifax:e1')).toBeDefined()
  })

  it('reports a credit-report failure without touching linked balances or stored report rows', async () => {
    upsertCreditReportAccount(ctx.db, { key: 'cr:transunion:kept', institution: 'Kept', type: 'Credit Card', category: 'credit_card', currentBalance: -1, creditLimit: 1, asOf: '2024-01-01' }, 'earlier')
    stubCk(ctx, ck({ getCreditReport: () => ({ errors: [{ message: 'An error occurred.' }] }) }))
    stubVault([vaultConnection('Example Bank', [checking])])
    const report = await refreshBalances(ctx, NOW)
    expect(report.credit_report).toEqual({ ok: false, error: 'getCreditReport failed: An error occurred.' })
    expect(report.linked).toMatchObject({ ok: true })
    expect(row('cr:transunion:kept')).toBeDefined()
  })

  it('reports a non-Error throw as text', async () => {
    stubCk(ctx, ck({ getCreditReportHistory: () => { throw 'plain string' } }))
    stubVault([])
    expect((await refreshBalances(ctx, NOW)).credit_report).toEqual({ ok: false, error: 'plain string' })
  })

  it('marks the credit-report row that duplicates a linked card as matched', async () => {
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co', [card])])
    const report = await refreshBalances(ctx, NOW)
    expect(report.matched).toBe(1)
    expect(row('cr:transunion:card1')!.matched_account_id).toBe(URN('card'))
    expect(row('cr:transunion:other')!.matched_account_id).toBeNull()
  })

  it('still matches against stored linked balances when the vault is down this time', async () => {
    setLinkedBalance(ctx.db, {
      id: URN('card'), urn: URN('card'), name: 'Rewards Card', provider: 'Example Card Co', last4: '4321', type: 'CREDITCARD',
      balance: -1100, creditLimit: 10000, availableCredit: 8900, asOf: '2024-02-14T09:00:00Z', syncedAt: 'earlier',
    })
    stubCk(ctx, ck({ idxAuth: () => { throw new Error('down') } }))
    const report = await refreshBalances(ctx, NOW)
    expect(report.matched).toBe(1)
  })

  it('rolls back a source\'s writes if storing them fails part-way', async () => {
    stubCk(ctx, ck())
    stubVault([])
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

  const linkedRow = (id: string, asOf: string | null) =>
    setLinkedBalance(ctx.db, {
      id, urn: `urn:${id}`, name: id, provider: 'Example Bank', last4: null, type: 'SAVINGS',
      balance: 100, creditLimit: null, availableCredit: null, asOf, syncedAt: '2024-02-15T00:00:00Z',
    })

  const seed = () => {
    linkedRow('Fresh', '2024-02-10T00:00:00Z')
    linkedRow('Old', '2024-02-01T00:00:00Z')
    linkedRow('Undated', null)
    upsertCreditReportAccount(ctx.db, { key: 'cr:transunion:a', institution: 'Example Card Co', type: 'Credit Card', category: 'credit_card', currentBalance: -250, creditLimit: 5000, asOf: '2024-01-20' }, '2024-02-15T00:00:00Z')
    upsertCreditReportAccount(ctx.db, { key: 'cr:transunion:b', institution: 'Old Lender', type: 'Auto Loan', category: 'auto_loan', currentBalance: -8000, creditLimit: null, asOf: '2023-12-01' }, '2024-02-15T00:00:00Z')
  }

  it('reads balances from the DB with a per-source stale flag', async () => {
    seed()
    const result = await handleGetAccountBalances({}, ctx, NOW)
    expect(result.refresh).toBeUndefined()
    expect(result.accounts.map(a => [a.id, a.stale])).toEqual([
      ['Fresh', false],             // linked, 5 days old
      ['Old', true],                // linked, 14 days > 7
      ['Undated', true],            // no as-of at all
      ['cr:transunion:a', false],   // credit report, 26 days < 35
      ['cr:transunion:b', true],    // credit report, 76 days > 35
    ])
    expect(result.accounts[3]).toEqual({
      id: 'cr:transunion:a', institution: 'Example Card Co', name: 'Example Card Co', type: 'Credit Card', last4: null,
      current_balance: -250, available_balance: null, credit_limit: 5000,
      balance_as_of: '2024-01-20', balances_synced_at: '2024-02-15T00:00:00Z', source: 'credit_report', matched_to: null, stale: false,
    })
  })

  it('pins the stale thresholds', () => {
    expect(STALE_DAYS).toEqual({ linked: 7, credit_report: 35 })
  })

  it('hides matched credit-report rows unless include_matched', async () => {
    seed()
    ctx.db.prepare("UPDATE accounts SET matched_account_id = 'Fresh' WHERE id = 'cr:transunion:a'").run()
    expect((await handleGetAccountBalances({}, ctx, NOW)).accounts.map(a => a.id)).not.toContain('cr:transunion:a')
    const all = await handleGetAccountBalances({ include_matched: true }, ctx, NOW)
    expect(all.accounts.find(a => a.id === 'cr:transunion:a')!.matched_to).toBe('Fresh')
  })

  it('refreshes live first when asked, and reports how that went', async () => {
    stubCk(ctx, ck())
    stubVault([vaultConnection('Example Card Co', [card])])
    const result = await handleGetAccountBalances({ refresh: true }, ctx, NOW)
    expect(result.refresh).toMatchObject({ linked: { ok: true }, credit_report: { ok: true }, matched: 1 })
    expect(result.accounts.map(a => a.id)).toEqual([URN('card'), 'cr:transunion:other'])
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

  it('keeps a transaction account\'s history when the vault stops returning it', async () => {
    upsertAccount(ctx.db, { id: 'Gone|1', name: 'g' })
    upsertTransaction(ctx.db, { id: 't', date: '2024-01-01', description: 'x', status: 'posted', amount: -1, accountId: 'Gone|1', categoryId: null, merchantId: null, rawJson: null })
    linkedRow('Gone|1', '2024-02-10T00:00:00Z')
    stubCk(ctx, ck())
    stubVault([])
    await handleGetAccountBalances({ refresh: true }, ctx, NOW)
    expect(ctx.db.prepare("SELECT balance_source FROM accounts WHERE id = 'Gone|1'").get()).toEqual({ balance_source: null })
  })

  it('registers the tool — not read-only, since refresh writes the local DB — and wraps the result', async () => {
    seed()
    const { server, calls } = fakeServer()
    registerBalanceTools(server, ctx)
    expect(calls.map(c => c.name)).toEqual(['ck_get_account_balances'])
    expect(calls[0].opts.inputSchema.shape).toHaveProperty('refresh')
    expect(calls[0].opts.inputSchema.shape).toHaveProperty('include_matched')
    expect(calls[0].opts.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true })
    const body = JSON.parse((await calls[0].handler({})).content[0].text)
    expect(body.accounts).toHaveLength(5)
  })
})
