import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  createTestOrm,
  expectDbError,
  insert,
  ledgerRow,
  now,
  resetSchema,
  SQLSTATE,
  seedBet,
  seedWallet,
  txRow,
  walletRow,
} from './support/db';

let orm: MikroORM;
const em = () => orm.em.fork();
const tx = <T>(fn: Parameters<ReturnType<typeof em>['transactional']>[0]) => em().transactional(fn) as Promise<T>;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
});

afterAll(async () => {
  await orm.close(true);
});

describe('migrations', () => {
  test('are reversible: down to zero removes everything, up restores it', async () => {
    const tables = async () =>
      (
        await em().execute<{ table_name: string }[]>(
          `select table_name from information_schema.tables
            where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
        )
      ).map((r) => r.table_name);
    const functions = async () =>
      (await em().execute<{ n: string }[]>(`select count(*)::text as n from pg_proc p
         join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'`))[0]?.n;

    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    expect(await functions()).toBe('0');

    await migrator.up();
    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});

describe('wallets', () => {
  test('balance cannot be negative', async () => {
    await expectDbError(insert(em(), 'wallets', walletRow({ balance: '-0.01' })), SQLSTATE.check, /wallets_balance_non_negative_chk/);
  });

  test('one wallet per player + currency', async () => {
    const playerId = randomUUID();
    await insert(em(), 'wallets', walletRow({ player_id: playerId }));
    await insert(em(), 'wallets', walletRow({ player_id: playerId, currency: 'USD' }));
    await expectDbError(insert(em(), 'wallets', walletRow({ player_id: playerId })), SQLSTATE.unique, /wallets_player_currency_uq/);
  });

  test('a positive balance without ledger backing fails at COMMIT', async () => {
    await expectDbError(insert(em(), 'wallets', walletRow({ balance: '50.00' })), SQLSTATE.integrity, /does not match ledger/);
  });

  test('wallet + OPENING transaction + ledger commit together', async () => {
    const w = await seedWallet(orm, '100.00');
    const [row] = await em().execute<{ balance: string }[]>('select balance from wallets where id = ?', [w.walletId]);
    expect(row?.balance).toBe('100.00');
  });

  test('balance update without a ledger entry fails at COMMIT', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(
      em().execute('update wallets set balance = 90.00, version = 2 where id = ?', [w.walletId]),
      SQLSTATE.integrity,
      /does not match ledger/,
    );
  });

  test('version must move by exactly +1 with the balance (stale write / lost update guard)', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(seedBet(orm, w, '10.00', '100.00', '90.00', 1), SQLSTATE.integrity, /version must be 2/);
    await expectDbError(
      em().execute('update wallets set version = 5 where id = ?', [w.walletId]),
      SQLSTATE.integrity,
      /version may only change with balance/,
    );
    await seedBet(orm, w, '10.00', '100.00', '90.00', 2);
  });

  test('identity is immutable and wallets are never deleted', async () => {
    const w = await seedWallet(orm, '0.00');
    await expectDbError(
      em().execute('update wallets set player_id = ? where id = ?', [randomUUID(), w.walletId]),
      SQLSTATE.integrity,
      /immutable/,
    );
    await expectDbError(em().execute('delete from wallets where id = ?', [w.walletId]), SQLSTATE.integrity, /forbidden/);
  });
});

describe('ledger', () => {
  test('is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(
      em().execute("update wallet_ledger_entries set amount = 1.00 where wallet_id = ?", [w.walletId]),
      SQLSTATE.integrity,
      /UPDATE on wallet_ledger_entries is forbidden/,
    );
    await expectDbError(
      em().execute('delete from wallet_ledger_entries where wallet_id = ?', [w.walletId]),
      SQLSTATE.integrity,
      /DELETE on wallet_ledger_entries is forbidden/,
    );
    await expectDbError(em().execute('truncate wallet_ledger_entries cascade'), SQLSTATE.integrity, /TRUNCATE/);
  });

  test('arithmetic is checked: before ± amount = after', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(seedBet(orm, w, '10.00', '100.00', '91.00', 2), SQLSTATE.check, /ledger_arithmetic_chk/);
  });

  test('chain is checked: balance_before must equal the previous balance_after', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(seedBet(orm, w, '10.00', '80.00', '70.00', 2), SQLSTATE.integrity, /ledger chain broken/);
  });

  test('at most one entry per transaction and wallet', async () => {
    const w = await seedWallet(orm, '100.00');
    const txId = await seedBet(orm, w, '10.00', '100.00', '90.00', 2);
    await expectDbError(
      tx(async (e) => {
        await insert(e, 'wallet_ledger_entries', ledgerRow(w.walletId, txId, {
          direction: 'DEBIT', amount: '10.00', balance_before: '90.00', balance_after: '80.00',
        }));
        await e.execute('update wallets set balance = 80.00, version = 3 where id = ?', [w.walletId]);
      }),
      SQLSTATE.unique,
      /ledger_one_entry_per_transaction_wallet_uq/,
    );
  });

  test('entry must match its transaction (amount) and its wallet (currency)', async () => {
    const w = await seedWallet(orm, '100.00');
    // transaction is 10.00 but ledger line says 20.00
    await expectDbError(
      tx(async (e) => {
        const t = txRow(w.walletId, w.playerId, { amount: '10.00', status: 'PROCESSED', processed_at: now() });
        await insert(e, 'wager_transactions', t);
        await insert(e, 'wallet_ledger_entries', ledgerRow(w.walletId, t.id as string, {
          direction: 'DEBIT', amount: '20.00', balance_before: '100.00', balance_after: '80.00',
        }));
        await e.execute('update wallets set balance = 80.00, version = 2 where id = ?', [w.walletId]);
      }),
      SQLSTATE.foreignKey,
      /ledger_transaction_fk/,
    );
    // USD line on a BRL wallet
    await expectDbError(
      tx(async (e) => {
        const t = txRow(w.walletId, w.playerId, { currency: 'USD', status: 'PROCESSED', processed_at: now() });
        await insert(e, 'wager_transactions', t);
        await insert(e, 'wallet_ledger_entries', ledgerRow(w.walletId, t.id as string, {
          currency: 'USD', direction: 'DEBIT', balance_before: '100.00', balance_after: '90.00',
        }));
        await e.execute('update wallets set balance = 90.00, version = 2 where id = ?', [w.walletId]);
      }),
      SQLSTATE.foreignKey,
      /ledger_wallet_fk/,
    );
  });
});

