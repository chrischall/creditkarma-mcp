import { describe, it, expect, afterEach, vi } from 'vitest'
import { EdgeBlockedError } from '@chrischall/mcp-utils'
import {
  parseIdxAuthToken, parseVaultAccounts, searchVaultConnections, VAULT_SEARCH_URL,
} from '../src/vault.js'
import { vaultAccount, vaultConnection, idxAuthResponse } from './fixtures/balances.js'

const URN = (n: number) => `urn:account:fdp::accountid:00000000-0000-0000-0000-00000000000${n}`

describe('parseIdxAuthToken', () => {
  it('returns the token', () => {
    expect(parseIdxAuthToken(idxAuthResponse('tok.en'))).toBe('tok.en')
  })

  it('throws the server\'s reason when it refuses', () => {
    expect(() => parseIdxAuthToken(idxAuthResponse(null))).toThrow('idxAuth failed: User not on trusted device')
  })

  it('throws on GraphQL errors and on an unexpected shape', () => {
    expect(() => parseIdxAuthToken({ errors: [{ message: 'An error occurred.' }] })).toThrow('idxAuth failed: An error occurred.')
    expect(() => parseIdxAuthToken({ data: {} })).toThrow('idxAuth failed: no token in response')
    expect(() => parseIdxAuthToken({ data: { prime: { idxAuth: { __typename: 'Prime_ServerError' } } } })).toThrow('idxAuth failed: no token in response')
  })
})

describe('parseVaultAccounts', () => {
  it('maps a credit card: negative balance, positive limit, available credit, its own refresh time', () => {
    const json = [vaultConnection('Example Card Co', [vaultAccount({
      urn: URN(1), masked: 'XXXXXXXXXXXX4321', nickName: 'Rewards Card', accountType: 'CREDITCARD',
      accountCategory: 'LINEOFCREDIT', balance: '1250.50', creditMaximumAmount: 10000, refreshedAt: '2024-02-14T10:00:00Z',
    })])]
    expect(parseVaultAccounts(json)).toEqual([{
      urn: URN(1), provider: 'Example Card Co', name: 'Rewards Card', last4: '4321', type: 'CREDITCARD',
      category: 'LINEOFCREDIT', balance: -1250.5, creditLimit: 10000, availableCredit: 8749.5, asOf: '2024-02-14T10:00:00Z',
    }])
  })

  it('normalizes loans to negative whatever sign the provider used', () => {
    const json = [vaultConnection('Example Lender', [
      vaultAccount({ urn: URN(1), masked: '7777', accountType: 'MORTGAGE', accountCategory: 'LOAN', balance: '-250000.25' }),
      vaultAccount({ urn: URN(2), masked: '8888', accountType: 'AUTOLOAN', accountCategory: 'LOAN', balance: '9000' }),
    ])]
    expect(parseVaultAccounts(json).map(a => [a.balance, a.creditLimit, a.availableCredit])).toEqual([
      [-250000.25, null, null],
      [-9000, null, null],
    ])
  })

  it('keeps assets positive and leaves card-only fields null', () => {
    const json = [vaultConnection('Example Bank', [vaultAccount({ urn: URN(1), balance: '500.10' })])]
    expect(parseVaultAccounts(json)[0]).toMatchObject({ balance: 500.1, creditLimit: null, availableCredit: null, category: 'DEPOSIT' })
  })

  it('treats a zero or missing credit maximum as no limit (charge cards report 0)', () => {
    const json = [vaultConnection('Example Charge Co', [
      vaultAccount({ urn: URN(1), accountCategory: 'LINEOFCREDIT', accountType: 'CREDITCARD', balance: '50', creditMaximumAmount: 0 }),
      vaultAccount({ urn: URN(2), accountCategory: 'LINEOFCREDIT', accountType: 'CREDITCARD', balance: '50' }),
    ])]
    expect(parseVaultAccounts(json).map(a => [a.creditLimit, a.availableCredit])).toEqual([[null, null], [null, null]])
  })

  it('reports a zero balance as 0, not -0', () => {
    const json = [vaultConnection('Example Card Co', [vaultAccount({ urn: URN(1), accountCategory: 'LINEOFCREDIT', balance: '0', creditMaximumAmount: 100 })])]
    expect(Object.is(parseVaultAccounts(json)[0].balance, 0)).toBe(true)
  })

  it('reads last4 from the many masking styles, and null when there is none', () => {
    const masks = ['...1228', 'XXXXXX4746', '*****1927', 'XXXXX-4827', 'EPAY XXXXX-4827', '7527', 'Health Savings Account', 'PLAN NAME 401(K)   ', '']
    const json = [vaultConnection('X', masks.map((m, i) => vaultAccount({ urn: URN(i), masked: m })))]
    expect(parseVaultAccounts(json).map(a => a.last4)).toEqual(['1228', '4746', '1927', '4827', '4827', '7527', null, null, null])
  })

  it('reports an empty balance as null rather than zero', () => {
    const json = [vaultConnection('X', [vaultAccount({ urn: URN(1), balance: '' }), vaultAccount({ urn: URN(2), balance: 'n/a' })])]
    expect(parseVaultAccounts(json).map(a => a.balance)).toEqual([null, null])
  })

  it('falls back to the connection\'s last success when the account has no refresh time, then to null', () => {
    const json = [
      vaultConnection('A', [vaultAccount({ urn: URN(1), refreshedAt: '' })], '2024-02-10T00:00:00Z'),
      vaultConnection('B', [vaultAccount({ urn: URN(2), refreshedAt: '' })], ''),
    ]
    expect(parseVaultAccounts(json).map(a => a.asOf)).toEqual(['2024-02-10T00:00:00Z', null])
  })

  it('trims the provider and falls back to it when the account has no nickname', () => {
    const json = [vaultConnection('Padded Bank   ', [vaultAccount({ urn: URN(1), nickName: '  ' })])]
    expect(parseVaultAccounts(json)[0]).toMatchObject({ provider: 'Padded Bank', name: 'Padded Bank' })
  })

  it('skips accounts that are not OPEN or carry no URN', () => {
    const json = [vaultConnection('X', [
      vaultAccount({ urn: URN(1), status: 'CLOSED' }),
      vaultAccount({ urn: '' }),
      vaultAccount({ urn: URN(3) }),
    ])]
    expect(parseVaultAccounts(json).map(a => a.urn)).toEqual([URN(3)])
  })

  it('tolerates connections without accounts and junk entries', () => {
    expect(parseVaultAccounts([{ name: 'Empty' }, null, 'x', vaultConnection('X', [vaultAccount({ urn: URN(1) })])])).toHaveLength(1)
  })

  it('throws when the response is not a list of connections', () => {
    expect(() => parseVaultAccounts({ error: 'nope' })).toThrow('vault connections response is not a list')
  })
})

