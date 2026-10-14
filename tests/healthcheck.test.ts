import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test'
import { registerHealthcheckTools } from '../src/tools/healthcheck.js'
import type { AppContext } from '../src/index.js'
import type { CreditKarmaClient, RefreshOutcome } from '../src/client.js'
import { CkAuthError } from '../src/authError.js'
import { EdgeBlockedError } from '@chrischall/mcp-utils'

interface Step { status: string; [k: string]: unknown }
interface Result {
  ok: boolean
  steps: { credential_lookup: Step; token_validity: Step; refresh: Step; probe: Step }
  failed_step?: string
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> }
  error?: { kind: string; message: string; detail?: Record<string, unknown> }
  hint: string
}

// A JWT whose exp is far future / long past. Only the exp claim is read.
const jwt = (exp: number) =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
const LIVE = jwt(Math.floor(Date.now() / 1000) + 3600)
const DEAD = jwt(Math.floor(Date.now() / 1000) - 3600)

/** What the SHARED client already holds. Default: nothing (a fresh server). */
interface Held { token?: string | null; refreshToken?: string | null; accessExpired?: boolean }

async function call(opts: {
  resolve?: () => Promise<{ cookies: string; source: 'env' | 'session' | 'fetchproxy' }>
  applyCookies?: () => void
  probe?: () => Promise<unknown>
  held?: Held
  /** What the client's refresh did while the probe ran, if it ran one. */
  refreshDuringProbe?: RefreshOutcome
}): Promise<Result> {
  const held = opts.held ?? {}
  let lastRefresh: RefreshOutcome | null = null
  const probe = opts.probe ?? (async () => ({ transactions: [] }))
  const client = {
    fetchPage: async () => {
      if (opts.refreshDuringProbe) lastRefresh = opts.refreshDuringProbe
      return probe()
    },
    getLastRefresh: () => lastRefresh,
    getToken: () => held.token ?? null,
    getRefreshToken: () => held.refreshToken ?? null,
    isTokenExpired: () => held.accessExpired ?? !held.token,
  } as unknown as CreditKarmaClient
  const ctx = { client } as AppContext
  const h = await createTestHarness((server) =>
    registerHealthcheckTools(server, ctx, {
      resolve: opts.resolve ?? (async () => ({ cookies: `CKAT=${LIVE}`, source: 'env' })),
      applyCookies: opts.applyCookies ?? (() => {}),
    }),
  )
  const res = await h.client.callTool({ name: 'ck_healthcheck', arguments: {} })
  await h.close?.()
  return parseToolResult<Result>(res as never)
}

