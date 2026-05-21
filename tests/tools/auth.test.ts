import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSetSession, persistSession, registerAuthTools } from '../../src/tools/auth.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'
import { fakeServer } from '../helpers.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ck-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

import { makeJwt } from '../helpers.js'
const expiredJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 })
const validJwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })

describe('ck_set_session', () => {
  let ctx: AppContext
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: join(tmpDir, '.mcp.json')
    }
  })

  afterEach(() => {
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

  it('persists CK_COOKIES to .env', async () => {
    await handleSetSession({ cookies: 'CKAT=acc-tok%3Bref-tok' }, ctx)

    const envPath = join(tmpDir, '.env')
    const contents = readFileSync(envPath, 'utf8')
    expect(contents).toContain('CK_COOKIES=CKAT=acc-tok%3Bref-tok')
  })

  it('updates existing CK_COOKIES line in .env', async () => {
    const envPath = join(tmpDir, '.env')
    writeFileSync(envPath, 'CK_COOKIES=old-value\nOTHER=x\n')

    await handleSetSession({ cookies: 'CKAT=new%3Bnew' }, ctx)

    const contents = readFileSync(envPath, 'utf8')
    expect(contents).toContain('CK_COOKIES=CKAT=new%3Bnew')
    expect(contents).toContain('OTHER=x')
    expect(contents).not.toContain('old-value')
  })

  it('refuses to save when the refresh JWT is already expired', async () => {
    const cookies = `CKAT=${validJwt}%3B${expiredJwt}`
    const result = await handleSetSession({ cookies }, ctx)

    expect(result).toMatch(/expired/i)
    expect(result).toMatch(/fetchproxy|DevTools/)
    expect(ctx.client.getToken()).toBeNull()
    expect(ctx.client.getRefreshToken()).toBeNull()
    expect(existsSync(join(tmpDir, '.env'))).toBe(false)
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

  it('reports the persistSession warning when .env cannot be written', async () => {
    // Point mcpJsonPath at a parent that doesn't exist so writeFileSync throws.
    ctx.mcpJsonPath = '/nonexistent-dir-for-warning-test/.mcp.json'
    const result = await handleSetSession({ cookies: 'CKAT=tok' }, ctx)
    expect(result).toMatch(/Warning:/)
    expect(result).toMatch(/could not be written/i)
  })
})

describe('persistSession', () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = makeTmpDir() })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it('creates .env with CK_COOKIES when file does not exist', () => {
    const mcpJsonPath = join(tmpDir, '.mcp.json')
    persistSession('CKAT=tok', mcpJsonPath)
    const contents = readFileSync(join(tmpDir, '.env'), 'utf8')
    expect(contents).toContain('CK_COOKIES=CKAT=tok')
  })

  it('replaces existing CK_COOKIES line in .env', () => {
    const mcpJsonPath = join(tmpDir, '.mcp.json')
    writeFileSync(join(tmpDir, '.env'), 'CK_COOKIES=old\nOTHER=x\n')
    persistSession('CKAT=new', mcpJsonPath)
    const contents = readFileSync(join(tmpDir, '.env'), 'utf8')
    expect(contents).toContain('CK_COOKIES=CKAT=new')
    expect(contents).toContain('OTHER=x')
    expect(contents).not.toContain('old')
  })

  it('returns null (no warning) on success', () => {
    const mcpJsonPath = join(tmpDir, '.mcp.json')
    expect(persistSession('CKAT=tok', mcpJsonPath)).toBeNull()
  })

  it('returns null without writing when cookies is null', () => {
    const mcpJsonPath = join(tmpDir, '.mcp.json')
    const result = persistSession(null, mcpJsonPath)
    expect(result).toBeNull()
    expect(existsSync(join(tmpDir, '.env'))).toBe(false)
  })

  it('writes .env at mode 0600 (owner read/write only)', () => {
    const mcpJsonPath = join(tmpDir, '.mcp.json')
    persistSession('CKAT=tok', mcpJsonPath)
    const mode = require('fs').statSync(join(tmpDir, '.env')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('inserts a separating newline when appending to a file with no trailing newline', () => {
    const envPath = join(tmpDir, '.env')
    writeFileSync(envPath, 'CK_DB_PATH=val') // no trailing newline
    persistSession('CKAT=tok', join(tmpDir, '.mcp.json'))
    expect(readFileSync(envPath, 'utf8')).toBe('CK_DB_PATH=val\nCK_COOKIES=CKAT=tok\n')
  })

  it('returns a warning when an existing .env is unreadable', () => {
    const envPath = join(tmpDir, '.env')
    writeFileSync(envPath, 'CK_DB_PATH=val\n', { mode: 0o000 })
    try {
      const result = persistSession('CKAT=tok', join(tmpDir, '.mcp.json'))
      expect(result).toMatch(/could not be read/i)
    } finally {
      // restore perms so afterEach rmSync can clean up
      require('fs').chmodSync(envPath, 0o600)
    }
  })

  it('returns a warning when .env cannot be written', () => {
    // mcpJsonPath inside a nonexistent dir => write to a nonexistent dir
    const result = persistSession('CKAT=tok', '/nonexistent-dir-for-test/.mcp.json')
    expect(result).toMatch(/could not be written/i)
  })
})

describe('registerAuthTools', () => {
  it('registers ck_set_session with a string `cookies` field', () => {
    const ctx: AppContext = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: join(makeTmpDir(), '.mcp.json')
    }
    const { server, calls } = fakeServer()
    registerAuthTools(server, ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('ck_set_session')
    expect(calls[0].opts.description).toMatch(/Credit Karma/)
    expect(calls[0].opts.inputSchema).toHaveProperty('cookies')
  })

  it('wraps handler result as MCP text content', async () => {
    const tmpDir = makeTmpDir()
    const ctx: AppContext = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: join(tmpDir, '.mcp.json')
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