describe('searchVaultConnections', () => {
  afterEach(() => vi.restoreAllMocks())

  it('POSTs the Manage-accounts search with the idx token', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }))
    await expect(searchVaultConnections('idx-token')).resolves.toEqual([])
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    const u = new URL(url)
    expect(`${u.origin}${u.pathname}`).toBe(VAULT_SEARCH_URL)
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      country_code: 'US', flow_name: 'ManageConnections', intuit_offeringid: 'com.creditkarma', locale: 'en_US',
    })
    expect(u.searchParams.get('intuit_tid')).toMatch(/^[0-9a-f-]{36}$/)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer idx-token')
    expect(JSON.parse(String(init.body))).toMatchObject({ acquireAccounts: true, visibleAccounts: true, manualAccounts: false })
  })

  it('surfaces a failure with status and a redacted body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    await expect(searchVaultConnections('t')).rejects.toThrow(/Intuit vault search failed: HTTP 401/)
  })

  it('names a CDN block as such', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(
      '<HTML><TITLE>ERROR: The request could not be satisfied</TITLE>Generated by cloudfront (CloudFront)</HTML>',
      { status: 403, headers: { 'content-type': 'text/html', 'x-cache': 'Error from cloudfront', server: 'CloudFront' } },
    ))
    await expect(searchVaultConnections('t')).rejects.toBeInstanceOf(EdgeBlockedError)
  })

  it('reports a body that is not JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>oops</html>', { status: 200 }))
    await expect(searchVaultConnections('t')).rejects.toThrow('Intuit vault search returned non-JSON')
  })
})
