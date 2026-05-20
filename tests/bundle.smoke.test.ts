import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Simulates the layout that `mcpb pack` produces — only the files .mcpbignore
// whitelists end up next to the bundle. If anything the bundle reads at
// runtime (transaction.graphql, etc.) gets re-trimmed by accident, the server
// will ENOENT on startup and the MCP host will see a transport that closes
// within ~100 ms of spawn with no stack trace. This test catches that.
describe('mcpb bundle smoke', () => {
  let stagingDir: string

  beforeAll(() => {
    if (!existsSync('dist/bundle.js')) {
      throw new Error('dist/bundle.js missing — run `npm run build` before `npm test`')
    }
    stagingDir = mkdtempSync(join(tmpdir(), 'ck-mcpb-'))
    mkdirSync(join(stagingDir, 'dist'))
    copyFileSync('package.json', join(stagingDir, 'package.json'))
    copyFileSync('manifest.json', join(stagingDir, 'manifest.json'))
    copyFileSync('dist/bundle.js', join(stagingDir, 'dist', 'bundle.js'))
    copyFileSync('dist/transaction.graphql', join(stagingDir, 'dist', 'transaction.graphql'))
  })

  afterAll(() => {
    rmSync(stagingDir, { recursive: true, force: true })
  })

  it('responds to initialize when launched from the mcpb-shipped file set', async () => {
    const child = spawn(process.execPath, ['dist/bundle.js'], {
      cwd: stagingDir,
      env: {
        ...process.env,
        CK_COOKIES: '',
        CK_DB_PATH: join(stagingDir, 'db.sqlite')
      }
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })

    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '0.0.0' }
      }
    }) + '\n'
    child.stdin.write(initMsg)

    const response = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error(`Timed out waiting for response.\nstderr:\n${stderr}\nstdout:\n${stdout}`))
      }, 5000)

      child.stdout.on('data', () => {
        const line = stdout.split('\n').find((l) => l.includes('"id":0'))
        if (line) {
          clearTimeout(timeout)
          child.stdin.end()
          child.kill()
          resolve(line)
        }
      })

      child.on('exit', (code) => {
        clearTimeout(timeout)
        const line = stdout.split('\n').find((l) => l.includes('"id":0'))
        if (!line) {
          reject(new Error(`Server exited (code ${code}) before responding.\nstderr:\n${stderr}`))
        }
      })
    })

    const parsed = JSON.parse(response)
    expect(parsed.result?.serverInfo?.name).toBe('creditkarma-mcp')
    expect(parsed.result?.protocolVersion).toBeTruthy()
  }, 10_000)
})
