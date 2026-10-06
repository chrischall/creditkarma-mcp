import {
  truncateErrorMessage,
  decodeJwtClaim,
  parseCookieHeader,
  EdgeBlockedError,
  detectEdgeBlock,
} from '@chrischall/mcp-utils'
import { TokenManager } from '@chrischall/mcp-utils/session'
import { CkAuthError } from './authError.js'
import * as queryHash from './queryHash.js'

/**
 * Fallback lifetime assumed for an access token whose real expiry can't be
 * read. Deliberately shorter than CK's actual ~15 minutes so an undecodable
 * token errs towards refreshing rather than towards using a dead one.
 */
const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * When the access token actually expires.
 *
 * Prefers the JWT's own `exp` over a synthetic window, because the difference
 * decides whether we POST `/member/oauth2/refresh` — and every one of those
 * ROTATES CK's refresh token, invalidating the copy in the browser's `CKAT`
 * cookie and eventually signing the user out of creditkarma.com (#119).
 * Assuming a 10-minute life for a token CK actually gave 15 minutes
 * manufactured needless rotations; reading `exp` makes the decision honest.
 *
 * Falls back to the synthetic window for anything undecodable, so opaque
 * tokens keep working.
 */
function accessTokenExpiry(token: string | null | undefined): number {
  const exp = token ? decodeJwtClaim(token, 'exp') : undefined
  return typeof exp === 'number' ? exp * 1000 : Date.now() + TOKEN_TTL_MS
}

/** Pause before the single post-429 replay. */
const RATE_LIMIT_BACKOFF_MS = 2000

/**
 * Client identity the GraphQL gateway keys its persisted-operation registry on.
 *
 * `prime_web` is the CK web app's own value and the ONLY one that resolves —
 * `web` (what `/member/oauth2/refresh` accepts) is rejected. Without this
 * header pair the gateway has no registry to look the operation up in and
 * answers `No query found`, which is why that error was long mistaken for a
 * ~44% upstream flake.
 *
 * The version is presence-checked only: `1.0.0`, `2.0.30` and `99.0.0` all
 * return 200, an empty string 400s. It tracks CK's deployed web build purely
 * as documentation of where {@link TRANSACTION_QUERY_HASH} came from.
 */
export const CK_CLIENT_NAME = 'prime_web'
export const CK_CLIENT_VERSION = '2.0.31'

/** Operation name that goes alongside the persisted hash. */
export const TRANSACTION_OPERATION_NAME = 'GetTransactions'

/**
 * sha256 of CK's safelisted `GetTransactions` operation.
 *
 * The gateway executes ONLY safelisted operations — a full ad-hoc document is
 * rejected even with correct headers — so this hash, not
 * `src/transaction.graphql`, is what actually selects the query. Its response
 * is a superset of {@link ApiTransaction}, so the parser is unaffected.
 *
 * To re-derive after a CK web deploy: load a signed-in creditkarma.com page,
 * grep the Next.js chunks under
 * `creditkarmacdn-a.akamaihd.net/res/content/bundles/prime_web/<ver>/_next/static/chunks/`
 * for `usePregeneratedHashes` — it holds a name→hash manifest of all 14
 * operations.
 */
export const TRANSACTION_QUERY_HASH =
  '9b5109d15254ad7fc7d18f597b4026422a69bdc48a4be7d43823866a6ea15915'

export const GRAPHQL_ENDPOINT = 'https://api.creditkarma.com/graphql'

/**
 * A safelisted CK operation and the web app it belongs to.
 *
 * The gateway keeps one safelist PER APP, keyed on `ck-client-name`: a hash
 * registered by `credit-health` answers "No query found" when sent as
 * `prime_web`. So each operation carries the identity of the app whose bundle
 * published it, and `source` says where to re-read the hash when it rotates.
 */
export interface OperationSpec {
  operationName: string
  hash: string
  clientName: string
  clientVersion: string
  source: queryHash.HashSource
}

/** `credit-health` bundle version the credit-report hashes came from. */
export const CREDIT_HEALTH_CLIENT_VERSION = '1.2.1'

/**
 * Balance operations. Hashes read 2026-10-06 from the manifests of `prime_web`
 * 2.0.35 and `credit-health` 1.2.1; {@link CreditKarmaClient.runOperation}
 * re-reads them in-process if CK rotates them.
 */
export const OPERATIONS = {
  /** Net-worth page for one account type ("cash", "investments", …): server-driven UI. */
  getAccountL2Page: {
    operationName: 'getAccountL2Page',
    hash: 'ae3d3cc725b67ede7ec9216518daf4c06695c583301d6749881a1a55a9c061f2',
    clientName: CK_CLIENT_NAME,
    clientVersion: CK_CLIENT_VERSION,
    source: queryHash.PRIME_WEB_SOURCE,
  },
  /** Per-institution connections with their exact last refresh time. */
  idxConnections: {
    operationName: 'idxConnections',
    hash: 'b15bb6b455264783f9c130ddf6a646ba2caf25355937dc18a54833f8aa54d33c',
    clientName: CK_CLIENT_NAME,
    clientVersion: CK_CLIENT_VERSION,
    source: queryHash.PRIME_WEB_SOURCE,
  },
  /** Report pull dates per bureau — `getCreditReport` needs one of them exactly. */
  getCreditReportHistory: {
    operationName: 'getCreditReportHistory',
    hash: 'c4292dade7cf16cffd893ac52be341debcbc8e5d23383584a97e8ed3b3e4d00c',
    clientName: 'credit-health',
    clientVersion: CREDIT_HEALTH_CLIENT_VERSION,
    source: queryHash.CREDIT_HEALTH_SOURCE,
  },
  /** One bureau's full report: typed tradelines with balances and limits. */
  getCreditReport: {
    operationName: 'getCreditReport',
    hash: 'e18b04e3456cf94d7286a538514340ba13eb6ff5229c18fe8a789fdff02d6801',
    clientName: 'credit-health',
    clientVersion: CREDIT_HEALTH_CLIENT_VERSION,
    source: queryHash.CREDIT_HEALTH_SOURCE,
  },
} satisfies Record<string, OperationSpec>

/** Sentinel for "the gateway could not resolve our persisted hash" — distinct
 *  from a page, and not an error, because it has a recovery path. */
const NO_QUERY_FOUND = Symbol('NO_QUERY_FOUND')
export const CK_REFRESH_ENDPOINT = 'https://www.creditkarma.com/member/oauth2/refresh'

export interface TransactionPage {
  transactions: ApiTransaction[]
  pageInfo: {
    startCursor: string
    endCursor: string
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

export interface ApiTransaction {
  id: string
  date: string
  description: string
  status: string
  amount: { value: number; asCurrencyString: string }
  account: {
    id: string
    name: string
    type: string
    providerName: string
    accountTypeAndNumberDisplay: string
    /** e.g. `urn:account:fdp::accountid:<uuid>`; present on newer responses only. */
    accountURN?: string
  }
  category: { id: string; name: string; type: string } | null
  merchant: { id: string; name: string } | null
}

export class CreditKarmaClient {
  private token: string | null = null
  private refreshToken: string | null = null
  private cookies: string | null = null
  /**
   * Owns the bearer-token lifecycle: TTL/expiry tracking, proactive refresh
   * inside a skew window, the single 401-replay on the authed GraphQL POST, and
   * the single-flight semaphore that coalesces concurrent refreshes into ONE
   * `/member/oauth2/refresh` POST. Replaces the hand-rolled `tokenSetAt` TTL
   * tracking + `refreshInFlight` single-flight this class used to carry.
   *
   * CK's access/refresh tokens + cookies remain this class's own mutable state
   * (the sync `getToken()`/`getRefreshToken()`/`getCookies()` accessors and the
   * request headers read them directly); the refresh callback mirrors fresh
   * tokens back into those fields so the two stay in lock-step. The manager is
   * rebuilt on every external `setToken()` so its expiry window restarts from
   * "now" — matching the old `tokenSetAt = Date.now()` reset.
   */
  private tokens: TokenManager

  /**
   * Hash actually sent. Starts at the compiled-in {@link TRANSACTION_QUERY_HASH}
   * and is replaced in-process if CK turns out to have rotated it — so a sync
   * can heal itself without waiting on a release.
   */
  private queryHash: string = TRANSACTION_QUERY_HASH

  /** Guards `rediscoverQueryHash` to one attempt per client. */
  private hashRediscovered = false

  /** Hashes healed in-process for {@link runOperation}, by operation name. */
  private operationHashes = new Map<string, string>()

  /** Operations whose hash discovery has already been attempted. */
  private operationsRediscovered = new Set<string>()

  /** Told the rebuilt Cookie header after every successful refresh. */
  private sessionListener: ((cookies: string) => void) | null = null

  constructor(token?: string, refreshToken?: string, cookies?: string) {
    if (refreshToken) this.refreshToken = refreshToken
    if (cookies) this.cookies = cookies
    if (token) this.token = token
    this.tokens = this.buildTokenManager()
  }

  /**
   * (Re)build the {@link TokenManager} around the client's current token state,
   * restarting the TTL window from now. The refresh callback runs CK's native
   * refresh POST and writes the fresh access/refresh tokens straight onto this
   * client (NOT via `setToken`, which would rebuild the manager mid-flight and
   * orphan the in-flight single-flight promise); the manager applies the new
   * `expiresAt` to its own window.
   */
  private buildTokenManager(): TokenManager {
    return new TokenManager({
      initial: {
        accessToken: this.token ?? '',
        refreshToken: this.refreshToken ?? undefined,
        expiresAt: accessTokenExpiry(this.token),
      },
      // TokenManager only calls this when a refresh token is present (guaranteed
      // by `refreshAccessToken`'s own NO_REFRESH_TOKEN guard / by withAuth only
      // refreshing when it has one), so the callback can assume one exists.
      refresh: async () => {
        const { accessToken, refreshToken } = await this.doRefreshAccessToken()
        this.token = accessToken
        if (refreshToken) this.refreshToken = refreshToken
        // CK just ROTATED the refresh token, so the CKAT inside our Cookie
        // header is now the rotated-out pair — and it is sent on later refresh
        // and discovery requests. Rebuild it, then hand it to whoever persists
        // it, or a restart reloads the dead token (fleet-audit#69).
        this.cookies = withCkat(this.cookies, accessToken, this.refreshToken!)
        this.sessionListener?.(this.cookies)
        return {
          accessToken,
          // Omit an empty/absent refresh token so the manager keeps the prior one.
          refreshToken: refreshToken || undefined,
          expiresAt: accessTokenExpiry(accessToken),
        }
      },
    })
  }

  setToken(token: string): void {
    this.token = token
    // Restart the TTL window (old behavior: `tokenSetAt = Date.now()`).
    this.tokens = this.buildTokenManager()
  }

  getToken(): string | null {
    return this.token
  }

  getRefreshToken(): string | null {
    return this.refreshToken
  }

  setRefreshToken(token: string): void {
    this.refreshToken = token
    // Keep the manager's view of the refresh token current for later refreshes.
    this.tokens = this.buildTokenManager()
  }

  getCookies(): string | null {
    return this.cookies
  }

  setCookies(cookies: string): void {
    this.cookies = cookies
  }

  /**
   * Drop every credential this client holds (`ck_forget_session`), so the
   * running server stops using the session as well as the file on disk.
   */
  clearSession(): void {
    this.token = null
    this.refreshToken = null
    this.cookies = null
    this.tokens = this.buildTokenManager()
  }

  /**
   * Register the one listener told the rebuilt Cookie header after each
   * successful refresh, i.e. each rotation of CK's refresh token.
   */
  onSessionRotated(listener: (cookies: string) => void): void {
    this.sessionListener = listener
  }

  isTokenExpired(): boolean {
    if (!this.token) return true
    // TTL is owned by the TokenManager now; expired ⟺ at/after its expiry.
    return Date.now() >= this.tokens.getExpiresAt()
  }

  /**
   * POST the authed GraphQL query through the TokenManager so a token within the
   * skew window is proactively refreshed first, and a hard HTTP 401 triggers one
   * refresh + replay. When no refresh token is available the manager's refresh
   * attempt rejects — surface that as a 401 Response so `fetchPage` maps it to
   * the same TOKEN_EXPIRED the bespoke path produced (sync.ts then re-auths).
   *
   * (CK's PRIMARY expired-token signal is a 200 body carrying an auth `errorCode`,
   * not an HTTP 401 — that GraphQL-errorCode path is mapped to TOKEN_EXPIRED in
   * `parseTransactionPage` and reactively refreshed by the sync loop, since the
   * manager's reactive replay is HTTP-status-based and can't see GraphQL bodies.)
   */
  private graphqlPost(
    body: Record<string, unknown>,
    clientName: string = CK_CLIENT_NAME,
    clientVersion: string = CK_CLIENT_VERSION,
  ): Promise<Response> {
    return this.tokens
      .withAuth((accessToken) => this.post(GRAPHQL_ENDPOINT, body, accessToken, clientName, clientVersion))
      .catch((err: unknown) => {
        if (err instanceof Error && /no refresh token/i.test(err.message)) {
          return new Response(null, { status: 401 })
        }
        throw err
      })
  }

  /**
   * Fetch a single page of transactions. Throws TOKEN_EXPIRED on 401.
   *
   * `No query found` is never retried as-is — the gateway either resolves our
   * hash or it never will. But CK rotates hashes on web deploys, so the one
   * recovery worth attempting is re-reading the current hash from CK's own
   * bundle and replaying with it. That happens at most once per client.
   */
  async fetchPage(afterCursor?: string): Promise<TransactionPage> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const page = await this.attemptPage(afterCursor)
    if (page !== NO_QUERY_FOUND) return page

    if (await this.rediscoverQueryHash()) {
      const replay = await this.attemptPage(afterCursor)
      if (replay !== NO_QUERY_FOUND) return replay
    }

    throw new Error(
      `GraphQL gateway rejected the request with "No query found" (HTTP 400). The ` +
        `persisted-query hash for ${TRANSACTION_OPERATION_NAME} is not registered, and ` +
        `re-reading it from Credit Karma's current web bundle did not yield a working ` +
        `replacement. This is not a session problem, and retrying will not help. Derive the ` +
        `hash by hand: open a signed-in creditkarma.com page and grep its Next.js chunks for ` +
        `\`${queryHash.HASH_MANIFEST_MARKER}\`, then update TRANSACTION_QUERY_HASH in ` +
        `src/client.ts. Already-synced data stays queryable via ck_list_transactions / ` +
        `ck_query_sql.`,
    )
  }

  /**
   * Re-read the persisted hash from CK's web bundle. Returns true only when it
   * yields something new that is worth replaying.
   *
   * Attempted at most once per client: a second lookup would return the same
   * answer, so it would only add latency to each remaining page of the sync.
   * Skipped entirely without cookies — discovery reads a signed-in page, and
   * logged out CK serves the login bundle, which carries no manifest.
   */
  private async rediscoverQueryHash(): Promise<boolean> {
    if (this.hashRediscovered || !this.cookies) return false
    this.hashRediscovered = true

    const discovered = await queryHash.discoverQueryHash(TRANSACTION_OPERATION_NAME, this.cookies)
    if (!discovered || discovered === this.queryHash) return false

    this.queryHash = discovered
    return true
  }

  /**
   * One POST for a page. Returns {@link NO_QUERY_FOUND} for the rotated-hash
   * signature so the caller can decide whether recovery is worth attempting;
   * every other failure throws here.
   */
  private async attemptPage(afterCursor?: string): Promise<TransactionPage | typeof NO_QUERY_FOUND> {
    const request = buildPersistedRequest(TRANSACTION_OPERATION_NAME, buildVariables(afterCursor), this.queryHash)
    let response = await this.graphqlPost(request)

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      response = await this.graphqlPost(request)
      if (response.status === 401) throw new Error('TOKEN_EXPIRED')
    }

    if (response.ok) return parseTransactionPage(await response.json())

    // Body is read once here: `Response` bodies are single-use, so the
    // signature check and the error message share this one read.
    const body = await readBodyOrEmpty(response)

    if (isNoQueryFound(response.status, body)) return NO_QUERY_FOUND

    // A CDN/WAF refusal page is not Credit Karma's answer, and its markers sit
    // past the 200-char cut below — so name it here, from the full body.
    throwIfEdgeBlocked(response, body, 'POST', '/graphql')

    throw new Error(httpErrorMessage(response.status, body))
  }

  /**
   * Run one safelisted operation and return its JSON body.
   *
   * Same transport rules as {@link fetchPage} — the shared token lifecycle,
   * TOKEN_EXPIRED for HTTP 401 or an auth-shaped error code, one replay after a
   * 429, an edge block named as such — but the body is returned as-is: what a
   * non-auth GraphQL error MEANS differs per operation (CK answers a credit
   * report request with a bad date as a generic "An error occurred."), so the
   * caller's parser decides. A rotated hash is re-read from the operation's
   * own app bundle, once per operation per client.
   */
  async runOperation(op: OperationSpec, variables: Record<string, unknown>): Promise<unknown> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const result = await this.attemptOperation(op, variables)
    if (result !== NO_QUERY_FOUND) return result

    if (await this.rediscoverOperationHash(op)) {
      const replay = await this.attemptOperation(op, variables)
      if (replay !== NO_QUERY_FOUND) return replay
    }

    throw new Error(
      `GraphQL gateway answered "No query found" (HTTP 400) for ${op.operationName}: its persisted-query ` +
        `hash is not registered for ck-client-name "${op.clientName}", and re-reading it from Credit ` +
        `Karma's ${op.source.bundle} bundle did not yield a working replacement. Update ` +
        `OPERATIONS.${op.operationName}.hash in src/client.ts from that bundle's ` +
        `\`${queryHash.HASH_MANIFEST_MARKER}\` manifest.`,
    )
  }

  private async rediscoverOperationHash(op: OperationSpec): Promise<boolean> {
    if (this.operationsRediscovered.has(op.operationName) || !this.cookies) return false
    this.operationsRediscovered.add(op.operationName)

    const discovered = await queryHash.discoverQueryHash(op.operationName, this.cookies, op.source)
    if (!discovered || discovered === this.operationHash(op)) return false

    this.operationHashes.set(op.operationName, discovered)
    return true
  }

  private operationHash(op: OperationSpec): string {
    return this.operationHashes.get(op.operationName) ?? op.hash
  }

  private async attemptOperation(op: OperationSpec, variables: Record<string, unknown>): Promise<unknown> {
    const body = buildPersistedRequest(op.operationName, variables, this.operationHash(op))
    let response = await this.graphqlPost(body, op.clientName, op.clientVersion)

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      response = await this.graphqlPost(body, op.clientName, op.clientVersion)
      if (response.status === 401) throw new Error('TOKEN_EXPIRED')
    }

    if (response.ok) {
      const json = await response.json() as Record<string, unknown>
      if (collectErrorCodes(json).some(c => AUTH_ERROR_CODE.test(c))) throw new Error('TOKEN_EXPIRED')
      return json
    }

    const text = await readBodyOrEmpty(response)
    if (isNoQueryFound(response.status, text)) return NO_QUERY_FOUND
    throwIfEdgeBlocked(response, text, 'POST', '/graphql')
    throw new Error(httpErrorMessage(response.status, text))
  }

  /**
   * Refresh the access token using CK's native refresh endpoint.
   * Requires a refresh token and session cookies (captured after login).
   *
   * The {@link TokenManager} owns the single-flight: concurrent callers (e.g. a
   * multi-page sync that 401s on several pages at once) coalesce onto ONE
   * in-flight refresh instead of firing duplicate POSTs to
   * /member/oauth2/refresh (wasted quota, rate-limit risk). The in-flight slot
   * clears on settle, so a later expiry refreshes anew.
   */
  async refreshAccessToken(): Promise<string> {
    // Keep CK's actionable NO_REFRESH_TOKEN message (the manager would otherwise
    // reject with its generic "no refresh token is available").
    if (!this.refreshToken) throw new Error('NO_REFRESH_TOKEN: Call ck_set_session first.')
    await this.tokens.refreshNow()
    return this.token!
  }

  /**
   * Perform CK's native refresh POST and return the parsed tokens. The
   * lifecycle (single-flight, expiry, mirroring onto this client) is handled by
   * the {@link TokenManager} refresh callback that wraps this.
   */
  private async doRefreshAccessToken(): Promise<{ accessToken: string; refreshToken?: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Origin': 'https://www.creditkarma.com',
      'Referer': 'https://www.creditkarma.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'ck-client-name': 'web',
      'ck-client-version': '1.0.0',
      'ck-device-type': 'Desktop',
    }

    if (this.token) {
      headers['authorization'] = `Bearer ${this.token}`
      // Extract glid from JWT for ck-trace-id
      const glid = decodeJwtClaim(this.token, 'glid')
      if (typeof glid === 'string') headers['ck-trace-id'] = glid
      // Extract CKTRKID cookie for ck-cookie-id
      const cookieId = parseCookieHeader(this.cookies ?? '')['CKTRKID'] ?? null
      if (cookieId) headers['ck-cookie-id'] = cookieId
    }

    if (this.cookies) headers['Cookie'] = this.cookies

    const res = await fetch(CK_REFRESH_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: this.refreshToken })
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // Checked BEFORE the session_rejected throw: an edge block answers 403
      // without CK ever seeing the refresh token, so it must not read as a
      // rejected session (or trigger the re-bootstrap that one gets).
      throwIfEdgeBlocked(res, body, 'POST', '/member/oauth2/refresh')
      const contentType = res.headers.get('content-type') ?? ''
      const looksHtml = !contentType.includes('json') && /^\s*<(!doctype|html)/i.test(body)
      const detail = looksHtml
        ? '(non-JSON error page — refresh token likely expired or session invalid; sign back into creditkarma.com so the ContextMint Bridge extension can re-read fresh cookies, or paste a fresh Cookie header via ck_set_session)'
        // Redact + cap the upstream body (same treatment as the GraphQL path)
        // so tokens echoed back by CK never reach the tool surface.
        : (truncateErrorMessage(body, 200).trim() || '(empty body)')
      // `session rejected` is the load-bearing phrase: it says we HAD readable
      // credentials and Credit Karma turned them down — as opposed to
      // `no credentials readable`, which means the extension/env gave us
      // nothing to send. Those two used to be indistinguishable at a glance
      // and they have different fixes.
      throw new CkAuthError(
        'session_rejected',
        `CK auth: session rejected — Token refresh failed: HTTP ${res.status} — ${detail}`,
        res.status,
      )
    }
    const json = await res.json() as { accessToken?: string; refreshToken?: string; error?: string }
    if (json.error || !json.accessToken) throw new Error(`Token refresh error: ${json.error ?? 'no accessToken in response'}`)

    return { accessToken: json.accessToken, refreshToken: json.refreshToken }
  }

  private post(url: string, body: unknown, token: string, clientName: string, clientVersion: string): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Required — without this pair the gateway cannot resolve the
        // persisted operation and answers `No query found`.
        'ck-client-name': clientName,
        'ck-client-version': clientVersion,
        'Origin': 'https://www.creditkarma.com',
        'Referer': 'https://www.creditkarma.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return `cookies` with its CKAT cookie set to `<access>%3B<refresh>`, leaving
 * every other cookie untouched. A missing header — or a bare CKAT value, which
 * the lenient parsers also accept — becomes a plain `CKAT=` header.
 */
