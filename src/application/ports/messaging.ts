import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishResult {
  published: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Broker port for integration events. Implementations MUST be safe to call twice for the
 * same message (at-least-once): the message id is the event id, and consumers dedupe on it.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
