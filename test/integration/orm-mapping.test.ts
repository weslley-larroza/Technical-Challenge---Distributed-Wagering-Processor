import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletBalanceChanged } from '../../src/domain/messaging/events';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../src/infrastructure/persistence/entities';
import {
  LedgerEntryMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletMapper,
} from '../../src/infrastructure/persistence/mappers';
import { createTestOrm, resetSchema } from './support/db';

let orm: MikroORM;
const MAX = '999999999999999999.99';

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close(true);
});

/** Opens a wallet the domain way and persists wallet + OPENING tx + entry in one unit of work. */
async function openWallet(initial: string): Promise<Wallet> {
  const now = new Date();
  const walletId = randomUUID();
  const openingTxId = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: randomUUID(),
    initialBalance: Money.from({ amount: initial, currency: 'BRL' }),
    opening: { transactionId: openingTxId, ledgerEntryId: randomUUID() },
    now,
  });
  await orm.em.fork().transactional(async (em) => {
    em.persist(WalletMapper.toRecord(wallet));
    if (openingEntry) {
      const opening = WagerTransaction.opening({
        id: openingTxId,
        walletId,
        playerId: wallet.playerId,
        money: wallet.balance,
        payloadHash: 'sha256:opening',
        at: now,
      });
      em.persist(WagerTransactionMapper.toRecord(opening));
      em.persist(LedgerEntryMapper.toNewRecord(openingEntry));
    }
  });
  return wallet;
}

describe('ORM mapping (domain ⇄ records ⇄ PostgreSQL)', () => {
  test('wallet round-trips with exact NUMERIC precision at the limit', async () => {
    const wallet = await openWallet(MAX);
    const record = await orm.em.fork().findOneOrFail(WalletRecord, wallet.id);
    expect(typeof record.balance).toBe('string');
    const back = WalletMapper.toDomain(record);
    expect(back.balance.amount).toBe(MAX);
    expect(back.version).toBe(1);
    expect(back.playerId).toBe(wallet.playerId);
  });

  test('a settled BET persists tx + ledger + wallet + outbox atomically and rehydrates faithfully', async () => {
    const wallet = await openWallet('100.00');
    const now = new Date();

    await orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(WalletRecord, wallet.id);
      const w = WalletMapper.toDomain(record);
      const bet = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        idempotencyKey: 'provider-a:bet-1',
        payloadHash: 'sha256:bet',
        walletId: w.id,
        playerId: w.playerId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.10', currency: 'BRL' }),
        createdAt: now,
      });
      const outcome = WagerSettlement.settle({ wallet: w, transaction: bet, ledgerEntryId: randomUUID(), now });
      if (outcome.type !== 'processed' || !outcome.ledgerEntry) throw new Error('expected processed');

      WalletMapper.toRecord(w, record); // managed → UoW flushes an UPDATE of changed columns
      em.persist(WagerTransactionMapper.toRecord(bet));
      em.persist(LedgerEntryMapper.toNewRecord(outcome.ledgerEntry));
      const event = WalletBalanceChanged.from(w, outcome.ledgerEntry, {
        newId: randomUUID,
        correlationId: 'corr-1',
        occurredAt: now,
      });
      em.persist(OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event)));
    });

    const em = orm.em.fork();
    const w = WalletMapper.toDomain(await em.findOneOrFail(WalletRecord, wallet.id));
    expect(w.balance.amount).toBe('74.90');
    expect(w.version).toBe(2);

    const t = WagerTransactionMapper.toDomain(
      await em.findOneOrFail(WagerTransactionRecord, { providerId: 'provider-a', externalTransactionId: 'bet-1' }),
    );
    expect(t.status).toBe(WagerTransactionStatus.Processed);
    expect(t.balanceAfter?.amount).toBe('74.90');
    expect(t.referenceExternalTransactionId).toBeUndefined();

    const entries = (await em.find(LedgerEntryRecord, { walletId: wallet.id })).map(LedgerEntryMapper.toDomain);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.isBalanced())).toBe(true);

    const [outbox] = await em.find(OutboxMessageRecord, { aggregateId: wallet.id });
    const msg = OutboxMessageMapper.toDomain(outbox!);
    expect(msg.isPending()).toBe(true);
    expect((msg.payload.data as { balanceAfter: unknown }).balanceAfter).toEqual({ amount: '74.90', currency: 'BRL' });
  });

  test('a failing invariant rolls back the WHOLE unit of work (nothing partial is committed)', async () => {
    const wallet = await openWallet('100.00');
    const txId = randomUUID();
    const attempt = orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(WalletRecord, wallet.id);
      record.balance = '50.00'; // balance change WITHOUT ledger entry
      record.version = 2;
      const t = new WagerTransactionRecord();
      Object.assign(t, WagerTransactionMapper.toRecord(
        WagerTransaction.create({
          id: txId,
          providerId: 'provider-a',
          externalTransactionId: `x-${txId}`,
          idempotencyKey: `provider-a:x-${txId}`,
          payloadHash: 'h',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'r',
          gameId: 'g',
          kind: WagerTransactionKind.Bet,
          money: Money.from({ amount: '50.00', currency: 'BRL' }),
          createdAt: new Date(),
        }),
      ));
      em.persist(t);
    });
    await expect(attempt).rejects.toThrow(/does not match ledger/);

    const em = orm.em.fork();
    expect((await em.findOneOrFail(WalletRecord, wallet.id)).balance).toBe('100.00');
    expect(await em.findOne(WagerTransactionRecord, txId)).toBeNull();
  });
});
