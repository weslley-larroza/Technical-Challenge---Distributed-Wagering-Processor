import { describe, expect, test } from 'bun:test';
import { canonicalJson, wagerPayloadHash } from '../../src/application/idempotency/payload-hash';
import { WalletBalanceChanged } from '../../src/domain/messaging/events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OUTBOX_RETRY_POLICY, OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../src/domain/shared/errors';
import { brl, id, NOW, wallet } from './fixtures';

const payload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p',
  walletId: 'w',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonical payload hash', () => {
  test('key order does not matter', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as typeof payload;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(payload));
  });

  test('a different business payload under the same key yields a different hash (conflict, not replay)', () => {
    const base = wagerPayloadHash(payload);
    expect(wagerPayloadHash({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(base);
    expect(wagerPayloadHash({ ...payload, kind: 'WIN' })).not.toBe(base);
    expect(wagerPayloadHash({ ...payload, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });

  test('amount is normalized before hashing ("25" == "25.00"), invalid money throws', () => {
    expect(wagerPayloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } })).toBe(wagerPayloadHash(payload));
    expect(() => wagerPayloadHash({ ...payload, money: { amount: '1e3', currency: 'BRL' } })).toThrow();
  });

  test('transport metadata is not part of the hash', () => {
    const withExtra = { ...payload, idempotencyKey: 'whatever', messageId: 'm-1' } as typeof payload;
    expect(wagerPayloadHash(withExtra)).toBe(wagerPayloadHash(payload));
  });
});

describe('Outbox / Inbox', () => {
  const event = () => {
    const w = wallet('100.00');
    const entry = w.debit({ money: brl('10.00'), transactionId: 't', ledgerEntryId: 'l', at: NOW });
    return WalletBalanceChanged.from(w, entry, { newId: () => id('evt'), correlationId: 'corr', occurredAt: NOW });
  };

  test('event envelope serializes money as decimal strings with type and version', () => {
    const json = event().toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(NOW.toISOString());
    expect(json.data.balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(json.data.walletVersion).toBe(2);
  });

  test('outbox id equals eventId; retry backs off; publish is final', () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);
    expect(msg.id).toBe(e.eventId);
    expect(msg.isDue(NOW)).toBe(true);
    msg.scheduleRetry(NOW, 'boom');
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(NOW)).toBe(false);
    expect(msg.nextAttemptAt?.getTime()).toBe(NOW.getTime() + OUTBOX_RETRY_POLICY.baseMs);
    msg.markPublished(NOW);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(NOW)).toThrow(InvalidTransactionStateError);
  });

  test('inbox processes once', () => {
    const inbox = InboxMessage.receive({ messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});
