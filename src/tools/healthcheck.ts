import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck'
import type { CreditKarmaClient } from '../client.js'
import type { AppContext } from '../index.js'
import { isJwtExpired } from '../client.js'
import { resolveAuth, splitCkatCookie, applyCookiesToClient, type ResolvedAuth } from '../auth.js'
import { CkAuthError } from '../authError.js'

/**
 * `ck_healthcheck` — is this connector actually working?
 *
 * Credit Karma had no such tool, and its shape makes one unusually valuable:
 * reads are served from a LOCAL sqlite mirror, so every query tool can answer
 * happily from stale rows long after the upstream session died. Nothing else
 * here distinguishes "the sync is current" from "the sync has been failing
 * quietly for a week".
 *
 * The split between `resolveCredential` and `probeFn` follows CkAuthError's
 * own reasons. Reading cookies (`no_credentials`) is a credential question;
 * whether Credit Karma still ACCEPTS them (`session_stale`,
 * `session_rejected`) is only knowable at the refresh, so that failure belongs
 * to the probe — where it classifies as a rejection rather than as "nothing is
 * configured".
 */
export function registerHealthcheckTools(
  server: McpServer,
  ctx: AppContext,
  /** Seams, injectable so tests need neither network nor browser. */
  deps: {
    resolve?: () => Promise<ResolvedAuth>
    applyCookies?: (c: CreditKarmaClient, cookies: string) => void
  } = {},
): void {
  const { client } = ctx
  const resolve = deps.resolve ?? resolveAuth
  const applyCookies = deps.applyCookies ?? applyCookiesToClient

  // `resolveCredential` and `probeFn` both need the cookies, and a resolve on
  // the fetchproxy path is a browser round-trip. Holding the in-flight promise
  // means one call does one resolve, and the credential the probe uses is the
  // SAME one whose source was just reported — re-resolving could report `env`
  // and then probe with something else if the browser session changed in
  // between. Two concurrent healthchecks may share a resolution; that is
  // harmless, since it is the same credential either way.
  let inFlight: Promise<ResolvedAuth> | null = null

  registerCredentialHealthcheckTool({
    server,
    prefix: 'ck',
    hostLabel: 'creditkarma.com',
    probePath: '/graphql (one transactions page)',
    resolveCredential: async () => {
      try {
        inFlight = resolve()
        const auth = await inFlight
        const { accessToken, refreshToken } = splitCkatCookie(auth.cookies)
        // Liveness of each JWT, never the JWT. An expired ACCESS token beside
        // a live REFRESH token is the normal steady state, so reporting only
        // "expired" would read as broken when it is fine.
        return {
          source: auth.source,
          detail: {
            access_token: !accessToken ? 'absent' : isJwtExpired(accessToken) ? 'expired' : 'live',
            refresh_token: !refreshToken
              ? 'absent'
              : isJwtExpired(refreshToken)
                ? 'expired'
                : 'live',
          },
        }
      } catch (e) {
        // ONLY "nothing readable" is a missing credential. A stale or rejected
        // session is a credential that exists and no longer works — letting it
        // fall in here would advise setting CK_COOKIES that are already set.
        inFlight = null
        if (e instanceof CkAuthError && e.reason === 'no_credentials') return { source: null }
        throw e
      }
    },
    probeFn: async () => {
      // Applied, not re-resolved: `loadAuthIntoClient` would resolve again.
      //
      // `inFlight` is always set here — the helper calls `probeFn` only after
      // `resolveCredential` has resolved a credential, and a resolver failure
      // or a null source returns before any probe. A `?? resolve()` fallback
      // would be unreachable code that no test can cover.
      const { cookies } = await (inFlight as Promise<ResolvedAuth>)
      applyCookies(client, cookies)
      return client.fetchPage()
    },
    classifyThrown: (err: unknown) => {
      if (err instanceof CkAuthError && err.reason !== 'no_credentials') {
        return {
          kind: 'credential_rejected',
          detail: { reason: err.reason },
          hint:
            err.reason === 'session_stale'
              ? 'The refresh JWT expired — detected locally, before any request. Sign in to ' +
                'creditkarma.com again (or re-run ck_set_session); retrying cannot help.'
              : 'Credit Karma rejected the session at /member/oauth2/refresh. Sign in again in ' +
                'the browser and re-read the cookies; the stored ones are dead.',
        }
      }
      return undefined
    },
    hints: {
      no_credential:
        'No Credit Karma credential resolved. Set CK_COOKIES, or install the fetchproxy ' +
        'extension and sign in to creditkarma.com in a tab. Note that ck_query_sql and the ' +
        'summary tools keep answering from the LOCAL mirror while this is broken, so stale ' +
        'answers are not evidence that auth works.',
      ok:
        'Credit Karma accepted the session and returned a transactions page, so auth and the ' +
        'upstream are both healthy. Local query tools read a sqlite mirror, so run ck_sync_' +
        'transactions if you need those rows current.',
    },
  })
}
