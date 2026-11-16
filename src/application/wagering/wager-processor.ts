import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import { JournalTransaction, LedgerAccount } from '../../domain/ledger/double-entry';
import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/shared/failure-code';
import { type ReferenceLookup, type SettlementOutcome, WagerSettlement } from '../../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Repositories } from '../ports/persistence';
import type { Clock, IdGenerator, Metrics } from '../ports/system';

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
  source: 'http' | 'sqs' | 'worker';
}

/**
 * Applies a transaction to a wallet that the CALLER HAS ALREADY LOCKED, and stages every
 * resulting write in the same unit of work:
 *   transaction row + ledger entry + wallet update + outbox events
 * Then cascades to PENDING_REFERENCE transactions of the same wallet that were waiting
 * for the one just processed (out-of-order delivery converges in the same commit).
 */
export class WagerProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  async lookupReference(r: Repositories, tx: WagerTransaction): Promise<ReferenceLookup | undefined> {
    if (!tx.referenceExternalTransactionId) return undefined;
    const reference = await r.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    if (!reference) return { found: false };
    return { found: true, transaction: reference, alreadyReversed: await r.transactions.isReversed(reference.id) };
  }

  /**
   * @param isNew true when `tx` is not persisted yet (insert), false when it was loaded (update).
   */
  async process(
    r: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    isNew: boolean,
    ctx: ProcessingContext,
    reference?: ReferenceLookup,
  ): Promise<SettlementOutcome> {
    const lookup = reference ?? (await this.lookupReference(r, tx));
    const outcome = WagerSettlement.settle({
      wallet,
      transaction: tx,
      reference: lookup,
      ledgerEntryId: this.ids.next(),
      now: this.clock.now(),
    });
    await this.record(r, wallet, tx, outcome, isNew, ctx);

    if (outcome.type === 'processed') {
      await this.cascade(r, wallet, tx, ctx);
    }
    return outcome;
  }

  /** Worker path: reference still missing after the retry budget → REJECTED REFERENCE_NOT_FOUND. */
  async expire(r: Repositories, wallet: Wallet, tx: WagerTransaction, ctx: ProcessingContext): Promise<void> {
    tx.reject(FailureCode.ReferenceNotFound, wallet.balance, this.clock.now());
    await this.record(r, wallet, tx, { type: 'rejected', failureCode: FailureCode.ReferenceNotFound }, false, ctx);
  }

  private async record(
    r: Repositories,
    wallet: Wallet,
    tx: WagerTransaction,
    outcome: SettlementOutcome,
    isNew: boolean,
    ctx: ProcessingContext,
  ): Promise<void> {
    if (isNew) r.transactions.add(tx);
    else await r.transactions.save(tx);

    if (outcome.type === 'processed' && outcome.ledgerEntry) {
      r.ledger.add(outcome.ledgerEntry);
      await r.wallets.save(wallet);
      // Double-entry: player leg mirrors the wallet entry, the provider's gaming account
      // takes the other side. Same SQL transaction; balanced-ness re-checked at COMMIT.
      const counterparty = LedgerAccount.providerGaming(tx.providerId, tx.money.currency);
      await r.journal.ensureAccounts([counterparty]);
      await r.journal.record(
        JournalTransaction.forWalletMovement({ entry: outcome.ledgerEntry, counterparty, newId: () => this.ids.next() }),
      );
    }

    for (const event of this.eventsFor(outcome, wallet, tx, ctx)) {
      r.outbox.add(OutboxMessage.enqueue(event));
    }
    this.metrics.increment('wager_transactions_total', { kind: tx.kind, status: tx.status, source: ctx.source });
  }

  private eventsFor(
    outcome: SettlementOutcome,
    wallet: Wallet,
    tx: WagerTransaction,
    ctx: ProcessingContext,
  ): IntegrationEvent<unknown>[] {
    const eventCtx: EventContext = {
      newId: () => this.ids.next(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: this.clock.now(),
    };
    switch (outcome.type) {
      case 'processed':
        return [
          WagerTransactionProcessed.from(tx, eventCtx),
          ...(outcome.ledgerEntry ? [WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventCtx)] : []),
        ];
      case 'rejected':
        return [WagerTransactionRejected.from(tx, eventCtx)];
      case 'pending-reference':
        // announce once; re-schedules by the worker are not new facts
        return tx.referenceAttempts === 1 ? [WagerTransactionPendingReference.from(tx, eventCtx)] : [];
    }
  }

  /**
   * Breadth-first: a processed BET may unblock a REFUND, which may unblock a ROLLBACK of
   * that REFUND. Reversal tracking is kept in memory because the rows staged in this unit
   * of work are not visible to SQL queries yet.
   */
  private async cascade(r: Repositories, wallet: Wallet, root: WagerTransaction, ctx: ProcessingContext): Promise<void> {
    const queue: WagerTransaction[] = [root];
    const reversed = new Set<string>();

    while (queue.length > 0) {
      const reference = queue.shift()!;
      const waiting = await r.transactions.findPendingReferencing(
        reference.providerId,
        wallet.id,
        reference.externalTransactionId,
      );
      for (const pending of waiting) {
        const lookup: ReferenceLookup = {
          found: true,
          transaction: reference,
          alreadyReversed: reversed.has(reference.id) || (await r.transactions.isReversed(reference.id)),
        };
        const outcome = WagerSettlement.settle({
          wallet,
          transaction: pending,
          reference: lookup,
          ledgerEntryId: this.ids.next(),
          now: this.clock.now(),
        });
        await this.record(r, wallet, pending, outcome, false, { ...ctx, causationId: root.id });
        this.metrics.increment('pending_reference_resolutions_total', { outcome: outcome.type, trigger: 'cascade' });

        if (outcome.type === 'processed') {
          if (pending.isReversal()) reversed.add(reference.id);
          queue.push(pending);
        }
      }
    }
  }
}
