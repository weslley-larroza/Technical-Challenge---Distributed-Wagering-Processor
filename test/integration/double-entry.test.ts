import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { expectGlobalInvariant } from '../support/cluster';
import { type App, buildApp, command, openWallet } from '../support/app';
import { GetTrialBalance } from '../../src/application/ledger/trial-balance';
import { Money } from '../../src/domain/money/money';
import { noopLogger } from '../../src/application/ports/system';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import {
  createTestOrm,
  expectDbError,
  insert,
  insertJournal,
  ledgerRow,
  now,
  resetSchema,
  SQLSTATE,
  seedWallet,
  txRow,
  walletRow,
} from './support/db';

let orm: MikroORM;
let app: App;
const em = () => orm.em.fork();

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  app = buildApp(orm);
});

afterAll(async () => {
  await orm.close(true);
});

describe('migration 4 backfills existing data into a balanced journal', () => {
  test('data written before the journal existed is booked with both legs', async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ migrations: ['Migration20261116000004DoubleEntryJournal'] }); // back to the pre-journal schema
    // a wallet with an OPENING and a BET, written the pre-migration way (no journal tables yet)
    const wallet = walletRow({ balance: '75.00', version: 2 });
    const walletId = wallet.id as string;
    await em().transactional(async (e) => {
      await insert(e, 'wallets', { ...wallet, balance: '100.00', version: 1 });
      const opening = txRow(walletId, wallet.player_id as string, {
        provider_id: 'internal', external_transaction_id: `opening:${walletId}`, idempotency_key: `internal:opening:${walletId}`,
        kind: 'OPENING', amount: '100.00', status: 'PROCESSED', processed_at: now(), round_id: 'opening', game_id: 'internal',
      });
      await insert(e, 'wager_transactions', opening);
      await insert(e, 'wallet_ledger_entries', ledgerRow(walletId, opening.id as string, { amount: '100.00', balance_after: '100.00' }));
      const bet = txRow(walletId, wallet.player_id as string, { amount: '25.00', status: 'PROCESSED', processed_at: now() });
      await insert(e, 'wager_transactions', bet);
      await insert(e, 'wallet_ledger_entries', ledgerRow(walletId, bet.id as string, {
        direction: 'DEBIT', amount: '25.00', balance_before: '100.00', balance_after: '75.00',
      }));
      await e.execute('update wallets set balance = 75.00, version = 2 where id = ?', [walletId]);
    });

    await migrator.up();

    const postings = await em().execute<{ code: string; direction: string; amount: string }[]>(
      `select a.code, p.direction, p.amount from journal_postings p join ledger_accounts a on a.id = p.account_id
        join wager_transactions t on t.id = p.transaction_id where t.wallet_id = ? order by p.seq`,
      [walletId],
    );
    expect(postings).toEqual([
      { code: `wallet:${walletId}`, direction: 'CREDIT', amount: '100.00' },
      { code: `wallet:${walletId}`, direction: 'DEBIT', amount: '25.00' },
      { code: 'funding:BRL', direction: 'DEBIT', amount: '100.00' },
      { code: 'provider:provider-a:BRL', direction: 'CREDIT', amount: '25.00' },
    ]);
    await expectGlobalInvariant(orm);
  });
});

