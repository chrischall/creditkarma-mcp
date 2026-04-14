import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeEnvVar } from '../scripts/setup-auth.mjs'

describe('writeEnvVar', () => {
  let tmpDir: string
  let envPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-env-'))
    envPath = path.join(tmpDir, '.env')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates the file when it does not exist', () => {
    writeEnvVar(envPath, 'CK_COOKIES', 'bar')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('CK_COOKIES=bar\n')
  })

  it('appends the key when it is not already present', () => {
    fs.writeFileSync(envPath, 'CK_DB_PATH=val\n')
    writeEnvVar(envPath, 'CK_COOKIES', 'bar')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('CK_DB_PATH=val\nCK_COOKIES=bar\n')
  })

  it('ensures a trailing newline before appending', () => {
    fs.writeFileSync(envPath, 'CK_DB_PATH=val') // no trailing newline
    writeEnvVar(envPath, 'CK_COOKIES', 'bar')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('CK_DB_PATH=val\nCK_COOKIES=bar\n')
  })

  it('replaces an existing value in place', () => {
    fs.writeFileSync(envPath, 'CK_COOKIES=old\nCK_DB_PATH=val\n')
    writeEnvVar(envPath, 'CK_COOKIES', 'new')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('CK_COOKIES=new\nCK_DB_PATH=val\n')
  })

  it('only replaces the exact key, not substrings', () => {
    fs.writeFileSync(envPath, 'CK_COOKIES_BACKUP=original\nCK_COOKIES=old\n')
    writeEnvVar(envPath, 'CK_COOKIES', 'new')
    expect(fs.readFileSync(envPath, 'utf8')).toBe('CK_COOKIES_BACKUP=original\nCK_COOKIES=new\n')
  })

  it('writes with 0600 permissions (owner read/write only)', () => {
    writeEnvVar(envPath, 'CK_COOKIES', 'bar')
    const mode = fs.statSync(envPath).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
