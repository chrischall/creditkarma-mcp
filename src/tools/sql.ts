import { z } from 'zod'
import { minifiedResult } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'

/**
 * Rows one `ck_query_sql` call returns when the caller does not say otherwise.
 * Without a cap, `SELECT * FROM transactions` on a multi-year sync put the
 * user's entire financial history into a single tool result (fleet-audit#1157).
 */
export const DEFAULT_MAX_ROWS = 500
/** Ceiling on `max_rows`; page past it with LIMIT/OFFSET. */
export const MAX_ROWS_LIMIT = 5000

export interface QuerySqlArgs {
  sql: string
  /** Row cap for this call (default {@link DEFAULT_MAX_ROWS}, at most {@link MAX_ROWS_LIMIT}). */
  max_rows?: number
}

export interface QuerySqlResult {
  rows: Record<string, unknown>[]
  count: number
  /** True when the query produced more rows than were returned. */
  truncated: boolean
  /** How to see the rest; present only when `truncated`. */
  hint?: string
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
    const cap = Math.min(args.max_rows ?? DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT)
    // Stream rather than `.all()`: stop reading at cap + 1 (the extra row only
    // proves there is more) instead of materialising the whole result.
    const rows: Record<string, unknown>[] = []
    let truncated = false
    for (const row of ctx.db.prepare(args.sql).iterate()) {
      if (rows.length === cap) {
        truncated = true
        break
      }
      rows.push(row as Record<string, unknown>)
    }
    return truncated
      ? {
          rows,
          count: rows.length,
          truncated,
          hint:
            `Only the first ${cap} rows were returned. Aggregate in SQL (GROUP BY / SUM / COUNT), ` +
            `or page with LIMIT/OFFSET, or raise max_rows (up to ${MAX_ROWS_LIMIT}).`,
        }
      : { rows, count: rows.length, truncated }
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
        `Returns at most max_rows rows (default ${DEFAULT_MAX_ROWS}, max ${MAX_ROWS_LIMIT}); a larger result comes back with truncated: true, so prefer aggregates or LIMIT/OFFSET paging. ` +
        'Tables: transactions, accounts, categories, merchants, sync_state.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sql: z.string().describe('A SELECT SQL statement'),
        max_rows: z.number().int().min(1).max(MAX_ROWS_LIMIT).optional()
          .describe(`Most rows to return (default ${DEFAULT_MAX_ROWS}). Page larger results with LIMIT/OFFSET.`),
      }),
    },
    async (args) => {
      const result = await handleQuerySql(args, ctx)
      return minifiedResult(result)
    }
  )
}
