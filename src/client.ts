import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

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
      if (!retry.ok) throw new Error(`HTTP ${retry.status}`)
      return parseTransactionPage(await retry.json())
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseTransactionPage(await response.json())
  }

  /**
   * Refresh the access token using CK's native refresh endpoint.
   * Requires a refresh token and session cookies (captured after login).
   */
  async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken) throw new Error('NO_REFRESH_TOKEN: Call ck_login first.')

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

    if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`)
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

function extractGlidFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return payload.glid ?? null
  } catch {
    return null
  }
}

function extractCookieValue(cookieString: string, name: string): string | null {
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
      paginationInput: {
        after: afterCursor ?? null,
        first: 50
      }
    }
  }
}

function parseTransactionPage(json: unknown): TransactionPage {
  const top = json as Record<string, unknown>
  if (top['errorCode']) throw new Error(`TOKEN_EXPIRED`)
  const data = json as {
    data: {
      prime: {
        transactionsHub: {
          transactionPage: TransactionPage
        }
      }
    }
  }
  return data.data.prime.transactionsHub.transactionPage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
