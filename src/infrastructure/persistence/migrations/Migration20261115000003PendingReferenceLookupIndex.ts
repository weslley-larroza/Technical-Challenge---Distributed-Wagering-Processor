import { Migration } from '@mikro-orm/migrations';

/**
 * Supports the cascade "which PENDING_REFERENCE rows of this wallet wait for the
 * transaction that was just processed?" — run on every processed transaction, so it must
 * be an index probe. Partial: only pending rows are indexed (tiny, hot).
 */
export class Migration20261115000003PendingReferenceLookupIndex extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index wager_tx_waiting_for_reference_idx
        on wager_transactions (provider_id, wallet_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists wager_tx_waiting_for_reference_idx');
  }
}
