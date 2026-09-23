import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CreditKarmaClient } from '../src/client.js'
import { persistRotatedSessions, resolveAuth } from '../src/auth.js'
import { readSavedSession } from '../src/session.js'
import { makeJwt } from './helpers.js'

// fleet-audit#69: every /member/oauth2/refresh ROTATES CK's refresh token. The
// client used to keep the rotated pair only in memory, so (a) the Cookie header
// it kept sending still carried the rotated-out CKAT, and (b) a restart loaded
// the dead token from CK_COOKIES and failed with session_rejected.

const jwt = (secondsFromNow: number, tag: string) =>
  makeJwt({ tag, exp: Math.floor(Date.now() / 1000) + secondsFromNow })

const refreshOk = (accessToken: string, refreshToken?: string) =>
  vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ accessToken, ...(refreshToken ? { refreshToken } : {}) }), { status: 200 }),
  )

describe('rotated tokens are written back', () => {
  let dir: string
  let savedPath: string | undefined
  let savedCookies: string | undefined
  let savedDisable: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-rotate-'))
    savedPath = process.env.CK_SESSION_PATH
    savedCookies = process.env.CK_COOKIES
    savedDisable = process.env.CK_DISABLE_FETCHPROXY
    process.env.CK_SESSION_PATH = join(dir, 'session')
    process.env.CK_DISABLE_FETCHPROXY = '1'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    process.env.CK_SESSION_PATH = savedPath
    if (savedCookies === undefined) delete process.env.CK_COOKIES
    else process.env.CK_COOKIES = savedCookies
    if (savedDisable === undefined) delete process.env.CK_DISABLE_FETCHPROXY
    else process.env.CK_DISABLE_FETCHPROXY = savedDisable
  })

  it('rebuilds CKAT inside the client cookies, keeping the other cookies', async () => {
    const client = new CreditKarmaClient('old-acc', 'old-ref', 'CKTRKID=trk; CKAT=old-acc%3Bold-ref; x=1')
    refreshOk('new-acc', 'new-ref')

    await client.refreshAccessToken()

    expect(client.getCookies()).toBe('CKTRKID=trk; CKAT=new-acc%3Bnew-ref; x=1')
  })

  it('keeps the current refresh token in CKAT when CK does not return a new one', async () => {
    const client = new CreditKarmaClient('old-acc', 'same-ref', 'CKAT=old-acc%3Bsame-ref')
    refreshOk('new-acc')

    await client.refreshAccessToken()

    expect(client.getCookies()).toBe('CKAT=new-acc%3Bsame-ref')
  })

  it('synthesises a CKAT cookie when the client held a bare value or no cookies', async () => {
    const bare = new CreditKarmaClient('a', 'r', 'a%3Br')
    refreshOk('a2', 'r2')
    await bare.refreshAccessToken()
    expect(bare.getCookies()).toBe('CKAT=a2%3Br2')

    const none = new CreditKarmaClient('a', 'r')
    refreshOk('a3', 'r3')
    await none.refreshAccessToken()
    expect(none.getCookies()).toBe('CKAT=a3%3Br3')
  })

  it('persists the rotated session so a restart does not reload the rotated-out token', async () => {
    const oldRef = jwt(3600, 'old')
    const newRef = jwt(8 * 3600, 'new')
    // The host config still carries the ORIGINAL cookies — as it always will.
    process.env.CK_COOKIES = `CKTRKID=trk; CKAT=old-acc%3B${oldRef}`
    const client = new CreditKarmaClient('old-acc', oldRef, process.env.CK_COOKIES)
    persistRotatedSessions(client)
    refreshOk('new-acc', newRef)

    await client.refreshAccessToken()

    expect(readSavedSession()).toBe(`CKTRKID=trk; CKAT=new-acc%3B${newRef}`)
    // "Restart": resolution picks the rotated pair, not the stale env seed.
    const next = await resolveAuth()
    expect(next.source).toBe('session')
    expect(next.cookies).toContain(newRef)
  })

  it('logs to stderr — never stdout — when the rotated session cannot be saved', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    process.env.CK_SESSION_PATH = join(blocker, 'session')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = new CreditKarmaClient('a', 'r', 'CKAT=a%3Br')
    persistRotatedSessions(client)
    refreshOk('a2', 'r2')

    await client.refreshAccessToken()

    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/rotated session.*could not be written/))
  })

  it('does not notify on a failed refresh', async () => {
    const client = new CreditKarmaClient('a', 'r', 'CKAT=a%3Br')
    const listener = vi.fn()
    client.onSessionRotated(listener)
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }))

    await expect(client.refreshAccessToken()).rejects.toThrow()

    expect(listener).not.toHaveBeenCalled()
    expect(client.getCookies()).toBe('CKAT=a%3Br')
  })
})
