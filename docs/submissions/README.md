# Registry submissions — creditkarma-mcp

Ready-to-paste copy for registries that need a manual browser-form submission. Automated pipelines fire on every `v*` tag via `.github/workflows/release.yml`.

## Coverage matrix

| Registry                          | Automated?                               | Where |
| --- | --- | --- |
| npm                               | ✅ `release.yml`                          | `npm publish --provenance` |
| GitHub Releases                   | ✅ `release.yml`                          | `.skill` + `.mcpb` attached |
| modelcontextprotocol/registry     | ✅ `release.yml` (OIDC)                   | `mcp-publisher publish` using `server.json` |
| PulseMCP                          | ✅ transitive (auto-ingests weekly)       | — |
| ClawHub (OpenClaw)                | ✅ conditional on `CLAWHUB_TOKEN`         | `clawhub skill publish` |
| mcpservers.org                    | ❌ manual — [mcpservers.org/submit](https://mcpservers.org/submit) | |
| Anthropic community plugins       | ❌ manual — [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission) | |

## mcpservers.org

- **Server Name:** `creditkarma-mcp`
- **Short Description:** `Credit Karma transaction tracking for Claude — sync and query your transactions, spending by category and merchant, and account summaries via natural language`
- **Link:** `https://github.com/chrischall/creditkarma-mcp`
- **Category:** `Finance`
- **Contact Email:** `chris.c.hall@gmail.com`

## Anthropic community plugins

- **Repo URL:** `https://github.com/chrischall/creditkarma-mcp`
- **Plugin name:** `creditkarma-mcp`
- **Short description:** `Credit Karma transaction tracking for Claude — sync and query your transactions, spending by category and merchant, and account summaries via natural language`
- **Category:** Finance
- **Tags:** creditkarma, transactions, finance, spending, accounts, mcp
