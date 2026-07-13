---
name: creditkarma-fpx
description: >-
  Query Credit Karma (creditkarma.com) transactions from a shell with the fpx
  CLI (@fetchproxy/cli) instead of running the creditkarma-mcp server —
  capture the signed-in session cookie once, then curl the GraphQL
  transactions endpoint directly. Use when you want Credit Karma transaction
  data without the MCP, in a script, or on a machine where the MCP isn't
  installed.
---

# Credit Karma via fpx + curl (no MCP)

Credit Karma has **no server-side login** a script can drive — the only
credential is the `CKAT`/`CKTRKID` cookies a real signed-in browser session
already holds. There's also no bot wall on the API itself once you have
those cookies: `creditkarma-mcp`'s own `client.ts` proves plain Node `fetch`
works fine against `api.creditkarma.com/graphql` and the refresh endpoint —
fetchproxy is only ever used for the **one-time cookie capture**, never as a
request path. So this skill is **hybrid**: `fpx` grabs the cookies once,
then plain `curl` does every read and refresh from then on.

This mirrors the one live endpoint `creditkarma-mcp` actually calls
(`ck_sync_transactions` → the GraphQL query in `src/transaction.graphql`).
The other `ck_*` tools (`ck_list_transactions`, `ck_get_spending_by_category`,
…) are local SQLite queries over already-synced data — there's no separate
remote endpoint to reproduce for those.

## One-time setup

```sh
npm install -g @fetchproxy/cli                                  # provides `fpx`
fpx profile add creditkarma --domain creditkarma.com
fpx profile declare creditkarma --cookie CKAT --cookie CKTRKID   # widen scope to these cookies
fpx pair -p creditkarma                                          # prints a pair code → approve in Transporter
```

Requirements: the **Transporter** browser extension installed, with an open
`www.creditkarma.com` tab you're signed into, and its Chrome **Site access**
allowing `creditkarma.com`. `CKAT`/`CKTRKID` are `HttpOnly` (invisible to page
JS) but `fpx cookies` reads them via the extension's `chrome.cookies.get`,
same as `@fetchproxy/bootstrap` does inside the MCP. Pairing persists across
invocations.

## Capture the session (once per shell / once the token goes stale)

```sh
fpx cookies -p creditkarma
# {"CKAT":"<accessJWT>%3B<refreshJWT>","CKTRKID":"<value>"}
```

`CKAT` packs both JWTs joined by a literal `%3B` (URL-encoded `;`). Split it:

```sh
COOKIES=$(fpx cookies -p creditkarma)
CKAT=$(jq -r '.CKAT' <<<"$COOKIES" | sed 's/%3B/;/')
CKTRKID=$(jq -r '.CKTRKID' <<<"$COOKIES")
ACCESS=${CKAT%%;*}
REFRESH=${CKAT#*;}
```

## Core call: fetch a page of transactions

POST the reverse-engineered query (`src/transaction.graphql` in this repo —
too large to inline; ~3800 lines because Credit Karma's app bundle carries
hundreds of unrelated fragments alongside the ~30 lines the query body
actually selects) to `https://api.creditkarma.com/graphql` with a bearer
access token:

```sh
CK_DIR=~/git/creditkarma-mcp   # wherever this repo is checked out

jq -n --rawfile q "$CK_DIR/src/transaction.graphql" \
  --argjson vars '{"input":{"paginationInput":{"afterCursor":null},
    "categoryInput":{"categoryId":null,"primeCategoryType":null},
    "datePeriodInput":{"datePeriod":null},"accountInput":{}}}' \
  '{query:$q, variables:$vars}' > /tmp/ck-body.json

curl -s https://api.creditkarma.com/graphql -X POST \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.creditkarma.com' \
  -H 'Referer: https://www.creditkarma.com/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  --data @/tmp/ck-body.json \
  | jq '.data.prime.transactionsHub.transactionPage'
```

## The one rule: cursor-paginate, and check for an auth error INSIDE the 200 body

Credit Karma's *primary* expired-token signal is an HTTP-200 body carrying an
`errorCode` — not an HTTP 401. Always check before trusting the payload:

```sh
jq -r '.errorCode // (.errors[]?.errorCode) // (.errors[]?.code) // (.errors[]?.extensions.code) // empty' response.json
```

If that value matches `UNAUTHENTICATED|UNAUTHORIZED|TOKEN_EXPIRED|401`
(case-insensitive), the access token expired — refresh it (below) and retry.
Anything else (schema drift, validation) is a real error, not an auth
failure — don't refresh on it. A `FORBIDDEN`/403-shaped code means
authenticated-but-not-authorized; refreshing won't help.

For the next page, re-run the same body with
`variables.input.paginationInput.afterCursor` set to the previous response's
`pageInfo.endCursor`, and stop when `pageInfo.hasNextPage` is `false`. See
`references/requests.md` for the full loop.

## Refreshing the access token (no need to re-run `fpx` for this)

The access token is short-lived (~10 min). Refresh with the `refreshToken`
you already extracted — this is a plain `curl`, not another `fpx` capture:

```sh
GLID=$(node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url').toString()).glid||'')" "$ACCESS")

curl -s https://www.creditkarma.com/member/oauth2/refresh -X POST \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://www.creditkarma.com' \
  -H 'Referer: https://www.creditkarma.com/' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -H 'ck-client-name: web' -H 'ck-client-version: 1.0.0' -H 'ck-device-type: Desktop' \
  -H "Authorization: Bearer $ACCESS" \
  -H "ck-trace-id: $GLID" \
  -H "ck-cookie-id: $CKTRKID" \
  -H "Cookie: CKTRKID=$CKTRKID; CKAT=$ACCESS%3B$REFRESH" \
  --data "$(jq -n --arg rt "$REFRESH" '{refreshToken:$rt}')" \
  | jq '{accessToken, refreshToken}'
```

A non-JSON (HTML) error body from this endpoint means the refresh token
itself is dead — re-sign into `creditkarma.com` in the browser and re-run
`fpx cookies -p creditkarma` to capture a fresh `CKAT`/`CKTRKID` pair.

## Output / exit-code contract

- `fpx cookies`/`fpx session`/`fpx pair` are bridge round-trips: they exit
  `0` on a successful read regardless of upstream status, `1` on a usage
  error (e.g. an undeclared cookie key), `2` if the bridge/extension is
  unreachable or pairing is still pending.
- Reads and the refresh call go through plain `curl` — there's no fetchproxy
  bot-wall exit code (`3`) to check on them. Check the HTTP status yourself
  and, for the GraphQL call, the in-body `errorCode` above.

## Notes

- Never persist `ACCESS`/`REFRESH`/`CKAT` to a file you don't control the
  permissions of — treat them like the MCP's own `.env` (0600) if you must
  write them down at all; prefer keeping them in shell variables for the
  session.
- Amounts: negative = expense/debit, positive = credit/income
  (`amount.value`/`amount.asCurrencyString`).
- This project is developed and maintained by AI (Claude).
