// Direct CK API probe — bypasses our parser to see the raw account fields.
import 'dotenv/config'
import { readFileSync } from 'fs'
import { CreditKarmaClient, GRAPHQL_ENDPOINT } from '../dist/client.js'

const cookies = process.env.CK_COOKIES
if (!cookies) { console.error('No CK_COOKIES'); process.exit(1) }

// CKAT cookie value is "<accessToken>;<refreshToken>" (URL-encoded ';' as %3B).
const ckatRaw = cookies.match(/CKAT=([^;]+(?:%3B[^;]+)?)/)?.[1] ?? ''
const parts = ckatRaw.replace('%3B', ';').split(';')
const token = parts[0]?.trim()
const refreshToken = parts[1]?.trim()
if (!token || !refreshToken) { console.error('No access/refresh token parsed from CKAT'); process.exit(1) }

const client = new CreditKarmaClient(token, refreshToken, cookies)
await client.refreshAccessToken()

const query = readFileSync('src/transaction.graphql', 'utf8')

const res = await fetch(GRAPHQL_ENDPOINT, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${client.getToken()}`,
    'Content-Type': 'application/json',
    'Origin': 'https://www.creditkarma.com',
    'Referer': 'https://www.creditkarma.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36',
  },
  body: JSON.stringify({
    query,
    variables: {
      input: {
        paginationInput: { afterCursor: null },
        categoryInput: { categoryId: null, primeCategoryType: null },
        datePeriodInput: { datePeriod: null },
        accountInput: {}
      }
    }
  })
})

console.log('HTTP', res.status)
const json = await res.json()
const txs = json?.data?.prime?.transactionsHub?.transactionPage?.transactions ?? []
console.log('tx count:', txs.length)
console.log('\nfirst 5 transactions, raw account field:')
for (const tx of txs.slice(0, 5)) {
  console.log(JSON.stringify({ id: tx.id, date: tx.date, account: tx.account }, null, 2))
}

// Show distinct (account.id, account.name) across the page
const seen = new Map()
for (const tx of txs) {
  const key = `${tx.account?.id ?? 'NULL'}|${tx.account?.name}|${tx.account?.providerName}`
  seen.set(key, (seen.get(key) ?? 0) + 1)
}
console.log('\ndistinct account id|name|provider on this page:')
for (const [k, n] of seen) console.log(`  ${n}x  ${k}`)
