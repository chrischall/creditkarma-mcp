import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test'
import { registerHealthcheckTools } from '../src/tools/healthcheck.js'
import type { AppContext } from '../src/index.js'
import type { CreditKarmaClient } from '../src/client.js'
import { CkAuthError } from '../src/authError.js'

interface Result {
  ok: boolean
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
}): Promise<Result> {
  const held = opts.held ?? {}
  const client = {
    fetchPage: opts.probe ?? (async () => ({ transactions: [] })),
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
    const client = { fetchPage: async () => ({}) } as unknown as CreditKarmaClient
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
