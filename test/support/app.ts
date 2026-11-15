import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletQueries } from '../../src/application/queries';
import { type Clock, type Labels, type Metrics, noopLogger } from '../../src/application/ports/system';
import { ResolvePendingReferences } from '../../src/application/wagering/resolve-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wagering/submit-wager-transaction';
import { WagerProcessor } from '../../src/application/wagering/wager-processor';
import { CreateWallet, type WalletView } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from '../../src/infrastructure/system/system';

export class FakeClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Metrics spy: counts by name (all label sets summed) and by exact labels. */
export class RecordingMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  increment(name: string, labels: Labels = {}, value = 1): void {
    const key = `${name}${JSON.stringify(Object.entries(labels).sort())}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }
  observe(): void {}
  total(name: string): number {
    let sum = 0;
    for (const [k, v] of this.counters) if (k.startsWith(`${name}[`)) sum += v;
    return sum;
  }
}

/** The real application graph (no mocks): use cases → MikroORM adapter → PostgreSQL. */
export function buildApp(orm: MikroORM, clock: Clock = systemClock) {
  const metrics = new RecordingMetrics();
  const uow = new MikroOrmUnitOfWork(orm);
  const processor = new WagerProcessor(uuidV7Generator, clock, metrics);
  return {
    uow,
    clock,
    metrics,
    submit: new SubmitWagerTransaction(uow, processor, uuidV7Generator, clock, metrics, noopLogger),
    createWallet: new CreateWallet(uow, uuidV7Generator, clock, metrics, noopLogger),
    reconcile: new ReconcileWallet(uow, metrics, noopLogger),
    resolver: new ResolvePendingReferences(uow, processor, clock, metrics, noopLogger),
    queries: new WalletQueries(uow),
  };
}

export type App = ReturnType<typeof buildApp>;

export function openWallet(app: App, amount = '1000.00'): Promise<WalletView> {
  return app.createWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    correlationId: `corr-${randomUUID()}`,
  });
}

export function command(
  wallet: WalletView,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `corr-${externalTransactionId}`,
    ...overrides,
  };
}

/** The global invariant of every test: wallet.balance == balance rebuilt from the ledger. */
export async function expectLedgerInvariant(app: App, walletId: string): Promise<void> {
  const report = await app.reconcile.execute(walletId, 'invariant-check');
  if (!report.consistent) {
    throw new Error(`ledger invariant broken for ${walletId}: ${JSON.stringify(report)}`);
  }
}
