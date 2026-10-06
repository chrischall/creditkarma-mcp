import { describe, it, expect } from 'vitest'
import {
  newestReportDate,
  parseCreditReport,
  parseLinkedBalances,
  parseConnectionTimes,
  findConnectionTime,
  dropStaleDuplicates,
  relativeAgeToIso,
  type LinkedAccountBalance,
  BUREAU_CODE,
} from '../src/balances.js'
import {
  linkedRow, attentionRow, investmentRow, promoCard, headerCard, l2Page,
  idxConnections, reportHistory, tradeline, creditReport,
} from './fixtures/balances.js'

describe('BUREAU_CODE', () => {
  it('maps bureau names to the numeric codes CK expects', () => {
    expect(BUREAU_CODE).toEqual({ transunion: 1, equifax: 2 })
  })
})

describe('newestReportDate', () => {
  it('returns the newest TransUnion date regardless of order', () => {
    const json = reportHistory(['2024-01-03T10:00:00Z', '2024-02-03T10:00:00Z', '2023-12-03T10:00:00Z'])
    expect(newestReportDate(json, 'transunion')).toBe('2024-02-03T10:00:00Z')
  })

  it('reads the Equifax history when asked', () => {
    const json = reportHistory(['2024-02-03T10:00:00Z'], ['2024-01-20T09:00:00Z'])
    expect(newestReportDate(json, 'equifax')).toBe('2024-01-20T09:00:00Z')
  })

  it('throws when the bureau has no reports', () => {
    expect(() => newestReportDate(reportHistory([]), 'transunion')).toThrow(/no transunion credit reports/i)
  })

  it('throws on a GraphQL error payload', () => {
    expect(() => newestReportDate({ errors: [{ message: 'An error occurred.' }] }, 'transunion'))
      .toThrow(/An error occurred/)
  })

  it('throws on an unexpected shape', () => {
    expect(() => newestReportDate({ data: {} }, 'transunion')).toThrow(/no transunion credit reports/i)
  })
})

