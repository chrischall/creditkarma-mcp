import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import type { AppContext } from '../index.js'

export interface SetSessionArgs {
  /** Full Cookie header string from any CK network request */
  cookies: string
}

export async function handleSetSession(args: SetSessionArgs, ctx: AppContext): Promise<string> {
  // Accept three formats:
  //   1. Raw CKAT value:      eyJ...%3BeyJ...  or  eyJ...;eyJ...
  //   2. Full Cookie header:  CKTRKID=...; CKAT=eyJ...%3BeyJ...; ...
  //   3. Key=value pair:      CKAT=eyJ...%3BeyJ...
  const ckat = extractCookieValue(args.cookies, 'CKAT') ?? args.cookies.trim()

  const parts = ckat.replace('%3B', ';').split(';')
  const accessToken = parts[0]?.trim()
  const refreshToken = parts[1]?.trim() ?? null

  if (!accessToken) return 'Session not saved: could not extract a token from the provided value.'

  ctx.client.setToken(accessToken)
  if (refreshToken) ctx.client.setRefreshToken(refreshToken)
  ctx.client.setCookies(args.cookies)

  const warning = persistSession(args.cookies, ctx.mcpJsonPath)
  return warning
    ? `Session saved. Warning: ${warning}`
    : 'Session saved. Access token, refresh token, and cookies stored.'
}


function extractCookieValue(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

/** Persist session to .env. Returns a warning string or null on success. */
export function persistSession(
  cookies: string | null,
  mcpJsonPath: string
): string | null {
  if (!cookies) return null

  const envPath = join(dirname(mcpJsonPath), '.env')

  let existing = ''
  if (existsSync(envPath)) {
    try {
      existing = readFileSync(envPath, 'utf8')
    } catch {
      return '.env could not be read — session applied in memory only'
    }
  }

  // Replace or append CK_COOKIES line
  const line = `CK_COOKIES=${cookies}`
  const updated = existing.match(/^CK_COOKIES=/m)
    ? existing.replace(/^CK_COOKIES=.*/m, line)
    : existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + line + '\n'

  try {
    writeFileSync(envPath, updated)
  } catch {
    return '.env could not be written — session applied in memory only'
  }
  return null
}

// Keep old name as alias for tests
export const persistTokens = persistSession

export const authToolDefinitions = [
  {
    name: 'ck_set_session',
    description: 'Store a Credit Karma session to enable automatic token refresh. Accepts any of: (1) the raw CKAT cookie value, (2) the full Cookie header string from any creditkarma.com request, or (3) just "CKAT=<value>". Find CKAT in Chrome DevTools → Application → Cookies → creditkarma.com, or copy the Cookie request header from the Network tab.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object' as const,
      properties: {
        cookies: { type: 'string', description: 'One of: raw CKAT value, full Cookie header string, or "CKAT=<value>"' },
      },
      required: ['cookies']
    }
  }
]
