import { readEnvVar, loadDotenvSafely, runMcp, parseCookieHeader } from '@chrischall/mcp-utils'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CreditKarmaClient, warnIfRefreshTokenExpired } from './client.js'
import { initDb, backfillAccountIds } from './db.js'
import type { Database } from './db.js'

import { registerAuthTools } from './tools/auth.js'
import { registerSyncTools } from './tools/sync.js'
import { registerQueryTools } from './tools/query.js'
import { registerSqlTools } from './tools/sql.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env for local dev; no-throw when absent (e.g. mcpb bundle relies on
// mcp_config.env). `readEnvVar` below already hardens against blank /
// `${UNEXPANDED}` placeholders passed through by some MCP hosts.
await loadDotenvSafely({ path: join(__dirname, '..', '.env') })

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}

async function main() {
  const dbPath = readEnvVar('CK_DB_PATH') || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(__dirname, '..', '.mcp.json')

  const cookies = readEnvVar('CK_COOKIES') || undefined

  // Canonical CK_COOKIES is a full Cookie header. Parser stays lenient and
  // also accepts a bare CKAT value or `CKAT=<value>` from legacy configs.
  let token: string | undefined
  let refreshToken: string | undefined
  if (cookies) {
    const ckat = parseCookieHeader(cookies)['CKAT'] ?? cookies.trim()
    const parts = ckat.replace('%3B', ';').split(';')
    token = parts[0]?.trim() || undefined
    refreshToken = parts[1]?.trim() || undefined
  }

  warnIfRefreshTokenExpired(refreshToken)

  const db = initDb(dbPath)
  const repaired = backfillAccountIds(db)
  if (repaired.txsUpdated > 0) {
    console.error(`[creditkarma-mcp] Repaired ${repaired.txsUpdated} transactions across ${repaired.accountsCreated} accounts (CK returned empty account.id for legacy rows).`)
  }

  // Build the client/context here so the deferred-config-error pattern is
  // preserved: the server boots (and answers the host's install-time
  // tools/list) even when CK_COOKIES is absent — the auth error surfaces on
  // the first tool call that needs credentials instead.
  const ctx: AppContext = {
    client: new CreditKarmaClient(token, refreshToken, cookies),
    db,
    mcpJsonPath
  }

  await runMcp({
    name: 'creditkarma-mcp',
    version: '2.2.5', // x-release-please-version
    deps: ctx,
    tools: [
      registerAuthTools,
      registerSyncTools,
      registerQueryTools,
      registerSqlTools,
    ],
  })
}

main().catch(console.error)