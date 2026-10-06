import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDb, upsertAccount, upsertTransaction, resolveAccountId, attachUrn,
  upsertCreditReportAccount, pruneCreditReportAccounts, setLinkedBalance, listBalances,
  findUnlinkedAccount, findAccountByUrn, pruneLinkedAccounts, loadMatchSnapshots, setCreditReportMatches,
  type Database, type LinkedBalanceRow,
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
      setLinkedBalance(db, { id: 'A|1111', urn: 'urn:a', name: 'a', provider: 'A', last4: '1111', type: 'CHECKING', balance: 50, creditLimit: null, availableCredit: null, asOf: '2024-02-14T00:00:00Z', syncedAt: '2024-02-15T00:00:00Z' })
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

  describe('findUnlinkedAccount', () => {
    // A vault account whose URN no row holds yet: the transactions may predate
    // CK sending URNs, so find that account by institution + last4 instead.
    beforeEach(() => {
      upsertAccount(db, { id: 'Example Bank|5403', name: 'Checking', providerName: 'Example Bank', display: 'Bank (..5403)' })
    })

    it('finds the URN-less account with the same institution (case and padding ignored) and last4', () => {
      expect(findUnlinkedAccount(db, '  EXAMPLE BANK ', '5403')).toBe('Example Bank|5403')
    })

    it('returns null for another institution, another last4, or no last4', () => {
      expect(findUnlinkedAccount(db, 'Example', '5403')).toBeNull()
      expect(findUnlinkedAccount(db, 'Example Bank', '0000')).toBeNull()
      expect(findUnlinkedAccount(db, 'Example Bank', null)).toBeNull()
    })

    it('skips an account that already holds a URN — it belongs to that account', () => {
      attachUrn(db, 'Example Bank|5403', 'urn:other')
      expect(findUnlinkedAccount(db, 'Example Bank', '5403')).toBeNull()
    })

    it('returns null when two accounts fit — never guesses', () => {
      upsertAccount(db, { id: 'Example Bank|5403-b', name: 'Other', providerName: 'Example Bank', display: 'Bank (..5403)' })
      expect(findUnlinkedAccount(db, 'Example Bank', '5403')).toBeNull()
    })

    it('ignores credit-report rows', () => {
      db.prepare("UPDATE accounts SET balance_source = 'credit_report' WHERE id = 'Example Bank|5403'").run()
      expect(findUnlinkedAccount(db, 'Example Bank', '5403')).toBeNull()
    })
  })

  describe('findAccountByUrn', () => {
    it('returns the row holding the URN, or null', () => {
      upsertAccount(db, { id: 'A|1', name: 'a' })
      attachUrn(db, 'A|1', 'urn:a')
      expect(findAccountByUrn(db, 'urn:a')).toBe('A|1')
      expect(findAccountByUrn(db, 'urn:none')).toBeNull()
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
    const card: LinkedBalanceRow = {
      id: 'urn:account:fdp::accountid:card-1', urn: 'urn:account:fdp::accountid:card-1',
      name: 'Rewards Card', provider: 'Example Card Co', last4: '4321', type: 'CREDITCARD',
      balance: -1250.5, creditLimit: 10000, availableCredit: 8749.5,
      asOf: '2024-02-15T10:00:00Z', syncedAt: '2024-02-15T12:00:00Z',
    }

    it('creates a row for an account with no transactions, keyed and URN-tagged by the URN', () => {
      setLinkedBalance(db, card)
      expect(row(card.id)).toMatchObject({
        name: 'Rewards Card', type: 'CREDITCARD', provider_name: 'Example Card Co', display: null, last4: '4321',
        account_urn: card.urn, current_balance: -1250.5, credit_limit: 10000, available_balance: 8749.5,
        balance_as_of: '2024-02-15T10:00:00Z', balances_synced_at: '2024-02-15T12:00:00Z', balance_source: 'linked',
      })
    })

    it('updates balances on an existing transaction account without renaming it, filling only missing metadata', () => {
      upsertAccount(db, { id: 'Example Card Co|4321', name: 'Card', providerName: 'Example Card Co', display: 'Credit (..4321)' })
      setLinkedBalance(db, { ...card, id: 'Example Card Co|4321' })
      expect(row('Example Card Co|4321')).toMatchObject({
        name: 'Card', display: 'Credit (..4321)', type: 'CREDITCARD', account_urn: card.urn,
        current_balance: -1250.5, credit_limit: 10000, available_balance: 8749.5,
      })
    })

    it('does not steal a URN another row already holds', () => {
      upsertAccount(db, { id: 'Holder|1', name: 'h' })
      attachUrn(db, 'Holder|1', card.urn)
      setLinkedBalance(db, { ...card, id: 'Other|1' })
      expect(row('Other|1')!.account_urn).toBeNull()
    })

    it('clears a limit that went away', () => {
      setLinkedBalance(db, card)
      setLinkedBalance(db, { ...card, creditLimit: null, availableCredit: null })
      expect(row(card.id)).toMatchObject({ credit_limit: null, available_balance: null })
    })
  })

  describe('pruneLinkedAccounts', () => {
    const base: LinkedBalanceRow = {
      id: 'x', urn: 'urn:x', name: 'n', provider: 'P', last4: null, type: 'SAVINGS',
      balance: 1, creditLimit: null, availableCredit: null, asOf: null, syncedAt: 's',
    }

    it('deletes balance-only rows the latest refresh did not return, and unlists ones with transactions', () => {
      setLinkedBalance(db, { ...base, id: 'kept', urn: 'urn:kept' })
      setLinkedBalance(db, { ...base, id: 'gone', urn: 'urn:gone' })
      upsertAccount(db, { id: 'Has Tx|1', name: 'h' })
      upsertTransaction(db, { id: 't', date: '2024-01-01', description: 'x', status: 'posted', amount: -1, accountId: 'Has Tx|1', categoryId: null, merchantId: null, rawJson: null })
      setLinkedBalance(db, { ...base, id: 'Has Tx|1', urn: 'urn:hastx' })
      upsertCreditReportAccount(db, { key: 'cr:transunion:a', institution: 'I', type: 'Credit Card', category: 'credit_card', currentBalance: -1, creditLimit: 1, asOf: null }, 's')

      expect(pruneLinkedAccounts(db, ['kept'])).toBe(2)
      expect(row('gone')).toBeUndefined()
      expect(row('Has Tx|1')).toMatchObject({ balance_source: null, current_balance: null, balance_as_of: null })
      expect(row('kept')!.balance_source).toBe('linked')
      expect(row('cr:transunion:a')).toBeDefined()
    })

    it('handles an empty keep list', () => {
      setLinkedBalance(db, base)
      expect(pruneLinkedAccounts(db, [])).toBe(1)
    })
  })

  describe('credit-report matching storage', () => {
    it('loads both sides and records matches, clearing stale ones', () => {
      upsertCreditReportAccount(db, { key: 'cr:transunion:a', institution: 'Example Card Co', type: 'Credit Card', category: 'credit_card', currentBalance: -100, creditLimit: 1000, asOf: '2024-01-01' }, 's')
      upsertCreditReportAccount(db, { key: 'cr:transunion:b', institution: 'Other', type: 'Credit Card', category: 'credit_card', currentBalance: -5, creditLimit: 50, asOf: '2024-01-01' }, 's')
      setLinkedBalance(db, { id: 'L1', urn: 'urn:L1', name: 'Card', provider: 'Example Card Co', last4: '1', type: 'CREDITCARD', balance: -120, creditLimit: 1000, availableCredit: 880, asOf: null, syncedAt: 's' })
      setLinkedBalance(db, { id: 'Asset', urn: 'urn:asset', name: 'Savings', provider: 'Example Card Co', last4: '2', type: 'SAVINGS', balance: 500, creditLimit: null, availableCredit: null, asOf: null, syncedAt: 's' })

      const snap = loadMatchSnapshots(db)
      expect(snap.creditReport.map(r => r.id).sort()).toEqual(['cr:transunion:a', 'cr:transunion:b'])
      expect(snap.linked).toEqual([{ id: 'L1', institution: 'Example Card Co', creditLimit: 1000, balance: -120, asOf: null }])

      setCreditReportMatches(db, new Map([['cr:transunion:b', 'L1']]))
      setCreditReportMatches(db, new Map([['cr:transunion:a', 'L1']]))
      expect(row('cr:transunion:a')!.matched_account_id).toBe('L1')
      expect(row('cr:transunion:b')!.matched_account_id).toBeNull()
    })
  })

  describe('listBalances', () => {
    beforeEach(() => {
      upsertAccount(db, { id: 'NoBalance|1', name: 'n' })
      upsertCreditReportAccount(db, { key: 'cr:transunion:z', institution: 'Zeta Card', type: 'Credit Card', category: 'credit_card', currentBalance: -5, creditLimit: 100, asOf: '2024-01-01' }, 's')
      upsertCreditReportAccount(db, { key: 'cr:transunion:m', institution: 'Alpha', type: 'Credit Card', category: 'credit_card', currentBalance: -5, creditLimit: 100, asOf: '2024-01-01' }, 's')
      setLinkedBalance(db, { id: 'Alpha|1', urn: 'urn:a', name: 'Alpha Card', provider: 'Alpha', last4: '0001', type: 'CREDITCARD', balance: -7, creditLimit: 100, availableCredit: 93, asOf: null, syncedAt: 's' })
      setCreditReportMatches(db, new Map([['cr:transunion:m', 'Alpha|1']]))
    })

    it('lists accounts with a balance, linked first, hiding credit-report rows matched to a linked one', () => {
      expect(listBalances(db).map(r => [r.id, r.matched_to])).toEqual([['Alpha|1', null], ['cr:transunion:z', null]])
    })

    it('includes matched rows, with what they matched, when asked', () => {
      expect(listBalances(db, { includeMatched: true }).map(r => [r.id, r.matched_to])).toEqual([
        ['Alpha|1', null], ['cr:transunion:m', 'Alpha|1'], ['cr:transunion:z', null],
      ])
    })
  })
})
