/**
 * Stable, machine-readable failure taxonomy persisted on REJECTED / FAILED transactions.
 *
 * Retry guidance for providers:
 *  - FIX_PAYLOAD : the request is wrong; resend only with a NEW external id after fixing it.
 *  - GIVE_UP     : business outcome is final; resending yields the same (replayed) result.
 *  - RETRY_LATER : transient infrastructure problem; the SAME request may be resent.
 *                  Never persisted — transient errors are surfaced as 503 / SQS redelivery.
 *  - CONTACT_SUPPORT : FAILED (permanent, terminal). Resending the same key replays the
 *                  failure; requires operator investigation.
 */
export enum FailureCode {
  // ---- business rejections (REJECTED, terminal)
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET without balance
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK would make balance negative
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // retries for an out-of-order reference exhausted
  ReferenceMismatch = 'REFERENCE_MISMATCH', // different player / wallet / currency / round
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND', // e.g. REFUND pointing to a WIN
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // reference is REJECTED / FAILED
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH', // partial reversals are out of scope
  AlreadyReversed = 'ALREADY_REVERSED', // reference already refunded/rolled back (also blocks WIN on it)
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED', // credit would exceed NUMERIC(20,2)

  // ---- permanent infrastructure failure (FAILED, terminal, auditable)
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}

export type RetryGuidance = 'FIX_PAYLOAD' | 'GIVE_UP' | 'RETRY_LATER' | 'CONTACT_SUPPORT';

export const FAILURE_RETRY_GUIDANCE: Readonly<Record<FailureCode, RetryGuidance>> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalInsufficientFunds]: 'GIVE_UP',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerWalletMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotFound]: 'GIVE_UP',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.BalanceLimitExceeded]: 'CONTACT_SUPPORT',
  [FailureCode.PermanentProcessingError]: 'CONTACT_SUPPORT',
};