describe('database-enforced double-entry rules (checked at COMMIT)', () => {
  /** A processed BET of 10.00 on a fresh 100.00 wallet, with a custom journal. */
  const betWith = (journal: (e: Parameters<Parameters<ReturnType<typeof em>['transactional']>[0]>[0], walletId: string, txId: string) => Promise<void>) =>
    seedWallet(orm, '100.00').then((w) =>
      em().transactional(async (e) => {
        const t = txRow(w.walletId, w.playerId, { amount: '10.00', status: 'PROCESSED', processed_at: now() });
        await insert(e, 'wager_transactions', t);
        await insert(e, 'wallet_ledger_entries', ledgerRow(w.walletId, t.id as string, {
          direction: 'DEBIT', amount: '10.00', balance_before: '100.00', balance_after: '90.00',
        }));
        await e.execute('update wallets set balance = 90.00, version = 2 where id = ?', [w.walletId]);
        await journal(e, w.walletId, t.id as string);
      }),
    );

  test('a correct journal commits', async () => {
    await betWith((e, walletId, txId) => insertJournal(e, { walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00' }));
  });

  test('a wallet movement without a journal is rejected', async () => {
    await expectDbError(betWith(async () => {}), SQLSTATE.integrity, /moved a wallet without a double-entry journal/);
  });

  test('an unbalanced journal is rejected', async () => {
    await expectDbError(
      betWith(async (e, walletId, txId) => {
        await insertJournal(e, { walletId, transactionId: txId, direction: 'DEBIT', amount: '10.00' });
        // an extra leg breaks Σ debits = Σ credits
        await e.execute(
          `insert into ledger_accounts (id, code, kind, currency, wallet_id, created_at)
           values (md5('account:funding:BRL')::uuid, 'funding:BRL', 'FUNDING', 'BRL', null, now()) on conflict (code) do nothing`,
        );
        await e.execute(
          `insert into journal_postings (id, transaction_id, account_id, direction, amount, currency, created_at)
           values (?, ?, md5('account:funding:BRL')::uuid, 'CREDIT', 1.00, 'BRL', now())`,
          [randomUUID(), txId],
        );
      }),
      SQLSTATE.integrity,
      /is not balanced/,
    );
  });

  test('a balanced journal that does not mirror the wallet entry is rejected', async () => {
    await expectDbError(
      // balanced (5 = 5), but the player leg says 5.00 while the wallet moved 10.00
      betWith((e, walletId, txId) => insertJournal(e, { walletId, transactionId: txId, direction: 'DEBIT', amount: '5.00' })),
      SQLSTATE.integrity,
      /does not mirror its wallet ledger entry/,
    );
  });

  test('a journal without a wallet movement is rejected', async () => {
    const w = await seedWallet(orm, '100.00');
    await expectDbError(
      em().transactional(async (e) => {
        const t = txRow(w.walletId, w.playerId, { kind: 'LOSS', status: 'PROCESSED', processed_at: now() });
        await insert(e, 'wager_transactions', t);
        await insertJournal(e, { walletId: w.walletId, transactionId: t.id as string, direction: 'DEBIT', amount: '10.00' });
      }),
      SQLSTATE.integrity,
      /has no wallet ledger entry/,
    );
  });

  test('postings and accounts are append-only', async () => {
    await seedWallet(orm, '100.00');
    await expectDbError(em().execute('update journal_postings set amount = 1.00'), SQLSTATE.integrity, /forbidden/);
    await expectDbError(em().execute('delete from journal_postings'), SQLSTATE.integrity, /forbidden/);
    await expectDbError(em().execute("update ledger_accounts set code = 'x'"), SQLSTATE.integrity, /forbidden/);
  });
});

describe('trial balance after real flows', () => {
  test('book balances; provider account holds the house result; funding holds what entered', async () => {
    await resetSchema(orm); // isolated book for exact numbers
    const w1 = await openWallet(app, '100.00');
    const w2 = await openWallet(app, '50.00');
    const bet = command(w1, { money: { amount: '30.00', currency: 'BRL' } });
    await app.submit.execute(bet);
    await app.submit.execute(command(w1, { kind: 'WIN', money: { amount: '45.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }));
    await app.submit.execute(command(w2, { money: { amount: '20.00', currency: 'BRL' } }));
    await app.submit.execute(command(w2, { kind: 'LOSS', money: { amount: '20.00', currency: 'BRL' } })); // no movement, no journal
    await app.submit.execute(command(w2, { providerId: 'provider-b', idempotencyKey: `provider-b:${randomUUID()}`, money: { amount: '5.00', currency: 'BRL' } }));

    const report = await new GetTrialBalance(new MikroOrmUnitOfWork(orm), app.metrics, noopLogger).execute('BRL');
    const line = (code: string) => report.lines.find((l) => l.code === code);
    expect(report.balanced).toBe(true);
    expect(report.totals.debits).toEqual(report.totals.credits);
    expect(line('funding:BRL')?.balance.amount).toBe('-150.00'); // 100 + 50 entered
    expect(line('provider:provider-a:BRL')?.balance.amount).toBe('5.00'); // +30 +20 −45
    expect(line('provider:provider-b:BRL')?.balance.amount).toBe('5.00');
    expect(line('wallet:*')).toMatchObject({ accounts: 2, balance: { amount: '140.00' } }); // 115 + 25
    // Σ of every account balance is exactly zero (closed system)
    const signedSum = report.lines.reduce((acc, l) => {
      const abs = Money.from({ amount: l.balance.amount.replace(/^-/, ''), currency: 'BRL' });
      return acc.add(l.balance.amount.startsWith('-') ? abs.negate() : abs);
    }, Money.zero('BRL'));
    expect(signedSum.isZero()).toBe(true);

    for (const w of [w1, w2]) {
      const r = await app.reconcile.execute(w.id, 'c');
      expect(r.consistent).toBe(true);
      expect(r.journalBalance).toEqual(r.storedBalance);
    }
    await expectGlobalInvariant(orm);
  });
});
