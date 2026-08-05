/**
 * Live discovery of Credit Karma's persisted-query hashes.
 *
 * CK's GraphQL gateway executes only safelisted operations, selected by a
 * sha256 hash rather than a query document. Those hashes rotate whenever CK
 * ships a web build, which would otherwise break `ck_sync_transactions` until
 * someone hand-edited a constant and cut a release.
 *
 * They are, however, published by CK's own app: the signed-in page lists its
 * Next.js chunk URLs, and one chunk carries a name→hash manifest handed to
 * `usePregeneratedHashes`. Measured 2026-08-05: 22 chunk URLs, manifest found
 * in the 13th, ~0.68 MB and ~1s end to end.
 *
 * Session cookies are required — logged out, the same URL serves the *login*
 * bundle, which carries no manifest.
 */

/** The signed-in page whose bundle carries the manifest. */
export const TRANSACTIONS_PAGE_URL = 'https://www.creditkarma.com/networth/transactions'

/** Call site the hash manifest is passed to; identifies the right chunk. */
export const HASH_MANIFEST_MARKER = 'usePregeneratedHashes'

/**
 * Upper bound on chunks fetched per discovery.
 *
 * The manifest sat at position 13 of 22 when measured, so this leaves ample
 * headroom while keeping a bundle that never matches from becoming an
 * unbounded download.
 */
export const MAX_CHUNKS_SCANNED = 40

/**
 * Whole-scan budget, shared by the page request and every chunk fetch.
 *
 * Deliberately one deadline rather than a per-request timeout: discovery runs
 * inside a sync that has *already* failed, so the point is to bound the extra
 * delay a user waits before seeing the error. Applied per request, a page plus
 * {@link MAX_CHUNKS_SCANNED} chunks could stall for ~10 minutes.
 */
export const DISCOVERY_TIMEOUT_MS = 15_000

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

/** Chunk URLs for CK's `prime_web` app — the bundle that holds the manifest. */
const CHUNK_URL_RE =
  /https:\/\/[^"'\\\s]*\/bundles\/prime_web\/[0-9.]+\/_next\/static\/chunks\/[^"'\\\s]+\.js/g

async function getText(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(url, { headers, signal })
    return res.ok ? await res.text() : null
  } catch {
    // Any transport failure — including the budget expiring — is just "not
    // discoverable right now"; the caller falls back to the compiled-in hash
    // and its actionable error.
    return null
  }
}

/**
 * Find the current sha256 hash for `operationName`, or null if it cannot be
 * determined. Never throws: discovery is a best-effort recovery path, and a
 * failure here must surface as the original GraphQL error, not as a new one.
 */
export async function discoverQueryHash(
  operationName: string,
  cookies: string,
): Promise<string | null> {
  // One controller for the whole scan, so the page fetch and every chunk fetch
  // draw down the same budget. `clearTimeout` in `finally` keeps the timer from
  // holding an otherwise-idle process open.
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort(), DISCOVERY_TIMEOUT_MS)

  try {
    const html = await getText(
      TRANSACTIONS_PAGE_URL,
      { 'User-Agent': USER_AGENT, Cookie: cookies },
      budget.signal,
    )
    if (!html) return null

    const chunkUrls = [...new Set(html.match(CHUNK_URL_RE) ?? [])].slice(0, MAX_CHUNKS_SCANNED)

    // Match the operation name as a complete JSON key, so a lookup for
    // `GetTransactions` is not satisfied by `GetTransactionsList`.
    const entry = new RegExp(`"${escapeRegExp(operationName)}"\\s*:\\s*"([0-9a-f]{64})"`)

    for (const url of chunkUrls) {
      // Stop as soon as the budget is spent rather than queueing dozens of
      // fetches that can only reject.
      if (budget.signal.aborted) return null
      const js = await getText(url, { 'User-Agent': USER_AGENT }, budget.signal)
      // Require the manifest marker: a bare 64-hex string elsewhere in the
      // bundle (an SRI digest, a build id) is not an operation registry.
      if (!js?.includes(HASH_MANIFEST_MARKER)) continue
      const found = js.match(entry)
      if (found) return found[1]
    }

    return null
  } finally {
    clearTimeout(timer)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
