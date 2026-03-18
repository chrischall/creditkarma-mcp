import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSetToken, handleSetSession, persistSession } from '../../src/tools/auth.js'
import { CreditKarmaClient } from '../../src/client.js'
import { initDb } from '../../src/db.js'
import type { AppContext } from '../../src/index.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ck-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('ck_set_token', () => {
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

  it('sets the token on the client', async () => {
    await handleSetToken({ token: 'mytoken' }, ctx)
    expect(ctx.client.getToken()).toBe('mytoken')
  })

  it('returns success message', async () => {
    const result = await handleSetToken({ token: 'mytoken' }, ctx)
    expect(result).toContain('Token set successfully')
  })

  it('returns Warning if .mcp.json does not exist but still sets token', async () => {
    const result = await handleSetToken({ token: 'tok' }, ctx)
    expect(ctx.client.getToken()).toBe('tok')
    expect(result).toContain('Warning')
  })

  it('returns Warning if .mcp.json lacks expected key path but still sets token', async () => {
    writeFileSync(ctx.mcpJsonPath, JSON.stringify({ other: true }))
    const result = await handleSetToken({ token: 'tok' }, ctx)
    expect(ctx.client.getToken()).toBe('tok')
    expect(result).toContain('Warning')
  })
})

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

  it('persists CK_COOKIES to .mcp.json', async () => {
    const mcpJson = {
      mcpServers: { creditkarma: { command: 'node', args: ['dist/index.js'], env: { CK_COOKIES: '' } } }
    }
    writeFileSync(ctx.mcpJsonPath, JSON.stringify(mcpJson, null, 2))

    await handleSetSession({ cookies: 'CKAT=acc-tok%3Bref-tok' }, ctx)

    const updated = JSON.parse(readFileSync(ctx.mcpJsonPath, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_COOKIES).toBe('CKAT=acc-tok%3Bref-tok')
  })

  it('returns Warning when .mcp.json is missing', async () => {
    const result = await handleSetSession({ cookies: 'CKAT=a%3Br' }, ctx)
    expect(result).toContain('Warning')
  })
})

describe('persistSession', () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = makeTmpDir() })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it('returns Warning when .mcp.json contains invalid JSON', () => {
    const path = join(tmpDir, '.mcp.json')
    writeFileSync(path, '{ not valid json }}}')
    const result = persistSession('cookies=val', path)
    expect(result).toContain('could not be parsed')
  })

  it('persists CK_COOKIES when provided', () => {
    const path = join(tmpDir, '.mcp.json')
    const mcpJson = { mcpServers: { creditkarma: { env: { CK_COOKIES: '' } } } }
    writeFileSync(path, JSON.stringify(mcpJson))
    persistSession('CKAT=tok', path)
    const updated = JSON.parse(readFileSync(path, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_COOKIES).toBe('CKAT=tok')
  })

  it('does not write CK_COOKIES when null', () => {
    const path = join(tmpDir, '.mcp.json')
    const mcpJson = { mcpServers: { creditkarma: { env: { CK_COOKIES: 'old' } } } }
    writeFileSync(path, JSON.stringify(mcpJson))
    persistSession(null, path)
    const updated = JSON.parse(readFileSync(path, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_COOKIES).toBe('old')
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
