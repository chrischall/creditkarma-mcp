import { z } from 'zod'
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

  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed.')
  }

  const rows = ctx.db.prepare(args.sql).all() as Record<string, unknown>[]
  return { rows, count: rows.length }
}

export function registerSqlTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_query_sql',
    {
      description:
        'Execute a raw SQL SELECT query against the transactions database. ' +
        'Non-SELECT statements (INSERT, UPDATE, DELETE, DROP, etc.) are rejected. ' +
        'Tables: transactions, accounts, categories, merchants, sync_state.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sql: z.string().describe('A SELECT SQL statement'),
      },
    },
    async (args) => {
      const result = await handleQuerySql(args, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )
}
