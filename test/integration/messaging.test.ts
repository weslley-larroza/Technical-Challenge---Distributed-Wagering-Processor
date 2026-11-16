import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EventPublisher } from '../../src/application/ports/messaging';
import type { Container } from '../../src/bootstrap/container';
import { RecordingMetrics } from '../support/app';
import {
  drain,
  provisionQueues,
  queueDepth,
  sendWager,
  startContainer,
  testEnv,
  waitFor,
  wagerData,
} from '../support/messaging';
import { createTestOrm, resetSchema } from './support/db';

// These tests wait on real SQS visibility timeouts and retry backoffs (1s + 2s before the DLQ),
// which sit right at bun's 5s default; a slower machine must not turn them into timeouts.
setDefaultTimeout(60_000);

const env = testEnv();
let main: Container;
let metrics: RecordingMetrics;
let urls: { wager: string; dlq: string; events: string };

beforeAll(async () => {
  const orm = await createTestOrm();
  await resetSchema(orm);
  await orm.close(true);
  await provisionQueues(env);
  metrics = new RecordingMetrics();
  main = await startContainer(env, { metrics });
  urls = {
    wager: await main.queues.wager.get(),
    dlq: await main.queues.wagerDlq.get(),
    events: await main.queues.events.get(),
  };
});

afterAll(async () => {
  await main.workers.consumer.stop();
  await main.workers.outboxLoop.stop();
  await main.close();
});

