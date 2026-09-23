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
//   2. Saved session (`~/.creditkarma-mcp/session`, see src/session.ts)
//      Written by `ck_set_session` and read here with plain `fs`. It used to
//      be a CK_COOKIES line in <install>/.env, which the shipped .mcpb never
//      read back (fleet-audit#71). Paths 1 and 2 are both LOCAL candidates:
//      whichever holds the fresher refresh JWT wins (the saved file on a
//      tie), so a stale host-provided CK_COOKIES cannot shadow a newer saved
//      session, and a freshly re-pasted CK_COOKIES still beats an old file.
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
import { classifyBridgeError, FetchproxyBridgeDownError } from '@chrischall/mcp-utils/fetchproxy'
import { readEnvVar, parseBoolEnv, parseCookieHeader, decodeJwtClaim } from '@chrischall/mcp-utils'
import pkg from '../package.json' with { type: 'json' }
import { CreditKarmaClient, isJwtExpired } from './client.js'
import { CkAuthError } from './authError.js'
import { readSavedSession, saveSession } from './session.js'

/** Result of resolving CK auth, regardless of which path was taken. */
export interface ResolvedAuth {
  /**
   * Full Cookie header. Identical in shape to what `ck_set_session` accepts
   * and what `CK_COOKIES` is set to: caller parses CKAT inside to extract
   * the access + refresh JWTs, and uses the whole header on refresh requests.
   */
  cookies: string
  /** Which path produced the cookies. Diagnostics + future cache keying. */
  source: 'env' | 'session' | 'fetchproxy'
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
export interface ResolveOptions {
  /**
   * A refresh token Credit Karma has just REJECTED. Any local candidate
   * carrying it is skipped: handing it straight back can never work, and the
   * browser may hold fresh cookies right now. CK_COOKIES is only a seed, so it
   * must not shadow the fetchproxy path once it is known dead (fleet-audit#69).
   */
  rejectedRefreshToken?: string | null
}

export async function resolveAuth(opts: ResolveOptions = {}): Promise<ResolvedAuth> {
  // ── Paths 1 + 2: CK_COOKIES env var / saved session file.
  const local = resolveLocalAuth(opts)
  if (local) return local

  // ── Path 3: fetchproxy fallback — only when nothing local is configured.
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
        throw new CkAuthError(
          'no_credentials',
          'CKAT cookie missing on creditkarma.com. ' +
            'Sign into creditkarma.com in your browser (with the fetchproxy extension installed) and retry.',
        )
      }
      if (!cktrkid) {
        throw new CkAuthError(
          'no_credentials',
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
        // Deliberately NOT a CkAuthError: a sleeping service worker is an
        // infrastructure failure, not a statement about the user's session.
        // Tagging it `no_credentials` would send them to re-sign-in when the
        // fix is to wake the extension.
        throw new Error(
          `CK auth: fetchproxy bridge is down (extension service worker unreachable after retry). ${downErr.hint}`,
        )
      }
      const msg = e instanceof Error ? e.message : String(e)
      const wrapped = `CK auth: no credentials readable — no CK_COOKIES set, and fetchproxy fallback failed: ${msg}`
      // Preserve the reason when the inner throw already classified itself
      // (the CKAT/CKTRKID-missing branches above); anything else that escaped
      // bootstrap is an unknown failure and stays an untyped Error.
      throw e instanceof CkAuthError ? new CkAuthError(e.reason, wrapped) : new Error(wrapped)
    }
  }

  // Something local WAS configured, but CK rejected it and there is nowhere
  // else to look. That is a rejection, not "nothing configured".
  if (opts.rejectedRefreshToken && resolveLocalAuth() !== null) {
    throw new CkAuthError(
      'session_rejected',
      'CK auth: session rejected — Credit Karma refused the saved/CK_COOKIES session and the ' +
        'fetchproxy fallback is disabled. Sign back into creditkarma.com and paste a fresh ' +
        'Cookie header via ck_set_session (or unset CK_DISABLE_FETCHPROXY).',
    )
  }

  // ── Path 4: nothing configured. Surface all three fixes side-by-side so
  //    the user can pick whichever fits their setup.
  throw new CkAuthError(
    'no_credentials',
    'CK auth: no credentials readable — set CK_COOKIES, ' +
      'or call the ck_set_session MCP tool with a Cookie header, ' +
      'or install the fetchproxy extension and sign into creditkarma.com ' +
      '(unset CK_DISABLE_FETCHPROXY if it is set).',
  )
}

