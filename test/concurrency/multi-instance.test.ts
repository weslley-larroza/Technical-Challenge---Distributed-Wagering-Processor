/**
 * Section 13 — "≥ 3 processos/instâncias simultâneos", crash and restart, with REAL OS
 * processes (src/main.ts) sharing one PostgreSQL and one set of SQS queues. Each process
 * runs every role (HTTP, consumer, outbox publisher, pending-reference worker).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/bootstrap/config';
import { createSqsClient, QueueUrlResolver } from '../../src/infrastructure/messaging/sqs';
import { createTestOrm, resetSchema } from '../integration/support/db';
import { countLogLines, expectGlobalInvariant, type Instance, killHard, spawnInstance } from '../support/cluster';
import { drain, provisionQueues, queueDepth, sendWager, testEnv, waitFor, wagerData } from '../support/messaging';

setDefaultTimeout(120_000);

const env = testEnv({ LOG_LEVEL: 'info', SQS_VISIBILITY_TIMEOUT_SEC: '3', DB_POOL_MAX: '10' });
let orm: MikroORM;
let sqs: SQSClient;
let wagerUrl: string;
let eventsUrl: string;
let cluster: Instance[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  await resetSchema(orm);
  await provisionQueues(env);
  const config = loadConfig(env);
  sqs = createSqsClient(config.sqs);
  wagerUrl = await new QueueUrlResolver(sqs, config.sqs.wagerQueue).get();
  eventsUrl = await new QueueUrlResolver(sqs, config.sqs.eventsQueue).get();
  cluster = await Promise.all(['node-1', 'node-2', 'node-3'].map((id) => spawnInstance(id, env)));
});

afterAll(async () => {
  await Promise.all(cluster.map((i) => killHard(i).catch(() => undefined)));
  sqs.destroy();
  await orm.close(true);
});

const live = () => cluster.filter((i) => i.process.exitCode === null && !i.process.killed);
const pick = (n: number) => live()[n % live().length]!;

async function http(instance: Instance, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${instance.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function openWallet(amount: string) {
  const r = await http(pick(0), 'POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return r.body as { id: string; playerId: string };
}

function bet(w: { id: string; playerId: string }, amount: string, externalTransactionId = `tx-${randomUUID()}`) {
  const { idempotencyKey, ...body } = wagerData(w, { externalTransactionId, money: { amount, currency: 'BRL' } });
  return { body, key: idempotencyKey };
}

const submitVia = (instance: Instance, b: ReturnType<typeof bet>) =>
  http(instance, 'POST', '/wagering/transactions', b.body, { 'idempotency-key': b.key });

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await orm.em.fork().execute<{ n: number }[]>(sql, params);
  return rows[0]?.n ?? 0;
}

const outboxPending = () => count('select count(*)::int as n from outbox_messages where published_at is null');

describe('3 instances over HTTP', () => {
  test('section 8 across instances: 100.00, two 80.00 bets on two different instances (x5)', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await openWallet('100.00');
      const results = await Promise.all([submitVia(pick(0), bet(w, '80.00')), submitVia(pick(1), bet(w, '80.00'))]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(results.find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect((await http(pick(2), 'GET', `/wallets/${w.id}`)).body.balance.amount).toBe('20.00');
    }
  });

  test('the same bet 50x spread over 3 instances → one debit', async () => {
    const w = await openWallet('1000.00');
    const b = bet(w, '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submitVia(pick(i), b)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toBe(1);
  });

  test('hot wallet: 150 bets of 1.00 on 100.00 round-robin over 3 instances → exactly 100 debits', async () => {
    const w = await openWallet('100.00');
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => submitVia(pick(i), bet(w, '1.00'))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(100);
    expect(results.filter((r) => r.status === 422)).toHaveLength(50);
    expect((await http(pick(0), 'GET', `/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '0.00' }, version: 101 });
    await expectGlobalInvariant(orm);
  });
});

describe('3 competing consumers + 3 outbox publishers', () => {
  test('20 wallets × 6 queued bets: each applied exactly once, all events published once', async () => {
    await drain(sqs, eventsUrl, 1);
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    const sent = wallets.flatMap((w) => Array.from({ length: 6 }, () => wagerData(w, { money: { amount: '10.00', currency: 'BRL' } })));
    await Promise.all(sent.map((d) => sendWager(sqs, wagerUrl, d)));

    await waitFor(async () => (await count(
      `select count(*)::int as n from wager_transactions where external_transaction_id in (?)`,
      [sent.map((d) => d.externalTransactionId)],
    )) === sent.length, { timeoutMs: 60_000, what: 'all queued bets applied' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, what: 'outbox drained' });

    for (const w of wallets) {
      expect((await http(pick(0), 'GET', `/wallets/${w.id}`)).body.balance.amount).toBe('40.00');
    }
    const perInstance = await Promise.all(cluster.map((i) => countLogLines(i, 'message processed')));
    expect(perInstance.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2); // work really was shared

    const events = await drain(sqs, eventsUrl);
    const ids = events.map((m) => JSON.parse(m.Body ?? '{}').eventId as string);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate publication
    await expectGlobalInvariant(orm);
  });
});

describe('crash and restart', () => {
  test('SIGKILL one instance mid-stream → survivors finish its work, nothing applied twice', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet('1000.00')));
    const sent = wallets.flatMap((w) => Array.from({ length: 10 }, () => wagerData(w, { money: { amount: '5.00', currency: 'BRL' } })));
    await Promise.all(sent.map((d) => sendWager(sqs, wagerUrl, d)));
    const ids = sent.map((d) => d.externalTransactionId);
    const applied = () => count('select count(*)::int as n from wager_transactions where external_transaction_id in (?)', [ids]);

    await waitFor(async () => (await applied()) >= 15, { what: 'processing started' });
    const victim = cluster[1]!;
    await killHard(victim); // no graceful shutdown, in-flight messages un-acked
    const appliedAtKill = await applied();
    // the kill really happened mid-stream, and the victim had been doing real work
    expect(appliedAtKill).toBeLessThan(sent.length);
    expect(await countLogLines(victim, 'message processed')).toBeGreaterThan(0);

    await waitFor(async () => (await applied()) === sent.length, { timeoutMs: 60_000, what: 'survivors finished' });
    await waitFor(async () => {
      const d = await queueDepth(sqs, wagerUrl);
      return d.visible === 0 && d.inFlight === 0;
    }, { timeoutMs: 30_000, what: 'queue empty' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, what: 'outbox drained' });

    for (const w of wallets) {
      expect((await http(pick(0), 'GET', `/wallets/${w.id}`)).body.balance.amount).toBe('950.00'); // exactly 10 × 5.00
    }
    await expectGlobalInvariant(orm);
  });

  test('whole cluster killed, work queued while down, cluster restarted → converges consistently', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet('100.00')));
    await Promise.all(live().map(killHard)); // total outage
    // Work arrives while no instance is alive: bets + out-of-order rollbacks.
    const sent = wallets.flatMap((w) => {
      const b = wagerData(w, { money: { amount: '30.00', currency: 'BRL' } });
      const rb = wagerData(w, { kind: 'ROLLBACK', money: { amount: '30.00', currency: 'BRL' }, referenceExternalTransactionId: b.externalTransactionId });
      return [rb, b, wagerData(w, { money: { amount: '15.00', currency: 'BRL' } })]; // rollback BEFORE its bet
    });
    for (const d of sent) await sendWager(sqs, wagerUrl, d);

    cluster = await Promise.all(['node-4', 'node-5', 'node-6'].map((id) => spawnInstance(id, env)));
    const ids = sent.map((d) => d.externalTransactionId);
    await waitFor(async () => (await count(
      `select count(*)::int as n from wager_transactions where external_transaction_id in (?) and status = 'PROCESSED'`,
      [ids],
    )) === sent.length, { timeoutMs: 60_000, what: 'all processed after restart' });
    await waitFor(async () => (await outboxPending()) === 0, { timeoutMs: 30_000, what: 'outbox drained after restart' });

    for (const w of wallets) {
      // 100 − 30 (bet) + 30 (rollback) − 15
      expect((await http(pick(0), 'GET', `/wallets/${w.id}`)).body.balance.amount).toBe('85.00');
      expect((await http(pick(1), 'POST', `/wallets/${w.id}/reconciliation`)).body.consistent).toBe(true);
    }
    await expectGlobalInvariant(orm);
  });
});
