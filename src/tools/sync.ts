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
  // Auto-trigger login if no valid token
  if (ctx.client.isTokenExpired()) {
    const username = process.env.CK_USERNAME
    const password = process.env.CK_PASSWORD
    if (!username || !password) {
      throw new Error(
        'TOKEN_EXPIRED: No valid token. Call ck_login or ck_set_token first, ' +
        'or set CK_USERNAME and CK_PASSWORD env vars for auto-login.'
      )
    }
    await ctx.client.login(username, password)
    return (
      'MFA challenge initiated. Check your phone/email and call ck_submit_mfa ' +
      'with your code, then re-run ck_sync_transactions.'
    )
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
      // Save cursor so we can resume on next attempt
      if (cursor) setSyncState(ctx.db, 'last_cursor', cursor)
      throw err
    }

    ctx.db.transaction(() => {
      for (const tx of page.transactions) {
        const exists = ctx.db
          .prepare('SELECT id FROM transactions WHERE id = ?')
          .get(tx.id)

        upsertAccount(ctx.db, {
          id: tx.account.id, name: tx.account.name, type: tx.account.type,
          providerName: tx.account.providerName, display: tx.account.accountTypeAndNumberDisplay
        })
        upsertCategory(ctx.db, { id: tx.category.id, name: tx.category.name, type: tx.category.type })
        upsertMerchant(ctx.db, { id: tx.merchant.id, name: tx.merchant.name })
        upsertTransaction(ctx.db, {
          id: tx.id, date: tx.date, description: tx.description, status: tx.status,
          amount: tx.amount.value, accountId: tx.account.id, categoryId: tx.category.id,
          merchantId: tx.merchant.id, rawJson: JSON.stringify(tx)
        })

        if (exists) { updatedCount++ } else { newCount++ }
        totalCount++
      }
    })()

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


export const syncToolDefinitions = [
  {
    name: 'ck_sync_transactions',
    description:
      'Sync Credit Karma transactions into the local SQLite database. ' +
      'Incremental by default (fetches since last sync + 30-day overlap for updates). ' +
      'If no valid token, initiates the login/MFA flow automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        force_full: {
          type: 'boolean',
          description: 'If true, re-fetch all transactions from the beginning'
        }
      }
    }
  }
]
