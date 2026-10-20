import { describe, it, expect, vi, afterEach } from 'vitest'
import { McpToolError, RequestTimeoutError, ResponseTooLargeError } from '@chrischall/mcp-utils'
import { boundedFetch, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT } from '../src/http.js'

// fleet-audit#1236: every CK / Intuit request goes through one bounded fetch —
// timeout covering the body read, a byte cap, the call's cancellation — and
// fleet-audit#1187: a request the network refuses names the host it was for.

describe('boundedFetch', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes one shared browser User-Agent and sane bounds', () => {
    expect(USER_AGENT).toMatch(/^Mozilla\/5\.0 /)
    expect(MAX_RESPONSE_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
    expect(REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('returns the buffered response: status, headers and body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"a":1}', { status: 201, statusText: 'Created', headers: { 'x-k': 'v' } }),
    )
    const res = await boundedFetch('https://api.example.com/x', { method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.statusText).toBe('Created')
    expect(res.headers.get('x-k')).toBe('v')
    expect(await res.json()).toEqual({ a: 1 })
  })

  it('passes an abort signal to fetch', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'))
    await boundedFetch('https://api.example.com/x', {})
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('handles a null-body status', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const res = await boundedFetch('https://api.example.com/x', {})
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('refuses a body over the cap', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('x'.repeat(64)))
    await expect(boundedFetch('https://api.example.com/x', {}, { maxBytes: 16 }))
      .rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('times out a response that never finishes', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => undefined))
    await expect(boundedFetch('https://api.example.com/x', {}, { timeoutMs: 20 }))
      .rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('names the host when the network refuses the request', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
    )
    const err = await boundedFetch('https://vault.api.intuit.com/v2/search?q=secret', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpToolError)
    expect((err as McpToolError).kind).toBe('transport')
    expect((err as Error).message).toBe('Could not reach Credit Karma at vault.api.intuit.com (ECONNREFUSED: connect ECONNREFUSED).')
    expect((err as Error).message).not.toContain('secret')
    expect((err as McpToolError).hint).toMatch(/proxy|firewall/i)
    expect((err as Error).cause).toBeInstanceOf(TypeError)
  })

  it("points a hosted connector's egress-proxy refusal at the registration's allow-list", async () => {
    const aborted = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' })
    vi.spyOn(global, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: aborted }) }),
    )
    const err = await boundedFetch('https://vault.api.intuit.com/v2/search', {}).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/vault\.api\.intuit\.com/)
    expect((err as McpToolError).hint).toMatch(/egress allow-list/)
    expect((err as McpToolError).hint).not.toMatch(/VPN|DNS/)
  })

  it('passes a TypeError that is not a transport failure through unchanged', async () => {
    const bad = new TypeError('Invalid header value')
    vi.spyOn(global, 'fetch').mockRejectedValue(bad)
    await expect(boundedFetch('https://api.example.com/x', {})).rejects.toBe(bad)
  })

  it('passes any other error through unchanged', async () => {
    const boom = new Error('boom')
    vi.spyOn(global, 'fetch').mockRejectedValue(boom)
    await expect(boundedFetch('https://api.example.com/x', {})).rejects.toBe(boom)
  })
})
