---
name: creditkarma-mcp
description: Access Credit Karma transaction data via MCP. Use when the user asks about their Credit Karma transactions, spending by category or merchant, account summaries, or wants to sync or query their financial data. Triggers on phrases like "sync my transactions", "what did I spend on", "show my Credit Karma data", "spending by category", "top merchants", or any request involving personal finance data from Credit Karma. Requires creditkarma-mcp installed and the creditkarma server registered (see Setup below).
---

# creditkarma-mcp

MCP server for Credit Karma — syncs transactions into a local SQLite database and provides natural-language querying tools.

- **Source:** [github.com/chrischall/creditkarma-mcp](https://github.com/chrischall/creditkarma-mcp)

## Setup

Add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "creditkarma": {
      "command": "node",
      "args": ["/path/to/creditkarma-mcp/dist/index.js"],
      "env": {
        "CK_COOKIES": "your-ckat-value-here"
      }
    }
  }
}
```

Or use a `.env` file in the project directory with `CK_COOKIES=<value>`.

### Getting CK_COOKIES

1. Log in to [creditkarma.com](https://www.creditkarma.com) in Chrome
2. DevTools → **Application** → **Cookies** → `creditkarma.com`
3. Copy the `CKAT` cookie value

Accepts: raw CKAT value, `CKAT=<value>`, or the full Cookie header string from any CK network request.

## Authentication

Call `ck_set_session` with your cookie value to store credentials and enable auto-refresh.

- Access token: ~15 min TTL, auto-refreshed transparently
- Refresh token: ~8 hours TTL
- When expired: log in to creditkarma.com, grab the new CKAT cookie, call `ck_set_session`

## Tools

### Auth
| Tool | Description |
|------|-------------|
| `ck_set_session(cookies)` | Store credentials — accepts CKAT value, `CKAT=<value>`, or full Cookie header |

### Sync
| Tool | Description |
|------|-------------|
| `ck_sync_transactions(force_full?)` | Sync transactions to local SQLite. Incremental by default (since last sync − 30 days). `force_full=true` re-fetches everything. |

### Query
| Tool | Description |
|------|-------------|
| `ck_list_transactions(start_date?, end_date?, account?, category?, merchant?, status?, min_amount?, max_amount?, limit?, offset?)` | Filtered, paginated transaction list |
| `ck_get_recent_transactions(limit?)` | N most recent transactions (default 20) |
| `ck_get_spending_by_category(start_date?, end_date?)` | Spending totals grouped by category |
| `ck_get_spending_by_merchant(start_date?, end_date?, limit?)` | Spending totals grouped by merchant |
| `ck_get_account_summary` | Transaction counts and totals per account |
| `ck_query_sql(sql)` | Read-only SQL query against the local database (SELECT only) |

## Workflows

**First-time setup:**
1. Log in to [creditkarma.com](https://www.creditkarma.com) in Chrome
2. DevTools → Application → Cookies → copy the `CKAT` value
3. `ck_set_session(cookies)` → credentials stored
4. `ck_sync_transactions` → initial full sync

**Regular use:**
- `ck_sync_transactions` → pull latest transactions
- Then query with any of the query tools

**Spending analysis:**
```
ck_sync_transactions
ck_get_spending_by_category(start_date: "2026-01-01", end_date: "2026-03-31")
ck_get_spending_by_merchant(start_date: "2026-01-01", limit: 10)
```

**Custom analysis with SQL:**
```sql
-- Monthly spending totals
SELECT strftime('%Y-%m', date) AS month, SUM(ABS(amount)) AS total
FROM transactions WHERE amount < 0
GROUP BY month ORDER BY month DESC

-- Spending by category this year
SELECT c.name, SUM(ABS(t.amount)) AS total
FROM transactions t JOIN categories c ON t.category_id = c.id
WHERE t.date >= '2026-01-01' AND t.amount < 0
GROUP BY c.name ORDER BY total DESC
```

## Database schema

```sql
transactions (id, date, description, status, amount, account_id, category_id, merchant_id, raw_json)
accounts     (id, name, type, provider_name, display)
categories   (id, name, type)
merchants    (id, name)
sync_state   (key, value)
```

## Notes

- All query tools run against the local SQLite database — sync first
- Amounts: negative = expense/debit, positive = credit/income
- `ck_query_sql` only allows SELECT — no writes to Credit Karma data
- Sync saves a resume cursor — interrupted syncs can be resumed automatically
