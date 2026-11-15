import { InvalidTransactionStateError } from '../shared/errors';
import { FailureCode } from '../shared/failure-code';
import type { Wallet } from '../wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import {
  ALLOWED_REFERENCE_KINDS,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

/** What the repository found for `(providerId, referenceExternalTransactionId)`. */
export type ReferenceLookup =
  | { found: false }
  | {
      found: true;
      transaction: WagerTransaction;
      /** A PROCESSED REFUND/ROLLBACK already points at this reference (blocks reversals AND WIN/LOSS). */
      alreadyReversed: boolean;
    };

export type SettlementOutcome =
  | { type: 'processed'; ledgerEntry?: WalletLedgerEntry }
  | { type: 'rejected'; failureCode: FailureCode }
  | { type: 'pending-reference' };

export interface SettleInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Required when transaction.hasReference(). */
  reference?: ReferenceLookup;
  ledgerEntryId: string;
  now: Date;
}

/**
 * Pure domain service holding the business rules of section 7. It mutates the wallet
 * and the transaction in memory; the caller persists both atomically (under the
 * wallet row lock). No I/O here, so every rule is unit-testable.
 */
export class WagerSettlement {
  static settle(input: SettleInput): SettlementOutcome {
    const { wallet, transaction: tx, now } = input;
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${tx.id} already ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      throw new InvalidTransactionStateError('settle called with a different wallet');
    }

    const reject = (code: FailureCode, exposeBalance = true): SettlementOutcome => {
      tx.reject(code, exposeBalance ? wallet.balance : undefined, now);
      return { type: 'rejected', failureCode: code };
    };

    // Never record (and later replay) the balance of a wallet the caller does not own.
    if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerWalletMismatch, false);
    if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

    // ---- reference resolution (REFUND/ROLLBACK mandatory, WIN/LOSS optional)
    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const lookup = input.reference;
      if (!lookup) throw new InvalidTransactionStateError('reference lookup missing');
      if (!lookup.found) {
        tx.markPendingReference(now);
        return { type: 'pending-reference' };
      }
      reference = lookup.transaction;
      const refusal = WagerSettlement.validateReference(tx, reference, lookup.alreadyReversed);
      if (refusal === 'wait') {
        tx.markPendingReference(now);
        return { type: 'pending-reference' };
      }
      if (refusal) return reject(refusal);
    }

    // ---- LOSS: recorded, no balance movement, no ledger
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, wallet.balance, now);
      return { type: 'processed' };
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { money: tx.money, transactionId: tx.id, ledgerEntryId: input.ledgerEntryId, at: now };

    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // A bet without funds and a reversal that would go negative are operationally distinct.
      return reject(
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds,
      );
    }

    if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) {
      return reject(FailureCode.BalanceLimitExceeded);
    }

    const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { type: 'processed', ledgerEntry };
  }

  /** @returns a failure code, 'wait' (reference not settled yet) or undefined (valid). */
  private static validateReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | 'wait' | undefined {
    if (ref.status === WagerTransactionStatus.Pending || ref.status === WagerTransactionStatus.PendingReference) {
      return 'wait';
    }
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    const sameScope =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.money.currency === tx.money.currency &&
      ref.roundId === tx.roundId;
    if (!sameScope) return FailureCode.ReferenceMismatch;

    if (!ALLOWED_REFERENCE_KINDS[tx.kind].includes(ref.kind)) return FailureCode.InvalidReferenceKind;

    if (tx.isReversal() && !ref.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
    // Applies to WIN/LOSS too: settling a round whose BET was already refunded/rolled back
    // would pay a prize on a stake that was given back.
    if (alreadyReversed) return FailureCode.AlreadyReversed;
    return undefined;
  }
}
