import type { AppContext } from '../index.js'

export interface QuerySqlArgs {
  sql: string
}

export interface QuerySqlResult {
  rows: Record<string, unknown>[]
  count: number
}

export async function handleQuerySql(args: QuerySqlArgs, ctx: AppContext): Promise<QuerySqlResult> {
  const trimmed = args.sql.replace(/--[^\n]*/g, '').trim()

  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed.')
  }

  const rows = ctx.db.prepare(args.sql).all() as Record<string, unknown>[]
  return { rows, count: rows.length }
}

export const sqlToolDefinitions = [
  {
    name: 'ck_query_sql',
    description:
      'Execute a raw SQL SELECT query against the transactions database. ' +
      'Non-SELECT statements (INSERT, UPDATE, DELETE, DROP, etc.) are rejected. ' +
      'Tables: transactions, accounts, categories, merchants, sync_state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A SELECT SQL statement' }
      },
      required: ['sql']
    }
  }
]
