import { z } from 'zod'
import { minifiedResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import { OPERATIONS } from '../client.js'
import {
  resolveAccountId, findAccountByProviderPrefix, setLinkedBalance, deleteStaleLinkedRow, upsertCreditReportAccount, pruneCreditReportAccounts, listBalances,
  type LinkedBalanceRow, type Database,
} from '../db.js'
import { deriveAccountId } from '../accountId.js'
import {
  BUREAU_CODE, newestReportDate, parseCreditReport, parseLinkedBalances, parseConnectionTimes,
  findConnectionTime, dropStaleDuplicates, relativeAgeToIso, type Bureau,
} from '../balances.js'
import { ensureAuthenticated } from './sync.js'

/**
 * Net-worth account types fetched for linked balances. Not `loans`: the credit
 * report already covers them with typed, signed amounts, and the net-worth
 * page's sign for a debt is unverified — fetching both could list one loan
 * twice, once with the wrong sign.
 */
export const LINKED_ACCOUNT_TYPES = ['cash', 'investments', 'property'] as const

/**
 * Days after `balance_as_of` that a balance counts as stale, per source.
 * Linked accounts refresh daily-ish, so a week is a real gap; bureaus get
 * card and loan balances about monthly, so anything inside ~5 weeks is normal.
 */
export const STALE_DAYS = { linked: 7, credit_report: 35 } as const

export type SourceReport<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string }

export interface BalanceRefreshReport {
  linked: SourceReport<{ updated: number; unparsed: number; dropped: number }>
  credit_report: SourceReport<{ bureau: Bureau; report_date: string; updated: number; removed: number }>
}

/** `CK_CREDIT_BUREAU` (`transunion` | `equifax`), defaulting to TransUnion. */
export function bureauFromEnv(): Bureau {
  return process.env.CK_CREDIT_BUREAU?.trim().toLowerCase() === 'equifax' ? 'equifax' : 'transunion'
}

/**
 * Fetch and store balances from both sources. Never throws: each source is
 * attempted independently and reported, so one CK outage can't sink the other
 * — or the transaction sync that calls this. Each source's writes are one DB
 * transaction, so a failure part-way never leaves a mix of old and new.
 */
export async function refreshBalances(ctx: AppContext, now = new Date()): Promise<BalanceRefreshReport> {
  const syncedAt = now.toISOString()
  return {
    linked: await attempt(() => refreshLinked(ctx, now, syncedAt)),
    credit_report: await attempt(() => refreshCreditReport(ctx, syncedAt)),
  }
}

