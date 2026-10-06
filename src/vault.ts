/**
 * Intuit's account "vault" — the API behind Credit Karma's Manage-accounts page.
 *
 * Credit Karma's own net-worth pages take debts from the credit report, so
 * the only live source for a linked card's or loan's balance is the
 * IntuitConnect widget that page embeds. It authenticates with a token from
 * CK's `idxAuth` query and POSTs `vault.api.intuit.com/v2/search/connections`,
 * which returns every linked connection with typed per-account data keyed by
 * the SAME `urn:account:fdp::accountid:…` our transactions carry. Verified
 * headless 2026-10-06: idxAuth (client `idx-gateway`) → 200, 11 connections,
 * 30 accounts, all URN-keyed, 29 with a per-account refresh time.
 *
 * Undocumented and Intuit's, not CK's. When anything here fails, the balance
 * refresh reports `linked: { ok: false, error }` and leaves the stored linked
 * balances as they were (they then age into `stale`); the credit-report source
 * is unaffected.
 */
import { randomUUID } from 'node:crypto'
import { truncateErrorMessage, detectEdgeBlock, EdgeBlockedError } from '@chrischall/mcp-utils'
import { obj, str, throwOnGraphqlErrors } from './json.js'

export const VAULT_SEARCH_URL = 'https://vault.api.intuit.com/v2/search/connections'

/** The request body the widget sends for its Manage-accounts list. */
const SEARCH_BODY = {
  acquireAccounts: true,
  acquireMigrations: true,
  knownIssues: true,
  visibleAccounts: true,
  filterNoAccountConnections: true,
  manualAccounts: false,
  providerConfig: true,
  intents: ['BankingAggregation', 'investment/investmentportfolio'],
}

/** Categories whose balance is money owed, stored negative like transactions. */
const LIABILITY_CATEGORIES = new Set(['LOAN', 'LINEOFCREDIT'])

/** The Intuit token from an `idxAuth` response; throws the server's reason otherwise. */
export function parseIdxAuthToken(json: unknown): string {
  throwOnGraphqlErrors(json, 'idxAuth')
  const node = obj(obj(obj(obj(json)?.['data'])?.['prime'])?.['idxAuth'])
  const token = node?.['token']
  if (typeof token === 'string' && token !== '') return token
  const message = node?.['message']
  throw new Error(`idxAuth failed: ${typeof message === 'string' ? message : 'no token in response'}`)
}

/** POST the Manage-accounts search and return the parsed JSON body. */
export async function searchVaultConnections(idxToken: string): Promise<unknown> {
  const qs = new URLSearchParams({
    country_code: 'US',
    flow_name: 'ManageConnections',
    intuit_offeringid: 'com.creditkarma',
    intuit_tid: randomUUID(),
    locale: 'en_US',
  })
  const res = await fetch(`${VAULT_SEARCH_URL}?${qs}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idxToken}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(SEARCH_BODY),
  })
  const text = await res.text()
  if (!res.ok) {
    const edge = detectEdgeBlock({ body: text, headers: res.headers, status: res.status })
    if (edge) throw new EdgeBlockedError(res.status, edge.vendor, { service: 'vault.api.intuit.com', method: 'POST', path: '/v2/search/connections' })
    throw new Error(`Intuit vault search failed: HTTP ${res.status}: ${truncateErrorMessage(text, 200).trim()}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Intuit vault search returned non-JSON')
  }
}

export interface VaultAccount {
  /** `urn:account:fdp::accountid:…` — the id our transactions' `accountURN` carries. */
  urn: string
  provider: string
  name: string
  last4: string | null
  /** e.g. CREDITCARD, CHECKING, MORTGAGE, 401K */
  type: string
  /** e.g. LINEOFCREDIT, DEPOSIT, LOAN, INVESTMENT */
  category: string
  /** Transaction sign convention: liabilities negative. Null when Intuit has none. */
  balance: number | null
  /** Cards only; null when absent or 0 (charge cards report 0). */
  creditLimit: number | null
  /** Limit minus amount owed, for cards with a limit. Derived — Intuit sends no such field. */
  availableCredit: number | null
  asOf: string | null
}

/** Open, URN-keyed accounts from a vault connections response. */
export function parseVaultAccounts(json: unknown): VaultAccount[] {
  if (!Array.isArray(json)) throw new Error('vault connections response is not a list')
  const accounts: VaultAccount[] = []
  for (const rawConnection of json) {
    const connection = obj(rawConnection)
    if (!connection || !Array.isArray(connection['accounts'])) continue
    const provider = str(connection['name'])
    for (const raw of connection['accounts']) {
      const a = obj(raw)
      const urn = str(a?.['accountId'])
      if (!a || urn === '' || a['status'] !== 'OPEN') continue
      const category = str(a['accountCategory'])
      const liability = LIABILITY_CATEGORIES.has(category)
      const amount = str(a['currentBalance']) === '' ? NaN : Number(a['currentBalance'])
      const balance = Number.isFinite(amount) ? (liability ? -Math.abs(amount) || 0 : amount) : null
      const max = a['creditMaximumAmount']
      const creditLimit = liability && typeof max === 'number' && max > 0 ? max : null
      accounts.push({
        urn,
        provider,
        name: str(a['nickName']) || provider,
        last4: str(a['accountNumberMasked']).match(/(\d{4})$/)?.[1] ?? null,
        type: str(a['accountType']),
        category,
        balance,
        creditLimit,
        availableCredit: creditLimit !== null && balance !== null ? creditLimit + balance : null,
        asOf: str(a['lastSuccessfulRefreshTime']) || str(connection['lastSuccessTime']) || null,
      })
    }
  }
  return accounts
}
