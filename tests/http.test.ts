import { describe, it, expect, vi, afterEach } from 'vitest'
import { RequestTimeoutError, ResponseTooLargeError } from '@chrischall/mcp-utils'
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
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const err = await boundedFetch('https://vault.api.intuit.com/v2/search', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/vault\.api\.intuit\.com/)
    expect((err as Error).message).toMatch(/fetch failed/)
    expect((err as Error).message).toMatch(/egress/)
    expect((err as Error).cause).toBeInstanceOf(TypeError)
  })

  it('passes any other error through unchanged', async () => {
    const boom = new Error('boom')
    vi.spyOn(global, 'fetch').mockRejectedValue(boom)
    await expect(boundedFetch('https://api.example.com/x', {})).rejects.toBe(boom)
  })
})