const openWallet = (amount = '1000.00') =>
  main.createWallet.execute({ playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' }, correlationId: 'test' });

const txByExternal = (externalId: string) =>
  main.queries.getTransactionByExternalId('provider-a', externalId).catch(() => undefined);

async function debitCount(walletId: string): Promise<number> {
  const rows = await main.orm.em
    .fork()
    .execute<{ n: number }[]>(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
  return rows[0]?.n ?? 0;
}

async function expectQueueEmpty(url: string): Promise<void> {
  await waitFor(async () => {
    const d = await queueDepth(main.sqs, url);
    return d.visible === 0 && d.inFlight === 0;
  }, { what: 'queue to be empty' });
}

describe('SQS consumer', () => {
  test('processes a message through the shared use case, acks after commit, records the inbox', async () => {
    main.workers.consumer.start();
    const w = await openWallet();
    const data = wagerData(w);
    const messageId = await sendWager(main.sqs, urls.wager, data);

    const tx = await waitFor(() => txByExternal(data.externalTransactionId), { what: 'transaction' });
    expect(tx).toMatchObject({ status: 'PROCESSED', balanceAfter: { amount: '975.00' } });
    await expectQueueEmpty(urls.wager);
    const inbox = await main.orm.em
      .fork()
      .execute<{ n: number }[]>('select count(*)::int as n from inbox_messages where message_id = ?', [messageId]);
    expect(inbox[0]?.n).toBe(1);
  });

  test('redelivery of the same envelope messageId (broker dedup bypassed) → applied once', async () => {
    const w = await openWallet();
    const data = wagerData(w);
    const messageId = `msg-${randomUUID()}`;
    const before = metrics.total('inbox_duplicates_total');
    await sendWager(main.sqs, urls.wager, data, { messageId, dedupId: `${messageId}-a` });
    await sendWager(main.sqs, urls.wager, data, { messageId, dedupId: `${messageId}-b` });

    await waitFor(async () => metrics.total('inbox_duplicates_total') > before, { what: 'duplicate detection' });
    await expectQueueEmpty(urls.wager);
    expect(await debitCount(w.id)).toBe(1);
    expect((await main.queries.getWallet(w.id)).balance.amount).toBe('975.00');
  });

  test('malformed message → DLQ immediately with the reason; never retried', async () => {
    await sendWager(main.sqs, urls.wager, {}, { rawBody: '{"not":"an envelope"', groupId: 'poison' });
    const [dead] = await waitFor(async () => {
      const m = await drain(main.sqs, urls.dlq, 1);
      return m.length ? m : undefined;
    }, { what: 'DLQ message' });
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
    expect(Number(dead?.MessageAttributes?.receiveCount?.StringValue)).toBe(1);
    await expectQueueEmpty(urls.wager);
  });

  test('business error (unknown wallet) → acked, not retried, not in DLQ', async () => {
    const before = metrics.total('sqs_retries_total');
    const data = wagerData({ id: randomUUID(), playerId: randomUUID() });
    await sendWager(main.sqs, urls.wager, data);
    await waitFor(async () => metrics.total('sqs_messages_total') > 0 && (await queueDepth(main.sqs, urls.wager)).inFlight === 0);
    await expectQueueEmpty(urls.wager);
    expect(metrics.total('sqs_retries_total')).toBe(before);
    expect(await drain(main.sqs, urls.dlq, 1)).toHaveLength(0);
  });

  test('BET and ROLLBACK of the same wallet in one FIFO group are applied in order', async () => {
    const w = await openWallet('100.00');
    const bet = wagerData(w, { money: { amount: '60.00', currency: 'BRL' } });
    const rollback = wagerData(w, { kind: 'ROLLBACK', money: { amount: '60.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId });
    const bet2 = wagerData(w, { money: { amount: '90.00', currency: 'BRL' } });
    for (const d of [bet, rollback, bet2]) await sendWager(main.sqs, urls.wager, d);
    const last = await waitFor(() => txByExternal(bet2.externalTransactionId), { what: 'last transaction' });
    // in order: 100 −60 = 40, +60 = 100, −90 = 10  (out of order bet2 would have been rejected)
    expect(last).toMatchObject({ status: 'PROCESSED', balanceAfter: { amount: '10.00' } });
  });
});

describe('failures and recovery', () => {
  test('transient failure (PostgreSQL unreachable) → retried with backoff, then DLQ RETRIES_EXHAUSTED', async () => {
    const brokenEnv = { ...env, LOG_LEVEL: process.env.DEBUG_TEST ? 'warn' : 'silent', DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5999/nowhere' };
    const brokenMetrics = new RecordingMetrics();
    await main.workers.consumer.stop();
    const broken = await startContainer(brokenEnv, { metrics: brokenMetrics });
    try {
      broken.workers.consumer.start();
      const data = wagerData({ id: randomUUID(), playerId: randomUUID() });
      await sendWager(main.sqs, urls.wager, data);
      const [dead] = await waitFor(async () => {
        const m = await drain(main.sqs, urls.dlq, 1);
        return m.length ? m : undefined;
      }, { timeoutMs: 30_000, what: 'DLQ after retries' });
      expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
      expect(Number(dead?.MessageAttributes?.receiveCount?.StringValue)).toBe(3); // SQS_MAX_ATTEMPTS
      expect(brokenMetrics.total('sqs_retries_total')).toBe(2);
    } finally {
      await broken.workers.consumer.stop();
      await broken.close();
      main.workers.consumer.start();
    }
  });

  test('worker dies AFTER commit and BEFORE ack → redelivered to another instance → no double debit', async () => {
    await main.workers.consumer.stop();
    let crashed = false;
    const crashing = await startContainer(env, {
      consumerHooks: {
        beforeAck: async () => {
          crashed = true;
          return false; // commit happened; ack never sent; message stays in flight
        },
      },
    });
    const w = await openWallet();
    const data = wagerData(w);
    try {
      crashing.workers.consumer.start();
      await sendWager(main.sqs, urls.wager, data);
      await waitFor(async () => crashed && (await txByExternal(data.externalTransactionId)), { what: 'commit before crash' });
    } finally {
      await crashing.workers.consumer.stop();
      await crashing.close();
    }
    expect((await queueDepth(main.sqs, urls.wager)).inFlight).toBe(1); // un-acked

    const before = metrics.total('inbox_duplicates_total');
    main.workers.consumer.start(); // the "other instance" takes over after the visibility timeout
    await waitFor(async () => metrics.total('inbox_duplicates_total') > before, { what: 'redelivery deduplicated' });
    await expectQueueEmpty(urls.wager);
    expect(await debitCount(w.id)).toBe(1);
    expect((await main.queries.getWallet(w.id)).balance.amount).toBe('975.00');
  });

  test('SIGTERM-style stop drains: in-flight messages are acked, nothing is left invisible', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet()));
    const sent = wallets.flatMap((w) => [wagerData(w), wagerData(w)]);
    for (const d of sent) await sendWager(main.sqs, urls.wager, d);

    await new Promise((r) => setTimeout(r, 150)); // let it start mid-way
    await main.workers.consumer.stop();
    const afterStop = await queueDepth(main.sqs, urls.wager);
    expect(afterStop.inFlight).toBe(0); // in-flight finished+acked, the rest released

    main.workers.consumer.start();
    for (const d of sent) await waitFor(() => txByExternal(d.externalTransactionId), { what: d.externalTransactionId });
    await expectQueueEmpty(urls.wager);
    for (const w of wallets) expect(await debitCount(w.id)).toBe(2);
  });
});

describe('transactional outbox', () => {
  test('events are published after commit with the versioned envelope, FIFO group = aggregate', async () => {
    await drain(main.sqs, urls.events, 1);
    const w = await openWallet('100.00');
    const result = await main.submitWagerTransaction.execute({ ...wagerData(w), correlationId: 'corr-outbox' });

    main.workers.outboxLoop.start();
    const events = await waitFor(async () => {
      const pending = await main.orm.em.fork().execute<{ n: number }[]>('select count(*)::int as n from outbox_messages where published_at is null');
      return pending[0]?.n === 0 ? drain(main.sqs, urls.events) : undefined;
    }, { what: 'outbox drained' });
    await main.workers.outboxLoop.stop();

    const ours = events.map((m) => JSON.parse(m.Body ?? '{}')).filter((e) => e.aggregateId === w.id || e.aggregateId === result.transactionId);
    expect(ours.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
    const processed = ours.find((e) => e.eventType === 'WagerTransactionProcessed');
    expect(processed).toMatchObject({
      version: 1,
      correlationId: 'corr-outbox',
      aggregateId: result.transactionId,
      data: { money: { amount: '25.00', currency: 'BRL' }, balanceAfter: { amount: '75.00', currency: 'BRL' } },
    });
  });

  test('two concurrent publishers on the same outbox: every event published, none by both', async () => {
    const w = await openWallet('10000.00');
    await Promise.all(Array.from({ length: 30 }, () => main.submitWagerTransaction.execute({ ...wagerData(w), correlationId: 'c' })));
    const [{ n: pendingBefore } = { n: 0 }] = await main.orm.em
      .fork()
      .execute<{ n: number }[]>('select count(*)::int as n from outbox_messages where published_at is null');
    expect(pendingBefore).toBeGreaterThanOrEqual(60);

    const other = await startContainer(env);
    let publishedByA = 0;
    let publishedByB = 0;
    try {
      const pump = async (c: Container, add: (n: number) => void) => {
        for (;;) {
          const r = await c.publishOutbox.runOnce(5); // small batches → maximal interleaving
          add(r.published);
          if (r.claimed === 0) return;
        }
      };
      await Promise.all([pump(main, (n) => (publishedByA += n)), pump(other, (n) => (publishedByB += n))]);
    } finally {
      await other.close();
    }
    expect(publishedByA).toBeGreaterThan(0);
    expect(publishedByB).toBeGreaterThan(0);
    expect(publishedByA + publishedByB).toBe(pendingBefore); // no row published twice

    const received = await drain(main.sqs, urls.events);
    const ids = received.map((m) => JSON.parse(m.Body ?? '{}').eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(pendingBefore);
  });

  test('broker failure → event kept with backoff (never dropped), published on a later attempt', async () => {
    let failNext = true;
    const flaky = await startContainer(env, {
      eventPublisher: (real: EventPublisher): EventPublisher => ({
        publish: async (messages) => {
          if (failNext) {
            failNext = false;
            return { published: [], failed: messages.map((m) => ({ id: m.id, error: 'simulated broker outage' })) };
          }
          return real.publish(messages);
        },
      }),
    });
    try {
      const w = await openWallet('50.00');
      const first = await flaky.publishOutbox.runOnce();
      expect(first.failed).toBeGreaterThan(0);
      const [row] = await flaky.orm.em
        .fork()
        .execute<{ attempts: number; published_at: Date | null; last_error: string }[]>(
          'select attempts, published_at, last_error from outbox_messages where aggregate_id = ?', [w.id]);
      expect(row).toMatchObject({ attempts: 1, published_at: null, last_error: 'simulated broker outage' });

      expect((await flaky.publishOutbox.runOnce()).claimed).toBe(0); // backoff: not due yet
      await new Promise((r) => setTimeout(r, 1_100));
      await waitFor(async () => (await flaky.publishOutbox.runOnce()).published > 0 || undefined, { what: 'retry publish' });
    } finally {
      await flaky.close();
    }
  });
});

describe('readiness', () => {
  test('checks PostgreSQL and SQS', async () => {
    for (const indicator of main.healthIndicators) await indicator.check();
    const noSqs = await startContainer({ ...env, SQS_ENDPOINT: 'http://127.0.0.1:4999' });
    try {
      const sqs = noSqs.healthIndicators.find((h) => h.name === 'sqs')!;
      await expect(sqs.check()).rejects.toThrow();
    } finally {
      await noSqs.close();
    }
  });
});
