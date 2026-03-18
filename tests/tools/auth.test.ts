import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleSetToken, handleLogin, handleSubmitMfa } from '../../src/tools/auth.js'
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

  it('persists token to .mcp.json when file exists', async () => {
    const mcpJson = {
      mcpServers: { creditkarma: { command: 'node', args: ['dist/index.js'], env: { CK_TOKEN: '' } } }
    }
    writeFileSync(ctx.mcpJsonPath, JSON.stringify(mcpJson, null, 2))

    await handleSetToken({ token: 'saved-token' }, ctx)

    const updated = JSON.parse(readFileSync(ctx.mcpJsonPath, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_TOKEN).toBe('saved-token')
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

describe('ck_login', () => {
  let ctx: AppContext

  beforeEach(() => {
    ctx = {
      client: new CreditKarmaClient(),
      db: initDb(':memory:'),
      mcpJsonPath: '/nonexistent/.mcp.json'
    }
  })

  it('throws if no username provided', async () => {
    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
    await expect(handleLogin({}, ctx)).rejects.toThrow('Username and password required')
  })

  it('throws if no password provided', async () => {
    delete process.env.CK_PASSWORD
    await expect(handleLogin({ username: 'user' }, ctx)).rejects.toThrow('Username and password required')
  })

  it('uses env vars when args not provided', async () => {
    process.env.CK_USERNAME = 'envuser'
    process.env.CK_PASSWORD = 'envpass'
    vi.spyOn(ctx.client, 'login').mockResolvedValueOnce(undefined)
    const result = await handleLogin({}, ctx)
    expect(ctx.client.login).toHaveBeenCalledWith('envuser', 'envpass')
    expect(result).toContain('MFA challenge')
    delete process.env.CK_USERNAME
    delete process.env.CK_PASSWORD
  })

  it('calls client.login with provided args', async () => {
    vi.spyOn(ctx.client, 'login').mockResolvedValueOnce(undefined)
    await handleLogin({ username: 'u', password: 'p' }, ctx)
    expect(ctx.client.login).toHaveBeenCalledWith('u', 'p')
  })
})

describe('persistToken — invalid JSON', () => {
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

  it('returns Warning when .mcp.json contains invalid JSON', async () => {
    writeFileSync(ctx.mcpJsonPath, '{ not valid json }}}')
    const result = await handleSetToken({ token: 'tok' }, ctx)
    expect(ctx.client.getToken()).toBe('tok')
    expect(result).toContain('Warning')
    expect(result).toContain('could not be parsed')
  })
})

describe('ck_submit_mfa', () => {
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

  it('sets token from submitMfa result', async () => {
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('new-bearer-token')
    await handleSubmitMfa({ code: '123456' }, ctx)
    expect(ctx.client.getToken()).toBe('new-bearer-token')
  })

  it('returns success message', async () => {
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('tok')
    const result = await handleSubmitMfa({ code: '000000' }, ctx)
    expect(result).toContain('Authenticated successfully')
  })

  it('persists token to .mcp.json after MFA success', async () => {
    const mcpJson = {
      mcpServers: { creditkarma: { command: 'node', args: ['dist/index.js'], env: { CK_TOKEN: '' } } }
    }
    writeFileSync(ctx.mcpJsonPath, JSON.stringify(mcpJson, null, 2))
    vi.spyOn(ctx.client, 'submitMfa').mockResolvedValueOnce('mfa-token')
    await handleSubmitMfa({ code: '999999' }, ctx)
    const updated = JSON.parse(readFileSync(ctx.mcpJsonPath, 'utf8'))
    expect(updated.mcpServers.creditkarma.env.CK_TOKEN).toBe('mfa-token')
  })
})
