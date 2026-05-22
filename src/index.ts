import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CreditKarmaClient, isJwtExpired, extractCookieValue } from './client.js'
import { initDb, backfillAccountIds } from './db.js'
import type { Database } from './db.js'

import { registerAuthTools } from './tools/auth.js'
import { registerSyncTools } from './tools/sync.js'
import { registerQueryTools } from './tools/query.js'
import { registerSqlTools } from './tools/sql.js'

/**
 * Read an env var, trim whitespace, and treat as unset if blank or if the value
 * looks like an unsubstituted shell placeholder (e.g. `${FOO}`) — defends
 * against MCP hosts that pass .mcp.json env blocks through unexpanded.
 */
function readVar(key: string): string | undefined {
  const raw = process.env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === 'undefined' || trimmed === 'null') return undefined;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
  const { config } = await import('dotenv')
  config({ path: join(__dirname, '..', '.env'), override: false, quiet: true })
} catch {
  // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}

async function main() {
  const dbPath = readVar('CK_DB_PATH') || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(__dirname, '..', '.mcp.json')

  const cookies = readVar('CK_COOKIES') || undefined

  // Canonical CK_COOKIES is a full Cookie header. Parser stays lenient and
  // also accepts a bare CKAT value or `CKAT=<value>` from legacy configs.
  let token: string | undefined
  let refreshToken: string | undefined
  if (cookies) {
    const ckat = extractCookieValue(cookies, 'CKAT') ?? cookies.trim()
    const parts = ckat.replace('%3B', ';').split(';')
    token = parts[0]?.trim() || undefined
    refreshToken = parts[1]?.trim() || undefined
  }


  if (refreshToken && isJwtExpired(refreshToken)) {
    console.error('[creditkarma-mcp] Warning: refresh token in CK_COOKIES has expired. Sign back into creditkarma.com (with the fetchproxy extension installed) or call ck_set_session with a fresh Cookie header.')
  }

  const db = initDb(dbPath)
  const repaired = backfillAccountIds(db)
  if (repaired.txsUpdated > 0) {
    console.error(`[creditkarma-mcp] Repaired ${repaired.txsUpdated} transactions across ${repaired.accountsCreated} accounts (CK returned empty account.id for legacy rows).`)
  }

  const ctx: AppContext = {
    client: new CreditKarmaClient(token, refreshToken, cookies),
    db,
    mcpJsonPath
  }

  const server = new McpServer(
    { name: 'creditkarma-mcp', version: '2.1.0' } // x-release-please-version
  )

  registerAuthTools(server, ctx)
  registerSyncTools(server, ctx)
  registerQueryTools(server, ctx)
  registerSqlTools(server, ctx)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)