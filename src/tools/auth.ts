import { z } from 'zod'
import { rawTextResult, parseCookieHeader, minifiedResult, readEnvVar } from '@chrischall/mcp-utils'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AppContext } from '../index.js'
import { isJwtExpired } from '../client.js'
import { saveSession, sessionPath, deleteSavedSession, dbPath } from '../session.js'

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

export interface ForgetSessionResult {
  forgotten: true
  /** The saved-session file this call targeted. */
  sessionFile: string
  /** Whether a saved session file was actually deleted. */
  hadSavedSession: boolean
  /** Whether the host still passes CK_COOKIES (which this tool cannot unset). */
  envCookiesSet: boolean
  /** The local transactions database — NOT deleted by this tool. */
  transactionsDb: string
  note: string
  nextStep: string
  warning?: string
}

/**
 * Forget the Credit Karma session on this machine (fleet-audit#1158): delete
 * the saved Cookie header and clear the credentials held in memory. Local only
 * — no request goes to Credit Karma, and no credential is echoed back.
 */
export function handleForgetSession(ctx: AppContext): ForgetSessionResult {
  const sessionFile = sessionPath()
  const { deleted, warning } = deleteSavedSession(sessionFile)
  ctx.client.clearSession()
  const envCookiesSet = Boolean(readEnvVar('CK_COOKIES'))
  return {
    forgotten: true,
    sessionFile,
    hadSavedSession: deleted,
    envCookiesSet,
    transactionsDb: dbPath(),
    note:
      'Local only — Credit Karma was not contacted, so the tokens stay valid until they expire or you sign out at ' +
      'creditkarma.com. Synced transactions are kept; delete the transactionsDb file (and its -wal/-shm sidecars) to remove them.',
    nextStep: envCookiesSet
      ? 'CK_COOKIES is still set in the host config and will be used on the next call — remove it there to fully sign out.'
      : 'The next Credit Karma call needs credentials again: while the fetchproxy extension sees a signed-in creditkarma.com ' +
        'tab it re-reads the cookies (and saves rotated sessions again), so sign out there too to stay signed out.',
    ...(warning ? { warning } : {}),
  }
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

  server.registerTool(
    'ck_forget_session',
    {
      description:
        'Forget the Credit Karma session on this machine: delete the saved-session file (~/.creditkarma-mcp/session, or ' +
        'CK_SESSION_PATH) that ck_set_session and token refreshes write, and clear the credentials held in memory. ' +
        'Use when the user stops using this server or wants their stored login removed. Local only — Credit Karma is ' +
        'not contacted, synced transactions are kept, and a CK_COOKIES value set in the host config is not changed.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => minifiedResult(handleForgetSession(ctx))
  )
}
