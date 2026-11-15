import { HttpException } from '@nestjs/common';
import { ApplicationError, IdempotencyConflictError, WalletAlreadyExistsError } from '../../application/errors';
import { TransientPersistenceError } from '../../application/ports/persistence';
import type { WagerTransactionResult } from '../../application/wagering/wager-transaction-result';
import { DomainError } from '../../domain/shared/errors';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { AuthenticationError, ProviderForbiddenError } from './auth/authenticator';

/**
 * HTTP status contract — identical on every endpoint, so a provider can decide what to
 * do from the status alone:
 *
 *   200  PROCESSED (new or replay — a replay returns the SAME status and body)
 *   201  wallet created
 *   202  PENDING_REFERENCE — accepted, will settle when the reference arrives
 *   400  VALIDATION_ERROR / MALFORMED_REQUEST — fix the payload; never persisted
 *   401  UNAUTHENTICATED            403  PROVIDER_FORBIDDEN
 *   404  WALLET_NOT_FOUND / TRANSACTION_NOT_FOUND / ROUTE_NOT_FOUND
 *   409  IDEMPOTENCY_KEY_REUSED / EXTERNAL_ID_REUSED / WALLET_ALREADY_EXISTS — do NOT resend
 *   422  REJECTED by a business rule — body carries failureCode + retryGuidance (replayable)
 *   500  INTERNAL_ERROR (bug / invariant) — details only in logs
 *   503  TEMPORARILY_UNAVAILABLE + Retry-After — safe to resend the same request
 */
export function statusForResult(result: WagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** true when the error is unexpected and must be logged with full detail */
  unexpected: boolean;
}

const HTTP_EXCEPTION_CODES: Record<number, string> = {
  400: 'MALFORMED_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'ROUTE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

const unavailable = (message: string): MappedError => ({
  status: 503,
  code: 'TEMPORARILY_UNAVAILABLE',
  message,
  retryable: true,
  headers: { 'Retry-After': '1' },
  unexpected: false,
});

export function mapError(error: unknown): MappedError {
  if (error instanceof DomainError) {
    return error.category === 'validation'
      ? { status: 400, code: error.code, message: error.message, retryable: false, unexpected: false }
      : { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false, unexpected: true };
  }

  if (error instanceof ApplicationError) {
    switch (error.category) {
      case 'not-found':
        return { status: 404, code: error.code, message: error.message, retryable: false, unexpected: false };
      case 'conflict': {
        const details =
          error instanceof IdempotencyConflictError
            ? { existingTransactionId: error.existingTransactionId }
            : error instanceof WalletAlreadyExistsError
              ? { existingWalletId: error.existingWalletId }
              : undefined;
        return { status: 409, code: error.code, message: error.message, retryable: false, details, unexpected: false };
      }
      case 'transient':
        return unavailable('service temporarily unavailable, retry the same request');
    }
  }

  if (error instanceof TransientPersistenceError) return unavailable('service temporarily unavailable');

  if (error instanceof AuthenticationError) {
    return { status: 401, code: error.code, message: error.message, retryable: false, unexpected: false, headers: { 'WWW-Authenticate': 'Bearer' } };
  }
  if (error instanceof ProviderForbiddenError) {
    return { status: 403, code: error.code, message: error.message, retryable: false, unexpected: false };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      code: HTTP_EXCEPTION_CODES[status] ?? `HTTP_${status}`,
      message: status === 400 ? 'malformed request' : error.message,
      retryable: false,
      unexpected: status >= 500,
    };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error', retryable: false, unexpected: true };
}
