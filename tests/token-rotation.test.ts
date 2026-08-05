import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CreditKarmaClient } from '../src/client.js'
import { handleSyncTransactions } from '../src/tools/sync.js'
import { initDb } from '../src/db.js'
import type { AppContext } from '../src/index.js'
import type { TransactionPage } from '../src/client.js'
import * as auth from '../src/auth.js'

// Every call to CK's /member/oauth2/refresh ROTATES the refresh token, and the
// browser and this MCP share one CKAT cookie holding it. So a needless refresh
// does real damage: it invalidates the copy in the browser's cookie, and CK
// then signs the tab out — reported to the user as "logged you out due to
// inactivity", which points nowhere near the cause (#119).
//
// The defence is to refresh only when the access token is genuinely spent,
// which requires knowing when that actually is: the synthetic 10-minute TTL
// this client used to assume is unrelated to the JWT's real lifetime.

/** Minimal unsigned JWT — only the `exp` claim is ever read. */
const jwt = (expSecondsFromNow: number) => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString(
    'base64url',
  )
  return `header.${payload}.signature`
}

const emptyPage = (): TransactionPage => ({
  transactions: [],
  pageInfo: { startCursor: 's', endCursor: 'e', hasNextPage: false, hasPreviousPage: false },
})

describe('access-token expiry tracks the JWT, not a synthetic window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('treats a token as live while its own exp is in the future', async () => {
    // CK access tokens outlive the old 10-minute assumption. Believing the
    // synthetic window forces a refresh — and a rotation — that CK never needed.
    const client = new CreditKarmaClient(jwt(30 * 60))

    vi.advanceTimersByTime(12 * 60 * 1000)

    expect(client.isTokenExpired()).toBe(false)
  })

  it('treats a token as expired once its own exp has passed', async () => {
    // A cookie read from the browser can already be stale; the synthetic
    // window would have called it fresh for a full 10 minutes.
    const client = new CreditKarmaClient(jwt(-60))

    expect(client.isTokenExpired()).toBe(true)
  })

  it('falls back to the conservative window for an undecodable token', async () => {
    // Opaque tokens still work — expiry just becomes a guess again.
    const client = new CreditKarmaClient('not-a-jwt')

    expect(client.isTokenExpired()).toBe(false)
    vi.advanceTimersByTime(10 * 60 * 1000 + 1)
    expect(client.isTokenExpired()).toBe(true)
  })
})

describe('sync does not rotate a refresh token it did not need to', () => {
  let ctx: AppContext
  let originalDisable: string | undefined

  beforeEach(() => {
    originalDisable = process.env.CK_DISABLE_FETCHPROXY
    process.env.CK_DISABLE_FETCHPROXY = '1'
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: '/tmp/.mcp.json',
    } as AppContext
  })

  afterEach(() => {
    if (originalDisable === undefined) delete process.env.CK_DISABLE_FETCHPROXY
    else process.env.CK_DISABLE_FETCHPROXY = originalDisable
    ctx.db.close()
    vi.restoreAllMocks()
  })

  it('skips the refresh when the bootstrapped access token is still live', async () => {
    // The whole point: `loadAuthIntoClient` has just read a cookie the browser
    // actively maintains. If that access JWT is good, POSTing /refresh buys
    // nothing and costs the user their browser session.
    vi.spyOn(auth, 'loadAuthIntoClient').mockImplementation(async (client) => {
      client.setToken(jwt(20 * 60))
      client.setRefreshToken(jwt(8 * 60 * 60))
    })
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('still refreshes when the bootstrapped access token is spent', async () => {
    // Skipping here would just fail the first page and re-auth the slow way.
    vi.spyOn(auth, 'loadAuthIntoClient').mockImplementation(async (client) => {
      client.setToken(jwt(-60))
      client.setRefreshToken(jwt(8 * 60 * 60))
    })
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('refreshes without re-bootstrapping when only the access token is spent', async () => {
    // Cached refresh token still good — no reason to go back to the browser.
    ctx.client.setToken(jwt(-60))
    ctx.client.setRefreshToken(jwt(8 * 60 * 60))
    const bootstrap = vi.spyOn(auth, 'loadAuthIntoClient')
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(bootstrap).not.toHaveBeenCalled()
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('does not sync on a token it only assumed was good', async () => {
    // Guard against over-correcting: a live-looking token that CK rejects must
    // still reach the existing mid-sync re-auth path rather than failing hard.
    vi.spyOn(auth, 'loadAuthIntoClient').mockImplementation(async (client) => {
      client.setToken(jwt(20 * 60))
      client.setRefreshToken(jwt(8 * 60 * 60))
    })
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage')
      .mockRejectedValueOnce(new Error('TOKEN_EXPIRED'))
      .mockResolvedValueOnce(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })
})
