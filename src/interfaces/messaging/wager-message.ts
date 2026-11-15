import { createHash } from 'node:crypto';
import { canonicalJson } from '../../application/idempotency/payload-hash';
import { DomainValidationError } from '../../domain/shared/errors';
import { parseSubmitTransactionBody, type SubmitTransactionBody } from '../http/request-parsing';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: typeof WAGER_MESSAGE_TYPE;
  occurredAt: string;
  correlationId?: string;
  data: SubmitTransactionBody & { idempotencyKey: string };
}

const ENVELOPE_FIELDS = ['messageId', 'type', 'occurredAt', 'correlationId', 'data'];

/**
 * Parses the queue envelope (section 10). Same shape rules as HTTP — business validation
 * happens in the shared use case. Any failure here is PERMANENT: redelivering a malformed
 * message can never succeed, so it goes straight to the DLQ.
 */
export function parseWagerMessage(raw: string | undefined): WagerTransactionRequestedMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw ?? '');
  } catch {
    throw new DomainValidationError('message body is not valid JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new DomainValidationError('message body must be a JSON object');
  }
  const envelope = json as Record<string, unknown>;
  const unknown = Object.keys(envelope).filter((k) => !ENVELOPE_FIELDS.includes(k));
  if (unknown.length) throw new DomainValidationError(`unknown envelope field(s): ${unknown.join(', ')}`);

  if (typeof envelope.messageId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(envelope.messageId)) {
    throw new DomainValidationError('messageId must be 1-256 visible ASCII characters');
  }
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw new DomainValidationError(`unsupported message type ${String(envelope.type)}`);
  }
  if (typeof envelope.occurredAt !== 'string' || Number.isNaN(Date.parse(envelope.occurredAt))) {
    throw new DomainValidationError('occurredAt must be an ISO-8601 timestamp');
  }
  if (envelope.correlationId !== undefined && typeof envelope.correlationId !== 'string') {
    throw new DomainValidationError('correlationId must be a string');
  }

  const data = envelope.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new DomainValidationError('data must be a JSON object');
  }
  const { idempotencyKey, ...business } = data as Record<string, unknown>;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new DomainValidationError('data.idempotencyKey is required');
  }

  return {
    messageId: envelope.messageId,
    type: WAGER_MESSAGE_TYPE,
    occurredAt: envelope.occurredAt,
    ...(envelope.correlationId ? { correlationId: envelope.correlationId as string } : {}),
    data: { ...parseSubmitTransactionBody(business, 'data'), idempotencyKey },
  };
}

/** Inbox payload hash: sha256 of the canonical JSON of `data`. */
export function messagePayloadHash(message: WagerTransactionRequestedMessage): string {
  return `sha256:${createHash('sha256').update(canonicalJson(message.data)).digest('hex')}`;
}
