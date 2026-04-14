#!/usr/bin/env bash
#
# Credit Karma MCP auth setup (thin wrapper).
#
# Launches Chrome with a dedicated profile so you can sign in to
# creditkarma.com, captures the CKAT cookie (holds the access + refresh
# JWTs), and either prints it or writes it to an env file you pass.
#
# Equivalent to running: npm run auth [-- ENV_FILE]
#
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/setup-auth.mjs "$@"