describe('ck_healthcheck', () => {
  it('reports ok and which path supplied the cookies', async () => {
    const r = await call({})
    expect(r.ok).toBe(true)
    expect(r.credential.source).toBe('env')
  })

  // An expired ACCESS token beside a live REFRESH token is the normal steady
  // state — reporting only "expired" would read as broken when it is fine.
  // The separator is '%3B' — the ENCODED semicolon, inside the CKAT value.
  // A literal ';' cannot work: `parseCookieHeader` consumes it as the cookie
  // delimiter, so `CKAT=a;b` yields CKAT=a and the refresh half is lost. The
  // original fixture used '|', which never split either — so this test passed
  // while asserting nothing whatsoever about refresh liveness.
  it('reports each JWT’s liveness separately, never the JWT', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${DEAD}%3B${LIVE}`, source: 'fetchproxy' }),
    })
    expect(r.credential.detail?.access_token).toBe('expired')
    // The half that was never exercised: an expired ACCESS token beside a LIVE
    // refresh token is the normal steady state.
    expect(r.credential.detail?.refresh_token).toBe('live')
    expect(JSON.stringify(r)).not.toContain(DEAD.split('.')[1])
    expect(JSON.stringify(r)).not.toContain(LIVE.split('.')[1])
  })

  it('reports the reverse pair too, so neither slot is hard-coded', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${LIVE}%3B${DEAD}`, source: 'fetchproxy' }),
    })
    expect(r.credential.detail?.access_token).toBe('live')
    expect(r.credential.detail?.refresh_token).toBe('expired')
  })

  it('reports an absent token rather than guessing', async () => {
    const r = await call({ resolve: async () => ({ cookies: '', source: 'env' }) })
    expect(r.credential.detail?.access_token).toBe('absent')
    expect(r.credential.detail?.refresh_token).toBe('absent')
  })

  // A resolver failure that is NOT no_credentials must propagate, not be
  // silently reported as a missing credential.
  // A session Credit Karma rejected is a REJECTED credential, not a missing
  // one — including when the rejection surfaces from the resolver rather than
  // the probe. mcp-utils 0.19.3 consults classifyThrown on that path, so the
  // arm and the hint now match the cause; before it, this landed in
  // `no_credential` and advised setting CK_COOKIES that were already set.
  it('classifies a resolver-side rejection as rejected, not as missing', async () => {
    const r = await call({
      resolve: async () => {
        throw new CkAuthError('session_rejected', 'CK rejected the cookies at refresh')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/rejected the cookies/)
    expect(r.error?.kind).toBe('credential_rejected')
    expect(r.error?.detail).toEqual({ reason: 'session_rejected' })
    expect(r.hint).toMatch(/Sign in again in the browser/)
    expect(r.hint).not.toMatch(/Set CK_COOKIES/)
  })

  it('treats "nothing readable" as no_credential and warns the mirror still answers', async () => {
    const r = await call({
      resolve: async () => {
        throw new CkAuthError('no_credentials', 'CK auth: no credentials readable — set CK_COOKIES')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.credential.source).toBeNull()
    expect(r.hint).toMatch(/LOCAL mirror/i)
  })

  // The distinction that matters: a session that EXISTS and is dead must not
  // be advised as "set CK_COOKIES" — they are already set.
  it('classifies a stale session as rejected, not as missing', async () => {
    const r = await call({
      applyCookies: () => {
        throw new CkAuthError('session_stale', 'refresh JWT expired')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.credential.resolved).toBe(true)
    expect(r.error?.kind).toBe('credential_rejected')
    expect(r.error?.detail).toEqual({ reason: 'session_stale' })
    expect(r.hint).not.toMatch(/set CK_COOKIES/)
  })

  it('classifies an upstream rejection as rejected too', async () => {
    const r = await call({
      applyCookies: () => {
        throw new CkAuthError('session_rejected', 'CK returned 401')
      },
    })
    expect(r.error?.kind).toBe('credential_rejected')
    expect(r.error?.detail).toEqual({ reason: 'session_rejected' })
  })
})

// fleet-audit#70: the healthcheck used to re-apply the resolved cookies onto
// the SHARED client on every call. After a sync had refreshed (rotating CK's
// refresh token) that put the rotated-out pair back, and the next refresh
// failed with session_rejected — a diagnostic breaking a working session.
describe('ck_healthcheck: never clobbers the live session', () => {
  it('probes with the session the client already holds instead of re-applying cookies', async () => {
    let applied = 0
    const r = await call({
      held: { token: 'rotated-acc', refreshToken: LIVE, accessExpired: false },
      applyCookies: () => { applied++ },
    })
    expect(r.ok).toBe(true)
    expect(applied).toBe(0)
  })

  it('keeps a held session whose access token lapsed but whose refresh token is live', async () => {
    let applied = 0
    await call({
      held: { token: 'old-acc', refreshToken: LIVE, accessExpired: true },
      applyCookies: () => { applied++ },
    })
    expect(applied).toBe(0)
  })

  it('applies the resolved cookies when the held session is spent', async () => {
    let applied = 0
    await call({
      held: { token: 'old-acc', refreshToken: DEAD, accessExpired: true },
      applyCookies: () => { applied++ },
    })
    expect(applied).toBe(1)
  })

  it('applies the resolved cookies when the held access token is spent and there is no refresh token', async () => {
    let applied = 0
    await call({
      held: { token: 'old-acc', refreshToken: null, accessExpired: true },
      applyCookies: () => { applied++ },
    })
    expect(applied).toBe(1)
  })

  it('applies the resolved cookies to a client that holds nothing yet', async () => {
    let applied = 0
    await call({ applyCookies: () => { applied++ } })
    expect(applied).toBe(1)
  })
})

// classifyThrown must DECLINE anything that is not a CkAuthError, so an
// ordinary upstream failure keeps its own arm instead of being reported as a
// rejected credential — the credential is fine; Credit Karma is not.
describe('ck_healthcheck: non-auth probe failures', () => {
  it('declines to classify a plain upstream error', async () => {
    const r = await call({
      probe: async () => {
        throw Object.assign(new Error('Credit Karma 503'), { status: 503 })
      },
    })
    expect(r.ok).toBe(false)
    expect(r.error?.kind).not.toBe('credential_rejected')
    expect(r.credential.resolved).toBe(true)
  })

  // A CkAuthError that IS no_credentials reaching the probe is not a
  // rejection either: nothing was there to reject.
  it('declines to classify a no_credentials CkAuthError at probe time', async () => {
    const r = await call({
      applyCookies: () => {
        throw new CkAuthError('no_credentials', 'resolved cookies had no CKAT')
      },
    })
    expect(r.error?.kind).not.toBe('credential_rejected')
  })
})

// The production wiring: registered with no injected seams, so the real
// `resolveAuth` / `applyCookiesToClient` defaults are the ones used. Driven
// with nothing configured and fetchproxy off, so it resolves to "no
// credential" and returns before any probe — no network, no browser.
describe('ck_healthcheck: default wiring', () => {
  const VARS = ['CK_COOKIES', 'CK_DISABLE_FETCHPROXY'] as const
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of VARS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    process.env.CK_DISABLE_FETCHPROXY = '1'
  })
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('uses the real resolver and reports no_credential', async () => {
    const client = { fetchPage: async () => ({}), getLastRefresh: () => null } as unknown as CreditKarmaClient
    const h = await createTestHarness((server) =>
      registerHealthcheckTools(server, { client } as AppContext),
    )
    const res = await h.client.callTool({ name: 'ck_healthcheck', arguments: {} })
    await h.close?.()
    const r = parseToolResult<Result>(res as never)
    expect(r.ok).toBe(false)
    expect(r.credential.source).toBeNull()
  })
})

// 2026-10-13: the healthcheck said only "credential_rejected … sign in again",
// four times in a row, for a session signed in minutes earlier. Each hop is now
// reported on its own so the failing one is named, and an edge block is not
// sent back to the sign-in page.
describe('ck_healthcheck: hop-by-hop report', () => {
  const nowS = () => Math.floor(Date.now() / 1000)
  const tok = (claims: Record<string, number>) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

  it('reports every hop on success, with the refresh skipped', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${LIVE}%3B${LIVE}`, source: 'fetchproxy' }),
    })
    expect(r.ok).toBe(true)
    expect(r.steps.credential_lookup).toEqual({ status: 'ok', source: 'fetchproxy' })
    expect(r.steps.token_validity).toMatchObject({ status: 'ok', access_token: 'live', refresh_token: 'live' })
    expect(r.steps.token_validity.access_expires_in_s).toBeGreaterThan(3500)
    expect(r.steps.refresh).toEqual({ status: 'skipped' })
    expect(r.steps.probe).toEqual({ status: 'ok' })
    expect(r.failed_step).toBeUndefined()
  })

  it('reports a refresh that ran and worked', async () => {
    const r = await call({ refreshDuringProbe: { outcome: 'ok', status: 200, at: Date.now() } })
    expect(r.ok).toBe(true)
    expect(r.steps.refresh).toEqual({ status: 'ok', http_status: 200 })
  })

  it('names the refresh as the failing hop when it is', async () => {
    const msg = 'CK auth: session rejected — Token refresh failed: HTTP 400 — (non-JSON error page)'
    const r = await call({
      refreshDuringProbe: { outcome: 'failed', status: 400, message: msg, at: Date.now() },
      probe: async () => {
        throw new CkAuthError('session_rejected', msg, 400)
      },
    })
    expect(r.ok).toBe(false)
    expect(r.steps.refresh).toEqual({ status: 'failed', http_status: 400, message: msg })
    expect(r.steps.probe).toEqual({ status: 'not_reached' })
    expect(r.failed_step).toBe('refresh')
  })

  // Measured 2026-10-13: a refresh token issued 23 min earlier, not expired,
  // was refused because CK had already ended the session (an idle tab was
  // signed out). A recent `iat` does NOT prove the session alive, so a
  // rejection always advises signing in again — and says why that is the
  // usual cause even for a token that looks new.
  it('advises signing in again even when the rejected token looks new, and says why', async () => {
    const recent = tok({ iat: nowS() - 23 * 60, exp: nowS() + 8 * 3600 })
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${LIVE}%3B${recent}`, source: 'fetchproxy' }),
      refreshDuringProbe: { outcome: 'failed', status: 400, at: Date.now() },
      probe: async () => {
        throw new CkAuthError('session_rejected', 'refresh 400', 400)
      },
    })
    expect(r.hint).toMatch(/Sign in again/)
    expect(r.hint).toMatch(/issued 23 min ago/)
    expect(r.hint).toMatch(/ends sessions/)
    expect(r.hint).toMatch(/CK_DEBUG=1/)
  })

  it('advises signing in without the "looks new" note for an old token', async () => {
    const old = tok({ iat: nowS() - 6 * 3600, exp: nowS() + 2 * 3600 })
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${LIVE}%3B${old}`, source: 'fetchproxy' }),
      probe: async () => {
        throw new CkAuthError('session_rejected', 'refresh 400', 400)
      },
    })
    expect(r.hint).toMatch(/Sign in again/)
    expect(r.hint).not.toMatch(/min ago/)
  })

  // The case that genuinely must NOT send anyone to the sign-in page: the edge
  // refused the refresh before CK saw the token.
  it('does not advise signing in when the refresh was blocked at the edge', async () => {
    const r = await call({
      refreshDuringProbe: { outcome: 'failed', status: 200, message: 'blocked', at: Date.now() },
      probe: async () => {
        throw new EdgeBlockedError(200, 'Akamai', { service: 'creditkarma.com', method: 'POST', path: '/mobile/4.5/oauth2/token' })
      },
    })
    expect(r.ok).toBe(false)
    expect(r.failed_step).toBe('refresh')
    expect(r.hint).not.toMatch(/sign in again/i)
  })

  it('reports a refresh that failed before any HTTP status (transport error)', async () => {
    const r = await call({
      refreshDuringProbe: { outcome: 'failed', message: 'fetch failed', at: Date.now() },
      probe: async () => {
        throw new Error('fetch failed')
      },
    })
    expect(r.steps.refresh).toEqual({ status: 'failed', message: 'fetch failed' })
    expect(r.failed_step).toBe('refresh')
  })

  it('names the probe when the request itself failed', async () => {
    const r = await call({
      probe: async () => {
        throw new Error('Credit Karma 503')
      },
    })
    expect(r.steps.refresh).toEqual({ status: 'skipped' })
    expect(r.steps.probe).toMatchObject({ status: 'failed', message: 'Credit Karma 503' })
    expect(r.failed_step).toBe('probe')
  })

  it('names the token check when the session is stale before any request', async () => {
    const r = await call({
      applyCookies: () => {
        throw new CkAuthError('session_stale', 'refresh JWT expired')
      },
    })
    expect(r.steps.token_validity.status).toBe('failed')
    expect(r.steps.refresh).toEqual({ status: 'not_reached' })
    expect(r.failed_step).toBe('token_validity')
  })

  it('names the credential lookup when nothing resolved', async () => {
    const r = await call({
      resolve: async () => {
        throw new CkAuthError('no_credentials', 'CK auth: no credentials readable')
      },
    })
    expect(r.steps.credential_lookup).toMatchObject({ status: 'failed' })
    expect(r.steps.token_validity).toEqual({ status: 'not_reached' })
    expect(r.steps.probe).toEqual({ status: 'not_reached' })
    expect(r.failed_step).toBe('credential_lookup')
  })

  it('names the credential lookup when the resolver throws something else', async () => {
    const r = await call({
      resolve: async () => {
        throw new Error('ContextMint Bridge is down')
      },
    })
    expect(r.steps.credential_lookup).toEqual({ status: 'failed', message: 'ContextMint Bridge is down' })
    expect(r.failed_step).toBe('credential_lookup')
  })

  it('reports an expired access token as fine when the refresh token is live', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${DEAD}%3B${LIVE}`, source: 'session' }),
    })
    expect(r.steps.token_validity).toMatchObject({ status: 'ok', access_token: 'expired', refresh_token: 'live' })
  })

  it('reports the token check as failed when neither token can be used', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${DEAD}%3B${DEAD}`, source: 'session' }),
      applyCookies: () => {
        throw new CkAuthError('session_stale', 'refresh JWT expired')
      },
    })
    expect(r.steps.token_validity).toMatchObject({ status: 'failed', access_token: 'expired', refresh_token: 'expired' })
  })

  it('reports a non-Error throw as text', async () => {
    const r = await call({
      resolve: async () => {
        throw 'bridge exploded'
      },
    })
    expect(r.steps.credential_lookup).toEqual({ status: 'failed', message: 'bridge exploded' })
  })

  it('never echoes a token in the hop report', async () => {
    const r = await call({ resolve: async () => ({ cookies: `CKAT=${LIVE}%3B${LIVE}`, source: 'env' }) })
    expect(JSON.stringify(r.steps)).not.toContain(LIVE.split('.')[1])
  })
})
