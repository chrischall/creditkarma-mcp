import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// A worker that dies before replying (e.g. it could not load node:sqlite)
// must fail the call with that error rather than leave it pending.
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super()
      setImmediate(() => this.emit('error', new Error('worker could not start')))
    }
    terminate(): Promise<number> {
      return Promise.resolve(1)
    }
  },
}))

const { handleQuerySql } = await import('../../src/tools/sql.js')
const { initDb } = await import('../../src/db.js')
const { CreditKarmaClient } = await import('../../src/client.js')

describe('ck_query_sql worker failure', () => {
  it('rejects with the worker error', async () => {
    const ctx = { client: new CreditKarmaClient(), db: initDb(':memory:') }
    await expect(handleQuerySql({ sql: 'SELECT 1' }, ctx)).rejects.toThrow('worker could not start')
  })
})
