import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, existsSync } from 'fs'
import { dirname } from 'path'
import { deriveAccountId, parseLast4 } from './accountId.js'
import type { CreditReportAccount } from './creditReport.js'
import type { BalanceSnapshot } from './matching.js'

export type Database = DatabaseSync

const CURRENT_VERSION = 3

/**
 * One function per schema version. Each runs inside its own transaction (see
 * {@link initDb}), so a failure part-way leaves the previous version intact
 * rather than a half-migrated file. Exported so tests can inject a failure.
 */
export const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT,
      provider_name TEXT,
      display       TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT
    );

    CREATE TABLE IF NOT EXISTS merchants (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      date        TEXT NOT NULL,
      description TEXT NOT NULL,
      status      TEXT,
      amount      REAL NOT NULL,
      account_id  TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      merchant_id TEXT REFERENCES merchants(id),
      raw_json    TEXT,
      synced_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT OR IGNORE INTO schema_version VALUES (1);
  `),
  2: migrateToV2,
  // v3: a credit-report row that is the same account as a linked one points at
  // it here, and is hidden from listings (see src/matching.ts).
  3: (db) => db.exec(`
    ALTER TABLE accounts ADD COLUMN matched_account_id TEXT;
    INSERT OR IGNORE INTO schema_version VALUES (3);
  `),
}

/**
 * v2: account balances, plus the account-identity cleanup they depend on.
 *
 * - Balance columns on `accounts`. Money is REAL in USD with the transaction
 *   sign convention: assets positive, liabilities (card balances, loans)
 *   negative. `credit_limit` is always positive.
 * - `provider_name` trimmed (CK pads some, e.g. "Ally   ").
 * - `last4` parsed from `display`, NULL when CK shows something else there.
 * - `account_urn` backfilled from transactions' raw_json, but only where it is
 *   unambiguous: one URN per account AND one account per URN.
 * - The same card listed under two provider-name variants ("X" vs
 *   "X - Credit Cards") is folded into one row — see {@link mergeProviderVariants}.
 */
function migrateToV2(db: Database): void {
  for (const col of [
    'account_urn TEXT', 'last4 TEXT', 'current_balance REAL', 'available_balance REAL',
    'credit_limit REAL', 'balance_as_of TEXT', 'balances_synced_at TEXT', 'balance_source TEXT',
  ]) {
    db.exec(`ALTER TABLE accounts ADD COLUMN ${col}`)
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_urn ON accounts(account_urn) WHERE account_urn IS NOT NULL;
    CREATE TABLE IF NOT EXISTS account_aliases (
      alias      TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id)
    );
    UPDATE accounts SET provider_name = TRIM(provider_name) WHERE provider_name IS NOT NULL;
  `)

  const setLast4 = db.prepare('UPDATE accounts SET last4 = ? WHERE id = ?')
  for (const a of db.prepare('SELECT id, display FROM accounts').all() as Array<{ id: string, display: string | null }>) {
    setLast4.run(parseLast4(a.display), a.id)
  }

  backfillUrns(db)
  mergeProviderVariants(db)
  db.exec('INSERT OR IGNORE INTO schema_version VALUES (2)')
}

function backfillUrns(db: Database): void {
  const urnsByAccount = new Map<string, Set<string>>()
  const accountsByUrn = new Map<string, Set<string>>()
  const rows = db
    .prepare('SELECT account_id, raw_json FROM transactions WHERE account_id IS NOT NULL AND raw_json IS NOT NULL')
    .all() as Array<{ account_id: string, raw_json: string }>
  for (const r of rows) {
    let urn: unknown
    try {
      urn = (JSON.parse(r.raw_json) as { account?: { accountURN?: unknown } }).account?.accountURN
    } catch {
      continue
    }
    if (typeof urn !== 'string' || urn === '') continue
    if (!urnsByAccount.has(r.account_id)) urnsByAccount.set(r.account_id, new Set())
    urnsByAccount.get(r.account_id)!.add(urn)
    if (!accountsByUrn.has(urn)) accountsByUrn.set(urn, new Set())
    accountsByUrn.get(urn)!.add(r.account_id)
  }
  const set = db.prepare('UPDATE accounts SET account_urn = ? WHERE id = ?')
  for (const [accountId, urns] of urnsByAccount) {
    const [urn] = urns
    if (urns.size === 1 && accountsByUrn.get(urn)!.size === 1) set.run(urn, accountId)
  }
}

