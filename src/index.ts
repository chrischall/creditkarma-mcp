import { CreditKarmaClient } from './client.js'
import type { Database } from './db.js'

export interface AppContext {
  client: CreditKarmaClient
  db: Database
  mcpJsonPath: string
}
