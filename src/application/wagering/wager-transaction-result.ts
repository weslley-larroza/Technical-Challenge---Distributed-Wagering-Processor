import type { MoneyProps } from '../../domain/money/money';
import { FAILURE_RETRY_GUIDANCE, type FailureCode, type RetryGuidance } from '../../domain/shared/failure-code';
import type { WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';

/** Response contract shared by HTTP and SQS (and by replays). */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the outcome was decided (absent when not applicable / not disclosed). */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  retryGuidance?: RetryGuidance;
  idempotentReplay: boolean;
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.balanceAfter ? { balance: tx.balanceAfter.toJSON() } : {}),
    ...(tx.failureCode
      ? { failureCode: tx.failureCode, retryGuidance: FAILURE_RETRY_GUIDANCE[tx.failureCode] }
      : {}),
    idempotentReplay,
  };
}