/**
 * Fold rows that are one card listed under two provider-name variants.
 *
 * CK has reported the same card as "Capital One" and as "Capital One - Credit
 * Cards", and the synthetic `provider|last4` id turns that into two accounts.
 * Rows merge only when ALL of these hold, so unrelated accounts never do:
 * - the provider names agree before any " - " suffix (case-insensitive) —
 *   two different banks sharing a last4 stay apart;
 * - `last4` is a real four-digit number, not garbage like "ount";
 * - they carry at most one distinct URN between them.
 *
 * The row with the most transactions survives (ties: the smaller id); the
 * others' transactions move to it and their ids become aliases, so a later
 * sync that derives a retired id lands on the survivor instead of recreating it.
 */
function mergeProviderVariants(db: Database): void {
  const accounts = db.prepare(`
    SELECT a.id, a.provider_name, a.last4, a.account_urn,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
    FROM accounts a
    WHERE a.last4 IS NOT NULL AND a.provider_name IS NOT NULL
  `).all() as Array<{ id: string, provider_name: string, last4: string, account_urn: string | null, tx_count: number }>

  const groups = new Map<string, typeof accounts>()
  for (const a of accounts) {
    const key = `${a.provider_name.split(' - ')[0].trim().toLowerCase()}|${a.last4}`
    groups.set(key, [...(groups.get(key) ?? []), a])
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const urns = new Set(group.map(a => a.account_urn).filter((u): u is string => u !== null))
    if (urns.size > 1) continue
    group.sort((a, b) => b.tx_count - a.tx_count || (a.id < b.id ? -1 : 1))
    const [survivor, ...retired] = group
    for (const r of retired) {
      db.prepare('UPDATE transactions SET account_id = ? WHERE account_id = ?').run(survivor.id, r.id)
      db.prepare('UPDATE account_aliases SET account_id = ? WHERE account_id = ?').run(survivor.id, r.id)
      db.prepare('INSERT OR REPLACE INTO account_aliases (alias, account_id) VALUES (?, ?)').run(r.id, survivor.id)
      db.prepare('DELETE FROM accounts WHERE id = ?').run(r.id)
    }
    const [urn] = urns
    if (urn !== undefined) db.prepare('UPDATE accounts SET account_urn = ? WHERE id = ?').run(urn, survivor.id)
  }
}

