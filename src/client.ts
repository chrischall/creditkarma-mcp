import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { truncateErrorMessage } from '@chrischall/mcp-utils'

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
  private tokenSetAt: number | null = null
  private refreshToken: string | null = null
  private cookies: string | null = null
  /** In-flight refresh, shared across concurrent callers (see refreshAccessToken). */
  private refreshInFlight: Promise<string> | null = null

  constructor(token?: string, refreshToken?: string, cookies?: string) {
    if (token) this.setToken(token)
    if (refreshToken) this.refreshToken = refreshToken
    if (cookies) this.cookies = cookies
  }

  setToken(token: string): void {
    this.token = token
    this.tokenSetAt = Date.now()
  }

  getToken(): string | null {
    return this.token
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  setRefreshToken(token: string): void {
    this.refreshToken = token
  }

  getCookies(): string | null {
    return this.cookies
  }

  setCookies(cookies: string): void {
    this.cookies = cookies
  }

  isTokenExpired(): boolean {
    if (!this.token || this.tokenSetAt === null) return true
    return Date.now() - this.tokenSetAt > TOKEN_TTL_MS
  }

  /** Fetch a single page of transactions. Throws TOKEN_EXPIRED on 401. */
  async fetchPage(afterCursor?: string): Promise<TransactionPage> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const response = await this.post(GRAPHQL_ENDPOINT, {
      query: TRANSACTION_QUERY,
      variables: buildVariables(afterCursor)
    })

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(2000)
      const retry = await this.post(GRAPHQL_ENDPOINT, {
        query: TRANSACTION_QUERY,
        variables: buildVariables(afterCursor)
      })
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
   * Concurrent callers share a single in-flight request: the first call starts
   * the refresh and stores its promise; overlapping callers (e.g. a multi-page
   * sync that 401s on several pages at once) await that same promise instead of
   * firing duplicate POSTs to /member/oauth2/refresh (wasted quota, rate-limit
   * risk). The slot is cleared in `finally`, so a later expiry refreshes anew.
   */
  refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight
    const p = this.doRefreshAccessToken().finally(() => {
      this.refreshInFlight = null
    })
    this.refreshInFlight = p
    return p
  }

  private async doRefreshAccessToken(): Promise<string> {
    if (!this.refreshToken) throw new Error('NO_REFRESH_TOKEN: Call ck_set_session first.')

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
      const glid = extractGlidFromJwt(this.token)
      if (glid) headers['ck-trace-id'] = glid
      // Extract CKTRKID cookie for ck-cookie-id
      const cookieId = extractCookieValue(this.cookies ?? '', 'CKTRKID')
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

    this.setToken(json.accessToken)
    if (json.refreshToken) this.refreshToken = json.refreshToken
    return json.accessToken
  }

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token!}`,
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

/** Decode the unverified JWT payload claims. Returns null if the token is not
 *  a well-formed JWT. We never use this for authorization — only for reading
 *  claims (exp, glid) on tokens we already trust. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** True only if we can decode the JWT and its `exp` claim is in the past.
 *  Returns false for un-decodable strings (let the API decide) or tokens
 *  without an `exp` claim. */
export function isJwtExpired(token: string): boolean {
  const p = decodeJwtPayload(token)
  if (!p || typeof p.exp !== 'number') return false
  return p.exp * 1000 < Date.now()
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

function extractGlidFromJwt(token: string): string | null {
  const p = decodeJwtPayload(token)
  const glid = p?.glid
  return typeof glid === 'string' ? glid : null
}

/** Parse a single cookie value out of a Cookie header string. Exported so the
 *  auth tool and bootstrap don't each maintain their own copy. */
export function extractCookieValue(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
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
