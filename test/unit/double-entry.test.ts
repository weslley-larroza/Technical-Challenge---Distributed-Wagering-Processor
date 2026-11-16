import { describe, expect, test } from 'bun:test';
import { accountIdFor, AccountKind, JournalTransaction, LedgerAccount } from '../../src/domain/ledger/double-entry';
import { Money } from '../../src/domain/money/money';
import { InvalidLedgerEntryError } from '../../src/domain/shared/errors';
import { LedgerDirection as D, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, id, NOW, WALLET, wallet } from './fixtures';

const posting = (accountId: string, direction: D, amount: string, money = brl(amount)) => ({
  id: id('p'),
  transactionId: 'tx-1',
  accountId,
  direction,
  money,
  createdAt: NOW,
});

describe('LedgerAccount', () => {
  test('ids are deterministic from the code (same as the SQL backfill md5)', () => {
    const a = LedgerAccount.providerGaming('provider-a', 'BRL');
    expect(a.code).toBe('provider:provider-a:BRL');
    expect(a.id).toBe(accountIdFor('provider:provider-a:BRL'));
    expect(LedgerAccount.providerGaming('provider-a', 'BRL').id).toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(LedgerAccount.providerGaming('provider-a', 'USD').id).not.toBe(a.id);
  });

  test('chart of accounts', () => {
    expect(LedgerAccount.playerWallet(WALLET, 'BRL')).toMatchObject({ kind: AccountKind.PlayerWallet, walletId: WALLET });
    expect(LedgerAccount.funding('BRL')).toMatchObject({ kind: AccountKind.Funding, code: 'funding:BRL' });
  });
});

describe('JournalTransaction', () => {
  test('accepts a balanced two-leg entry', () => {
    const j = JournalTransaction.create('tx-1', [posting('a', D.Debit, '10.00'), posting('b', D.Credit, '10.00')]);
    expect(j.postings).toHaveLength(2);
    expect(Object.isFrozen(j)).toBe(true);
  });

  test('accepts a balanced multi-leg entry', () => {
    expect(() =>
      JournalTransaction.create('tx-1', [posting('a', D.Debit, '10.00'), posting('b', D.Credit, '7.50'), posting('c', D.Credit, '2.50')]),
    ).not.toThrow();
  });

  test.each([
    ['unbalanced', [posting('a', D.Debit, '10.00'), posting('b', D.Credit, '9.99')]],
    ['single leg', [posting('a', D.Debit, '10.00')]],
    ['mixed currency', [posting('a', D.Debit, '10.00'), posting('b', D.Credit, '10.00', Money.from({ amount: '10.00', currency: 'USD' }))]],
    ['two legs on one account', [posting('a', D.Debit, '10.00'), posting('a', D.Credit, '10.00')]],
    ['zero amount', [posting('a', D.Debit, '0.00'), posting('b', D.Credit, '0.00')]],
  ])('rejects %s', (_, postings) => {
    expect(() => JournalTransaction.create('tx-1', postings)).toThrow(InvalidLedgerEntryError);
  });

  test('wallet movement: player leg mirrors the wallet entry, counterparty takes the opposite side', () => {
    const w = wallet('100.00');
    const bet = w.debit({ money: brl('25.00'), transactionId: 'tx-bet', ledgerEntryId: 'le', at: NOW });
    const provider = LedgerAccount.providerGaming('provider-a', 'BRL');
    const j = JournalTransaction.forWalletMovement({ entry: bet, counterparty: provider, newId: () => id('p') });
    const player = LedgerAccount.playerWallet(w.id, 'BRL');
    expect(j.postings.map((p) => [p.accountId, p.direction, p.money.amount])).toEqual([
      [player.id, D.Debit, '25.00'],
      [provider.id, D.Credit, '25.00'],
    ]);

    const win = w.credit({ money: brl('40.00'), transactionId: 'tx-win', ledgerEntryId: 'le2', at: NOW });
    const jw = JournalTransaction.forWalletMovement({ entry: win, counterparty: provider, newId: () => id('p') });
    expect(jw.postings.map((p) => p.direction)).toEqual([D.Credit, D.Debit]);
  });

  test('a closed system: over any sequence of movements the accounts sum to zero', () => {
    const w = wallet('0.00');
    const provider = LedgerAccount.providerGaming('provider-a', 'BRL');
    const funding = LedgerAccount.funding('BRL');
    const entries: Array<[WalletLedgerEntry, LedgerAccount]> = [
      [w.credit({ money: brl('100.00'), transactionId: 't1', ledgerEntryId: 'l1', at: NOW }), funding],
      [w.debit({ money: brl('30.00'), transactionId: 't2', ledgerEntryId: 'l2', at: NOW }), provider],
      [w.credit({ money: brl('55.25'), transactionId: 't3', ledgerEntryId: 'l3', at: NOW }), provider],
      [w.debit({ money: brl('0.25'), transactionId: 't4', ledgerEntryId: 'l4', at: NOW }), provider],
    ];
    const balances = new Map<string, Money>();
    for (const [entry, counterparty] of entries) {
      for (const p of JournalTransaction.forWalletMovement({ entry, counterparty, newId: () => id('p') }).postings) {
        const signed = p.direction === D.Credit ? p.money : p.money.negate();
        balances.set(p.accountId, (balances.get(p.accountId) ?? Money.zero('BRL')).add(signed));
      }
    }
    const total = [...balances.values()].reduce((a, b) => a.add(b), Money.zero('BRL'));
    expect(total.isZero()).toBe(true);
    expect(balances.get(LedgerAccount.playerWallet(w.id, 'BRL').id)?.equals(w.balance)).toBe(true); // 125.00
    expect(balances.get(provider.id)?.amount).toBe('-25.00'); // house paid out 25.00 net
    expect(balances.get(funding.id)?.amount).toBe('-100.00'); // money that entered the system
  });
});