export function withCkat(cookies: string | null, accessToken: string, refreshToken: string): string {
  const ckat = `CKAT=${accessToken}%3B${refreshToken}`
  if (!cookies || parseCookieHeader(cookies)['CKAT'] === undefined) return ckat
  return cookies.replace(/(^|;\s*)CKAT=[^;]*/, `$1${ckat}`)
}

/** True only if we can decode the JWT and its `exp` claim is in the past.
 *  Returns false for un-decodable strings (let the API decide) or tokens
 *  without an `exp` claim — deliberately lenient, unlike mcp-utils'
 *  fail-closed `validateJwtExpiry`. */
export function isJwtExpired(token: string): boolean {
  const exp = decodeJwtClaim(token, 'exp')
  return typeof exp === 'number' && exp * 1000 < Date.now()
}

/**
 * Emit the standard stderr warning when a refresh JWT is present but already
 * expired. Single source of truth for the message that previously lived in
 * both `src/index.ts` (startup) and was conceptually mirrored in
 * `ck_set_session`. No-op when the token is absent or still valid.
 */
export function warnIfRefreshTokenExpired(refreshToken: string | undefined | null): void {
  if (refreshToken && isJwtExpired(refreshToken)) {
    console.error('[creditkarma-mcp] Warning: refresh token in CK_COOKIES has expired. Sign back into creditkarma.com (with the ContextMint Bridge extension installed) or call ck_set_session with a fresh Cookie header.')
  }
}

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

