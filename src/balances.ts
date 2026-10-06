/**
 * Parsers for Credit Karma's account-balance responses.
 *
 * Two sources, because CK has no single structured balance API for the web:
 *
 * - **Credit report** (`getCreditReportHistory` → `getCreditReport`): typed
 *   tradelines with numeric balances, limits and a `dateReported`. Covers cards
 *   and loans, but only as of the bureau's last report — typically 2–5 weeks
 *   old — and keyed by an opaque per-bureau `accountNumber` hash (CK's
 *   `accountId` is literally the string "id" for every tradeline).
 *
 * - **Linked accounts** (`getAccountL2Page`): CK's server-driven net-worth UI.
 *   Balances exist only as display text, so rows are recovered by CONTENT, not
 *   by layout keys: the smallest node holding exactly one "Provider (...1234)"
 *   line and exactly one dollar amount is one account. That survives CK
 *   reordering a row's spans — "needs attention" rows already put the provider
 *   before the balance — and a provider line that can't be paired is counted,
 *   never guessed at. `idxConnections` supplies the exact refresh time.
 *
 * Every function here is pure: the client fetches, these interpret.
 */
import { parseLast4 } from './accountId.js'

export type Bureau = 'transunion' | 'equifax'

/** The `bureau` variable CK's credit-report operations take. */
export const BUREAU_CODE: Record<Bureau, number> = { transunion: 1, equifax: 2 }

type Json = Record<string, unknown>

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
}

/** Throw the first GraphQL error message, if the payload carries any. */
function throwOnGraphqlErrors(json: unknown, what: string): void {
  const errors = obj(json)?.['errors']
  if (Array.isArray(errors) && errors.length > 0) {
    const message = obj(errors[0])?.['message']
    throw new Error(`${what} failed: ${typeof message === 'string' ? message : 'GraphQL error'}`)
  }
}

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
        creditLimit: category === 'credit_card' ? amountOf(t['limit']) : null,
        asOf: typeof t['dateReported'] === 'string' && t['dateReported'] !== '' ? t['dateReported'] : null,
      })
    }
  }
  return accounts
}

// ---------------------------------------------------------------------------
// Linked accounts (net-worth pages)
// ---------------------------------------------------------------------------

export interface LinkedAccountBalance {
  name: string
  provider: string
  /** "Provider (...1234)" as CK showed it — fed to deriveAccountId. */
  display: string
  last4: string | null
  balance: number
  /** e.g. "2 hr ago"; null when the row shows none. */
  relativeAge: string | null
  needsAttention: boolean
}

const PROVIDER_LINE = /^(.*?)\s*\(\.{2,}([^)]+)\)\s*(?:\n\s*(.*))?$/s
const MONEY = /^([-−+])?\$([\d,]+(?:\.\d+)?)$/
const STATUS = /needs (attention|verification)/i

/**
 * Account rows from a `getAccountL2Page` response, plus how many provider lines
 * could not be paired with exactly one balance (a layout CK changed under us).
 */
export function parseLinkedBalances(json: unknown): { rows: LinkedAccountBalance[]; unparsed: number } {
  throwOnGraphqlErrors(json, 'getAccountL2Page')
  const layout = obj(obj(obj(obj(json)?.['data'])?.['prime'])?.['networthByAccountType'])
  if (!layout) throw new Error('getAccountL2Page response is missing `networthByAccountType`.')
  if (layout['__typename'] === 'Prime_ErrorLayout') return { rows: [], unparsed: 0 }

  const rows: LinkedAccountBalance[] = []
  let providerLines = 0

  // Bottom-up: a node is a row when it holds exactly one provider line and one
  // amount AND no descendant already claimed them.
  const walk = (node: unknown): { texts: string[]; claimed: boolean } => {
    if (Array.isArray(node) || obj(node)) {
      const texts: string[] = []
      let claimed = false
      for (const [key, child] of Object.entries(node as Json)) {
        if (key === 'text' && typeof child === 'string') {
          texts.push(child)
          if (PROVIDER_LINE.test(child.trim())) providerLines++
          continue
        }
        const r = walk(child)
        texts.push(...r.texts)
        claimed ||= r.claimed
      }
      if (!claimed) {
        const row = toRow(texts)
        if (row) { rows.push(row); claimed = true }
      }
      return { texts: claimed ? [] : texts, claimed }
    }
    return { texts: [], claimed: false }
  }
  walk(layout['cards'])

  return { rows, unparsed: providerLines - rows.length }
}

