import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// This suite is about ONE question: when does `refreshOrThrow` go back to the
// browser for fresh cookies? It mocks `src/auth.js` so `loadAuthIntoClient`
// becomes an observable spy — hence a separate file from sync.test.ts, which
// exercises the real auth module.
const loadAuthIntoClientMock = vi.fn()
vi.mock('../../src/auth.js', () => ({
  loadAuthIntoClient: (...args: unknown[]) => loadAuthIntoClientMock(...args),
}))

import { handleSyncTransactions } from '../../src/tools/sync.js'
import { CreditKarmaClient } from '../../src/client.js'
import { CkAuthError } from '../../src/authError.js'
import { initDb } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import type { TransactionPage } from '../../src/client.js'
import { makeJwt } from '../helpers.js'

const emptyPage = (): TransactionPage => ({
  transactions: [],
  pageInfo: { startCursor: 's', endCursor: 'e', hasNextPage: false, hasPreviousPage: false },
})

/** A refresh JWT whose `exp` is `secondsFromNow` away (negative ⇒ expired). */
const refreshJwt = (secondsFromNow: number) =>
  makeJwt({ glid: 'g1', exp: Math.floor(Date.now() / 1000) + secondsFromNow })

describe('refreshOrThrow — re-reading browser cookies', () => {
  let ctx: AppContext

  beforeEach(() => {
    loadAuthIntoClientMock.mockReset()
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: '/tmp/.mcp.json',
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-bootstraps when the cached refresh token has already expired', async () => {
    // THE BUG: a long-lived server that bootstrapped >8h ago holds a refresh
    // JWT that is present but dead. The old code only re-read browser cookies
    // when the token was *absent*, so it POSTed the dead token forever and the
    // user could not recover by signing back in — only by restarting the server.
    ctx.client.setRefreshToken(refreshJwt(-60))
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(loadAuthIntoClientMock).toHaveBeenCalledWith(ctx.client)
    expect(refreshSpy).toHaveBeenCalled()
  })

  it('does NOT re-bootstrap when the cached refresh token is still valid', async () => {
    // Re-reading cookies spins up a WS bridge to the extension; don't do it
    // when the token we hold is perfectly good.
    ctx.client.setRefreshToken(refreshJwt(3600))
    vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(loadAuthIntoClientMock).not.toHaveBeenCalled()
  })

  it('re-bootstraps and retries once when CK rejects a valid-looking session', async () => {
    // The JWT's own `exp` says valid, but CK rejected it anyway (revoked
    // session, rotated device id). Fresh cookies may well be sitting in the
    // browser — go get them before giving up.
    ctx.client.setRefreshToken(refreshJwt(3600))
    const refreshSpy = vi
      .spyOn(ctx.client, 'refreshAccessToken')
      .mockRejectedValueOnce(new CkAuthError('session_rejected', 'CK auth: session rejected', 400))
      .mockResolvedValueOnce('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(loadAuthIntoClientMock).toHaveBeenCalledTimes(1)
    expect(refreshSpy).toHaveBeenCalledTimes(2)
  })

  it('gives up after one re-bootstrap when the fresh session is also rejected', async () => {
    // No retry loop: if the cookies we just lifted are also rejected, the user
    // genuinely has to sign in again.
    ctx.client.setRefreshToken(refreshJwt(3600))
    vi.spyOn(ctx.client, 'refreshAccessToken').mockRejectedValue(
      new CkAuthError('session_rejected', 'CK auth: session rejected — HTTP 400', 400),
    )

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow(/session rejected/)
    expect(loadAuthIntoClientMock).toHaveBeenCalledTimes(1)
  })

  it('does not re-bootstrap twice when the token was already stale', async () => {
    // Stale token ⇒ we bootstrapped up front. A rejection after that means the
    // browser cookies themselves are bad; re-reading them again is pointless.
    ctx.client.setRefreshToken(refreshJwt(-60))
    vi.spyOn(ctx.client, 'refreshAccessToken').mockRejectedValue(
      new CkAuthError('session_rejected', 'CK auth: session rejected — HTTP 400', 400),
    )

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow(/session rejected/)
    expect(loadAuthIntoClientMock).toHaveBeenCalledTimes(1)
  })

  it('does not re-bootstrap on a non-auth refresh failure', async () => {
    // A network blip is not an auth problem — don't prompt the browser for it.
    ctx.client.setRefreshToken(refreshJwt(3600))
    vi.spyOn(ctx.client, 'refreshAccessToken').mockRejectedValue(new Error('ECONNRESET'))

    await expect(handleSyncTransactions({}, ctx)).rejects.toThrow(/ECONNRESET/)
    expect(loadAuthIntoClientMock).not.toHaveBeenCalled()
  })

  it('still re-bootstraps when there is no refresh token at all', async () => {
    const refreshSpy = vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(loadAuthIntoClientMock).toHaveBeenCalledWith(ctx.client)
    expect(refreshSpy).toHaveBeenCalled()
  })

  it('treats an opaque (non-JWT) refresh token as usable', async () => {
    // `isJwtExpired` is deliberately lenient: an undecodable token is not
    // proof of staleness, so let CK be the judge rather than prompting the
    // browser on every sync.
    ctx.client.setRefreshToken('opaque-not-a-jwt')
    vi.spyOn(ctx.client, 'refreshAccessToken').mockResolvedValue('fresh')
    vi.spyOn(ctx.client, 'fetchPage').mockResolvedValue(emptyPage())

    await handleSyncTransactions({}, ctx)

    expect(loadAuthIntoClientMock).not.toHaveBeenCalled()
  })
})
