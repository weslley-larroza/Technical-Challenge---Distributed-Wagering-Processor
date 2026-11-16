import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/wagering_test';

export async function createTestOrm(poolMax = 10): Promise<MikroORM> {
  return MikroORM.init(createOrmConfig({ clientUrl: TEST_DATABASE_URL, poolMax }));
}

/** Drops everything and re-applies all migrations — each test file starts from a clean schema. */
export async function resetSchema(orm: MikroORM): Promise<void> {
  await orm.em.fork().execute('drop schema if exists public cascade; create schema public;');
  await orm.getMigrator().up();
}

// ---------------------------------------------------------------- raw SQL seeding
type Row = Record<string, unknown>;

export async function insert(em: EntityManager, table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  await em.execute(`insert into ${table} (${cols.join(', ')}) values (${placeholders})`, Object.values(row));
}

export const now = () => new Date();

export function walletRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: now(),
    updated_at: now(),
    ...overrides,
  };
}

export function txRow(walletId: string, playerId: string, overrides: Row = {}): Row {
  const ext = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: ext,
    idempotency_key: `provider-a:${ext}`,
    payload_hash: 'sha256:test',
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: now(),
    updated_at: now(),
    ...overrides,
  };
}

export function ledgerRow(walletId: string, transactionId: string, overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'CREDIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '0.00',
    balance_after: '10.00',
    created_at: now(),
    ...overrides,
  };
}

/**
 * Double-entry legs for a wallet ledger line (player leg mirrors it, counterparty takes
 * the opposite side). Required since migration 4: a wallet entry without a balanced
 * journal fails at COMMIT.
 */
export async function insertJournal(
  em: EntityManager,
  p: { walletId: string; transactionId: string; direction: 'DEBIT' | 'CREDIT'; amount: string; counterparty?: string; currency?: string },
): Promise<void> {
  const currency = p.currency ?? 'BRL';
  const counterpartyCode = p.counterparty ?? `provider:provider-a:${currency}`;
  const kind = counterpartyCode.startsWith('funding:') ? 'FUNDING' : 'PROVIDER_GAMING';
  await em.execute(
    `insert into ledger_accounts (id, code, kind, currency, wallet_id, created_at) values
       (md5('account:wallet:' || ?)::uuid, 'wallet:' || ?, 'PLAYER_WALLET', ?, ?, now()),
       (md5('account:' || ?)::uuid, ?, ?, ?, null, now())
     on conflict (code) do nothing`,
    [p.walletId, p.walletId, currency, p.walletId, counterpartyCode, counterpartyCode, kind, currency],
  );
  const opposite = p.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  await em.execute(
    `insert into journal_postings (id, transaction_id, account_id, direction, amount, currency, created_at) values
       (?, ?, md5('account:wallet:' || ?)::uuid, ?, ?, ?, now()),
       (?, ?, md5('account:' || ?)::uuid, ?, ?, ?, now())`,
    [randomUUID(), p.transactionId, p.walletId, p.direction, p.amount, currency, randomUUID(), p.transactionId, counterpartyCode, opposite, p.amount, currency],
  );
}

/** A consistent wallet: row + OPENING transaction + opening CREDIT entry, in one transaction. */
export async function seedWallet(orm: MikroORM, balance = '100.00'): Promise<{ walletId: string; playerId: string }> {
  const wallet = walletRow({ balance });
  const walletId = wallet.id as string;
  const playerId = wallet.player_id as string;
  await orm.em.fork().transactional(async (em) => {
    await insert(em, 'wallets', wallet);
    if (balance !== '0.00') {
      const opening = txRow(walletId, playerId, {
        provider_id: 'internal',
        external_transaction_id: `opening:${walletId}`,
        idempotency_key: `internal:opening:${walletId}`,
        kind: 'OPENING',
        amount: balance,
        status: 'PROCESSED',
        processed_at: now(),
        balance_after_amount: balance,
        balance_after_currency: 'BRL',
        round_id: 'opening',
        game_id: 'internal',
      });
      await insert(em, 'wager_transactions', opening);
      await insert(em, 'wallet_ledger_entries', ledgerRow(walletId, opening.id as string, { amount: balance, balance_after: balance }));
      await insertJournal(em, { walletId, transactionId: opening.id as string, direction: 'CREDIT', amount: balance, counterparty: 'funding:BRL' });
    }
  });
  return { walletId, playerId };
}

/** Applies a processed BET (tx + debit entry + wallet update) the legitimate way. */
export async function seedBet(
  orm: MikroORM,
  w: { walletId: string; playerId: string },
  amount: string,
  before: string,
  after: string,
  version: number,
  txOverrides: Row = {},
): Promise<string> {
  const tx = txRow(w.walletId, w.playerId, {
    amount,
    status: 'PROCESSED',
    processed_at: now(),
    balance_after_amount: after,
    balance_after_currency: 'BRL',
    ...txOverrides,
  });
  await orm.em.fork().transactional(async (em) => {
    await insert(em, 'wager_transactions', tx);
    await insert(
      em,
      'wallet_ledger_entries',
      ledgerRow(w.walletId, tx.id as string, { direction: 'DEBIT', amount, balance_before: before, balance_after: after }),
    );
    await insertJournal(em, { walletId: w.walletId, transactionId: tx.id as string, direction: 'DEBIT', amount });
    await em.execute('update wallets set balance = ?, version = ?, updated_at = now() where id = ?', [
      after,
      version,
      w.walletId,
    ]);
  });
  return tx.id as string;
}

// ---------------------------------------------------------------- assertions
/**
 * Asserts the promise fails with the given SQLSTATE (and, optionally, a message pattern —
 * typically the constraint name, proving WHICH guarantee fired).
 */
export async function expectDbError(promise: Promise<unknown>, sqlState: string, pattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error(`expected database error ${sqlState}, but the operation succeeded`);
  const err = caught as { code?: string; sqlState?: string; message?: string };
  expect(err.code ?? err.sqlState).toBe(sqlState);
  if (pattern) expect(String(err.message)).toMatch(pattern);
}

export const SQLSTATE = {
  integrity: '23000',
  foreignKey: '23503',
  unique: '23505',
  check: '23514',
} as const;
