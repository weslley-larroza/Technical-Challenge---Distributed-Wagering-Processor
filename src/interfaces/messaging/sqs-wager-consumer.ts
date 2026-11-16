import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import { TransientPersistenceError } from '../../application/ports/persistence';
import type { Logger, Metrics } from '../../application/ports/system';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { DomainError } from '../../domain/shared/errors';
import type { QueueUrlResolver } from '../../infrastructure/messaging/sqs';
import { contextFromTraceParent, SpanKind, withSpan } from '../../infrastructure/observability/tracing';
import { messagePayloadHash, parseWagerMessage } from './wager-message';

export type ErrorClass = 'business' | 'transient' | 'permanent' | 'unexpected';

/**
 *  business   → terminal outcome decided by the rules (not found, idempotency conflict): ACK
 *  transient  → infrastructure hiccup: retry with backoff (visibility), DLQ after maxAttempts
 *  permanent  → can never succeed (malformed message): DLQ immediately
 *  unexpected → bug / unknown: retried like transient (it may be environmental), then DLQ
 * Note: REJECTED transactions are not errors at all — they are results, and are ACKed.
 */
export function classifyProcessingError(error: unknown): ErrorClass {
  if (error instanceof DomainError) return error.category === 'validation' ? 'permanent' : 'unexpected';
  if (error instanceof ApplicationError) return error.category === 'transient' ? 'transient' : 'business';
  if (error instanceof TransientPersistenceError) return 'transient';
  return 'unexpected';
}

export interface SqsWagerConsumerOptions {
  consumerName: string;
  maxAttempts: number;
  visibilityTimeoutSec: number;
  waitTimeSec: number;
  batchSize: number;
  retryBaseSec: number;
  retryMaxSec: number;
  /** Max time stop() waits for in-flight messages before giving up (visibility timeout covers the rest). */
  shutdownGraceMs: number;
  /**
   * Fault-injection seam used by tests: return false to simulate a crash AFTER the commit
   * and BEFORE the ack (the message is then neither acked nor released).
   */
  beforeAck?: (message: Message) => Promise<boolean>;
}

export type MessageOutcome = 'acked' | 'retry' | 'dlq' | 'released' | 'abandoned' | 'ack-failed';

/**
 * Long-polls the FIFO queue and feeds every message to the SAME use case as HTTP.
 *
 *  - Ordering: messages are grouped by MessageGroupId (= walletId); groups run in
 *    parallel, messages of one group strictly in order. If one message of a group is not
 *    acked, the rest of that group's batch is released (not processed out of order).
 *  - Ack only after the use case resolved, i.e. after COMMIT. A crash between commit and
 *    ack → redelivery → inbox / idempotency key → replay, no double effect.
 *  - Graceful stop: no new receives; in-flight messages finish and ack; received but not
 *    started messages get their visibility reset to 0 so another instance takes them now.
 */