describe('parseCreditReport', () => {
  it('maps a credit card to a negative balance with a positive limit', () => {
    const json = creditReport({
      creditCards: [tradeline({ hash: 'aaa111', institution: 'Example Card Co', balance: '1234.56', limit: '5000.00', dateReported: '2024-01-28' })],
    })
    expect(parseCreditReport(json, 'transunion')).toEqual([{
      key: 'cr:transunion:aaa111',
      institution: 'Example Card Co',
      type: 'Credit Card',
      category: 'credit_card',
      currentBalance: -1234.56,
      creditLimit: 5000,
      asOf: '2024-01-28',
    }])
  })

  it('maps loans across categories with no credit limit', () => {
    const json = creditReport({
      autoLoans: [tradeline({ hash: 'auto1', accountType: 'Auto Loan', balance: '8000.00', limit: '20000.00' })],
      realEstateLoans: [tradeline({ hash: 'home1', accountType: 'Mortgage', balance: '250000.00', limit: null })],
      studentLoans: [tradeline({ hash: 'stu1', accountType: 'Student Loan', balance: '0.00' })],
      otherLoans: [tradeline({ hash: 'oth1', accountType: 'Personal Loan', balance: '10.50' })],
    })
    const rows = parseCreditReport(json, 'transunion')
    expect(rows.map(r => [r.category, r.currentBalance, r.creditLimit])).toEqual([
      ['auto_loan', -8000, null],
      ['other_loan', -10.5, null],
      ['real_estate_loan', -250000, null],
      ['student_loan', 0, null],
    ])
  })

  it('drops closed accounts', () => {
    const json = creditReport({
      creditCards: [
        tradeline({ hash: 'open1', balance: '10.00', limit: '100.00' }),
        tradeline({ hash: 'closed1', balance: '0.00', limit: '100.00', isOpen: false }),
      ],
    })
    expect(parseCreditReport(json, 'transunion').map(r => r.key)).toEqual(['cr:transunion:open1'])
  })

  it('leaves the limit null when a card reports none or an unparseable one', () => {
    const json = creditReport({
      creditCards: [
        tradeline({ hash: 'c1', balance: '10.00', limit: null }),
        tradeline({ hash: 'c2', balance: '10.00', limit: 'n/a' }),
      ],
    })
    expect(parseCreditReport(json, 'transunion').map(r => r.creditLimit)).toEqual([null, null])
  })

  it('keeps an account whose institution is missing', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'x1', institution: null, balance: '1.00' })] })
    expect(parseCreditReport(json, 'transunion')[0].institution).toBeNull()
  })

  it('skips a tradeline whose balance is not a number rather than storing garbage', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'bad', balance: 'abc' }), tradeline({ hash: 'ok', balance: '2.00' })] })
    expect(parseCreditReport(json, 'transunion').map(r => r.key)).toEqual(['cr:transunion:ok'])
  })

  it('skips a tradeline without an account number — there is nothing stable to key it by', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: '', balance: '2.00' })] })
    expect(parseCreditReport(json, 'transunion')).toEqual([])
  })

  it('falls back to the category when the type is missing, and to a null as-of when the date is', () => {
    const t = { ...tradeline({ hash: 'bare', balance: '3.00' }) } as Record<string, unknown>
    delete t.accountType
    delete t.dateReported
    const [row] = parseCreditReport(creditReport({ creditCards: [t as ReturnType<typeof tradeline>] }), 'transunion')
    expect(row).toMatchObject({ type: 'credit_card', asOf: null })
  })

  it('tolerates a missing tradeline group', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'c', balance: '1.00' })] })
    delete (json.data.creditReportsV2.creditReport.tradelines as Record<string, unknown>).studentLoans
    expect(parseCreditReport(json, 'transunion')).toHaveLength(1)
  })

  it('reports a GraphQL error that carries no message', () => {
    expect(() => parseCreditReport({ errors: [{}] }, 'transunion')).toThrow('getCreditReport failed: GraphQL error')
  })

  it('throws on a GraphQL error payload', () => {
    const json = { errors: [{ message: 'An error occurred.' }], data: { creditReportsV2: { creditReport: null } } }
    expect(() => parseCreditReport(json, 'transunion')).toThrow(/An error occurred/)
  })

  it('throws when the report is missing', () => {
    expect(() => parseCreditReport({ data: { creditReportsV2: { creditReport: null } } }, 'transunion'))
      .toThrow(/missing/i)
  })
})

