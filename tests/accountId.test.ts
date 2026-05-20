import { describe, it, expect } from 'vitest'
import { deriveAccountId } from '../src/accountId.js'

describe('deriveAccountId', () => {
  it('returns CK-provided id when non-empty', () => {
    expect(deriveAccountId({
      id: 'urn:account:abc',
      providerName: 'Chase',
      accountTypeAndNumberDisplay: 'Credit (..1234)'
    })).toBe('urn:account:abc')
  })

  it('returns CK-provided id even when provider has whitespace', () => {
    expect(deriveAccountId({
      id: 'real-id',
      providerName: 'Ally   ',
      accountTypeAndNumberDisplay: 'Bank (..7133)'
    })).toBe('real-id')
  })

  it('synthesizes provider|last4 when id is empty', () => {
    expect(deriveAccountId({
      id: '',
      providerName: 'Citi',
      accountTypeAndNumberDisplay: 'Credit (..2630)'
    })).toBe('Citi|2630')
  })

  it('trims trailing whitespace from providerName', () => {
    expect(deriveAccountId({
      id: '',
      providerName: 'Ally   ',
      accountTypeAndNumberDisplay: 'Bank (..7133)'
    })).toBe('Ally|7133')
  })

  it('groups Credit and Credit Card variants under the same synthetic id', () => {
    const a = deriveAccountId({
      id: '', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit (..2630)'
    })
    const b = deriveAccountId({
      id: '', providerName: 'Citi', accountTypeAndNumberDisplay: 'Credit Card (..2630)'
    })
    expect(a).toBe(b)
  })

  it('keeps non-numeric last-4 fragments (e.g. truncated names like "..ount")', () => {
    expect(deriveAccountId({
      id: '',
      providerName: 'HealthEquity',
      accountTypeAndNumberDisplay: 'Bank (..ount)'
    })).toBe('HealthEquity|ount')
  })

  it('treats null id like empty', () => {
    expect(deriveAccountId({
      id: null,
      providerName: 'Chase',
      accountTypeAndNumberDisplay: 'Credit (..1228)'
    })).toBe('Chase|1228')
  })

  it('treats whitespace-only id like empty', () => {
    expect(deriveAccountId({
      id: '   ',
      providerName: 'Chase',
      accountTypeAndNumberDisplay: 'Credit (..1228)'
    })).toBe('Chase|1228')
  })

  it('falls back to raw display when no (..XXXX) pattern', () => {
    expect(deriveAccountId({
      id: '',
      providerName: 'Unknown',
      accountTypeAndNumberDisplay: 'something weird'
    })).toBe('Unknown|something weird')
  })

  it('handles missing provider and display fields', () => {
    expect(deriveAccountId({ id: '' })).toBe('|')
  })

  it('handles different accounts at same provider distinctly', () => {
    const checking = deriveAccountId({
      id: '', providerName: 'Ally', accountTypeAndNumberDisplay: 'Checking (..8189)'
    })
    const savings = deriveAccountId({
      id: '', providerName: 'Ally', accountTypeAndNumberDisplay: 'Savings (..7148)'
    })
    expect(checking).not.toBe(savings)
  })
})
