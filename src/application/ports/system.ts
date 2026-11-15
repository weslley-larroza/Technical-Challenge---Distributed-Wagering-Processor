export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

export type Labels = Readonly<Record<string, string>>;

/**
 * Metrics port. Names used by the application:
 *   wager_transactions_total{kind,status,source}
 *   idempotent_replays_total{source}
 *   idempotency_conflicts_total{code}
 *   inbox_duplicates_total{consumer}
 *   persistence_retries_total{operation,reason}
 *   lock_conflicts_total{operation,reason}
 *   pending_reference_resolutions_total{outcome}
 *   reconciliation_mismatches_total
 *   wager_processing_duration_ms{source}   (histogram)
 */
export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const noopMetrics: Metrics = { increment: () => {}, observe: () => {} };
export const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
