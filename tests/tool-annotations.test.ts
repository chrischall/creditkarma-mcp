import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestHarness } from '@chrischall/mcp-utils/test'
import type { AppContext } from '../src/index.js'
import { registerHealthcheckTools } from '../src/tools/healthcheck.js'
import { registerAuthTools } from '../src/tools/auth.js'
import { registerSyncTools } from '../src/tools/sync.js'
import { registerQueryTools } from '../src/tools/query.js'
import { registerSqlTools } from '../src/tools/sql.js'
import { registerBalanceTools } from '../src/tools/balances.js'

/**
 * Fleet annotation meta-test. `destructiveHint` DEFAULTS TO TRUE whenever
 * readOnlyHint is false, so a write that forgets to declare it publishes as
 * destructive and nothing fails — a considered `false` and a forgotten one
 * leave identical annotations. So every write must CHOOSE, no read may claim
 * to be destructive, and every tool says whether it reaches the network.
 * Reads the annotations off the wire (tools/list), not a hand-kept list.
 */
interface Ann { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown }

let harness: Awaited<ReturnType<typeof createTestHarness>>
let ann: Record<string, Ann | undefined>

beforeAll(async () => {
  // Registration only — no handler runs, so the context is never touched.
  const ctx = {} as AppContext
  harness = await createTestHarness((s) => {
    registerHealthcheckTools(s, ctx)
    registerAuthTools(s, ctx)
    registerSyncTools(s, ctx)
    registerQueryTools(s, ctx)
    registerBalanceTools(s, ctx)
    registerSqlTools(s, ctx)
  })
  ann = Object.fromEntries(
    (await harness.client.listTools()).tools.map((t) => [t.name, t.annotations as Ann | undefined]),
  )
})
afterAll(async () => { if (harness) await harness.close() })

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(ann)).toHaveLength(11)
  })

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(ann)
      .filter(([, a]) => a?.readOnlyHint !== true && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n)
    expect(undeclared).toEqual([])
  })

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(ann)
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([n]) => n)
    expect(contradictory).toEqual([])
  })

  it('declares openWorldHint on every tool: network for CK calls, local for SQLite/session-file tools', () => {
    const world = Object.fromEntries(Object.entries(ann).map(([n, a]) => [n, a?.openWorldHint]))
    expect(world).toEqual({
      // Reach creditkarma.com (or the Intuit aggregator / browser bridge).
      ck_healthcheck: true,
      ck_sync_transactions: true,
      ck_get_account_balances: true, // refresh:true fetches live
      // Local SQLite database or the local saved-session file only.
      ck_set_session: false,
      ck_forget_session: false,
      ck_list_transactions: false,
      ck_get_recent_transactions: false,
      ck_get_spending_by_category: false,
      ck_get_spending_by_merchant: false,
      ck_get_account_summary: false,
      ck_query_sql: false,
    })
  })

  it('classifies the writes by the inverse test', () => {
    // destructive:false only when a later call in THIS tool set restores the
    // prior state. sync and get_account_balances refresh a local mirror of CK
    // data that the next sync/refresh rewrites; set_session's saved file is
    // removed again by ck_forget_session. forget_session deletes the saved
    // session and nothing here can bring that credential back.
    const writes = Object.fromEntries(
      Object.entries(ann).filter(([, a]) => a?.readOnlyHint !== true).map(([n, a]) => [n, a?.destructiveHint]),
    )
    expect(writes).toEqual({
      ck_set_session: false,
      ck_forget_session: true,
      ck_sync_transactions: false,
      ck_get_account_balances: false,
    })
  })
})
