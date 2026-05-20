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

function extractLast4(display: string): string {
  const m = display.match(/\(\.\.([^)]+)\)/)
  return m?.[1] ?? display
}
