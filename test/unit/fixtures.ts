import { Money } from '../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

let seq = 0;
export const id = (prefix = 'id'): string => `${prefix}-${++seq}`;
export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
export const OTHER_PLAYER = '0192f28f-0000-7000-8000-000000000bad';

export function wallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: WALLET,
    playerId: PLAYER,
    currency,
    balance: Money.from({ amount: balance, currency }),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? id('ext');
  return WagerTransaction.create({
    id: id('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'sha256:x',
    walletId: WALLET,
    playerId: PLAYER,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: NOW,
    ...overrides,
  });
}
