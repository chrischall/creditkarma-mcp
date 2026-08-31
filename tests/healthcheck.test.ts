import { describe, it, expect } from 'vitest'
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
  loadAuth?: () => Promise<void>
  probe?: () => Promise<unknown>
}): Promise<Result> {
  const client = { fetchPage: opts.probe ?? (async () => ({ transactions: [] })) } as unknown as CreditKarmaClient
  const ctx = { client } as AppContext
  const h = await createTestHarness((server) =>
    registerHealthcheckTools(server, ctx, {
      resolve: opts.resolve ?? (async () => ({ cookies: `CKAT=${LIVE}`, source: 'env' })),
      loadAuth: opts.loadAuth ?? (async () => {}),
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
  it('reports each JWT’s liveness separately, never the JWT', async () => {
    const r = await call({
      resolve: async () => ({ cookies: `CKAT=${DEAD}|${LIVE}`, source: 'fetchproxy' }),
    })
    expect(r.credential.detail?.access_token).toBe('expired')
    expect(JSON.stringify(r)).not.toContain(DEAD.split('.')[1])
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
      loadAuth: async () => {
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
      loadAuth: async () => {
        throw new CkAuthError('session_rejected', 'CK returned 401')
      },
    })
    expect(r.error?.kind).toBe('credential_rejected')
    expect(r.error?.detail).toEqual({ reason: 'session_rejected' })
  })
})
