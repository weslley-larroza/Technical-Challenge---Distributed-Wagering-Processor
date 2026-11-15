import type { MoneyProps } from '../../domain/money/money';
import { DomainValidationError } from '../../domain/shared/errors';

/**
 * Shape validation of HTTP bodies. Only types / presence / unknown fields are checked
 * here — every business rule (UUIDs, money format, kinds, references) is validated by the
 * domain, so HTTP and SQS share exactly the same rules.
 *
 * Unknown fields are rejected: a typo such as "referenceExternalTransactionID" on a WIN
 * would otherwise be silently ignored.
 */
type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainValidationError(`${what} must be a JSON object`);
  }
  return value as Json;
}

function rejectUnknown(obj: Json, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new DomainValidationError(`unknown field(s) in ${what}: ${unknown.join(', ')}`);
}

function requiredString(obj: Json, field: string): string {
  const v = obj[field];
  if (typeof v !== 'string') throw new DomainValidationError(`${field} must be a string`);
  return v;
}

function optionalString(obj: Json, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new DomainValidationError(`${field} must be a string`);
  return v;
}

/** Money must arrive as { amount: "<decimal string>", currency } — a JSON number is rejected. */
export function parseMoney(value: unknown, field: string): MoneyProps {
  const obj = asObject(value, field);
  rejectUnknown(obj, ['amount', 'currency'], field);
  if (typeof obj.amount !== 'string') {
    throw new DomainValidationError(`${field}.amount must be a decimal string (e.g. "25.00"), not a ${typeof obj.amount}`);
  }
  return { amount: obj.amount, currency: requiredString(obj, 'currency') };
}

export interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const SUBMIT_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;

export function parseSubmitTransactionBody(value: unknown, what = 'body'): SubmitTransactionBody {
  const body = asObject(value, what);
  rejectUnknown(body, SUBMIT_FIELDS, what);
  return {
    providerId: requiredString(body, 'providerId'),
    externalTransactionId: requiredString(body, 'externalTransactionId'),
    playerId: requiredString(body, 'playerId'),
    walletId: requiredString(body, 'walletId'),
    roundId: requiredString(body, 'roundId'),
    gameId: requiredString(body, 'gameId'),
    kind: requiredString(body, 'kind'),
    money: parseMoney(body.money, 'money'),
    referenceExternalTransactionId: optionalString(body, 'referenceExternalTransactionId'),
  };
}

export function parseCreateWalletBody(value: unknown): { playerId: string; initialBalance: MoneyProps } {
  const body = asObject(value, 'body');
  rejectUnknown(body, ['playerId', 'initialBalance'], 'body');
  return { playerId: requiredString(body, 'playerId'), initialBalance: parseMoney(body.initialBalance, 'initialBalance') };
}

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/; // visible ASCII, no spaces

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new DomainValidationError('Idempotency-Key header is required');
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new DomainValidationError('Idempotency-Key must be 1-256 visible ASCII characters');
  }
  return value;
}

export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,4}$/.test(raw)) throw new DomainValidationError('limit must be a positive integer');
  return Number(raw);
}
