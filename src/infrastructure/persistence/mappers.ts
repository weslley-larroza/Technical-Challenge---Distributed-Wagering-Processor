import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/shared/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/**
 * Domain ⇄ record. `toRecord` writes the full domain state onto a (new or managed)
 * record; for a managed record the Unit of Work then flushes only the changed columns.
 */
export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet, target: WalletRecord = new WalletRecord()): WalletRecord {
    target.id = w.id;
    target.playerId = w.playerId;
    target.currency = w.currency;
    target.balance = w.balance.amount;
    target.version = w.version;
    target.createdAt = w.createdAt;
    target.updatedAt = w.updatedAt;
    return target;
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: opt(r.processedAt),
      balanceAfter:
        r.balanceAfterAmount != null && r.balanceAfterCurrency != null
          ? money(r.balanceAfterAmount, r.balanceAfterCurrency)
          : undefined,
      referenceAttempts: r.referenceAttempts,
      nextReferenceCheckAt: opt(r.nextReferenceCheckAt),
      updatedAt: r.updatedAt,
    });
  },
  toRecord(t: WagerTransaction, target: WagerTransactionRecord = new WagerTransactionRecord()): WagerTransactionRecord {
    target.id = t.id;
    target.providerId = t.providerId;
    target.externalTransactionId = t.externalTransactionId;
    target.idempotencyKey = t.idempotencyKey;
    target.payloadHash = t.payloadHash;
    target.walletId = t.walletId;
    target.playerId = t.playerId;
    target.roundId = t.roundId;
    target.gameId = t.gameId;
    target.kind = t.kind;
    target.amount = t.money.amount;
    target.currency = t.money.currency;
    target.referenceExternalTransactionId = t.referenceExternalTransactionId ?? null;
    target.referenceTransactionId = t.referenceTransactionId ?? null;
    target.status = t.status;
    target.failureCode = t.failureCode ?? null;
    target.balanceAfterAmount = t.balanceAfter?.amount ?? null;
    target.balanceAfterCurrency = t.balanceAfter?.currency ?? null;
    target.referenceAttempts = t.referenceAttempts;
    target.nextReferenceCheckAt = t.nextReferenceCheckAt ?? null;
    target.processedAt = t.processedAt ?? null;
    target.createdAt = t.createdAt;
    target.updatedAt = t.updatedAt;
    return target;
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      createdAt: r.createdAt,
    });
  },
  /** Ledger entries are only ever inserted — there is no update path. */
  toNewRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    const r = new LedgerEntryRecord();
    r.id = e.id;
    r.walletId = e.walletId;
    r.transactionId = e.transactionId;
    r.direction = e.direction;
    r.amount = e.money.amount;
    r.currency = e.money.currency;
    r.balanceBefore = e.balanceBefore.amount;
    r.balanceAfter = e.balanceAfter.amount;
    r.createdAt = e.createdAt;
    return r;
  },
};

export const InboxMessageMapper = {
  toDomain(r: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: opt(r.processedAt),
    });
  },
  toRecord(m: InboxMessage, target: InboxMessageRecord = new InboxMessageRecord()): InboxMessageRecord {
    target.consumerName = m.consumerName;
    target.messageId = m.messageId;
    target.payloadHash = m.payloadHash;
    target.receivedAt = m.receivedAt;
    target.processedAt = m.processedAt ?? null;
    return target;
  },
};

export const OutboxMessageMapper = {
  toDomain(r: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: opt(r.nextAttemptAt),
      publishedAt: opt(r.publishedAt),
      lastError: opt(r.lastError),
      traceParent: opt(r.traceParent),
    });
  },
  toRecord(m: OutboxMessage, target: OutboxMessageRecord = new OutboxMessageRecord()): OutboxMessageRecord {
    target.id = m.id;
    target.aggregateId = m.aggregateId;
    target.eventType = m.eventType;
    target.payload = { ...m.payload };
    target.occurredAt = m.occurredAt;
    target.attempts = m.attempts;
    target.nextAttemptAt = m.nextAttemptAt ?? null;
    target.publishedAt = m.publishedAt ?? null;
    target.lastError = m.lastError ?? null;
    target.traceParent = m.traceParent ?? null;
    return target;
  },
};
