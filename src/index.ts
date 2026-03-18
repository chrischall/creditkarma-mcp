import { config as loadDotenv } from 'dotenv'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'
import { join } from 'path'

// Load .env from the project directory; don't override vars already set by .mcp.json
loadDotenv({ path: join(process.cwd(), '.env'), override: false })

import { CreditKarmaClient } from './client.js'
import { initDb } from './db.js'
import type { Database } from './db.js'

import { authToolDefinitions, handleSetToken, handleSetSession } from './tools/auth.js'
import { syncToolDefinitions, handleSyncTransactions } from './tools/sync.js'
import {
  queryToolDefinitions,
  handleListTransactions, handleGetRecentTransactions,
  handleGetSpendingByCategory, handleGetSpendingByMerchant, handleGetAccountSummary
} from './tools/query.js'
import { sqlToolDefinitions, handleQuerySql } from './tools/sql.js'

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}

const allTools = [
  ...authToolDefinitions,
  ...syncToolDefinitions,
  ...queryToolDefinitions,
  ...sqlToolDefinitions
]

function extractCookieValue(cookieString: string, name: string): string | undefined {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : undefined
}

async function main() {
  const dbPath = process.env.CK_DB_PATH || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(process.cwd(), '.mcp.json')

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

  const server = new Server(
    { name: 'creditkarma-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params

    const result = await dispatch(name, args as Record<string, unknown>, ctx)

    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function dispatch(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  switch (name) {
    // Auth
    case 'ck_set_token': return handleSetToken(args as { token: string }, ctx)
case 'ck_set_session': return handleSetSession(args as { cookies: string }, ctx)

    // Sync
    case 'ck_sync_transactions': return handleSyncTransactions(args as { force_full?: boolean }, ctx)

    // Query
    case 'ck_list_transactions': return handleListTransactions(args, ctx)
    case 'ck_get_recent_transactions': return handleGetRecentTransactions(args as { limit?: number }, ctx)
    case 'ck_get_spending_by_category': return handleGetSpendingByCategory(args, ctx)
    case 'ck_get_spending_by_merchant': return handleGetSpendingByMerchant(args, ctx)
    case 'ck_get_account_summary': return handleGetAccountSummary(args, ctx)

    // SQL
    case 'ck_query_sql': return handleQuerySql(args as { sql: string }, ctx)

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

main().catch(console.error)
