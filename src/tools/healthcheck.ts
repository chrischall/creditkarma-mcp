import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  runCredentialHealthcheck,
  credentialHealthcheckDescription,
  type CredentialHealthcheckResult,
  type RegisterCredentialHealthcheckToolArgs,
} from '@chrischall/mcp-utils/healthcheck'
import type { CreditKarmaClient, RefreshOutcome } from '../client.js'
import type { AppContext } from '../index.js'
import { isJwtExpired } from '../client.js'
import { resolveAuth, splitCkatCookie, applyCookiesToClient, type ResolvedAuth } from '../auth.js'
import { CkAuthError } from '../authError.js'
import { jwtTimes } from '../debug.js'

/**
 * A refresh token younger than this gets an explanation with its "sign in
 * again" — a young token looks like it cannot be dead, and it can.
 */
const RECENT_TOKEN_S = 60 * 60

type StepStatus = 'ok' | 'failed' | 'skipped' | 'not_reached'
interface Step {
  status: StepStatus
  [k: string]: unknown
}

/**
 * The four hops a working call crosses, in order. Reported one by one because
 * the arm alone ("credential_rejected") cannot say WHICH hop broke, and the
 * fixes differ: a lookup failure is the extension or the env, a token failure
 * is a stale session, a refresh failure is CK refusing the refresh REQUEST, a
 * probe failure is the data request itself.
 */
interface HopReport {
  credential_lookup: Step
  token_validity: Step
  refresh: Step
  probe: Step
}

const HOP_ORDER = ['credential_lookup', 'token_validity', 'refresh', 'probe'] as const

/** Where to diff the MCP's refresh against the browser's (docs/ is not shipped). */
const GROUND_TRUTH_DOC =
  'https://github.com/chrischall/creditkarma-mcp/blob/main/docs/refresh-ground-truth.md'

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

  // Per-call hop state. Reset at the top of each call; two concurrent
  // healthchecks would share it, which only blurs a diagnostic.
  let hops: HopReport
  let resolvedCookies: string | null = null
  let refreshBefore: RefreshOutcome | null = null

  const args: RegisterCredentialHealthcheckToolArgs = {
    server,
    prefix: 'ck',
    hostLabel: 'creditkarma.com',
    probePath: '/graphql (one transactions page)',
    resolveCredential: async () => {
      try {
        inFlight = resolve()
        const auth = await inFlight
        resolvedCookies = auth.cookies
        hops.credential_lookup = { status: 'ok', source: auth.source }
        const { accessToken, refreshToken } = splitCkatCookie(auth.cookies)
        // Liveness of each JWT, never the JWT. An expired ACCESS token beside
        // a live REFRESH token is the normal steady state, so reporting only
        // "expired" would read as broken when it is fine.
        const access = !accessToken ? 'absent' : isJwtExpired(accessToken) ? 'expired' : 'live'
        const refresh = !refreshToken ? 'absent' : isJwtExpired(refreshToken) ? 'expired' : 'live'
        hops.token_validity = {
          status: access === 'live' || refresh === 'live' ? 'ok' : 'failed',
          access_token: access,
          refresh_token: refresh,
          ...timing('access', accessToken),
          ...timing('refresh', refreshToken),
        }
        return { source: auth.source, detail: { access_token: access, refresh_token: refresh } }
      } catch (e) {
        // ONLY "nothing readable" is a missing credential. A stale or rejected
        // session is a credential that exists and no longer works — letting it
        // fall in here would advise setting CK_COOKIES that are already set.
        inFlight = null
        hops.credential_lookup = { status: 'failed', message: messageOf(e) }
        if (e instanceof CkAuthError && e.reason === 'no_credentials') return { source: null }
        throw e
      }
    },
    probeFn: async () => {
      // Applied (when needed), not re-resolved: `loadAuthIntoClient` would resolve again.
      //
      // `inFlight` is always set here — the helper calls `probeFn` only after
      // `resolveCredential` has resolved a credential, and a resolver failure
      // or a null source returns before any probe. A `?? resolve()` fallback
      // would be unreachable code that no test can cover.
      const { cookies } = await (inFlight as Promise<ResolvedAuth>)
      // Never overwrite a session the shared client can still use
      // (fleet-audit#70). After a sync has refreshed, the client holds CK's
      // ROTATED refresh token; re-applying the resolved cookies would put the
      // rotated-out pair back, and the next refresh would be rejected — a
      // diagnostic breaking a working session. Only a client with nothing
      // usable gets the resolved cookies.
      try {
        if (!holdsUsableSession(client)) applyCookies(client, cookies)
      } catch (e) {
        hops.token_validity = { ...hops.token_validity, status: 'failed', message: messageOf(e) }
        throw e
      }
      refreshBefore = client.getLastRefresh()
      try {
        const page = await client.fetchPage()
        recordRefresh()
        hops.probe = { status: 'ok' }
        return page
      } catch (e) {
        recordRefresh()
        hops.probe =
          hops.refresh.status === 'failed' ? { status: 'not_reached' } : { status: 'failed', message: messageOf(e) }
        throw e
      }
    },
    classifyThrown: (err: unknown) => {
      if (err instanceof CkAuthError && err.reason !== 'no_credentials') {
        return {
          kind: 'credential_rejected',
          detail: { reason: err.reason },
          hint: rejectionHint(err, resolvedCookies),
        }
      }
      return undefined
    },
    hints: {
      no_credential:
        'No Credit Karma credential resolved. Set CK_COOKIES, or install the ContextMint ' +
        'Bridge browser extension and sign in to creditkarma.com in a tab. Note that ck_query_sql and the ' +
        'summary tools keep answering from the LOCAL mirror while this is broken, so stale ' +
        'answers are not evidence that auth works.',
      ok:
        'Credit Karma accepted the session and returned a transactions page, so auth and the ' +
        'upstream are both healthy. Local query tools read a sqlite mirror, so run ck_sync_' +
        'transactions if you need those rows current.',
    },
  }

  /** Did this probe trigger a refresh, and how did it go? */
  function recordRefresh(): void {
    const after = client.getLastRefresh()
    if (after === refreshBefore || after === null) {
      hops.refresh = { status: 'skipped' }
      return
    }
    hops.refresh = {
      status: after.outcome,
      ...(after.status !== undefined ? { http_status: after.status } : {}),
      ...(after.message !== undefined ? { message: after.message } : {}),
    }
  }

  server.registerTool(
    'ck_healthcheck',
    {
      title: 'Verify credentials and upstream reachability',
      description:
        `${credentialHealthcheckDescription('creditkarma.com')} Call this when a real tool fails and you want ` +
        'to know which hop broke — `steps` reports credential lookup, token validity, refresh and probe ' +
        'separately, and `failed_step` names the first that failed.',
      annotations: {
        title: 'Verify credentials and upstream reachability',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({}),
    },
    async () => {
      hops = {
        credential_lookup: { status: 'not_reached' },
        token_validity: { status: 'not_reached' },
        refresh: { status: 'not_reached' },
        probe: { status: 'not_reached' },
      }
      resolvedCookies = null
      const res = await runCredentialHealthcheck(args)
      const result = JSON.parse(res.content[0].text) as CredentialHealthcheckResult
      const failed = HOP_ORDER.find((h) => hops[h].status === 'failed')
      const report = { ...result, steps: hops, ...(failed ? { failed_step: failed } : {}) }
      return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] }
    },
  )
}

