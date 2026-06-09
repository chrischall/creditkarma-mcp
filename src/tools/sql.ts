import { z } from 'zod'
import { textResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppContext } from '../index.js'

export interface QuerySqlArgs {
  sql: string
}

export interface QuerySqlResult {
  rows: Record<string, unknown>[]
  count: number
}

export async function handleQuerySql(args: QuerySqlArgs, ctx: AppContext): Promise<QuerySqlResult> {
  const trimmed = args.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim()

  // WITH is allowed so CTE-shaped reads (`WITH x AS (...) SELECT ...`) work.
  // The regex alone can't prove a WITH-prefixed statement is read-only
  // (`WITH ... INSERT` is valid SQLite), so execution below runs under
  // `PRAGMA query_only`, which makes any write fail with SQLITE_READONLY.
  if (!/^(WITH|SELECT)\b/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed. (WITH ... SELECT CTEs are also permitted.)')
  }

  ctx.db.exec('PRAGMA query_only = 1')
  try {
    const rows = ctx.db.prepare(args.sql).all() as Record<string, unknown>[]
    return { rows, count: rows.length }
  } finally {
    // ctx.db is shared with the sync tools — restore write access.
    ctx.db.exec('PRAGMA query_only = 0')
  }
}

export function registerSqlTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_query_sql',
    {
      description:
        'Execute a raw SQL SELECT query (CTEs via WITH ... SELECT are supported) against the transactions database. ' +
        'Non-SELECT statements (INSERT, UPDATE, DELETE, DROP, etc.) are rejected. ' +
        'Tables: transactions, accounts, categories, merchants, sync_state.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sql: z.string().describe('A SELECT SQL statement'),
      },
    },
    async (args) => {
      const result = await handleQuerySql(args, ctx)
      return textResult(result)
    }
  )
}
