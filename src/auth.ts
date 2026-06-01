// ────────────────────────────────────────────────────────────────────────────
// Auth resolution — Pattern A template
// ────────────────────────────────────────────────────────────────────────────
//
// Mirrors the canonical "browser-bootstrap + Node-direct" shape from
// ofw-mcp/src/auth.ts. Other MCPs in this family (resy-mcp, opentable-mcp,
// signupgenius-mcp, zola-mcp, …) use the same selector — keep the structure
// flat, the path-selection explicit, and the error messages actionable.
//
// THE PATHS, in priority order:
//
//   1. CK_COOKIES env var (existing behavior)
//      A full Cookie header (e.g. `CKTRKID=...; CKAT=eyJ...%3BeyJ...; ...`)
//      from a signed-in creditkarma.com request. The CKAT cookie contains
//      `<accessJWT>%3B<refreshJWT>` URL-encoded, which the caller parses.
//      Legacy users keep working without action.
//
//   2. Cached session from `ck_set_session` (existing behavior)
//      The MCP tool `ck_set_session` accepts a pasted Cookie header and
//      persists it to .env as CK_COOKIES — so once it's been called, this
//      path collapses into path 1 on subsequent runs.
//
//   3. fetchproxy fallback (new)
//      When no Cookie header is set, lift the user's session out of their
//      signed-in creditkarma.com browser tab via the fetchproxy 0.3.0
//      extension. `@fetchproxy/bootstrap` spins up a one-shot WebSocket
//      bridge, asks the extension for the `CKAT` and `CKTRKID` cookies via
//      `chrome.cookies.get`, then closes the bridge. The synthesized
//      Cookie header has the same shape that ck_set_session produces, so
//      the rest of the stack consumes it without branching.
//
//      All subsequent API calls go out via plain Node `fetch()` —
//      fetchproxy is NOT in the request hot path. Token refresh
//      (`POST /member/oauth2/refresh`) is also a plain Node fetch.
//
//      Users opt out with CK_DISABLE_FETCHPROXY=1 (anyone who wants the
//      old behavior of "fail loudly when creds are missing").
//
//   4. Error
//      Nothing to authenticate with. We throw a message that names all
//      three onboarding paths so the user can pick whichever fits.
//
// Why fetchproxy is only a one-shot read:
//   The bootstrap call snapshots the CKAT + CKTRKID cookies and returns.
//   The MCP then operates from Node with direct fetch — latency and
//   reliability are not coupled to the browser bridge for normal tool
//   calls. If the access JWT inside CKAT expires, the refresh flow runs
//   in pure Node against `creditkarma.com/member/oauth2/refresh`. If
//   that 403s (Akamai gate / expired refresh JWT), the user re-signs into
//   creditkarma.com in the browser and the next MCP run re-reads the
//   fresh cookies.
//
// Testability:
//   - `@fetchproxy/bootstrap` is mocked at the module boundary in tests.
//   - This module exposes a single async `resolveAuth()` that returns a
//     Cookie header string + a source label. Callers treat the cookies
//     value as opaque — the existing parser in `src/index.ts` /
//     `src/tools/auth.ts` extracts the CKAT JWTs the same way it does
//     today.

import { bootstrap } from '@fetchproxy/bootstrap'
import { classifyBridgeError, FetchproxyBridgeDownError } from '@fetchproxy/server'
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils'
import pkg from '../package.json' with { type: 'json' }
import { CreditKarmaClient, extractCookieValue } from './client.js'

/** Result of resolving CK auth, regardless of which path was taken. */
export interface ResolvedAuth {
  /**
   * Full Cookie header. Identical in shape to what `ck_set_session` accepts
   * and what `CK_COOKIES` is set to: caller parses CKAT inside to extract
   * the access + refresh JWTs, and uses the whole header on refresh requests.
   */
  cookies: string
  /** Which path produced the cookies. Diagnostics + future cache keying. */
  source: 'env' | 'fetchproxy'
}

/** True if the user has explicitly disabled the fetchproxy fallback. Accepts
 *  the standard truthy tokens (`1`, `true`, `yes`, `on`) via mcp-utils'
 *  `parseBoolEnv`, which also hardens against blank / `${UNEXPANDED}` values. */
function fetchproxyDisabled(): boolean {
  return parseBoolEnv('CK_DISABLE_FETCHPROXY', { default: false })
}

/**
 * Resolve CK auth using the path priority described at the top of this
 * file. Throws with an actionable error message when no path succeeds.
 *
 * Callers should treat the return value as opaque credentials — they
 * should not branch on `source`. The field exists for logging / future
 * cache-keying only.
 */
