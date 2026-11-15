import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../shared/errors';

/** Wire / persistence contract. `amount` is a decimal string with scale 2, e.g. "25.00". */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Matches PostgreSQL NUMERIC(20,2): at most 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
/** Largest absolute value representable in NUMERIC(20,2), in minor units. */
const MAX_ABS_MINOR = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;
/**
 * Non-negative decimal, no sign, no exponent, no leading zeros, 0–2 fraction digits.
 * Rejects: "", " 1.00", "1e3", "NaN", "Infinity", "-1.00", "+1.00", "1.234", "01.00", "1.".
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Internally an exact integer count of minor units (bigint),
 * so there is no floating point anywhere and no rounding is ever performed:
 * inputs with more than 2 decimals are rejected instead of rounded.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an input contract. Negative values are rejected (inputs are always unsigned). */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`invalid amount "${amount}": expected non-negative decimal with up to ${SCALE} places`);
    }
    const [intPart = '0', fracPart = ''] = amount.split('.');
    if (intPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError('amount exceeds supported magnitude');
    }
    const minor = BigInt(intPart) * FACTOR + BigInt(fracPart.padEnd(SCALE, '0'));
    return new Money(minor, Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  /** Decimal string with fixed scale 2 (may be negative for internal results, e.g. differences). */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const int = abs / FACTOR;
    const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${int}.${frac}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor - other.minor, this.currency);
  }

  /** True when `this + other` stays within the persistable range (NUMERIC(20,2)). */
  canAdd(other: Money): boolean {
    this.assertSameCurrency(other);
    return Money.withinLimits(this.minor + other.minor);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  private static withinLimits(minor: bigint): boolean {
    return (minor < 0n ? -minor : minor) <= MAX_ABS_MINOR;
  }

  private static checked(minor: bigint, currency: string): Money {
    if (!Money.withinLimits(minor)) {
      throw new MoneyOverflowError('result exceeds supported magnitude');
    }
    return new Money(minor, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected ISO-4217 code`);
    }
    return currency;
  }
}
