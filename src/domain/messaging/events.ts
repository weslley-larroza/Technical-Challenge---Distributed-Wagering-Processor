import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../shared/failure-code';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
}

function base(tx: WagerTransaction): TransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
  };
}

// ---------------------------------------------------------------- Processed
export interface WagerTransactionProcessedData extends TransactionEventBase {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.balanceAfter || !tx.processedAt) throw new Error('transaction is not processed');
    return new WagerTransactionProcessed(
      IntegrationEvent.props(ctx, tx.id, {
        ...base(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.balanceAfter.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------- Rejected
export interface WagerTransactionRejectedData extends TransactionEventBase {
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.processedAt) throw new Error('transaction is not rejected');
    return new WagerTransactionRejected(
      IntegrationEvent.props(ctx, tx.id, {
        ...base(tx),
        failureCode: tx.failureCode,
        rejectedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------- PendingReference
export interface WagerTransactionPendingReferenceData extends TransactionEventBase {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceCheckAt) {
      throw new Error('transaction is not pending a reference');
    }
    return new WagerTransactionPendingReference(
      IntegrationEvent.props(ctx, tx.id, {
        ...base(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempts: tx.referenceAttempts,
        nextCheckAt: tx.nextReferenceCheckAt.toISOString(),
      }),
    );
  }
}

// ---------------------------------------------------------------- WalletBalanceChanged
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(ctx, wallet.id, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
