import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestHarness } from '@chrischall/mcp-utils/test'
import type { AppContext } from '../src/index.js'
import { CreditKarmaClient } from '../src/client.js'
import { initDb, upsertAccount, upsertCategory, upsertMerchant, upsertTransaction, type TransactionRow } from '../src/db.js'
import { registerHealthcheckTools } from '../src/tools/healthcheck.js'
import { registerAuthTools } from '../src/tools/auth.js'
import { registerSyncTools } from '../src/tools/sync.js'
import { registerQueryTools, briefLine } from '../src/tools/query.js'
import { registerSqlTools } from '../src/tools/sql.js'
import { registerBalanceTools } from '../src/tools/balances.js'

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * asserted against the served tool list — what a host actually sees.
 */
type Mint = {
  domain?: unknown; intent?: unknown; canonical?: unknown; subject?: unknown
  when?: { start?: unknown; end?: unknown }; aliases?: unknown
}
type Listed = {
  name: string
  annotations?: { readOnlyHint?: unknown }
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> }
  _meta?: { mint?: Mint }
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food']
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other']
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on']
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases']

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  ck_set_session: 'other',
  ck_forget_session: 'other',
  ck_sync_transactions: 'other',
  ck_list_transactions: 'whats-new',
  ck_get_recent_transactions: 'whats-new',
  ck_get_spending_by_category: 'lookup',
  ck_get_spending_by_merchant: 'lookup',
  ck_get_account_summary: 'lookup',
  ck_get_account_balances: 'lookup',
  ck_query_sql: 'lookup',
}

function seed(): AppContext {
  const db = initDb(':memory:')
  upsertAccount(db, { id: 'a1', name: 'Everyday Checking' })
  upsertCategory(db, { id: 'c1', name: 'Groceries' })
  upsertMerchant(db, { id: 'm1', name: 'Corner Market' })
  const txs: TransactionRow[] = [
    { id: 't1', date: '2026-11-02', description: 'CORNER MKT 0042', status: 'posted', amount: -42.1, accountId: 'a1', categoryId: 'c1', merchantId: 'm1', rawJson: '{}' },
    { id: 't2', date: '2026-11-03', description: 'Payroll deposit', status: 'pending', amount: 1500, accountId: 'a1', categoryId: null, merchantId: null, rawJson: '{}' },
    { id: 't3', date: '', description: 'X'.repeat(300), status: '', amount: -1, accountId: 'a1', categoryId: null, merchantId: null, rawJson: '{}' },
    { id: 't4', date: '2026-10-01', description: 'Older one', status: 'posted', amount: -3, accountId: 'a1', categoryId: null, merchantId: null, rawJson: '{}' },
  ]
  for (const tx of txs) upsertTransaction(db, tx)
  return { client: new CreditKarmaClient(), db }
}

let harness: Awaited<ReturnType<typeof createTestHarness>>
let tools: Listed[]

beforeAll(async () => {
  const ctx = seed()
  harness = await createTestHarness((s) => {
    registerHealthcheckTools(s, ctx)
    registerAuthTools(s, ctx)
    registerSyncTools(s, ctx)
    registerQueryTools(s, ctx)
    registerBalanceTools(s, ctx)
    registerSqlTools(s, ctx)
  })
  tools = (await harness.client.listTools()).tools as unknown as Listed[]
})
afterAll(async () => { if (harness) await harness.close() })

const hinted = () => tools.filter((t) => !t.name.endsWith('_healthcheck'))
const tool = (name: string) => tools.find((t) => t.name === name)!

