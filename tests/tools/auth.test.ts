import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSetSession, handleForgetSession, registerAuthTools } from '../../src/tools/auth.js'
import { readSavedSession } from '../../src/session.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import { fakeServer } from '../helpers.js'

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ck-test-'))
}

import { makeJwt } from '../helpers.js'
const expiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 })
const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })

describe('ck_set_session', () => {
  let ctx: AppContext
  let tmpDir: string

  let sessionFile: string
  let savedPath: string | undefined

  beforeEach(() => {
    tmpDir = makeTmpDir()
    savedPath = process.env.CK_SESSION_PATH
    sessionFile = join(tmpDir, 'session')
    process.env.CK_SESSION_PATH = sessionFile
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
    }
  })

  afterEach(() => {
    process.env.CK_SESSION_PATH = savedPath
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('accepts full cookie string and extracts CKAT', async () => {
    await handleSetSession({ cookies: 'other=x; CKAT=access-jwt%3Brefresh-jwt; foo=bar' }, ctx)
    expect(ctx.client.getToken()).toBe('access-jwt')
    expect(ctx.client.getRefreshToken()).toBe('refresh-jwt')
    expect(ctx.client.getCookies()).toBe('other=x; CKAT=access-jwt%3Brefresh-jwt; foo=bar')
  })

  it('accepts CKAT=<value> format', async () => {
    await handleSetSession({ cookies: 'CKAT=access-jwt%3Brefresh-jwt' }, ctx)
    expect(ctx.client.getToken()).toBe('access-jwt')
    expect(ctx.client.getRefreshToken()).toBe('refresh-jwt')
  })

  it('accepts raw CKAT value (no key prefix)', async () => {
    await handleSetSession({ cookies: 'access-jwt%3Brefresh-jwt' }, ctx)
    expect(ctx.client.getToken()).toBe('access-jwt')
    expect(ctx.client.getRefreshToken()).toBe('refresh-jwt')
  })

  it('accepts raw CKAT value with literal semicolon', async () => {
    await handleSetSession({ cookies: 'access-jwt;refresh-jwt' }, ctx)
    expect(ctx.client.getToken()).toBe('access-jwt')
    expect(ctx.client.getRefreshToken()).toBe('refresh-jwt')
  })

  it('persists the Cookie header to the saved-session file the server reads back (fleet-audit#71)', async () => {
    await handleSetSession({ cookies: 'CKAT=acc-tok%3Bref-tok' }, ctx)

    expect(readFileSync(sessionFile, 'utf8').trim()).toBe('CKAT=acc-tok%3Bref-tok')
    // …and resolveAuth reads it straight back, with no dotenv involved.
    expect(readSavedSession()).toBe('CKAT=acc-tok%3Bref-tok')
  })

  it('replaces a previously saved session', async () => {
    writeFileSync(sessionFile, 'CKAT=old-value\n')

    await handleSetSession({ cookies: 'CKAT=new%3Bnew' }, ctx)

    const contents = readFileSync(sessionFile, 'utf8')
    expect(contents).toContain('CKAT=new%3Bnew')
    expect(contents).not.toContain('old-value')
  })

  it('refuses to save when the refresh JWT is already expired', async () => {
    const cookies = `CKAT=${validJwt}%3B${expiredJwt}`
    const result = await handleSetSession({ cookies }, ctx)

    expect(result).toMatch(/expired/i)
    expect(result).toMatch(/fetchproxy|DevTools/)
    expect(ctx.client.getToken()).toBeNull()
    expect(ctx.client.getRefreshToken()).toBeNull()
    expect(existsSync(sessionFile)).toBe(false)
  })

  it('saves when access JWT is expired but refresh JWT is still valid', async () => {
    const cookies = `CKAT=${expiredJwt}%3B${validJwt}`
    const result = await handleSetSession({ cookies }, ctx)

    expect(result).toMatch(/saved/i)
    expect(ctx.client.getToken()).toBe(expiredJwt)
    expect(ctx.client.getRefreshToken()).toBe(validJwt)
  })

  it('returns a "could not extract" message when input has no token', async () => {
    const result = await handleSetSession({ cookies: '' }, ctx)
    expect(result).toMatch(/could not extract/i)
    expect(ctx.client.getToken()).toBeNull()
  })

  it('says the session is in memory only when it cannot be saved', async () => {
    // A parent that is a FILE cannot be created as a directory.
    writeFileSync(join(tmpDir, 'blocker'), 'x')
    process.env.CK_SESSION_PATH = join(tmpDir, 'blocker', 'session')
    const result = await handleSetSession({ cookies: 'CKAT=tok' }, ctx)
    expect(result).toMatch(/Warning:/)
    expect(result).toMatch(/could not be written/i)
    expect(result).toMatch(/memory only/i)
    expect(result).not.toMatch(/stored/)
  })
})

// fleet-audit#1158: the saved Cookie header (working CK access + refresh JWTs)
// stayed on disk with no tool to remove it.
describe('ck_forget_session', () => {
  let ctx: AppContext
  let tmpDir: string
  let sessionFile: string
  let savedPath: string | undefined
  let savedEnvCookies: string | undefined

  beforeEach(() => {
    tmpDir = makeTmpDir()
    savedPath = process.env.CK_SESSION_PATH
    savedEnvCookies = process.env.CK_COOKIES
    delete process.env.CK_COOKIES
    sessionFile = join(tmpDir, 'session')
    process.env.CK_SESSION_PATH = sessionFile
    ctx = { client: new CreditKarmaClient(), db: initDb(':memory:') }
  })

  afterEach(() => {
    process.env.CK_SESSION_PATH = savedPath
    if (savedEnvCookies === undefined) delete process.env.CK_COOKIES
    else process.env.CK_COOKIES = savedEnvCookies
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('deletes the saved-session file and clears the in-memory credentials', async () => {
    await handleSetSession({ cookies: 'CKAT=acc-tok%3Bref-tok' }, ctx)
    expect(existsSync(sessionFile)).toBe(true)

    const result = handleForgetSession(ctx)

    expect(existsSync(sessionFile)).toBe(false)
    expect(ctx.client.getToken()).toBeNull()
    expect(ctx.client.getRefreshToken()).toBeNull()
    expect(ctx.client.getCookies()).toBeNull()
    expect(result).toMatchObject({ forgotten: true, sessionFile, hadSavedSession: true, envCookiesSet: false })
    // Never echo the credential back.
    expect(JSON.stringify(result)).not.toContain('acc-tok')
    expect(JSON.stringify(result)).not.toContain('ref-tok')
  })

  it('says the transaction database is untouched and where it lives', () => {
    const result = handleForgetSession(ctx)
    expect(result.transactionsDb).toMatch(/transactions\.db|CK_DB_PATH/)
    expect(result.note).toMatch(/not contacted/i)
  })

  it('is idempotent when nothing is saved', () => {
    const result = handleForgetSession(ctx)
    expect(result).toMatchObject({ forgotten: true, hadSavedSession: false })
    expect(result.warning).toBeUndefined()
  })

  it('warns that CK_COOKIES still supplies a session when the host sets it', () => {
    process.env.CK_COOKIES = 'CKAT=env-acc%3Benv-ref'
    const result = handleForgetSession(ctx)
    expect(result.envCookiesSet).toBe(true)
    expect(result.nextStep).toMatch(/CK_COOKIES/)
    expect(JSON.stringify(result)).not.toContain('env-acc')
  })

  it('surfaces a warning when the file cannot be deleted', () => {
    mkdirSync(sessionFile)
    const result = handleForgetSession(ctx)
    expect(result.hadSavedSession).toBe(false)
    expect(result.warning).toMatch(/could not be deleted/)
  })

  it('is registered as a local, destructive, idempotent tool whose handler returns JSON text', async () => {
    const { server, calls } = fakeServer()
    registerAuthTools(server, ctx)
    const tool = calls.find((c) => c.name === 'ck_forget_session')!
    expect(tool.opts.description).toMatch(/session/)
    expect(tool.opts.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false })
    const out = await tool.handler({})
    expect(out.content[0].type).toBe('text')
    expect(JSON.parse(out.content[0].text)).toMatchObject({ forgotten: true })
  })
})

describe('registerAuthTools', () => {
  it('registers ck_set_session with a string `cookies` field', () => {
    const ctx: AppContext = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
    }
    const { server, calls } = fakeServer()
    registerAuthTools(server, ctx)

    expect(calls.map((c) => c.name)).toEqual(['ck_set_session', 'ck_forget_session'])
    expect(calls[0].name).toBe('ck_set_session')
    expect(calls[0].opts.description).toMatch(/Credit Karma/)
    expect(calls[0].opts.inputSchema.shape).toHaveProperty('cookies')
  })

  it('wraps handler result as MCP text content', async () => {
    const tmpDir = makeTmpDir()
    const ctx: AppContext = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
    }
    const { server, calls } = fakeServer()
    registerAuthTools(server, ctx)

    const result = await calls[0].handler({ cookies: 'CKAT=tok' })
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toMatch(/saved/i)
  })
})

