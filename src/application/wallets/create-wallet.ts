import { createHash } from 'node:crypto';
import { JournalTransaction, LedgerAccount } from '../../domain/ledger/double-entry';
import { WalletBalanceChanged } from '../../domain/messaging/events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletAlreadyExistsError } from '../errors';
import { canonicalJson } from '../idempotency/payload-hash';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator, Logger, Metrics } from '../ports/system';
import { withPersistenceRetry } from '../shared/persistence-retry';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(w: Wallet): WalletView {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

/**
 * Wallet + internal OPENING transaction + CREDIT entry + WalletBalanceChanged, in one SQL
 * transaction. Duplicate player+currency → 409; a concurrent duplicate loses on the unique
 * index, the retry re-reads the winner and reports the same conflict.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(cmd.initialBalance);

    return withPersistenceRetry(
      () =>
        this.uow.run(async (r) => {
          const now = this.clock.now();
          const openingTransactionId = this.ids.next();
          const { wallet, openingEntry } = Wallet.open({
            id: this.ids.next(),
            playerId: cmd.playerId,
            initialBalance,
            opening: { transactionId: openingTransactionId, ledgerEntryId: this.ids.next() },
            now,
          });

          const existing = await r.wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
          if (existing) throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency, existing.id);

          r.wallets.add(wallet);
          const playerAccount = LedgerAccount.playerWallet(wallet.id, wallet.currency);
          const funding = LedgerAccount.funding(wallet.currency);
          await r.journal.ensureAccounts(openingEntry ? [playerAccount, funding] : [playerAccount]);
          if (openingEntry) {
            // money enters the closed system: FUNDING → player
            await r.journal.record(
              JournalTransaction.forWalletMovement({ entry: openingEntry, counterparty: funding, newId: () => this.ids.next() }),
            );
            r.transactions.add(
              WagerTransaction.opening({
                id: openingTransactionId,
                walletId: wallet.id,
                playerId: wallet.playerId,
                money: initialBalance,
                payloadHash: `sha256:${createHash('sha256')
                  .update(canonicalJson({ walletId: wallet.id, initialBalance: initialBalance.toJSON() }))
                  .digest('hex')}`,
                at: now,
              }),
            );
            r.ledger.add(openingEntry);
            r.outbox.add(
              OutboxMessage.enqueue(
                WalletBalanceChanged.from(wallet, openingEntry, {
                  newId: () => this.ids.next(),
                  correlationId: cmd.correlationId,
                  occurredAt: now,
                }),
              ),
            );
          }
          this.logger.info('wallet created', { correlationId: cmd.correlationId, walletId: wallet.id });
          return toWalletView(wallet);
        }),
      { operation: 'create-wallet', metrics: this.metrics },
    );
  }
}
