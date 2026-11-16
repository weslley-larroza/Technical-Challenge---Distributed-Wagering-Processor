import { createHash } from 'node:crypto';
import { Money } from '../money/money';
import { InvalidLedgerEntryError } from '../shared/errors';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';

/**
 * Double-entry bookkeeping on top of the per-wallet ledger.
 *
 * Chart of accounts (closed system — the sum of every account is always zero):
 *   PLAYER_WALLET    one per wallet; its balance IS the wallet balance
 *   PROVIDER_GAMING  one per provider + currency; counterparty of BET / WIN / REFUND / ROLLBACK
 *                    (balance > 0 means the house is up against players on that provider)
 *   FUNDING          one per currency; counterparty of OPENING (money entering the system)
 *
 * Sign convention (same as the wallet ledger): CREDIT puts money into an account, DEBIT
 * takes it out; account balance = Σ credits − Σ debits.
 */
export enum AccountKind {
  PlayerWallet = 'PLAYER_WALLET',
  ProviderGaming = 'PROVIDER_GAMING',
  Funding = 'FUNDING',
}

/**
 * Deterministic account id derived from its code: every instance (and the SQL backfill,
 * `md5('account:' || code)::uuid`) computes the same id without a lookup or a race.
 * md5 is used as a stable hash here, not for security.
 */
export function accountIdFor(code: string): string {
  const h = createHash('md5').update(`account:${code}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class LedgerAccount {
  private constructor(
    public readonly id: string,
    public readonly code: string,
    public readonly kind: AccountKind,
    public readonly currency: string,
    public readonly walletId: string | undefined,
  ) {}

  static playerWallet(walletId: string, currency: string): LedgerAccount {
    const code = `wallet:${walletId}`;
    return new LedgerAccount(accountIdFor(code), code, AccountKind.PlayerWallet, currency, walletId);
  }

  static providerGaming(providerId: string, currency: string): LedgerAccount {
    const code = `provider:${providerId}:${currency}`;
    return new LedgerAccount(accountIdFor(code), code, AccountKind.ProviderGaming, currency, undefined);
  }

  static funding(currency: string): LedgerAccount {
    const code = `funding:${currency}`;
    return new LedgerAccount(accountIdFor(code), code, AccountKind.Funding, currency, undefined);
  }
}

export interface JournalPosting {
  readonly id: string;
  readonly transactionId: string;
  readonly accountId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly createdAt: Date;
}

const opposite = (d: LedgerDirection) => (d === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit);

/**
 * The postings of ONE financial transaction. Immutable; `create` enforces the
 * double-entry rule (Σ debits = Σ credits, ≥ 2 legs, one currency, one leg per account).
 * The database enforces the same rule again at COMMIT.
 */
export class JournalTransaction {
  private constructor(
    public readonly transactionId: string,
    public readonly postings: readonly JournalPosting[],
  ) {
    Object.freeze(this.postings);
    Object.freeze(this);
  }

  static create(transactionId: string, postings: readonly JournalPosting[]): JournalTransaction {
    if (postings.length < 2) throw new InvalidLedgerEntryError('a journal transaction needs at least two postings');
    const currency = postings[0]!.money.currency;
    const accounts = new Set<string>();
    let debits = Money.zero(currency);
    let credits = Money.zero(currency);
    for (const p of postings) {
      if (p.transactionId !== transactionId) throw new InvalidLedgerEntryError('posting belongs to another transaction');
      if (!p.money.isPositive()) throw new InvalidLedgerEntryError('posting amount must be positive');
      if (p.money.currency !== currency) throw new InvalidLedgerEntryError('a journal transaction has a single currency');
      if (accounts.has(p.accountId)) throw new InvalidLedgerEntryError('one posting per account per transaction');
      accounts.add(p.accountId);
      if (p.direction === LedgerDirection.Debit) debits = debits.add(p.money);
      else credits = credits.add(p.money);
    }
    if (!debits.equals(credits)) {
      throw new InvalidLedgerEntryError(`unbalanced journal: debits ${debits} != credits ${credits}`);
    }
    return new JournalTransaction(transactionId, [...postings]);
  }

  /**
   * The two legs of a wallet movement: the player leg mirrors the wallet ledger entry
   * exactly; the counterparty leg is the opposite direction, same amount.
   */
  static forWalletMovement(props: {
    entry: WalletLedgerEntry;
    counterparty: LedgerAccount;
    newId: () => string;
  }): JournalTransaction {
    const { entry, counterparty } = props;
    if (counterparty.currency !== entry.money.currency) {
      throw new InvalidLedgerEntryError('counterparty account currency differs from the movement');
    }
    const player = LedgerAccount.playerWallet(entry.walletId, entry.money.currency);
    return JournalTransaction.create(entry.transactionId, [
      {
        id: props.newId(),
        transactionId: entry.transactionId,
        accountId: player.id,
        direction: entry.direction,
        money: entry.money,
        createdAt: entry.createdAt,
      },
      {
        id: props.newId(),
        transactionId: entry.transactionId,
        accountId: counterparty.id,
        direction: opposite(entry.direction),
        money: entry.money,
        createdAt: entry.createdAt,
      },
    ]);
  }
}
