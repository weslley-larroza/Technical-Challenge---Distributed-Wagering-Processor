import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from '../../src/domain/shared/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normalizes to fixed scale 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  test('is exact (no floating point drift)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('1000000000000000.01').add(brl('0.01')).amount).toBe('1000000000000000.02');
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E-2',
    '-1.00',
    '+1.00',
    '1.234',
    '1.',
    '.50',
    '01.00',
    '1,00',
    ' 1.00',
    '0x10',
    '1234567890123456789.00',
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (numbers are never accepted for money)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('subtract / negate / sign predicates', () => {
    const diff = brl('5.00').subtract(brl('7.50'));
    expect(diff.amount).toBe('-2.50');
    expect(diff.isNegative()).toBe(true);
    expect(diff.negate().amount).toBe('2.50');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('cross-currency arithmetic throws a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money limits (NUMERIC(20,2))', () => {
  const MAX = '999999999999999999.99';

  test('accepts the largest persistable value, rejects anything above on input', () => {
    expect(brl(MAX).amount).toBe(MAX);
    expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
  });

  test('arithmetic that leaves the range throws MoneyOverflowError (invariant) and canAdd predicts it', () => {
    expect(brl(MAX).canAdd(brl('0.00'))).toBe(true);
    expect(brl(MAX).canAdd(brl('0.01'))).toBe(false);
    expect(() => brl(MAX).add(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => brl(MAX).negate().subtract(brl('0.01'))).toThrow(MoneyOverflowError);
  });
});

describe('error categories', () => {
  test('input errors are validation, programming errors are invariant', () => {
    const catchErr = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as { category: string };
      }
      throw new Error('expected throw');
    };
    expect(catchErr(() => brl('1e3')).category).toBe('validation');
    expect(catchErr(() => brl('1.00').add(Money.from({ amount: '1.00', currency: 'USD' }))).category).toBe('invariant');
  });
});
