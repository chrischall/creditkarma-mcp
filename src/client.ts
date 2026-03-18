const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const GRAPHQL_ENDPOINT = 'https://api.creditkarma.com/graphql'

export interface TransactionPage {
  transactions: ApiTransaction[]
  pageInfo: {
    startCursor: string
    endCursor: string
    hasNextPage: boolean
    hasPreviousPage: boolean
  }
}

export interface ApiTransaction {
  id: string
  date: string
  description: string
  status: string
  amount: { value: number; asCurrencyString: string }
  account: {
    id: string
    name: string
    type: string
    providerName: string
    accountTypeAndNumberDisplay: string
  }
  category: { id: string; name: string; type: string }
  merchant: { id: string; name: string }
}

export class CreditKarmaClient {
  private token: string | null = null
  private tokenSetAt: number | null = null
  /** Opaque MFA challenge state from login response — implementation TBD */
  challengeState: unknown = null

  constructor(token?: string) {
    if (token) this.setToken(token)
  }

  setToken(token: string): void {
    this.token = token
    this.tokenSetAt = Date.now()
  }

  getToken(): string | null {
    return this.token
  }

  isTokenExpired(): boolean {
    if (!this.token || this.tokenSetAt === null) return true
    return Date.now() - this.tokenSetAt > TOKEN_TTL_MS
  }

  /** Fetch a single page of transactions. Throws TOKEN_EXPIRED on 401. */
  async fetchPage(afterCursor?: string): Promise<TransactionPage> {
    if (!this.token) throw new Error('TOKEN_EXPIRED')

    const response = await this.post(GRAPHQL_ENDPOINT, {
      query: TRANSACTION_QUERY,
      variables: buildVariables(afterCursor)
    })

    if (response.status === 401) throw new Error('TOKEN_EXPIRED')

    if (response.status === 429) {
      await sleep(2000)
      const retry = await this.post(GRAPHQL_ENDPOINT, {
        query: TRANSACTION_QUERY,
        variables: buildVariables(afterCursor)
      })
      if (retry.status === 401) throw new Error('TOKEN_EXPIRED')
      if (!retry.ok) throw new Error(`HTTP ${retry.status}`)
      return parseTransactionPage(await retry.json())
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseTransactionPage(await response.json())
  }

  /**
   * Initiate login. Sends username/password to CK auth endpoint.
   * Stores MFA challenge state in memory.
   *
   * NOTE: CK login endpoints must be reverse-engineered from browser network
   * traffic before this method can be implemented. The method signature is final;
   * only the body needs implementation once endpoints are known.
   */
  async login(_username: string, _password: string): Promise<void> {
    throw new Error(
      'LOGIN_NOT_IMPLEMENTED: Capture CK auth endpoints from browser Network tab first.'
    )
  }

  /**
   * Submit MFA code. Returns bearer token on success.
   *
   * NOTE: Depends on login() challenge state. Endpoints TBD.
   */
  async submitMfa(_code: string): Promise<string> {
    throw new Error(
      'MFA_NOT_IMPLEMENTED: Depends on login() — endpoints TBD.'
    )
  }

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token ?? ''}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }
}

// ---------------------------------------------------------------------------
// GraphQL query (ported from Ruby script at
// /Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions)
// ---------------------------------------------------------------------------

/**
 * TODO: Extract the full GraphQL query from the Ruby script.
 * Search for the query string in the Ruby file and replace this placeholder.
 * The Ruby file is at:
 * /Users/chris/git/creditkarma_export_transactions/fetch_credit_karma_transactions
 */
export const TRANSACTION_QUERY = `
  query GetTransactions($input: TransactionPageInput) {
    prime {
      transactionsHub {
        transactionPage(input: $input) {
          transactions {
            id
            date
            description
            status
            amount {
              value
              asCurrencyString
            }
            account {
              id
              name
              type
              providerName
              accountTypeAndNumberDisplay
            }
            category {
              id
              name
              type
            }
            merchant {
              id
              name
            }
          }
          pageInfo {
            startCursor
            endCursor
            hasNextPage
            hasPreviousPage
          }
        }
      }
    }
  }
`

function buildVariables(afterCursor?: string): Record<string, unknown> {
  return {
    input: {
      paginationInput: {
        after: afterCursor ?? null,
        first: 50
      }
    }
  }
}

function parseTransactionPage(json: unknown): TransactionPage {
  const data = json as {
    data: {
      prime: {
        transactionsHub: {
          transactionPage: TransactionPage
        }
      }
    }
  }
  return data.data.prime.transactionsHub.transactionPage
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
