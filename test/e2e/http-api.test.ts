import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { loadConfig } from '../../src/bootstrap/config';
import { type Container, createContainer } from '../../src/bootstrap/container';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { createTestOrm, resetSchema, TEST_DATABASE_URL } from '../integration/support/db';

let container: Container;
let app: INestApplication;
let base: string;

async function startApp(databaseUrl: string): Promise<{ container: Container; app: INestApplication; base: string }> {
  const c = await createContainer(loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' }));
  const a = await createHttpApp(c);
  await a.listen(0);
  const address = a.getHttpServer().address() as { port: number };
  return { container: c, app: a, base: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  const orm = await createTestOrm();
  await resetSchema(orm);
  await orm.close(true);
  ({ container, app, base } = await startApp(TEST_DATABASE_URL));
});

afterAll(async () => {
  await app.close();
  await container.close();
});

interface Res {
  status: number;
  body: any;
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function createWallet(amount = '1000.00') {
  const res = await call('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function txBody(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (body: ReturnType<typeof txBody>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'idempotency-key': key });

describe('health', () => {
  test('live and ready are public and report dependencies', async () => {
    expect(await call('GET', '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', checks: { postgres: { status: 'up' }, sqs: { status: 'up' } } });
  });
});

describe('POST /wallets', () => {
  test('201 with the documented contract', async () => {
    const playerId = randomUUID();
    const res = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const dup = await call('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false, details: { existingWalletId: res.body.id } });
  });

  test.each([
    ['amount as JSON number', { playerId: randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['scientific notation', { playerId: randomUUID(), initialBalance: { amount: '1e3', currency: 'BRL' } }],
    ['unknown field', { playerId: randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' }, admin: true }],
    ['malformed player id', { playerId: 'p-1', initialBalance: { amount: '1.00', currency: 'BRL' } }],
  ])('400 on %s', async (_, body) => {
    const res = await call('POST', '/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.retryable).toBe(false);
  });

  test('400 MALFORMED_REQUEST on invalid JSON', async () => {
    const res = await call('POST', '/wallets', '{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });
});

describe('POST /wagering/transactions — status contract', () => {
  test('200 PROCESSED; identical retry → same status and body with idempotentReplay=true', async () => {
    const w = await createWallet();
    const body = txBody(w);
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await submit(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  test('400 when Idempotency-Key is missing', async () => {
    const w = await createWallet();
    const res = await call('POST', '/wagering/transactions', txBody(w));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  test('409 IDEMPOTENCY_KEY_REUSED when the payload differs', async () => {
    const w = await createWallet();
    const body = txBody(w);
    await submit(body);
    const res = await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false, details: { existingTransactionId: expect.any(String) } });
  });

  test('422 REJECTED by business rule, with failureCode and guidance; replay keeps 422', async () => {
    const w = await createWallet('10.00');
    const body = txBody(w, { money: { amount: '50.00', currency: 'BRL' } });
    const res = await submit(body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', retryGuidance: 'GIVE_UP' });
    expect((await submit(body)).status).toBe(422);
  });

  test('202 PENDING_REFERENCE for a reversal that arrived before its reference', async () => {
    const w = await createWallet();
    const res = await submit(txBody(w, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
  });

  test('404 WALLET_NOT_FOUND', async () => {
    const res = await submit(txBody({ id: randomUUID(), playerId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test.each([
    ['OPENING kind', { kind: 'OPENING' }],
    ['money as number', { money: { amount: 25, currency: 'BRL' } }],
    ['typo in field name', { referenceExternalTransactionID: 'x' }],
    ['negative amount', { money: { amount: '-1.00', currency: 'BRL' } }],
  ])('400 on %s', async (_, overrides) => {
    const w = await createWallet();
    const res = await submit(txBody(w, overrides));
    expect(res.status).toBe(400);
  });
});

describe('queries', () => {
  test('transaction by id and by provider external id', async () => {
    const w = await createWallet();
    const body = txBody(w);
    const { body: result } = await submit(body);
    const byId = await call('GET', `/wagering/transactions/${result.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: result.transactionId, status: 'PROCESSED', money: { amount: '25.00', currency: 'BRL' } });
    const byExt = await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.body.id).toBe(result.transactionId);
    expect((await call('GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/wagering/transactions/not-a-uuid')).status).toBe(400);
  });

  test('wallet + ledger pagination with opaque cursor', async () => {
    const w = await createWallet('100.00');
    for (let i = 0; i < 3; i++) await submit(txBody(w, { money: { amount: '1.00', currency: 'BRL' } }));
    expect((await call('GET', `/wallets/${w.id}`)).body).toMatchObject({ balance: { amount: '97.00' }, version: 4 });

    const p1 = await call('GET', `/wallets/${w.id}/ledger?limit=3`);
    expect(p1.body.entries).toHaveLength(3);
    const p2 = await call('GET', `/wallets/${w.id}/ledger?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.entries.map((e: { balanceAfter: { amount: string } }) => e.balanceAfter.amount)).toEqual(['97.00']);
    expect(p2.body.nextCursor).toBeUndefined();
    expect((await call('GET', `/wallets/${w.id}/ledger?limit=abc`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.id}/ledger?cursor=zzz`)).status).toBe(400);
  });

  test('reconciliation', async () => {
    const w = await createWallet('975.00');
    const res = await call('POST', `/wallets/${w.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });
});

describe('cross-cutting', () => {
  test('correlation id is accepted and echoed (and generated when absent)', async () => {
    const res = await call('GET', '/health/live', undefined, { 'x-correlation-id': 'corr-abc-123' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc-123');
    expect((await call('GET', '/health/live')).headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('unknown route → 404 ROUTE_NOT_FOUND with the standard error envelope', async () => {
    const res = await call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), retryable: false }, correlationId: expect.any(String) });
  });

  test('PostgreSQL unreachable → process stays up, ready=503, requests=503 + Retry-After', async () => {
    const down = await startApp('postgres://postgres:postgres@127.0.0.1:5999/nowhere');
    try {
      expect((await fetch(`${down.base}/health/live`)).status).toBe(200);
      const ready = await fetch(`${down.base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as any).checks.postgres.status).toBe('down');

      const res = await fetch(`${down.base}/wallets/${randomUUID()}`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(((await res.json()) as any).error).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
    } finally {
      await down.app.close();
      await down.container.close();
    }
  });
});
