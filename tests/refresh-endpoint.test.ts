import { describe, it, expect, afterEach, vi } from 'vitest'
import { CreditKarmaClient, CK_REFRESH_ENDPOINT, CK_CLIENT_NAME, CK_CLIENT_VERSION } from '../src/client.js'
import { isCkAuthError, type CkAuthError } from '../src/authError.js'
import { EdgeBlockedError } from '@chrischall/mcp-utils'
import { makeJwt } from './helpers.js'

// 2026-10-13: every refresh failed with `HTTP 400 — (non-JSON error page …)`,
// even minutes after a fresh sign-in. The cause was the ENDPOINT: CK's web app
// (prime_web 2.0.35, `webAuthRefreshCkatCookie` / `refreshViaMobileApi`) no
// longer refreshes at www.creditkarma.com/member/oauth2/refresh — it POSTs
// api.creditkarma.com/mobile/4.5/oauth2/token. The retired URL answers EVERY
// request, a dummy token included, with the same HTML 400, so it read as a dead
// session when it was a dead route.

const nowS = () => Math.floor(Date.now() / 1000)
const access = (expInS: number) => makeJwt({ exp: nowS() + expInS, iat: nowS() - 60, glid: 'trace-123' })
const REFRESH = makeJwt({ exp: nowS() + 8 * 3600, iat: nowS() - 60 })

const page = () =>
  new Response(
    JSON.stringify({
      data: {
        prime: {
          transactionsHub: {
            transactionPage: {
              transactions: [],
              pageInfo: { startCursor: '', endCursor: '', hasNextPage: false, hasPreviousPage: false },
            },
          },
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const tokens = (a: string, r: string) =>
  new Response(JSON.stringify({ accessToken: a, refreshToken: r }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const urlOf = (call: unknown[]) => String(call[0])

afterEach(() => vi.restoreAllMocks())

describe('refresh request — matches what creditkarma.com itself sends', () => {
  it('targets the mobile OAuth token endpoint the web app uses', () => {
    expect(CK_REFRESH_ENDPOINT).toBe('https://api.creditkarma.com/mobile/4.5/oauth2/token')
  })

  it('sends the web app’s header set, the Bearer access token, and a JSON {refreshToken} body', async () => {
    const accessTok = access(600)
    const c = new CreditKarmaClient(accessTok, REFRESH, 'CKTRKID=cookie-id-1; CKAT=x%3By')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(tokens('new-a', 'new-r'))

    await c.refreshAccessToken()

    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(CK_REFRESH_ENDPOINT)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: REFRESH })
    const h = init.headers as Record<string, string>
    expect(h['authorization']).toBe(`Bearer ${accessTok}`)
    expect(h['ck-client-name']).toBe(CK_CLIENT_NAME)
    expect(h['ck-client-version']).toBe(CK_CLIENT_VERSION)
    expect(h['ck-device-type']).toBe('Desktop')
    expect(h['content-type']).toBe('application/json')
    expect(h['ck-cookie-id']).toBe('cookie-id-1')
    expect(h['ck-trace-id']).toBe('trace-123')
  })

  it('sends NO Cookie header — the browser’s cross-origin fetch carries none', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc; CKAT=x%3By')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(tokens('a', 'r'))
    await c.refreshAccessToken()
    const h = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('cookie')
  })

  // Measured 2026-10-13: without Origin or a browser User-Agent, Akamai answers
  // a canned `200 {"errorCode":"SecErr"}` (`server: AkamaiNetStorage`) and the
  // request never reaches CK. A live refresh without Origin failed that way.
  it('sends Origin and a browser User-Agent — without them Akamai answers a canned SecErr', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc; CKAT=x%3By')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(tokens('a', 'r'))
    await c.refreshAccessToken()
    const h = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(h['Origin']).toBe('https://www.creditkarma.com')
    expect(h['User-Agent']).toMatch(/Mozilla\/5\.0/)
  })

  // Measured live 2026-10-13: without Origin/User-Agent the refresh got
  // `200 {"errorCode":"SecErr"}` from `server: AkamaiNetStorage` — a static
  // file (2019 last-modified) the edge serves INSTEAD of forwarding. CK never
  // saw the token, so it is an edge block, not a rejected session.
  it('Akamai’s canned SecErr is an edge block, not a rejected session — and rotates nothing', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('{\n\t"errorCode":"SecErr",\n\t"errorMessage":"Security Error",\n\t"logUserOut": 0\n}', {
        status: 200,
        headers: { 'content-type': 'application/json', server: 'AkamaiNetStorage' },
      }),
    )
    const err = await c.refreshAccessToken().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(EdgeBlockedError)
    expect(isCkAuthError(err)).toBe(false)
    expect((err as Error).message).toMatch(/Akamai/)
    expect((err as Error).message).toContain('/mobile/4.5/oauth2/token')
    expect(c.getRefreshToken()).toBe(REFRESH)
    expect(c.getLastRefresh()).toMatchObject({ outcome: 'failed', status: 200 })
  })

  it('an errorCode from CK itself is a rejected session', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('{"errorCode":"SecErr","errorMessage":"Security Error"}', {
        status: 200,
        headers: { 'content-type': 'application/json', server: 'CK-FG-server' },
      }),
    )
    const err = (await c.refreshAccessToken().then(() => null, (e: unknown) => e)) as CkAuthError
    expect(isCkAuthError(err, 'session_rejected')).toBe(true)
    expect(err.message).toMatch(/SecErr \(Security Error\)/)
    expect(c.getRefreshToken()).toBe(REFRESH)
  })

  // Measured live 2026-10-13: a refresh token 23 min old, unexpired, from a
  // tab CK had already signed out got an EMPTY 400 from CK-FG-server.
  it('an empty 400 from CK says the session ended and to sign in again', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('', { status: 400, headers: { server: 'CK-FG-server', 'content-length': '0' } }),
    )
    const err = (await c.refreshAccessToken().then(() => null, (e: unknown) => e)) as CkAuthError
    expect(isCkAuthError(err, 'session_rejected')).toBe(true)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/HTTP 400/)
    expect(err.message).toMatch(/ended the session/)
    expect(err.message).toMatch(/sign in again/i)
  })

  it('a 200 whose body is not JSON is an error, not a crash', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>ok?</html>', { status: 200 }))
    await expect(c.refreshAccessToken()).rejects.toThrow(/HTTP 200 with a non-JSON body/)
  })

  it('an errorCode without an errorMessage still names the code', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{"errorCode":"SecErr"}', { status: 200 }))
    await expect(c.refreshAccessToken()).rejects.toThrow(/Token refresh failed: SecErr$/)
  })

  it('an HTML 400 page is reported as a rejection that names the endpoint, without blaming sign-in', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('<!DOCTYPE html><html lang="en"><head></head><body>error</body></html>', {
        status: 400,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const err = (await c.refreshAccessToken().then(() => null, (e: unknown) => e)) as CkAuthError
    expect(isCkAuthError(err, 'session_rejected')).toBe(true)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/non-JSON error page/)
    expect(err.message).toContain('/mobile/4.5/oauth2/token')
  })
})

