import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EdgeBlockedError } from '@chrischall/mcp-utils'
import { CreditKarmaClient, OPERATIONS, type OperationSpec } from '../src/client.js'
import * as queryHash from '../src/queryHash.js'

// Balance data comes from operations in THREE different CK web apps, and the
// gateway keys its safelist on `ck-client-name` — a hash registered for
// `credit-health` answers "No query found" when sent as `prime_web`. So every
// operation carries its own client identity, and must be sent with it.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const noQueryFound = () => json({ message: 'No query found' }, 400)

const ROTATED = 'f'.repeat(64)

describe('CreditKarmaClient.runOperation', () => {
  let client: CreditKarmaClient
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    client = new CreditKarmaClient('valid-token', undefined, 'CKAT=x')
    fetchSpy = vi.spyOn(global, 'fetch')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const sent = (i = 0) => {
    const [url, init] = fetchSpy.mock.calls[i] as [string, RequestInit]
    return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) }
  }

  it('sends a persisted request under the operation\'s own client identity', async () => {
    fetchSpy.mockResolvedValueOnce(json({ data: { ok: true } }))
    const result = await client.runOperation(OPERATIONS.getCreditReport, { bureau: 1, date: '2024-02-01T00:00:00Z' })

    expect(result).toEqual({ data: { ok: true } })
    const req = sent()
    expect(req.url).toBe('https://api.creditkarma.com/graphql')
    expect(req.headers['ck-client-name']).toBe('credit-health')
    expect(req.headers['ck-client-version']).toBe(OPERATIONS.getCreditReport.clientVersion)
    expect(req.headers['Authorization']).toBe('Bearer valid-token')
    expect(req.body).toEqual({
      extensions: { persistedQuery: { version: 1, sha256Hash: OPERATIONS.getCreditReport.hash } },
      operationName: 'getCreditReport',
      variables: { bureau: 1, date: '2024-02-01T00:00:00Z' },
    })
  })

  it('declares every balance operation with a 64-hex hash and the app that registered it', () => {
    const apps = Object.fromEntries(Object.entries(OPERATIONS).map(([k, v]) => [k, v.clientName]))
    expect(apps).toEqual({
      getAccountL2Page: 'prime_web',
      idxConnections: 'prime_web',
      getCreditReportHistory: 'credit-health',
      getCreditReport: 'credit-health',
    })
    for (const op of Object.values(OPERATIONS)) expect(op.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('throws TOKEN_EXPIRED without a token, sending nothing', async () => {
    const anon = new CreditKarmaClient()
    await expect(anon.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow('TOKEN_EXPIRED')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps HTTP 401 to TOKEN_EXPIRED', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }))
    await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('maps an auth errorCode in a 200 body to TOKEN_EXPIRED', async () => {
    fetchSpy.mockResolvedValueOnce(json({ errors: [{ message: 'nope', extensions: { code: 'UNAUTHENTICATED' } }] }))
    await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow('TOKEN_EXPIRED')
  })

  it('returns a non-auth GraphQL error body for the caller to interpret', async () => {
    const body = { errors: [{ message: 'An error occurred.' }], data: { creditReportsV2: { creditReport: null } } }
    fetchSpy.mockResolvedValueOnce(json(body))
    await expect(client.runOperation(OPERATIONS.getCreditReport, {})).resolves.toEqual(body)
  })

  it('backs off once on 429 and replays', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(json({ data: 1 }))
    const p = client.runOperation(OPERATIONS.idxConnections, {})
    await vi.advanceTimersByTimeAsync(2000)
    await expect(p).resolves.toEqual({ data: 1 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('maps a 401 on the 429 replay to TOKEN_EXPIRED', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response(null, { status: 401 }))
    const p = client.runOperation(OPERATIONS.idxConnections, {})
    const assertion = expect(p).rejects.toThrow('TOKEN_EXPIRED')
    await vi.advanceTimersByTimeAsync(2000)
    await assertion
  })

  it('surfaces other HTTP failures with status and a redacted body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('upstream exploded', { status: 500 }))
    await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow('HTTP 500: upstream exploded')
  })

  it('names a CDN block rather than reporting a rejected session', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<HTML><TITLE>ERROR: The request could not be satisfied</TITLE>Generated by cloudfront (CloudFront)</HTML>', {
      status: 403, headers: { 'content-type': 'text/html', 'x-cache': 'Error from cloudfront', server: 'CloudFront' },
    }))
    await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toBeInstanceOf(EdgeBlockedError)
  })

  describe('stale hash self-healing', () => {
    it('rediscovers the hash from the operation\'s own app and replays', async () => {
      const discover = vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(ROTATED)
      fetchSpy.mockResolvedValueOnce(noQueryFound()).mockResolvedValueOnce(json({ data: 'healed' }))

      await expect(client.runOperation(OPERATIONS.getCreditReport, {})).resolves.toEqual({ data: 'healed' })
      expect(discover).toHaveBeenCalledWith('getCreditReport', 'CKAT=x', queryHash.CREDIT_HEALTH_SOURCE)
      expect(sent(1).body.extensions.persistedQuery.sha256Hash).toBe(ROTATED)
    })

    it('keeps the healed hash for later calls', async () => {
      vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(ROTATED)
      fetchSpy.mockResolvedValueOnce(noQueryFound()).mockImplementation(async () => json({ data: 1 }))
      await client.runOperation(OPERATIONS.idxConnections, {})
      await client.runOperation(OPERATIONS.idxConnections, {})
      expect(sent(2).body.extensions.persistedQuery.sha256Hash).toBe(ROTATED)
    })

    it('tries discovery at most once per operation', async () => {
      const discover = vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(null)
      fetchSpy.mockImplementation(async () => noQueryFound())
      await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow(/No query found.*idxConnections/s)
      await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow(/idxConnections/)
      expect(discover).toHaveBeenCalledTimes(1)
    })

    it('does not replay when discovery finds the same hash', async () => {
      vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(OPERATIONS.idxConnections.hash)
      fetchSpy.mockImplementation(async () => noQueryFound())
      await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow(/No query found/)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('fails clearly when the healed hash is rejected too', async () => {
      vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(ROTATED)
      fetchSpy.mockImplementation(async () => noQueryFound())
      await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow(/No query found/)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('skips discovery without cookies — logged out there is no manifest', async () => {
      const discover = vi.spyOn(queryHash, 'discoverQueryHash')
      const noCookies = new CreditKarmaClient('valid-token')
      fetchSpy.mockImplementation(async () => noQueryFound())
      await expect(noCookies.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow(/No query found/)
      expect(discover).not.toHaveBeenCalled()
    })

    it('tracks each operation separately', async () => {
      const discover = vi.spyOn(queryHash, 'discoverQueryHash').mockResolvedValue(null)
      fetchSpy.mockImplementation(async () => noQueryFound())
      const other: OperationSpec = { ...OPERATIONS.idxConnections, operationName: 'getAccountL2Page' }
      await expect(client.runOperation(OPERATIONS.idxConnections, {})).rejects.toThrow()
      await expect(client.runOperation(other, {})).rejects.toThrow()
      expect(discover).toHaveBeenCalledTimes(2)
    })
  })
})
