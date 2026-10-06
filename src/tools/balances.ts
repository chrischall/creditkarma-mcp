import { z } from 'zod'
import { minifiedResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import { OPERATIONS } from '../client.js'
import {
  findAccountByUrn, findUnlinkedAccount, setLinkedBalance, pruneLinkedAccounts,
  upsertCreditReportAccount, pruneCreditReportAccounts, loadMatchSnapshots, setCreditReportMatches,
  listBalances, type LinkedBalanceRow, type Database,
} from '../db.js'
import { BUREAU_CODE, newestReportDate, parseCreditReport, type Bureau } from '../creditReport.js'
import { parseIdxAuthToken, parseVaultAccounts, searchVaultConnections, type VaultAccount } from '../vault.js'
import { matchCreditReportAccounts } from '../matching.js'
import { ensureAuthenticated } from './sync.js'

/**
 * Days after `balance_as_of` that a balance counts as stale, per source.
 * Linked accounts refresh daily-ish, so a week is a real gap; bureaus get
 * card and loan balances about monthly, so anything inside ~5 weeks is normal.
 */
export const STALE_DAYS = { linked: 7, credit_report: 35 } as const

/** What CK's Manage-accounts page asks idxAuth for. */
const IDX_AUTH_VARIABLES = { source: 'NETWORTH', origin: 'MANAGE_ACCOUNTS' }

export type SourceReport<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string }

export interface BalanceRefreshReport {
  /** Live balances from the Intuit vault, for every linked account. */
  linked: SourceReport<{ updated: number; no_balance: number; removed: number }>
  /** Weeks-old balances and limits from one bureau's credit report. */
  credit_report: SourceReport<{ bureau: Bureau; report_date: string; updated: number; removed: number }>
  /** Credit-report rows now hidden as duplicates of a linked account. */
  matched: number
}

/** `CK_CREDIT_BUREAU` (`transunion` | `equifax`), defaulting to TransUnion. */
export function bureauFromEnv(): Bureau {
  return process.env.CK_CREDIT_BUREAU?.trim().toLowerCase() === 'equifax' ? 'equifax' : 'transunion'
}

/**
 * Fetch and store balances from both sources, then pair duplicates. Never
 * throws: each source is attempted independently and reported, so one outage
 * can't sink the other — or the transaction sync that calls this. Each
 * source's writes are one DB transaction, so a failure part-way never leaves a
 * mix of old and new. Matching runs on whatever is stored, so a source that
 * failed this time still contributes its last known balances.
 */
export async function refreshBalances(ctx: AppContext, now = new Date()): Promise<BalanceRefreshReport> {
  const syncedAt = now.toISOString()
  const linked = await attempt(() => refreshLinked(ctx, syncedAt))
  const credit_report = await attempt(() => refreshCreditReport(ctx, syncedAt))
  return { linked, credit_report, matched: matchDuplicates(ctx.db) }
}

async function attempt<T extends object>(fn: () => Promise<T>): Promise<SourceReport<T>> {
  try {
    return { ok: true, ...(await fn()) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function refreshLinked(ctx: AppContext, syncedAt: string) {
  const token = parseIdxAuthToken(await ctx.client.runOperation(OPERATIONS.idxAuth, IDX_AUTH_VARIABLES))
  const accounts = parseVaultAccounts(await searchVaultConnections(token))

  const rows: LinkedBalanceRow[] = []
  for (const a of accounts) {
    if (a.balance === null) continue
    rows.push({
      id: accountIdFor(ctx.db, a),
      urn: a.urn,
      name: a.name,
      provider: a.provider,
      last4: a.last4,
      type: a.type,
      balance: a.balance,
      creditLimit: a.creditLimit,
      availableCredit: a.availableCredit,
      asOf: a.asOf,
      syncedAt,
    })
  }

  let removed = 0
  inTransaction(ctx.db, () => {
    rows.forEach(r => setLinkedBalance(ctx.db, r))
    removed = pruneLinkedAccounts(ctx.db, rows.map(r => r.id))
  })
  return { updated: rows.length, no_balance: accounts.length - rows.length, removed }
}

/**
 * The row a vault account's balance belongs on: the one already holding its
 * URN (transactions carry the same URN), else a URN-less transaction account
 * with the same institution and last4, else a new row keyed by the URN.
 */
function accountIdFor(db: Database, a: VaultAccount): string {
  return findAccountByUrn(db, a.urn) ?? findUnlinkedAccount(db, a.provider, a.last4) ?? a.urn
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

/** Mark credit-report rows that duplicate a linked account; returns how many. */
function matchDuplicates(db: Database): number {
  const { creditReport, linked } = loadMatchSnapshots(db)
  const matches = matchCreditReportAccounts(creditReport, linked)
  setCreditReportMatches(db, matches)
  return matches.size
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
  /** For a credit-report row: the linked account it duplicates (listed only with include_matched). */
  matched_to: string | null
  stale: boolean
}

export interface GetAccountBalancesResult {
  accounts: AccountBalance[]
  /** Present only when `refresh` was requested. */
  refresh?: BalanceRefreshReport
}

export async function handleGetAccountBalances(
  args: { refresh?: boolean; include_matched?: boolean },
  ctx: AppContext,
  now = new Date(),
): Promise<GetAccountBalancesResult> {
  let refresh: BalanceRefreshReport | undefined
  if (args.refresh) {
    await ensureAuthenticated(ctx)
    refresh = await refreshBalances(ctx, now)
  }

  const accounts = listBalances(ctx.db, { includeMatched: args.include_matched })
    .map(({ balance_source, ...r }): AccountBalance => ({
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
        'Current balance of every account: institution, type, last 4, current balance, available ' +
        'credit and credit limit (cards), and the as-of time. Reads the local database (filled by ' +
        'ck_sync_transactions); pass refresh:true to fetch live first. `source` "linked" = a linked ' +
        'bank, card, loan or investment account, live from the account aggregator (refreshed about ' +
        'daily). `source` "credit_report" = a card or loan from the credit report (2–5 weeks old, no ' +
        'last 4); one that duplicates a linked account is hidden unless include_matched:true. ' +
        'Liabilities are negative, matching transactions; available credit is limit minus balance. ' +
        '`stale` is true past 7 days (linked) or 35 days (credit report).',
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: z.object({
        refresh: z.boolean().optional().describe(
          'Fetch balances live before reading. Default false (local data only).',
        ),
        include_matched: z.boolean().optional().describe(
          'Also list credit-report rows that duplicate a linked account (each names it in matched_to). Default false.',
        ),
      }),
    },
    async (args) => minifiedResult(await handleGetAccountBalances(args, ctx)),
  )
}
