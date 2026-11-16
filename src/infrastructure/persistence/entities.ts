import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records — plain data shaped like the tables, mapped with EntitySchema
 * (no decorators). Domain classes stay free of ORM concerns; `mappers.ts` converts
 * between both using the domain `rehydrate` factories.
 *
 * Money columns are NUMERIC(20,2) mapped as `string`: the pg driver returns NUMERIC as a
 * string and we never let it pass through `number`. Currency lives in its own column.
 *
 * FK columns are plain scalars (not ORM relations): the schema's DEFERRABLE FKs make
 * insert order inside a flush irrelevant, and aggregates reference each other by id.
 */

const timestamptz = { type: 'datetime', columnType: 'timestamptz' } as const;
const money = { type: 'string', columnType: 'numeric(20,2)' } as const;
const currency = { type: 'string', columnType: 'char(3)' } as const;

// ------------------------------------------------------------------ wallets
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency,
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamptz,
    updatedAt: timestamptz,
  },
});

// ------------------------------------------------------------------ wager_transactions
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceAfterAmount?: string | null;
  balanceAfterCurrency?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  processedAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: money,
    currency,
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    balanceAfterAmount: { ...money, nullable: true },
    balanceAfterCurrency: { ...currency, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceCheckAt: { ...timestamptz, nullable: true },
    processedAt: { ...timestamptz, nullable: true },
    createdAt: timestamptz,
    updatedAt: timestamptz,
  },
});

// ------------------------------------------------------------------ wallet_ledger_entries
/** `seq` (identity) is intentionally not mapped: it is DB-generated and read via queries. */
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: money,
    currency,
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamptz,
  },
});

// ------------------------------------------------------------------ inbox_messages
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: timestamptz,
    processedAt: { ...timestamptz, nullable: true },
  },
});

// ------------------------------------------------------------------ outbox_messages
export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
  traceParent?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestamptz,
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz, nullable: true },
    publishedAt: { ...timestamptz, nullable: true },
    lastError: { type: 'text', nullable: true },
    traceParent: { type: 'string', nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
