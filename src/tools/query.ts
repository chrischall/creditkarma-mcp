import type { AppContext } from '../index.js'
import type { Database } from '../db.js'

// ---------------------------------------------------------------------------
// Shared query row type
// ---------------------------------------------------------------------------

export interface QueryTransactionRow {
  id: string
  date: string
  description: string
  status: string
  amount: number
  account: string
  category: string
  merchant: string
}

export interface ListResult {
  transactions: QueryTransactionRow[]
  total: number
  offset: number
  limit: number
}

// ---------------------------------------------------------------------------
// ck_list_transactions
// ---------------------------------------------------------------------------

export interface ListFilters {
  start_date?: string
  end_date?: string
  account?: string
  category?: string
  merchant?: string
  status?: string
  min_amount?: number
  max_amount?: number
  limit?: number
  offset?: number
}

export async function handleListTransactions(args: ListFilters, ctx: AppContext): Promise<ListResult> {
  return queryTransactions(ctx.db, args)
}

function queryTransactions(db: Database, filters: ListFilters): ListResult {
  const { where, params } = buildWhere(filters)
  const limit = filters.limit ?? 50
  const offset = filters.offset ?? 0

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
  `).get(...params) as { count: number }

  const rows = db.prepare(`
    SELECT t.id, t.date, t.description, t.status, t.amount,
           COALESCE(a.name, '') as account,
           COALESCE(c.name, '') as category,
           COALESCE(m.name, '') as merchant
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
    ORDER BY t.date DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as QueryTransactionRow[]

  return { transactions: rows, total: countRow.count, offset, limit }
}

function buildWhere(filters: ListFilters): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.start_date) { conditions.push('t.date >= ?'); params.push(filters.start_date) }
  if (filters.end_date) { conditions.push('t.date <= ?'); params.push(filters.end_date) }
  if (filters.account) { conditions.push('a.name LIKE ?'); params.push(`%${filters.account}%`) }
  if (filters.category) { conditions.push('c.name LIKE ?'); params.push(`%${filters.category}%`) }
  if (filters.merchant) { conditions.push('m.name LIKE ?'); params.push(`%${filters.merchant}%`) }
  if (filters.status) { conditions.push('t.status = ?'); params.push(filters.status) }
  if (filters.min_amount != null) { conditions.push('ABS(t.amount) >= ?'); params.push(filters.min_amount) }
  if (filters.max_amount != null) { conditions.push('ABS(t.amount) <= ?'); params.push(filters.max_amount) }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

// ---------------------------------------------------------------------------
// ck_get_recent_transactions
// ---------------------------------------------------------------------------

export interface RecentArgs {
  limit?: number
}

export async function handleGetRecentTransactions(args: RecentArgs, ctx: AppContext): Promise<ListResult> {
  return queryTransactions(ctx.db, { limit: args.limit ?? 25, offset: 0 })
}

// ---------------------------------------------------------------------------
// Stubs for aggregate tools (implemented in Task 10)
// ---------------------------------------------------------------------------

export interface SpendingByCategoryArgs {
  start_date?: string
  end_date?: string
  account?: string
}
export interface SpendingByCategoryResult {
  rows: Array<{ category: string; total: number; count: number }>
}
export async function handleGetSpendingByCategory(_args: SpendingByCategoryArgs, _ctx: AppContext): Promise<SpendingByCategoryResult> {
  throw new Error('Not implemented yet')
}

export interface SpendingByMerchantArgs {
  start_date?: string
  end_date?: string
  category?: string
  limit?: number
}
export interface SpendingByMerchantResult {
  rows: Array<{ merchant: string; total: number; count: number }>
}
export async function handleGetSpendingByMerchant(_args: SpendingByMerchantArgs, _ctx: AppContext): Promise<SpendingByMerchantResult> {
  throw new Error('Not implemented yet')
}

export interface AccountSummaryArgs {
  start_date?: string
  end_date?: string
}
export interface AccountSummaryResult {
  rows: Array<{ account: string; debits: number; credits: number; net: number; count: number }>
}
export async function handleGetAccountSummary(_args: AccountSummaryArgs, _ctx: AppContext): Promise<AccountSummaryResult> {
  throw new Error('Not implemented yet')
}
