/**
 * `CK_DEBUG=1` tracing for the auth path — credential source, cookie NAMES,
 * JWT timings, and the refresh round-trip — written so the output can be
 * pasted into an issue as-is.
 *
 * Exists because the 2026-10-13 outage was undiagnosable from the tool
 * surface: every refresh came back `HTTP 400 — (non-JSON error page)`, which
 * read as a dead session, and only the request itself (a retired URL) said
 * otherwise. Everything here goes to stderr (stdout is the JSON-RPC stream),
 * and never a token, cookie value or refresh token: JWTs are reduced to their
 * `iat`/`exp`, bodies are cut to 500 chars with secrets and JWTs redacted, and
 * `set-cookie` keeps cookie NAMES only.
 */
import { parseBoolEnv, decodeJwtClaim, truncateErrorMessage } from '@chrischall/mcp-utils'

/** How much of an upstream body a trace keeps. */
const BODY_HEAD_CHARS = 500

export function debugEnabled(): boolean {
  return parseBoolEnv('CK_DEBUG', { default: false })
}

/** One tagged JSON line on stderr, or nothing when CK_DEBUG is off. */
export function debugLog(event: string, fields: Record<string, unknown>): void {
  if (!debugEnabled()) return
  console.error(`[creditkarma-mcp:debug] ${event} ${JSON.stringify(fields)}`)
}

export interface JwtTimes {
  present: boolean
  iat?: string | null
  exp?: string | null
  issued_ago_s?: number
  expires_in_s?: number
}

/** A JWT's issue/expiry times — the token itself never leaves this function. */
export function jwtTimes(token: string | null | undefined): JwtTimes {
  if (!token) return { present: false }
  const iat = decodeJwtClaim(token, 'iat')
  const exp = decodeJwtClaim(token, 'exp')
  const nowS = Date.now() / 1000
  const out: JwtTimes = {
    present: true,
    iat: typeof iat === 'number' ? new Date(iat * 1000).toISOString() : null,
    exp: typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null,
  }
  if (typeof iat === 'number') out.issued_ago_s = Math.round(nowS - iat)
  if (typeof exp === 'number') out.expires_in_s = Math.round(exp - nowS)
  return out
}

/** The head of an upstream body, with the given secrets and any JWT redacted. */
export function debugBody(body: string, secrets: Array<string | null | undefined>): string {
  let out = body
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]')
  // Redact the whole body first (a JWT straddling the cut would otherwise
  // survive in part), then cut.
  out = truncateErrorMessage(out, Number.MAX_SAFE_INTEGER)
  return out.length > BODY_HEAD_CHARS ? `${out.slice(0, BODY_HEAD_CHARS)}…` : out
}

export function headerNames(headers: Record<string, string>): string[] {
  return Object.keys(headers)
}

/**
 * Response headers worth reading in a trace. `set-cookie` would carry tokens,
 * so it keeps only each cookie's NAME — which cookies an endpoint tries to set
 * (CKAT? an Akamai `ak_bmsc`?) is diagnostic; their values never are.
 */
export function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') out[name] = value
  })
  const cookies = headers.getSetCookie()
  if (cookies.length > 0) {
    out['set-cookie'] = cookies.map((c) => `${c.split('=', 1)[0].trim()}=[REDACTED]`).join(', ')
  }
  return out
}
