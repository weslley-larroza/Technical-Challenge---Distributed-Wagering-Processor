export interface BackoffPolicy {
  /** delay for the first retry, in ms */
  readonly baseMs: number;
  /** upper bound for a single delay, in ms */
  readonly maxMs: number;
}

/**
 * Deterministic exponential backoff: base * 2^(attempt-1), capped at max.
 * `attempt` is 1-based (the attempt that just failed). Deterministic on purpose so
 * that domain behaviour is testable; jitter, if wanted, belongs to the scheduler.
 */
export function exponentialDelayMs(policy: BackoffPolicy, attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  // 2^30 * base already overflows any sane cap; avoid Infinity.
  const raw = policy.baseMs * 2 ** Math.min(exp, 30);
  return Math.min(raw, policy.maxMs);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
