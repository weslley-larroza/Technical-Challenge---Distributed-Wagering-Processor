import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/**
 * Persistence ports. Application code depends only on these; the MikroORM adapter
 * implements them. Every repository instance is bound to ONE unit of work (one SQL
 * transaction): `add` stages an insert, `save` stages an update, the commit happens
 * when `UnitOfWork.run` resolves.
 */
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE on the wallet row — the per-wallet concurrency boundary. */
  lockById(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** A PROCESSED REFUND/ROLLBACK already points at this transaction. */
  isReversed(transactionId: string): Promise<boolean>;
  /** PENDING_REFERENCE rows of this wallet waiting for `(providerId, referenceExternalTransactionId)`. */
  findPendingReferencing(
    providerId: string,
    walletId: string,
    referenceExternalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  add(transaction: WagerTransaction): void;
  save(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageRow {
  entry: WalletLedgerEntry;
  /** Monotonic append position — the cursor source. */
  seq: bigint;
}

export interface LedgerTotals {
  credits: string;
  debits: string;
  count: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  /** Entries in append order with seq > afterSeq. */
  page(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<LedgerPageRow[]>;
  totals(walletId: string): Promise<LedgerTotals>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /**
   * Due, unpublished messages, row-locked with SKIP LOCKED: concurrent publishers get
   * disjoint batches and never wait on each other. Locks last until the unit of work ends.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  /**
   * Set-based "published" mark for messages already transitioned in the domain
   * (`markPublished`). One statement for the whole batch: the load test showed the
   * per-row ORM update was the publisher's bottleneck.
   */
  markPublished(messages: readonly OutboxMessage[]): Promise<void>;
  /** Unpublished count and age of the oldest one (outbox lag). */
  stats(now: Date): Promise<{ pending: number; oldestAgeMs: number }>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): void;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

export interface UnitOfWorkOptions {
  /** 'repeatable-read' gives a single consistent snapshot (used by reconciliation). */
  isolation?: 'read-committed' | 'repeatable-read';
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction; commits if it resolves, rolls back if it throws. */
  run<T>(work: (repositories: Repositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

// ---------------------------------------------------------------- adapter → application errors
/** A unique constraint fired (typically a concurrent insert of the same key). Retrying re-reads the winner. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`unique constraint violated: ${constraint ?? 'unknown'}`, options);
    this.name = 'UniqueViolationError';
  }
}

export type TransientReason = 'deadlock' | 'lock-timeout' | 'serialization' | 'connection';

/** The database is temporarily unable to complete the work; the same work may be retried. */
export class TransientPersistenceError extends Error {
  constructor(
    readonly reason: TransientReason,
    options?: { cause?: unknown },
  ) {
    super(`transient persistence failure: ${reason}`, options);
    this.name = 'TransientPersistenceError';
  }
}
