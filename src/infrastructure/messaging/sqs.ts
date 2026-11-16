import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { linkFromTraceParent, SpanKind, withSpan } from '../observability/tracing';

export interface SqsSettings {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createSqsClient(s: SqsSettings): SQSClient {
  return new SQSClient({
    region: s.region,
    // Always talk to the configured endpoint, never to the host embedded in a QueueUrl
    // (LocalStack returns *.localhost.localstack.cloud, which needs public DNS).
    ...(s.endpoint ? { endpoint: s.endpoint, useQueueUrlAsEndpoint: false } : {}),
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    maxAttempts: 2, // the callers own retry policy; keep SDK retries short
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 25_000 }, // > long-poll wait
  });
}

/**
 * Lazily resolves (and caches) a queue URL by name. Lazy on purpose: the process must
 * boot while SQS is unavailable; a failed lookup is retried on the next call.
 */
export class QueueUrlResolver {
  private cached?: Promise<string>;

  constructor(
    private readonly client: SQSClient,
    readonly queueName: string,
  ) {}

  get(): Promise<string> {
    if (!this.cached) {
      this.cached = this.client
        .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
        .then((r) => {
          if (!r.QueueUrl) throw new Error(`queue ${this.queueName} has no URL`);
          return r.QueueUrl;
        })
        .catch((error: unknown) => {
          this.cached = undefined;
          throw error;
        });
    }
    return this.cached;
  }

  async ping(): Promise<void> {
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: await this.get(), AttributeNames: ['QueueArn'] }));
  }
}

export interface QueueNames {
  wager: string;
  wagerDlq: string;
  events: string;
}

/**
 * Idempotent queue provisioning (also done by the LocalStack init script). The redrive
 * policy is a SAFETY NET for poison messages that crash the process before it can
 * classify them; normal DLQ moves are explicit, at `maxAttempts`.
 */
export async function ensureQueues(client: SQSClient, names: QueueNames, maxAttempts: number): Promise<void> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = await client.send(
    new CreateQueueCommand({ QueueName: names.wagerDlq, Attributes: { ...fifo, MessageRetentionPeriod: '1209600' } }),
  );
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn;
  await client.send(
    new CreateQueueCommand({
      QueueName: names.wager,
      Attributes: {
        ...fifo,
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxAttempts + 1) }),
      },
    }),
  );
  await client.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }));
}

/**
 * Publishes outbox messages to a FIFO queue:
 *   MessageGroupId         = aggregateId  → per-aggregate ordering on the broker
 *   MessageDeduplicationId = eventId      → broker drops re-sends within its 5-min window
 * Never throws: a failed chunk is reported as failed so the outbox reschedules it.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queue: QueueUrlResolver,
  ) {}

  publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    // One PRODUCER span per batch, LINKED to each originating request's trace (a batch
    // mixes many traces, so links rather than a single parent).
    return withSpan(
      'outbox.publish',
      {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': 'aws_sqs', 'messaging.destination.name': this.queue.queueName, 'messaging.batch.message_count': messages.length },
        links: messages.flatMap((m) => linkFromTraceParent(m.traceParent)).slice(0, 128),
      },
      () => this.send(messages),
    );
  }

  private async send(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    let queueUrl: string;
    try {
      queueUrl = await this.queue.get();
    } catch (error) {
      result.failed.push(...messages.map((m) => ({ id: m.id, error: describe(error) })));
      return result;
    }

    // Lanes run in parallel; one aggregate always maps to the same lane and a lane is sent
    // sequentially, so per-aggregate order inside the batch is preserved. (The load test
    // showed strictly sequential 10-message calls could not keep up with ~700 events/s.)
    const lanes: OutboxMessage[][] = Array.from({ length: PUBLISH_LANES }, () => []);
    for (const m of messages) lanes[laneOf(m.aggregateId)]!.push(m);

    await Promise.all(
      lanes.map(async (lane) => {
        for (let i = 0; i < lane.length; i += 10) {
          const chunk = lane.slice(i, i + 10);
          try {
            const response = await this.client.send(
              new SendMessageBatchCommand({
                QueueUrl: queueUrl,
                Entries: chunk.map((m) => ({
                  Id: m.id,
                  MessageBody: JSON.stringify(m.payload),
                  MessageGroupId: m.aggregateId,
                  MessageDeduplicationId: m.id,
                  MessageAttributes: {
                    eventType: { DataType: 'String', StringValue: m.eventType },
                    // downstream consumers continue the trace of the request that caused the event
                    ...(m.traceParent ? { traceparent: { DataType: 'String', StringValue: m.traceParent } } : {}),
                  },
                })),
              }),
            );
            for (const ok of response.Successful ?? []) if (ok.Id) result.published.push(ok.Id);
            for (const ko of response.Failed ?? []) {
              if (ko.Id) result.failed.push({ id: ko.Id, error: `${ko.Code}: ${ko.Message ?? ''}` });
            }
          } catch (error) {
            result.failed.push(...chunk.map((m) => ({ id: m.id, error: describe(error) })));
          }
        }
      }),
    );
    return result;
  }
}

const PUBLISH_LANES = 8;

function laneOf(aggregateId: string): number {
  let h = 0;
  for (let i = 0; i < aggregateId.length; i++) h = (h * 31 + aggregateId.charCodeAt(i)) | 0;
  return Math.abs(h) % PUBLISH_LANES;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
