/**
 * Credit Karma's `transactionsHub` returns `account.id = ""` for every transaction,
 * even when the response spans many accounts. Without a stable key, every account
 * collapses into one row. We synthesize an id from provider + the last-4 fragment
 * of accountTypeAndNumberDisplay (e.g. "Credit (..2630)" → "2630"), which stays
 * stable across CK's "Credit" vs "Credit Card" display drift for the same card.
 */
export interface AccountIdSource {
  id?: string | null
  providerName?: string | null
  accountTypeAndNumberDisplay?: string | null
}

export function deriveAccountId(account: AccountIdSource): string {
  if (account.id && account.id.trim() !== '') return account.id
  const provider = (account.providerName ?? '').trim()
  const last4 = extractLast4(account.accountTypeAndNumberDisplay ?? '')
  return `${provider}|${last4}`
}

/**
 * The fragment inside "(..xxxx)". Transactions use two dots, the net-worth
 * pages three, so both must yield the same fragment or one account gets two ids.
 * Deliberately unvalidated: existing ids were built from whatever CK put there
 * (HealthEquity's "ount" included), and changing that would orphan their rows.
 */
function extractLast4(display: string): string {
  const m = display.match(/\(\.{2,}([^)]+)\)/)
  return m?.[1] ?? display
}

/**
 * The account's real last four digits, or null when CK's display carries
 * something else — e.g. HealthEquity's "(..ount)", a truncated "account".
 */
export function parseLast4(display: string | null | undefined): string | null {
  const m = (display ?? '').match(/\(\.{2,}([^)]+)\)/)
  return m && /^\d{4}$/.test(m[1]) ? m[1] : null
}
