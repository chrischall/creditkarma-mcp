import { z } from 'zod'
import { Worker } from 'node:worker_threads'
import { minifiedResult, withAmbientCancellation } from '@chrischall/mcp-utils'
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

/**
 * Wall-clock budget for one `ck_query_sql` call (fleet-audit#1232).
 *
 * `node:sqlite`'s DatabaseSync has no interrupt and no progress handler, and a
 * query that never yields a row — `count(*)` over an unbounded recursive CTE —
 * never gives the row cap a chance to stop it. Run in-process, that blocked the
 * event loop and with it every other tool, forever. So the query runs in a
 * worker thread on its own read-only connection, and the worker is terminated
 * when the budget runs out or the tool call is cancelled.
 */
export const SQL_TIME_BUDGET_MS = 10_000

export interface QuerySqlOptions {
  /** Override {@link SQL_TIME_BUDGET_MS} (tests). */
  timeoutMs?: number
}

/**
 * The worker body, run with `eval: true` so it survives bundling into
 * dist/bundle.js (a separate worker file would not be shipped). It opens its
 * own connection — the file read-only, or a deserialized copy of an in-memory
 * database — under `PRAGMA query_only`, streams at most `cap + 1` rows and
 * posts them back.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const { location, image, sql, cap } = workerData
let db
try {
  if (location) {
    db = new DatabaseSync(location, { readOnly: true })
  } else {
    db = new DatabaseSync(':memory:')
    db.deserialize(image)
  }
  db.exec('PRAGMA query_only = 1')
  const rows = []
  let truncated = false
  for (const row of db.prepare(sql).iterate()) {
    if (rows.length === cap) { truncated = true; break }
    rows.push({ ...row })
  }
  parentPort.postMessage({ rows, truncated })
} catch (err) {
  parentPort.postMessage({ error: err && err.message ? err.message : String(err) })
} finally {
  if (db) db.close()
}
`

interface WorkerReply {
  rows?: Record<string, unknown>[]
  truncated?: boolean
  error?: string
}

function runQueryInWorker(
  ctx: AppContext,
  sql: string,
  cap: number,
  timeoutMs: number,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const signal = withAmbientCancellation(undefined)
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  const location = ctx.db.location()
  const workerData = location ? { location, sql, cap } : { image: ctx.db.serialize(), sql, cap }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData })
    // Whichever of reply / error / budget / cancel comes first settles the
    // promise; a later one is a no-op (a settled promise ignores it, and
    // terminate() on a stopped worker resolves at once).
    const finish = (fn: () => void): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error(
      `ck_query_sql stopped: the query exceeded its ${timeoutMs} ms time budget. ` +
        'Add a WHERE clause or LIMIT, or bound any recursive CTE.',
    ))), timeoutMs)
    const onAbort = (): void => finish(() => reject(abortReason(signal!)))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (reply: WorkerReply) => finish(() => {
      if (reply.error !== undefined) reject(new Error(reply.error))
      else resolve({ rows: reply.rows!, truncated: reply.truncated! })
    }))
    worker.once('error', (err) => finish(() => reject(err)))
  })
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(String(reason))
}

export async function handleQuerySql(
  args: QuerySqlArgs,
  ctx: AppContext,
  opts: QuerySqlOptions = {},
): Promise<QuerySqlResult> {
  const trimmed = args.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').trim()

  // WITH is allowed so CTE-shaped reads (`WITH x AS (...) SELECT ...`) work.
  // The regex alone can't prove a WITH-prefixed statement is read-only
  // (`WITH ... INSERT` is valid SQLite), so the worker's connection is opened
  // read-only and runs under `PRAGMA query_only`, which makes any write fail
  // with SQLITE_READONLY.
  if (!/^(WITH|SELECT)\b/i.test(trimmed)) {
    throw new Error('Only SELECT statements are allowed. (WITH ... SELECT CTEs are also permitted.)')
  }

  const cap = Math.min(args.max_rows ?? DEFAULT_MAX_ROWS, MAX_ROWS_LIMIT)
  // Stream rather than `.all()`: the worker stops reading at cap + 1 (the
  // extra row only proves there is more) instead of materialising the table.
  const { rows, truncated } = await runQueryInWorker(ctx, args.sql, cap, opts.timeoutMs ?? SQL_TIME_BUDGET_MS)
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
}

export function registerSqlTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_query_sql',
    {
      description:
        'Execute a raw SQL SELECT query (CTEs via WITH ... SELECT are supported) against the transactions database. ' +
        'Non-SELECT statements (INSERT, UPDATE, DELETE, DROP, etc.) are rejected. ' +
        `Returns at most max_rows rows (default ${DEFAULT_MAX_ROWS}, max ${MAX_ROWS_LIMIT}); a larger result comes back with truncated: true, so prefer aggregates or LIMIT/OFFSET paging. ` +
        `A query running longer than ${SQL_TIME_BUDGET_MS / 1000} s is stopped. Only the first statement runs. ` +
        'Tables: transactions, accounts, categories, merchants, sync_state.',
      annotations: { readOnlyHint: true, openWorldHint: false },
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