describe('wager transactions', () => {
  test('idempotency: unique per (provider, external id) and per (provider, idempotency key)', async () => {
    const w = await seedWallet(orm, '0.00');
    const first = txRow(w.walletId, w.playerId);
    await insert(em(), 'wager_transactions', first);
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { external_transaction_id: first.external_transaction_id })),
      SQLSTATE.unique,
      /wager_tx_provider_external_uq/,
    );
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { idempotency_key: first.idempotency_key })),
      SQLSTATE.unique,
      /wager_tx_provider_idempotency_key_uq/,
    );
    // the same external id from ANOTHER provider is a different operation
    await insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, {
      provider_id: 'provider-b', external_transaction_id: first.external_transaction_id,
    }));
  });

  test('OPENING is internal-only; REFUND/ROLLBACK require a reference', async () => {
    const w = await seedWallet(orm, '0.00');
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { kind: 'OPENING' })),
      SQLSTATE.check,
      /wager_tx_opening_internal_chk/,
    );
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { kind: 'REFUND' })),
      SQLSTATE.check,
      /wager_tx_reversal_requires_reference_chk/,
    );
  });

  test('status-dependent columns are consistent', async () => {
    const w = await seedWallet(orm, '0.00');
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { status: 'REJECTED', processed_at: now() })),
      SQLSTATE.check,
      /wager_tx_failure_code_chk/,
    );
    await expectDbError(
      insert(em(), 'wager_transactions', txRow(w.walletId, w.playerId, { status: 'PENDING_REFERENCE' })),
      SQLSTATE.check,
      /wager_tx_pending_reference_chk/,
    );
  });

  test('terminal transactions are frozen; business columns are immutable; never deleted', async () => {
    const w = await seedWallet(orm, '100.00');
    const processedId = await seedBet(orm, w, '10.00', '100.00', '90.00', 2);
    await expectDbError(
      em().execute("update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?", [processedId]),
      SQLSTATE.integrity,
      /is terminal/,
    );
    const pending = txRow(w.walletId, w.playerId);
    await insert(em(), 'wager_transactions', pending);
    await expectDbError(
      em().execute("update wager_transactions set amount = 99.00 where id = ?", [pending.id]),
      SQLSTATE.integrity,
      /business columns are immutable/,
    );
    await expectDbError(em().execute('delete from wager_transactions where id = ?', [pending.id]), SQLSTATE.integrity, /forbidden/);
  });

  test('a transaction can be reversed only once (REFUND or ROLLBACK)', async () => {
    const w = await seedWallet(orm, '100.00');
    const betId = await seedBet(orm, w, '40.00', '100.00', '60.00', 2);
    const [bet] = await em().execute<{ external_transaction_id: string }[]>(
      'select external_transaction_id from wager_transactions where id = ?', [betId]);

    const reverse = (kind: string, before: string, after: string, version: number) =>
      tx(async (e) => {
        const t = txRow(w.walletId, w.playerId, {
          kind,
          amount: '40.00',
          status: 'PROCESSED',
          processed_at: now(),
          reference_external_transaction_id: bet?.external_transaction_id,
          reference_transaction_id: betId,
        });
        await insert(e, 'wager_transactions', t);
        await insert(e, 'wallet_ledger_entries', ledgerRow(w.walletId, t.id as string, {
          amount: '40.00', balance_before: before, balance_after: after,
        }));
        await e.execute('update wallets set balance = ?, version = ? where id = ?', [after, version, w.walletId]);
      });

    await reverse('REFUND', '60.00', '100.00', 3);
    await expectDbError(reverse('ROLLBACK', '100.00', '140.00', 4), SQLSTATE.unique, /wager_tx_single_reversal_uq/);
    await expectDbError(reverse('REFUND', '100.00', '140.00', 4), SQLSTATE.unique, /wager_tx_single_reversal_uq/);
  });
});