function toRow(texts: string[]): LinkedAccountBalance | null {
  const trimmed = texts.map(t => t.trim()).filter(t => t !== '')
  const providers = trimmed.filter(t => PROVIDER_LINE.test(t))
  const amounts = trimmed.filter(t => MONEY.test(t))
  if (providers.length !== 1 || amounts.length !== 1) return null

  const [, providerRaw, , age] = providers[0].match(PROVIDER_LINE)!
  const [, minus, digits] = amounts[0].match(MONEY)!
  const value = Number(digits.replace(/,/g, ''))
  const provider = providerRaw.trim()
  const display = providers[0].split('\n')[0].trim()
  const name = trimmed.find(t => t !== providers[0] && t !== amounts[0] && !STATUS.test(t)) ?? provider

  return {
    name,
    provider,
    display,
    last4: parseLast4(display),
    balance: minus === '-' || minus === '−' ? -value : value,
    relativeAge: age?.trim() || null,
    needsAttention: trimmed.some(t => STATUS.test(t)),
  }
}

/**
 * Exact last-refresh time per institution, keyed by lower-cased trimmed
 * provider name. When one institution has several connections we can't tell
 * which an account belongs to, so the OLDEST wins — it can only make a balance
 * look staler than it is, never fresher.
 */
export function parseConnectionTimes(json: unknown): Map<string, string> {
  const times = new Map<string, string>()
  const connections = obj(obj(obj(obj(json)?.['data'])?.['prime'])?.['idxConnections'])?.['connections']
  if (!Array.isArray(connections)) return times
  for (const raw of connections) {
    const c = obj(raw)
    const name = obj(c?.['providerMetadata'])?.['providerName']
    const at = c?.['lastRefreshTimeStamp']
    if (typeof name !== 'string' || typeof at !== 'string') continue
    const key = normalizeProvider(name)
    const prev = times.get(key)
    if (!prev || at < prev) times.set(key, at)
  }
  return times
}

export function normalizeProvider(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The refresh time for an account row's provider. The net-worth pages show a
 * SHORTENED provider name — investments especially ("Vanguard - Pers...") —
 * while connections carry the full one. Measured 2026-10-06: exact matching
 * timed 11 of 26 rows, prefix matching all 26. So: exact first, then any
 * connection whose name starts with the row's (ellipsis stripped), taking the
 * oldest if several do.
 */
export function findConnectionTime(times: Map<string, string>, provider: string): string | undefined {
  const name = normalizeProvider(provider)
  const exact = times.get(name)
  if (exact) return exact
  const stem = name.replace(/(\.\.\.|…)$/, '').trim()
  if (stem === '') return undefined
  let oldest: string | undefined
  for (const [connection, at] of times) {
    if (connection.startsWith(stem) && (!oldest || at < oldest)) oldest = at
  }
  return oldest
}

const UNIT_MS: Record<string, number> = {
  sec: 1000,
  min: 60_000,
  hr: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
}

/** "2 hr ago" → an ISO timestamp relative to `now`; null if unrecognized. */
export function relativeAgeToIso(text: string | null, now: Date): string | null {
  const m = text?.match(/(\d+)\s*(sec|min|hr|days?|mo|yr)\s+ago/)
  if (!m) return null
  const n = Number(m[1])
  const d = new Date(now)
  if (m[2] === 'mo') d.setUTCMonth(d.getUTCMonth() - n)
  else if (m[2] === 'yr') d.setUTCFullYear(d.getUTCFullYear() - n)
  else d.setTime(d.getTime() - n * UNIT_MS[m[2]])
  return d.toISOString()
}