async function attempt<T extends object>(fn: () => Promise<T>): Promise<SourceReport<T>> {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function refreshLinked(ctx: AppContext, now: Date, syncedAt: string) {
  // Exact refresh times are a nicety: without them each row's own "2 hr ago"
  // is close enough, so a failure here must not cost the balances.
  const times = await ctx.client.runOperation(OPERATIONS.idxConnections, {})
    .then(parseConnectionTimes, () => new Map<string, string>())

  const rows: LinkedBalanceRow[] = []
  const staleIds: string[] = []
  let unparsed = 0
  for (const accountType of LINKED_ACCOUNT_TYPES) {
    const page = parseLinkedBalances(
      await ctx.client.runOperation(OPERATIONS.getAccountL2Page, { input: { accountType } }),
    )
    unparsed += page.unparsed
    const { kept, dropped } = dropStaleDuplicates(page.rows)
    for (const r of dropped) {
      staleIds.push(resolveAccountId(ctx.db, deriveAccountId({ providerName: r.provider, accountTypeAndNumberDisplay: r.display })))
    }
    for (const r of kept) {
      const derived = deriveAccountId({ providerName: r.provider, accountTypeAndNumberDisplay: r.display })
      const resolved = resolveAccountId(ctx.db, derived)
      const exists = ctx.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(resolved) !== undefined
      rows.push({
        id: exists ? resolved : (findAccountByProviderPrefix(ctx.db, r.provider, r.last4) ?? resolved),
        name: r.name,
        provider: r.provider,
        display: r.display,
        last4: r.last4,
        balance: r.balance,
        asOf: findConnectionTime(times, r.provider) ?? relativeAgeToIso(r.relativeAge, now),
        syncedAt,
      })
    }
  }

  inTransaction(ctx.db, () => {
    rows.forEach(r => setLinkedBalance(ctx.db, r))
    // A row an earlier sync stored for a now-recognised stale record.
    staleIds.forEach(id => deleteStaleLinkedRow(ctx.db, id))
  })
  return { updated: rows.length, unparsed, dropped: staleIds.length }
}

async function refreshCreditReport(ctx: AppContext, syncedAt: string) {
  const bureau = bureauFromEnv()
  const code = BUREAU_CODE[bureau]
  const date = newestReportDate(await ctx.client.runOperation(OPERATIONS.getCreditReportHistory, { bureau: code }), bureau)
  const accounts = parseCreditReport(
    await ctx.client.runOperation(OPERATIONS.getCreditReport, { bureau: code, date }),
    bureau,
  )

  let removed = 0
  inTransaction(ctx.db, () => {
    for (const a of accounts) upsertCreditReportAccount(ctx.db, a, syncedAt)
    removed = pruneCreditReportAccounts(ctx.db, accounts.map(a => a.key))
  })
  return { bureau, report_date: date, updated: accounts.length, removed }
}

function inTransaction(db: Database, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ---------------------------------------------------------------------------
// ck_get_account_balances
// ---------------------------------------------------------------------------

export interface AccountBalance {
  id: string
  institution: string | null
  name: string
  type: string | null
  last4: string | null
  current_balance: number | null
  available_balance: number | null
  credit_limit: number | null
  balance_as_of: string | null
  balances_synced_at: string | null
  source: 'linked' | 'credit_report'
  stale: boolean
}

export interface GetAccountBalancesResult {
  accounts: AccountBalance[]
  /** Present only when `refresh` was requested. */
  refresh?: BalanceRefreshReport
}

export async function handleGetAccountBalances(
  args: { refresh?: boolean },
  ctx: AppContext,
  now = new Date(),
): Promise<GetAccountBalancesResult> {
  let refresh: BalanceRefreshReport | undefined
  if (args.refresh) {
    await ensureAuthenticated(ctx)
    refresh = await refreshBalances(ctx, now)
  }

  const accounts = listBalances(ctx.db).map(({ balance_source, ...r }): AccountBalance => ({
    ...r,
    source: balance_source,
    stale: isStale(r.balance_as_of, STALE_DAYS[balance_source], now),
  }))
  return { accounts, ...(refresh ? { refresh } : {}) }
}

function isStale(asOf: string | null, days: number, now: Date): boolean {
  const t = asOf ? Date.parse(asOf) : NaN
  return Number.isNaN(t) || now.getTime() - t > days * 86_400_000
}

export function registerBalanceTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_get_account_balances',
    {
      description:
        'Current balance of every account Credit Karma knows about: institution, type, last 4, ' +
        'current balance, available balance and credit limit where known, and the as-of time CK ' +
        'reports. Reads the local database (filled by ck_sync_transactions); pass refresh:true to ' +
        'fetch live first. Two sources, marked by `source`: "linked" accounts (bank, investment — ' +
        'refreshed by CK about daily) and "credit_report" accounts (cards, loans — as of the ' +
        'bureau\'s last report, typically 2–5 weeks old; no last 4). Liabilities are negative, ' +
        'matching transactions. `stale` is true past 7 days (linked) or 35 days (credit report).',
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: z.object({
        refresh: z.boolean().optional().describe(
          'Fetch balances live from Credit Karma before reading. Default false (local data only).',
        ),
      }),
    },
    async (args) => minifiedResult(await handleGetAccountBalances(args, ctx)),
  )
}
