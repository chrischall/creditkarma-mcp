import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { truncateErrorMessage, decodeJwtClaim, parseCookieHeader } from '@chrischall/mcp-utils'
import { TokenManager } from '@chrischall/mcp-utils/session'

const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const GRAPHQL_ENDPOINT = 'https://api.creditkarma.com/graphql'
export const CK_REFRESH_ENDPOINT = 'https://www.creditkarma.com/member/oauth2/refresh'

export interface TransactionPage {
  transactions: ApiTransaction[]
  pageInfo: {
    startCursor: string
    endCursor: string
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

export interface ApiTransaction {
  id: string
  date: string
  description: string
  status: string
  amount: { value: number; asCurrencyString: string }
  account: {
    id: string
    name: string
    type: string
    providerName: string
    accountTypeAndNumberDisplay: string
  }
  category: { id: string; name: string; type: string } | null
  merchant: { id: string; name: string } | null
}

export class CreditKarmaClient {
  private token: string | null = null
  private refreshToken: string | null = null
  private cookies: string | null = null
  /**
   * Owns the bearer-token lifecycle: TTL/expiry tracking, proactive refresh
   * inside a skew window, the single 401-replay on the authed GraphQL POST, and
   * the single-flight semaphore that coalesces concurrent refreshes into ONE
   * `/member/oauth2/refresh` POST. Replaces the hand-rolled `tokenSetAt` TTL
   * tracking + `refreshInFlight` single-flight this class used to carry.
   *
   * CK's access/refresh tokens + cookies remain this class's own mutable state
   * (the sync `getToken()`/`getRefreshToken()`/`getCookies()` accessors and the
   * request headers read them directly); the refresh callback mirrors fresh
   * tokens back into those fields so the two stay in lock-step. The manager is
   * rebuilt on every external `setToken()` so its expiry window restarts from
   * "now" — matching the old `tokenSetAt = Date.now()` reset.
   */
  private tokens: TokenManager

  constructor(token?: string, refreshToken?: string, cookies?: string) {
    if (refreshToken) this.refreshToken = refreshToken
    if (cookies) this.cookies = cookies
    if (token) this.token = token
    this.tokens = this.buildTokenManager()
  }

  /**
   * (Re)build the {@link TokenManager} around the client's current token state,
   * restarting the TTL window from now. The refresh callback runs CK's native
   * refresh POST and writes the fresh access/refresh tokens straight onto this
   * client (NOT via `setToken`, which would rebuild the manager mid-flight and
   * orphan the in-flight single-flight promise); the manager applies the new
   * `expiresAt` to its own window.
   */
  private buildTokenManager(): TokenManager {
    return new TokenManager({
      initial: {
        accessToken: this.token ?? '',
        refreshToken: this.refreshToken ?? undefined,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      },
      // TokenManager only calls this when a refresh token is present (guaranteed
      // by `refreshAccessToken`'s own NO_REFRESH_TOKEN guard / by withAuth only
      // refreshing when it has one), so the callback can assume one exists.
      refresh: async () => {
        const { accessToken, refreshToken } = await this.doRefreshAccessToken()
        this.token = accessToken
        if (refreshToken) this.refreshToken = refreshToken
        return {
          accessToken,
          // Omit an empty/absent refresh token so the manager keeps the prior one.
          refreshToken: refreshToken || undefined,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        }
      },
    })
  }

  setToken(token: string): void {
    this.token = token
    // Restart the TTL window (old behavior: `tokenSetAt = Date.now()`).
    this.tokens = this.buildTokenManager()
  }

  getToken(): string | null {
    return this.token
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  setRefreshToken(token: string): void {
    this.refreshToken = token
    // Keep the manager's view of the refresh token current for later refreshes.
    this.tokens = this.buildTokenManager()
  }

  getCookies(): string | null {
    return this.cookies
  }

  setCookies(cookies: string): void {
    this.cookies = cookies
  }

  isTokenExpired(): boolean {
    if (!this.token) return true
    // TTL is owned by the TokenManager now; expired ⟺ at/after its expiry.
    return Date.now() >= this.tokens.getExpiresAt()
  }

  /**
   * POST the authed GraphQL query through the TokenManager so a token within the
   * skew window is proactively refreshed first, and a hard HTTP 401 triggers one
   * refresh + replay. When no refresh token is available the manager's refresh
   * attempt rejects — surface that as a 401 Response so `fetchPage` maps it to
   * the same TOKEN_EXPIRED the bespoke path produced (sync.ts then re-auths).
   *
   * (CK's PRIMARY expired-token signal is a 200 body carrying an auth `errorCode`,
   * not an HTTP 401 — that GraphQL-errorCode path is mapped to TOKEN_EXPIRED in
   * `parseTransactionPage` and reactively refreshed by the sync loop, since the
   * manager's reactive replay is HTTP-status-based and can't see GraphQL bodies.)
   */
  private graphqlPost(variables: Record<string, unknown>): Promise<Response> {
    return this.tokens
      .withAuth((accessToken) =>
        this.post(GRAPHQL_ENDPOINT, { query: TRANSACTION_QUERY, variables }, accessToken)
      )
      .catch((err: unknown) => {
        if (err instanceof Error && /no refresh token/i.test(err.message)) {
          return new Response(null, { status: 401 })
        }
        throw err
      })
  }

  /** Fetch a single page of transactions. Throws TOKEN_EXPIRED on 401. */
  async fetchPage(afterCursor?: string): Promise<TransactionPage> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const response = await this.graphqlPost(buildVariables(afterCursor))

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(2000)
      const retry = await this.graphqlPost(buildVariables(afterCursor))
      if (retry.status === 401) throw new Error('TOKEN_EXPIRED')
      if (!retry.ok) throw new Error(await httpErrorMessage(retry))
      return parseTransactionPage(await retry.json())
    }

    if (!response.ok) throw new Error(await httpErrorMessage(response))
    return parseTransactionPage(await response.json())
  }

  /**
   * Refresh the access token using CK's native refresh endpoint.
   * Requires a refresh token and session cookies (captured after login).
   *
   * The {@link TokenManager} owns the single-flight: concurrent callers (e.g. a
   * multi-page sync that 401s on several pages at once) coalesce onto ONE
   * in-flight refresh instead of firing duplicate POSTs to
   * /member/oauth2/refresh (wasted quota, rate-limit risk). The in-flight slot
   * clears on settle, so a later expiry refreshes anew.
   */
  async refreshAccessToken(): Promise<string> {
    // Keep CK's actionable NO_REFRESH_TOKEN message (the manager would otherwise
    // reject with its generic "no refresh token is available").
    if (!this.refreshToken) throw new Error('NO_REFRESH_TOKEN: Call ck_set_session first.')
    await this.tokens.refreshNow()
    return this.token!
  }

  /**
   * Perform CK's native refresh POST and return the parsed tokens. The
   * lifecycle (single-flight, expiry, mirroring onto this client) is handled by
   * the {@link TokenManager} refresh callback that wraps this.
   */
  private async doRefreshAccessToken(): Promise<{ accessToken: string; refreshToken?: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Origin': 'https://www.creditkarma.com',
      'Referer': 'https://www.creditkarma.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'ck-client-name': 'web',
      'ck-client-version': '1.0.0',
      'ck-device-type': 'Desktop',
    }

    if (this.token) {
      headers['authorization'] = `Bearer ${this.token}`
      // Extract glid from JWT for ck-trace-id
      const glid = decodeJwtClaim(this.token, 'glid')
      if (typeof glid === 'string') headers['ck-trace-id'] = glid
      // Extract CKTRKID cookie for ck-cookie-id
      const cookieId = parseCookieHeader(this.cookies ?? '')['CKTRKID'] ?? null
      if (cookieId) headers['ck-cookie-id'] = cookieId
    }

    if (this.cookies) headers['Cookie'] = this.cookies

    const res = await fetch(CK_REFRESH_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: this.refreshToken })
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const contentType = res.headers.get('content-type') ?? ''
      const looksHtml = !contentType.includes('json') && /^\s*<(!doctype|html)/i.test(body)
      const detail = looksHtml
        ? '(non-JSON error page — refresh token likely expired or session invalid; sign back into creditkarma.com so the fetchproxy extension can re-read fresh cookies, or paste a fresh Cookie header via ck_set_session)'
        // Redact + cap the upstream body (same treatment as the GraphQL path)
        // so tokens echoed back by CK never reach the tool surface.
        : (truncateErrorMessage(body, 200).trim() || '(empty body)')
      throw new Error(`Token refresh failed: HTTP ${res.status} — ${detail}`)
    }
    const json = await res.json() as { accessToken?: string; refreshToken?: string; error?: string }
    if (json.error || !json.accessToken) throw new Error(`Token refresh error: ${json.error ?? 'no accessToken in response'}`)

    return { accessToken: json.accessToken, refreshToken: json.refreshToken }
  }

  private post(url: string, body: unknown, token: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Origin': 'https://www.creditkarma.com',
        'Referer': 'https://www.creditkarma.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True only if we can decode the JWT and its `exp` claim is in the past.
 *  Returns false for un-decodable strings (let the API decide) or tokens
 *  without an `exp` claim — deliberately lenient, unlike mcp-utils'
 *  fail-closed `validateJwtExpiry`. */
export function isJwtExpired(token: string): boolean {
  const exp = decodeJwtClaim(token, 'exp')
  return typeof exp === 'number' && exp * 1000 < Date.now()
}

/**
 * Emit the standard stderr warning when a refresh JWT is present but already
 * expired. Single source of truth for the message that previously lived in
 * both `src/index.ts` (startup) and was conceptually mirrored in
 * `ck_set_session`. No-op when the token is absent or still valid.
 */
export function warnIfRefreshTokenExpired(refreshToken: string | undefined | null): void {
  if (refreshToken && isJwtExpired(refreshToken)) {
    console.error('[creditkarma-mcp] Warning: refresh token in CK_COOKIES has expired. Sign back into creditkarma.com (with the fetchproxy extension installed) or call ck_set_session with a fresh Cookie header.')
  }
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

const _dir = dirname(fileURLToPath(import.meta.url))
export const TRANSACTION_QUERY = readFileSync(join(_dir, 'transaction.graphql'), 'utf8')

function buildVariables(afterCursor?: string): Record<string, unknown> {
  return {
    input: {
      paginationInput: { afterCursor: afterCursor ?? null },
      categoryInput: { categoryId: null, primeCategoryType: null },
      datePeriodInput: { datePeriod: null },
      accountInput: {}
    }
  }
}

/** GraphQL/HTTP error codes that mean "the access token is no longer valid" —
 *  these (and only these) should drive the refresh + retry path. Anything else
 *  (schema drift, validation, server faults) is a real error to surface, not an
 *  auth failure to paper over with a pointless token refresh.
 *
 *  Deliberately NOT including FORBIDDEN/403: that means "authenticated but not
 *  authorized for this resource", so a token refresh wouldn't help and the retry
 *  would just fail again with the same code, masking the real problem. We have
 *  no evidence CK returns FORBIDDEN for an expired token. */
const AUTH_ERROR_CODE = /\b(UNAUTHENTICATED|UNAUTHORIZED|TOKEN_EXPIRED|401)\b/i

/** Pull every candidate "error code" string out of a GraphQL error payload:
 *  the top-level `errorCode`, and each entry's `errorCode` / `code` /
 *  `extensions.code`. CK has shipped auth failures in several of these shapes. */
function collectErrorCodes(top: Record<string, unknown>): string[] {
  const codes: string[] = []
  if (typeof top['errorCode'] === 'string') codes.push(top['errorCode'])
  const errors = top['errors']
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (!e || typeof e !== 'object') continue
      const obj = e as Record<string, unknown>
      if (typeof obj['errorCode'] === 'string') codes.push(obj['errorCode'])
      if (typeof obj['code'] === 'string') codes.push(obj['code'])
      const ext = obj['extensions']
      if (ext && typeof ext === 'object' && typeof (ext as Record<string, unknown>)['code'] === 'string') {
        codes.push((ext as Record<string, unknown>)['code'] as string)
      }
    }
  }
  return codes
}

