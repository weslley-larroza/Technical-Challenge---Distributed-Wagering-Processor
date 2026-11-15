import type { MoneyProps } from '../domain/money/money';
import { DomainValidationError } from '../domain/shared/errors';
import { canonicalUuid } from '../domain/shared/identifiers';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { LedgerDirection } from '../domain/wallet/wallet-ledger-entry';
import { TransactionNotFoundError, WalletNotFoundError } from './errors';
import type { UnitOfWork } from './ports/persistence';
import { toWalletView, type WalletView } from './wallets/create-wallet';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  /** Opaque; absent on the last page. */
  nextCursor?: string;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balanceAfter?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export const MAX_LEDGER_PAGE = 200;

/**
 * Cursor = base64url("v1:<seq>"). Opaque to clients, stable under concurrent appends
 * (seq is monotonic and entries are immutable, so pages never shift).
 */
export const LedgerCursor = {
  encode(seq: bigint): string {
    return Buffer.from(`v1:${seq}`, 'utf8').toString('base64url');
  },
  decode(cursor: string): bigint {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v1:(\d{1,19})$/.exec(raw);
    if (!match?.[1]) throw new DomainValidationError('invalid cursor');
    return BigInt(match[1]);
  },
};

function toTransactionView(t: WagerTransaction): WagerTransactionView {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    ...(t.referenceExternalTransactionId ? { referenceExternalTransactionId: t.referenceExternalTransactionId } : {}),
    ...(t.referenceTransactionId ? { referenceTransactionId: t.referenceTransactionId } : {}),
    ...(t.failureCode ? { failureCode: t.failureCode } : {}),
    ...(t.balanceAfter ? { balanceAfter: t.balanceAfter.toJSON() } : {}),
    createdAt: t.createdAt.toISOString(),
    ...(t.processedAt ? { processedAt: t.processedAt.toISOString() } : {}),
  };
}

/** Read side: plain lookups, no locks. */
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.uow.run(async (r) => {
      const wallet = await r.wallets.findById(canonicalUuid('walletId', walletId));
      if (!wallet) throw new WalletNotFoundError(walletId);
      return toWalletView(wallet);
    });
  }

  getLedger(walletId: string, cursor: string | undefined, limit = 50): Promise<LedgerPageView> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_PAGE) {
      throw new DomainValidationError(`limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`);
    }
    const afterSeq = cursor ? LedgerCursor.decode(cursor) : undefined;
    return this.uow.run(async (r) => {
      const wallet = await r.wallets.findById(canonicalUuid('walletId', walletId));
      if (!wallet) throw new WalletNotFoundError(walletId);
      const rows = await r.ledger.page(wallet.id, afterSeq, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        walletId: wallet.id,
        entries: page.map(({ entry }) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        ...(rows.length > limit && last ? { nextCursor: LedgerCursor.encode(last.seq) } : {}),
      };
    });
  }

  getTransaction(transactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async (r) => {
      const tx = await r.transactions.findById(canonicalUuid('transactionId', transactionId));
      if (!tx) throw new TransactionNotFoundError(transactionId);
      return toTransactionView(tx);
    });
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async (r) => {
      const tx = await r.transactions.findByExternalId(providerId, externalTransactionId);
      if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      return toTransactionView(tx);
    });
  }
}
