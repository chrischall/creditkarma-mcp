import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CreditKarmaClient,
  isJwtExpired,
  decodeJwtPayload,
  extractCookieValue,
  type TransactionPage
} from '../src/client.js'
import { makeJwt } from './helpers.js'

describe('CreditKarmaClient — token management', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    client = new CreditKarmaClient()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has no token by default', () => {
    expect(client.getToken()).toBeNull()
  })

  it('is expired with no token', () => {
    expect(client.isTokenExpired()).toBe(true)
  })

  it('accepts a token at construction', () => {
    vi.useFakeTimers()
    const c = new CreditKarmaClient('mytoken')
    expect(c.getToken()).toBe('mytoken')
    expect(c.isTokenExpired()).toBe(false)
  })

  it('setToken updates the token', () => {
    client.setToken('tok1')
    expect(client.getToken()).toBe('tok1')
    expect(client.isTokenExpired()).toBe(false)
  })

  it('token is expired after 10 minutes', () => {
    client.setToken('tok1')
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    expect(client.isTokenExpired()).toBe(true)
  })

  it('token is not expired just before 10 minutes', () => {
    client.setToken('tok1')
    vi.advanceTimersByTime(10 * 60 * 1000 - 1)
    expect(client.isTokenExpired()).toBe(false)
  })
})

const mockPage: TransactionPage = {
  transactions: [
    {
      id: 'tx1', date: '2024-01-10', description: 'Starbucks', status: 'posted',
      amount: { value: -5.50, asCurrencyString: '-$5.50' },
      account: { id: 'a1', name: 'Chase', type: 'checking', providerName: 'Chase', accountTypeAndNumberDisplay: '...1234' },
      category: { id: 'c1', name: 'Food', type: 'expense' },
      merchant: { id: 'm1', name: 'Starbucks' }
    }
  ],
  pageInfo: { startCursor: 'start', endCursor: 'end', hasNextPage: false, hasPreviousPage: false }
}

const mockResponse = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

describe('CreditKarmaClient — fetchPage', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-01-01'))
    client = new CreditKarmaClient('valid-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('throws TOKEN_EXPIRED with no token', async () => {
    const c = new CreditKarmaClient()
    await expect(c.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('calls GraphQL endpoint with Authorization header', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )

    await client.fetchPage()

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.creditkarma.com/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Authorization': 'Bearer valid-token' })
      })
    )
  })

  it('returns parsed TransactionPage on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )
    const result = await client.fetchPage('cursor1')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].id).toBe('tx1')
    expect(result.pageInfo.endCursor).toBe('end')
  })

  it('throws TOKEN_EXPIRED on 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse(401))
    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('retries once on 429 and succeeds', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(
        mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
      )

    // Use Promise.all to advance timers and await result concurrently — avoids ordering races
    const [result] = await Promise.all([
      client.fetchPage(),
      vi.runAllTimersAsync()
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result.transactions).toHaveLength(1)
  })

  it('throws TOKEN_EXPIRED if retry after 429 returns 401', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(401))

    await expect(
      Promise.all([client.fetchPage(), vi.runAllTimersAsync()])
    ).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('throws HTTP error if retry after 429 returns non-200/401 status', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse(429))
      .mockResolvedValueOnce(mockResponse(503))

    await expect(
      Promise.all([client.fetchPage(), vi.runAllTimersAsync()])
    ).rejects.toThrow('HTTP 503')
  })

  it('throws HTTP error on non-200/401/429 status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(mockResponse(500))
    await expect(client.fetchPage()).rejects.toThrow('HTTP 500')
  })

  it('passes afterCursor in request variables', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse(200, { data: { prime: { transactionsHub: { transactionPage: mockPage } } } })
    )
    await client.fetchPage('my-cursor')
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables.input.paginationInput.afterCursor).toBe('my-cursor')
  })
})