function parseTransactionPage(json: unknown): TransactionPage {
  const top = json as Record<string, unknown>

  // CK signals errors via a top-level `errorCode` and/or a GraphQL `errors`
  // array. Only auth-shaped codes mean "refresh the token" — map those to
  // TOKEN_EXPIRED. Every other GraphQL error (schema drift, validation, server
  // fault) is surfaced verbatim (redacted) so the user sees the real problem
  // instead of a misleading "token expired" after a wasted refresh + retry.
  if (top['errorCode'] || top['errors']) {
    const codes = collectErrorCodes(top)
    if (codes.some(c => AUTH_ERROR_CODE.test(c))) throw new Error('TOKEN_EXPIRED')
    const payload = truncateErrorMessage(JSON.stringify(top['errors'] ?? top['errorCode']), 300).trim()
    throw new Error(`GraphQL error: ${payload}`)
  }

  // Schema drift: a 200 with a well-formed but unexpected shape. Name the
  // missing node so the failure is diagnosable, rather than letting a blind
  // cast NPE downstream in sync.ts. Not an auth failure — do NOT refresh.
  const data = top['data']
  if (!data || typeof data !== 'object') {
    throw new Error('GraphQL response missing `data` (schema drift or unexpected response)')
  }
  const prime = (data as Record<string, unknown>)['prime']
  if (!prime || typeof prime !== 'object') {
    throw new Error('GraphQL response missing `data.prime` (schema drift or unexpected response)')
  }
  const hub = (prime as Record<string, unknown>)['transactionsHub']
  if (!hub || typeof hub !== 'object') {
    throw new Error('GraphQL response missing `data.prime.transactionsHub` (schema drift)')
  }
  const transactionPage = (hub as Record<string, unknown>)['transactionPage']
  if (!transactionPage || typeof transactionPage !== 'object') {
    throw new Error('GraphQL response missing `data.prime.transactionsHub.transactionPage` (schema drift)')
  }
  return transactionPage as TransactionPage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Build an `HTTP <status>: <body>` error message for a failed GraphQL response,
 * attaching the upstream body (redacted + length-capped via mcp-utils'
 * `truncateErrorMessage`) so failures are debuggable instead of a bare status.
 * Falls back to just the status when the body can't be read.
 */
async function httpErrorMessage(res: Response): Promise<string> {
  let body = ''
  try {
    body = typeof res.text === 'function' ? await res.text() : ''
  } catch {
    body = ''
  }
  const safe = truncateErrorMessage(body, 200).trim()
  return safe.length > 0 ? `HTTP ${res.status}: ${safe}` : `HTTP ${res.status}`
}