describe('inbox / outbox', () => {
  test('inbox deduplicates by (consumer, message id); processed is final', async () => {
    const row = { consumer_name: 'wager-consumer', message_id: 'msg-1', payload_hash: 'h', received_at: now(), processed_at: now() };
    await insert(em(), 'inbox_messages', row);
    await insert(em(), 'inbox_messages', { ...row, consumer_name: 'other-consumer' });
    await expectDbError(insert(em(), 'inbox_messages', row), SQLSTATE.unique, /inbox_messages_pk/);
    await expectDbError(
      em().execute("update inbox_messages set processed_at = now() where message_id = 'msg-1' and consumer_name = 'wager-consumer'"),
      SQLSTATE.integrity,
      /immutable once processed/,
    );
  });

  test('outbox payload is immutable and publication is irreversible', async () => {
    const id = randomUUID();
    await insert(em(), 'outbox_messages', {
      id, aggregate_id: 'agg', event_type: 'WalletBalanceChanged', payload: JSON.stringify({ a: 1 }),
      occurred_at: now(), attempts: 0, next_attempt_at: now(),
    });
    await expectDbError(
      em().execute(`update outbox_messages set payload = '{"a":2}' where id = ?`, [id]),
      SQLSTATE.integrity,
      /content is immutable/,
    );
    await expectDbError(
      em().execute('update outbox_messages set published_at = now() where id = ?', [id]),
      SQLSTATE.check,
      /outbox_schedule_chk/,
    );
    await em().execute('update outbox_messages set published_at = now(), next_attempt_at = null where id = ?', [id]);
    await expectDbError(
      em().execute('update outbox_messages set published_at = null, next_attempt_at = now() where id = ?', [id]),
      SQLSTATE.integrity,
      /already published/,
    );
  });
});
