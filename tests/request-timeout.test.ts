import { describe, it, expect, vi, afterEach } from 'vitest'
import { CreditKarmaClient, REQUEST_TIMEOUT_MS } from '../src/client.js'
import { searchVaultConnections } from '../src/vault.js'
import { makeJwt } from './helpers.js'

// fleet-audit#389: every Credit Karma / Intuit request carries an abort
// deadline, so a hung CK or Akamai connection fails the call instead of
// leaving ck_sync_transactions pending until the host gives up.

const live = () => makeJwt({ glid: 'g1', exp: Math.floor(Date.now() / 1000) + 3600 })

function signalOf(spy: ReturnType<typeof vi.spyOn>): AbortSignal | undefined {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined
  return init?.signal ?? undefined
}

describe('request timeouts', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is a bounded, sane deadline', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })

  it('GraphQL posts carry an abort signal', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { prime: { transactionsHub: { transactionPage: {
        transactions: [], pageInfo: { hasNextPage: false, endCursor: null },
      } } } } }), { status: 200 }),
    )
    const client = new CreditKarmaClient(live(), live())
    await client.fetchPage().catch(() => undefined)
    const signal = signalOf(spy)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('the token refresh POST carries an abort signal', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: live(), refreshToken: live() }), { status: 200 }),
    )
    const client = new CreditKarmaClient(undefined, live())
    await client.refreshAccessToken()
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal)
  })

  it('the Intuit vault search carries an abort signal', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }))
    await searchVaultConnections('idx-token')
    expect(signalOf(spy)).toBeInstanceOf(AbortSignal)
  })

  it('a request that never answers fails once the deadline passes', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')))
    vi.spyOn(global, 'fetch').mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        const s = (init as RequestInit).signal!
        if (s.aborted) reject(s.reason)
        s.addEventListener('abort', () => reject(s.reason))
      }),
    )
    await expect(searchVaultConnections('idx-token')).rejects.toThrow(/timed out/)
  })
})
