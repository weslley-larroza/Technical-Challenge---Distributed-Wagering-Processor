import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock, Logger, Metrics } from '../ports/system';
import { withPersistenceRetry } from '../shared/persistence-retry';
import type { WagerProcessor } from './wager-processor';

export interface ResolvePendingReferencesReport {
  scanned: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
}

/**
 * One pass of the scheduled worker for out-of-order references (section 7.1).
 *
 * Multi-instance safety: candidates are read without locks; each one is then handled in
 * its own unit of work that first locks the WALLET (same lock order as submissions → no
 * deadlocks) and re-reads the transaction. If another instance got there first the row
 * is no longer due and is skipped. No global lock, no leader election.
 *
 * Policy: exponential backoff 2s → 5min, 10 attempts (~18 min). After that the
 * transaction is REJECTED with REFERENCE_NOT_FOUND and the event is published.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async runOnce(batchSize = 100): Promise<ResolvePendingReferencesReport> {
    const report: ResolvePendingReferencesReport = { scanned: 0, processed: 0, rejected: 0, rescheduled: 0, skipped: 0 };
    const due = await this.uow.run((r) => r.transactions.findDuePendingReferences(this.clock.now(), batchSize));
    report.scanned = due.length;

    for (const candidate of due) {
      const outcome = await withPersistenceRetry(
        () =>
          this.uow.run(async (r) => {
            const wallet = await r.wallets.lockById(candidate.walletId);
            const tx = await r.transactions.findById(candidate.id);
            const now = this.clock.now();
            if (
              !wallet ||
              !tx ||
              tx.status !== WagerTransactionStatus.PendingReference ||
              (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt > now)
            ) {
              return 'skipped' as const;
            }

            const ctx = { correlationId: tx.id, causationId: tx.id, source: 'worker' as const };
            const lookup = await this.processor.lookupReference(r, tx);
            if (lookup && !lookup.found && tx.hasExhaustedReferenceRetries()) {
              await this.processor.expire(r, wallet, tx, ctx);
              this.logger.warn('pending reference expired', {
                transactionId: tx.id,
                walletId: tx.walletId,
                providerId: tx.providerId,
                attempts: tx.referenceAttempts,
              });
              return 'rejected' as const;
            }

            const result = await this.processor.process(r, wallet, tx, false, ctx, lookup);
            return result.type === 'processed'
              ? ('processed' as const)
              : result.type === 'rejected'
                ? ('rejected' as const)
                : ('rescheduled' as const);
          }),
        { operation: 'resolve-pending-reference', metrics: this.metrics },
      );
      report[outcome] += 1;
      if (outcome !== 'skipped') {
        this.metrics.increment('pending_reference_resolutions_total', { outcome, trigger: 'worker' });
      }
    }
    return report;
  }
}
