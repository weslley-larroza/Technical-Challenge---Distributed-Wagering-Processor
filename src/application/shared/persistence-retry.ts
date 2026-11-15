import { TransientInfrastructureError } from '../errors';
import { TransientPersistenceError, UniqueViolationError } from '../ports/persistence';
import type { Metrics } from '../ports/system';

export interface RetryOptions {
  operation: string;
  metrics: Metrics;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry around a whole unit of work (never around a single statement — the
 * transaction is rolled back, so each attempt starts from a clean state):
 *
 *  - UniqueViolationError: a concurrent request inserted the same key first. The next
 *    attempt re-reads it and returns a replay / conflict. No delay needed.
 *  - TransientPersistenceError (deadlock, lock timeout, connection): retried with
 *    exponential backoff + full jitter; after the last attempt → TransientInfrastructureError
 *    (HTTP 503 / SQS redelivery).
 *  - anything else (domain / application errors, bugs): rethrown untouched.
 */
export async function withPersistenceRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const last = attempt >= maxAttempts;

      if (error instanceof UniqueViolationError) {
        opts.metrics.increment('persistence_retries_total', { operation: opts.operation, reason: 'unique-race' });
        if (last) throw new TransientInfrastructureError('unresolved unique race', { cause: error });
        continue;
      }

      if (error instanceof TransientPersistenceError) {
        opts.metrics.increment('persistence_retries_total', { operation: opts.operation, reason: error.reason });
        if (error.reason === 'deadlock' || error.reason === 'lock-timeout') {
          opts.metrics.increment('lock_conflicts_total', { operation: opts.operation, reason: error.reason });
        }
        if (last) throw new TransientInfrastructureError(error.reason, { cause: error });
        await sleep(Math.random() * Math.min(1_000, 25 * 2 ** attempt));
        continue;
      }

      throw error;
    }
  }
}
