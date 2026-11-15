import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError, InvalidLedgerEntryError } from '../../src/domain/shared/errors';
import { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, id, NOW, PLAYER, WALLET, wallet } from './fixtures';

const move = (amount: string) => ({ money: brl(amount), transactionId: id('tx'), ledgerEntryId: id('le'), at: NOW });

describe('Wallet', () => {
  test('open with positive balance: version 1 + OPENING credit entry 0 → initial', () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl('1000.00'),
      opening: { transactionId: 't', ledgerEntryId: 'l' },
      now: NOW,
    });
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('1000.00');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  test('open with zero balance produces no ledger entry', () => {
    const { wallet: w, openingEntry } = Wallet.open({ id: WALLET, playerId: PLAYER, initialBalance: brl('0'), now: NOW });
    expect(w.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('debit and credit return balanced entries and bump version', () => {
    const w = wallet('100.00');
    const d = w.debit(move('30.00'));
    expect(d.balanceBefore.amount).toBe('100.00');
    expect(d.balanceAfter.amount).toBe('70.00');
    expect(w.version).toBe(2);
    const c = w.credit(move('5.50'));
    expect(c.balanceAfter.amount).toBe('75.50');
    expect(w.balance.amount).toBe('75.50');
    expect(w.version).toBe(3);
  });

  test('never goes negative; failed debit changes nothing', () => {
    const w = wallet('10.00');
    expect(() => w.debit(move('10.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    w.debit(move('10.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('rejects movements in another currency', () => {
    const w = wallet('10.00');
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('balance always equals the sum of its ledger', () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: WALLET,
      playerId: PLAYER,
      initialBalance: brl('50.00'),
      opening: { transactionId: 't', ledgerEntryId: 'l' },
      now: NOW,
    });
    const entries = [openingEntry!, w.debit(move('20.00')), w.credit(move('7.25')), w.debit(move('0.25'))];
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(w.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'l',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('30.00'),
    balanceAfter: brl('20.00'),
    createdAt: NOW,
  };

  test('validates arithmetic in the factory', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('21.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0') })).toThrow(InvalidLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const e = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
  });
});

describe('Wallet identifiers', () => {
  test('requires UUIDs and canonicalizes them to lowercase', () => {
    const { wallet: w } = Wallet.open({
      id: WALLET.toUpperCase(),
      playerId: PLAYER.toUpperCase(),
      initialBalance: brl('0'),
      now: NOW,
    });
    expect(w.id).toBe(WALLET);
    expect(w.playerId).toBe(PLAYER);
    expect(() => Wallet.open({ id: 'w', playerId: PLAYER, initialBalance: brl('0'), now: NOW })).toThrow(
      DomainValidationError,
    );
    expect(() => Wallet.open({ id: WALLET, playerId: 'p', initialBalance: brl('0'), now: NOW })).toThrow(
      DomainValidationError,
    );
  });
});
