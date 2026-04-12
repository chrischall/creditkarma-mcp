import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppContext } from '../index.js'
import {
  upsertAccount, upsertCategory, upsertMerchant, upsertTransaction,
  getSyncState, setSyncState
} from '../db.js'

export interface SyncArgs {
  force_full?: boolean
}

export interface SyncResult {
  new: number
  updated: number
  total: number
}

export async function handleSyncTransactions(
  args: SyncArgs,
  ctx: AppContext
): Promise<SyncResult | string> {
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

  while (!done) {
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

        upsertAccount(ctx.db, {
          id: tx.account.id, name: tx.account.name, type: tx.account.type,
          providerName: tx.account.providerName, display: tx.account.accountTypeAndNumberDisplay
        })
        if (tx.category) upsertCategory(ctx.db, { id: tx.category.id, name: tx.category.name, type: tx.category.type })
        if (tx.merchant) upsertMerchant(ctx.db, { id: tx.merchant.id, name: tx.merchant.name })
        upsertTransaction(ctx.db, {
          id: tx.id, date: tx.date, description: tx.description, status: tx.status,
          amount: tx.amount.value, accountId: tx.account.id,
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
    cursor = page.pageInfo.endCursor
  }

  setSyncState(ctx.db, 'last_sync_date', today)
  // Clear resume cursor on success
  ctx.db.prepare("DELETE FROM sync_state WHERE key = 'last_cursor'").run()

  return { new: newCount, updated: updatedCount, total: totalCount }
}

async function refreshOrThrow(ctx: AppContext): Promise<void> {
  if (!ctx.client.getRefreshToken()) {
    throw new Error('TOKEN_EXPIRED: No valid token. Call ck_set_session with your CKAT cookie to authenticate.')
  }
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
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { content: [{ type: 'text', text }] }
    }
  )
}