describe('CreditKarmaClient — refresh token', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stores refresh token and cookies from constructor', () => {
    const c = new CreditKarmaClient('access', 'refresh-tok', 'CKTRKID=abc')
    expect(c.getRefreshToken()).toBe('refresh-tok')
    expect(c.getCookies()).toBe('CKTRKID=abc')
  })

  it('setRefreshToken updates stored value', () => {
    const c = new CreditKarmaClient()
    c.setRefreshToken('new-refresh')
    expect(c.getRefreshToken()).toBe('new-refresh')
  })

  it('refreshAccessToken throws NO_REFRESH_TOKEN when none set', async () => {
    const c = new CreditKarmaClient()
    await expect(c.refreshAccessToken()).rejects.toThrow('NO_REFRESH_TOKEN')
  })

  it('refreshAccessToken posts to CK refresh endpoint', async () => {
    const c = new CreditKarmaClient('old-tok', 'old-refresh', 'CKTRKID=xyz')

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh' }), { status: 200 })
    )

    const token = await c.refreshAccessToken()
    expect(token).toBe('new-access')
    expect(c.getToken()).toBe('new-access')
    expect(c.getRefreshToken()).toBe('new-refresh')
  })

  it('refreshAccessToken throws on HTTP error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(c.refreshAccessToken()).rejects.toThrow('Token refresh failed')
  })

  it('refreshAccessToken throws on error response body', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_token' }), { status: 200 })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow('Token refresh error')
  })

  it('refreshAccessToken includes status code in error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 400 }))
    await expect(c.refreshAccessToken()).rejects.toThrow('HTTP 400')
  })

  it('refreshAccessToken includes JSON body snippet in error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow(/invalid_grant/)
  })

  it('refreshAccessToken flags non-JSON (HTML) error page in error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html>error</html>', {
        status: 400,
        headers: { 'content-type': 'text/html' }
      })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow(/non-JSON error page/)
  })

  it('refreshAccessToken hints expired refresh token in error for HTML 400', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('<!DOCTYPE html>', {
        status: 400,
        headers: { 'content-type': 'text/html' }
      })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow(/refresh token/i)
  })

  it('refreshAccessToken labels empty body as "(empty body)" in the error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 400, headers: { 'content-type': 'application/json' } })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow('(empty body)')
  })

  it('refreshAccessToken truncates long error bodies to 200 chars + ellipsis', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    const long = '{"error":"' + 'x'.repeat(500) + '"}'
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(long, { status: 400, headers: { 'content-type': 'application/json' } })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow(/…/)
  })

  it('refreshAccessToken survives a body-read failure', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    const fakeRes = {
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('stream broken')),
      headers: new Headers({ 'content-type': 'text/plain' })
    } as unknown as Response
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(fakeRes)
    await expect(c.refreshAccessToken()).rejects.toThrow('HTTP 502')
  })

  it('refreshAccessToken handles error responses with no content-type header', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    const fakeRes = {
      ok: false,
      status: 500,
      text: () => Promise.resolve('oops'),
      headers: new Headers()  // no content-type
    } as unknown as Response
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(fakeRes)
    await expect(c.refreshAccessToken()).rejects.toThrow(/HTTP 500.*oops/)
  })

  it('refreshAccessToken errors with "no accessToken in response" when response is empty JSON', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow(/no accessToken in response/)
  })

  it('refreshAccessToken says "ck_set_session" (not the obsolete ck_login) when no refresh token', async () => {
    const c = new CreditKarmaClient('tok')
    await expect(c.refreshAccessToken()).rejects.toThrow('ck_set_session')
  })

  it('refreshAccessToken omits authorization header when no access token', async () => {
    const c = new CreditKarmaClient()
    c.setRefreshToken('ref')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new' }), { status: 200 })
    )
    await c.refreshAccessToken()
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('refreshAccessToken keeps the old refresh token if the response omits one', async () => {
    const c = new CreditKarmaClient('old', 'keep-this-refresh')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new' }), { status: 200 })
    )
    await c.refreshAccessToken()
    expect(c.getToken()).toBe('new')
    expect(c.getRefreshToken()).toBe('keep-this-refresh')
  })
})

describe('isJwtExpired', () => {
  it('returns false for un-decodable strings (unknown — let the API decide)', () => {
    expect(isJwtExpired('not-a-jwt')).toBe(false)
    expect(isJwtExpired('')).toBe(false)
  })

  it('returns false when JWT has no exp claim', () => {
    expect(isJwtExpired(makeJwt({ sub: 'x' }))).toBe(false)
  })

  it('returns true when JWT exp is in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(isJwtExpired(makeJwt({ exp: past }))).toBe(true)
  })

  it('returns false when JWT exp is in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600
    expect(isJwtExpired(makeJwt({ exp: future }))).toBe(false)
  })
})

describe('decodeJwtPayload', () => {
  it('returns the parsed payload for a well-formed JWT', () => {
    const payload = decodeJwtPayload(makeJwt({ sub: 'me', glid: 'abc' }))
    expect(payload).toMatchObject({ sub: 'me', glid: 'abc' })
  })

  it('returns null for non-JWT strings', () => {
    expect(decodeJwtPayload('')).toBeNull()
    expect(decodeJwtPayload('no-dots')).toBeNull()
    expect(decodeJwtPayload('one.two.three')).toBeNull()
  })
})

describe('extractCookieValue', () => {
  it('returns the value of a named cookie from a Cookie header', () => {
    expect(extractCookieValue('CKTRKID=abc; CKAT=xyz', 'CKAT')).toBe('xyz')
  })

  it('returns null when the cookie is absent', () => {
    expect(extractCookieValue('OTHER=x', 'CKAT')).toBeNull()
  })

  it('handles cookies at the start of the header', () => {
    expect(extractCookieValue('CKAT=v; OTHER=x', 'CKAT')).toBe('v')
  })
})

describe('CreditKarmaClient — refreshAccessToken header propagation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('includes ck-trace-id when JWT has a glid claim', async () => {
    const token = makeJwt({ glid: 'trace-me' })
    const c = new CreditKarmaClient(token, 'ref', 'CKTRKID=cookie-id')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new' }), { status: 200 })
    )
    await c.refreshAccessToken()
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['ck-trace-id']).toBe('trace-me')
    expect(headers['ck-cookie-id']).toBe('cookie-id')
  })

  it('omits ck-trace-id when JWT lacks a glid claim', async () => {
    const token = makeJwt({ sub: 'x' })
    const c = new CreditKarmaClient(token, 'ref')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new' }), { status: 200 })
    )
    await c.refreshAccessToken()
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['ck-trace-id']).toBeUndefined()
  })
})

describe('CreditKarmaClient — parseTransactionPage error paths', () => {
  let client: CreditKarmaClient
  beforeEach(() => { client = new CreditKarmaClient('tok') })
  afterEach(() => vi.restoreAllMocks())

  it('treats `errors` array on response as TOKEN_EXPIRED', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'unauthorized' }] }), { status: 200 })
    )
    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('treats missing `prime` in response as TOKEN_EXPIRED', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), { status: 200 })
    )
    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('treats `data: null` (entirely missing) as TOKEN_EXPIRED', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    )
    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
  })
})
