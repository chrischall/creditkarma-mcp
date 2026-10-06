/**
 * Credit-report balances: `getCreditReportHistory` → `getCreditReport`.
 *
 * Typed tradelines with numeric balances, limits and a `dateReported` for
 * cards and loans — but only as of the bureau's last report, typically 2–5
 * weeks old, and keyed by an opaque per-bureau `accountNumber` hash (CK's
 * `accountId` is literally the string "id" for every tradeline). Linked,
 * live balances come from the Intuit vault instead (`src/vault.ts`); a
 * credit-report row that is the same account as a linked one is marked
 * matched (`src/matching.ts`) rather than listed twice.
 *
 * Pure: the client fetches, these interpret.
 */
export type Bureau = 'transunion' | 'equifax'

/** The `bureau` variable CK's credit-report operations take. */
export const BUREAU_CODE: Record<Bureau, number> = { transunion: 1, equifax: 2 }

import { obj, throwOnGraphqlErrors } from './json.js'

// ---------------------------------------------------------------------------
// Credit report
// ---------------------------------------------------------------------------

/**
 * The newest report pull for `bureau`. `getCreditReport` only accepts one of
 * these exact timestamps — "now" or a bare date is rejected — so it has to be
 * read from the history first.
 */
export function newestReportDate(json: unknown, bureau: Bureau): string {
  throwOnGraphqlErrors(json, 'getCreditReportHistory')
  const reports = obj(obj(json)?.['data'])?.['creditReportsV2']
  const history = obj(obj(reports)?.[`${bureau}ReportHistory`])
  const dates = (Array.isArray(history?.['reportDates']) ? history['reportDates'] : [])
    .filter((d): d is string => typeof d === 'string' && d !== '')
  if (dates.length === 0) throw new Error(`Credit Karma has no ${bureau} credit reports for this account.`)
  return dates.reduce((a, b) => (b > a ? b : a))
}

export type TradelineCategory = 'credit_card' | 'auto_loan' | 'other_loan' | 'real_estate_loan' | 'student_loan'

const TRADELINE_GROUPS: Array<[string, TradelineCategory]> = [
  ['creditCards', 'credit_card'],
  ['autoLoans', 'auto_loan'],
  ['otherLoans', 'other_loan'],
  ['realEstateLoans', 'real_estate_loan'],
  ['studentLoans', 'student_loan'],
]

export interface CreditReportAccount {
  /** `cr:<bureau>:<accountNumber hash>` — stable across reports, NOT across bureaus. */
  key: string
  institution: string | null
  type: string
  category: TradelineCategory
  /** Negative: everything on a credit report is money owed. */
  currentBalance: number
  /** Cards only; positive. */
  creditLimit: number | null
  /** The tradeline's `dateReported` (YYYY-MM-DD); null when CK omits it. */
  asOf: string | null
}

function amountOf(v: unknown): number | null {
  const amount = obj(v)?.['amount']
  if (typeof amount !== 'string' || amount.trim() === '') return null
  const n = Number(amount)
  return Number.isFinite(n) ? n : null
}

/** Charge cards report a `0.00` limit, meaning "no preset limit", not zero. */
function positiveOrNull(n: number | null): number | null {
  return n !== null && n > 0 ? n : null
}

/** Open tradelines from a `getCreditReport` response. Closed ones are dropped. */
export function parseCreditReport(json: unknown, bureau: Bureau): CreditReportAccount[] {
  throwOnGraphqlErrors(json, 'getCreditReport')
  const report = obj(obj(obj(obj(json)?.['data'])?.['creditReportsV2'])?.['creditReport'])
  const tradelines = obj(report?.['tradelines'])
  if (!tradelines) throw new Error('getCreditReport response is missing `creditReport.tradelines`.')

  const accounts: CreditReportAccount[] = []
  for (const [group, category] of TRADELINE_GROUPS) {
    const list = tradelines[group]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const t = obj(raw)
      if (!t || t['isOpen'] !== true) continue
      const hash = t['accountNumber']
      const balance = amountOf(t['currentBalance'])
      if (typeof hash !== 'string' || hash === '' || balance === null) continue
      const institution = obj(t['institution'])?.['name']
      accounts.push({
        key: `cr:${bureau}:${hash}`,
        institution: typeof institution === 'string' ? institution : null,
        type: typeof t['accountType'] === 'string' ? t['accountType'] : category,
        category,
        currentBalance: balance === 0 ? 0 : -balance,
        creditLimit: category === 'credit_card' ? positiveOrNull(amountOf(t['limit'])) : null,
        asOf: typeof t['dateReported'] === 'string' && t['dateReported'] !== '' ? t['dateReported'] : null,
      })
    }
  }
  return accounts
}
