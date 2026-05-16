import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface RegisterCall {
  name: string
  opts: { description: string; inputSchema: unknown; annotations?: unknown }
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
}

/** Minimal MCP server stand-in for testing `register*Tools` functions —
 *  records each registerTool() call so tests can assert on names, schemas,
 *  and the wrapped handlers. */
export function fakeServer(): { server: McpServer; calls: RegisterCall[] } {
  const calls: RegisterCall[] = []
  const server = {
    registerTool: (name: string, opts: RegisterCall['opts'], handler: RegisterCall['handler']) => {
      calls.push({ name, opts, handler })
    }
  } as unknown as McpServer
  return { server, calls }
}

/** Build a fake JWT (header.payload.sig) with the given payload claims. The
 *  signature is bogus — these tests never verify, only decode. */
export function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS512', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.fake-sig`
}