describe('_meta.mint on tools/list', () => {
  it('names every served tool, so a new tool cannot skip the decision', () => {
    expect(hinted().map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort())
    expect(tool('ck_healthcheck')._meta?.mint).toBeUndefined()
  })

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain money and intent %s', (name, intent) => {
    const mint = tool(name)._meta?.mint
    expect(mint, name).toBeDefined()
    expect(mint!.domain).toBe('money')
    expect(mint!.intent).toBe(intent)
  })

  it('every hint is shaped per the host contract', () => {
    for (const t of hinted()) {
      const mint = t._meta!.mint!
      const props = t.inputSchema.properties ?? {}
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([])
      expect(DOMAINS, t.name).toContain(mint.domain)
      expect(INTENTS, t.name).toContain(mint.intent)
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true)
        expect(t.annotations?.readOnlyHint, t.name).toBe(true)
        expect(CANONICAL_INTENTS, t.name).toContain(mint.intent)
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string)
      if ('when' in mint) {
        expect(Object.keys(mint.when!).sort(), t.name).toEqual(['end', 'start'])
        expect(props, t.name).toHaveProperty(mint.when!.start as string)
        expect(props, t.name).toHaveProperty(mint.when!.end as string)
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[]
        expect(aliases.length, t.name).toBeGreaterThan(0)
        expect(aliases.length, t.name).toBeLessThanOrEqual(8)
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40)
          expect(a, t.name).toBe(a.toLowerCase())
        }
      }
    }
  })

  it('has at most one canonical read per what’s-new/due/on intent', () => {
    for (const intent of CANONICAL_INTENTS) {
      const canonical = hinted().filter((t) => t._meta!.mint!.intent === intent && t._meta!.mint!.canonical === true)
      expect(canonical.length, intent).toBeLessThanOrEqual(1)
    }
  })

  it('marks ck_list_transactions the one canonical read: whats-new over its date range, no subject', () => {
    const canonical = hinted().filter((t) => t._meta!.mint!.canonical === true).map((t) => t.name)
    expect(canonical).toEqual(['ck_list_transactions'])
    const mint = tool('ck_list_transactions')._meta!.mint!
    expect(mint).toMatchObject({
      domain: 'money', intent: 'whats-new', canonical: true,
      when: { start: 'start_date', end: 'end_date' },
    })
    // Accounts are listable, but a per-account fan-out would exceed the host's
    // sub-call cap for a typical account list, and a subject-bearing read with
    // no published enum is never called — so the canonical read takes none.
    expect(mint).not.toHaveProperty('subject')
    expect(tool('ck_list_transactions').inputSchema.properties).toHaveProperty('view')
  })
})

describe('ck_list_transactions view: brief', () => {
  const brief = async (args: Record<string, unknown> = {}) => {
    const res = await harness.callTool('ck_list_transactions', { view: 'brief', ...args })
    return (res.content as Array<{ text: string }>)[0]!.text.split('\n')
  }

  it('answers one line per item, ≤ 120 chars, shaped "title — <ISO date | no date> — <status>"', async () => {
    const lines = await brief()
    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120)
      expect(line).toMatch(/^.+ — (\d{4}-\d{2}-\d{2}|no date) — \S.*$/)
    }
  })

  it('titles a line by merchant (else description) and signed amount, and carries the status', async () => {
    const lines = await brief({ start_date: '2026-11-02', end_date: '2026-11-03' })
    expect(lines).toEqual([
      'Payroll deposit +$1,500.00 — 2026-11-03 — pending',
      'Corner Market -$42.10 — 2026-11-02 — posted',
    ])
  })

  it('shortens a long title and says "no date" / "no status" for a row that lacks them', async () => {
    const line = (await brief()).find((l) => l.includes('no date'))!
    expect(line.length).toBeLessThanOrEqual(120)
    expect(line).toMatch(/^X+… -\$1\.00 — no date — no status$/)
  })

  it('names a row with neither merchant nor description "(no description)"', () => {
    expect(briefLine({ id: 'x', date: '2026-11-01', description: '  ', status: 'posted', amount: 0, account: '', category: '', merchant: '' }))
      .toBe('(no description) +$0.00 — 2026-11-01 — posted')
  })

  it('answers empty text when nothing is in range', async () => {
    const res = await harness.callTool('ck_list_transactions', { view: 'brief', start_date: '2030-01-01' })
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe('')
  })

  it('keeps the full JSON answer by default', async () => {
    const res = await harness.callTool('ck_list_transactions', {})
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ total: 4 })
  })
})