/**
 * Build the persisted-query request body.
 *
 * Deliberately carries NO `query` field: CK's gateway executes only safelisted
 * operations, and including a document gets the whole request rejected rather
 * than being ignored as a harmless extra. `src/transaction.graphql` is kept in
 * the repo as documentation of the selection set {@link parseTransactionPage}
 * reads, but it is no longer sent — or even loaded — at runtime.
 */
function buildPersistedRequest(
  operationName: string,
  variables: Record<string, unknown>,
  sha256Hash: string,
): Record<string, unknown> {
  return {
    extensions: { persistedQuery: { version: 1, sha256Hash } },
    operationName,
    variables,
  }
}

function buildVariables(afterCursor?: string): Record<string, unknown> {
  return {
    input: {
      paginationInput: { afterCursor: afterCursor ?? null },
      categoryInput: { categoryId: null, primeCategoryType: null },
      datePeriodInput: { datePeriod: null },
      accountInput: {}
    }
  }
}

/** GraphQL/HTTP error codes that mean "the access token is no longer valid" —
 *  these (and only these) should drive the refresh + retry path. Anything else
 *  (schema drift, validation, server faults) is a real error to surface, not an
 *  auth failure to paper over with a pointless token refresh.
 *
 *  Deliberately NOT including FORBIDDEN/403: that means "authenticated but not
 *  authorized for this resource", so a token refresh wouldn't help and the retry
 *  would just fail again with the same code, masking the real problem. We have
 *  no evidence CK returns FORBIDDEN for an expired token. */
