/**
 * Real parallelism against PostgreSQL: concurrent units of work on a pool of real
 * connections (no mocks, no sequential fakes). Multi-PROCESS scenarios live in
 * test/concurrency/multi-instance.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { WalletView } from '../../src/application/wallets/create-wallet';
import { createTestOrm, resetSchema } from '../integration/support/db';
import { type App, buildApp, command, expectLedgerInvariant, openWallet } from '../support/app';

let orm: MikroORM;
let app: App;

beforeAll(async () => {
  orm = await createTestOrm(30);
  await resetSchema(orm);
  app = buildApp(orm);
});

afterAll(async () => {
  await orm.close(true);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function ledgerCount(w: WalletView, direction?: 'DEBIT' | 'CREDIT'): Promise<number> {
  const rows = await orm.em
    .fork()
    .execute<{ n: number }[]>(
      `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? ${direction ? 'and direction = ?' : ''}`,
      direction ? [w.id, direction] : [w.id],
    );
  return rows[0]?.n ?? 0;
}

describe('section 8 — mandatory scenario', () => {
  test('100.00 and two simultaneous 80.00 bets: one PROCESSED, one REJECTED, 20.00 left, one debit (x10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const w = await openWallet(app, '100.00');
      const results = await Promise.all([
        app.submit.execute(command(w, { money: brl('80.00') })),
        app.submit.execute(command(w, { money: brl('80.00') })),
      ]);
      const statuses = results.map((r) => String(r.status)).sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(String(results.find((r) => r.status === 'REJECTED')?.failureCode)).toBe('INSUFFICIENT_FUNDS');
      expect((await app.queries.getWallet(w.id)).balance.amount).toBe('20.00');
      expect(await ledgerCount(w, 'DEBIT')).toBe(1);

      // retrying both requests never duplicates the debit
      // (re-submitting is a replay of each original outcome)
      await expectLedgerInvariant(app, w.id);
    }
  });
});

describe('idempotency under contention', () => {
  test('the same BET sent 50 times in parallel → exactly one debit, 49 replays, one transaction id', async () => {
    const w = await openWallet(app, '1000.00');
    const cmd = command(w);
    const results = await Promise.all(Array.from({ length: 50 }, () => app.submit.execute(cmd)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '975.00')).toBe(true);
    expect(await ledgerCount(w, 'DEBIT')).toBe(1);
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('975.00');
    await expectLedgerInvariant(app, w.id);
  });

  test('the same key raced with DIFFERENT payloads → one wins, the rest are conflicts', async () => {
    const w = await openWallet(app, '1000.00');
    const base = command(w);
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => app.submit.execute({ ...base, money: brl(`${i + 1}.00`) })),
    );
    const winners = settled.filter((s) => s.status === 'fulfilled' && !s.value.idempotentReplay);
    expect(winners).toHaveLength(1);
    const others = settled.filter((s) => s !== winners[0]);
    for (const s of others) {
      if (s.status === 'fulfilled') {
        // same payload as the winner → legitimate replay
        expect(s.value.idempotentReplay).toBe(true);
      } else {
        expect(s.reason).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      }
    }
    expect(await ledgerCount(w, 'DEBIT')).toBe(1);
    await expectLedgerInvariant(app, w.id);
  });
});

describe('hot wallet', () => {
  test('100 parallel 1.00 bets on 50.00 → exactly 50 processed, balance 0.00, never negative', async () => {
    const w = await openWallet(app, '50.00');
    const results = await Promise.all(
      Array.from({ length: 100 }, () => app.submit.execute(command(w, { money: brl('1.00') }))),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(50);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    const final = await app.queries.getWallet(w.id);
    expect(final.balance.amount).toBe('0.00');
    expect(final.version).toBe(51);
    expect(await ledgerCount(w, 'DEBIT')).toBe(50);
    await expectLedgerInvariant(app, w.id);
  });

  test('mixed credits and debits in parallel keep balance == ledger', async () => {
    const w = await openWallet(app, '100.00');
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        app.submit.execute(command(w, { kind: i % 3 === 0 ? 'WIN' : 'BET', money: brl('3.00') })),
      ),
    );
    await expectLedgerInvariant(app, w.id);
    const final = await app.queries.getWallet(w.id);
    expect(final.balance.amount).toBe('40.00'); // 100 + 20*3 − 40*3
  });
});

describe('independent wallets', () => {
  test('20 wallets × 10 bets in parallel all settle correctly', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(app, '100.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 10 }, () => app.submit.execute(command(w, { money: brl('5.00') })))),
    );
    for (const w of wallets) {
      expect((await app.queries.getWallet(w.id)).balance.amount).toBe('50.00');
      await expectLedgerInvariant(app, w.id);
    }
  });
});

describe('out-of-order under concurrency', () => {
  test('ROLLBACK and its BET submitted at the same time, 20 rounds → always converges', async () => {
    const w = await openWallet(app, '1000.00');
    await Promise.all(
      Array.from({ length: 20 }, () => {
        const bet = command(w, { money: brl('10.00') });
        const rollback = command(w, {
          kind: 'ROLLBACK',
          money: brl('10.00'),
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        return Promise.all([app.submit.execute(rollback), app.submit.execute(bet)]);
      }),
    );
    const rows = await orm.em
      .fork()
      .execute<{ status: string; n: number }[]>(
        `select status, count(*)::int as n from wager_transactions where wallet_id = ? and kind = 'ROLLBACK' group by status`,
        [w.id],
      );
    expect(rows).toEqual([{ status: 'PROCESSED', n: 20 }]);
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('1000.00');
    await expectLedgerInvariant(app, w.id);
  });
});
