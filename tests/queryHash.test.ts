import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  discoverQueryHash,
  TRANSACTIONS_PAGE_URL,
  HASH_MANIFEST_MARKER,
  MAX_CHUNKS_SCANNED,
} from '../src/queryHash.js'

// CK rotates its persisted-query hashes on web deploys, which would otherwise
// break sync until someone hand-edited a constant. The current hashes are
// discoverable from the app's own bundle: the signed-in page lists its
// Next.js chunks, and one of them carries a name→hash manifest passed to
// `usePregeneratedHashes`. Measured 2026-08-05: 22 chunk URLs, the manifest
// found in the 13th, ~0.68 MB and ~1s total.
//
// Logged-out the same URL serves the *login* bundle, which has no manifest —
// so discovery needs the session cookies sync already holds.

const CHUNK_BASE = 'https://creditkarmacdn-a.akamaihd.net/res/content/bundles/prime_web/2.0.31/_next/static/chunks'
const HASH = '9b5109d15254ad7fc7d18f597b4026422a69bdc48a4be7d43823866a6ea15915'
const OTHER = '448c78c1783583307c9c28cb14348e3cf55353193e37e50c97bc70d61646c219'

const pageHtml = (n = 3) =>
  Array.from({ length: n }, (_, i) => `<script src="${CHUNK_BASE}/${i}-abc${i}.js"></script>`).join('')

const manifestChunk = (entries: Record<string, string>) =>
  `(0,o.usePregeneratedHashes)(JSON.parse('${JSON.stringify(entries)}'))`

/** Route fetches by URL so tests describe a site, not a call sequence. */
const routes = (page: string | number, chunks: Record<string, string | number>) =>
  vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith(TRANSACTIONS_PAGE_URL)) {
      return typeof page === 'number' ? new Response('', { status: page }) : new Response(page, { status: 200 })
    }
    const body = chunks[url.split('/').pop() ?? '']
    if (body === undefined) return new Response('', { status: 404 })
    if (typeof body === 'number') return new Response('', { status: body })
    return new Response(body, { status: 200 })
  })

describe('discoverQueryHash', () => {
  afterEach(() => vi.restoreAllMocks())

  it('finds the operation hash in the chunk carrying the manifest', async () => {
    routes(pageHtml(), {
      '0-abc0.js': 'unrelated bundle code',
      '1-abc1.js': manifestChunk({ GetTransactionsList: OTHER, GetTransactions: HASH }),
    })

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBe(HASH)
  })

  it('stops fetching chunks once the manifest is found', async () => {
    // 0.68 MB was the measured cost when the manifest turned up 13 chunks in;
    // scanning the remainder would be pure waste.
    const spy = routes(pageHtml(5), { '0-abc0.js': manifestChunk({ GetTransactions: HASH }) })

    await discoverQueryHash('GetTransactions', 'CKAT=x')

    // 1 page + 1 chunk — not all five.
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not confuse an operation with one that extends its name', async () => {
    // "GetTransactionsList" must not satisfy a lookup for "GetTransactions".
    routes(pageHtml(), { '0-abc0.js': manifestChunk({ GetTransactionsList: OTHER }) })

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()
  })

  it('ignores a 64-hex string outside a manifest chunk', async () => {
    // A bare hash somewhere in unrelated code is not an operation registry.
    routes(pageHtml(), { '0-abc0.js': `const sri = {"GetTransactions":"${OTHER}"}` })

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()
  })

  it('returns null when the page is not the signed-in app', async () => {
    // Logged out, CK serves the login bundle — no prime_web chunks at all.
    routes('<script src="https://cdn/bundles/login/3.11.1/_next/static/chunks/x.js"></script>', {})

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()
  })

  it('returns null when the page request fails', async () => {
    routes(403, {})

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()
  })

  it('survives a chunk that fails to load and keeps scanning', async () => {
    // One flaky CDN response must not abandon the whole search.
    routes(pageHtml(), {
      '0-abc0.js': 500,
      '1-abc1.js': manifestChunk({ GetTransactions: HASH }),
    })

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBe(HASH)
  })

  it('survives the page request throwing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'))

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()
  })

  it('sends the session cookies — logged out there is no manifest to find', async () => {
    const spy = routes(pageHtml(1), { '0-abc0.js': manifestChunk({ GetTransactions: HASH }) })

    await discoverQueryHash('GetTransactions', 'CKAT=secret')

    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Cookie']).toBe('CKAT=secret')
  })

  it('bounds how many chunks it will scan', async () => {
    // A bundle that never matches must not turn into an unbounded download.
    const many = Array.from({ length: MAX_CHUNKS_SCANNED + 10 }, (_, i) => `<script src="${CHUNK_BASE}/${i}-abc${i}.js"></script>`).join('')
    const chunks = Object.fromEntries(
      Array.from({ length: MAX_CHUNKS_SCANNED + 10 }, (_, i) => [`${i}-abc${i}.js`, 'nothing here']),
    )
    const spy = routes(many, chunks)

    await expect(discoverQueryHash('GetTransactions', 'CKAT=x')).resolves.toBeNull()

    expect(spy).toHaveBeenCalledTimes(MAX_CHUNKS_SCANNED + 1) // + the page itself
  })

  it('deduplicates repeated chunk URLs', async () => {
    const dupes = `<script src="${CHUNK_BASE}/0-abc0.js"></script>`.repeat(4)
    const spy = routes(dupes, { '0-abc0.js': 'nothing here' })

    await discoverQueryHash('GetTransactions', 'CKAT=x')

    expect(spy).toHaveBeenCalledTimes(2) // page + one unique chunk
  })

  it('pins the marker the manifest is identified by', () => {
    expect(HASH_MANIFEST_MARKER).toBe('usePregeneratedHashes')
  })
})
