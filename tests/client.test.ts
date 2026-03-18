import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CreditKarmaClient, type TransactionPage } from '../src/client.js'

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
})
