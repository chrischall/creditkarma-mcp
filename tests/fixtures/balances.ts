// Synthetic fixtures shaped like Credit Karma's balance responses. Every name,
// amount, date and hash here is invented — none comes from a real account.

export function reportHistory(transunion: string[], equifax: string[] = []) {
  return {
    data: {
      creditReportsV2: {
        transunionReportHistory: { reportDates: transunion, reportDateLabels: transunion.map(() => 'Label') },
        equifaxReportHistory: { reportDates: equifax, reportDateLabels: equifax.map(() => 'Label') },
        __typename: 'CRSV2CreditReports',
      },
    },
  }
}

const money = (amount: string) => ({ currency: 'USD', amount, __typename: 'CRSV2CurrencyAmount' })

export interface TradelineOpts {
  hash: string
  institution?: string | null
  accountType?: string
  balance: string
  limit?: string | null
  isOpen?: boolean
  dateReported?: string
}

export function tradeline(o: TradelineOpts) {
  return {
    accountId: 'id',
    accountNumber: o.hash,
    accountType: o.accountType ?? 'Credit Card',
    categoryType: 'Credit',
    currentBalance: money(o.balance),
    limit: o.limit === null ? null : money(o.limit ?? '0.00'),
    isOpen: o.isOpen ?? true,
    dateReported: o.dateReported ?? '2024-02-01',
    institution: o.institution === null ? null : { name: o.institution ?? 'Example Card Co', institutionCode: 'BC', __typename: 'CRSV2Institution' },
  }
}

export function creditReport(tradelines: Partial<Record<
  'creditCards' | 'autoLoans' | 'otherLoans' | 'realEstateLoans' | 'studentLoans',
  ReturnType<typeof tradeline>[]
>>) {
  return {
    data: {
      creditReportsV2: {
        creditReport: {
          creditBureauId: 'TU',
          dateReportPulled: '2024-02-01T12:00:00.000Z',
          tradelines: {
            creditCards: [], autoLoans: [], otherLoans: [], realEstateLoans: [], studentLoans: [],
            ...tradelines,
          },
        },
        __typename: 'CRSV2CreditReports',
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Intuit vault (`POST vault.api.intuit.com/v2/search/connections`) — the API
// behind Credit Karma's "Manage accounts" widget. Shape as captured
// 2026-10-06; every value here is invented.
// ---------------------------------------------------------------------------

export interface VaultAccountOpts {
  urn: string
  masked?: string
  nickName?: string
  accountType?: string
  accountCategory?: string
  status?: string
  balance?: string
  creditMaximumAmount?: number
  refreshedAt?: string
}

export function vaultAccount(o: VaultAccountOpts) {
  return {
    accountId: o.urn,
    accountNumberMasked: o.masked ?? 'XXXX1234',
    currencyCode: 'USD',
    nickName: o.nickName ?? 'Everyday Checking',
    statusCode: '0',
    accountType: o.accountType ?? 'CHECKING',
    accountCategory: o.accountCategory ?? 'DEPOSIT',
    status: o.status ?? 'OPEN',
    lastSuccessfulRefreshTime: o.refreshedAt ?? '2024-02-15T09:00:00Z',
    currentBalance: o.balance ?? '100.00',
    ...(o.creditMaximumAmount !== undefined ? { creditMaximumAmount: o.creditMaximumAmount } : {}),
    statusDetail: [],
  }
}

export function vaultConnection(name: string, accounts: ReturnType<typeof vaultAccount>[], lastSuccessTime = '2024-02-15T08:00:00Z') {
  return {
    providerId: `provider-${name}`,
    name,
    connectionId: `conn-${name}`,
    type: 'OAuth',
    lastSuccessTime,
    statusDetail: [],
    configurations: [{ key: 'irrelevant', value: 'x' }],
    accounts,
  }
}

export function idxAuthResponse(token: string | null, message?: string) {
  return token
    ? { data: { prime: { idxAuth: { __typename: 'Prime_IdxAuth', token } } } }
    : { data: { prime: { idxAuth: { __typename: 'Prime_ServerError', message: message ?? 'User not on trusted device' } } } }
}