export class SqsWagerConsumer {
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly client: SQSClient,
    private readonly queue: QueueUrlResolver,
    private readonly dlq: QueueUrlResolver,
    private readonly submit: SubmitWagerTransaction,
    private readonly options: SqsWagerConsumerOptions,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * The in-progress long poll is NOT aborted: aborting client-side does not cancel the
   * poll on the broker, which would still hand the next message to the dead connection
   * (invisible for a full visibility timeout and one receive attempt burnt). Instead we
   * wait for it to return (≤ waitTimeSec) and release whatever it brought back.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const timedOut = await Promise.race([
      this.loop?.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), this.options.shutdownGraceMs)),
    ]);
    if (timedOut) this.logger.warn('consumer stop grace period exceeded', { consumer: this.options.consumerName });
  }

  private async run(): Promise<void> {
    let consecutiveErrors = 0;
    while (this.running) {
      try {
        const messages = await this.receive();
        consecutiveErrors = 0;
        if (messages.length > 0) await this.handleBatch(messages);
      } catch (error) {
        if (!this.running) break;
        consecutiveErrors += 1;
        this.metrics.increment('sqs_receive_errors_total', { consumer: this.options.consumerName });
        this.logger.warn('sqs receive failed', { consumer: this.options.consumerName, error: error instanceof Error ? error : String(error) });
        await new Promise((r) => setTimeout(r, Math.min(10_000, 250 * 2 ** consecutiveErrors)));
      }
    }
  }

  private async receive(): Promise<Message[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queue.get(),
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSec,
        VisibilityTimeout: this.options.visibilityTimeoutSec,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    return response.Messages ?? [];
  }

  /** Exposed for tests: processes one received batch with the ordering rules above. */
  async handleBatch(messages: Message[]): Promise<MessageOutcome[]> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    const outcomes = await Promise.all(
      [...groups.values()].map(async (group) => {
        const results: MessageOutcome[] = [];
        for (let i = 0; i < group.length; i++) {
          const message = group[i]!;
          if (!this.running && this.loop) {
            results.push(...(await Promise.all(group.slice(i).map((m) => this.release(m)))));
            break;
          }
          const outcome = await this.handle(message);
          results.push(outcome);
          if (outcome !== 'acked' && outcome !== 'dlq') {
            // keep FIFO order: do not process later messages of this group now
            results.push(...(await Promise.all(group.slice(i + 1).map((m) => this.release(m)))));
            break;
          }
        }
        return results;
      }),
    );
    return outcomes.flat();
  }

  /** CONSUMER span; continues the producer's trace when the message carries `traceparent`. */
  private handle(message: Message): Promise<MessageOutcome> {
    return withSpan(
      `sqs.process ${this.queue.queueName}`,
      {
        kind: SpanKind.CONSUMER,
        parent: contextFromTraceParent(message.MessageAttributes?.traceparent?.StringValue),
        attributes: {
          'messaging.system': 'aws_sqs',
          'messaging.destination.name': this.queue.queueName,
          'messaging.message.id': message.MessageId ?? '',
          'messaging.sqs.receive_count': Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
        },
      },
      async (span) => {
        const outcome = await this.process(message);
        span.setAttribute('messaging.outcome', outcome);
        return outcome;
      },
    );
  }

  private async process(message: Message): Promise<MessageOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const consumer = this.options.consumerName;

    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(message.Body);
    } catch (error) {
      return this.moveToDlq(message, 'INVALID_MESSAGE', error, receiveCount);
    }

    const log = {
      consumer,
      messageId: parsed.messageId,
      correlationId: parsed.correlationId ?? parsed.messageId,
      walletId: parsed.data.walletId,
      providerId: parsed.data.providerId,
      receiveCount,
    };

    try {
      const result = await this.submit.execute({
        ...parsed.data,
        correlationId: parsed.correlationId ?? parsed.messageId,
        message: { consumerName: consumer, messageId: parsed.messageId, payloadHash: messagePayloadHash(parsed) },
      });
      if (this.options.beforeAck && !(await this.options.beforeAck(message))) return 'abandoned';
      const acked = await this.ack(message);
      this.metrics.increment('sqs_messages_total', {
        consumer,
        outcome: result.duplicateMessage ? 'duplicate' : result.idempotentReplay ? 'replay' : 'processed',
        status: result.status,
      });
      this.logger.info('message processed', { ...log, transactionId: result.transactionId, status: result.status });
      return acked ? 'acked' : 'ack-failed';
    } catch (error) {
      const kind = classifyProcessingError(error);
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : 'UNKNOWN');

      if (kind === 'business') {
        this.metrics.increment('sqs_messages_total', { consumer, outcome: 'business-error', code });
        this.logger.warn('message rejected by business rule', { ...log, code });
        return (await this.ack(message)) ? 'acked' : 'ack-failed';
      }
      if (kind === 'permanent') return this.moveToDlq(message, code, error, receiveCount);
      if (receiveCount >= this.options.maxAttempts) {
        return this.moveToDlq(message, 'RETRIES_EXHAUSTED', error, receiveCount);
      }

      const delay = Math.min(this.options.retryMaxSec, this.options.retryBaseSec * 2 ** (receiveCount - 1));
      this.metrics.increment('sqs_retries_total', { consumer, reason: kind });
      this.logger.warn('message will be retried', { ...log, code, kind, retryInSec: delay, error: error instanceof Error ? error : String(error) });
      await this.changeVisibility(message, delay);
      return 'retry';
    }
  }

  private async ack(message: Message): Promise<boolean> {
    try {
      await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queue.get(), ReceiptHandle: message.ReceiptHandle }));
      return true;
    } catch (error) {
      // The effect is committed; the redelivery will be deduplicated by the inbox.
      this.logger.warn('sqs ack failed (message will be redelivered and deduplicated)', {
        consumer: this.options.consumerName,
        sqsMessageId: message.MessageId,
        error: error instanceof Error ? error : String(error),
      });
      return false;
    }
  }

  private async release(message: Message): Promise<MessageOutcome> {
    await this.changeVisibility(message, 0);
    return 'released';
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.queue.get(),
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.max(0, Math.trunc(seconds)),
        }),
      );
    } catch (error) {
      // Falls back to the queue visibility timeout — still a retry, just a later one.
      this.logger.warn('sqs change visibility failed', { sqsMessageId: message.MessageId, error: error instanceof Error ? error : String(error) });
    }
  }

  /** Explicit DLQ move with the reason attached; the source is deleted only after the DLQ accepted it. */
  private async moveToDlq(message: Message, reason: string, error: unknown, receiveCount: number): Promise<MessageOutcome> {
    const consumer = this.options.consumerName;
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: await this.dlq.get(),
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            failureMessage: { DataType: 'String', StringValue: (error instanceof Error ? error.message : String(error)).slice(0, 256) || '-' },
            sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? '-' },
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
    } catch (dlqError) {
      this.logger.error('dlq send failed, message kept for retry', { consumer, sqsMessageId: message.MessageId, error: dlqError instanceof Error ? dlqError : String(dlqError) });
      await this.changeVisibility(message, this.options.retryBaseSec);
      return 'retry';
    }
    this.metrics.increment('sqs_dlq_total', { consumer, reason });
    this.logger.error('message moved to DLQ', { consumer, sqsMessageId: message.MessageId, reason, receiveCount });
    await this.ack(message);
    return 'dlq';
  }
}
