// ────────────────────────────────────────────────────────────────────────────
// Saved session — a per-user 0600 file the server reads DIRECTLY
// ────────────────────────────────────────────────────────────────────────────
//
// `ck_set_session` used to persist the Cookie header to `<install>/.env` as
// CK_COOKIES and rely on dotenv to read it back on the next start. In the
// shipped .mcpb that never happened (fleet-audit#71): the bundle is built with
// `--external:dotenv` and `.mcpbignore` drops node_modules/, so the dynamic
// `import('dotenv')` fails and the .env is silently skipped. Where dotenv did
// load, it loads with override:false, so the host's CK_COOKIES (often the
// blank or stale value the manifest passes through from user_config) won. For
// npx installs the .env landed in the ephemeral npx cache. Every one of those
// told the user "Session saved" and lost it on restart.
//
// So the session now lives at a stable per-user path, `~/.creditkarma-mcp/
// session` beside the default database (override with CK_SESSION_PATH), and
// `resolveAuth()` reads it with plain `fs` — no loader, no bundling caveat.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { readEnvVar } from '@chrischall/mcp-utils'

/** Where the saved Cookie header lives. */
export function sessionPath(): string {
  return readEnvVar('CK_SESSION_PATH') || join(homedir(), '.creditkarma-mcp', 'session')
}

/** The saved Cookie header, or null when there is none (missing, unreadable or empty). */
export function readSavedSession(path: string = sessionPath()): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * Save a Cookie header to the session file at mode 0600 (directory 0700).
 * Returns a warning string when it could not be written, null on success.
 */
export function saveSession(cookies: string, path: string = sessionPath()): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, cookies + '\n', { mode: 0o600 })
    // `mode` only applies when the file is created — re-assert 0600 so a
    // pre-existing, looser file gets locked down too.
    chmodSync(path, 0o600)
  } catch {
    return `${path} could not be written — session applied in memory only and will not survive a restart`
  }
  return null
}
