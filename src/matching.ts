/**
 * Pair credit-report accounts with the linked accounts they duplicate.
 *
 * A card or loan usually appears twice: live from the Intuit vault, and weeks
 * old from the credit report. The credit report gives no last 4 (its account
 * number is a per-bureau hash), so the pair is inferred from what both sides
 * do report — and only when that inference is unambiguous. A wrong match would
 * hide a real account, so anything doubtful stays unmatched and is listed.
 */

export interface BalanceSnapshot {
  id: string
  institution: string | null
  creditLimit: number | null
  /** Transaction sign convention (liabilities negative). */
  balance: number | null
  /** When that balance was true (a date or ISO timestamp). */
  asOf: string | null
}

/**
 * Bureau spellings → the names lenders link under. Bureaus report creditor
 * codes, not brands; extend this only with a pair you have actually seen.
 */
const ALIASES: Record<string, string> = {
  amex: 'american express',
  'jpmcb card': 'chase',
  jpmcb: 'chase',
  citibank: 'citi',
  cbna: 'citi',
  truistmrtg: 'truist',
}

function normalize(name: string): string {
  const n = name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  return ALIASES[n] ?? n
}

/** Same lender, allowing one name to be a whole-word prefix of the other. */
export function sameInstitution(a: string | null, b: string | null): boolean {
  const x = normalize(a ?? '')
  const y = normalize(b ?? '')
  if (x === '' || y === '') return false
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)
}

/** Credit limits a dollar apart are the same limit (rounding); any more is a different card. */
const LIMIT_TOLERANCE = 1
/** Card balances drift between a bureau report and today: allow a quarter of the limit. */
const CARD_DRIFT_OF_LIMIT = 0.25
/** Loans amortize slowly: allow 5% of the balance, but at least this much. */
const LOAN_DRIFT_SHARE = 0.05
const LOAN_DRIFT_FLOOR = 1000

/**
 * Hiding a credit-report row means preferring the linked balance, which is
 * only right when the linked one is at least as recent. A linked connection
 * that broke months ago keeps its last balance forever, and the bureau's
 * newer figure must not be hidden behind it. Undated linked balances never
 * win; an undated credit-report balance loses to any dated linked one.
 */
function linkedIsFresher(cr: BalanceSnapshot, linked: BalanceSnapshot): boolean {
  if (!linked.asOf) return false
  return !cr.asOf || Date.parse(linked.asOf) >= Date.parse(cr.asOf)
}

function plausiblySame(cr: BalanceSnapshot, linked: BalanceSnapshot): boolean {
  if (cr.balance === null || linked.balance === null) return false
  if (!linkedIsFresher(cr, linked)) return false
  if (!sameInstitution(cr.institution, linked.institution)) return false
  const drift = Math.abs(cr.balance - linked.balance)
  if (cr.creditLimit !== null && linked.creditLimit !== null) {
    return Math.abs(cr.creditLimit - linked.creditLimit) <= LIMIT_TOLERANCE &&
      drift <= CARD_DRIFT_OF_LIMIT * cr.creditLimit
  }
  if (cr.creditLimit === null && linked.creditLimit === null) {
    return drift <= Math.max(LOAN_DRIFT_FLOOR, LOAN_DRIFT_SHARE * Math.max(Math.abs(cr.balance), Math.abs(linked.balance)))
  }
  return false
}

/**
 * credit-report id → linked id, for pairs where each side has exactly one
 * plausible partner. Every other row is left out, i.e. unmatched.
 */
export function matchCreditReportAccounts(creditReport: BalanceSnapshot[], linked: BalanceSnapshot[]): Map<string, string> {
  const candidates = new Map(creditReport.map(c => [c.id, linked.filter(l => plausiblySame(c, l))]))
  const claims = new Map<string, number>()
  for (const ls of candidates.values()) for (const l of ls) claims.set(l.id, (claims.get(l.id) ?? 0) + 1)

  const matches = new Map<string, string>()
  for (const [crId, ls] of candidates) {
    if (ls.length === 1 && claims.get(ls[0].id) === 1) matches.set(crId, ls[0].id)
  }
  return matches
}