describe('parseLinkedBalances', () => {
  it('reads name, provider, last4, balance and age from a standard row', () => {
    const json = l2Page([
      headerCard('Cash', '$1,500'),
      linkedRow('Everyday Checking', '$1,234.56', 'Example Bank    (...1234)\n2 hr ago'),
    ])
    expect(parseLinkedBalances(json)).toEqual({
      rows: [{
        name: 'Everyday Checking',
        provider: 'Example Bank',
        display: 'Example Bank    (...1234)',
        last4: '1234',
        balance: 1234.56,
        relativeAge: '2 hr ago',
        needsAttention: false,
      }],
      unparsed: 0,
    })
  })

  it('handles the needs-attention layout where the provider comes before the balance', () => {
    const json = l2Page([attentionRow('Family HSA', 'Sample Health (...4321)', '$12,000', 'Account needs attention')])
    expect(parseLinkedBalances(json).rows).toEqual([{
      name: 'Family HSA',
      provider: 'Sample Health',
      display: 'Sample Health (...4321)',
      last4: '4321',
      balance: 12000,
      relativeAge: null,
      needsAttention: true,
    }])
  })

  it('reads an investment row: nested deeper, truncated provider, with a change figure beside the balance', () => {
    const json = l2Page([investmentRow('Brokerage (Margin)', '$123,456', 'Example Brokerage - Ind... (...9876)', '▼ $1,234 (1.2%)')])
    expect(parseLinkedBalances(json)).toEqual({
      rows: [{
        name: 'Brokerage (Margin)',
        provider: 'Example Brokerage - Ind...',
        display: 'Example Brokerage - Ind... (...9876)',
        last4: '9876',
        balance: 123456,
        relativeAge: null,
        needsAttention: false,
      }],
      unparsed: 0,
    })
  })

  it('keeps a row whose last4 is garbage, with last4 null', () => {
    const json = l2Page([linkedRow('Health Savings', '$50', 'Garbage Co (...ount)\n3 mo ago')])
    const [row] = parseLinkedBalances(json).rows
    expect(row.last4).toBeNull()
    expect(row.display).toBe('Garbage Co (...ount)')
  })

  it('reads negative balances', () => {
    const json = l2Page([linkedRow('Overdrawn', '-$5.25', 'Example Bank (...1111)\n1 hr ago')])
    expect(parseLinkedBalances(json).rows[0].balance).toBe(-5.25)
  })

  it('reads a balance written with a unicode minus sign', () => {
    const json = l2Page([linkedRow('Overdrawn', '−$5.25', 'Example Bank (...1111)\n1 hr ago')])
    expect(parseLinkedBalances(json).rows[0].balance).toBe(-5.25)
  })

  it('falls back to the provider as the name when the row has no title', () => {
    const json = l2Page([{ item: { views: [{ v: { spans: [{ text: '$7' }, { text: 'Example Bank (...2222)' }] } }] } }])
    expect(parseLinkedBalances(json).rows[0].name).toBe('Example Bank')
  })

  it('ignores promo and header cards', () => {
    const json = l2Page([
      headerCard('Cash', '$100'),
      promoCard('Earn 4.00% APY with something'),
      linkedRow('Savings', '$100', 'Example Bank (...3333)\n1 hr ago'),
    ])
    expect(parseLinkedBalances(json).rows.map(r => r.name)).toEqual(['Savings'])
  })

  it('counts a provider line it could not pair with exactly one balance as unparsed', () => {
    const json = l2Page([
      { item: { views: [{ a: { text: 'Example Bank (...4444)' }, b: { text: '$1' }, c: { text: '+$2' } }] } },
      linkedRow('Fine', '$3', 'Example Bank (...5555)\n1 hr ago'),
    ])
    expect(parseLinkedBalances(json)).toMatchObject({ unparsed: 1, rows: [{ name: 'Fine' }] })
  })

  it('returns no rows for a page with no accounts', () => {
    expect(parseLinkedBalances(l2Page([]))).toEqual({ rows: [], unparsed: 0 })
  })

  it('returns no rows for an error layout', () => {
    const json = { data: { prime: { networthByAccountType: { __typename: 'Prime_ErrorLayout', cards: [promoCard('Something went wrong')] } } } }
    expect(parseLinkedBalances(json)).toEqual({ rows: [], unparsed: 0 })
  })

  it('throws on a GraphQL error payload', () => {
    expect(() => parseLinkedBalances({ errors: [{ message: 'An error occurred.' }] })).toThrow(/An error occurred/)
  })

  it('throws when the layout is missing', () => {
    expect(() => parseLinkedBalances({ data: { prime: {} } })).toThrow(/missing/i)
  })
})

describe('parseConnectionTimes', () => {
  it('maps normalized provider names to refresh timestamps', () => {
    const json = idxConnections([
      { providerName: 'Example Bank   ', lastRefreshTimeStamp: '2024-02-14T10:00:00Z' },
      { providerName: 'Other CU', lastRefreshTimeStamp: null },
    ])
    expect(parseConnectionTimes(json)).toEqual(new Map([['example bank', '2024-02-14T10:00:00Z']]))
  })

  it('keeps the OLDEST timestamp when one provider has several connections', () => {
    const json = idxConnections([
      { providerName: 'Example Bank', lastRefreshTimeStamp: '2024-02-14T10:00:00Z' },
      { providerName: 'Example Bank', lastRefreshTimeStamp: '2024-02-10T10:00:00Z' },
      { providerName: 'Example Bank', lastRefreshTimeStamp: '2024-02-12T10:00:00Z' },
    ])
    expect(parseConnectionTimes(json).get('example bank')).toBe('2024-02-10T10:00:00Z')
  })

  it('returns an empty map for an unexpected shape', () => {
    expect(parseConnectionTimes({ data: { prime: { idxConnections: { __typename: 'Prime_ServerError' } } } })).toEqual(new Map())
    expect(parseConnectionTimes(null)).toEqual(new Map())
  })
})

