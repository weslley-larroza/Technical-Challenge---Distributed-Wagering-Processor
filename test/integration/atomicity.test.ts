/**
 * Section 11 / 13 — "atomicidade entre wallet, ledger, inbox e outbox".
 *
 * The failure is injected AT COMMIT TIME, after every INSERT/UPDATE of the unit of work
 * has already been executed by PostgreSQL (a test-only DEFERRABLE constraint trigger on
 * outbox_messages raises during COMMIT). If anything were not part of the same SQL
 * transaction it would survive the failure. Nothing may survive.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type App, buildApp, command, expectLedgerInvariant, openWallet } from '../support/app';
import { createTestOrm, resetSchema } from './support/db';

let orm: MikroORM;
let app: App;

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  app = buildApp(orm);
  await orm.em.fork().execute(`
    create function test_fail_at_commit() returns trigger language plpgsql as $fn$
    begin
      raise exception 'simulated failure at COMMIT (outbox row for %)', new.aggregate_id;
    end $fn$`);
});

afterAll(async () => {
  await orm.em.fork().execute('drop function if exists test_fail_at_commit() cascade');
  await orm.close(true);
});

async function counts(walletId: string, externalId: string, messageId: string) {
  const [row] = await orm.em.fork().execute<{ tx: number; ledger: number; inbox: number; outbox: number; balance: string; version: number }[]>(
    `select
       (select count(*)::int from wager_transactions where external_transaction_id = ?) as tx,
       (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger,
       (select count(*)::int from inbox_messages where message_id = ?) as inbox,
       (select count(*)::int from outbox_messages o
          where o.aggregate_id = ? or o.aggregate_id in (select id::text from wager_transactions where external_transaction_id = ?)) as outbox,
       (select balance::text from wallets where id = ?) as balance,
       (select version from wallets where id = ?) as version`,
    [externalId, walletId, messageId, walletId, externalId, walletId, walletId],
  );
  return row!;
}

describe('atomicity of wallet + ledger + transaction + inbox + outbox', () => {
  test('a failure at COMMIT leaves NOTHING behind; the redelivery then applies everything exactly once', async () => {
    const w = await openWallet(app, '100.00');
    const before = await counts(w.id, '-', '-');
    // only this wallet's balance-change event fails at commit (deferred → raised during COMMIT)
    await orm.em.fork().execute(`
      create constraint trigger test_fail_commit_${w.id.replaceAll('-', '_')}
        after insert on outbox_messages deferrable initially deferred
        for each row when (new.aggregate_id = '${w.id}')
        execute function test_fail_at_commit()`);

    const messageId = `msg-${randomUUID()}`;
    const cmd = {
      ...command(w, { money: { amount: '40.00', currency: 'BRL' } }),
      message: { consumerName: 'wager-transactions-consumer', messageId, payloadHash: 'sha256:m' },
    };
    await expect(app.submit.execute(cmd)).rejects.toThrow(/simulated failure at COMMIT/);

    // every write of the unit of work was rolled back together
    expect(await counts(w.id, cmd.externalTransactionId, messageId)).toEqual({
      tx: 0,
      ledger: before.ledger, // only the opening entry
      inbox: 0, // → the message will be redelivered and processed again
      outbox: before.outbox, // only the opening WalletBalanceChanged
      balance: '100.00',
      version: 1,
    });

    // dependency fixed, message redelivered: applied once, all pieces present
    await orm.em.fork().execute(`drop trigger test_fail_commit_${w.id.replaceAll('-', '_')} on outbox_messages`);
    const result = await app.submit.execute(cmd);
    expect(result).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '60.00' } });
    const after = await counts(w.id, cmd.externalTransactionId, messageId);
    expect(after).toEqual({
      tx: 1,
      ledger: before.ledger + 1,
      inbox: 1,
      outbox: before.outbox + 2, // WagerTransactionProcessed + WalletBalanceChanged
      balance: '60.00',
      version: 2,
    });

    // and a second redelivery is a replay with no new effect
    expect((await app.submit.execute(cmd)).idempotentReplay).toBe(true);
    expect(await counts(w.id, cmd.externalTransactionId, messageId)).toEqual(after);
    await expectLedgerInvariant(app, w.id);
  });
});
