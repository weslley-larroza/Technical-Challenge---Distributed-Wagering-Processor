import type { EventPublisher } from '../ports/messaging';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock, Logger, Metrics } from '../ports/system';

export interface PublishOutboxReport {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * One publisher pass. The claim (FOR UPDATE SKIP LOCKED), the broker call and the
 * "published" mark happen inside ONE database transaction:
 *
 *  - N publishers on N instances get disjoint batches, no global lock, no leader.
 *  - Crash after the broker accepted but before COMMIT → row stays unpublished, locks are
 *    released, another publisher re-sends it. Duplicates are therefore possible and safe:
 *    the broker message id / dedup id is the eventId, consumers dedupe on it.
 *  - Broker failure → scheduleRetry (exponential backoff); the event is never dropped.
 *
 * Events are only ever read from committed outbox rows, so nothing can be published
 * before the financial transaction commits.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async runOnce(batchSize = 50): Promise<PublishOutboxReport> {
    return this.uow.run(async (r) => {
      const now = this.clock.now();
      const batch = await r.outbox.claimDue(now, batchSize);
      if (batch.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const result = await this.publisher.publish(batch);
      const published = new Set(result.published);
      const failures = new Map(result.failed.map((f) => [f.id, f.error]));
      const doneAt = this.clock.now();

      for (const message of batch) {
        if (published.has(message.id)) {
          message.markPublished(doneAt);
          this.metrics.increment('outbox_published_total', { eventType: message.eventType });
          this.metrics.observe('outbox_lag_ms', doneAt.getTime() - message.occurredAt.getTime(), {
            eventType: message.eventType,
          });
        } else {
          message.scheduleRetry(doneAt, failures.get(message.id) ?? 'not acknowledged by broker');
          this.metrics.increment('outbox_publish_failures_total', { eventType: message.eventType });
          this.logger.warn('outbox publish failed', {
            outboxId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            error: failures.get(message.id),
          });
        }
        await r.outbox.save(message);
      }
      return { claimed: batch.length, published: published.size, failed: batch.length - published.size };
    });
  }
}
