// Print every account in the local DB with its tx count and metadata.
// Also runs backfillAccountIds() as a safety net — no-op after the first server
// startup, but useful if the DB was opened directly or restored from backup.
import { homedir } from 'os'
import { join } from 'path'
import { initDb, backfillAccountIds } from '../dist/db.js'

const dbPath = process.env.CK_DB_PATH || join(homedir(), '.creditkarma-mcp', 'transactions.db')
const db = initDb(dbPath)

const broken = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id IS NULL OR account_id = ''").get().n
if (broken > 0) {
  const result = backfillAccountIds(db)
  console.log(`Repaired ${result.txsUpdated} transactions into ${result.accountsCreated} accounts.\n`)
}

const totals = {
  accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
  transactions: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
}
console.log(`${totals.accounts} accounts, ${totals.transactions} transactions\n`)

console.log('Accounts by tx count:')
const rows = db.prepare(`
  SELECT a.id, a.name, a.provider_name, a.display, COUNT(t.id) AS tx_count
  FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
  GROUP BY a.id ORDER BY tx_count DESC
`).all()
for (const r of rows) console.log(`  ${String(r.tx_count).padStart(5)}  ${r.id.padEnd(28)}  ${r.provider_name?.trim() ?? ''} — ${r.name} (${r.display ?? ''})`)