describe('client — cookie and refresh token storage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stores cookies from constructor', () => {
    const c = new CreditKarmaClient('tok', 'ref', 'CKTRKID=abc; ius_session=xyz')
    expect(c.getCookies()).toBe('CKTRKID=abc; ius_session=xyz')
  })

  it('setCookies updates stored value', () => {
    const c = new CreditKarmaClient()
    c.setCookies('new-cookies')
    expect(c.getCookies()).toBe('new-cookies')
  })

  it('refreshAccessToken throws NO_REFRESH_TOKEN when none set', async () => {
    const c = new CreditKarmaClient()
    await expect(c.refreshAccessToken()).rejects.toThrow('NO_REFRESH_TOKEN')
  })

  it('refreshAccessToken calls CK refresh endpoint with correct body', async () => {
    const c = new CreditKarmaClient('old-token', 'my-refresh', 'CKTRKID=abc123')
    const spy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: 'new-token', refreshToken: 'new-refresh' }), { status: 200 })
    )

    const token = await c.refreshAccessToken()
    expect(token).toBe('new-token')
    expect(c.getToken()).toBe('new-token')
    expect(c.getRefreshToken()).toBe('new-refresh')

    const [url, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://www.creditkarma.com/member/oauth2/refresh')
    expect(JSON.parse(opts.body as string)).toEqual({ refreshToken: 'my-refresh' })
    const headers = opts.headers as Record<string, string>
    expect(headers['ck-cookie-id']).toBe('abc123')
    expect(headers['Cookie']).toBe('CKTRKID=abc123')
  })

  it('refreshAccessToken throws on HTTP error', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(c.refreshAccessToken()).rejects.toThrow('Token refresh failed')
  })

  it('refreshAccessToken throws when response has no accessToken', async () => {
    const c = new CreditKarmaClient('tok', 'ref')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_token' }), { status: 200 })
    )
    await expect(c.refreshAccessToken()).rejects.toThrow('Token refresh error')
  })
})