/** `<name>_expires_in_s` / `<name>_issued_ago_s` for a JWT — never the JWT. */
function timing(name: string, token: string | null): Record<string, number> {
  const t = jwtTimes(token)
  const out: Record<string, number> = {}
  if (t.expires_in_s !== undefined) out[`${name}_expires_in_s`] = t.expires_in_s
  if (t.issued_ago_s !== undefined) out[`${name}_issued_ago_s`] = t.issued_ago_s
  return out
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The remedy for a rejected session: sign in again. A recent `iat` does NOT
 * prove the session alive — measured 2026-10-13, a refresh token issued 23
 * min earlier and nowhere near its `exp` was refused because CK had already
 * ended the session (an idle tab was signed out), and a sign-in fixed it. So
 * a young token gets the same advice plus why. The case where signing in
 * cannot help — the refresh refused at the edge before CK saw the token — is
 * an `EdgeBlockedError`, not a `CkAuthError`, and never reaches here.
 */
function rejectionHint(err: CkAuthError, cookies: string | null): string {
  if (err.reason === 'session_stale') {
    return (
      'The refresh JWT expired — detected locally, before any request. Sign in to ' +
      'creditkarma.com again (or re-run ck_set_session); retrying cannot help.'
    )
  }
  const { refreshToken } = cookies ? splitCkatCookie(cookies) : { refreshToken: null }
  const t = jwtTimes(refreshToken)
  const young =
    t.issued_ago_s !== undefined &&
    t.issued_ago_s < RECENT_TOKEN_S &&
    t.expires_in_s !== undefined &&
    t.expires_in_s > 0
  const why = young
    ? ` Its refresh token was issued ${Math.max(0, Math.round(t.issued_ago_s! / 60))} min ago and has not ` +
      'expired, but CK ends sessions server-side before then — an idle tab is signed out, and any other ' +
      'client refreshing the shared CKAT rotates it — so that is still the usual cause.'
    : ''
  return (
    'Credit Karma rejected the session at the token refresh. Sign in again in the browser and ' +
    `re-read the cookies; the stored ones are dead.${why} If a sign-in made moments ago fails the same way, ` +
    `restart the server with CK_DEBUG=1 and see ${GROUND_TRUTH_DOC}.`
  )
}

/**
 * True when the client already holds credentials it can make a request with:
 * a live access token, or a refresh token that has not expired.
 */
function holdsUsableSession(client: CreditKarmaClient): boolean {
  if (!client.getToken()) return false
  if (!client.isTokenExpired()) return true
  const refresh = client.getRefreshToken()
  return refresh !== null && !isJwtExpired(refresh)
}
