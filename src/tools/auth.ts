import { z } from 'zod'
import { rawTextResult, parseCookieHeader } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import { isJwtExpired } from '../client.js'
import { saveSession } from '../session.js'

export interface SetSessionArgs {
  /** Full Cookie header string from any CK network request */
  cookies: string
}

export async function handleSetSession(args: SetSessionArgs, ctx: AppContext): Promise<string> {
  // Canonical input is the full Cookie header from a signed-in creditkarma.com
  // request (`CKTRKID=...; CKAT=eyJ...%3BeyJ...; ...`). The parser remains
  // lenient and also accepts a bare CKAT value or `CKAT=<value>` for callers
  // that lifted just the cookie value from DevTools.
  const ckat = parseCookieHeader(args.cookies)['CKAT'] ?? args.cookies.trim()

  const parts = ckat.replace('%3B', ';').split(';')
  const accessToken = parts[0]?.trim()
  const refreshToken = parts[1]?.trim() ?? null

  if (!accessToken) return 'Session not saved: could not extract a token from the provided value.'

  // Refuse if the refresh JWT is already expired — saving stale credentials
  // pollutes the saved session and produces confusing HTTP 400s from the refresh endpoint.
  if (refreshToken && isJwtExpired(refreshToken)) {
    return 'Session not saved: refresh token has already expired. Sign back into creditkarma.com — with the fetchproxy extension installed the MCP will read fresh cookies automatically, or copy a fresh Cookie header from DevTools.'
  }

  ctx.client.setToken(accessToken)
  if (refreshToken) ctx.client.setRefreshToken(refreshToken)
  ctx.client.setCookies(args.cookies)

  // Saved where resolveAuth() reads it back directly (src/session.ts) — not a
  // .env that the shipped .mcpb never loads (fleet-audit#71).
  const warning = saveSession(args.cookies)
  return warning
    ? `Session applied for this run only. Warning: ${warning}`
    : 'Session saved. Access token, refresh token, and cookies stored.'
}

export function registerAuthTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ck_set_session',
    {
      description: 'Store a Credit Karma session to enable automatic token refresh. Pass the full Cookie header from a signed-in creditkarma.com request (Chrome DevTools \u2192 Network \u2192 any creditkarma.com request \u2192 Request Headers \u2192 right-click the `cookie` header \u2192 Copy value). For most users the easier onboarding path is to install the fetchproxy extension and sign into creditkarma.com \u2014 the MCP reads the cookies automatically.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        cookies: z.string().describe('Full Cookie header from a signed-in creditkarma.com request (contains CKAT, CKTRKID, etc.)'),
      }),
    },
    async (args) => {
      const result = await handleSetSession(args, ctx)
      return rawTextResult(result)
    }
  )
}
