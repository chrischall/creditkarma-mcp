import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CreditKarmaClient,
  isNoQueryFound,
  NO_QUERY_FOUND_ATTEMPTS,
  NO_QUERY_FOUND_BACKOFF_MS,
} from '../src/client.js'

// Credit Karma's GraphQL gateway rejects a fraction of well-formed requests
// with `HTTP 400 {"message":"No query found"}`. Measured 2026-08-01 against a
// live account: identical POSTs on the same connection pool returned 200 or
// 400 with no client-observable predictor. Falsified as causes: query size (a
// 25-byte `query Ping { __typename }` fails at the same rate), persisted
// queries (ad-hoc queries execute fine, so the gateway is not APQ-only), the
// `ck-*` client headers, session/Akamai cookies, and request rate (250ms vs
// 3s pacing: 10/16 vs 8/16 failures). Both outcomes reach the origin with
// identical headers apart from `connection: close` on the failure.
//
// So it is retried, narrowly: only this exact signature, so a real 400 (bad
// query, schema drift) still surfaces immediately.

const mockPage = {
  transactions: [{ id: 'tx1' }],
  pageInfo: { startCursor: 's', endCursor: 'end', hasNextPage: false, hasPreviousPage: false },
}

const okResponse = () =>
  new Response(JSON.stringify({ data: { prime: { transactionsHub: { transactionPage: mockPage } } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const noQueryFound = () =>
  new Response(JSON.stringify({ message: 'No query found' }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })

describe('isNoQueryFound', () => {
  it('matches the gateway signature: 400 + the exact message', () => {
    expect(isNoQueryFound(400, '{"message":"No query found"}')).toBe(true)
  })

  it('tolerates whitespace variation in the JSON body', () => {
    expect(isNoQueryFound(400, '{ "message" : "No query found" }')).toBe(true)
  })

  it('does not match on a different status', () => {
    // A 500 carrying the same text is a different failure — don't paper over it.
    expect(isNoQueryFound(500, '{"message":"No query found"}')).toBe(false)
    expect(isNoQueryFound(200, '{"message":"No query found"}')).toBe(false)
  })

  it('does not match other 400s', () => {
    expect(isNoQueryFound(400, '{"message":"Syntax Error: Unexpected Name"}')).toBe(false)
    expect(isNoQueryFound(400, '{"errors":[{"message":"Cannot query field \\"frob\\""}]}')).toBe(false)
    expect(isNoQueryFound(400, '')).toBe(false)
  })

  it('does not match a body that merely mentions the phrase', () => {
    // Guard against over-broad matching: the phrase must be the `message`
    // value, not incidental prose inside some other error payload.
    expect(isNoQueryFound(400, '{"error":"the log said No query found earlier"}')).toBe(false)
  })
})

describe('fetchPage — "No query found" retry', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    vi.useFakeTimers()
    client = new CreditKarmaClient('valid-token')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries and succeeds when the gateway rejects the first attempt', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(noQueryFound())
      .mockResolvedValueOnce(okResponse())

    const [page] = await Promise.all([client.fetchPage(), vi.runAllTimersAsync()])

    expect(page.transactions).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries more than once before giving up', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(noQueryFound())
      .mockResolvedValueOnce(noQueryFound())
      .mockResolvedValueOnce(okResponse())

    const [page] = await Promise.all([client.fetchPage(), vi.runAllTimersAsync()])

    expect(page.transactions).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('gives up after a bounded number of attempts', async () => {
    // `mockImplementation`, not `mockResolvedValue`: a Response body is
    // single-use, so every attempt needs its own object (as in production).
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => noQueryFound())

    const err = await Promise.all([
      client.fetchPage().catch((e: Error) => e),
      vi.runAllTimersAsync(),
    ]).then(([e]) => e as Error)

    expect(fetchSpy).toHaveBeenCalledTimes(NO_QUERY_FOUND_ATTEMPTS)
    // The message must name the upstream cause and the fact that we retried,
    // so this doesn't read like a bug in our query.
    expect(err.message).toMatch(/No query found/)
    expect(err.message).toMatch(new RegExp(`${NO_QUERY_FOUND_ATTEMPTS} attempts`))
  })

  it('backs off between attempts rather than hammering the gateway', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => noQueryFound())
    const sleepSpy = vi.spyOn(global, 'setTimeout')

    await Promise.all([client.fetchPage().catch(() => null), vi.runAllTimersAsync()])

    const delays = sleepSpy.mock.calls.map((c) => c[1]).filter((d): d is number => typeof d === 'number' && d > 0)
    expect(delays.length).toBe(NO_QUERY_FOUND_ATTEMPTS - 1)
    // Strictly increasing — a flat retry is not a backoff.
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    expect(new Set(delays).size).toBe(delays.length)
  })

  it('does NOT retry a 400 that is a real query error', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Syntax Error: Unexpected Name' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )

    await expect(client.fetchPage()).rejects.toThrow(/Syntax Error/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 500', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))

    await expect(client.fetchPage()).rejects.toThrow(/HTTP 500/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('still throws TOKEN_EXPIRED on a 401 seen during the retry loop', async () => {
    // Auth must win over the gateway retry: a 401 after a "No query found"
    // means re-auth, not another attempt at the same broken request.
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(noQueryFound())
      .mockResolvedValueOnce(new Response(null, { status: 401 }))

    await expect(
      Promise.all([client.fetchPage(), vi.runAllTimersAsync()]).then(([p]) => p),
    ).rejects.toThrow('TOKEN_EXPIRED')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries a "No query found" that arrives after a 429 backoff', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(noQueryFound())
      .mockResolvedValueOnce(okResponse())

    const [page] = await Promise.all([client.fetchPage(), vi.runAllTimersAsync()])

    expect(page.transactions).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})

describe('retry sizing', () => {
  it('has one backoff entry per retry', () => {
    // A mismatch would either hammer with `undefined` delay or skip a wait.
    expect(NO_QUERY_FOUND_BACKOFF_MS).toHaveLength(NO_QUERY_FOUND_ATTEMPTS - 1)
  })

  it('keeps the worst-case wait per page bounded', () => {
    const total = NO_QUERY_FOUND_BACKOFF_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeLessThanOrEqual(10_000)
  })
})