export async function resolveAuth(): Promise<ResolvedAuth> {
  // ── Path 1: CK_COOKIES env var (unchanged from pre-fetchproxy behavior).
  const envCookies = readEnvVar('CK_COOKIES')
  if (envCookies) {
    return { cookies: envCookies, source: 'env' }
  }

  // ── Path 2: fetchproxy fallback (new).
  //   (Path 2 — cached session from ck_set_session — also lands here at the
  //    env-var step on subsequent runs, since that tool writes CK_COOKIES
  //    to .env. So this branch only fires when neither env var nor cache
  //    has been seeded.)
  if (!fetchproxyDisabled()) {
    try {
      const session = await bootstrap({
        serverName: pkg.name,
        version: pkg.version,
        // CK serves www.creditkarma.com (web) and api.creditkarma.com
        // (GraphQL). Both share the apex domain; the extension matches on
        // suffix so listing the apex covers any subdomain.
        domains: ['creditkarma.com'],
        declare: {
          // CKAT contains the access + refresh JWTs joined by `%3B`. CKTRKID
          // is sent as the `ck-cookie-id` header on refresh requests; without
          // it the refresh endpoint 403s. Both are HttpOnly — invisible to
          // page JS — but fetchproxy 0.3.0's `read_cookies` uses
          // `chrome.cookies.get` which sees HttpOnly cookies.
          cookies: ['CKAT', 'CKTRKID'],
          localStorage: [],
          sessionStorage: [],
          captureHeaders: [],
        },
      })

      const ckat = session.cookies['CKAT']
      const cktrkid = session.cookies['CKTRKID']
      if (!ckat) {
        throw new Error(
          'CKAT cookie missing on creditkarma.com. ' +
            'Sign into creditkarma.com in your browser (with the fetchproxy extension installed) and retry.',
        )
      }
      if (!cktrkid) {
        throw new Error(
          'CKTRKID cookie missing on creditkarma.com. ' +
            'Sign into creditkarma.com in your browser (with the fetchproxy extension installed) and retry.',
        )
      }

      // Synthesize a Cookie header identical in shape to what `ck_set_session`
      // accepts. The existing parser in `src/index.ts` / `src/tools/auth.ts`
      // extracts CKAT and splits its `<accessJWT>%3B<refreshJWT>` payload
      // without caring how the header was assembled.
      const cookies = `CKTRKID=${cktrkid}; CKAT=${ckat}`
      return { cookies, source: 'fetchproxy' }
    } catch (e) {
      // 0.8.0+ typed-error discrimination. The fetchproxy server already
      // retries once on SW eviction (bridgeReviveDelayMs=2000 default), so
      // a thrown FetchproxyBridgeDownError means the retry also failed —
      // the extension's service worker is genuinely down and the user
      // needs to wake it. The `.hint` is the actionable copy
      // ("click the extension toolbar icon...") that we'd otherwise have
      // to hand-write here. Surface it verbatim so users in path 3 get
      // the same self-service guidance as path 4.
      if (classifyBridgeError(e) === 'bridge_down') {
        const downErr = e as FetchproxyBridgeDownError
        throw new Error(
          `CK auth: fetchproxy bridge is down (extension service worker unreachable after retry). ${downErr.hint}`,
        )
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(
        `CK auth: no CK_COOKIES set, and fetchproxy fallback failed: ${msg}`,
      )
    }
  }

  // ── Path 4: nothing configured. Surface all three fixes side-by-side so
  //    the user can pick whichever fits their setup.
  throw new Error(
    'CK auth: set CK_COOKIES, ' +
      'or call the ck_set_session MCP tool with a Cookie header, ' +
      'or install the fetchproxy extension and sign into creditkarma.com ' +
      '(unset CK_DISABLE_FETCHPROXY if it is set).',
  )
}

/**
 * Parse a Cookie header into the CK_COOKIES → (accessToken, refreshToken)
 * shape, mirroring `src/index.ts` and `src/tools/auth.ts`. The CKAT cookie
 * value is `<accessJWT>%3B<refreshJWT>` URL-encoded; we split on either
 * the encoded or literal semicolon.
 *
 * Exported so both `src/index.ts` (startup) and `loadAuthIntoClient()`
 * (lazy bootstrap) can share one parser. Returns nulls (not errors) when
 * the input doesn't contain a CKAT — the caller decides whether absence
 * is fatal.
 */
export function parseCookieHeader(cookies: string): {
  accessToken: string | null
  refreshToken: string | null
} {
  const ckat = extractCookieValue(cookies, 'CKAT') ?? cookies.trim()
  const parts = ckat.replace('%3B', ';').split(';')
  const accessToken = parts[0]?.trim() || null
  const refreshToken = parts[1]?.trim() || null
  return { accessToken, refreshToken }
}

/**
 * Resolve CK auth via `resolveAuth()` and apply the result to a client.
 *
 * Used by tool handlers on the first request that needs auth but finds no
 * credentials on the client — i.e. the user didn't set CK_COOKIES, didn't
 * call ck_set_session, and the fetchproxy extension is the last hope.
 *
 * If `resolveAuth()` lands on the env-var path (path 1) the cookies are
 * applied with no network round-trip. If it lands on fetchproxy (path 3)
 * the bootstrap call snapshots the browser session once; afterwards the
 * client has fresh CKAT + CKTRKID and the normal `refreshAccessToken()`
 * flow takes over.
 */
export async function loadAuthIntoClient(client: CreditKarmaClient): Promise<void> {
  const { cookies } = await resolveAuth()
  const { accessToken, refreshToken } = parseCookieHeader(cookies)
  if (!accessToken) {
    throw new Error('CK auth: resolved cookies did not contain a CKAT token.')
  }
  client.setToken(accessToken)
  if (refreshToken) client.setRefreshToken(refreshToken)
  client.setCookies(cookies)
}
