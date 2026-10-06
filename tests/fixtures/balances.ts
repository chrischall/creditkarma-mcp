// Synthetic fixtures shaped like Credit Karma's balance responses. Every name,
// amount, date and hash here is invented — none comes from a real account.

const span = (text: string) => ({ text, format: null, style: null, styles: null, __typename: 'Span' })
const formatted = (...texts: string[]) => ({ spans: texts.map(span), __typename: 'FormattedText' })

/** A cash-page account row, laid out as captured 2026-10-06 (values invented):
 *  `cards[].item.views[]` holding rowTitle (name), rowValue (balance) and
 *  rowStatusDot.statusDotText ("Provider (...1234)\n<age> ago"). */
export function linkedRow(name: string, balance: string, providerLine: string) {
  return {
    item: {
      views: [{
        rowTitle: formatted(name),
        rowValue: formatted(balance),
        rowStatusDot: { statusDotText: formatted(providerLine), __typename: 'KPLStatusDotView' },
        __typename: 'KPLRowView',
      }],
      __typename: 'KPLViewGroup',
    },
    __typename: 'FabricCardAny',
  }
}

/** The "needs attention" variant: the provider line moves into rowTitle, ahead
 *  of the balance, and the status dot carries the warning instead. */
export function attentionRow(name: string, providerLine: string, balance: string, status: string) {
  return {
    item: {
      views: [{
        rowOverline: formatted(`${name}\n`),
        rowTitle: formatted(providerLine),
        rowValue: formatted(balance),
        rowStatusDot: { statusDotText: formatted(status), __typename: 'KPLStatusDotView' },
        __typename: 'KPLRowView',
      }],
      __typename: 'KPLViewGroup',
    },
    __typename: 'FabricCardAny',
  }
}

/** An investments-page row: nested one level deeper under `lookalikeViews`,
 *  with a truncated provider name ("Example Brokerage - Ind...") and a
 *  "▼ $1,234 (1.2%)" change figure beside the balance. */
export function investmentRow(name: string, balance: string, providerLine: string, change: string) {
  return {
    item: {
      views: [{
        lookalikeViews: [{
          rowTitle: formatted(name),
          rowValue: formatted(balance),
          rowStatusDot: { statusDotText: formatted(providerLine), __typename: 'KPLStatusDotView' },
          rowChange: formatted(change),
          rowCaption: formatted('last 30 days'),
          __typename: 'KPLRowView',
        }],
      }],
      __typename: 'KPLViewGroup',
    },
    __typename: 'FabricCardAny',
  }
}

export function promoCard(text: string) {
  return { item: { views: [{ paragraphText: formatted(text) }] }, __typename: 'FabricCardAny' }
}

export function headerCard(title: string, total: string) {
  return { item: { header: { title: formatted(title), total: formatted(total) } }, __typename: 'FabricCardAny' }
}

export function l2Page(cards: unknown[]) {
  return {
    data: {
      prime: {
        networthByAccountType: {
          __typename: 'Prime_NetworthByAccountTypeLayout',
          impressionEvent: { __typename: 'ImpressionEvent', trackingPayload: 'x' },
          cards,
        },
      },
    },
  }
}

export function idxConnections(connections: Array<{ providerName: string; lastRefreshTimeStamp: string | null }>) {
  return {
    data: {
      prime: {
        idxConnections: {
          __typename: 'Prime_IdxConnections',
          connections: connections.map((c, i) => ({
            __typename: 'Prime_IdxConnection',
            connectionId: `conn-${i}`,
            lastRefreshTimeStamp: c.lastRefreshTimeStamp,
            providerMetadata: { providerName: c.providerName, providerId: `p${i}`, providerLogos: [] },
          })),
        },
      },
    },
  }
}

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
