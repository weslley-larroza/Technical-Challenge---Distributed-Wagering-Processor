import { Money, type MoneyProps } from '../../domain/money/money';
import { canonicalUuid } from '../../domain/shared/identifiers';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/persistence';
import type { Logger, Metrics } from '../ports/system';
import { withPersistenceRetry } from '../shared/persistence-retry';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Recomputes the balance from the ledger and compares it with the materialized balance.
 * Read in ONE REPEATABLE READ snapshot (consistent without blocking writers).
 * Divergences are never "fixed": they are logged, counted and reported.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const report = await withPersistenceRetry(
      () =>
        this.uow.run(
          async (r) => {
            const wallet = await r.wallets.findById(canonicalUuid('walletId', walletId));
            if (!wallet) throw new WalletNotFoundError(walletId);
            const totals = await r.ledger.totals(wallet.id);
            const credits = Money.from({ amount: totals.credits, currency: wallet.currency });
            const debits = Money.from({ amount: totals.debits, currency: wallet.currency });
            const calculated = credits.subtract(debits);
            const difference = wallet.balance.subtract(calculated);
            return {
              walletId: wallet.id,
              storedBalance: wallet.balance.toJSON(),
              calculatedBalance: calculated.toJSON(),
              difference: difference.toJSON(),
              consistent: difference.isZero(),
              checkedEntries: totals.count,
            };
          },
          { isolation: 'repeatable-read' },
        ),
      { operation: 'reconcile-wallet', metrics: this.metrics },
    );

    if (!report.consistent) {
      this.metrics.increment('reconciliation_mismatches_total');
      this.logger.error('wallet reconciliation mismatch', {
        correlationId,
        walletId: report.walletId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
