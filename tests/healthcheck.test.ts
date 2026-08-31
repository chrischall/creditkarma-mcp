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

async function call(opts: {
  resolve?: () => Promise<{ cookies: string; source: 'env' | 'fetchproxy' }>
  applyCookies?: () => void
  probe?: () => Promise<unknown>
}): Promise<Result> {
  const client = { fetchPage: opts.probe ?? (async () => ({ transactions: [] })) } as unknown as CreditKarmaClient
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
  it('rethrows a non-no_credentials resolver failure', async () => {
    const r = await call({
      resolve: async () => {
        throw new CkAuthError('session_rejected', 'CK rejected the cookies at refresh')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/rejected the cookies/)
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
