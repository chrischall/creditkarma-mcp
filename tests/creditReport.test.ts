import { describe, it, expect } from 'vitest'
import { newestReportDate, parseCreditReport, BUREAU_CODE } from '../src/creditReport.js'
import { reportHistory, tradeline, creditReport } from './fixtures/balances.js'

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

  it('treats a zero limit as none — charge cards report 0.00', () => {
    const json = creditReport({ creditCards: [tradeline({ hash: 'c0', balance: '10.00', limit: '0.00' })] })
    expect(parseCreditReport(json, 'transunion')[0].creditLimit).toBeNull()
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
