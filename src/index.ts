import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { CreditKarmaClient } from './client.js'
import { initDb } from './db.js'
import type { Database } from './db.js'

import { registerAuthTools } from './tools/auth.js'
import { registerSyncTools } from './tools/sync.js'
import { registerQueryTools } from './tools/query.js'
import { registerSqlTools } from './tools/sql.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. mcpb bundle)
try {
  const { config } = await import('dotenv')
  config({ path: join(__dirname, '..', '.env'), override: false })
} catch {
  // not available — rely on process.env (mcpb sets credentials via mcp_config.env)
}

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}

function extractCookieValue(cookieString: string, name: string): string | undefined {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : undefined
}

async function main() {
  const dbPath = process.env.CK_DB_PATH || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(__dirname, '..', '.mcp.json')

  const cookies = process.env.CK_COOKIES || undefined

  // Bootstrap tokens from CK_COOKIES: accepts raw CKAT, CKAT=<value>, or full cookie string
  let token: string | undefined
  let refreshToken: string | undefined
  if (cookies) {
    const ckat = extractCookieValue(cookies, 'CKAT') ?? cookies.trim()
    const parts = ckat.replace('%3B', ';').split(';')
    token = parts[0]?.trim() || undefined
    refreshToken = parts[1]?.trim() || undefined
  }

  const ctx: AppContext = {
    client: new CreditKarmaClient(token, refreshToken, cookies),
    db: initDb(dbPath),
    mcpJsonPath
  }

  const server = new McpServer(
    { name: 'creditkarma-mcp', version: '2.0.3' }
  )

  registerAuthTools(server, ctx)
  registerSyncTools(server, ctx)
  registerQueryTools(server, ctx)
  registerSqlTools(server, ctx)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
