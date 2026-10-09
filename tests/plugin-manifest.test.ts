// Invariant: the Claude Code plugin manifest declares its MCP config under
// `mcpServers`, the key Claude Code actually reads. `mcp` is an unknown field
// that Claude Code ignores at load time (`claude plugin validate` warns on
// it); it only appeared to work because ./.mcp.json is the default location.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>

describe('.claude-plugin/plugin.json', () => {
  it('declares its MCP config under mcpServers, not the ignored mcp key', () => {
    expect(manifest).not.toHaveProperty('mcp')
    expect(typeof manifest.mcpServers).toBe('string')
  })

  it('points mcpServers at a file that exists', () => {
    expect(existsSync(join(ROOT, manifest.mcpServers as string))).toBe(true)
  })
})