describe('refresh only when needed', () => {
  it('a valid access token is used directly — no refresh first', async () => {
    const c = new CreditKarmaClient(access(14 * 60), REFRESH, 'CKTRKID=abc')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(page())
    await c.fetchPage()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(urlOf(spy.mock.calls[0])).toContain('/graphql')
  })

  // The shared TokenManager's default skew is FIVE minutes, so a token the
  // healthcheck reported "live" with 4 minutes left was refreshed before use —
  // and when that refresh failed, the request failed with it.
  it('a token with a few minutes left is still used, not refreshed', async () => {
    const c = new CreditKarmaClient(access(4 * 60), REFRESH, 'CKTRKID=abc')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(page())
    await c.fetchPage()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(urlOf(spy.mock.calls[0])).toContain('/graphql')
  })

  it('a token about to expire IS refreshed first', async () => {
    const c = new CreditKarmaClient(access(20), REFRESH, 'CKTRKID=abc')
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(tokens(access(900), REFRESH))
      .mockResolvedValueOnce(page())
    await c.fetchPage()
    expect(spy.mock.calls.map(urlOf)).toEqual([CK_REFRESH_ENDPOINT, expect.stringContaining('/graphql')])
  })

  it('a 401 refreshes once, then retries the original request with the new token', async () => {
    const c = new CreditKarmaClient(access(14 * 60), REFRESH, 'CKTRKID=abc')
    const fresh = access(900)
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(tokens(fresh, makeJwt({ exp: nowS() + 9 * 3600 })))
      .mockResolvedValueOnce(page())
    await c.fetchPage()
    expect(spy.mock.calls.map(urlOf)).toEqual([
      expect.stringContaining('/graphql'),
      CK_REFRESH_ENDPOINT,
      expect.stringContaining('/graphql'),
    ])
    const retry = (spy.mock.calls[2][1] as RequestInit).headers as Record<string, string>
    expect(retry['Authorization']).toBe(`Bearer ${fresh}`)
  })
})

describe('refresh outcome is recorded for diagnostics', () => {
  it('starts with no refresh attempted', () => {
    expect(new CreditKarmaClient('a', 'r').getLastRefresh()).toBeNull()
  })

  it('records a successful refresh', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(tokens('a2', 'r2'))
    await c.refreshAccessToken()
    expect(c.getLastRefresh()).toMatchObject({ outcome: 'ok', status: 200 })
  })

  it('records a failed refresh with its status and reason', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('<!DOCTYPE html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    )
    await c.refreshAccessToken().catch(() => {})
    expect(c.getLastRefresh()).toMatchObject({ outcome: 'failed', status: 400 })
    expect(c.getLastRefresh()?.message).toMatch(/non-JSON/)
  })

  it('records a transport failure that never got a status', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    await c.refreshAccessToken().catch(() => {})
    expect(c.getLastRefresh()).toMatchObject({ outcome: 'failed', message: 'fetch failed' })
    expect(c.getLastRefresh()?.status).toBeUndefined()
  })

  it('records a non-Error rejection as a string', async () => {
    const c = new CreditKarmaClient(access(600), REFRESH, 'CKTRKID=abc')
    vi.spyOn(global, 'fetch').mockRejectedValueOnce('boom')
    await c.refreshAccessToken().catch(() => {})
    expect(c.getLastRefresh()).toMatchObject({ outcome: 'failed', message: 'boom' })
  })
})
