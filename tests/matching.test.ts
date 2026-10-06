import { describe, it, expect } from 'vitest'
import { matchCreditReportAccounts, sameInstitution, type BalanceSnapshot } from '../src/matching.js'

const cr = (id: string, institution: string | null, balance: number | null, creditLimit: number | null = null, asOf: string | null = '2024-01-25'): BalanceSnapshot =>
  ({ id, institution, balance, creditLimit, asOf })
const linked = (id: string, institution: string | null, balance: number | null, creditLimit: number | null = null, asOf: string | null = '2024-02-15T09:00:00Z'): BalanceSnapshot =>
  ({ id, institution, balance, creditLimit, asOf })

describe('sameInstitution', () => {
  it.each([
    ['Example Card Co', 'example card co', true],
    ['EXAMPLE CARD', 'Example Card Co', true],          // word-prefix
    ['Capital One', 'Capital One - Credit Cards', true], // punctuation ignored
    ['Example & Sons', 'Example and Sons Bank', true],
    ['AMEX', 'American Express', true],                 // bureau abbreviation
    ['JPMCB CARD', 'Chase', true],
    ['Citibank', 'Citi', true],
    ['TRUISTMRTG', 'Truist', true],
    ['Example', 'Examples Bank', false],                 // not a whole-word prefix
    ['First Bank', 'Second Bank', false],
    ['', 'Example', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(sameInstitution(a, b)).toBe(expected)
  })

  it('never matches an unknown institution', () => {
    expect(sameInstitution(null, 'Example')).toBe(false)
    expect(sameInstitution('Example', null)).toBe(false)
  })
})

describe('matchCreditReportAccounts', () => {
  it('matches a card on institution, equal limit and a nearby balance', () => {
    const m = matchCreditReportAccounts(
      [cr('cr:1', 'EXAMPLE CARD', -1200, 10000)],
      [linked('L1', 'Example Card Co', -1900, 10000)],
    )
    expect(m).toEqual(new Map([['cr:1', 'L1']]))
  })

  it('tolerates a $1 limit difference but not more', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000)], [linked('L1', 'X', -100, 5000.5)]).size).toBe(1)
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000)], [linked('L1', 'X', -100, 5100)]).size).toBe(0)
  })

  it('rejects a card whose balance moved more than a quarter of its limit', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 1000)], [linked('L1', 'X', -400, 1000)]).size).toBe(0)
  })

  it('does not match when only one side knows the limit', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 1000)], [linked('L1', 'X', -100, null)]).size).toBe(0)
  })

  it('matches a loan (no limits) on institution and a close balance', () => {
    const m = matchCreditReportAccounts([cr('cr:1', 'Example Lender', -200000)], [linked('L1', 'Example Lender', -199000)])
    expect(m.get('cr:1')).toBe('L1')
    expect(matchCreditReportAccounts([cr('cr:1', 'Example Lender', -200000)], [linked('L1', 'Example Lender', -150000)]).size).toBe(0)
  })

  it('allows at least $1,000 of drift on small loans', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -2000)], [linked('L1', 'X', -2900)]).size).toBe(1)
  })

  it('leaves both unmatched when one credit-report row fits two linked accounts', () => {
    const m = matchCreditReportAccounts(
      [cr('cr:1', 'X', -100, 5000)],
      [linked('L1', 'X', -120, 5000), linked('L2', 'X', -90, 5000)],
    )
    expect(m.size).toBe(0)
  })

  it('leaves both unmatched when one linked account fits two credit-report rows', () => {
    const m = matchCreditReportAccounts(
      [cr('cr:1', 'X', -100, 5000), cr('cr:2', 'X', -110, 5000)],
      [linked('L1', 'X', -105, 5000)],
    )
    expect(m.size).toBe(0)
  })

  it('still matches the unambiguous pairs around an ambiguous one', () => {
    const m = matchCreditReportAccounts(
      [cr('cr:a', 'Alpha', -100, 1000), cr('cr:b', 'Beta', -50, 2000)],
      [linked('La', 'Alpha', -150, 1000), linked('Lb', 'Beta', -60, 2000), linked('Lb2', 'Beta', -40, 2000)],
    )
    expect(m).toEqual(new Map([['cr:a', 'La']]))
  })

  it('never hides a credit-report row behind an OLDER linked balance', () => {
    // A linked connection that broke months ago keeps its last balance; the
    // bureau's newer figure is the better one, so both stay listed.
    expect(matchCreditReportAccounts(
      [cr('cr:1', 'X', -100, 5000, '2024-01-25')],
      [linked('L1', 'X', -110, 5000, '2023-09-14T13:02:31Z')],
    ).size).toBe(0)
  })

  it('accepts a linked balance from the same day, or one whose as-of mixes date and timestamp forms', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000, '2024-01-25')], [linked('L1', 'X', -100, 5000, '2024-01-25')]).size).toBe(1)
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000, '2024-01-25')], [linked('L1', 'X', -100, 5000, '2024-01-25T00:00:01Z')]).size).toBe(1)
  })

  it('does not match a linked balance with no as-of — nothing says it is fresher', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000)], [linked('L1', 'X', -100, 5000, null)]).size).toBe(0)
  })

  it('accepts any dated linked balance when the credit report gives no date', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -100, 5000, null)], [linked('L1', 'X', -100, 5000)]).size).toBe(1)
  })

  it('skips rows without a balance', () => {
    expect(matchCreditReportAccounts([cr('cr:1', 'X', null, 100)], [linked('L1', 'X', -1, 100)]).size).toBe(0)
    expect(matchCreditReportAccounts([cr('cr:1', 'X', -1, 100)], [linked('L1', 'X', null, 100)]).size).toBe(0)
  })
})
