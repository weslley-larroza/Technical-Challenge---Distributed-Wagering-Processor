import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/bootstrap/config';
import { type ContainerOverrides, createContainer } from '../../src/bootstrap/container';
import { createSqsClient, ensureQueues } from '../../src/infrastructure/messaging/sqs';
import { TEST_DATABASE_URL } from '../integration/support/db';

/** Unique queue set per test file → files never see each other's messages. */
export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const suffix = randomUUID().slice(0, 8);
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
    SQS_WAGER_QUEUE: `wager-${suffix}.fifo`,
    SQS_WAGER_DLQ: `wager-dlq-${suffix}.fifo`,
    SQS_EVENTS_QUEUE: `events-${suffix}.fifo`,
    SQS_MAX_ATTEMPTS: '3',
    SQS_WAIT_TIME_SEC: '1',
    SQS_VISIBILITY_TIMEOUT_SEC: '2',
    SQS_RETRY_BASE_SEC: '1',
    SHUTDOWN_GRACE_MS: '8000',
    OUTBOX_IDLE_DELAY_MS: '50',
    ...extra,
  };
}

export async function provisionQueues(env: Record<string, string>): Promise<void> {
  const config = loadConfig(env);
  const client = createSqsClient(config.sqs);
  await ensureQueues(
    client,
    { wager: config.sqs.wagerQueue, wagerDlq: config.sqs.wagerDlq, events: config.sqs.eventsQueue },
    config.sqs.maxAttempts,
  );
  client.destroy();
}

export function startContainer(env: Record<string, string>, overrides: ContainerOverrides = {}) {
  return createContainer(loadConfig(env), overrides);
}

export interface WagerData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerData(wallet: { id: string; playerId: string }, overrides: Partial<WagerData> = {}): WagerData {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Producer side: one WagerTransactionRequested message (section 10 envelope). */
export async function sendWager(
  client: SQSClient,
  queueUrl: string,
  data: WagerData | Record<string, unknown>,
  opts: { messageId?: string; dedupId?: string; rawBody?: string; groupId?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${randomUUID()}`;
  const body =
    opts.rawBody ??
    JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: opts.groupId ?? String((data as { walletId?: string }).walletId ?? 'g'),
      MessageDeduplicationId: opts.dedupId ?? messageId,
    }),
  );
  return messageId;
}

/** Receives (and deletes) everything currently available on a queue. */
export async function drain(client: SQSClient, queueUrl: string, idleRounds = 2): Promise<Message[]> {
  const all: Message[] = [];
  let idle = 0;
  while (idle < idleRounds) {
    const r = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = r.Messages ?? [];
    if (messages.length === 0) {
      idle += 1;
      continue;
    }
    idle = 0;
    all.push(...messages);
    await Promise.all(
      messages.map((m) => client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }))),
    );
  }
  return all;
}

export async function queueDepth(client: SQSClient, queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const r = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
