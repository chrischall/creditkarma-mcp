import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { sessionPath, readSavedSession, saveSession } from '../src/session.js'

describe('saved session file (fleet-audit#71)', () => {
  let dir: string
  let saved: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-session-'))
    saved = process.env.CK_SESSION_PATH
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.CK_SESSION_PATH
    else process.env.CK_SESSION_PATH = saved
  })

  it('defaults to a stable per-user path beside the default database', () => {
    delete process.env.CK_SESSION_PATH
    expect(sessionPath()).toBe(join(homedir(), '.creditkarma-mcp', 'session'))
  })

  it('honours CK_SESSION_PATH', () => {
    process.env.CK_SESSION_PATH = join(dir, 'custom')
    expect(sessionPath()).toBe(join(dir, 'custom'))
  })

  it('round-trips a Cookie header, creating the directory, at mode 0600', () => {
    const path = join(dir, 'nested', 'session')
    expect(saveSession('CKAT=a%3Bb', path)).toBeNull()
    expect(readSavedSession(path)).toBe('CKAT=a%3Bb')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('locks down a pre-existing, looser file', () => {
    const path = join(dir, 'session')
    writeFileSync(path, 'old', { mode: 0o644 })
    chmodSync(path, 0o644)
    saveSession('CKAT=new', path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('CKAT=new\n')
  })

  it('reads the default path when none is given', () => {
    process.env.CK_SESSION_PATH = join(dir, 'session')
    saveSession('CKAT=via-env-path')
    expect(readSavedSession()).toBe('CKAT=via-env-path')
  })

  it('treats a missing or empty file as no session', () => {
    expect(readSavedSession(join(dir, 'absent'))).toBeNull()
    writeFileSync(join(dir, 'empty'), '  \n')
    expect(readSavedSession(join(dir, 'empty'))).toBeNull()
  })

  it('warns — and says the session will not survive a restart — when it cannot write', () => {
    // A path whose parent is a FILE cannot be created.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    expect(saveSession('CKAT=x', join(blocker, 'session'))).toMatch(/could not be written.*restart/)
  })
})
