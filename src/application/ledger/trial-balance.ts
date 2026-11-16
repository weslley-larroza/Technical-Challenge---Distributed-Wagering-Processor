import { Money, type MoneyProps } from '../../domain/money/money';
import { DomainValidationError } from '../../domain/shared/errors';
import type { UnitOfWork } from '../ports/persistence';
import type { Logger, Metrics } from '../ports/system';

export interface TrialBalanceLine {
  code: string;
  kind: string;
  accounts: number;
  debits: MoneyProps;
  credits: MoneyProps;
  /** credits − debits: money held by the account (negative for FUNDING: money that entered) */
  balance: MoneyProps;
}

export interface TrialBalanceReport {
  currency: string;
  lines: TrialBalanceLine[];
  totals: { debits: MoneyProps; credits: MoneyProps };
  /** Σ debits == Σ credits over the whole book, i.e. the sum of every balance is zero. */
  balanced: boolean;
}

/**
 * Trial balance of the double-entry journal for one currency, from one REPEATABLE READ
 * snapshot. Player wallets are aggregated into a single line (one account per wallet).
 * An unbalanced book is reported, logged and counted — never corrected.
 */
export class GetTrialBalance {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(currency: string): Promise<TrialBalanceReport> {
    if (!/^[A-Z]{3}$/.test(currency)) throw new DomainValidationError('currency must be an ISO-4217 code');
    const rows = await this.uow.run((r) => r.journal.trialBalance(currency), { isolation: 'repeatable-read' });

    let debits = Money.zero(currency);
    let credits = Money.zero(currency);
    const lines = rows.map((row) => {
      const d = Money.from({ amount: row.debits, currency });
      const c = Money.from({ amount: row.credits, currency });
      debits = debits.add(d);
      credits = credits.add(c);
      return { code: row.code, kind: row.kind, accounts: row.accounts, debits: d.toJSON(), credits: c.toJSON(), balance: c.subtract(d).toJSON() };
    });
    const balanced = debits.equals(credits);
    if (!balanced) {
      this.metrics.increment('trial_balance_mismatches_total');
      this.logger.error('double-entry book is not balanced', { currency, debits: debits.amount, credits: credits.amount });
    }
    return { currency, lines, totals: { debits: debits.toJSON(), credits: credits.toJSON() }, balanced };
  }
}
