import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// resolveAuth() drives three paths:
//   1. CK_COOKIES env var (existing — full Cookie header)
//   2. cached cookies from a prior ck_set_session call (existing — also Cookie header)
//   3. fetchproxy fallback (new — read CKAT + CKTRKID cookies via @fetchproxy/bootstrap)
//   4. error: tell the user to set CK_COOKIES, call ck_set_session, or sign in via the extension
//
// These tests verify path selection, error shapes, and that the synthesized
// cookie header from the fetchproxy path is consumable by the rest of the
// stack the same way CK_COOKIES is.

// Mock @fetchproxy/bootstrap at the module boundary — never hit a real WS.
const bootstrapMock = vi.fn()
vi.mock('@fetchproxy/bootstrap', () => ({
  bootstrap: (...args: unknown[]) => bootstrapMock(...args),
}))

import { resolveAuth, splitCkatCookie, loadAuthIntoClient } from '../src/auth.js'
import { CreditKarmaClient } from '../src/client.js'

describe('resolveAuth', () => {
  let originalCookies: string | undefined
  let originalDisable: string | undefined

  beforeEach(() => {
    originalCookies = process.env.CK_COOKIES
    originalDisable = process.env.CK_DISABLE_FETCHPROXY
    delete process.env.CK_COOKIES
    delete process.env.CK_DISABLE_FETCHPROXY
    bootstrapMock.mockReset()
  })

  afterEach(() => {
    if (originalCookies === undefined) delete process.env.CK_COOKIES
    else process.env.CK_COOKIES = originalCookies
    if (originalDisable === undefined) delete process.env.CK_DISABLE_FETCHPROXY
    else process.env.CK_DISABLE_FETCHPROXY = originalDisable
  })

  describe('path 1: CK_COOKIES env var', () => {
    it('returns CK_COOKIES verbatim when set', async () => {
      process.env.CK_COOKIES = 'CKTRKID=trk; CKAT=acc%3Bref; foo=bar'

      const result = await resolveAuth()

      expect(bootstrapMock).not.toHaveBeenCalled()
      expect(result.cookies).toBe('CKTRKID=trk; CKAT=acc%3Bref; foo=bar')
      expect(result.source).toBe('env')
    })

    it('takes env-var precedence even when fetchproxy would succeed', async () => {
      process.env.CK_COOKIES = 'CKAT=env-token'
      bootstrapMock.mockResolvedValue({
        cookies: { CKAT: 'fp-token', CKTRKID: 'fp-trk' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      })

      const result = await resolveAuth()

      expect(bootstrapMock).not.toHaveBeenCalled()
      expect(result.source).toBe('env')
    })

    it('trims surrounding whitespace from the env value', async () => {
      process.env.CK_COOKIES = '  CKAT=trimmed  '

      const result = await resolveAuth()

      expect(result.cookies).toBe('CKAT=trimmed')
    })
  })

  describe('path 2: fetchproxy fallback', () => {
    it('reads CKAT + CKTRKID cookies via bootstrap() and builds a Cookie header', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { CKAT: 'acc-jwt%3Bref-jwt', CKTRKID: 'trk-id' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      })

      const result = await resolveAuth()

      expect(bootstrapMock).toHaveBeenCalledTimes(1)
      const opts = bootstrapMock.mock.calls[0][0] as {
        serverName: string
        version: string
        domains: string[]
        declare: {
          cookies: string[]
          localStorage: string[]
          sessionStorage: string[]
          captureHeaders: unknown[]
        }
      }
      expect(opts.serverName).toBe('creditkarma-mcp')
      expect(typeof opts.version).toBe('string')
      expect(opts.domains).toEqual(['creditkarma.com'])
      expect(opts.declare.cookies).toEqual(['CKAT', 'CKTRKID'])
      expect(opts.declare.localStorage).toEqual([])
      expect(opts.declare.sessionStorage).toEqual([])
      expect(opts.declare.captureHeaders).toEqual([])

      expect(result.source).toBe('fetchproxy')
      // The cookie header must include both CKAT and CKTRKID so the refresh
      // endpoint accepts the request (CKTRKID is the ck-cookie-id source).
      expect(result.cookies).toContain('CKAT=acc-jwt%3Bref-jwt')
      expect(result.cookies).toContain('CKTRKID=trk-id')
    })

    it('throws with a helpful message when CKAT cookie is missing', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { CKTRKID: 'trk-only' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      })

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed/)
      await expect(resolveAuth()).rejects.toThrow(/CKAT/)
    })

    it('throws with a helpful message when CKTRKID cookie is missing', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { CKAT: 'acc-only' },
        localStorage: {},
        sessionStorage: {},
        capturedHeaders: {},
      })

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy fallback failed/)
      await expect(resolveAuth()).rejects.toThrow(/CKTRKID/)
    })

    it('wraps bootstrap() errors with actionable context', async () => {
      bootstrapMock.mockRejectedValue(new Error('extension offline'))

      await expect(resolveAuth()).rejects.toThrow(
        /fetchproxy fallback failed: extension offline/
      )
    })

    it('handles non-Error rejections from bootstrap()', async () => {
      bootstrapMock.mockRejectedValue('plain string failure')

      await expect(resolveAuth()).rejects.toThrow(
        /fetchproxy fallback failed: plain string failure/
      )
    })

    it('surfaces FetchproxyBridgeDownError.hint verbatim when the SW retry exhausts', async () => {
      // 0.8.0+: bootstrap propagates FetchproxyBridgeDownError when the
      // server's lazy-revive retry also fails. We surface the typed
      // `.hint` so users see the actionable "click the extension toolbar
      // icon" message in path 3, matching the self-service guidance in
      // path 4.
      const { FetchproxyBridgeDownError } = await import('@fetchproxy/server')
      const downErr = new FetchproxyBridgeDownError({
        originalError: 'content_script_unreachable',
        retryAttempted: true,
        op: 'fetch',
      })
      bootstrapMock.mockRejectedValue(downErr)

      await expect(resolveAuth()).rejects.toThrow(/fetchproxy bridge is down/)
      await expect(resolveAuth()).rejects.toThrow(downErr.hint)
    })
  })

  describe('env-var sanitization', () => {
    // Matches the readVar() helper hardening in src/index.ts: defenses against
    // MCP hosts that pass through unexpanded `${VAR}` or serialize
    // undefined/null as a string.
    it.each(['undefined', 'null', '${CK_COOKIES}', '   ', ''])(
      'treats CK_COOKIES=%j as unset and falls through to fetchproxy',
      async (val) => {
        process.env.CK_COOKIES = val
        bootstrapMock.mockResolvedValue({
          cookies: { CKAT: 'fp', CKTRKID: 'trk' },
          localStorage: {},
          sessionStorage: {},
          capturedHeaders: {},
        })

        const result = await resolveAuth()

        expect(result.source).toBe('fetchproxy')
      },
    )
  })

  describe('path 3: nothing configured', () => {
    it('skips fetchproxy when CK_DISABLE_FETCHPROXY=1 is set', async () => {
      process.env.CK_DISABLE_FETCHPROXY = '1'

      await expect(resolveAuth()).rejects.toThrow(/CK_COOKIES/)
      expect(bootstrapMock).not.toHaveBeenCalled()
    })

    it.each(['1', 'true', 'yes', 'on', 'TRUE'])(
      'treats CK_DISABLE_FETCHPROXY=%j as disabled',
      async (val) => {
        process.env.CK_DISABLE_FETCHPROXY = val
        await expect(resolveAuth()).rejects.toThrow(/CK_COOKIES/)
        expect(bootstrapMock).not.toHaveBeenCalled()
      },
    )

    it.each(['0', 'false', 'no', '', 'off'])(
      'treats CK_DISABLE_FETCHPROXY=%j as enabled (default)',
      async (val) => {
        process.env.CK_DISABLE_FETCHPROXY = val
        bootstrapMock.mockResolvedValue({
          cookies: { CKAT: 'fp', CKTRKID: 'trk' },
          localStorage: {},
          sessionStorage: {},
          capturedHeaders: {},
        })
        await resolveAuth()
        expect(bootstrapMock).toHaveBeenCalled()
      },
    )

    it('error message mentions all three onboarding options', async () => {
      process.env.CK_DISABLE_FETCHPROXY = '1'

      // Mentions env var path
      await expect(resolveAuth()).rejects.toThrow(/CK_COOKIES/)
      // Mentions ck_set_session path
      await expect(resolveAuth()).rejects.toThrow(/ck_set_session/)
      // Mentions fetchproxy extension path
      await expect(resolveAuth()).rejects.toThrow(/fetchproxy/)
    })
  })
})

