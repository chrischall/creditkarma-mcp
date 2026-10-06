import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDb, upsertAccount, upsertTransaction, resolveAccountId, attachUrn,
  upsertCreditReportAccount, pruneCreditReportAccounts, setLinkedBalance, listBalances,
  findAccountByProviderPrefix,
  type Database,
} from '../src/db.js'

describe('balance storage', () => {
  let db: Database
  beforeEach(() => { db = initDb(':memory:') })

  const row = (id: string) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined

  describe('upsertAccount', () => {
    it('trims the provider name and derives last4 from the display', () => {
      upsertAccount(db, { id: 'Padded|1234', name: 'Checking', providerName: 'Padded   ', display: 'Bank (..1234)' })
      expect(row('Padded|1234')).toMatchObject({ provider_name: 'Padded', last4: '1234' })
    })

    it('stores a NULL last4 for a garbage display and when no display is given', () => {
      upsertAccount(db, { id: 'G|ount', name: 'HSA', providerName: 'G', display: 'Bank (..ount)' })
      upsertAccount(db, { id: 'N|', name: 'n' })
      expect(row('G|ount')!.last4).toBeNull()
      expect(row('N|')).toMatchObject({ last4: null, provider_name: null })
    })

    it('does not wipe balances when transaction metadata is re-upserted', () => {
      upsertAccount(db, { id: 'A|1111', name: 'a', providerName: 'A', display: 'Card (..1111)' })
      setLinkedBalance(db, { id: 'A|1111', name: 'a', provider: 'A', display: 'A (...1111)', last4: '1111', balance: 50, asOf: '2024-02-14T00:00:00Z', syncedAt: '2024-02-15T00:00:00Z' })
      upsertAccount(db, { id: 'A|1111', name: 'a2', providerName: 'A', display: 'Card (..1111)' })
      expect(row('A|1111')).toMatchObject({ name: 'a2', current_balance: 50, balance_source: 'linked' })
    })
  })

  describe('resolveAccountId', () => {
    it('returns the derived id when nothing overrides it', () => {
      expect(resolveAccountId(db, 'A|1111')).toBe('A|1111')
      expect(resolveAccountId(db, 'A|1111', 'urn:unknown')).toBe('A|1111')
    })

    it('prefers the row already holding the URN, even under a different derived id', () => {
      upsertAccount(db, { id: 'Old Name|1111', name: 'a' })
      attachUrn(db, 'Old Name|1111', 'urn:account:test-1')
      expect(resolveAccountId(db, 'New Name|1111', 'urn:account:test-1')).toBe('Old Name|1111')
    })

    it('follows an alias left by a merge', () => {
      upsertAccount(db, { id: 'Survivor|9999', name: 's' })
      db.prepare("INSERT INTO account_aliases (alias, account_id) VALUES ('Retired|9999', 'Survivor|9999')").run()
      expect(resolveAccountId(db, 'Retired|9999')).toBe('Survivor|9999')
    })
  })

  describe('findAccountByProviderPrefix', () => {
    // Net-worth rows show shortened provider names ("Example Bank", or
    // "Example Bank Pe...") where transactions carry the full one
    // ("Example Bank Personal"), so the derived ids differ.
    beforeEach(() => {
      upsertAccount(db, { id: 'Example Bank Personal|5403', name: 'Checking', providerName: 'Example Bank Personal', display: 'Bank (..5403)' })
    })

    it('finds the account whose provider starts with the shortened name, same last4', () => {
      expect(findAccountByProviderPrefix(db, 'Example Bank', '5403')).toBe('Example Bank Personal|5403')
    })

    it('strips a truncation ellipsis and ignores case and padding', () => {
      expect(findAccountByProviderPrefix(db, '  EXAMPLE BANK PE...', '5403')).toBe('Example Bank Personal|5403')
      expect(findAccountByProviderPrefix(db, 'Example Bank Pe…', '5403')).toBe('Example Bank Personal|5403')
    })

    it('also matches when the row shows the LONGER name', () => {
      upsertAccount(db, { id: 'Sample|7777', name: 's', providerName: 'Sample', display: 'Card (..7777)' })
      expect(findAccountByProviderPrefix(db, 'Sample Credit Union', '7777')).toBe('Sample|7777')
    })

    it('returns null for a different last4, a missing last4, or an empty name', () => {
      expect(findAccountByProviderPrefix(db, 'Example Bank', '0000')).toBeNull()
      expect(findAccountByProviderPrefix(db, 'Example Bank', null)).toBeNull()
      expect(findAccountByProviderPrefix(db, '...', '5403')).toBeNull()
    })

    it('returns null when the prefix fits more than one account — never guesses', () => {
      upsertAccount(db, { id: 'Example Bank Business|5403', name: 'Biz', providerName: 'Example Bank Business', display: 'Bank (..5403)' })
      expect(findAccountByProviderPrefix(db, 'Example Bank', '5403')).toBeNull()
    })

    it('ignores credit-report rows', () => {
      db.prepare("UPDATE accounts SET balance_source = 'credit_report' WHERE id = 'Example Bank Personal|5403'").run()
      expect(findAccountByProviderPrefix(db, 'Example Bank', '5403')).toBeNull()
    })
  })

  describe('attachUrn', () => {
    it('sets the URN only when the row has none and no other row claims it', () => {
      upsertAccount(db, { id: 'A|1', name: 'a' })
      upsertAccount(db, { id: 'B|2', name: 'b' })
      attachUrn(db, 'A|1', 'urn:x')
      attachUrn(db, 'A|1', 'urn:y')   // already has one — unchanged
      attachUrn(db, 'B|2', 'urn:x')   // claimed by A — unchanged
      expect(row('A|1')!.account_urn).toBe('urn:x')
      expect(row('B|2')!.account_urn).toBeNull()
    })
  })

  describe('credit-report accounts', () => {
    const card = {
      key: 'cr:transunion:abc', institution: 'Example Card Co', type: 'Credit Card', category: 'credit_card' as const,
      currentBalance: -120.5, creditLimit: 1000, asOf: '2024-01-28',
    }

    it('inserts and then updates a credit-report row', () => {
      upsertCreditReportAccount(db, card, '2024-02-15T00:00:00Z')
      upsertCreditReportAccount(db, { ...card, currentBalance: -80 }, '2024-02-16T00:00:00Z')
      expect(row('cr:transunion:abc')).toMatchObject({
        name: 'Example Card Co', type: 'Credit Card', provider_name: 'Example Card Co',
        current_balance: -80, credit_limit: 1000, available_balance: null,
        balance_as_of: '2024-01-28', balances_synced_at: '2024-02-16T00:00:00Z', balance_source: 'credit_report',
      })
    })

    it('names a row by its type when the institution is unknown', () => {
      upsertCreditReportAccount(db, { ...card, institution: null }, '2024-02-15T00:00:00Z')
      expect(row('cr:transunion:abc')!.name).toBe('Credit Card')
    })

    it('prunes credit-report rows missing from the latest report, sparing ones with transactions', () => {
      upsertCreditReportAccount(db, card, 's')
      upsertCreditReportAccount(db, { ...card, key: 'cr:transunion:gone' }, 's')
      upsertCreditReportAccount(db, { ...card, key: 'cr:transunion:kept-by-tx' }, 's')
      upsertTransaction(db, { id: 't', date: '2024-01-01', description: 'x', status: 'posted', amount: -1, accountId: 'cr:transunion:kept-by-tx', categoryId: null, merchantId: null, rawJson: null })
      upsertAccount(db, { id: 'Linked|1', name: 'linked' })
      expect(pruneCreditReportAccounts(db, ['cr:transunion:abc'])).toBe(1)
      expect(row('cr:transunion:gone')).toBeUndefined()
      expect(row('cr:transunion:kept-by-tx')).toBeDefined()
      expect(row('Linked|1')).toBeDefined()
    })

    it('prunes every credit-report row when the report has none', () => {
      upsertCreditReportAccount(db, card, 's')
      expect(pruneCreditReportAccounts(db, [])).toBe(1)
    })
  })

  describe('setLinkedBalance', () => {
    const linked = {
      id: 'Example Bank|1234', name: 'Everyday Checking', provider: 'Example Bank', display: 'Example Bank (...1234)',
      last4: '1234', balance: 1500, asOf: '2024-02-15T10:00:00Z', syncedAt: '2024-02-15T12:00:00Z',
    }

    it('creates a row for an account that has no transactions yet', () => {
      setLinkedBalance(db, linked)
      expect(row('Example Bank|1234')).toMatchObject({
        name: 'Everyday Checking', provider_name: 'Example Bank', display: 'Example Bank (...1234)', last4: '1234',
        current_balance: 1500, available_balance: null, credit_limit: null,
        balance_as_of: '2024-02-15T10:00:00Z', balances_synced_at: '2024-02-15T12:00:00Z', balance_source: 'linked',
      })
    })

    it('updates balances on an existing row without renaming it or touching its display', () => {
      upsertAccount(db, { id: 'Example Bank|1234', name: 'Checking', providerName: 'Example Bank', display: 'Checking (..1234)' })
      setLinkedBalance(db, linked)
      expect(row('Example Bank|1234')).toMatchObject({ name: 'Checking', display: 'Checking (..1234)', current_balance: 1500 })
    })

    it('stores a NULL as-of when none is known', () => {
      setLinkedBalance(db, { ...linked, asOf: null })
      expect(row('Example Bank|1234')!.balance_as_of).toBeNull()
    })
  })

  describe('listBalances', () => {
    it('lists only accounts that have a balance, linked first', () => {
      upsertAccount(db, { id: 'NoBalance|1', name: 'n' })
      upsertCreditReportAccount(db, {
        key: 'cr:transunion:z', institution: 'Zeta Card', type: 'Credit Card', category: 'credit_card',
        currentBalance: -5, creditLimit: 100, asOf: '2024-01-01',
      }, 's')
      setLinkedBalance(db, { id: 'Alpha|1', name: 'Alpha Savings', provider: 'Alpha', display: 'Alpha (...0001)', last4: '0001', balance: 1, asOf: null, syncedAt: 's' })
      expect(listBalances(db).map(r => r.id)).toEqual(['Alpha|1', 'cr:transunion:z'])
    })
  })
})
