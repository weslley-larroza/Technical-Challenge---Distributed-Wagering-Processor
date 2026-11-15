import { createHash } from 'node:crypto';
import { Money } from '../../domain/money/money';

/**
 * Canonical JSON: object keys sorted lexicographically (recursively), no whitespace,
 * `undefined` properties omitted, arrays keep order. Only JSON-safe values are allowed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number in canonical JSON');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported type in canonical JSON: ${typeof value}`);
  }
}

/** Business fields that define "the same request". Transport metadata is excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = "sha256:" + hex(SHA-256(canonicalJson(fields))).
 * The amount is hashed in its normalized 2-decimal form (normalized here, not by the caller),
 * so "25" and "25.00" are the same request. Throws InvalidMoneyError on invalid money.
 */
export function wagerPayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(subset)).digest('hex')}`;
}