export function initDb(dbPath: string): Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  const currentVersion = tableExists
    ? ((db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0)
    : 0

  for (let v = currentVersion + 1; v <= CURRENT_VERSION; v++) {
    db.exec('BEGIN')
    try {
      MIGRATIONS[v](db)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (dbPath !== ':memory:') {
    hardenDbPermissions(dbPath)
  }

  return db
}

/**
 * Assert hardened modes on the DB and its parent directory (0700 dir / 0600
 * files) on every open — SQLite creates files with default (world-readable)
 * permissions, and modes set at creation don't help pre-existing files.
 * Mirrors `SessionStore.saveToDisk` in @chrischall/mcp-utils. The `-wal`/`-shm`
 * sidecars may not exist yet (they appear on first use), so they're chmodded
 * only when present. Exported for direct testing.
 */
export function hardenDbPermissions(dbPath: string): void {
  chmodSync(dirname(dbPath), 0o700)
  chmodSync(dbPath, 0o600)
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
  }
}

export interface AccountRow {
  id: string
  name: string
  type?: string | null
  providerName?: string | null
  display?: string | null
}

export interface CategoryRow {
  id: string
  name: string
  type?: string | null
}

export interface MerchantRow {
  id: string
  name: string
}

export interface TransactionRow {
  id: string
  date: string
  description: string
  status: string
  amount: number
  accountId: string | null
  categoryId: string | null
  merchantId: string | null
  rawJson: string | null
}

export function upsertAccount(db: Database, row: AccountRow): void {
  // Balance columns are deliberately untouched: they belong to the balance
  // sync, and a transaction page re-upserting metadata must not wipe them.
  db.prepare(`
    INSERT INTO accounts (id, name, type, provider_name, display, last4)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      provider_name = excluded.provider_name,
      display = excluded.display,
      last4 = excluded.last4
  `).run(
    row.id, row.name, row.type ?? null, row.providerName?.trim() ?? null,
    row.display ?? null, parseLast4(row.display),
  )
}

/**
 * The account a transaction belongs to. A row already holding the transaction's
 * URN wins — that survives CK renaming the provider — then an alias left by a
 * merge, then the synthetic id itself.
 */
export function resolveAccountId(db: Database, derivedId: string, urn?: string | null): string {
  const byUrn = urn ? findAccountByUrn(db, urn) : null
  if (byUrn) return byUrn
  const alias = db.prepare('SELECT account_id FROM account_aliases WHERE alias = ?').get(derivedId) as { account_id: string } | undefined
  return alias?.account_id ?? derivedId
}

/**
 * The URN-less account a vault account belongs to: same institution
 * (case-insensitive, trimmed) and same real last4, holding no URN yet — its
 * transactions predate CK sending URNs. Only when exactly one fits; anything
 * ambiguous gets its own row rather than a wrong home. Credit-report rows are
 * never candidates.
 */
export function findUnlinkedAccount(db: Database, provider: string, last4: string | null): string | null {
  if (!last4) return null
  const rows = db.prepare(`
    SELECT id FROM accounts
    WHERE last4 = ? AND LOWER(TRIM(provider_name)) = ? AND account_urn IS NULL
      AND balance_source IS NOT 'credit_report'
  `).all(last4, provider.trim().toLowerCase()) as Array<{ id: string }>
  return rows.length === 1 ? rows[0].id : null
}

/** The account holding `urn`, if any. */
export function findAccountByUrn(db: Database, urn: string): string | null {
  const row = db.prepare('SELECT id FROM accounts WHERE account_urn = ?').get(urn) as { id: string } | undefined
  return row?.id ?? null
}

/** Record `urn` on an account that has none, unless another row already holds it. */
export function attachUrn(db: Database, accountId: string, urn: string): void {
  db.prepare(`
    UPDATE accounts SET account_urn = ?
    WHERE id = ? AND account_urn IS NULL
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE account_urn = ?)
  `).run(urn, accountId, urn)
}

export function upsertCreditReportAccount(db: Database, a: CreditReportAccount, syncedAt: string): void {
  db.prepare(`
    INSERT INTO accounts (id, name, type, provider_name, display, last4, current_balance, available_balance,
                          credit_limit, balance_as_of, balances_synced_at, balance_source)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, 'credit_report')
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      provider_name = excluded.provider_name,
      current_balance = excluded.current_balance,
      credit_limit = excluded.credit_limit,
      balance_as_of = excluded.balance_as_of,
      balances_synced_at = excluded.balances_synced_at,
      balance_source = excluded.balance_source
  `).run(a.key, a.institution ?? a.type, a.type, a.institution, a.currentBalance, a.creditLimit, a.asOf, syncedAt)
}

/**
 * Delete credit-report rows absent from the latest report (closed, or from a
 * bureau no longer used). A row that somehow has transactions is kept.
 * Returns how many were removed.
 */
export function pruneCreditReportAccounts(db: Database, keep: string[]): number {
  const placeholders = keep.map(() => '?').join(', ')
  const result = db.prepare(`
    DELETE FROM accounts
    WHERE balance_source = 'credit_report'
      ${keep.length > 0 ? `AND id NOT IN (${placeholders})` : ''}
      AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id)
  `).run(...keep)
  return Number(result.changes)
}

export interface LinkedBalanceRow {
  id: string
  urn: string
  name: string
  provider: string
  last4: string | null
  type: string
  /** Liabilities negative. */
  balance: number
  creditLimit: number | null
  availableCredit: number | null
  asOf: string | null
  syncedAt: string
}

/**
 * Record a linked account's balance from the Intuit vault. An existing row
 * keeps its name and display (those come from transactions) and only gains
 * metadata it lacks; a new one is created from the vault's. The URN is
 * attached unless another row already holds it.
 */
export function setLinkedBalance(db: Database, b: LinkedBalanceRow): void {
  db.prepare(`
    INSERT INTO accounts (id, name, type, provider_name, display, last4, current_balance, available_balance,
                          credit_limit, balance_as_of, balances_synced_at, balance_source)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'linked')
    ON CONFLICT(id) DO UPDATE SET
      type = COALESCE(accounts.type, excluded.type),
      provider_name = COALESCE(accounts.provider_name, excluded.provider_name),
      last4 = COALESCE(accounts.last4, excluded.last4),
      current_balance = excluded.current_balance,
      available_balance = excluded.available_balance,
      credit_limit = excluded.credit_limit,
      balance_as_of = excluded.balance_as_of,
      balances_synced_at = excluded.balances_synced_at,
      balance_source = excluded.balance_source
  `).run(b.id, b.name, b.type, b.provider, b.last4, b.balance, b.availableCredit, b.creditLimit, b.asOf, b.syncedAt)
  attachUrn(db, b.id, b.urn)
}

/**
 * Retire linked balances the latest vault refresh did not return (closed, or
 * no longer linked). A balance-only row is deleted; one with transactions
 * keeps its history and just stops being listed as a balance. Returns how
 * many rows were retired.
 */
export function pruneLinkedAccounts(db: Database, keep: string[]): number {
  const notKept = keep.length > 0 ? `AND id NOT IN (${keep.map(() => '?').join(', ')})` : ''
  const hasTx = 'EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id)'
  const deleted = db.prepare(`DELETE FROM accounts WHERE balance_source = 'linked' ${notKept} AND NOT ${hasTx}`).run(...keep)
  const unlisted = db.prepare(`
    UPDATE accounts SET balance_source = NULL, current_balance = NULL, available_balance = NULL,
                        credit_limit = NULL, balance_as_of = NULL, balances_synced_at = NULL
    WHERE balance_source = 'linked' ${notKept}
  `).run(...keep)
  return Number(deleted.changes) + Number(unlisted.changes)
}

/** Both sides of credit-report matching, as {@link matchCreditReportAccounts} takes them. */
export function loadMatchSnapshots(db: Database): { creditReport: BalanceSnapshot[]; linked: BalanceSnapshot[] } {
  const load = (where: string) => db.prepare(`
    SELECT id, provider_name AS institution, credit_limit AS creditLimit, current_balance AS balance,
           balance_as_of AS asOf
    FROM accounts WHERE ${where}
  `).all() as unknown as BalanceSnapshot[]
  return {
    creditReport: load("balance_source = 'credit_report'"),
    // Only liabilities can be the same account as a credit-report tradeline.
    linked: load("balance_source = 'linked' AND current_balance < 0"),
  }
}

/** Replace every credit-report row's match with `matches` (credit-report id → linked id). */
export function setCreditReportMatches(db: Database, matches: Map<string, string>): void {
  db.prepare("UPDATE accounts SET matched_account_id = NULL WHERE balance_source = 'credit_report'").run()
  const set = db.prepare('UPDATE accounts SET matched_account_id = ? WHERE id = ?')
  for (const [crId, linkedId] of matches) set.run(linkedId, crId)
}

export interface BalanceListRow {
  id: string
  name: string
  institution: string | null
  type: string | null
  last4: string | null
  current_balance: number | null
  available_balance: number | null
  credit_limit: number | null
  balance_as_of: string | null
  balances_synced_at: string | null
  balance_source: 'linked' | 'credit_report'
  /** For a credit-report row: the linked account it duplicates. */
  matched_to: string | null
}

/**
 * Accounts with a balance, linked first. A credit-report row matched to a
 * linked account is the same account seen weeks earlier, so it is hidden
 * unless `includeMatched`.
 */
export function listBalances(db: Database, opts: { includeMatched?: boolean } = {}): BalanceListRow[] {
  return db.prepare(`
    SELECT id, name, provider_name AS institution, type, last4, current_balance, available_balance,
           credit_limit, balance_as_of, balances_synced_at, balance_source, matched_account_id AS matched_to
    FROM accounts
    WHERE balance_source IS NOT NULL ${opts.includeMatched ? '' : 'AND matched_account_id IS NULL'}
    ORDER BY balance_source DESC, provider_name, name
  `).all() as unknown as BalanceListRow[]
}

export function upsertCategory(db: Database, row: CategoryRow): void {
  db.prepare(`
    INSERT INTO categories (id, name, type)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type
  `).run(row.id, row.name, row.type ?? null)
}

export function upsertMerchant(db: Database, row: MerchantRow): void {
  db.prepare(`
    INSERT INTO merchants (id, name)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `).run(row.id, row.name)
}

export function upsertTransaction(db: Database, row: TransactionRow): void {
  db.prepare(`
    INSERT INTO transactions (id, date, description, status, amount, account_id, category_id, merchant_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      date        = excluded.date,
      description = excluded.description,
      status      = excluded.status,
      amount      = excluded.amount,
      account_id  = excluded.account_id,
      category_id = excluded.category_id,
      merchant_id = excluded.merchant_id,
      raw_json    = excluded.raw_json,
      updated_at  = CURRENT_TIMESTAMP
  `).run(
    row.id, row.date, row.description, row.status, row.amount,
    row.accountId, row.categoryId, row.merchantId, row.rawJson
  )
}

export function getSyncState(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSyncState(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/**
 * Repair transactions whose `account_id` is `''` (or NULL) by re-deriving the
 * id from each transaction's `raw_json.account` and rebuilding the accounts
 * table. Idempotent — returns zero counts if there's nothing to fix.
 *
 * Needed because CK's `transactionsHub` historically returned empty
 * `account.id` strings, collapsing every account into a single row.
 */
export function backfillAccountIds(db: Database): { txsUpdated: number, accountsCreated: number } {
  const rows = db
    .prepare("SELECT id, raw_json FROM transactions WHERE account_id IS NULL OR account_id = ''")
    .all() as Array<{ id: string, raw_json: string | null }>

  if (rows.length === 0) return { txsUpdated: 0, accountsCreated: 0 }

  const accounts = new Map<string, AccountRow>()
  const updates: Array<{ txId: string, accountId: string }> = []

  for (const row of rows) {
    if (!row.raw_json) continue
    let parsed: { account?: { id?: string, name?: string, type?: string, providerName?: string, accountTypeAndNumberDisplay?: string } }
    try {
      parsed = JSON.parse(row.raw_json)
    } catch {
      continue
    }
    if (!parsed.account) continue
    const accountId = deriveAccountId(parsed.account)
    accounts.set(accountId, {
      id: accountId,
      name: parsed.account.name ?? '',
      type: parsed.account.type ?? null,
      providerName: parsed.account.providerName ?? null,
      display: parsed.account.accountTypeAndNumberDisplay ?? null,
    })
    updates.push({ txId: row.id, accountId })
  }

  if (updates.length === 0) return { txsUpdated: 0, accountsCreated: 0 }

  db.exec('BEGIN')
  try {
    for (const acct of accounts.values()) upsertAccount(db, acct)
    const stmt = db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?')
    for (const u of updates) stmt.run(u.accountId, u.txId)
    db.prepare("DELETE FROM accounts WHERE id = ''").run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { txsUpdated: updates.length, accountsCreated: accounts.size }
}
