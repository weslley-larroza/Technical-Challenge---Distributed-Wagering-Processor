import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxRepository,
  LedgerPageRow,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/persistence';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities';
import {
  InboxMessageMapper,
  LedgerEntryMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletMapper,
} from './mappers';

/**
 * Repositories bound to one transactional EntityManager. Loaded records stay in the
 * Identity Map, so `save()` copies domain state onto the managed record and the Unit of
 * Work flushes only changed columns at commit.
 */
class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { playerId, currency });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  add(wallet: Wallet): void {
    this.em.persist(WalletMapper.toRecord(wallet));
  }

  async save(wallet: Wallet): Promise<void> {
    const managed = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    WalletMapper.toRecord(wallet, managed);
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, where);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  findById(id: string) {
    return this.one({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string) {
    return this.one({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string) {
    return this.one({ providerId, externalTransactionId });
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const rows = await this.em.execute<{ one: number }[]>(
      `select 1 as one from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
        limit 1`,
      [transactionId],
    );
    return rows.length > 0;
  }

  async findPendingReferencing(providerId: string, walletId: string, referenceExternalTransactionId: string) {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { providerId, walletId, referenceExternalTransactionId, status: WagerTransactionStatus.PendingReference },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    return rows.map(WagerTransactionMapper.toDomain);
  }

  async findDuePendingReferences(now: Date, limit: number) {
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
        order by next_reference_check_at
        limit ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(WagerTransactionMapper.toRecord(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const managed = await this.em.findOneOrFail(WagerTransactionRecord, { id: transaction.id });
    WagerTransactionMapper.toRecord(transaction, managed);
  }
}

interface LedgerRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date;
  seq: string;
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.persist(LedgerEntryMapper.toNewRecord(entry));
  }

  async page(walletId: string, afterSeq: bigint | undefined, limit: number): Promise<LedgerPageRow[]> {
    const rows = await this.em.execute<LedgerRow[]>(
      `select id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
              created_at, seq::text as seq
         from wallet_ledger_entries
        where wallet_id = ? and seq > ?
        order by seq
        limit ?`,
      [walletId, (afterSeq ?? 0n).toString(), limit],
    );
    return rows.map((row) => {
      const record = new LedgerEntryRecord();
      Object.assign(record, {
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
        createdAt: new Date(row.created_at),
      });
      return { entry: LedgerEntryMapper.toDomain(record), seq: BigInt(row.seq) };
    });
  }

  async totals(walletId: string): Promise<LedgerTotals> {
    const [row] = await this.em.execute<{ credits: string; debits: string; count: number }[]>(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::numeric(30,2)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'),  0)::numeric(30,2)::text as debits,
              count(*)::int as count
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    return { credits: row?.credits ?? '0.00', debits: row?.debits ?? '0.00', count: row?.count ?? 0 };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(OutboxMessageMapper.toRecord(message));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxMessageRecord, { consumerName, messageId });
    return r ? InboxMessageMapper.toDomain(r) : undefined;
  }

  add(message: InboxMessage): void {
    this.em.persist(InboxMessageMapper.toRecord(message));
  }
}

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
