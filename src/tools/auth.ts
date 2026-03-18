import { exec } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import type { AppContext } from '../index.js'

export interface SetTokenArgs {
  token: string
}

export interface SetSessionArgs {
  /** The CKAT cookie value — contains both access and refresh tokens separated by semicolon */
  ckat: string
  /** Full Cookie header string from any CK network request */
  cookies: string
}

export async function handleSetToken(args: SetTokenArgs, ctx: AppContext): Promise<string> {
  ctx.client.setToken(args.token)
  const warning = persistSession(args.token, null, null, ctx.mcpJsonPath)
  return warning
    ? `Token set successfully. Warning: ${warning}`
    : 'Token set successfully.'
}

export async function handleSetSession(args: SetSessionArgs, ctx: AppContext): Promise<string> {
  // CKAT cookie = "<access_token>;<refresh_token>" (URL-encoded as %3B)
  const parts = args.ckat.replace('%3B', ';').split(';')
  const accessToken = parts[0]?.trim()
  const refreshToken = parts[1]?.trim() ?? null

  if (!accessToken) return 'Session not saved: CKAT cookie appears empty or malformed.'

  ctx.client.setToken(accessToken)
  if (refreshToken) ctx.client.setRefreshToken(refreshToken)
  ctx.client.setCookies(args.cookies)

  const warning = persistSession(accessToken, refreshToken, args.cookies, ctx.mcpJsonPath)
  return warning
    ? `Session saved. Warning: ${warning}`
    : 'Session saved. Access token, refresh token, and cookies stored.'
}

/**
 * Open the Credit Karma login page in the default browser.
 * After logging in, use ck_set_session to store the captured token, refresh token, and cookies.
 */
export async function handleLogin(_args: Record<string, never>, _ctx: AppContext): Promise<string> {
  const url = 'https://www.creditkarma.com/auth/logon'
  openBrowser(url)
  return [
    'Opening Credit Karma login page in your browser.',
    'After logging in, capture from Chrome DevTools → Network tab (any request to api.creditkarma.com):',
    '  1. Authorization header value (the bearer token)',
    '  2. From a /member/oauth2/refresh request body: the refreshToken value',
    '  3. The full Cookie request header value',
    'Then call ck_set_session with all three values.',
  ].join('\n')
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, () => { /* ignore errors */ })
}

/** Persist session to .mcp.json. Returns a warning string or null on success. */
export function persistSession(
  accessToken: string,
  refreshToken: string | null,
  cookies: string | null,
  mcpJsonPath: string
): string | null {
  if (!existsSync(mcpJsonPath)) {
    return '.mcp.json not found — session applied in memory only'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
  } catch {
    return '.mcp.json could not be parsed — session applied in memory only'
  }

  const env = (parsed as { mcpServers?: { creditkarma?: { env?: Record<string, string> } } })
    ?.mcpServers?.creditkarma?.env

  if (!env) {
    return '.mcp.json lacks mcpServers.creditkarma.env path — session applied in memory only'
  }

  env.CK_TOKEN = accessToken
  if (refreshToken) env.CK_REFRESH_TOKEN = refreshToken
  if (cookies) env.CK_COOKIES = cookies
  writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2))
  return null
}

// Keep old name as alias for tests
export const persistTokens = persistSession

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
    description: 'Open the Credit Karma login page in the browser. After logging in, use ck_set_session to store the captured credentials.',
    inputSchema: {
      type: 'object' as const,
      properties: {}
    }
  },
  {
    name: 'ck_set_session',
    description: 'Store a full Credit Karma session from the CKAT cookie value. The CKAT cookie contains both the access token and refresh token (separated by semicolon), enabling automatic token refresh. After logging in via ck_login, open Chrome DevTools → Application → Cookies → creditkarma.com and copy the CKAT cookie value.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ckat: { type: 'string', description: 'The CKAT cookie value from creditkarma.com. Contains access token and refresh token separated by a semicolon (may be URL-encoded as %3B).' },
        cookies: { type: 'string', description: 'Full Cookie header value from any CK network request (for session context)' },
      },
      required: ['ckat', 'cookies']
    }
  }
]
