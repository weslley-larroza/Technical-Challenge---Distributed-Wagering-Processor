import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { InvalidMoneyError, DomainValidationError } from '../../src/domain/shared/errors';
import { REFERENCE_RETRY_POLICY } from '../../src/domain/wagering/wager-transaction';
import { type App, buildApp, command, expectLedgerInvariant, FakeClock, openWallet } from '../support/app';
import { createTestOrm, resetSchema } from './support/db';

let orm: MikroORM;
let app: App;
const touched = new Set<string>();

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  app = buildApp(orm);
});

afterEach(async () => {
  for (const walletId of touched) await expectLedgerInvariant(app, walletId);
  touched.clear();
});

afterAll(async () => {
  await orm.close(true);
});

async function wallet(amount = '1000.00') {
  const w = await openWallet(app, amount);
  touched.add(w.id);
  return w;
}

async function eventsFor(aggregateId: string): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .execute<{ event_type: string }[]>(
      'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type',
      [aggregateId],
    );
  return rows.map((r) => r.event_type);
}

describe('CreateWallet', () => {
  test('opens at version 1 with an OPENING credit and a WalletBalanceChanged event', async () => {
    const w = await wallet('1000.00');
    expect(w.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(w.version).toBe(1);
    const ledger = await app.queries.getLedger(w.id, undefined);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ direction: 'CREDIT', balanceBefore: { amount: '0.00' }, balanceAfter: { amount: '1000.00' } });
    expect(await eventsFor(w.id)).toEqual(['WalletBalanceChanged']);
  });

  test('zero initial balance: no OPENING, no ledger, no event', async () => {
    const w = await wallet('0.00');
    expect((await app.queries.getLedger(w.id, undefined)).entries).toHaveLength(0);
    expect(await eventsFor(w.id)).toEqual([]);
  });

  test('duplicate player + currency is a conflict (sequential and concurrent)', async () => {
    const playerId = randomUUID();
    const create = () =>
      app.createWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' }, correlationId: 'c' });
    const results = await Promise.allSettled([create(), create(), create(), create()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
    touched.add((ok[0] as PromiseFulfilledResult<{ id: string }>).value.id);
    expect(create()).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('rejects invalid money', async () => {
    await expect(
      app.createWallet.execute({ playerId: randomUUID(), initialBalance: { amount: '1e3', currency: 'BRL' }, correlationId: 'c' }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('SubmitWagerTransaction — idempotency', () => {
  test('BET is processed; identical resubmission replays the ORIGINAL result', async () => {
    const w = await wallet('1000.00');
    const cmd = command(w);
    const first = await app.submit.execute(cmd);
    expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    await app.submit.execute(command(w, { money: { amount: '100.00', currency: 'BRL' } })); // balance moves on
    const replay = await app.submit.execute(cmd);
    expect(replay).toEqual({ ...first, idempotentReplay: true }); // still 975.00: the balance observed back then
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('875.00');
  });

  test('amount "25" and "25.00" are the same request', async () => {
    const w = await wallet();
    const cmd = command(w, { money: { amount: '25', currency: 'BRL' } });
    await app.submit.execute(cmd);
    const replay = await app.submit.execute({ ...cmd, money: { amount: '25.00', currency: 'BRL' } });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const w = await wallet();
    const cmd = command(w);
    await app.submit.execute(cmd);
    const conflict = app.submit.execute({ ...cmd, money: { amount: '26.00', currency: 'BRL' } });
    await expect(conflict).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(conflict).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('975.00');
  });

  test('same external id under another key is a conflict', async () => {
    const w = await wallet();
    const cmd = command(w);
    await app.submit.execute(cmd);
    await expect(app.submit.execute({ ...cmd, idempotencyKey: 'another-key' })).rejects.toMatchObject({
      code: 'EXTERNAL_ID_REUSED',
    });
  });

  test('transport metadata (correlationId) does not affect idempotency', async () => {
    const w = await wallet();
    const cmd = command(w);
    await app.submit.execute(cmd);
    expect((await app.submit.execute({ ...cmd, correlationId: 'other' })).idempotentReplay).toBe(true);
  });
});

describe('SubmitWagerTransaction — rules end to end', () => {
  test('unknown wallet → WalletNotFoundError, nothing persisted', async () => {
    const ghost = { id: randomUUID(), playerId: randomUUID(), balance: { amount: '0.00', currency: 'BRL' }, version: 1 };
    const cmd = command(ghost);
    await expect(app.submit.execute(cmd)).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(app.queries.getTransactionByExternalId('provider-a', cmd.externalTransactionId)).rejects.toThrow();
  });

  test.each([
    ['malformed walletId', { walletId: 'not-a-uuid' }],
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['missing idempotency key', { idempotencyKey: '' }],
    ['3 decimals', { money: { amount: '1.001', currency: 'BRL' } }],
    ['REFUND without reference', { kind: 'REFUND' }],
  ])('invalid input (%s) is rejected before persistence', async (_, overrides) => {
    const w = await wallet();
    const cmd = command(w, overrides as never);
    await expect(app.submit.execute(cmd)).rejects.toMatchObject({ category: 'validation' });
  });

  test('insufficient funds → REJECTED with stable code + guidance, event, no ledger', async () => {
    const w = await wallet('10.00');
    const result = await app.submit.execute(command(w, { money: { amount: '10.01', currency: 'BRL' } }));
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      retryGuidance: 'GIVE_UP',
      balance: { amount: '10.00' },
    });
    expect(await eventsFor(result.transactionId)).toEqual(['WagerTransactionRejected']);
    expect((await app.queries.getLedger(w.id, undefined)).entries).toHaveLength(1);
  });

  test('currency mismatch → REJECTED CURRENCY_MISMATCH', async () => {
    const w = await wallet();
    const result = await app.submit.execute(command(w, { money: { amount: '1.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
  });

  test('LOSS: PROCESSED, WagerTransactionProcessed only, no balance change', async () => {
    const w = await wallet();
    const result = await app.submit.execute(command(w, { kind: 'LOSS' }));
    expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '1000.00' } });
    expect(await eventsFor(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect((await app.queries.getWallet(w.id)).version).toBe(1);
  });

  test('BET → WIN → ROLLBACK(WIN) → REFUND(BET) full round', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { money: { amount: '40.00', currency: 'BRL' } });
    const win = command(w, { kind: 'WIN', money: { amount: '90.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });
    await app.submit.execute(bet);
    await app.submit.execute(win);
    const rb = await app.submit.execute(command(w, { kind: 'ROLLBACK', money: { amount: '90.00', currency: 'BRL' }, referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb).toMatchObject({ status: 'PROCESSED', balance: { amount: '60.00' } });
    const refund = await app.submit.execute(command(w, { kind: 'REFUND', money: { amount: '40.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const again = await app.submit.execute(command(w, { kind: 'ROLLBACK', money: { amount: '40.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect((await app.queries.getWallet(w.id)).version).toBe(5);
  });
});

describe('out-of-order references', () => {
  test('ROLLBACK before its BET → PENDING_REFERENCE, resolved in the same commit as the BET', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { money: { amount: '30.00', currency: 'BRL' } });
    const rollback = command(w, { kind: 'ROLLBACK', money: { amount: '30.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await app.submit.execute(rollback);
    expect({ ...pending }).toEqual({ transactionId: pending.transactionId, status: 'PENDING_REFERENCE', idempotentReplay: false } as never);
    expect(await eventsFor(pending.transactionId)).toEqual(['WagerTransactionPendingReference']);

    const betResult = await app.submit.execute(bet);
    expect(betResult).toMatchObject({ status: 'PROCESSED', balance: { amount: '70.00' } });

    const resolved = await app.queries.getTransaction(pending.transactionId);
    expect(resolved).toMatchObject({ status: 'PROCESSED', referenceTransactionId: betResult.transactionId, balanceAfter: { amount: '100.00' } });
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('100.00');
  });

  test('chain: ROLLBACK(REFUND) and REFUND(BET) both before the BET → cascade resolves both', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { money: { amount: '20.00', currency: 'BRL' } });
    const refund = command(w, { kind: 'REFUND', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });
    const rollbackRefund = command(w, { kind: 'ROLLBACK', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: refund.externalTransactionId });
    await app.submit.execute(rollbackRefund);
    await app.submit.execute(refund);
    await app.submit.execute(bet);
    const statuses = await Promise.all(
      [bet, refund, rollbackRefund].map((c) => app.queries.getTransactionByExternalId('provider-a', c.externalTransactionId)),
    );
    expect(statuses.map((s) => s.status)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
    // −20 (bet) +20 (refund) −20 (rollback of refund)
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('80.00');
  });

  test('two reversals waiting on the same BET: only the first succeeds', async () => {
    const w = await wallet('100.00');
    const bet = command(w, { money: { amount: '10.00', currency: 'BRL' } });
    const refund = command(w, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = command(w, { kind: 'ROLLBACK', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });
    await app.submit.execute(refund);
    await app.submit.execute(rollback);
    await app.submit.execute(bet);
    const [r1, r2] = await Promise.all(
      [refund, rollback].map((c) => app.queries.getTransactionByExternalId('provider-a', c.externalTransactionId)),
    );
    expect(r1).toMatchObject({ status: 'PROCESSED' });
    expect(r2).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('100.00');
  });

  test('worker: retries with backoff, then REJECTED REFERENCE_NOT_FOUND + event', async () => {
    const clock = new FakeClock();
    const timed = buildApp(orm, clock);
    const w = await openWallet(timed, '100.00');
    touched.add(w.id);
    const refund = await timed.submit.execute(
      command(w, { kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: 'never-arrives' }),
    );
    expect(String(refund.status)).toBe('PENDING_REFERENCE');

    // not due yet → untouched
    expect((await timed.resolver.runOnce()).scanned).toBe(0);

    for (let i = 1; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) {
      clock.advance(REFERENCE_RETRY_POLICY.maxMs + 1);
      await timed.resolver.runOnce();
      expect(String((await timed.queries.getTransaction(refund.transactionId)).status)).toBe('PENDING_REFERENCE');
    }
    clock.advance(REFERENCE_RETRY_POLICY.maxMs + 1);
    const report = await timed.resolver.runOnce();
    expect(report.rejected).toBeGreaterThanOrEqual(1);

    const final = await timed.queries.getTransaction(refund.transactionId);
    expect(final).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await eventsFor(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await timed.queries.getWallet(w.id)).balance.amount).toBe('100.00');
  });
});

describe('queries', () => {
  test('ledger pagination with a stable opaque cursor', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 4; i++) await app.submit.execute(command(w, { money: { amount: '1.00', currency: 'BRL' } }));
    const p1 = await app.queries.getLedger(w.id, undefined, 2);
    const p2 = await app.queries.getLedger(w.id, p1.nextCursor, 2);
    const p3 = await app.queries.getLedger(w.id, p2.nextCursor, 2);
    expect(p1.entries.map((e) => e.balanceAfter.amount)).toEqual(['100.00', '99.00']);
    expect(p2.entries.map((e) => e.balanceAfter.amount)).toEqual(['98.00', '97.00']);
    expect(p3.entries.map((e) => e.balanceAfter.amount)).toEqual(['96.00']);
    expect(p3.nextCursor).toBeUndefined();
    expect(() => app.queries.getLedger(w.id, 'garbage', 2)).toThrow(DomainValidationError);
    expect(() => app.queries.getLedger(w.id, undefined, 0)).toThrow(DomainValidationError);
  });

  test('lookups by id and by provider external id; malformed ids are validation errors', async () => {
    const w = await wallet();
    const cmd = command(w);
    const r = await app.submit.execute(cmd);
    expect((await app.queries.getTransaction(r.transactionId)).externalTransactionId).toBe(cmd.externalTransactionId);
    expect((await app.queries.getTransactionByExternalId('provider-a', cmd.externalTransactionId)).id).toBe(r.transactionId);
    await expect(app.queries.getWallet('nope')).rejects.toBeInstanceOf(DomainValidationError);
  });
});

describe('reconciliation', () => {
  test('consistent wallet', async () => {
    const w = await wallet('500.00');
    await app.submit.execute(command(w, { money: { amount: '125.50', currency: 'BRL' } }));
    const report = await app.reconcile.execute(w.id, 'c');
    expect(report).toEqual({
      walletId: w.id,
      storedBalance: { amount: '374.50', currency: 'BRL' },
      calculatedBalance: { amount: '374.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      journalBalance: { amount: '374.50', currency: 'BRL' },
    });
  });

  test('a divergence (forced by bypassing the triggers as superuser) is reported, counted and NOT fixed', async () => {
    const w = await openWallet(app, '100.00'); // not added to `touched`: it is broken on purpose
    const em = orm.em.fork();
    await em.execute('alter table wallets disable trigger user');
    try {
      await em.execute('update wallets set balance = 150.00 where id = ?', [w.id]);
    } finally {
      await em.execute('alter table wallets enable trigger user');
    }
    const before = app.metrics.total('reconciliation_mismatches_total');
    const report = await app.reconcile.execute(w.id, 'c');
    expect(report).toMatchObject({ consistent: false, difference: { amount: '50.00' }, storedBalance: { amount: '150.00' } });
    expect(app.metrics.total('reconciliation_mismatches_total')).toBe(before + 1);
    expect((await app.queries.getWallet(w.id)).balance.amount).toBe('150.00');
  });
});
