# Credit Karma requests for fpx + curl

Ready-to-run bodies/commands for the two live endpoints `creditkarma-mcp`
actually calls (from `src/client.ts`). Both are unpublished, reverse-engineered
CK-internal endpoints — verified live by the MCP's own client, not guessed.

- `POST https://api.creditkarma.com/graphql` — the transactions query.
- `POST https://www.creditkarma.com/member/oauth2/refresh` — access-token refresh.

Everything else the MCP exposes (`ck_list_transactions`,
`ck_get_spending_by_category`, `ck_get_spending_by_merchant`,
`ck_get_account_summary`, `ck_query_sql`) queries a **local SQLite DB** the
MCP populated from this same GraphQL query — there is no separate remote
endpoint behind them to reproduce here.

---

## 0. Capture the session cookie (once)

```sh
COOKIES=$(fpx cookies -p creditkarma)          # {"CKAT":"...","CKTRKID":"..."}
CKAT=$(jq -r '.CKAT' <<<"$COOKIES" | sed 's/%3B/;/')
CKTRKID=$(jq -r '.CKTRKID' <<<"$COOKIES")
ACCESS=${CKAT%%;*}                             # access JWT
REFRESH=${CKAT#*;}                             # refresh JWT
```

## 1. Fetch one page of transactions

`variables.input` shape (from `client.ts`'s `buildVariables`):

```json
{
  "input": {
    "paginationInput": { "afterCursor": null },
    "categoryInput": { "categoryId": null, "primeCategoryType": null },
    "datePeriodInput": { "datePeriod": null },
    "accountInput": {}
  }
}
```

`afterCursor` is `null` for the first page, then the previous response's
`pageInfo.endCursor` for subsequent pages. The query text itself lives at
`src/transaction.graphql` in this repo (too large — ~3800 lines — to inline;
only the top `query GetTransactions(...)` operation and the `fabricCardAny`
fragment chain it references actually matter, but GraphQL requires every
transitively-referenced fragment in the document, hence the size).

```sh
CK_DIR=~/git/creditkarma-mcp

build_body() {   # $1 = afterCursor (or the string "null")
  jq -n --rawfile q "$CK_DIR/src/transaction.graphql" \
    --argjson after "$1" \
    '{query:$q, variables:{input:{
        paginationInput:{afterCursor:$after},
        categoryInput:{categoryId:null,primeCategoryType:null},
        datePeriodInput:{datePeriod:null},
        accountInput:{}}}}'
}

build_body null > /tmp/ck-body.json

curl -s https://api.creditkarma.com/graphql -X POST \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.creditkarma.com' \
  -H 'Referer: https://www.creditkarma.com/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  --data @/tmp/ck-body.json > /tmp/ck-resp.json
```

The response shape (`src/client.ts`'s `parseTransactionPage`):
`data.prime.transactionsHub.transactionPage.{transactions[], pageInfo}`.

### Project the transactions

```sh
jq -r '.data.prime.transactionsHub.transactionPage.transactions[]
  | [.date, .amount.asCurrencyString, .description,
     .account.providerName, .account.accountTypeAndNumberDisplay,
     (.category.name // ""), (.merchant.name // "")]
  | @tsv' /tmp/ck-resp.json
```

Fields per transaction: `id date description status amount{value
asCurrencyString} account{id name type providerName
accountTypeAndNumberDisplay} category{id name type} merchant{id name}`.
`account.id` is always `""` from CK — the MCP synthesizes a stable id from
`providerName` + the last 4 digits in `accountTypeAndNumberDisplay`
(`src/accountId.ts`); do the same locally if you need one.

### Paginate to the end

```sh
after=null
while :; do
  build_body "$after" > /tmp/ck-body.json
  curl -s https://api.creditkarma.com/graphql -X POST \
    -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/json' \
    -H 'Origin: https://www.creditkarma.com' \
    -H 'Referer: https://www.creditkarma.com/' \
    -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
    --data @/tmp/ck-body.json > /tmp/ck-resp.json

  jq -r '.data.prime.transactionsHub.transactionPage.transactions[]
    | [.date, .amount.asCurrencyString, .description] | @tsv' /tmp/ck-resp.json

  has_next=$(jq -r '.data.prime.transactionsHub.transactionPage.pageInfo.hasNextPage' /tmp/ck-resp.json)
  [ "$has_next" = "true" ] || break
  after=$(jq -c '.data.prime.transactionsHub.transactionPage.pageInfo.endCursor' /tmp/ck-resp.json)
done
```

### Auth-error check (run on every response BEFORE trusting `.data`)

```sh
jq -r '.errorCode // (.errors[]?.errorCode) // (.errors[]?.code)
  // (.errors[]?.extensions.code) // empty' /tmp/ck-resp.json
```

Matches `UNAUTHENTICATED|UNAUTHORIZED|TOKEN_EXPIRED|401` (case-insensitive)
→ refresh the token (step 2) and retry the SAME body. Any other non-empty
value is a real GraphQL error (schema drift, validation) — surface it, don't
refresh.

## 2. Refresh the access token

```sh
GLID=$(node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url').toString()).glid||'')" "$ACCESS")

curl -s https://www.creditkarma.com/member/oauth2/refresh -X POST \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.creditkarma.com' \
  -H 'Referer: https://www.creditkarma.com/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -H 'ck-client-name: web' \
  -H 'ck-client-version: 1.0.0' \
  -H 'ck-device-type: Desktop' \
  -H "Authorization: Bearer $ACCESS" \
  -H "ck-trace-id: $GLID" \
  -H "ck-cookie-id: $CKTRKID" \
  -H "Cookie: CKTRKID=$CKTRKID; CKAT=$ACCESS%3B$REFRESH" \
  --data "$(jq -n --arg rt "$REFRESH" '{refreshToken:$rt}')" > /tmp/ck-refresh.json

ACCESS=$(jq -r '.accessToken' /tmp/ck-refresh.json)
NEW_REFRESH=$(jq -r '.refreshToken // empty' /tmp/ck-refresh.json)
[ -n "$NEW_REFRESH" ] && REFRESH=$NEW_REFRESH   # CK doesn't always rotate it
```

Failure shapes (`client.ts`'s `doRefreshAccessToken`):
- Non-2xx with an HTML body → refresh token dead / session invalid. Re-sign
  into `creditkarma.com` and re-run `fpx cookies -p creditkarma`.
- Non-2xx with a JSON body → the (redacted/capped) body is the detail.
- 2xx with `{"error": "..."}` and no `accessToken` → treat the same as a
  non-2xx failure.

`ck-trace-id` (the JWT's `glid` claim) and `ck-cookie-id` (`CKTRKID`) are
both required — CK 403s the refresh call without them once a token is
present.

## Money / units

- `amount.value` is a signed number; negative = expense/debit, positive =
  credit/income. `amount.asCurrencyString` is the display form (e.g.
  `"-$42.10"`).
- No currency conversion — CK is USD-only for this endpoint
  (`Prime_AmountOfUsd`).
