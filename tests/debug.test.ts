import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { debugEnabled, debugLog, jwtTimes, debugBody, headerNames, responseHeaders } from '../src/debug.js'
import { CreditKarmaClient } from '../src/client.js'
import { makeJwt } from './helpers.js'

const nowS = () => Math.floor(Date.now() / 1000)

let stderr: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.CK_DEBUG
})

const logged = () => stderr.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')

describe('CK_DEBUG gate', () => {
  it('is off by default and logs nothing', () => {
    expect(debugEnabled()).toBe(false)
    debugLog('x', { a: 1 })
    expect(stderr).not.toHaveBeenCalled()
  })

  it('logs one tagged JSON line to stderr when CK_DEBUG=1', () => {
    process.env.CK_DEBUG = '1'
    debugLog('auth.resolved', { source: 'fetchproxy' })
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(logged()).toBe('[creditkarma-mcp:debug] auth.resolved {"source":"fetchproxy"}')
  })
})

describe('jwtTimes', () => {
  it('reports iat/exp and relative seconds — never the token', () => {
    const t = makeJwt({ iat: nowS() - 120, exp: nowS() + 780 })
    const r = jwtTimes(t)
    expect(r.present).toBe(true)
    expect(r.issued_ago_s).toBeGreaterThanOrEqual(119)
    expect(r.expires_in_s).toBeGreaterThan(770)
    expect(r.iat).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(r.exp).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(JSON.stringify(r)).not.toContain(t.split('.')[1])
  })

  it('handles absent and undecodable tokens', () => {
    expect(jwtTimes(null)).toEqual({ present: false })
    expect(jwtTimes('opaque')).toEqual({ present: true, iat: null, exp: null })
  })
})

describe('debugBody', () => {
  it('keeps the first 500 chars and redacts the given secrets and any JWT', () => {
    const jwt = makeJwt({ sub: 'x' })
    const body = `token=${jwt} refresh=secret-refresh ` + 'y'.repeat(1000)
    const out = debugBody(body, ['secret-refresh'])
    expect(out.length).toBeLessThanOrEqual(501)
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('secret-refresh')
    expect(out).toContain('[REDACTED]')
  })

  it('ignores empty secrets', () => {
    expect(debugBody('abc', ['', null, undefined])).toBe('abc')
  })
})

describe('header helpers', () => {
  it('headerNames lists names only', () => {
    expect(headerNames({ authorization: 'Bearer x', 'ck-cookie-id': 'y' })).toEqual(['authorization', 'ck-cookie-id'])
  })

  it('responseHeaders keeps values but masks set-cookie', () => {
    const h = new Headers({ 'content-type': 'text/html', 'set-cookie': 'CKAT=abc', server: 'CK-FG-server' })
    expect(responseHeaders(h)).toEqual({ 'content-type': 'text/html', 'set-cookie': 'CKAT=[REDACTED]', server: 'CK-FG-server' })
  })

  it('responseHeaders lists every set-cookie NAME, never a value', () => {
    const h = new Headers()
    h.append('set-cookie', 'CKAT=secret1; Path=/; Secure')
    h.append('set-cookie', 'ak_bmsc=secret2; Domain=.creditkarma.com')
    const out = responseHeaders(h)
    expect(out['set-cookie']).toBe('CKAT=[REDACTED], ak_bmsc=[REDACTED]')
    expect(JSON.stringify(out)).not.toMatch(/secret/)
  })
})

describe('refresh call is traced under CK_DEBUG', () => {
  it('logs URL, method, header names, body shape, status, headers and a redacted body head', async () => {
    process.env.CK_DEBUG = '1'
    const access = makeJwt({ iat: nowS() - 60, exp: nowS() + 600 })
    const refresh = makeJwt({ iat: nowS() - 60, exp: nowS() + 28800 })
    const c = new CreditKarmaClient(access, refresh, 'CKTRKID=trk-secret')
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(`<!DOCTYPE html><html>echo ${refresh}</html>`, {
        status: 400,
        headers: { 'content-type': 'text/html', server: 'CK-FG-server' },
      }),
    )
    await c.refreshAccessToken().catch(() => {})

    const out = logged()
    expect(out).toContain('refresh.request')
    expect(out).toContain('https://api.creditkarma.com/mobile/4.5/oauth2/token')
    expect(out).toContain('"method":"POST"')
    expect(out).toContain('"header_names":[')
    expect(out).toContain('"body_shape":{"refreshToken":"string"}')
    expect(out).toContain('refresh.response')
    expect(out).toContain('"status":400')
    expect(out).toContain('CK-FG-server')
    expect(out).toContain('<!DOCTYPE html>')
    // Nothing secret leaks.
    expect(out).not.toContain(access)
    expect(out).not.toContain(refresh)
    expect(out).not.toContain('trk-secret')
  })

  it('logs a transport failure', async () => {
    process.env.CK_DEBUG = '1'
    const c = new CreditKarmaClient('a', 'r', 'CKTRKID=t')
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    await c.refreshAccessToken().catch(() => {})
    expect(logged()).toContain('refresh.error {"message":"Could not reach api.creditkarma.com: fetch failed')
  })
})