const AUTH_ERROR_CODE = /\b(UNAUTHENTICATED|UNAUTHORIZED|TOKEN_EXPIRED|401)\b/i

/** Pull every candidate "error code" string out of a GraphQL error payload:
 *  the top-level `errorCode`, and each entry's `errorCode` / `code` /
 *  `extensions.code`. CK has shipped auth failures in several of these shapes. */
function collectErrorCodes(top: Record<string, unknown>): string[] {
  const codes: string[] = []
  if (typeof top['errorCode'] === 'string') codes.push(top['errorCode'])
  const errors = top['errors']
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (!e || typeof e !== 'object') continue
      const obj = e as Record<string, unknown>
      if (typeof obj['errorCode'] === 'string') codes.push(obj['errorCode'])
      if (typeof obj['code'] === 'string') codes.push(obj['code'])
      const ext = obj['extensions']
      if (ext && typeof ext === 'object' && typeof (ext as Record<string, unknown>)['code'] === 'string') {
        codes.push((ext as Record<string, unknown>)['code'] as string)
      }
    }
  }
  return codes
}

function parseTransactionPage(json: unknown): TransactionPage {
  const top = json as Record<string, unknown>

  // CK signals errors via a top-level `errorCode` and/or a GraphQL `errors`
  // array. Only auth-shaped codes mean "refresh the token" — map those to
  // TOKEN_EXPIRED. Every other GraphQL error (schema drift, validation, server
  // fault) is surfaced verbatim (redacted) so the user sees the real problem
  // instead of a misleading "token expired" after a wasted refresh + retry.
  if (top['errorCode'] || top['errors']) {
    const codes = collectErrorCodes(top)
    if (codes.some(c => AUTH_ERROR_CODE.test(c))) throw new Error('TOKEN_EXPIRED')
    const payload = truncateErrorMessage(JSON.stringify(top['errors'] ?? top['errorCode']), 300).trim()
    throw new Error(`GraphQL error: ${payload}`)
  }

  // Schema drift: a 200 with a well-formed but unexpected shape. Name the
  // missing node so the failure is diagnosable, rather than letting a blind
  // cast NPE downstream in sync.ts. Not an auth failure — do NOT refresh.
  const data = top['data']
  if (!data || typeof data !== 'object') {
    throw new Error('GraphQL response missing `data` (schema drift or unexpected response)')
  }
  const prime = (data as Record<string, unknown>)['prime']
  if (!prime || typeof prime !== 'object') {
    throw new Error('GraphQL response missing `data.prime` (schema drift or unexpected response)')
  }
  const hub = (prime as Record<string, unknown>)['transactionsHub']
  if (!hub || typeof hub !== 'object') {
    throw new Error('GraphQL response missing `data.prime.transactionsHub` (schema drift)')
  }
  const transactionPage = (hub as Record<string, unknown>)['transactionPage']
  if (!transactionPage || typeof transactionPage !== 'object') {
    throw new Error('GraphQL response missing `data.prime.transactionsHub.transactionPage` (schema drift)')
  }
  return transactionPage as TransactionPage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Read a response body, degrading to '' on any failure (broken stream, or a
 *  stubbed Response without `.text`). Split out from {@link httpErrorMessage}
 *  because `fetchPage` needs the body BEFORE it knows whether this is a
 *  retryable gateway blip or a real error — and a body can only be read once. */
async function readBodyOrEmpty(res: Response): Promise<string> {
  try {
    return typeof res.text === 'function' ? await res.text() : ''
  } catch {
    return ''
  }
}

/**
 * Credit Karma's GraphQL gateway intermittently rejects well-formed requests
 * with `HTTP 400 {"message":"No query found"}`.
 *
 * Measured 2026-08-01 against a live account, this is NOT about the request:
 * a 25-byte `query Ping { __typename }` fails at the same rate as the 98KB
 * transaction query, ad-hoc queries execute fine (so the gateway is not
 * persisted-query-only, despite the APQ-flavoured wording), and neither the
 * `ck-*` client headers, session/Akamai cookies, nor request pacing moved the
 * needle. Successes and failures both reach the origin with identical headers
 * apart from `connection: close` on the failure. From the client's side it is
 * simply non-deterministic, so the only available mitigation is to retry.
 *
 * Matched narrowly — status AND the exact `message` value — so a genuine 400
 * (syntax error, schema drift) is never silently retried. The regex requires
 * the phrase to be the `message` field's value rather than incidental text
 * elsewhere in some other payload.
 */
export function isNoQueryFound(status: number, body: string): boolean {
  return status === 400 && /"message"\s*:\s*"No query found"/.test(body)
}

/**
 * Throw {@link EdgeBlockedError} when a non-2xx response is a CDN/WAF refusal
 * page rather than Credit Karma's own answer (chrischall/mcp-host#1015). The
 * healthcheck reports that as `edge_blocked`, not a rejected credential.
 */
function throwIfEdgeBlocked(res: Response, body: string, method: string, path: string): void {
  const edge = detectEdgeBlock({ body, headers: res.headers, status: res.status })
  if (edge) throw new EdgeBlockedError(res.status, edge.vendor, { service: 'creditkarma.com', method, path })
}

/**
 * Build an `HTTP <status>: <body>` error message for a failed GraphQL response,
 * attaching the upstream body (redacted + length-capped via mcp-utils'
 * `truncateErrorMessage`) so failures are debuggable instead of a bare status.
 * Falls back to just the status when the body is empty or unreadable.
 */
function httpErrorMessage(status: number, body: string): string {
  const safe = truncateErrorMessage(body, 200).trim()
  return safe.length > 0 ? `HTTP ${status}: ${safe}` : `HTTP ${status}`
}
