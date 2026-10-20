/**
 * The one transport every Credit Karma / Intuit request goes through
 * (fleet-audit#1236): the GraphQL gateway, the token refresh, the Intuit vault
 * search and persisted-query-hash discovery.
 *
 * It is `fetchBounded` from mcp-utils — a timeout that covers the body read,
 * the tool call's cancellation, and a byte cap — returning the BUFFERED
 * response as a `Response`, so the callers (and `TokenManager.withAuth`, which
 * needs a `Response` to see a 401) read it exactly as before.
 */
import { describeTransportFailure, fetchBounded } from '@chrischall/mcp-utils'

/**
 * A browser User-Agent. Akamai in front of creditkarma.com answers a canned
 * refusal without one, so every request sends it.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

/**
 * Per-request deadline for every Credit Karma / Intuit call. A hung connection
 * otherwise left ck_sync_transactions pending until the host timed the whole
 * call out (fleet-audit#389). Hash discovery has its own shared budget
 * (`DISCOVERY_TIMEOUT_MS` in src/queryHash.ts).
 */
export const REQUEST_TIMEOUT_MS = 30_000

/**
 * Largest response body read. The real ones are a transactions page, a token,
 * a vault connections list or a Next.js chunk — all well under this; the cap
 * stops a hostile or broken upstream streaming an unbounded body into memory.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

export interface BoundedFetchOptions {
  /** Defaults to {@link REQUEST_TIMEOUT_MS}; `false` leaves timing to `init.signal`. */
  timeoutMs?: number | false
  /** Defaults to {@link MAX_RESPONSE_BYTES}. */
  maxBytes?: number
}

/** Statuses whose `Response` may not carry a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

export async function boundedFetch(url: string, init: RequestInit, opts: BoundedFetchOptions = {}): Promise<Response> {
  const host = new URL(url).host
  let res: Response
  let body: Uint8Array
  try {
    ;({ res, body } = await fetchBounded(url, init, {
      read: 'bytes',
      maxBytes: opts.maxBytes ?? MAX_RESPONSE_BYTES,
      timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      service: host,
    }))
  } catch (err) {
    // undici reports every transport failure — DNS, a refused connection, a
    // hosted connector's egress proxy refusing a host its manifest does not
    // allow — as a bare `TypeError: fetch failed` that names nothing. Say
    // which host it was, the cause code, and a hint keyed to it.
    throw describeTransportFailure(err, url, 'Credit Karma') ?? err
  }
  // fetchBounded assembles the bytes into a fresh ArrayBuffer-backed array.
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : (body as Uint8Array<ArrayBuffer>), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}
