/**
 * OpenTelemetry: real spans captured in memory while the real HTTP app, PostgreSQL and
 * LocalStack run. Proves that a single trace follows a transaction across the async hop
 * (request → outbox row → publisher → SQS message attribute) and that an inbound message
 * carrying `traceparent` is processed inside the producer's trace.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Container } from '../../src/bootstrap/container';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { initTracing, type TracingHandle, withSpan } from '../../src/infrastructure/observability/tracing';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { drain, provisionQueues, startContainer, testEnv, waitFor, wagerData } from '../support/messaging';
import { createTestOrm, resetSchema } from './support/db';

// Waits on a real SQS round trip (publish → consume); keep slower machines clear of bun's 5s default.
setDefaultTimeout(60_000);

const env = testEnv();
const exporter = new InMemorySpanExporter();
let tracing: TracingHandle;
let container: Container;
let app: INestApplication;
let base: string;

beforeAll(async () => {
  tracing = initTracing({ serviceName: 'test', instanceId: 'test-1', processor: new SimpleSpanProcessor(exporter) })!;
  const orm = await createTestOrm();
  await resetSchema(orm);
  await orm.close(true);
  await provisionQueues(env);
  container = await startContainer(env);
  app = await createHttpApp(container);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});

afterAll(async () => {
  await container.workers.consumer.stop();
  await app.close();
  await container.close();
  await tracing.shutdown();
});

const spansOf = (traceId: string) => exporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
const parentId = (s: ReadableSpan) => s.parentSpanContext?.spanId;

async function wallet() {
  const res = await fetch(`${base}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
  });
  return (await res.json()) as { id: string; playerId: string };
}

describe('distributed tracing', () => {
  test('HTTP continues the caller trace; unit of work and wallet-lock wait are child spans', async () => {
    const w = await wallet();
    const callerTrace = 'a'.repeat(31) + '1';
    const callerSpan = 'b'.repeat(15) + '2';
    const { idempotencyKey, ...body } = wagerData(w);
    const res = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, traceparent: `00-${callerTrace}-${callerSpan}-01` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-trace-id')).toBe(callerTrace);

    await Bun.sleep(50);
    const spans = spansOf(callerTrace);
    const server = spans.find((s) => s.name === 'POST /wagering/transactions')!;
    expect(server).toBeDefined();
    expect(parentId(server)).toBe(callerSpan);
    expect(server.attributes['http.response.status_code']).toBe(200);

    const tx = spans.filter((s) => s.name === 'db.transaction');
    expect(tx.length).toBeGreaterThanOrEqual(1);
    expect(tx.every((s) => parentId(s) === server.spanContext().spanId)).toBe(true);
    const lock = spans.find((s) => s.name === 'db.lock wallet')!;
    expect(lock.attributes['wallet.id']).toBe(w.id);
    expect(tx.map((s) => s.spanContext().spanId)).toContain(parentId(lock)!);
  });

  test('the trace crosses the outbox: stored on the row, linked by the publisher, forwarded to SQS', async () => {
    await drain(container.sqs, await container.queues.events.get(), 1);
    const w = await wallet();
    const { idempotencyKey, ...body } = wagerData(w);
    const res = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    const traceId = res.headers.get('x-trace-id')!;
    const { transactionId } = (await res.json()) as { transactionId: string };

    const rows = await container.orm.em
      .fork()
      .execute<{ trace_parent: string }[]>('select trace_parent from outbox_messages where aggregate_id = ?', [transactionId]);
    expect(rows[0]?.trace_parent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));

    await container.publishOutbox.runOnce();
    const publish = exporter.getFinishedSpans().filter((s) => s.name === 'outbox.publish').at(-1)!;
    expect(publish.links.map((l) => l.context.traceId)).toContain(traceId);

    const messages = await drain(container.sqs, await container.queues.events.get());
    const ours = messages.find((m) => JSON.parse(m.Body ?? '{}').aggregateId === transactionId)!;
    expect(ours.MessageAttributes?.traceparent?.StringValue).toContain(traceId);
  });

  test('an inbound SQS message with traceparent is processed inside the producer trace', async () => {
    container.workers.consumer.start();
    const w = await wallet();
    const producerTrace = 'c'.repeat(31) + '3';
    const producerSpan = 'd'.repeat(15) + '4';
    const data = wagerData(w);
    const messageId = `msg-${randomUUID()}`;
    await container.sqs.send(
      new SendMessageCommand({
        QueueUrl: await container.queues.wager.get(),
        MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
        MessageGroupId: w.id,
        MessageDeduplicationId: messageId,
        MessageAttributes: { traceparent: { DataType: 'String', StringValue: `00-${producerTrace}-${producerSpan}-01` } },
      }),
    );
    const consume = await waitFor(
      async () => spansOf(producerTrace).find((s) => s.name.startsWith('sqs.process')),
      { what: 'consumer span' },
    );
    expect(parentId(consume)).toBe(producerSpan);
    expect(consume.attributes['messaging.outcome']).toBe('acked');
    expect(spansOf(producerTrace).some((s) => s.name === 'db.transaction' && parentId(s) === consume.spanContext().spanId)).toBe(true);
  });

  test('log lines written inside a span carry traceId / spanId', async () => {
    const lines: string[] = [];
    const logger = new JsonLogger('info', {}, (l) => lines.push(l));
    await withSpan('test.span', {}, async (span) => {
      logger.info('inside');
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.traceId).toBe(span.spanContext().traceId);
      expect(parsed.spanId).toBe(span.spanContext().spanId);
    });
    logger.info('outside');
    expect(JSON.parse(lines[1]!).traceId).toBeUndefined();
  });
});
