import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GRAPHQL_ENDPOINT, CK_REFRESH_ENDPOINT } from '../src/client.js'
import { VAULT_SEARCH_URL } from '../src/vault.js'
import { PRIME_WEB_SOURCE, CREDIT_HEALTH_SOURCE, IDX_GATEWAY_SOURCE } from '../src/queryHash.js'

// fleet-audit#1187: the hosted registration is fenced by mint.yaml
// `egress.allow`. A host the code fetches but the manifest omits fails only
// on the hosted connector, as a bare "fetch failed" — so pin the two together.
const mint = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8')

function egressHosts(): string[] {
  const block = mint.split(/^egress:\s*$/m)[1] ?? ''
  return [...block.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ''))
}

function envNames(): string[] {
  const block = mint.split(/^env:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  return [...block.matchAll(/^\s+-\s+name:\s+(\S+)/gm)].map((m) => m[1])
}

describe('mint.yaml', () => {
  it('allows every host the server fetches', () => {
    const fetched = [
      GRAPHQL_ENDPOINT,
      CK_REFRESH_ENDPOINT,
      VAULT_SEARCH_URL,
      PRIME_WEB_SOURCE.pageUrl,
      CREDIT_HEALTH_SOURCE.pageUrl,
      IDX_GATEWAY_SOURCE.pageUrl,
    ].map((u) => new URL(u).host)
    const allowed = egressHosts()
    for (const host of new Set(fetched)) expect(allowed).toContain(host)
  })

  it('offers CK_CREDIT_BUREAU as a registration variable', () => {
    expect(envNames()).toContain('CK_CREDIT_BUREAU')
  })
})
