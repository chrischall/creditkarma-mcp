import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'
import { join } from 'path'

import { CreditKarmaClient } from './client.js'
import { initDb } from './db.js'
import type { Database } from './db.js'

import { authToolDefinitions, handleSetToken, handleLogin, handleSetSession } from './tools/auth.js'
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

async function main() {
  const dbPath = process.env.CK_DB_PATH || join(homedir(), '.creditkarma-mcp', 'transactions.db')
  const mcpJsonPath = join(process.cwd(), '.mcp.json')

  const ctx: AppContext = {
    client: new CreditKarmaClient(
      process.env.CK_TOKEN || undefined,
      process.env.CK_REFRESH_TOKEN || undefined,
      process.env.CK_COOKIES || undefined
    ),
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
    case 'ck_login': return handleLogin(args as Record<string, never>, ctx)
    case 'ck_set_session': return handleSetSession(args as { ckat: string; cookies: string }, ctx)

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
