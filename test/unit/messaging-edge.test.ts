import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { TransientPersistenceError } from '../../src/application/ports/persistence';
import { DomainValidationError, InvalidLedgerEntryError, InvalidMoneyError } from '../../src/domain/shared/errors';
import { classifyProcessingError } from '../../src/interfaces/messaging/sqs-wager-consumer';
import { messagePayloadHash, parseWagerMessage } from '../../src/interfaces/messaging/wager-message';

const envelope = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...data,
    },
    ...overrides,
  });

describe('classifyProcessingError (consumer error taxonomy)', () => {
  test.each([
    ['validation → permanent (DLQ now)', new DomainValidationError('x'), 'permanent'],
    ['invalid money → permanent', new InvalidMoneyError('x'), 'permanent'],
    ['domain invariant (bug) → unexpected (retry, then DLQ)', new InvalidLedgerEntryError('x'), 'unexpected'],
    ['wallet not found → business (ack)', new WalletNotFoundError('w'), 'business'],
    ['idempotency conflict → business (ack)', new IdempotencyConflictError('IDEMPOTENCY_KEY_REUSED', 't'), 'business'],
    ['transient app error → transient', new TransientInfrastructureError('deadlock'), 'transient'],
    ['raw transient persistence → transient', new TransientPersistenceError('connection'), 'transient'],
    ['anything else → unexpected', new TypeError('boom'), 'unexpected'],
  ])('%s', (_, error, expected) => {
    expect(classifyProcessingError(error)).toBe(expected as never);
  });
});

describe('parseWagerMessage', () => {
  test('accepts the section 10 envelope', () => {
    const m = parseWagerMessage(envelope());
    expect(m.messageId).toBe('msg-123');
    expect(m.data.idempotencyKey).toBe('provider-a:transaction-123');
    expect(m.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each([
    ['not JSON', '{"x":'],
    ['array', '[]'],
    ['wrong type', envelope({ type: 'SomethingElse' })],
    ['missing messageId', envelope({ messageId: undefined })],
    ['bad occurredAt', envelope({ occurredAt: 'yesterday' })],
    ['unknown envelope field', envelope({ priority: 1 })],
    ['missing idempotencyKey', envelope({}, { idempotencyKey: undefined })],
    ['amount as number', envelope({}, { money: { amount: 25, currency: 'BRL' } })],
    ['unknown data field', envelope({}, { bonus: true })],
  ])('rejects %s as a validation (permanent) error', (_, raw) => {
    expect(() => parseWagerMessage(raw)).toThrow(DomainValidationError);
  });

  test('inbox payload hash is stable under key order', () => {
    const a = parseWagerMessage(envelope());
    const reordered = JSON.parse(envelope());
    reordered.data = Object.fromEntries(Object.entries(reordered.data).reverse());
    expect(messagePayloadHash(parseWagerMessage(JSON.stringify(reordered)))).toBe(messagePayloadHash(a));
  });
});
