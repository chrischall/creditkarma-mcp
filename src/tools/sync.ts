import { z } from 'zod'
import { minifiedResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import {
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState
} from '../db.js'
import { deriveAccountId } from '../accountId.js'
import { loadAuthIntoClient } from '../auth.js'
import { isJwtExpired } from '../client.js'
import { isCkAuthError } from '../authError.js'

export interface SyncArgs {
  force_full?: boolean
  /**
   * Pages this call may fetch before pausing. Overrides `CK_SYNC_MAX_PAGES`.
   * Absent with no env var = unbounded, i.e. exactly the behaviour a local
   * stdio server has always had.
   */
  max_pages?: number
}

export interface SyncResult {
  new: number
  updated: number
  total: number
  /** Pages fetched by THIS call. */
  pages_fetched: number
  /**
   * True when this sync paused with more to fetch AND running it again will
   * make progress. The caller's cue to loop: the resume cursor is checkpointed,
   * so the next call continues rather than starting over.
   *
   * Deliberately FALSE for `cursor_stuck`, which is the one pause where an
   * immediate retry cannot help — Credit Karma handed back the same cursor it
   * was given, so the next call replays the same page and the one after that
   * does it again. A headless caller looping on this flag would hammer the
   * endpoint, which is the behaviour the stuck-cursor guard exists to prevent.
   * The `stopped` field says what happened; a LATER run may well get past it.
   */
  another_run_needed: boolean
  /** A sentence naming what happened and, when relevant, what to do next. */
  note: string
  /** Set only when the page loop terminated on a safety guard rather than
   *  reaching the end of the data — surfaces a clear outcome instead of
   *  silently truncating or looping forever.
   *  - `cursor_stuck`: CK returned hasNextPage:true with a non-advancing cursor.
   *  - `max_pages`: spent this call's page budget; more data remains.
   *  - `page_cap`: hit MAX_SYNC_PAGES; more data may remain. */
  stopped?: 'cursor_stuck' | 'page_cap' | 'max_pages'
}

/** Hard ceiling on pages fetched in a single sync. CK pages are ~50–100 txns,
 *  so a few hundred pages covers years of history. The cap exists to bound a
 *  runaway loop (corrupted cursor, server bug), not to limit legitimate syncs. */
export const MAX_SYNC_PAGES = 300

/**
 * Pages one call may fetch before pausing, from `CK_SYNC_MAX_PAGES`.
 *
 * A deep backfill is hundreds of pages and minutes of work. Locally that is
 * fine — an stdio server has as long as it likes. HOSTED it is not: the call
 * has to answer inside the client's request timeout, and a sync that runs past
 * it is reported as a failure however much data it actually banked.
 *
 * So the walk becomes bounded and resumable, which is the shape the rest of
 * the fleet already uses for this (`OFW_SYNC_MAX_REQUESTS` in ofw-mcp;
 * `max_pages` in untappd-mcp's `untappd_sync_user_beers`). Deliberately NOT a
 * background job with a status to poll: on a scale-to-zero machine the child
 * is idled out from under a background walk, whereas every bounded call is
 * complete in itself and the SQLite file IS the resume state.
 *
 * Unset — or set to anything that is not a usable page count — means
 * unbounded, so a local stdio sync behaves exactly as it always has. A typo
 * must never turn "sync" into "fetch nothing and report success".
 */
export function envMaxPages(): number | undefined {
  const raw = process.env.CK_SYNC_MAX_PAGES
  if (raw === undefined || raw.trim() === '') return undefined
  if (!/^\d+$/.test(raw.trim())) return undefined
  const pages = Number(raw.trim())
  return Number.isInteger(pages) && pages > 0 ? pages : undefined
}

/**
 * Record where a paused sync should resume.
 *
 * One helper for all three pause paths (budget, runaway cap, stuck cursor)
 * because they share a rule that is easy to get wrong in one of them: an EMPTY
 * cursor is not a resume point. Written, `''` reads back as a cursor and
 * resumes from nowhere; skipped, the next run starts from the last real
 * checkpoint and the upserts are idempotent anyway.
 *
 * `paused` is true only for a DELIBERATE pause (max_pages / page_cap), where
 * every page so far advanced cleanly and the cursor is known-good. A failed
 * fetch or a stuck cursor also checkpoints (so a plain retry picks up where it
 * died), but that cursor may be the very thing CK is rejecting, so force_full
 * must not resume it: force_full is the only escape from a poisoned cursor.
 */
function checkpoint(
  db: AppContext['db'],
  cursor: string | undefined,
  mode: ResumeMode,
  paused: boolean,
): void {
  if (!cursor) return
  setSyncState(db, 'last_cursor', cursor)
  setSyncState(db, 'resume_mode', mode)
  if (paused) setSyncState(db, 'resume_paused', '1')
  else db.prepare("DELETE FROM sync_state WHERE key = 'resume_paused'").run()
}

/**
 * What kind of walk a saved `last_cursor` belongs to, stored beside it as
 * `resume_mode` (fleet-audit#68).
 *
 * The cursor alone is not enough to resume correctly. A `full` walk (force_full,
 * or a first-ever sync) has no date cutoff; an `incremental` one stops at
 * last_sync_date - 30 days. Resuming a paused full backfill with the
 * incremental cutoff recomputed from an OLDER completed sync stopped after one
 * deep page, whose dates are years below the cutoff, then stamped
 * last_sync_date and cleared the cursor, reporting "up to date" with the rest
 * of the history never fetched. And a repeated force_full used to ignore the
 * checkpoint entirely, re-fetching the same first N pages forever. So the mode
 * is persisted with the cursor, a resume reuses it, and force_full honours a
 * `full` checkpoint left by a deliberate pause (`resume_paused`) instead of
 * restarting. Any other checkpoint (failed fetch, stuck cursor) is one
 * force_full restarts from page 1, so it stays the escape hatch.
 */
type ResumeMode = 'full' | 'incremental'

export async function handleSyncTransactions(
  args: SyncArgs,
  ctx: AppContext
): Promise<SyncResult> {
  // Auto-refresh if token expired and we have a refresh token
  if (ctx.client.isTokenExpired() || !ctx.client.getToken()) {
    await refreshOrThrow(ctx)
  }

  // An explicit argument is a decision the caller made for this call and beats
  // the deployment's default, the same precedence every other budget in the
  // fleet uses.
  const budget = args.max_pages !== undefined && Number.isInteger(args.max_pages) && args.max_pages > 0
    ? args.max_pages
    : envMaxPages()

  const today = utcDateString(new Date())
  const lastSyncDate = getSyncState(ctx.db, 'last_sync_date')

  const savedCursor = getSyncState(ctx.db, 'last_cursor') ?? undefined
  // A full-mode checkpoint (from any stop) is resumed by a plain call without
  // the incremental cutoff. A repeated force_full resumes it too, but ONLY when
  // it came from a deliberate pause — see checkpoint() and ResumeMode.
  const fullCheckpoint = savedCursor !== undefined && getSyncState(ctx.db, 'resume_mode') === 'full'
  const pausedBackfill = fullCheckpoint && getSyncState(ctx.db, 'resume_paused') === '1'

  // Cutoff: stop fetching pages when tx.date < (lastSyncDate - 30 days)
  // Unless force_full=true, no prior sync, or we are finishing a full backfill.
  const cutoffDate = (!args.force_full && !fullCheckpoint && lastSyncDate)
    ? subtractDays(lastSyncDate, 30)
    : null
  const mode: ResumeMode = cutoffDate ? 'incremental' : 'full'

  // force_full starts from the beginning unless a paused full backfill is
  // part-way through; an incremental checkpoint, or one left by a failure,
  // is not one to continue.
  let cursor: string | undefined = args.force_full && !pausedBackfill
    ? undefined
    : savedCursor

  let newCount = 0
  let updatedCount = 0
  let totalCount = 0
  let done = false
  let stopped: SyncResult['stopped']
  let pageCount = 0
  // The cursor used for the request that produced the current page. Tracked so
  // we can detect a non-advancing cursor (CK returning hasNextPage:true but the
  // same endCursor, or a corrupted resume cursor replaying the same page) and
  // bail instead of hammering the endpoint forever.
  let prevCursor: string | undefined = cursor

  while (!done) {
    // This call's budget, when it has one. Distinct from MAX_SYNC_PAGES below:
    // that is a runaway guard against a broken cursor, this is a deliberate
    // pause with more data known to remain.
    if (budget !== undefined && pageCount >= budget) {
      stopped = 'max_pages'
      // `cursor` is the next page to fetch, so checkpointing it here is what
      // makes "run it again" true rather than advice.
      checkpoint(ctx.db, cursor, mode, true)
      break
    }
    // Cap: never loop unboundedly. Surface a clear "stopped at cap" outcome and
    // leave last_cursor checkpointed below so a follow-up sync can resume.
    if (pageCount >= MAX_SYNC_PAGES) {
      stopped = 'page_cap'
      // Reaching the cap means every page advanced the cursor (a non-advancing
      // one trips `cursor_stuck` first), so this is always a real resume point.
      checkpoint(ctx.db, cursor, mode, true)
      break
    }
    pageCount++

    let page
    try {
      page = await ctx.client.fetchPage(cursor)
    } catch (err) {
      if (err instanceof Error && err.message === 'TOKEN_EXPIRED') {
        // CK rejected the token mid-sync, so it is dead regardless of what its
        // `exp` says — refresh unconditionally here, then retry the page.
        try {
          await refreshOrThrow(ctx, true)
          page = await ctx.client.fetchPage(cursor)
        } catch (retryErr) {
          checkpoint(ctx.db, cursor, mode, false)
          throw retryErr
        }
      } else {
        checkpoint(ctx.db, cursor, mode, false)
        throw err
      }
    }

    ctx.db.exec('BEGIN')
    try {
      for (const tx of page.transactions) {
        const exists = ctx.db
          .prepare('SELECT id FROM transactions WHERE id = ?')
          .get(tx.id)

        const accountId = deriveAccountId(tx.account)
        upsertAccount(ctx.db, {
          id: accountId, name: tx.account.name, type: tx.account.type,
          providerName: tx.account.providerName, display: tx.account.accountTypeAndNumberDisplay
        })
        if (tx.category) upsertCategory(ctx.db, { id: tx.category.id, name: tx.category.name, type: tx.category.type })
        if (tx.merchant) upsertMerchant(ctx.db, { id: tx.merchant.id, name: tx.merchant.name })
        upsertTransaction(ctx.db, {
          id: tx.id, date: tx.date, description: tx.description, status: tx.status,
          amount: tx.amount.value, accountId,
          categoryId: tx.category?.id ?? null,
          merchantId: tx.merchant?.id ?? null,
          rawJson: JSON.stringify(tx)
        })

        if (exists) { updatedCount++ } else { newCount++ }
        totalCount++
      }
      ctx.db.exec('COMMIT')
    } catch (err) {
      ctx.db.exec('ROLLBACK')
      throw err
    }

    // Stop if we've reached older-than-cutoff transactions
    if (cutoffDate && page.transactions.length > 0) {
      const oldestDate = page.transactions[page.transactions.length - 1].date
      if (oldestDate < cutoffDate) done = true
    }

    if (!page.pageInfo.hasNextPage) done = true

    const nextCursor = page.pageInfo.endCursor
    // Non-advancing cursor: CK says there's more but the endCursor matches the
    // cursor we just paged from (or the cursor never moves). Following it would
    // replay the same page forever. Bail with a clear outcome.
    if (!done && nextCursor === prevCursor) {
      stopped = 'cursor_stuck'
      done = true
    }
    cursor = nextCursor
    prevCursor = nextCursor
  }

  // A capped or stuck sync is intentionally incomplete — keep last_cursor (the
  // cap path already checkpointed it) so the next run resumes. Only a fully
  // drained sync advances last_sync_date and clears the resume cursor.
  if (!stopped) {
    setSyncState(ctx.db, 'last_sync_date', today)
    // Clear resume cursor on success
    ctx.db.prepare("DELETE FROM sync_state WHERE key IN ('last_cursor', 'resume_mode', 'resume_paused')").run()
  } else if (stopped === 'max_pages') {
    // Already checkpointed at the pause. Nothing else to do — and in
    // particular last_sync_date stays where it was, because a sync that did
    // not reach the end must not let the next incremental run start after data
    // it never fetched.
  } else if (stopped === 'cursor_stuck') {
    // A stuck cursor is not a clean finish — checkpoint it so a LATER sync can
    // retry from the same point (the page_cap path already checkpointed above).
    checkpoint(ctx.db, cursor, mode, false)
  }

  const anotherRunNeeded = stopped === 'max_pages' || stopped === 'page_cap'
  const note = anotherRunNeeded
    ? `Synced ${totalCount} transaction(s) over ${pageCount} page(s) and paused with more to fetch. ` +
      'Run ck_sync_transactions again to continue from where this left off.'
    : stopped === 'cursor_stuck'
      ? `Synced ${totalCount} transaction(s), then stopped: Credit Karma kept reporting more pages without advancing its cursor. ` +
        'This is a fault on their side, not a pause — the resume point is saved, but running the tool again ' +
        'right now replays the same page. Try again later.'
      : `Sync complete — ${totalCount} transaction(s) over ${pageCount} page(s); the local database is up to date.`

  return {
    new: newCount,
    updated: updatedCount,
    total: totalCount,
    pages_fetched: pageCount,
    another_run_needed: anotherRunNeeded,
    note,
    ...(stopped ? { stopped } : {}),
  }
}

async function refreshOrThrow(ctx: AppContext, tokenKnownDead = false): Promise<void> {
  // Go back to the browser (or env) for credentials when the ones we hold are
  // missing OR provably dead.
  //
  // The "provably dead" half is the fix for a bug that made a long-lived server
  // unrecoverable: CK's refresh JWT lives ~8 hours, but an MCP server process
  // lives for days. This used to re-read cookies only when the refresh token
  // was ABSENT, so once the cached one aged out, every sync POSTed the dead
  // token and failed with an HTML error page surfaced as "HTTP 400". Signing
  // back into creditkarma.com — which does put fresh cookies in the browser —
  // changed nothing, because the process never looked at them again. The only
  // cure was restarting the server, which is not a thing a user should have to
  // guess. Checking `exp` locally means a stale token costs one bootstrap
  // instead of a permanent outage.
  const cached = ctx.client.getRefreshToken()
  const reBootstrapped = !cached || isJwtExpired(cached)
  if (reBootstrapped) {
    await loadAuthIntoClient(ctx.client)
  }

  // Refresh ONLY when the access token is actually spent.
  //
  // This used to refresh unconditionally, "to be sure", on the reasoning that a
  // token just read from CKAT might already be stale. It might — but checking
  // is free, and refreshing when we didn't need to is not: every
  // /member/oauth2/refresh ROTATES CK's refresh token, which invalidates the
  // copy still sitting in the browser's CKAT cookie. The user then gets signed
  // out of creditkarma.com and told it was "inactivity" (#119). A server that
  // syncs on a schedule did that on every process start.
  //
  // `tokenKnownDead` is the reactive case: CK answered TOKEN_EXPIRED, so the
  // token is dead no matter what its `exp` claims and the check must not apply.
  // Proactively, `isTokenExpired()` reads the JWT's own `exp`, so a genuinely
  // stale cookie still refreshes — and a token that merely *looks* live but CK
  // rejects comes back through here with `tokenKnownDead` set.
  if (!tokenKnownDead && !ctx.client.isTokenExpired()) return

  try {
    await ctx.client.refreshAccessToken()
  } catch (err) {
    // The JWT's own `exp` looked fine but CK rejected it anyway — a revoked
    // session or a rotated device id. Fresh cookies may be sitting in the
    // browser right now, so lift them and try once more. Only once: if the
    // credentials we just read are also rejected, the user really does need to
    // sign in, and retrying would just re-prompt the extension in a loop.
    if (reBootstrapped || !isCkAuthError(err, 'session_rejected')) throw err
    // Name the token CK just refused, so resolution skips any local copy of it
    // (CK_COOKIES, the saved session) and reaches the browser instead of
    // handing the same dead token straight back (fleet-audit#69).
    await loadAuthIntoClient(ctx.client, { rejectedRefreshToken: cached })
    await ctx.client.refreshAccessToken()
  }
}

function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setUTCDate(d.getUTCDate() - days)
  return utcDateString(d)
}

/** Returns YYYY-MM-DD using UTC methods to avoid timezone-shift issues
 *  when the Date was constructed from an ISO date string (UTC midnight). */
function utcDateString(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function registerSyncTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_sync_transactions',
    {
      description:
        'Sync Credit Karma transactions into the local SQLite database. ' +
        'Incremental by default (fetches since last sync + 30-day overlap for updates). ' +
        'If no valid token, initiates the login/MFA flow automatically. ' +
        'Bounded and resumable: when it pauses with more to fetch it returns ' +
        'another_run_needed:true and a note — run it again and it continues from where it stopped.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        force_full: z.boolean().optional().describe(
          'If true, walk the whole history with no date cutoff. Starts from the beginning, ' +
            'except that it continues a full backfill paused by max_pages. Also the way to ' +
            'restart after a sync that failed or stopped on a stuck cursor.',
        ),
        max_pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Pages this call may fetch before pausing (a deep backfill is hundreds). ' +
              'Overrides CK_SYNC_MAX_PAGES. Omit both for an unbounded sync.',
          ),
      }),
    },
    async (args) => {
      const result = await handleSyncTransactions(args, ctx)
      return minifiedResult(result)
    }
  )
}