describe('splitCkatCookie', () => {
  it('extracts access + refresh JWTs from a full Cookie header', () => {
    expect(splitCkatCookie('OTHER=x; CKAT=acc%3Bref; foo=bar')).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
    })
  })

  it('accepts a bare CKAT=<value> input', () => {
    expect(splitCkatCookie('CKAT=acc%3Bref')).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
    })
  })

  it('accepts a raw CKAT value with a literal semicolon', () => {
    expect(splitCkatCookie('acc;ref')).toEqual({
      accessToken: 'acc',
      refreshToken: 'ref',
    })
  })

  it('returns nulls for an empty input', () => {
    expect(splitCkatCookie('')).toEqual({
      accessToken: null,
      refreshToken: null,
    })
  })

  it('returns null refresh token when only one part is present', () => {
    expect(splitCkatCookie('CKAT=acc-only')).toEqual({
      accessToken: 'acc-only',
      refreshToken: null,
    })
  })
})

describe('loadAuthIntoClient', () => {
  let originalCookies: string | undefined
  let originalDisable: string | undefined

  beforeEach(() => {
    originalCookies = process.env.CK_COOKIES
    originalDisable = process.env.CK_DISABLE_FETCHPROXY
    delete process.env.CK_COOKIES
    delete process.env.CK_DISABLE_FETCHPROXY
    bootstrapMock.mockReset()
  })

  afterEach(() => {
    if (originalCookies === undefined) delete process.env.CK_COOKIES
    else process.env.CK_COOKIES = originalCookies
    if (originalDisable === undefined) delete process.env.CK_DISABLE_FETCHPROXY
    else process.env.CK_DISABLE_FETCHPROXY = originalDisable
  })

  it('applies cookies from CK_COOKIES env var to the client', async () => {
    process.env.CK_COOKIES = 'CKTRKID=trk; CKAT=acc%3Bref'
    const client = new CreditKarmaClient()

    await loadAuthIntoClient(client)

    expect(client.getToken()).toBe('acc')
    expect(client.getRefreshToken()).toBe('ref')
    expect(client.getCookies()).toBe('CKTRKID=trk; CKAT=acc%3Bref')
  })

  it('applies cookies from fetchproxy fallback to the client', async () => {
    bootstrapMock.mockResolvedValue({
      cookies: { CKAT: 'fp-acc%3Bfp-ref', CKTRKID: 'fp-trk' },
      localStorage: {},
      sessionStorage: {},
      capturedHeaders: {},
    })
    const client = new CreditKarmaClient()

    await loadAuthIntoClient(client)

    expect(client.getToken()).toBe('fp-acc')
    expect(client.getRefreshToken()).toBe('fp-ref')
    expect(client.getCookies()).toContain('CKAT=fp-acc%3Bfp-ref')
    expect(client.getCookies()).toContain('CKTRKID=fp-trk')
  })

  it('skips setRefreshToken when the resolved cookies have no refresh JWT', async () => {
    process.env.CK_COOKIES = 'CKAT=access-only'
    const client = new CreditKarmaClient()

    await loadAuthIntoClient(client)

    expect(client.getToken()).toBe('access-only')
    expect(client.getRefreshToken()).toBeNull()
  })

  it('throws when resolved cookies contain no CKAT token', async () => {
    // resolveAuth() succeeds (env path) but the supplied value lacks
    // anything that parses to an access token — protect against this in
    // case a downstream caller hands us garbage.
    process.env.CK_COOKIES = '   ;   '
    const client = new CreditKarmaClient()

    await expect(loadAuthIntoClient(client)).rejects.toThrow(/did not contain a CKAT token/)
  })

  it('propagates fetchproxy bootstrap failures', async () => {
    bootstrapMock.mockRejectedValue(new Error('extension offline'))
    const client = new CreditKarmaClient()

    await expect(loadAuthIntoClient(client)).rejects.toThrow(/extension offline/)
  })
})
