import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { AppContext } from '../index.js'

export interface SetTokenArgs {
  token: string
}

export interface LoginArgs {
  username?: string
  password?: string
}

export interface SubmitMfaArgs {
  code: string
}

export async function handleSetToken(args: SetTokenArgs, ctx: AppContext): Promise<string> {
  ctx.client.setToken(args.token)
  const warning = persistToken(args.token, ctx.mcpJsonPath)
  return warning
    ? `Token set successfully. Warning: ${warning}`
    : 'Token set successfully.'
}

export async function handleLogin(args: LoginArgs, ctx: AppContext): Promise<string> {
  const username = args.username ?? process.env.CK_USERNAME
  const password = args.password ?? process.env.CK_PASSWORD

  if (!username || !password) {
    throw new Error('Username and password required. Pass as args or set CK_USERNAME / CK_PASSWORD env vars.')
  }

  await ctx.client.login(username, password)
  return 'MFA challenge initiated. Check your phone/email and call ck_submit_mfa with your code.'
}

export async function handleSubmitMfa(args: SubmitMfaArgs, ctx: AppContext): Promise<string> {
  const token = await ctx.client.submitMfa(args.code)
  ctx.client.setToken(token)

  const warning = persistToken(token, ctx.mcpJsonPath)
  return warning
    ? `Authenticated successfully. Token saved. Warning: ${warning}`
    : 'Authenticated successfully. Token saved.'
}

function persistToken(token: string, mcpJsonPath: string): string | null {
  if (!existsSync(mcpJsonPath)) {
    return '.mcp.json not found — token applied in memory only'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
  } catch {
    return '.mcp.json could not be parsed — token applied in memory only'
  }

  const env = (parsed as { mcpServers?: { creditkarma?: { env?: Record<string, string> } } })
    ?.mcpServers?.creditkarma?.env

  if (!env) {
    return '.mcp.json lacks mcpServers.creditkarma.env path — token applied in memory only'
  }

  env.CK_TOKEN = token
  writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2))
  return null
}

export const authToolDefinitions = [
  {
    name: 'ck_set_token',
    description: 'Manually set the Credit Karma bearer token. Updates in-memory state and persists to .mcp.json.',
    inputSchema: {
      type: 'object' as const,
      properties: { token: { type: 'string', description: 'Bearer token from browser Network tab' } },
      required: ['token']
    }
  },
  {
    name: 'ck_login',
    description: 'Initiate Credit Karma login with username and password. Sends an MFA challenge. Follow up with ck_submit_mfa.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'CK username (uses CK_USERNAME env var if omitted)' },
        password: { type: 'string', description: 'CK password (uses CK_PASSWORD env var if omitted)' }
      }
    }
  },
  {
    name: 'ck_submit_mfa',
    description: 'Submit MFA code after ck_login. Completes authentication and saves the token.',
    inputSchema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'MFA code from SMS/email' } },
      required: ['code']
    }
  }
]
