/**
 * Application errors (outside the domain): the edges map `category` to transport.
 *   not-found  → HTTP 404 / SQS terminal (ack)
 *   conflict   → HTTP 409 / SQS terminal (ack)
 *   transient  → HTTP 503 / SQS retry with backoff
 */
export type ApplicationErrorCategory = 'not-found' | 'conflict' | 'transient';

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ApplicationErrorCategory;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  readonly category = 'not-found' as const;
  constructor(readonly walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  readonly category = 'not-found' as const;
  constructor(what: string) {
    super(`transaction ${what} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'conflict' as const;
  constructor(
    readonly playerId: string,
    readonly currency: string,
    readonly existingWalletId: string,
  ) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

/**
 * IDEMPOTENCY_KEY_REUSED : same Idempotency-Key, different business payload.
 * EXTERNAL_ID_REUSED     : same (providerId, externalTransactionId) under a different key.
 * Never a replay — the provider has a bug and must not blindly resend.
 */
export class IdempotencyConflictError extends ApplicationError {
  readonly category = 'conflict' as const;
  constructor(
    readonly code: 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_ID_REUSED',
    readonly existingTransactionId: string,
  ) {
    super(
      code === 'IDEMPOTENCY_KEY_REUSED'
        ? 'idempotency key already used with a different payload'
        : 'external transaction id already used under a different idempotency key',
    );
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';
  readonly category = 'transient' as const;
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`temporarily unavailable: ${reason}`, options);
  }
}
