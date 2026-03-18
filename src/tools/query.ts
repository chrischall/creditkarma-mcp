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

function buildWhere(filters: ListFilters): { where: string; params: (string | number)[] } {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filters.start_date) { conditions.push('t.date >= ?'); params.push(filters.start_date) }
  if (filters.end_date) { conditions.push('t.date <= ?'); params.push(filters.end_date) }
  if (filters.account) { conditions.push('a.name LIKE ? ESCAPE \'\\\''); params.push(`%${filters.account.replace(/[%_\\]/g, '\\$&')}%`) }
  if (filters.category) { conditions.push('c.name LIKE ? ESCAPE \'\\\''); params.push(`%${filters.category.replace(/[%_\\]/g, '\\$&')}%`) }
  if (filters.merchant) { conditions.push('m.name LIKE ? ESCAPE \'\\\''); params.push(`%${filters.merchant.replace(/[%_\\]/g, '\\$&')}%`) }
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
// ck_get_spending_by_category
// ---------------------------------------------------------------------------

export interface SpendingByCategoryArgs {
  start_date?: string
  end_date?: string
  account?: string
}

export interface SpendingByCategoryResult {
  rows: Array<{ category: string; total: number; count: number }>
}

export async function handleGetSpendingByCategory(
  args: SpendingByCategoryArgs,
  ctx: AppContext
): Promise<SpendingByCategoryResult> {
  const conditions: string[] = ['t.amount < 0']  // debits only
  const params: (string | number)[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }
  if (args.account) { conditions.push('a.name LIKE ? ESCAPE \'\\\''); params.push(`%${args.account.replace(/[%_\\]/g, '\\$&')}%`) }

  const where = `WHERE ${conditions.join(' AND ')}`

  const rows = ctx.db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorized') as category,
           SUM(ABS(t.amount)) as total,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    ${where}
    GROUP BY c.id, c.name
    ORDER BY total DESC
  `).all(...params) as Array<{ category: string; total: number; count: number }>

  return { rows }
}

// ---------------------------------------------------------------------------
// ck_get_spending_by_merchant
// ---------------------------------------------------------------------------

export interface SpendingByMerchantArgs {
  start_date?: string
  end_date?: string
  category?: string
  limit?: number
}

export interface SpendingByMerchantResult {
  rows: Array<{ merchant: string; total: number; count: number }>
}

export async function handleGetSpendingByMerchant(
  args: SpendingByMerchantArgs,
  ctx: AppContext
): Promise<SpendingByMerchantResult> {
  const conditions: string[] = ['t.amount < 0']
  const params: (string | number)[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }
  if (args.category) { conditions.push('c.name LIKE ? ESCAPE \'\\\''); params.push(`%${args.category.replace(/[%_\\]/g, '\\$&')}%`) }

  const where = `WHERE ${conditions.join(' AND ')}`
  const limit = args.limit ?? 25

  const rows = ctx.db.prepare(`
    SELECT COALESCE(m.name, 'Unknown') as merchant,
           SUM(ABS(t.amount)) as total,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    ${where}
    GROUP BY m.id, m.name
    ORDER BY total DESC
    LIMIT ?
  `).all(...params, limit) as Array<{ merchant: string; total: number; count: number }>

  return { rows }
}

// ---------------------------------------------------------------------------
// ck_get_account_summary
// ---------------------------------------------------------------------------

export interface AccountSummaryArgs {
  start_date?: string
  end_date?: string
}

export interface AccountSummaryResult {
  rows: Array<{ account: string; debits: number; credits: number; net: number; count: number }>
}

export async function handleGetAccountSummary(
  args: AccountSummaryArgs,
  ctx: AppContext
): Promise<AccountSummaryResult> {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (args.start_date) { conditions.push('t.date >= ?'); params.push(args.start_date) }
  if (args.end_date) { conditions.push('t.date <= ?'); params.push(args.end_date) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = ctx.db.prepare(`
    SELECT COALESCE(a.name, 'Unknown') as account,
           SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as debits,
           SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as credits,
           SUM(t.amount) as net,
           COUNT(*) as count
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    ${where}
    GROUP BY a.id, a.name
    ORDER BY debits DESC
  `).all(...params) as Array<{ account: string; debits: number; credits: number; net: number; count: number }>

  return { rows }
}

// ---------------------------------------------------------------------------
// Tool definitions for all 5 query tools
// ---------------------------------------------------------------------------

export const queryToolDefinitions = [
  {
    name: 'ck_list_transactions',
    description: 'List transactions with optional filters. Paginated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string', description: 'Partial account name match' },
        category: { type: 'string', description: 'Partial category name match' },
        merchant: { type: 'string', description: 'Partial merchant name match' },
        status: { type: 'string', description: 'e.g. posted, pending, cancelled' },
        min_amount: { type: 'number', description: 'Minimum absolute amount' },
        max_amount: { type: 'number', description: 'Maximum absolute amount' },
        limit: { type: 'number', description: 'Default 50' },
        offset: { type: 'number', description: 'Default 0' }
      }
    }
  },
  {
    name: 'ck_get_recent_transactions',
    description: 'Return the N most recent transactions. Convenience shortcut for ck_list_transactions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Number of transactions to return (default 25)' }
      }
    }
  },
  {
    name: 'ck_get_spending_by_category',
    description: 'Group debit transactions by category and return totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        account: { type: 'string', description: 'Partial account name filter' }
      }
    }
  },
  {
    name: 'ck_get_spending_by_merchant',
    description: 'Return top merchants by total debit spend.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        category: { type: 'string', description: 'Partial category name filter' },
        limit: { type: 'number', description: 'Default 25' }
      }
    }
  },
  {
    name: 'ck_get_account_summary',
    description: 'Return per-account debit, credit, and net totals.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' }
      }
    }
  }
]