describe('dropStaleDuplicates', () => {
  // Credit Karma can list one account twice: the live record "(...6801)" and a
  // stale one for the same plan whose number it formats "(...8-01)", which
  // never refreshes (measured 2026-10-06 on 529 plans: updated tens of days
  // ago, no change history, 90–95% of the live balance).
  const r = (name: string, last4: string | null, display = `X (...${last4 ?? '8-01'})`): LinkedAccountBalance => ({
    name, provider: 'X', display, last4, balance: 1, relativeAge: null, needsAttention: false,
  })

  it('drops the row without a real last4 when a same-named row has one', () => {
    const live = r('College Plan', '6801')
    const stale = r('College Plan', null)
    expect(dropStaleDuplicates([stale, live])).toEqual({ kept: [live], dropped: [stale] })
  })

  it('matches names ignoring surrounding whitespace', () => {
    const live = r('College Plan', '6801')
    const stale = r('  College Plan ', null)
    expect(dropStaleDuplicates([live, stale]).dropped).toEqual([stale])
  })

  it('keeps same-named rows that both have a real last4 — two genuine accounts', () => {
    const rows = [r('Savings', '1111'), r('Savings', '2222')]
    expect(dropStaleDuplicates(rows)).toEqual({ kept: rows, dropped: [] })
  })

  it('keeps same-named rows that both lack a real last4 — nothing says which is stale', () => {
    const rows = [r('HSA', null, 'Y (...ount)'), r('HSA', null, 'Z (...ount)')]
    expect(dropStaleDuplicates(rows)).toEqual({ kept: rows, dropped: [] })
  })

  it('keeps a lone row without a real last4', () => {
    const rows = [r('HSA', null, 'Y (...ount)'), r('Other', '1234')]
    expect(dropStaleDuplicates(rows)).toEqual({ kept: rows, dropped: [] })
  })
})

describe('findConnectionTime', () => {
  const times = new Map([
    ['example bank', '2024-02-14T10:00:00Z'],
    ['example brokerage - individual', '2024-02-13T10:00:00Z'],
    ['example brokerage - joint', '2024-02-12T10:00:00Z'],
    ['sample credit union', '2024-02-11T10:00:00Z'],
  ])

  it('matches the provider exactly, ignoring case and padding', () => {
    expect(findConnectionTime(times, 'Example Bank  ')).toBe('2024-02-14T10:00:00Z')
  })

  it('matches a name CK truncated with an ellipsis by its prefix', () => {
    expect(findConnectionTime(times, 'Example Brokerage - Ind...')).toBe('2024-02-13T10:00:00Z')
    expect(findConnectionTime(times, 'Example Brokerage - Ind…')).toBe('2024-02-13T10:00:00Z')
  })

  it('matches a shortened, untruncated name by prefix', () => {
    expect(findConnectionTime(times, 'Sample Credit')).toBe('2024-02-11T10:00:00Z')
  })

  it('takes the OLDEST when a prefix matches several connections', () => {
    expect(findConnectionTime(times, 'Example Brokerage...')).toBe('2024-02-12T10:00:00Z')
  })

  it('returns undefined when nothing matches, or the name is only an ellipsis', () => {
    expect(findConnectionTime(times, 'Unknown Bank')).toBeUndefined()
    expect(findConnectionTime(times, '...')).toBeUndefined()
  })
})

describe('relativeAgeToIso', () => {
  const now = new Date('2024-02-15T12:00:00Z')

  it.each([
    ['30 sec ago', '2024-02-15T11:59:30.000Z'],
    ['5 min ago', '2024-02-15T11:55:00.000Z'],
    ['2 hr ago', '2024-02-15T10:00:00.000Z'],
    ['1 day ago', '2024-02-14T12:00:00.000Z'],
    ['3 days ago', '2024-02-12T12:00:00.000Z'],
    ['2 mo ago', '2023-12-15T12:00:00.000Z'],
    ['1 yr ago', '2023-02-15T12:00:00.000Z'],
    ['Updated 2 hr ago', '2024-02-15T10:00:00.000Z'],
  ])('%s → %s', (text, iso) => {
    expect(relativeAgeToIso(text, now)).toBe(iso)
  })

  it('returns null for text it does not understand', () => {
    expect(relativeAgeToIso('recently', now)).toBeNull()
    expect(relativeAgeToIso(null, now)).toBeNull()
  })
})
