import { addMs, type BackoffPolicy, exponentialDelayMs } from '../shared/backoff';
import { InvalidTransactionStateError } from '../shared/errors';
import type { IntegrationEvent } from './integration-event';

export const OUTBOX_RETRY_POLICY: Readonly<BackoffPolicy> = Object.freeze({ baseMs: 1_000, maxMs: 60_000 });

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
  /** W3C trace context of the producing request (transport metadata, not event content). */
  traceParent?: string;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
    public readonly traceParent: string | undefined = undefined,
  ) {}

  /** id === eventId, so consumers can deduplicate redelivered publications by eventId. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(envelope),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
      s.lastError,
      s.traceParent,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox ${this.id} already published`);
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** increments attempts and computes the next nextAttemptAt (backoff). Never gives up: events must not be lost. */
  scheduleRetry(now: Date, error?: string): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox ${this.id} already published`);
    this._attempts += 1;
    this._nextAttemptAt = addMs(now, exponentialDelayMs(OUTBOX_RETRY_POLICY, this._attempts));
    this._lastError = error?.slice(0, 500);
  }
}
