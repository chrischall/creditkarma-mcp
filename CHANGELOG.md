# Changelog

## [2.2.2](https://github.com/chrischall/creditkarma-mcp/compare/v2.2.1...v2.2.2) (2026-06-04)


### Bug Fixes

* adopt @fetchproxy/server 0.13.0 (bridge host failover + re-pairing) ([#53](https://github.com/chrischall/creditkarma-mcp/issues/53)) ([07de705](https://github.com/chrischall/creditkarma-mcp/commit/07de7055bb01544b5d69088648c0261f4de8fe3e))
* adopt @fetchproxy/server 1.0.0 + @chrischall/mcp-utils 0.5.0 ([#55](https://github.com/chrischall/creditkarma-mcp/issues/55)) ([8d5b0ae](https://github.com/chrischall/creditkarma-mcp/commit/8d5b0aedbd453bb6bb611c7470ad6df58a4480be))

## [2.2.1](https://github.com/chrischall/creditkarma-mcp/compare/v2.2.0...v2.2.1) (2026-05-29)


### Bug Fixes

* **ci:** auto-merge arm guards ([#43](https://github.com/chrischall/creditkarma-mcp/issues/43)) ([31227ed](https://github.com/chrischall/creditkarma-mcp/commit/31227ed8e2c30c887889298fb7848b521b615e37))

## [2.2.0](https://github.com/chrischall/creditkarma-mcp/compare/v2.1.4...v2.2.0) (2026-05-28)


### Features

* **deps:** adopt @fetchproxy/bootstrap 0.8.0 for SW-eviction-resilient startup capture ([#40](https://github.com/chrischall/creditkarma-mcp/issues/40)) ([321c189](https://github.com/chrischall/creditkarma-mcp/commit/321c189279f8e1afee562915f00e511d343e0360))

## [2.1.4](https://github.com/chrischall/creditkarma-mcp/compare/v2.1.3...v2.1.4) (2026-05-26)


### Bug Fixes

* **ci:** substitute repo name in publish workflow ([#37](https://github.com/chrischall/creditkarma-mcp/issues/37)) ([7fe3c7a](https://github.com/chrischall/creditkarma-mcp/commit/7fe3c7ad4d5b30f1c165cebbe6caf13c3d96d035))

## [2.1.3](https://github.com/chrischall/creditkarma-mcp/compare/v2.1.2...v2.1.3) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#35](https://github.com/chrischall/creditkarma-mcp/issues/35)) ([f08d2e2](https://github.com/chrischall/creditkarma-mcp/commit/f08d2e26b64e21a60986b32e602325947483e930))

## [2.1.2](https://github.com/chrischall/creditkarma-mcp/compare/v2.1.1...v2.1.2) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#32](https://github.com/chrischall/creditkarma-mcp/issues/32)) ([9c33a33](https://github.com/chrischall/creditkarma-mcp/commit/9c33a336bd0329809d1f27ce9f9dd422ed28598c))

## [2.1.1](https://github.com/chrischall/creditkarma-mcp/compare/v2.1.0...v2.1.1) (2026-05-24)


### Documentation

* add Acknowledgement of Terms section to README ([#26](https://github.com/chrischall/creditkarma-mcp/issues/26)) ([bef799f](https://github.com/chrischall/creditkarma-mcp/commit/bef799f97d6d9b27fcb904c712cf4f5e75d328dc))
* canonical auto-merge guidance ([#29](https://github.com/chrischall/creditkarma-mcp/issues/29)) ([811a23e](https://github.com/chrischall/creditkarma-mcp/commit/811a23e18bb592108319a3f402e94513edd77a7b))
* **claude-md:** call out 100-char limit on server.json description ([5b56a04](https://github.com/chrischall/creditkarma-mcp/commit/5b56a048e5474eb719c90b436e63a69e6d330ab7))
* **claude-md:** call out 100-char limit on server.json description ([a5d9d49](https://github.com/chrischall/creditkarma-mcp/commit/a5d9d49a67749fcf8991fbe300822e7b0942afbd))
* correct release-please PR handling in merge guidance ([#30](https://github.com/chrischall/creditkarma-mcp/issues/30)) ([e4f178b](https://github.com/chrischall/creditkarma-mcp/commit/e4f178bb3aa61f0f5000e099c1aa4539d971de46))

## [2.1.0](https://github.com/chrischall/creditkarma-mcp/compare/v2.0.11...v2.1.0) (2026-05-22)


### Features

* @fetchproxy/bootstrap as a third auth path ([fbf8acc](https://github.com/chrischall/creditkarma-mcp/commit/fbf8acc961cf57b3acbb9df2717639e5b89d777c))
* add .mcpb bundle support ([1633d17](https://github.com/chrischall/creditkarma-mcp/commit/1633d172a12f79409a124e6cdbd9e3f0f10d209a))
* add Claude Code plugin distribution files ([bc027f2](https://github.com/chrischall/creditkarma-mcp/commit/bc027f21d94891286e6064a453f12c0a5010eb90))
* add MCP tool annotations for read-only vs approval-required tools ([686240b](https://github.com/chrischall/creditkarma-mcp/commit/686240bd2f8001d4316ad7f0cee744281b7221c9))
* add scripted browser auth capture via puppeteer-core ([0560701](https://github.com/chrischall/creditkarma-mcp/commit/056070101cb5b671084bf9ed99c2f23d0f9fbafc))
* auth tools (ck_set_token, ck_login, ck_submit_mfa) ([62486b6](https://github.com/chrischall/creditkarma-mcp/commit/62486b6fe841a72a4891519d16c488dba1dbd434))
* **auth:** add --manual mode with secure no-echo paste prompt ([e53b4c4](https://github.com/chrischall/creditkarma-mcp/commit/e53b4c479548401e230f227f30c11ae5fe5fc617))
* ck_list_transactions and ck_get_recent_transactions ([ab9572a](https://github.com/chrischall/creditkarma-mcp/commit/ab9572a48e94327f78ff136e5c342c0d79bb8154))
* ck_query_sql with SELECT-only guard ([2610b47](https://github.com/chrischall/creditkarma-mcp/commit/2610b47b12a9793c6598445786ba4653fec8bb03))
* ck_sync_transactions with incremental sync and auto-login ([224d622](https://github.com/chrischall/creditkarma-mcp/commit/224d622143603a1129ca34516d94c397106c65c3))
* complete creditkarma-mcp implementation ([00df4ba](https://github.com/chrischall/creditkarma-mcp/commit/00df4ba507377fc9cd70000f00280f5386afc451))
* CreditKarmaClient token management ([a333de6](https://github.com/chrischall/creditkarma-mcp/commit/a333de6d908bf1e83fc9d7e6c7d54e3a411b500b))
* database schema and initDb ([1fe8f6d](https://github.com/chrischall/creditkarma-mcp/commit/1fe8f6d00272379475927e583fbc8e319001a76f))
* **deploy:** registry listings for MCP Registry, Claude plugins, ClawHub, PulseMCP, mcpservers.org ([3a77f1f](https://github.com/chrischall/creditkarma-mcp/commit/3a77f1fdd989e468be20f02d6777567fb6e20243))
* implement CK-native token refresh with CKAT cookie session setup ([50dd06f](https://github.com/chrischall/creditkarma-mcp/commit/50dd06f839a0e350d50491f89fbe896eb36204ca))
* MCP server wiring — all 10 tools registered ([5eeeecd](https://github.com/chrischall/creditkarma-mcp/commit/5eeeecdba45c7e7475ae95fc4d60519d0a72a220))
* optional @fetchproxy/bootstrap fallback for auth ([6163f01](https://github.com/chrischall/creditkarma-mcp/commit/6163f01860d5fcbd57000d808b618652fa3bfe0b))
* query tools (list, recent, by-category, by-merchant, account-summary) ([604edda](https://github.com/chrischall/creditkarma-mcp/commit/604edda13a7c6180c75dbd011db91f676a892f14))
* row types and upsert helpers ([2062c13](https://github.com/chrischall/creditkarma-mcp/commit/2062c13042923728ae23ce9715c3b0ed7d3ccce8))
* simplify session setup to single CK_COOKIES env var ([094215d](https://github.com/chrischall/creditkarma-mcp/commit/094215d5348c308b65df89bb7137722cb070deb6))
* store credentials in .env instead of .mcp.json ([9e860f4](https://github.com/chrischall/creditkarma-mcp/commit/9e860f4b2b04eead7270a7894e67180788031938))
* sync state helpers ([023c2f4](https://github.com/chrischall/creditkarma-mcp/commit/023c2f449be3774ebbef8b01a2d59e3213c39f06))


### Bug Fixes

* add NODE_AUTH_TOKEN to npm publish step ([b9f9936](https://github.com/chrischall/creditkarma-mcp/commit/b9f99364ae940665dd6606fa46615e1b93e68ef3))
* **auth:** bypass CK bot detection, capture CKAT only, hard-kill Chrome ([529938f](https://github.com/chrischall/creditkarma-mcp/commit/529938f2080d664c4f3b68324b7d414b2de8fe61))
* bump @types/node to ^22, split setup-node for publish to silence warnings ([54f13a4](https://github.com/chrischall/creditkarma-mcp/commit/54f13a4116e8274fe5af9913bb15e8234d55d388))
* cast query result through unknown for node:sqlite type compatibility ([827df38](https://github.com/chrischall/creditkarma-mcp/commit/827df38a015616ce609f727bcfa8d2c28dab219d))
* copy transaction.graphql to dist on build ([7bbdc88](https://github.com/chrischall/creditkarma-mcp/commit/7bbdc88dad9ebbc7552546ad64d834d7fd2357a8))
* correct GraphQL variables and add mid-sync token refresh retry ([57a7b31](https://github.com/chrischall/creditkarma-mcp/commit/57a7b314df3804ece3ad3f55fe29f3d42ae072ab))
* correct stale ck_login reference in TOKEN_EXPIRED error message ([06c42f2](https://github.com/chrischall/creditkarma-mcp/commit/06c42f2c2a8b40a6d1612de6650a7e05d663a970))
* **deploy:** shorten server.json description to ≤100 chars for MCP Registry ([4dfc518](https://github.com/chrischall/creditkarma-mcp/commit/4dfc518cf1b02339d3189aa8109938b68be29639))
* **env:** also reject literal "undefined"/"null" in readVar ([88a1f39](https://github.com/chrischall/creditkarma-mcp/commit/88a1f396095413839e2c71c5bd2ce009c18481af))
* **env:** treat blank/whitespace/placeholder env vars as unset ([d40556d](https://github.com/chrischall/creditkarma-mcp/commit/d40556df56743b2d1a1857a2bb3e01d0ffc7f7c5))
* escape LIKE wildcards in filter params, narrow param type ([1e2c3fc](https://github.com/chrischall/creditkarma-mcp/commit/1e2c3fc89e2765b1d7a03c43311f1410d5132aeb))
* **index:** silence dotenv v17 stdout banner (breaks JSON-RPC over stdio) ([9e7e8c2](https://github.com/chrischall/creditkarma-mcp/commit/9e7e8c2f99c9377333a14c85ebd5af4dbdecfc0b))
* load .env relative to script location, not cwd ([d12cf13](https://github.com/chrischall/creditkarma-mcp/commit/d12cf1356a8a4bf00e58d372440c1d2d2a9bf82d))
* resolve __dirname scope bug causing mcpb startup crash; align to ofw-mcp ([1b007aa](https://github.com/chrischall/creditkarma-mcp/commit/1b007aad8cc60d10f616dd4d40e084627c66c0ec))
* strip block comments before SELECT guard, add tests ([fae7144](https://github.com/chrischall/creditkarma-mcp/commit/fae7144a7957a0d397596f6a75fd05045efeeabd))
* suppress dotenv stdout logging to prevent MCP JSON parse errors ([d6fb776](https://github.com/chrischall/creditkarma-mcp/commit/d6fb7767d5447fb245174b3be20189668a82ac12))
* TransactionRow nullable foreign key fields ([e030894](https://github.com/chrischall/creditkarma-mcp/commit/e030894b0f45bcfd9f0a98c18a32d7c64028d6d3))
* use esbuild ^0.27.0 to match vite 8 peer dep ([717caf4](https://github.com/chrischall/creditkarma-mcp/commit/717caf41e2bbbbf9f0dfb22c2782991873f026c3))
* use RELEASE_PAT secret for npm publish ([eba2784](https://github.com/chrischall/creditkarma-mcp/commit/eba2784351c588f58fd38f4ca24f8fda4ff6cbed))


### Refactor

* remove ck_set_token — fully cookie-based auth via ck_set_session ([35c6384](https://github.com/chrischall/creditkarma-mcp/commit/35c638458589d71f5c2cae8818634656610663b2))
* replace better-sqlite3 with built-in node:sqlite, remove tsx ([7252bb3](https://github.com/chrischall/creditkarma-mcp/commit/7252bb31c72d807d7f7d5f3d57472597f5e3ba6b))
* sync - remove dead code, add tx wrapper, add first-page failure test ([8790301](https://github.com/chrischall/creditkarma-mcp/commit/879030145bac4cf4153e41b47cf349e2203bffae))


### Documentation

* add README, SKILL.md, and GitHub Actions workflows ([2cadae3](https://github.com/chrischall/creditkarma-mcp/commit/2cadae3d60f9a9728ec68eb9607baab1b22980e9))
* align CLAUDE.md merge guidance with repo settings ([29ec073](https://github.com/chrischall/creditkarma-mcp/commit/29ec073e49b8bfc3bf87388d20998c6db3a03022))
* remove ck_login references from README and SKILL.md ([8d1f97f](https://github.com/chrischall/creditkarma-mcp/commit/8d1f97f7bf3d84796b99b73a8ee0a563f1fd6b7a))
