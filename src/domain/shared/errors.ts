/**
 * Domain errors carry a stable machine-readable `code` and a `category` used by the
 * edges (HTTP / SQS) to map them without `instanceof` chains:
 *
 *  - 'validation' : the input is malformed. Never persisted. HTTP 400 / SQS → DLQ (permanent).
 *  - 'invariant'  : an invariant was about to be broken by OUR code (a bug). Business
 *                   outcomes are never thrown — they are returned as REJECTED results.
 *                   HTTP 500 / SQS → retry, then DLQ.
 *
 * They never depend on NestJS/HTTP — mapping to transport happens at the edge.
 */
export type DomainErrorCategory = 'validation' | 'invariant';

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly category: DomainErrorCategory;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input: never persisted. */
export class DomainValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly category = 'validation' as const;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  readonly category = 'validation' as const;
}

/** Thrown only by Money arithmetic; settlement checks currency first and returns REJECTED. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  readonly category = 'invariant' as const;
}

/** Arithmetic result outside NUMERIC(20,2). Settlement checks first and returns REJECTED. */
export class MoneyOverflowError extends DomainError {
  readonly code = 'MONEY_OVERFLOW';
  readonly category = 'invariant' as const;
}

/** Thrown only if a debit bypasses canDebit(); settlement returns REJECTED instead. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  readonly category = 'invariant' as const;
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
  readonly category = 'invariant' as const;
}

/** Programming error: attempted transition out of a terminal / invalid state. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  readonly category = 'invariant' as const;
}