/**
 * The best LOCAL credential — the saved session file or CK_COOKIES — without
 * touching the browser. Null when neither is set.
 *
 * Shared by `resolveAuth()` and server startup so both pick the same one.
 * Candidates are ranked live-before-expired, then by the refresh JWT's `exp`
 * (fresher first), then saved-file-before-env: every rotation and every
 * `ck_set_session` writes the file, so on equal footing it is the newer one.
 * An expired candidate is still returned when it is all there is, so the
 * caller reports `session_stale` rather than "nothing configured".
 */
export function resolveLocalAuth(opts: ResolveOptions = {}): ResolvedAuth | null {
  let candidates: ResolvedAuth[] = []
  const saved = readSavedSession()
  if (saved) candidates.push({ cookies: saved, source: 'session' })
  const env = readEnvVar('CK_COOKIES')
  if (env) candidates.push({ cookies: env, source: 'env' })
  if (opts.rejectedRefreshToken) {
    candidates = candidates.filter(
      (c) => splitCkatCookie(c.cookies).refreshToken !== opts.rejectedRefreshToken,
    )
  }
  if (candidates.length === 0) return null

  const rank = (c: ResolvedAuth): [number, number] => {
    const { refreshToken } = splitCkatCookie(c.cookies)
    const expired = refreshToken ? isJwtExpired(refreshToken) : false
    const exp = refreshToken ? decodeJwtClaim(refreshToken, 'exp') : undefined
    return [expired ? 0 : 1, typeof exp === 'number' ? exp : 0]
  }
  // Array.prototype.sort is stable, so equal ranks keep saved-file-first.
  return candidates
    .map((c) => ({ c, r: rank(c) }))
    .sort((a, b) => b.r[0] - a.r[0] || b.r[1] - a.r[1])[0].c
}

/**
 * Split a Cookie header into the CK_COOKIES → (accessToken, refreshToken)
 * shape, mirroring `src/index.ts` and `src/tools/auth.ts`. The CKAT cookie
 * value is `<accessJWT>%3B<refreshJWT>` URL-encoded; we split on either
 * the encoded or literal semicolon. (CK-specific — the generic name→value
 * parse is mcp-utils' `parseCookieHeader`.)
 *
 * Exported so both `src/index.ts` (startup) and `loadAuthIntoClient()`
 * (lazy bootstrap) can share one parser. Returns nulls (not errors) when
 * the input doesn't contain a CKAT — the caller decides whether absence
 * is fatal.
 */
export function splitCkatCookie(cookies: string): {
  accessToken: string | null
  refreshToken: string | null
} {
  const ckat = parseCookieHeader(cookies)['CKAT'] ?? cookies.trim()
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
export async function loadAuthIntoClient(
  client: CreditKarmaClient,
  opts?: ResolveOptions,
): Promise<void> {
  const { cookies } = await resolveAuth(opts)
  applyCookiesToClient(client, cookies)
}

/**
 * Save every rotated session the client reports to the saved-session file, so
 * the next start (and the next `resolveAuth()`) uses the live refresh token
 * instead of the rotated-out one still sitting in CK_COOKIES (fleet-audit#69).
 * A failed write is logged to stderr — stdout is the JSON-RPC stream.
 */
export function persistRotatedSessions(client: CreditKarmaClient): void {
  client.onSessionRotated((cookies) => {
    const warning = saveSession(cookies)
    if (warning) console.error(`[creditkarma-mcp] Warning: rotated session not saved — ${warning}`)
  })
}

/**
 * The half of {@link loadAuthIntoClient} that does NOT resolve: validate a
 * Cookie header and apply it.
 *
 * Split out so a caller that has already resolved can apply the SAME cookies
 * instead of resolving a second time. On the fetchproxy path a resolve is a
 * browser round-trip, so doing it twice in one tool call is a real cost and
 * can even disagree with itself if the browser session changes in between.
 */
export function applyCookiesToClient(client: CreditKarmaClient, cookies: string): void {
  const { accessToken, refreshToken } = splitCkatCookie(cookies)
  if (!accessToken) {
    throw new CkAuthError(
      'no_credentials',
      'CK auth: no credentials readable — resolved cookies did not contain a CKAT token.',
    )
  }
  // A readable-but-dead refresh JWT is its own failure mode. Catching it here
  // — before the POST — means the user is told to sign in rather than shown a
  // Credit Karma HTML error page relayed as an opaque HTTP 400.
  if (refreshToken && isJwtExpired(refreshToken)) {
    throw new CkAuthError(
      'session_stale',
      'CK auth: session stale — the refresh token in your creditkarma.com cookies has expired ' +
        '(they last ~8 hours). Sign back into creditkarma.com so the fetchproxy extension can ' +
        're-read fresh cookies, or paste a fresh Cookie header via ck_set_session.',
    )
  }
  client.setToken(accessToken)
  if (refreshToken) client.setRefreshToken(refreshToken)
  client.setCookies(cookies)
}
