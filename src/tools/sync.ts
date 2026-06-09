import { z } from 'zod'
import { textResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppContext } from '../index.js'
import {
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState
} from '../db.js'
import { deriveAccountId } from '../accountId.js'
import { loadAuthIntoClient } from '../auth.js'

export interface SyncArgs {
  force_full?: boolean
}

export interface SyncResult {
  new: number
  updated: number
  total: number
  /** Set only when the page loop terminated on a safety guard rather than
   *  reaching the end of the data — surfaces a clear outcome instead of
   *  silently truncating or looping forever.
   *  - `cursor_stuck`: CK returned hasNextPage:true with a non-advancing cursor.
   *  - `page_cap`: hit MAX_SYNC_PAGES; more data may remain. */
  stopped?: 'cursor_stuck' | 'page_cap'
}

/** Hard ceiling on pages fetched in a single sync. CK pages are ~50–100 txns,
 *  so a few hundred pages covers years of history. The cap exists to bound a
 *  runaway loop (corrupted cursor, server bug), not to limit legitimate syncs. */
export const MAX_SYNC_PAGES = 300

export async function handleSyncTransactions(
  args: SyncArgs,
  ctx: AppContext
): Promise<SyncResult> {
  // Auto-refresh if token expired and we have a refresh token
  if (ctx.client.isTokenExpired() || !ctx.client.getToken()) {
    await refreshOrThrow(ctx)
  }

  const today = utcDateString(new Date())
  const lastSyncDate = getSyncState(ctx.db, 'last_sync_date')

  // Cutoff: stop fetching pages when tx.date < (lastSyncDate - 30 days)
  // Unless force_full=true or no prior sync
  const cutoffDate = (!args.force_full && lastSyncDate)
    ? subtractDays(lastSyncDate, 30)
    : null

  // For force_full, always start from the beginning (ignore any saved resume cursor)
  let cursor: string | undefined = args.force_full
    ? undefined
    : (getSyncState(ctx.db, 'last_cursor') ?? undefined)

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
    // Cap: never loop unboundedly. Surface a clear "stopped at cap" outcome and
    // leave last_cursor checkpointed below so a follow-up sync can resume.
    if (pageCount >= MAX_SYNC_PAGES) {
      stopped = 'page_cap'
      // Reaching the cap means we paged MAX_SYNC_PAGES times, each advancing the
      // cursor (a non-advancing cursor trips `cursor_stuck` first), so `cursor`
      // is always a real resume point here. Checkpoint it for the next run.
      setSyncState(ctx.db, 'last_cursor', cursor!)
      break
    }
    pageCount++

    let page
    try {
      page = await ctx.client.fetchPage(cursor)
    } catch (err) {
      if (err instanceof Error && err.message === 'TOKEN_EXPIRED') {
        // JWT may have expired mid-sync — try refresh once then retry page
        try {
          await refreshOrThrow(ctx)
          page = await ctx.client.fetchPage(cursor)
        } catch (retryErr) {
          if (cursor) setSyncState(ctx.db, 'last_cursor', cursor)
          throw retryErr
        }
      } else {
        if (cursor) setSyncState(ctx.db, 'last_cursor', cursor)
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
    ctx.db.prepare("DELETE FROM sync_state WHERE key = 'last_cursor'").run()
  } else if (stopped === 'cursor_stuck') {
    // A stuck cursor is not a clean finish — checkpoint it so a later sync can
    // retry from the same point (the page_cap path already checkpointed above).
    setSyncState(ctx.db, 'last_cursor', cursor!)
  }

  return { new: newCount, updated: updatedCount, total: totalCount, ...(stopped ? { stopped } : {}) }
}

async function refreshOrThrow(ctx: AppContext): Promise<void> {
  // No cached refresh token → either CK_COOKIES wasn't set at startup AND
  // ck_set_session was never called, OR the user is on the fetchproxy path
  // and we need to lift the session out of the browser. Either way, defer
  // to loadAuthIntoClient() — it picks env-var (fast, no network) or
  // fetchproxy (one-shot WS bridge) and applies the result to the client.
  //
  // Any throw from there is already shaped as a TOKEN_EXPIRED-style
  // actionable message ("CK auth: set CK_COOKIES, ...") so we let it bubble.
  if (!ctx.client.getRefreshToken()) {
    await loadAuthIntoClient(ctx.client)
  }
  // We may have just loaded a token via fetchproxy (in which case the access
  // JWT inside CKAT could already be ~15-min stale) — refresh once to be sure.
  await ctx.client.refreshAccessToken()
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
        'If no valid token, initiates the login/MFA flow automatically.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        force_full: z.boolean().optional().describe('If true, re-fetch all transactions from the beginning'),
      },
    },
    async (args) => {
      const result = await handleSyncTransactions(args, ctx)
      return textResult(result)
    }
  )
}
