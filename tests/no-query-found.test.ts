import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CreditKarmaClient,
  isNoQueryFound,
  CK_CLIENT_NAME,
  CK_CLIENT_VERSION,
  TRANSACTION_OPERATION_NAME,
  TRANSACTION_QUERY_HASH,
} from '../src/client.js'

// Credit Karma's GraphQL gateway answers `HTTP 400 {"message":"No query
// found"}` when it cannot resolve a request against its safelisted operation
// registry. It is not a flake and it is not retryable — measured 2026-08-05
// against a live account by ablating one header at a time from a working
// request:
//
//   200  all headers (control)          200  minus ck-cookie-id
//   400  minus ck-client-name           200  minus ck-device-type
//   400  minus ck-client-version        200  minus ck-trace-id / tz-id / accept
//   400  ck-client-name: "web"          200  no Origin / Referer / User-Agent
//   400  prime_web + full query doc     200  ONLY ck-client-name + ck-client-version
//
// So two things are required, and nothing else is: the `ck-client-name` /
// `ck-client-version` pair, and a persisted-query body carrying only a
// sha256 hash. A full ad-hoc document is rejected even with correct headers.

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

describe('persisted-query request shape', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    client = new CreditKarmaClient('valid-token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const capture = async (cursor?: string) => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(okResponse())
    await client.fetchPage(cursor)
    const init = spy.mock.calls[0][1] as RequestInit
    return {
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    }
  }

  it('sends the persisted hash instead of a query document', async () => {
    // The gateway rejects ad-hoc documents outright, so sending `query` is not
    // a harmless extra — the whole request fails.
    const { body } = await capture()

    expect(body.extensions.persistedQuery).toEqual({ version: 1, sha256Hash: TRANSACTION_QUERY_HASH })
    expect(body.operationName).toBe(TRANSACTION_OPERATION_NAME)
    expect(body).not.toHaveProperty('query')
  })

  it('pins the hash to the operation CK has safelisted', () => {
    // A 64-hex sha256 from CK's own pregenerated manifest. If CK ships a web
    // build that rotates it, sync starts failing with "No query found" again.
    expect(TRANSACTION_QUERY_HASH).toMatch(/^[0-9a-f]{64}$/)
    expect(TRANSACTION_OPERATION_NAME).toBe('GetTransactions')
  })

  it('still sends the pagination cursor in variables', async () => {
    const { body } = await capture('my-cursor')

    expect(body.variables.input.paginationInput.afterCursor).toBe('my-cursor')
  })

  it('identifies as prime_web — the exact value the registry is keyed on', async () => {
    // "web" (the value the refresh endpoint takes) is rejected here.
    const { headers } = await capture()

    expect(headers['ck-client-name']).toBe('prime_web')
    expect(CK_CLIENT_NAME).toBe('prime_web')
  })

  it('sends a non-empty ck-client-version', async () => {
    // Presence-checked only — any non-empty value works, an empty one 400s.
    const { headers } = await capture()

    expect(headers['ck-client-version']).toBe(CK_CLIENT_VERSION)
    expect(CK_CLIENT_VERSION).not.toBe('')
  })

  it('still authenticates with the bearer token', async () => {
    const { headers } = await capture()

    expect(headers['Authorization']).toBe('Bearer valid-token')
  })
})

describe('fetchPage — "No query found" handling', () => {
  let client: CreditKarmaClient

  beforeEach(() => {
    client = new CreditKarmaClient('valid-token')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fails on the first attempt — retrying cannot help', async () => {
    // The rejection is deterministic: the gateway either resolves the hash or
    // it does not. Six attempts bought ~5.4s of backoff and nothing else.
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => noQueryFound())

    await expect(client.fetchPage()).rejects.toThrow(/No query found/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('blames a stale persisted hash, not the session', async () => {
    // The actionable fix is re-deriving the hash from CK's current web bundle.
    // Telling the user to re-authenticate or retry sends them nowhere.
    vi.spyOn(global, 'fetch').mockImplementation(async () => noQueryFound())

    const err = await client.fetchPage().catch((e: Error) => e)

    expect(err.message).toMatch(/persisted/i)
    expect(err.message).toMatch(/usePregeneratedHashes/)
    expect(err.message).not.toMatch(/retry the sync/i)
  })

  it('does NOT swallow a 400 that is a real query error', async () => {
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

  it('still throws TOKEN_EXPIRED on a 401', async () => {
    // Auth must still win: a 401 means re-auth, not a hash problem.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }))

    await expect(client.fetchPage()).rejects.toThrow('TOKEN_EXPIRED')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('still replays once after a 429', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(okResponse())

    const [page] = await Promise.all([client.fetchPage(), vi.runAllTimersAsync()])

    expect(page.transactions).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
