import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { DomainValidationError, InvalidTransactionStateError } from '../../src/domain/shared/errors';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { type ReferenceLookup, WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import {
  REFERENCE_RETRY_POLICY,
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../src/domain/wallet/wallet-ledger-entry';
import { brl, id, NOW, OTHER_PLAYER, PLAYER, tx, WALLET, wallet } from './fixtures';

const settle = (w: Wallet, t: WagerTransaction, reference?: ReferenceLookup) =>
  WagerSettlement.settle({ wallet: w, transaction: t, reference, ledgerEntryId: id('le'), now: NOW });

const found = (t: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  found: true,
  transaction: t,
  alreadyReversed,
});

/** Processes a transaction against the wallet and asserts it was PROCESSED. */
function processed(w: Wallet, t: WagerTransaction, reference?: ReferenceLookup): WagerTransaction {
  const out = settle(w, t, reference);
  expect(out.type).toBe('processed');
  return t;
}

describe('BET', () => {
  test('debits and records one DEBIT entry', () => {
    const w = wallet('100.00');
    const out = settle(w, tx({ money: brl('25.00') }));
    expect(out.type).toBe('processed');
    if (out.type !== 'processed') return;
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('75.00');
  });

  test('insufficient funds → REJECTED INSUFFICIENT_FUNDS, no entry, balance untouched', () => {
    const w = wallet('10.00');
    const t = tx({ money: brl('10.01') });
    expect(settle(w, t)).toEqual({ type: 'rejected', failureCode: FailureCode.InsufficientFunds });
    expect(t.status).toBe(S.Rejected);
    expect(t.balanceAfter?.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('section 8 scenario (sequentialised by the wallet lock): 100 − 80 − 80', () => {
    const w = wallet('100.00');
    const a = settle(w, tx({ money: brl('80.00') }));
    const b = settle(w, tx({ money: brl('80.00') }));
    expect(a.type).toBe('processed');
    expect(b).toEqual({ type: 'rejected', failureCode: FailureCode.InsufficientFunds });
    expect(w.balance.amount).toBe('20.00');
  });

  test('cannot reference another transaction', () => {
    expect(() => tx({ referenceExternalTransactionId: 'x' })).toThrow(DomainValidationError);
  });
});

describe('WIN / LOSS', () => {
  test('WIN credits', () => {
    const w = wallet('0.00');
    const out = settle(w, tx({ kind: K.Win, money: brl('50.00') }));
    expect(out.type === 'processed' && out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('50.00');
  });

  test('WIN may reference the BET of the same round', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('10.00') }));
    const win = processed(w, tx({ kind: K.Win, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId }), found(bet));
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('120.00');
  });

  test('LOSS is PROCESSED with no balance change and no ledger entry', () => {
    const w = wallet('100.00');
    const out = settle(w, tx({ kind: K.Loss }));
    expect(out).toEqual({ type: 'processed' });
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('requires a reference', () => {
    expect(() => tx({ kind: K.Refund })).toThrow(DomainValidationError);
  });

  test('credits back a processed BET', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00') }));
    const refund = tx({ kind: K.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    processed(w, refund, found(bet));
    expect(w.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('only references BET', () => {
    const w = wallet('100.00');
    const win = processed(w, tx({ kind: K.Win, money: brl('5.00') }));
    const refund = tx({ kind: K.Refund, money: brl('5.00'), referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(w, refund, found(win))).toEqual({ type: 'rejected', failureCode: FailureCode.InvalidReferenceKind });
  });

  test('only once', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00') }));
    const again = tx({ kind: K.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, again, found(bet, true))).toEqual({ type: 'rejected', failureCode: FailureCode.AlreadyReversed });
    expect(w.balance.amount).toBe('60.00');
  });

  test('amount must equal the reference (no partial refunds)', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00') }));
    const partial = tx({ kind: K.Refund, money: brl('20.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, partial, found(bet))).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceAmountMismatch });
  });

  test('reference must share round / player / wallet', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00'), roundId: 'round-A' }));
    const refund = tx({ kind: K.Refund, money: brl('40.00'), roundId: 'round-B', referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, refund, found(bet))).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceMismatch });
  });

  test('reference that was REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const w = wallet('1.00');
    const bet = tx({ money: brl('40.00') });
    settle(w, bet); // rejected for funds
    const refund = tx({ kind: K.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, refund, found(bet))).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00') }));
    const rb = tx({ kind: K.Rollback, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId });
    const out = settle(w, rb, found(bet));
    expect(out.type === 'processed' && out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('of a WIN debits', () => {
    const w = wallet('0.00');
    const win = processed(w, tx({ kind: K.Win, money: brl('30.00') }));
    const rb = tx({ kind: K.Rollback, money: brl('30.00'), referenceExternalTransactionId: win.externalTransactionId });
    const out = settle(w, rb, found(win));
    expect(out.type === 'processed' && out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.isZero()).toBe(true);
  });

  test('of a REFUND debits', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('40.00') }));
    const refund = processed(w, tx({ kind: K.Refund, money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId }), found(bet));
    const rb = tx({ kind: K.Rollback, money: brl('40.00'), referenceExternalTransactionId: refund.externalTransactionId });
    processed(w, rb, found(refund));
    expect(w.balance.amount).toBe('60.00');
  });

  test('that would make balance negative → REVERSAL_INSUFFICIENT_FUNDS (distinct from bet)', () => {
    const w = wallet('0.00');
    const win = processed(w, tx({ kind: K.Win, money: brl('30.00') }));
    processed(w, tx({ money: brl('25.00') })); // player spent the win
    const rb = tx({ kind: K.Rollback, money: brl('30.00'), referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(w, rb, found(win))).toEqual({ type: 'rejected', failureCode: FailureCode.ReversalInsufficientFunds });
    expect(rb.status).toBe(S.Rejected);
    expect(w.balance.amount).toBe('5.00');
  });

  test('cannot target LOSS', () => {
    const w = wallet('100.00');
    const loss = processed(w, tx({ kind: K.Loss }));
    const rb = tx({ kind: K.Rollback, money: brl('10.00'), referenceExternalTransactionId: loss.externalTransactionId });
    expect(settle(w, rb, found(loss))).toEqual({ type: 'rejected', failureCode: FailureCode.InvalidReferenceKind });
  });
});

describe('out-of-order references', () => {
  test('missing reference → PENDING_REFERENCE with exponential backoff', () => {
    const w = wallet('100.00');
    const rb = tx({ kind: K.Rollback, money: brl('10.00'), referenceExternalTransactionId: 'later' });
    expect(settle(w, rb, { found: false })).toEqual({ type: 'pending-reference' });
    expect(rb.status).toBe(S.PendingReference);
    expect(rb.referenceAttempts).toBe(1);
    expect(rb.nextReferenceCheckAt?.getTime()).toBe(NOW.getTime() + REFERENCE_RETRY_POLICY.baseMs);

    settle(w, rb, { found: false });
    expect(rb.referenceAttempts).toBe(2);
    expect(rb.nextReferenceCheckAt?.getTime()).toBe(NOW.getTime() + REFERENCE_RETRY_POLICY.baseMs * 2);
    expect(w.balance.amount).toBe('100.00');
  });

  test('pending reference resolves once the reference arrives', () => {
    const w = wallet('100.00');
    const rb = tx({ kind: K.Rollback, money: brl('10.00'), referenceExternalTransactionId: 'bet-late' });
    settle(w, rb, { found: false });
    const bet = processed(w, tx({ externalTransactionId: 'bet-late', money: brl('10.00') }));
    processed(w, rb, found(bet));
    expect(w.balance.amount).toBe('100.00');
  });

  test('exhausting retries is detectable, and REJECTED REFERENCE_NOT_FOUND is terminal', () => {
    const w = wallet('100.00');
    const rb = tx({ kind: K.Refund, money: brl('10.00'), referenceExternalTransactionId: 'never' });
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) settle(w, rb, { found: false });
    expect(rb.hasExhaustedReferenceRetries()).toBe(true);
    rb.reject(FailureCode.ReferenceNotFound, w.balance, NOW);
    expect(rb.isTerminal()).toBe(true);
  });
});

describe('cross-cutting rules', () => {
  test('currency mismatch → REJECTED CURRENCY_MISMATCH', () => {
    const w = wallet('100.00');
    const t = tx({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
    expect(settle(w, t)).toEqual({ type: 'rejected', failureCode: FailureCode.CurrencyMismatch });
  });

  test('player not owner of wallet → REJECTED PLAYER_WALLET_MISMATCH without leaking the balance', () => {
    const w = wallet('100.00');
    const t = tx({ playerId: OTHER_PLAYER });
    expect(settle(w, t)).toEqual({
      type: 'rejected',
      failureCode: FailureCode.PlayerWalletMismatch,
    });
    expect(t.balanceAfter).toBeUndefined();
  });

  test('terminal states cannot transition', () => {
    const w = wallet('100.00');
    const t = processed(w, tx());
    expect(() => t.reject(FailureCode.InsufficientFunds, undefined, NOW)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => settle(w, t)).toThrow(InvalidTransactionStateError);
  });

  test('OPENING and reserved provider cannot be submitted', () => {
    expect(() => tx({ kind: K.Opening })).toThrow(DomainValidationError);
    expect(() => tx({ providerId: 'internal' })).toThrow(DomainValidationError);
  });

  test('zero amount is invalid input', () => {
    expect(() => tx({ money: brl('0.00') })).toThrow(DomainValidationError);
  });

  test('matchesPayload distinguishes divergent payloads under the same key', () => {
    const t = tx({ payloadHash: 'sha256:aaa' });
    expect(t.matchesPayload('sha256:aaa')).toBe(true);
    expect(t.matchesPayload('sha256:bbb')).toBe(false);
  });
});

describe('review fixes', () => {
  test('WIN on a BET that was already refunded → REJECTED ALREADY_REVERSED', () => {
    const w = wallet('100.00');
    const bet = processed(w, tx({ money: brl('10.00') }));
    const win = tx({ kind: K.Win, money: brl('50.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(w, win, found(bet, true))).toEqual({ type: 'rejected', failureCode: FailureCode.AlreadyReversed });
    expect(w.balance.amount).toBe('90.00');
  });

  test('credit beyond NUMERIC(20,2) → REJECTED BALANCE_LIMIT_EXCEEDED, nothing applied', () => {
    const w = wallet('999999999999999999.00');
    const win = tx({ kind: K.Win, money: brl('1.00') });
    expect(settle(w, win)).toEqual({ type: 'rejected', failureCode: FailureCode.BalanceLimitExceeded });
    expect(w.version).toBe(1);
  });

  test('walletId / playerId must be UUIDs and are canonicalized, so casing never causes a mismatch', () => {
    expect(() => tx({ walletId: 'wallet-1' })).toThrow(DomainValidationError);
    expect(() => tx({ playerId: 'player-1' })).toThrow(DomainValidationError);
    const w = wallet('100.00');
    const t = tx({ walletId: WALLET.toUpperCase(), playerId: PLAYER.toUpperCase() });
    expect(t.walletId).toBe(WALLET);
    expect(settle(w, t).type).toBe('processed');
  });
});
