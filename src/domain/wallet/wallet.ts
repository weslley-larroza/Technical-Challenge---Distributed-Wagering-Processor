import { Money } from '../money/money';
import { CurrencyMismatchError, DomainValidationError, InsufficientFundsError } from '../shared/errors';
import { canonicalUuid } from '../shared/identifiers';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Required when initialBalance > 0: ids for the internal OPENING transaction and its ledger entry. */
  opening?: { transactionId: string; ledgerEntryId: string };
  now: Date;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aggregate root. The ONLY way to change the balance is debit()/credit(), and both
 * return the ledger entry describing that exact change — so balance and ledger cannot
 * drift apart inside the domain. `version` is bumped only on balance changes and is
 * used by the repository as an optimistic guard on top of the row lock.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance yields the OPENING ledger
   * entry (0 → initial) so that "every balance has a ledger line" holds from day one.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new DomainValidationError('initial balance must not be negative');
    }
    const wallet = new Wallet(
      canonicalUuid('walletId', props.id),
      canonicalUuid('playerId', props.playerId),
      initialBalance.currency,
      initialBalance,
      1,
      props.now,
      props.now,
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new DomainValidationError('opening ids are required for a positive initial balance');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: initialBalance,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** False when the credit would exceed the persistable balance range. */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.canAdd(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(`insufficient funds: balance ${this._balance}, debit ${props.money}`);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    // create() validates positivity, non-negativity and arithmetic.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet currency ${this.currency} does not accept ${money.currency}`);
    }
  }
}
