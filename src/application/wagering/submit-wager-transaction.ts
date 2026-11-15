import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { DomainValidationError } from '../../domain/shared/errors';
import {
  SUBMITTABLE_KINDS,
  WagerTransaction,
  type WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import { IdempotencyConflictError, WalletNotFoundError } from '../errors';
import { wagerPayloadHash } from '../idempotency/payload-hash';
import type { Repositories, UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator, Logger, Metrics } from '../ports/system';
import { withPersistenceRetry } from '../shared/persistence-retry';
import type { WagerProcessor } from './wager-processor';
import { toResult, type WagerTransactionResult } from './wager-transaction-result';

export interface SubmitWagerTransactionCommand {
  /** Source of truth for idempotency (HTTP header / message field). */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** Present when the command comes from a queue: inbox dedup in the same SQL transaction. */
  message?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface SubmitWagerTransactionOutput extends WagerTransactionResult {
  /** The queue message itself was already processed (inbox hit). */
  duplicateMessage?: boolean;
}

/**
 * The single entry point for HTTP and SQS.
 *
 * Inside one SQL transaction:
 *   1. inbox check (queue only)            — exact redelivery → replay
 *   2. idempotency lookup (no lock)        — fast replay / conflict path
 *   3. SELECT wallet FOR UPDATE            — serialises everything touching this wallet
 *   4. idempotency re-check under the lock — closes the check-then-insert race per wallet
 *   5. settle + stage tx/ledger/wallet/outbox (+ inbox) and commit together
 *
 * A concurrent insert of the same key on ANOTHER wallet surfaces as a unique violation;
 * the retry re-runs the whole unit of work and lands on step 2 (replay / conflict).
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionOutput> {
    const startedAt = performance.now();
    const source = cmd.message ? 'sqs' : 'http';
    // Fail fast on malformed input before touching the database (never persisted),
    // then hash the NORMALIZED fields (lowercase UUIDs, 2-decimal amount).
    const { normalized, payloadHash } = this.validateAndHash(cmd);

    try {
      return await withPersistenceRetry(
        () => this.uow.run((r) => this.attempt(r, normalized, payloadHash, source)),
        { operation: 'submit-wager-transaction', metrics: this.metrics },
      );
    } finally {
      this.metrics.observe('wager_processing_duration_ms', performance.now() - startedAt, { source });
    }
  }

  private async attempt(
    r: Repositories,
    cmd: SubmitWagerTransactionCommand,
    payloadHash: string,
    source: 'http' | 'sqs',
  ): Promise<SubmitWagerTransactionOutput> {
    // 1. queue redelivery
    if (cmd.message) {
      const seen = await r.inbox.find(cmd.message.consumerName, cmd.message.messageId);
      if (seen) {
        this.metrics.increment('inbox_duplicates_total', { consumer: cmd.message.consumerName });
        const original = await r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
        if (original) return { ...this.replayOrConflict(original, payloadHash, source), duplicateMessage: true };
      }
    }

    // 2. fast path — no lock needed to read a row that already exists
    const prior = await r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (prior) {
      this.recordInbox(r, cmd);
      return this.replayOrConflict(prior, payloadHash, source);
    }

    // 3. per-wallet lock
    const wallet = await r.wallets.lockById(cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    // 4. re-check under the lock
    const raced = await r.transactions.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
    if (raced) {
      this.recordInbox(r, cmd);
      return this.replayOrConflict(raced, payloadHash, source);
    }
    const sameExternal = await r.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternal) {
      this.metrics.increment('idempotency_conflicts_total', { code: 'EXTERNAL_ID_REUSED' });
      throw new IdempotencyConflictError('EXTERNAL_ID_REUSED', sameExternal.id);
    }

    // 5. apply
    const tx = this.draft(cmd, payloadHash);
    await this.processor.process(r, wallet, tx, true, {
      correlationId: cmd.correlationId,
      causationId: cmd.message?.messageId,
      source,
    });
    this.recordInbox(r, cmd);

    this.logger.info('wager transaction settled', {
      correlationId: cmd.correlationId,
      messageId: cmd.message?.messageId,
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode,
    });
    return toResult(tx, false);
  }

  private replayOrConflict(existing: WagerTransaction, payloadHash: string, source: string): WagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      this.metrics.increment('idempotency_conflicts_total', { code: 'IDEMPOTENCY_KEY_REUSED' });
      throw new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', existing.id);
    }
    this.metrics.increment('idempotent_replays_total', { source });
    return toResult(existing, true);
  }

  private recordInbox(r: Repositories, cmd: SubmitWagerTransactionCommand): void {
    if (!cmd.message) return;
    const now = this.clock.now();
    const inbox = InboxMessage.receive({ ...cmd.message, receivedAt: now });
    inbox.markProcessed(now);
    r.inbox.add(inbox);
  }

  private validateAndHash(cmd: SubmitWagerTransactionCommand): {
    normalized: SubmitWagerTransactionCommand;
    payloadHash: string;
  } {
    if (typeof cmd.idempotencyKey !== 'string' || cmd.idempotencyKey.trim() === '') {
      throw new DomainValidationError('Idempotency-Key is required');
    }
    if (!(SUBMITTABLE_KINDS as readonly string[]).includes(cmd.kind)) {
      throw new DomainValidationError(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
    }
    const probe = this.draft(cmd, ''); // throws DomainValidationError / InvalidMoneyError
    const payloadHash = wagerPayloadHash({
      providerId: probe.providerId,
      externalTransactionId: probe.externalTransactionId,
      playerId: probe.playerId,
      walletId: probe.walletId,
      roundId: probe.roundId,
      gameId: probe.gameId,
      kind: probe.kind,
      money: probe.money.toJSON(),
      referenceExternalTransactionId: probe.referenceExternalTransactionId,
    });
    return { normalized: { ...cmd, walletId: probe.walletId, playerId: probe.playerId }, payloadHash };
  }

  private draft(cmd: SubmitWagerTransactionCommand, payloadHash: string): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as WagerTransactionKind,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}
